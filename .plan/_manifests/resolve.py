#!/usr/bin/env python3
"""Resolve an issue (by file stem or unique ID) plus every plan duplicate pointing at it.

usage: resolve.py <stem-or-id> "<Resolved note>" [--no-dups]
Sets Status: resolved and appends a **Resolved (date):** comment; duplicates get a pointer comment.
"""
import glob, json, os, re, sys, datetime
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
key, note = sys.argv[1], sys.argv[2]
plan = json.load(open(os.path.join(ROOT, ".plan/plan.json")))
byk = {i["_key"]: i for i in plan["issues"]}
if key not in byk:
    cands = [k for k, i in byk.items() if i["id"] == key]
    if len(cands) != 1:
        sys.exit(f"ambiguous or unknown: {key} -> {cands}")
    key = cands[0]
today = datetime.date.today().isoformat()

def close(k, text):
    path = os.path.join(ROOT, byk[k]["issue_file"])
    s = open(path).read()
    s = re.sub(r"^Status: .*$", "Status: resolved", s, count=1, flags=re.M)
    s = re.sub(r"^Status: \*\*.*\*\*$", "Status: **resolved**", s, count=1, flags=re.M)
    open(path, "w").write(s.rstrip("\n") + f"\n\n**Resolved ({today}):** {text}\n")

close(key, note)
n = 1
if "--no-dups" not in sys.argv:
    for k, i in byk.items():
        d = i.get("duplicate_of")
        if d and (d == key or d == byk[key]["id"] and len([x for x in byk.values() if x["id"] == d]) == 1):
            close(k, f"Duplicate of `{key}` — closed by its fix (see that issue's Resolved comment).")
            n += 1
print(f"resolved {n} issue(s) under {key}")
