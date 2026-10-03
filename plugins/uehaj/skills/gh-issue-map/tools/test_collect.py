#!/usr/bin/env python3
"""collect.py の純粋な部分のテスト。gh は呼ばず、GraphQL の応答と同じ形の dict を差し込む。"""
import contextlib, io, json, os, re, subprocess, sys, tempfile, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collect  # noqa: E402

REPO = "example/widgets"


def ref(n, repo=REPO):
    return {"number": n, "repository": {"nameWithOwner": repo}}


def commit(oid, msg="msg", login="alice"):
    return {"oid": oid, "committedDate": "2026-10-01T09:00:00Z", "messageHeadline": msg,
            "author": {"name": "Alice", "user": {"login": login} if login else None}}


def tl(*nodes, filtered=None):
    return {"filteredCount": len(nodes) if filtered is None else filtered,
            "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": list(nodes)}


def xref(n, repo=REPO):
    return {"__typename": "CrossReferencedEvent", "source": ref(n, repo)}


def cref(oid, repo=REPO):
    return {"__typename": "ReferencedEvent", "commitRepository": {"nameWithOwner": repo}, "commit": commit(oid)}


def issue(number, **kw):
    n = {"number": number, "title": "issue %d" % number, "state": "OPEN", "stateReason": None,
         "createdAt": "2026-09-01T00:00:00Z", "closedAt": None, "author": {"login": "alice"},
         "labels": {"nodes": []}, "parent": None, "blockedBy": {"nodes": []}, "timelineItems": tl()}
    n.update(kw)
    return n


def pr(number, updated="2026-10-01T00:00:00Z", **kw):
    n = {"number": number, "title": "pr %d" % number, "state": "OPEN", "isDraft": False,
         "createdAt": "2026-09-30T00:00:00Z", "closedAt": None, "mergedAt": None, "updatedAt": updated,
         "author": {"login": "bob"}, "headRefName": "feat/x", "baseRefName": "main", "body": "",
         "closingIssuesReferences": {"nodes": []}, "mergeCommit": None,
         "commits": {"totalCount": 0, "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []},
         "timelineItems": tl()}
    n.update(kw)
    return n


def page(key, nodes, nxt=None):
    return {"repository": {key: {"pageInfo": {"hasNextPage": nxt is not None, "endCursor": nxt}, "nodes": nodes}}}


class PagesTest(unittest.TestCase):
    def test_passes_each_end_cursor_and_stops_at_the_cap(self):
        seen = []

        def run(q, v):
            seen.append(v["endCursor"])
            return page("issues", [len(seen)], "c%d" % len(seen))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            got = list(collect.pages(run, "q", {}, lambda d: d["repository"]["issues"], 3))
        self.assertEqual(seen, [None, "c1", "c2"])
        self.assertEqual(got, [[1], [2], [3]])
        self.assertIn("3 ページで打ち切りました", err.getvalue())

    def test_a_cursor_that_does_not_advance_stops(self):
        run = lambda q, v: page("issues", [1], "same")
        with self.assertRaises(RuntimeError):
            list(collect.pages(run, "q", {}, lambda d: d["repository"]["issues"], 50))

    def test_queries_page_with_end_cursor(self):
        for q in (collect.ISSUES_Q, collect.PRS_Q, collect.MORE_TIMELINE_Q, collect.MORE_COMMITS_Q):
            self.assertIn("$endCursor:String", q)
            self.assertIn("after:$endCursor", q)
            self.assertNotRegex(q, r"\$cursor\b")


class TransformTest(unittest.TestCase):
    def test_issue_keeps_only_facts_and_omits_empty_keys(self):
        cs = {}
        n = issue(81, state="CLOSED", stateReason="NOT_PLANNED", closedAt="2026-09-26T07:00:00Z",
                  labels={"nodes": [{"name": "enhancement"}]}, parent=ref(70),
                  blockedBy={"nodes": [ref(80), ref(79), ref(5, "other/repo")]})
        e = collect.issue_entry(n, REPO, cs, [xref(87), xref(12, "example/plugins"), xref(87),
                                              cref("2b2ff41e00aaaa"), cref("ffff000000aaaa", "other/repo")])
        self.assertEqual(e, {"t": "issue 81", "s": "closed", "r": "not_planned", "a": "alice", "c": "2026-09-01",
                             "d": "2026-09-26", "l": ["enhancement"], "p": 70, "b": [79, 80],
                             "x": [87, "example/plugins#12"], "rc": ["2b2ff41e00"]})
        self.assertEqual(cs, {"2b2ff41e00": ["2026-10-01", "alice", "msg"]})

    def test_completed_issue_has_no_reason_and_cross_repo_parent_is_dropped(self):
        e = collect.issue_entry(issue(3, state="CLOSED", stateReason="COMPLETED", parent=ref(1, "other/repo"),
                                      author=None), REPO, {}, [])
        self.assertEqual(e, {"t": "issue 3", "s": "closed", "c": "2026-09-01"})

    def test_pr_closing_keywords_and_commits(self):
        cs = {}
        body = ("Closes #48. fixes: #3, Resolved #4 and resolves #4 again.\n"
                "Not these: closes other/repo#5, prefix#6, Closing #7, see #8, unfixed #10.")
        n = pr(83, state="MERGED", isDraft=False, mergedAt="2026-09-26T04:56:08Z", body=body,
               headRefName="feat/auto-scope-roles", baseRefName="feat/auto-scope",
               closingIssuesReferences={"nodes": [ref(48), ref(9, "other/repo")]},
               mergeCommit=commit("2323799aaaaaaa", "merge", login=None))
        e = collect.pr_entry(n, REPO, cs, [], [{"commit": commit("716bd72b91ffff")}])
        self.assertEqual(e["kw"], [48, 3, 4])
        self.assertEqual(e["cl"], [48])
        self.assertEqual(e["cm"], ["716bd72b91"])
        self.assertEqual(e["mc"], "2323799aaa")
        self.assertEqual(cs["2323799aaa"], ["2026-10-01", "Alice", "merge"])
        self.assertEqual(e["d"], "2026-09-26")
        self.assertNotIn("dr", e)

    def test_timeline_truncation_uses_filtered_count(self):
        self.assertFalse(collect.truncated({"totalCount": 5, "filteredCount": 0, "nodes": []}, "filteredCount"))
        self.assertTrue(collect.truncated({"totalCount": 5, "filteredCount": 101, "nodes": [0] * 100},
                                          "filteredCount"))


class CollectTest(unittest.TestCase):
    def run_collect(self, responses):
        calls = []

        def run(q, v):
            calls.append((q, v))
            return responses(q, v)
        return collect.collect(run, REPO, "2026-09-01", 10, "2026-10-04T00:00:00Z"), calls

    def test_pr_paging_stops_at_since_and_truncated_parts_are_refetched(self):
        long_tl = tl(xref(1), filtered=2)
        long_tl["pageInfo"] = {"hasNextPage": True, "endCursor": "t1"}

        def responses(q, v):
            if q is collect.ISSUES_Q:
                return page("issues", [issue(1, timelineItems=long_tl)])
            if q is collect.MORE_TIMELINE_Q:
                self.assertEqual((v["number"], v["endCursor"]), (1, "t1"))
                return {"repository": {"issueOrPullRequest": {"it": {
                    "pageInfo": {"hasNextPage": False, "endCursor": "t2"}, "nodes": [xref(2)]}}}}
            if q is collect.PRS_Q:
                if v["endCursor"] is None:
                    return page("pullRequests", [pr(2), pr(3)], "p1")
                return page("pullRequests", [pr(4), pr(5, updated="2026-08-31T23:59:59Z")], "p2")
            self.fail("予期しないクエリ")
        data, calls = self.run_collect(responses)
        self.assertEqual(set(data["i"]), {"1"})
        self.assertEqual(data["i"]["1"]["x"], [1, 2])
        self.assertEqual(set(data["p"]), {"2", "3", "4"})
        self.assertEqual([v["endCursor"] for q, v in calls if q is collect.PRS_Q], [None, "p1"])
        self.assertEqual(data["since"], "2026-09-01")


    def test_pr_commits_past_the_first_page_are_refetched(self):
        cm = {"totalCount": 2, "pageInfo": {"hasNextPage": True, "endCursor": "k1"},
              "nodes": [{"commit": commit("aaaaaaaaaa1111")}]}

        def responses(q, v):
            if q is collect.ISSUES_Q:
                return page("issues", [])
            if q is collect.PRS_Q:
                return page("pullRequests", [pr(7, commits=cm)])
            if q is collect.MORE_COMMITS_Q:
                self.assertEqual((v["number"], v["endCursor"]), (7, "k1"))
                return {"repository": {"pullRequest": {"commits": {
                    "pageInfo": {"hasNextPage": False, "endCursor": "k2"}, "nodes": [{"commit": commit("bbbbbbbbbb2222")}]}}}}
            self.fail("予期しないクエリ")
        data, calls = self.run_collect(responses)
        self.assertEqual(data["p"]["7"]["cm"], ["aaaaaaaaaa", "bbbbbbbbbb"])
        self.assertEqual(set(data["cs"]), {"aaaaaaaaaa", "bbbbbbbbbb"})


class MainTest(unittest.TestCase):
    def main(self, *argv):
        with mock.patch.object(sys, "argv", ["collect.py"] + list(argv)), \
                contextlib.redirect_stdout(io.StringIO()):
            collect.main()

    def test_without_repo_a_gh_failure_says_why(self):
        failed = subprocess.CompletedProcess([], 4, "", "To get started with GitHub CLI, please run:  gh auth login\n")
        with mock.patch.object(collect.subprocess, "run", return_value=failed), \
                self.assertRaises(SystemExit) as e:
            self.main("--out", os.devnull)
        self.assertIn("gh repo view", str(e.exception.code))
        self.assertIn("gh auth login", str(e.exception.code))

    def test_missing_gh_says_so(self):
        with mock.patch.object(collect.subprocess, "run", side_effect=FileNotFoundError("gh")), \
                self.assertRaises(SystemExit) as e:
            self.main("--out", os.devnull)
        self.assertIn("gh が見つかりません", str(e.exception.code))

    def test_out_directory_is_created(self):
        empty = lambda q, v: page("pullRequests" if q is collect.PRS_Q else "issues", [])
        with tempfile.TemporaryDirectory() as d, mock.patch.object(collect, "gh", empty):
            out = os.path.join(d, "new", "dir", "map.json")
            self.main("--repo", REPO, "--out", out)
            with open(out, encoding="utf-8") as f:
                self.assertEqual(json.load(f)["repo"], REPO)


class SinceTest(unittest.TestCase):
    def test_forms(self):
        import datetime
        today = datetime.date(2026, 10, 4)
        self.assertEqual(collect.parse_since("6m", today), "2026-04-04")
        self.assertEqual(collect.parse_since("6month", today), "2026-04-04")
        self.assertEqual(collect.parse_since("90d", today), "2026-07-06")
        self.assertEqual(collect.parse_since("2026-01-02", today), "2026-01-02")
        with self.assertRaises(ValueError):
            collect.parse_since("last week", today)


if __name__ == "__main__":
    unittest.main()
