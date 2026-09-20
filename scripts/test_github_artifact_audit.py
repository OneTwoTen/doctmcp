import io
import csv
import unittest
from github_artifact_audit import AuditError, GitHubAPI, inventory, render


class FakeAPI:
    def __init__(self, results):
        self.results = results

    def pages(self, path, field=None):
        return self.results[path]


class AuditTests(unittest.TestCase):
    def test_excludes_expired_and_sorts(self):
        repos = [{"full_name": "OneTwoTen/a", "owner": {"login": "OneTwoTen"}, "private": False}, {"full_name": "OneTwoTen/b", "owner": {"login": "OneTwoTen"}, "private": False}]
        api = FakeAPI({"/users/OneTwoTen/repos?type=public": repos, "/repos/OneTwoTen/a/actions/artifacts": [{"size_in_bytes": 1048576}, {"size_in_bytes": 9999999, "expired": True}], "/repos/OneTwoTen/b/actions/artifacts": [{"size_in_bytes": 2097152}]})
        rows = inventory(api, "OneTwoTen", False, 0)
        self.assertEqual([r["repository"] for r in rows], ["OneTwoTen/b", "OneTwoTen/a"])
        self.assertEqual(rows[1]["bytes"], 1048576)
        report, csv_text, errors = render(rows, "OneTwoTen", False)
        self.assertFalse(errors)
        self.assertIn("OneTwoTen/b (2.00 MiB)", report)
        self.assertEqual(list(csv.DictReader(io.StringIO(csv_text)))[0]["bytes"], "2097152")

    def test_scan_error_is_not_zero(self):
        class Denied(FakeAPI):
            def pages(self, path, field=None):
                if field is not None:
                    raise AuditError("HTTP 403")
                return super().pages(path, field)
        api = Denied({"/users/OneTwoTen/repos?type=public": [{"full_name": "OneTwoTen/blocked", "owner": {"login": "OneTwoTen"}, "private": False}]})
        rows = inventory(api, "OneTwoTen", False, 0)
        self.assertEqual(rows[0]["bytes"], "")
        report, _, errors = render(rows, "OneTwoTen", False)
        self.assertEqual(len(errors), 1)
        self.assertIn("Not determined", report)

    def test_pagination_over_100(self):
        api = object.__new__(GitHubAPI)
        api.get = lambda path: {"total_count": 101, "artifacts": [{}] * (100 if "page=1" in path else 1)}
        self.assertEqual(len(api.pages("/repos/OneTwoTen/a/actions/artifacts", "artifacts")), 101)


if __name__ == "__main__":
    unittest.main()
