#!/usr/bin/env python3
"""Phase 0 step 1: write validation verdicts from .plan/plan.json into .issues/*.md (idempotent).

wontfix recommendations are NOT applied to Status (plan README §7: needs user confirmation) — comment only.
"""
import json, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = json.load(open(os.path.join(ROOT, ".plan/plan.json")))
MARK = "**Plan validation (2026-09-29):**"
changed = skipped = 0
for i in P["issues"]:
    path = os.path.join(ROOT, i["issue_file"])
    text = open(path).read()
    if MARK in text:
        skipped += 1
        continue
    rec = i.get("recommended_status")
    apply = rec in ("resolved", "ready-for-agent", "ready-for-human")
    v = i["verdict"]
    ev = (i.get("evidence") or [{}])[0]
    ptr = f"{ev.get('path','')}:{ev.get('line','')}".rstrip(":")
    bits = [f"{MARK} {v} (confidence {i.get('confidence','?')}); workstream `{i.get('workstream')}`."]
    if i.get("duplicate_of"):
        bits.append(f"Duplicate of `{i['duplicate_of']}` — closed by that issue's fix.")
    if i.get("fixed_by_commit"):
        bits.append(f"Already fixed by commit {i['fixed_by_commit']}.")
    if ptr:
        bits.append(f"Evidence at HEAD ec065a7: `{ptr}`.")
    if v in ("CONFIRMED", "PARTIAL") and i.get("fix"):
        bits.append(f"Fix: {i['fix'].get('summary','')} (effort {i['fix'].get('effort','?')}).")
    if i.get("needs_decision"):
        bits.append("Needs a decision first — see `.plan/DECISIONS.md`.")
    if rec == "wontfix":
        bits.append("Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged.")
    bits.append(f"Full dossier: `.plan/slices/{i['_slice']}.md`.")
    if apply and rec != i.get("current_status"):
        text = re.sub(r"^Status: .*$", f"Status: {rec}", text, count=1, flags=re.M)
        text = re.sub(r"^Status: \*\*.*\*\*$", f"Status: **{rec}**", text, count=1, flags=re.M)
        bits.append(f"Status → {rec}.")
    if "## Comments" not in text:
        text += "\n## Comments\n"
    text = text.rstrip("\n") + "\n\n" + " ".join(bits) + "\n"
    open(path, "w").write(text)
    changed += 1
print(f"updated={changed} already-applied={skipped}")
