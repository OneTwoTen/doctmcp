# GitHub Actions artifact inventory (read-only)

Use the manual **Audit account artifact storage** workflow to list CURRENT,
non-expired artifacts in repositories owned by the GitHub account. It reports
artifact count and total bytes per repository, sorted by current artifact size,
plus a copyable CSV in the workflow's **Summary**. It never deletes anything,
nor does it upload another storage-consuming workflow artifact.

**Privacy:** `doctmcp` is PUBLIC. Its Actions logs and step summaries are
publicly visible. The workflow therefore scans **only public repositories by
default**. To include private repositories, you must explicitly type
`PUBLIC_LOGS_OK` and accept that their names and artifact sizes will become
public in the job logs. Prefer running the same script LOCALLY (below) if you
do not want your private repository inventory published.

## Full account scan from the GitHub UI

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   with resource owner **OneTwoTen**, repository access **All repositories**,
   and repository permissions **Actions: Read-only** (Metadata: Read-only is
   automatic). No Actions write/delete or Contents write permissions are needed.
   Limit its expiration and revoke it when no longer needed.
2. Add the token as the repository Actions secret `GH_AUDIT_TOKEN` in
   [doctmcp Actions secrets](https://github.com/OneTwoTen/doctmcp/settings/secrets/actions).
   Never paste the token into workflow inputs, chat, comments or logs.
3. Open [Audit account artifact storage](https://github.com/OneTwoTen/doctmcp/actions/workflows/audit-account-artifacts.yml),
   choose `main` → Run workflow. Check `include_private` and type
   `PUBLIC_LOGS_OK` ONLY if public disclosure of private repository names
   and artifact sizes is acceptable. Set `expected_min_repositories` to 52
   (account repository count at implementation time; adjust if the account changes).
4. Open the run's Summary to see the sorted table and copyable CSV. If the token
   can see fewer than the expected count or an API request fails, the audit
   fails explicitly instead of reporting missing repositories as empty.

## Full account scan without disclosing private repository inventory

Run locally in a private terminal (Python 3; no dependencies) after checking out
`doctmcp`:

```bash
export AUDIT_API_TOKEN='YOUR_READ_ONLY_FINE_GRAINED_PAT'
python3 scripts/github_artifact_audit.py --owner OneTwoTen \
  --include-private --expected-min 52 --csv "$HOME/artifact-inventory.csv"
unset AUDIT_API_TOKEN
```

Keep `$HOME/artifact-inventory.csv` private and outside the repository checkout; it contains private repository names.
On PowerShell, set the environment variable using
`$env:AUDIT_API_TOKEN = 'YOUR_READ_ONLY_FINE_GRAINED_PAT'`, then clear it
using `Remove-Item Env:AUDIT_API_TOKEN`. A token pasted in a terminal may
remain in shell history; use a private secure environment-variable mechanism
instead if necessary.

## Interpreting the data

The table reports only artifacts currently returned by the GitHub Actions
artifact API. It excludes already-expired artifacts and does not measure
Actions caches, Packages, or historical **GB-hours** accrued during the billing
cycle. A repository with 0 current artifacts could still have consumed
storage earlier in the month. API permission or pagination failures produce an
incomplete-scan error; do not treat such repositories as having zero artifacts.
