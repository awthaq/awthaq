#!/usr/bin/env python3
"""
Allocate @REQ-EA-NNN tags across the effect-auth Gherkin suite and (re)generate
features/traceability.md.

Deterministic and idempotent: walks the .feature files in the fixed order
below, tracking the current @BEH-EA-NNN Rule. A Scenario:/Scenario Outline:
line that already carries a @REQ-EA-NNN tag directly above it keeps that
number (identifiers are permanent — see spec/process/requirement-id-scheme.md
§3); a new, untagged scenario is assigned the next number after the highest
one already in use. Run this again after adding new scenarios to the suite;
it will not renumber or duplicate existing ids.

Usage: python3 features/scripts/allocate-req-ea.py
(run from the effect-auth repo root, or anywhere — paths below are resolved
relative to this script's own location)
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FEATURES = ROOT / "features" / "features"

# Canonical order — matches features/README.md's table.
ORDER = [
    "00-foundations/01-plugin-contract.feature",
    "00-foundations/02-plugin-composition-validate.feature",
    "00-foundations/03-ports-slots-hooks-registries.feature",
    "01-contract-and-persistence/04-contract-stratum.feature",
    "01-contract-and-persistence/05-persistence-stratum.feature",
    "02-domain/06-users-accounts.feature",
    "02-domain/07-sessions.feature",
    "02-domain/08-verification-tokens.feature",
    "03-http-layer/09-authentication-middleware.feature",
    "03-http-layer/10-csrf.feature",
    "03-http-layer/11-http-error-mapping.feature",
    "04-cross-cutting/12-hooks.feature",
    "04-cross-cutting/13-events.feature",
    "04-cross-cutting/14-rate-limiting.feature",
    "05-authentication-methods/15-password.feature",
    "05-authentication-methods/16-oauth.feature",
    "05-authentication-methods/17-passkey.feature",
    "06-roles-and-authorization-bridge/18-roles-subject-resolver.feature",
    "06-roles-and-authorization-bridge/19-qadi-bridge-path-a.feature",
    "06-roles-and-authorization-bridge/20-qadi-bridge-path-b.feature",
    "06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.feature",
    "07-client-integration/22-client-effect.feature",
    "07-client-integration/23-react.feature",
    "07-client-integration/24-nextjs-ssr.feature",
    "08-tooling/25-testing-harness.feature",
    "08-tooling/26-cli.feature",
]

# Explicit feature-file -> source-behavior-md map (most basenames match
# exactly, but 06-users-accounts.feature's source is 06-domain-users-accounts.md).
SOURCE_MD = {
    "01-plugin-contract.feature": "01-plugin-contract.md",
    "02-plugin-composition-validate.feature": "02-plugin-composition-validate.md",
    "03-ports-slots-hooks-registries.feature": "03-ports-slots-hooks-registries.md",
    "04-contract-stratum.feature": "04-contract-stratum.md",
    "05-persistence-stratum.feature": "05-persistence-stratum.md",
    "06-users-accounts.feature": "06-domain-users-accounts.md",
    "07-sessions.feature": "07-sessions.md",
    "08-verification-tokens.feature": "08-verification-tokens.md",
    "09-authentication-middleware.feature": "09-authentication-middleware.md",
    "10-csrf.feature": "10-csrf.md",
    "11-http-error-mapping.feature": "11-http-error-mapping.md",
    "12-hooks.feature": "12-hooks.md",
    "13-events.feature": "13-events.md",
    "14-rate-limiting.feature": "14-rate-limiting.md",
    "15-password.feature": "15-password.md",
    "16-oauth.feature": "16-oauth.md",
    "17-passkey.feature": "17-passkey.md",
    "18-roles-subject-resolver.feature": "18-roles-subject-resolver.md",
    "19-qadi-bridge-path-a.feature": "19-qadi-bridge-path-a.md",
    "20-qadi-bridge-path-b.feature": "20-qadi-bridge-path-b.md",
    "21-qadi-resolvers-obligations.feature": "21-qadi-resolvers-obligations.md",
    "22-client-effect.feature": "22-client-effect.md",
    "23-react.feature": "23-react.md",
    "24-nextjs-ssr.feature": "24-nextjs-ssr.md",
    "25-testing-harness.feature": "25-testing-harness.md",
    "26-cli.feature": "26-cli.md",
}

RULE_RE = re.compile(r'^\s*Rule:')
BEH_TAG_RE = re.compile(r'@BEH-EA-(\d{3})')
REQ_TAG_RE = re.compile(r'@REQ-EA-(\d{3})')
SCEN_RE = re.compile(r'^(\s*)(Scenario( Outline)?):\s*(.*)$')
HEADING_RE = re.compile(r'^##\s+(BEH-EA-\d{3}:.*)$')


def slugify(heading: str) -> str:
    """Approximate GitHub's heading slug algorithm (matches verify-traceability.sh's slugify)."""
    s = heading.lower()
    s = re.sub(r'[^a-z0-9_ -]', '', s)
    s = s.replace(' ', '-')
    return s


def build_anchor_index():
    """Map source .md basename -> {BEH-EA-NNN: anchor-slug}."""
    index = {}
    for md_path in (ROOT / "spec" / "behaviors").glob("*.md"):
        anchors = {}
        for line in md_path.read_text(encoding="utf-8").splitlines():
            m = HEADING_RE.match(line)
            if m:
                heading_text = m.group(1)
                beh_id = heading_text.split(":", 1)[0].strip()
                anchors[beh_id] = slugify(heading_text)
        index[md_path.name] = anchors
    return index


def main():
    anchor_index = build_anchor_index()

    # First pass: find the highest REQ-EA number already in use, across the
    # whole suite, so a re-run assigns only new numbers.
    max_existing = 0
    for rel in ORDER:
        path = FEATURES / rel
        for line in path.read_text(encoding="utf-8").splitlines():
            m = REQ_TAG_RE.search(line)
            if m:
                max_existing = max(max_existing, int(m.group(1)))
    counter = max_existing

    manifest = []  # (req_id, beh_id, file, scenario_title)

    for rel in ORDER:
        path = FEATURES / rel
        lines = path.read_text(encoding="utf-8").splitlines()
        out = []
        current_beh = None
        for line in lines:
            if RULE_RE.match(line):
                for prev in reversed(out):
                    m = BEH_TAG_RE.search(prev)
                    if m:
                        current_beh = m.group(1)
                        break
            m = SCEN_RE.match(line)
            if m:
                indent, _keyword, _, title = m.groups()
                # Does the immediately-preceding emitted line already carry a @REQ-EA tag?
                existing_req = None
                if out:
                    rm = REQ_TAG_RE.search(out[-1])
                    if rm:
                        existing_req = rm.group(1)
                if existing_req is None:
                    counter += 1
                    req_id_num = counter
                    out.append(f"{indent}@REQ-EA-{req_id_num:03d}")
                else:
                    req_id_num = int(existing_req)
                manifest.append((f"REQ-EA-{req_id_num:03d}", f"BEH-EA-{current_beh}", rel, title.strip()))
            out.append(line)
        path.write_text("\n".join(out) + "\n", encoding="utf-8")

    manifest.sort(key=lambda row: int(row[0].split("-")[-1]))
    print(f"{counter} REQ-EA id(s) now allocated across {len(ORDER)} files "
          f"({counter - max_existing} newly assigned this run).")

    manifest_path = ROOT / "features" / "traceability.md"
    out_lines = []
    out_lines.append("# Acceptance Scenario Traceability Manifest\n")
    out_lines.append(
        "> **Document Control**\n>\n"
        "> | Property | Value |\n"
        "> |---|---|\n"
        "> | Document ID | EFAUTH-FEAT-RTM |\n"
        "> | Revision | 1.0 |\n"
        "> | Effective Date | 2026-09-12 |\n"
        "> | Status | Effective |\n"
        "> | Author | effect-auth Engineering |\n"
        "> | Classification | Verification Record |\n"
        "> | Change History | 1.0 (2026-09-12): Initial release, generated from "
        "`features/features/**/*.feature` (CCR-EA-003) |\n"
    )
    out_lines.append("---\n")
    out_lines.append(
        f"Full manifest: one row per `REQ-EA-NNN` scenario id, its `BEH-EA-NNN` rule, its source "
        f"`.feature` file, and its scenario title. Generated mechanically by "
        f"`features/scripts/allocate-req-ea.py` in one deterministic, idempotent pass (fixed file "
        f"order, sequential numbering, existing ids never renumbered) — see `spec/traceability.md` "
        f"§6 for the file-level summary this rolls up to. {counter} `REQ-EA-NNN` ids allocated across "
        f"{len(ORDER)} `.feature` files.\n"
    )
    out_lines.append("| REQ-EA | BEH-EA | Feature file | Scenario |")
    out_lines.append("|---|---|---|---|")
    for req_id, beh_id, rel, title in manifest:
        title_escaped = title.replace("|", "\\|")
        feature_basename = rel.split("/")[-1]
        source_md = SOURCE_MD[feature_basename]
        anchor = anchor_index.get(source_md, {}).get(beh_id, "")
        beh_link = f"../spec/behaviors/{source_md}#{anchor}" if anchor else f"../spec/behaviors/{source_md}"
        out_lines.append(f"| {req_id} | [{beh_id}]({beh_link}) | [{rel}](features/{rel}) | {title_escaped} |")

    manifest_path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(f"Wrote manifest: {manifest_path} ({len(manifest)} rows)")


if __name__ == "__main__":
    main()
