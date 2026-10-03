#!/usr/bin/env python3
"""render.py の振る舞いのテスト。fixture.json だけで走り、ネットワークは使わない。

辺の導出はブラウザで動く JS（render.DERIVE_JS）にあるので、node で同じ JS を呼んで確かめる。
"""
import contextlib, io, json, os, re, shutil, subprocess, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render  # noqa: E402

FIXTURE = os.path.join(HERE, "fixture.json")
with open(FIXTURE, encoding="utf-8") as _f:
    FIXTURE_TEXT = _f.read()
NODE = shutil.which("node")


def run_js(expr, branch_re=render.DEFAULT_BRANCH_RE):
    """DERIVE_JS を読み込んだうえで expr を評価し、その JSON を返す。"""
    src = (render.DERIVE_JS + "\nconst D = " + FIXTURE_TEXT + ";\n"
           "const RE = " + json.dumps(branch_re) + ";\n"
           "process.stdout.write(JSON.stringify(" + expr + "));\n")
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(src)
    try:
        out = subprocess.run([NODE, f.name], capture_output=True, text=True, check=True).stdout
    finally:
        os.unlink(f.name)
    return json.loads(out)


def edge_set(edges):
    return {(e["k"], e["a"], e["b"], e["s"]) for e in edges}


EXPECTED = {
    ("order", "75", "76", "api"), ("order", "79", "81", "api"), ("order", "80", "81", "api"),
    ("impl", "147", "143", "api"), ("impl", "83", "48", "text"), ("impl", "170", "999", "text"),
    ("impl", "170", "152", "name"), ("impl", "175", "152", "name"), ("impl", "176", "152", "name"),
    ("stack", "82", "83", "api"), ("stack", "175", "176", "api"),
    ("share", "160", "162", "api"),
    ("mention", "81", "76", "api"), ("mention", "48", "76", "api"), ("mention", "147", "152", "api"), ("mention", "160", "162", "api"),
    ("mention", "example/plugins#12", "152", "api"),
}


@unittest.skipUnless(NODE, "node が無いので埋め込み JS のテストを飛ばす")
class DeriveEdgesTest(unittest.TestCase):
    def test_fixture_edges(self):
        self.assertEqual(edge_set(run_js("deriveEdges(D, RE)")), EXPECTED)

    def test_branch_re_is_configurable(self):
        got = edge_set(run_js("deriveEdges(D, RE)", branch_re=r"^nomatch-(\d+)$"))
        self.assertFalse({e for e in got if e[3] == "name"})
        self.assertIn(("mention", "175", "152", "api"), got)   # impl が消えると言及が見える

    def test_children_are_derived_from_parent(self):
        self.assertEqual(run_js("childrenOf(D)"), {"69": ["75", "76", "81"]})


@unittest.skipUnless(NODE, "node が無いので埋め込み JS のテストを飛ばす")
class ViewTest(unittest.TestCase):
    ALL = "{kinds: new Set(['order','impl','stack','share','mention']), srcs: new Set(['api','text','name'])"

    def view(self, extra):
        return run_js("(() => { const v = view(D, deriveEdges(D, RE), " + self.ALL + extra + "});"
                      " return {nodes: v.nodes, edges: v.edges.map(e => [e.k, e.a, e.b])}; })()")

    def test_hide_pr_rewires_through_implemented_issue(self):
        v = self.view(", hidePR: true, hops: 1, match: () => true")
        self.assertEqual({tuple(e) for e in v["edges"]}, {
            ("order", "75", "76"), ("order", "79", "81"), ("order", "80", "81"),
            ("mention", "81", "76"), ("mention", "48", "76"), ("mention", "143", "152"),
            ("mention", "example/plugins#12", "152")})
        self.assertFalse([n for n in v["nodes"] if n["id"] in D_PRS])

    def test_hops_zero_keeps_only_edges_inside_the_filter(self):
        v = self.view(", hops: 0, match: id => ['79','80','81','76'].includes(id)")
        self.assertEqual({tuple(e) for e in v["edges"]}, {("order", "79", "81"), ("order", "80", "81"),
                                                          ("mention", "81", "76")})

    def test_hops_one_adds_the_far_end_dimmed(self):
        v = self.view(", hops: 1, match: id => id === '176'")
        self.assertEqual({tuple(e) for e in v["edges"]}, {("impl", "176", "152"), ("stack", "175", "176")})
        self.assertEqual({n["id"]: n["dim"] for n in v["nodes"]}, {"176": False, "152": True, "175": True})

    def test_cluster_frame_holds_only_its_members(self):
        bad = run_js("""(() => {
          const v = view(D, deriveEdges(D, RE), {kinds: new Set(['order','impl','stack','mention']),
            srcs: new Set(['api','text','name']), hops: 1, clusters: true, match: () => true});
          const pos = layout(v), bad = [];
          v.clusters.forEach(c => {
            const ps = c.members.map(m => pos[m]);
            const x0 = Math.min(...ps.map(p => p[0])), x1 = Math.max(...ps.map(p => p[0]));
            const y0 = Math.min(...ps.map(p => p[1])), y1 = Math.max(...ps.map(p => p[1]));
            v.nodes.forEach(n => { const [x, y] = pos[n.id];
              if (!c.members.includes(n.id) && x >= x0 && x <= x1 && y >= y0 && y <= y1) bad.push(c.p + ':' + n.id); });
          });
          return {bad, clusters: v.clusters.map(c => c.p)};
        })()""")
        self.assertEqual(bad, {"bad": [], "clusters": ["69"]})

    def test_kind_and_src_checkboxes(self):
        v = run_js("view(D, deriveEdges(D, RE), {kinds: new Set(['impl']), srcs: new Set(['name']),"
                   " hops: 1, match: () => true}).edges.map(e => e.a + '>' + e.b)")
        self.assertEqual(sorted(v), ["170>152", "175>152", "176>152"])


D_PRS = set(json.loads(FIXTURE_TEXT)["p"])


class HtmlTest(unittest.TestCase):
    def setUp(self):
        self.d = json.loads(FIXTURE_TEXT)
        self.html = render.render_html(self.d, render.DEFAULT_BRANCH_RE)

    def test_self_contained(self):
        self.assertNotRegex(self.html, r"<script[^>]+src=")
        self.assertNotRegex(self.html, r"<link[^>]+href=")
        self.assertNotRegex(self.html, r"@import")

    def test_embedded_data_round_trips(self):
        m = re.search(r'<script type="application/json" id="data">(.*?)</script>', self.html, re.S)
        self.assertEqual(json.loads(m.group(1)), self.d)

    def test_has_both_tabs_and_kind_checkboxes(self):
        for kind in ("order", "impl", "stack", "share", "mention"):
            self.assertIn('value="%s"' % kind, self.html)
        self.assertIn('data-tab="table"', self.html)
        self.assertIn('data-tab="graph"', self.html)


@unittest.skipUnless(NODE, "node が無いので JS の正規表現の検査を飛ばす")
class BranchReTest(unittest.TestCase):
    def main(self, branch_re, out):
        argv = ["render.py", "--data", FIXTURE, "--out", out, "--branch-re", branch_re]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
            render.main()

    def test_python_only_syntax_is_refused_before_writing(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "map.html")
            for bad in (r"^issue-(?P<n>\d+)-", r"(?i)^issue-(\d+)"):
                with self.subTest(bad=bad), self.assertRaises(SystemExit) as e:
                    self.main(bad, out)
                self.assertIn("JavaScript", str(e.exception.code))
                self.assertFalse(os.path.exists(out))
            self.main(r"^issue-(?<n>\d+)-", out)
            self.assertTrue(os.path.exists(out))


class EmbedJsonTest(unittest.TestCase):
    def test_escapes_script_breakers(self):
        out = render.embed_json({"t": "</script><!-- & <script>"})
        self.assertNotIn("<", out)
        self.assertNotIn(">", out)
        self.assertEqual(json.loads(out), {"t": "</script><!-- & <script>"})


if __name__ == "__main__":
    unittest.main()
