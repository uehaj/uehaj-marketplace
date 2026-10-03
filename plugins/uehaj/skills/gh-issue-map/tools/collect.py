#!/usr/bin/env python3
"""GitHub の issue と PR を gh api graphql で集め、render.py が読む JSON を書く。読み取りだけで、書き込みはしない。

    python3 collect.py --out map.json [--repo owner/name] [--since 6m|90d|2026-04-01] [--max-pages 200]

認証は gh に任せる（gh auth login 済みであること）。
"""
import argparse, datetime, json, re, subprocess, sys

SHA = 10   # cm / mc / rc / cs のキーはこの長さにそろえる。そろわないとコミットから PR を引けない
PAGE = 50

COMMIT = "oid committedDate messageHeadline author{name user{login}}"
TIMELINE = """timelineItems(first:100,after:$endCursor,itemTypes:[CROSS_REFERENCED_EVENT,REFERENCED_EVENT]){
  filteredCount pageInfo{hasNextPage endCursor}
  nodes{__typename
    ... on CrossReferencedEvent{source{... on Issue{number repository{nameWithOwner}}
                                       ... on PullRequest{number repository{nameWithOwner}}}}
    ... on ReferencedEvent{commitRepository{nameWithOwner} commit{%s}}}}""" % COMMIT
FIRST_TIMELINE = TIMELINE.replace("after:$endCursor,", "")
REF = "number repository{nameWithOwner}"

# --paginate は使わず自前でページを送る。変数名は $endCursor にそろえる（gh の --paginate と同じ名前）。
ISSUES_Q = """query($owner:String!,$name:String!,$since:DateTime,$endCursor:String){repository(owner:$owner,name:$name){
 issues(first:%d,after:$endCursor,filterBy:{since:$since},orderBy:{field:UPDATED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{number title state stateReason createdAt closedAt author{login} labels(first:30){nodes{name}}
   parent{%s} blockedBy(first:50){nodes{%s}} %s}}}}""" % (PAGE, REF, REF, FIRST_TIMELINE)

PRS_Q = """query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){
 pullRequests(first:%d,after:$endCursor,orderBy:{field:UPDATED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{number title state isDraft createdAt closedAt mergedAt updatedAt author{login} headRefName baseRefName body
   closingIssuesReferences(first:50){nodes{%s}} mergeCommit{%s}
   commits(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{commit{%s}}} %s}}}}""" % (
    PAGE, REF, COMMIT, COMMIT, FIRST_TIMELINE)

MORE_TIMELINE_Q = """query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){
 issueOrPullRequest(number:$number){... on Issue{it:%s} ... on PullRequest{pt:%s}}}}""" % (TIMELINE, TIMELINE)

MORE_COMMITS_Q = """query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){
 pullRequest(number:$number){commits(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{commit{%s}}}}}}""" % COMMIT

KW_RE = re.compile(r"(?<![\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b", re.I)


def gh(query, variables):
    cmd = ["gh", "api", "graphql", "-f", "query=" + query]
    for k, v in variables.items():
        if v is not None:
            cmd += ["-F" if isinstance(v, int) else "-f", "%s=%s" % (k, v)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit("gh api graphql が失敗しました: " + (p.stderr.strip() or p.stdout.strip()))
    out = json.loads(p.stdout)
    if out.get("errors"):
        sys.exit("GraphQL のエラー: " + json.dumps(out["errors"], ensure_ascii=False))
    return out["data"]


def pages(run, query, variables, conn, max_pages):
    """conn(data) が返す connection を endCursor で送り、ページごとの nodes を返す。max_pages で必ず止まる。"""
    cursor = None
    for n in range(max_pages):
        c = conn(run(query, dict(variables, endCursor=cursor)))
        yield c["nodes"]
        info = c["pageInfo"]
        if not info["hasNextPage"]:
            return
        if info["endCursor"] in (None, cursor):
            raise RuntimeError("endCursor が進みません（%r）。同じページを取り続けるので止めます" % cursor)
        cursor = info["endCursor"]
    print("警告: %d ページで打ち切りました。--since を短くするか --max-pages を増やしてください" % max_pages,
          file=sys.stderr)


def truncated(conn, count_key):
    """入れ子の connection が 1 ページに収まらなかったか。timelineItems は filteredCount で判定する
    （totalCount は itemTypes の絞り込みを無視した全件数を返す）。commits は totalCount。"""
    return conn[count_key] > len(conn["nodes"])


def ref(node, repo):
    """同じリポジトリなら番号、別リポジトリなら 'owner/repo#N'。"""
    r = node["repository"]["nameWithOwner"]
    return node["number"] if r == repo else "%s#%d" % (r, node["number"])


def day(ts):
    return ts[:10] if ts else None


def add_commit(cs, c):
    sha = c["oid"][:SHA]
    a = c.get("author") or {}
    cs[sha] = [day(c["committedDate"]), (a.get("user") or {}).get("login") or a.get("name") or "",
               c["messageHeadline"]]
    return sha


def uniq(xs):
    return list(dict.fromkeys(xs))


def timeline(nodes, repo, cs):
    """言及（x）と、本文で参照したコミット（rc）。別リポジトリのコミットは数えない。"""
    x, rc = [], []
    for e in nodes:
        if e["__typename"] == "CrossReferencedEvent" and e["source"].get("number") is not None:
            x.append(ref(e["source"], repo))
        elif e["__typename"] == "ReferencedEvent" and e.get("commit") and \
                (e.get("commitRepository") or {}).get("nameWithOwner") == repo:
            rc.append(add_commit(cs, e["commit"]))
    return uniq(x), uniq(rc)


def compact(d):
    return {k: v for k, v in d.items() if v not in (None, [], False, "")}


def same_repo(nodes, repo):
    return [n["number"] for n in nodes if n["repository"]["nameWithOwner"] == repo]


def issue_entry(n, repo, cs, tl_nodes):
    x, rc = timeline(tl_nodes, repo, cs)
    reason = (n.get("stateReason") or "").lower()
    parent = n.get("parent")
    return compact({
        "t": n["title"], "s": n["state"].lower(),
        "r": reason if reason in ("not_planned", "duplicate") else None,
        "a": (n.get("author") or {}).get("login"), "c": day(n["createdAt"]), "d": day(n.get("closedAt")),
        "l": [l["name"] for l in n["labels"]["nodes"]],
        "p": parent["number"] if parent and parent["repository"]["nameWithOwner"] == repo else None,
        "b": sorted(same_repo(n["blockedBy"]["nodes"], repo)), "x": x, "rc": rc})


def pr_entry(n, repo, cs, tl_nodes, commit_nodes):
    x, rc = timeline(tl_nodes, repo, cs)
    mc = n.get("mergeCommit")
    return compact({
        "t": n["title"], "s": n["state"].lower(), "dr": n.get("isDraft"),
        "a": (n.get("author") or {}).get("login"), "c": day(n["createdAt"]),
        "d": day(n.get("mergedAt") or n.get("closedAt")),
        "h": n["headRefName"], "bs": n["baseRefName"],
        "cl": same_repo(n["closingIssuesReferences"]["nodes"], repo),
        "kw": uniq(int(m) for m in KW_RE.findall(n.get("body") or "")),
        "cm": uniq(add_commit(cs, c["commit"]) for c in commit_nodes),
        "mc": add_commit(cs, mc) if mc else None, "x": x, "rc": rc})


def rest(run, query, owner, name, number, conn, first, max_pages):
    """1 ページ目に収まらなかった入れ子の connection の、2 ページ目以降。"""
    cursor = first["pageInfo"]["endCursor"]
    nodes = list(first["nodes"])
    for _ in range(max_pages):
        c = conn(run(query, {"owner": owner, "name": name, "number": number, "endCursor": cursor}))
        nodes += c["nodes"]
        if not c["pageInfo"]["hasNextPage"] or c["pageInfo"]["endCursor"] in (None, cursor):
            break
        cursor = c["pageInfo"]["endCursor"]
    return nodes


def collect(run, repo, since, max_pages, now):
    owner, name = repo.split("/")
    cs, issues, prs = {}, {}, {}
    since_ts = since + "T00:00:00Z"
    tl_more = lambda d: next(v for k, v in d["repository"]["issueOrPullRequest"].items() if k in ("it", "pt"))
    cm_more = lambda d: d["repository"]["pullRequest"]["commits"]

    def tl_nodes(n):
        t = n["timelineItems"]
        if truncated(t, "filteredCount"):
            return rest(run, MORE_TIMELINE_Q, owner, name, n["number"], tl_more, t, max_pages)
        return t["nodes"]

    for page in pages(run, ISSUES_Q, {"owner": owner, "name": name, "since": since_ts},
                      lambda d: d["repository"]["issues"], max_pages):
        for n in page:
            issues[str(n["number"])] = issue_entry(n, repo, cs, tl_nodes(n))
    for page in pages(run, PRS_Q, {"owner": owner, "name": name},
                      lambda d: d["repository"]["pullRequests"], max_pages):
        fresh = [n for n in page if n["updatedAt"] >= since_ts]
        for n in fresh:
            cm = n["commits"]
            commits = rest(run, MORE_COMMITS_Q, owner, name, n["number"], cm_more, cm, max_pages) \
                if truncated(cm, "totalCount") else cm["nodes"]
            prs[str(n["number"])] = pr_entry(n, repo, cs, tl_nodes(n), commits)
        if len(fresh) < len(page):   # 更新日の新しい順なので、ここから先は期間より古い
            break
    return {"v": 1, "repo": repo, "at": now, "since": since, "i": issues, "p": prs, "cs": cs}


def parse_since(s, today):
    m = re.fullmatch(r"(\d+)\s*(d|w|m|y)[a-z]*", s)
    if not m:
        datetime.date.fromisoformat(s)
        return s
    n, unit = int(m.group(1)), m.group(2)
    if unit == "m":
        y, mo = divmod(today.year * 12 + today.month - 1 - n, 12)
        return today.replace(year=y, month=mo + 1, day=min(today.day, 28)).isoformat()
    days = {"d": 1, "w": 7, "y": 365}[unit] * n
    return (today - datetime.timedelta(days=days)).isoformat()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", help="owner/name。省略すると今のディレクトリのリポジトリ")
    ap.add_argument("--since", default="6m", help="この日以降に更新された issue / PR（YYYY-MM-DD、または 90d / 12w / 6m / 1y）")
    ap.add_argument("--max-pages", type=int, default=200, help="1 つの一覧で取るページ数の上限（1 ページ %d 件）" % PAGE)
    a = ap.parse_args()
    repo = a.repo or subprocess.run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
                                    capture_output=True, text=True, check=True).stdout.strip()
    now = datetime.datetime.now(datetime.timezone.utc)
    data = collect(gh, repo, parse_since(a.since, now.date()), a.max_pages, now.strftime("%Y-%m-%dT%H:%M:%SZ"))
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("%s: issue %d, PR %d, コミット %d" % (a.out, len(data["i"]), len(data["p"]), len(data["cs"])))


if __name__ == "__main__":
    main()
