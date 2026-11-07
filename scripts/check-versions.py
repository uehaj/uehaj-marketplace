#!/usr/bin/env python3
"""Each plugin's version in .claude-plugin/marketplace.json must equal its own plugin.json; exit 1 if not."""
import json, os, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bad = []
for p in json.load(open(os.path.join(root, ".claude-plugin/marketplace.json")))["plugins"]:
    own = json.load(open(os.path.join(root, p["source"], ".claude-plugin/plugin.json"))).get("version")
    if p.get("version") != own:
        bad.append("%s: marketplace.json %s, plugin.json %s" % (p["name"], p.get("version"), own))
print("\n".join(bad) or "versions match")
sys.exit(1 if bad else 0)
