#!/usr/bin/env python3
"""Read-only GitHub Actions artifact inventory for repositories owned by one user.

Public GitHub Actions job logs are public. Run the all-repository audit locally
for a private report, or explicitly accept public disclosure in the workflow.
"""
import argparse
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


class AuditError(Exception):
    pass


class GitHubAPI:
    def __init__(self, token):
        self.api = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
        self.token = token

    def get(self, path):
        req = urllib.request.Request(
            self.api + path,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            # Do not print the auth token or error response body.
            raise AuditError("GitHub GET %s failed (HTTP %s)" % (path.split("?")[0], exc.code)) from exc
        except urllib.error.URLError as exc:
            raise AuditError("GitHub API connection failed: %s" % type(exc.reason).__name__) from exc

    def pages(self, path, field=None):
        items = []
        page = 1
        expected = None
        while True:
            sep = "&" if "?" in path else "?"
            data = self.get("%s%sper_page=100&page=%s" % (path, sep, page))
            if field is None:
                batch = data
            else:
                batch = data[field]
                if expected is None:
                    expected = data.get("total_count")
            if not isinstance(batch, list):
                raise AuditError("GitHub API returned an unexpected result for %s" % path)
            items.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        # Avoid silently claiming a complete scan if the API result changed mid-scan.
        if expected is not None and expected != len(items):
            raise AuditError(
                "Artifact count changed during pagination for %s (%s vs %s); retry"
                % (path, expected, len(items))
            )
        return items


def inventory(api, owner, include_private, expected_min):
    if include_private:
        login = api.get("/user").get("login", "")
        if login.casefold() != owner.casefold():
            raise AuditError("Audit token belongs to %s, expected owner %s" % (login, owner))
        repositories = api.pages("/user/repos?affiliation=owner")
    else:
        repositories = api.pages("/users/%s/repos?type=public" % urllib.parse.quote(owner))

    repositories = [
        repo for repo in repositories
        if repo.get("owner", {}).get("login", "").casefold() == owner.casefold()
        and (include_private or not repo.get("private", False))
    ]
    if include_private and len(repositories) < expected_min:
        raise AuditError(
            "Only %s repositories are visible, expected at least %s. "
            "Grant the fine-grained token access to ALL owner repositories; "
            "do not treat this as a complete audit."
            % (len(repositories), expected_min)
        )

    rows = []
    for repo in repositories:
        name = repo["full_name"]
        path = "/repos/%s/actions/artifacts" % urllib.parse.quote(name, safe="/")
        try:
            artifacts = api.pages(path, "artifacts")
            current = [a for a in artifacts if not a.get("expired", False)]
            size = sum(int(a.get("size_in_bytes", 0)) for a in current)
            rows.append({
                "repository": name,
                "visibility": "private" if repo.get("private") else "public",
                "artifacts": len(current),
                "bytes": size,
                "status": "OK",
            })
        except (AuditError, KeyError, ValueError, TypeError) as exc:
            rows.append({
                "repository": name,
                "visibility": "private" if repo.get("private") else "public",
                "artifacts": "",
                "bytes": "",
                "status": "ERROR: %s" % str(exc).replace("|", "/"),
            })
    rows.sort(key=lambda r: (-r["bytes"] if isinstance(r["bytes"], int) else 1,
                             r["repository"].casefold()))
    return rows


def render(rows, owner, include_private):
    count = len(rows)
    errors = [row for row in rows if row["status"] != "OK"]
    total = sum(row["bytes"] for row in rows if isinstance(row["bytes"], int))
    artifacts = sum(row["artifacts"] for row in rows if isinstance(row["artifacts"], int))
    scope = "all accessible owned repositories" if include_private else "public owned repositories ONLY"
    lines = [
        "## GitHub Actions artifact inventory",
        "",
        "- Owner: `%s`" % owner,
        "- Coverage: **%s** (%s repositories; %s scan errors)" % (scope, count, len(errors)),
        "- Currently listed, non-expired artifacts: **%s**" % artifacts,
        "- Total current artifact size: **%.2f MiB (%.3f GiB)**" %
        (total / 1048576, total / 1073741824),
        "",
        "| Repository | Visibility | Artifacts | Size (MiB) | Status |",
        "|---|---|---:|---:|---|",
    ]
    for row in rows:
        mib = "%.2f" % (row["bytes"] / 1048576) if isinstance(row["bytes"], int) else "—"
        lines.append(
            "| %s | %s | %s | %s | %s |" %
            (row["repository"], row["visibility"], row["artifacts"], mib, row["status"])
        )
    lines.extend([
        "",
        "**Largest current artifact storage:** %s" %
        (("%s (%.2f MiB)" % (rows[0]["repository"], rows[0]["bytes"] / 1048576))
         if rows and isinstance(rows[0]["bytes"], int) and rows[0]["bytes"] > 0 and not errors
         else ("No current artifacts." if rows and not errors else
               "Not determined: no repositories, incomplete scan or errors.")),
        "",
        "This is a snapshot of existing artifacts, not the historical GB-hours "
        "reported by GitHub Billing. No artifacts were created or deleted.",
        "",
    ])
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["repository", "visibility", "artifacts", "bytes", "status"])
    for row in rows:
        writer.writerow([row[key] for key in
                         ("repository", "visibility", "artifacts", "bytes", "status")])
    return "\n".join(lines), output.getvalue(), errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True, help="GitHub personal account owner login")
    parser.add_argument("--include-private", action="store_true")
    parser.add_argument("--expected-min", type=int, default=0,
                        help="Minimum visible owned repositories; protects against partial PAT scope")
    parser.add_argument("--csv", help="Optional local path for the CSV report")
    args = parser.parse_args()
    if args.expected_min < 0:
        parser.error("--expected-min must be nonnegative")
    token = os.environ.get("AUDIT_API_TOKEN", "").strip()
    if not token:
        parser.error("Set AUDIT_API_TOKEN to a read-only GitHub token")

    try:
        rows = inventory(GitHubAPI(token), args.owner, args.include_private, args.expected_min)
        markdown, csv_text, errors = render(rows, args.owner, args.include_private)
        if args.csv:
            with open(args.csv, "w", newline="", encoding="utf-8") as file:
                file.write(csv_text)
        print(markdown, flush=True)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            # The workflow resides in a PUBLIC repo: contents will be PUBLIC.
            with open(summary, "a", encoding="utf-8") as file:
                file.write(markdown + "\n### CSV report (copy and save as .csv)\n\n")
                file.write("```csv\n" + csv_text + "```\n")
        else:
            print("CSV report:\n" + csv_text, flush=True)
        if errors:
            raise AuditError("%s repository scans failed; results are incomplete" % len(errors))
    except AuditError as exc:
        print("AUDIT INCOMPLETE: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
