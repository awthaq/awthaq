#!/usr/bin/env python3
"""
Allocate @REQ-EA-NNN tags across the awthaq Gherkin suite and (re)generate
features/traceability.md.

Deterministic and idempotent: walks the .feature files in the fixed order
below, tracking the current @BEH-EA-NNN Rule. A Scenario:/Scenario Outline:
line that already carries a @REQ-EA-NNN tag directly above it keeps that
number (identifiers are permanent — see spec/process/requirement-id-scheme.md
§3); a new, untagged scenario is assigned the next number after the highest
one already in use. Run this again after adding new scenarios to the suite;
it will not renumber or duplicate existing ids.

Usage: python3 features/scripts/allocate-req-ea.py [--check]
(run from the awthaq repo root, or anywhere — paths below are resolved
relative to this script's own location)

--check writes nothing: it exits non-zero when a scenario still lacks a
@REQ-EA tag or features/traceability.md differs from what this script would
generate. spec/scripts/verify-traceability.sh runs it, so `pnpm check` fails
when a .feature file changes without the regenerated manifest (BDD-003).
"""
import re
import sys
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
    "09-admin-and-impersonation/27-admin-impersonation.feature",
    "05-authentication-methods/28-device-authorization.feature",
    "10-organization/35-organization.feature",
    "11-jwt/36-jwt.feature",
    "12-multi-tenancy/28-tenancy.feature",
    "13-enterprise-federation/29-saml-sp.feature",
    "13-enterprise-federation/30-scim.feature",
    "14-mfa-passwordless/31-two-factor.feature",
    "14-mfa-passwordless/32-magic-link.feature",
    "14-mfa-passwordless/33-email-otp.feature",
    "15-webhooks/34-webhooks.feature",
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
    "27-admin-impersonation.feature": "27-admin-impersonation.md",
    "35-organization.feature": "35-organization.md",
    "36-jwt.feature": "36-jwt.md",
    "28-tenancy.feature": "28-tenancy.md",
    "29-saml-sp.feature": "29-saml-sp.md",
    "30-scim.feature": "30-scim.md",
    "31-two-factor.feature": "31-two-factor.md",
    "32-magic-link.feature": "32-magic-link.md",
    "33-email-otp.feature": "33-email-otp.md",
    "34-webhooks.feature": "34-webhooks.md",
}

# DAG-007: a feature for a plugin that has no BEH-EA range yet traces to its model
# (spec/models/) through `@MOD-EA-NNN` Rule tags instead of `@BEH-EA-NNN`.
SOURCE_MODEL = {
    "28-device-authorization.feature": "13-device-authorization.md",
}

RULE_RE = re.compile(r'^\s*Rule:')
BEH_TAG_RE = re.compile(r'@(?:BEH|MOD)-EA-(\d{3})')
RULE_KIND_RE = re.compile(r'@(BEH|MOD)-EA-\d{3}')
REQ_TAG_RE = re.compile(r'@REQ-EA-(\d{3,})')
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


def check_order_matches_disk():
    """
    AH-001 (aslak-hellesoy): `27-admin-impersonation.feature` was hand-tagged
    with 25 @REQ-EA ids outside this script's deterministic pass because it
    was simply missing from ORDER — a file present on disk but absent here
    has its tags silently unscanned, so nothing ever detects a collision
    against numbers a *listed* file already owns. Raises before any
    allocation runs, rather than letting a missing/stale entry produce an
    ambiguous manifest.
    """
    # `_smoke/smoke.feature` is deliberately outside the numbered
    # specification (its own header comment: "Not part of the awthaq
    # specification") — no @BEH-EA/@REQ-EA tags, exists only to prove the
    # Cucumber/vitest pipeline wiring, so it is exempt from this check
    # rather than something ORDER needs to ever list.
    on_disk = {
        p.relative_to(FEATURES).as_posix()
        for p in FEATURES.rglob("*.feature")
        if p.relative_to(FEATURES).parts[0] != "_smoke"
    }
    in_order = set(ORDER)
    missing_from_order = sorted(on_disk - in_order)
    if missing_from_order:
        raise SystemExit(
            "allocate-req-ea.py: the following .feature file(s) exist on disk but are "
            f"not listed in ORDER — add them before running: {missing_from_order}"
        )
    stale_in_order = sorted(in_order - on_disk)
    if stale_in_order:
        raise SystemExit(
            f"allocate-req-ea.py: ORDER lists file(s) that no longer exist on disk: {stale_in_order}"
        )


def check_no_duplicate_req_ids(manifest):
    """Raises if any @REQ-EA-NNN id is tagged in more than one feature file — the collision this allocator exists to prevent, never to silently paper over."""
    owner_by_req_id = {}
    for req_id, _beh_id, rel, _title in manifest:
        owner = owner_by_req_id.get(req_id)
        if owner is not None:
            # AH-010: a duplicate inside one file is as ambiguous as one across two.
            where = f"twice in {rel}" if owner == rel else f"in both {owner} and {rel}"
            raise SystemExit(
                f"allocate-req-ea.py: {req_id} is tagged {where} — "
                "duplicate REQ-EA id, refusing to write an ambiguous manifest."
            )
        owner_by_req_id[req_id] = rel


# The manifest's Document Control block is emitted from these constants so a
# regeneration never resets it (BDD-003). Bump them when the manifest's own
# format changes, not when scenarios are added: the row count is generated.
MANIFEST_REVISION = "1.1"
MANIFEST_DATE = "2026-09-29"
MANIFEST_HISTORY = (
    "1.0 (2026-09-12): Initial release, generated from `features/features/**/*.feature` (CCR-EA-003) "
    "<br> 1.1 (2026-09-29): Header is emitted by the generator so regeneration keeps it; "
    "`27-admin-impersonation.feature` (REQ-EA-603..627) and every later feature file are allocated "
    "(BDD-003, CCR-EA-006)"
)


def main(check=False):
    check_order_matches_disk()
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
    untagged = []  # scenarios --check found without a @REQ-EA tag

    for rel in ORDER:
        path = FEATURES / rel
        lines = path.read_text(encoding="utf-8").splitlines()
        out = []
        current_beh = None
        current_kind = "BEH"
        for line in lines:
            if RULE_RE.match(line):
                for prev in reversed(out):
                    m = BEH_TAG_RE.search(prev)
                    if m:
                        current_beh = m.group(1)
                        current_kind = RULE_KIND_RE.search(prev).group(1)
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
                    untagged.append(f"{rel}: {title.strip()}")
                    counter += 1
                    req_id_num = counter
                    out.append(f"{indent}@REQ-EA-{req_id_num:03d}")
                else:
                    req_id_num = int(existing_req)
                manifest.append(
                    (f"REQ-EA-{req_id_num:03d}", f"{current_kind}-EA-{current_beh}", rel, title.strip())
                )
            out.append(line)
        if not check:
            path.write_text("\n".join(out) + "\n", encoding="utf-8")

    check_no_duplicate_req_ids(manifest)
    manifest.sort(key=lambda row: int(row[0].split("-")[-1]))
    if not check:
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
        f"> | Revision | {MANIFEST_REVISION} |\n"
        f"> | Effective Date | {MANIFEST_DATE} |\n"
        "> | Status | Effective |\n"
        "> | Author | awthaq Engineering |\n"
        "> | Classification | Verification Record |\n"
        f"> | Change History | {MANIFEST_HISTORY} |\n"
    )
    out_lines.append("---\n")
    out_lines.append(
        f"Full manifest: one row per `REQ-EA-NNN` scenario id, its `BEH-EA-NNN` rule, its source "
        f"`.feature` file, and its scenario title. Generated mechanically by "
        f"`features/scripts/allocate-req-ea.py` in one deterministic, idempotent pass (fixed file "
        f"order, sequential numbering, existing ids never renumbered) — see `spec/traceability.md` "
        f"§6 for the file-level summary this rolls up to. {len(manifest)} `REQ-EA-NNN` ids allocated across "
        f"{len(ORDER)} `.feature` files (highest issued: REQ-EA-{counter:03d}; the ids of a scenario that "
        f"was removed are retired, never reused).\n"
    )
    out_lines.append("| REQ-EA | BEH-EA | Feature file | Scenario |")
    out_lines.append("|---|---|---|---|")
    for req_id, beh_id, rel, title in manifest:
        title_escaped = title.replace("|", "\\|")
        feature_basename = rel.split("/")[-1]
        if beh_id.startswith("MOD-"):
            beh_link = f"../spec/models/{SOURCE_MODEL[feature_basename]}"
        else:
            source_md = SOURCE_MD[feature_basename]
            anchor = anchor_index.get(source_md, {}).get(beh_id, "")
            beh_link = f"../spec/behaviors/{source_md}#{anchor}" if anchor else f"../spec/behaviors/{source_md}"
        out_lines.append(f"| {req_id} | [{beh_id}]({beh_link}) | [{rel}](features/{rel}) | {title_escaped} |")

    generated = "\n".join(out_lines) + "\n"
    if check:
        if untagged:
            raise SystemExit(
                f"allocate-req-ea.py --check: {len(untagged)} scenario(s) have no @REQ-EA tag "
                f"(first: {untagged[0]}) — run python3 features/scripts/allocate-req-ea.py"
            )
        current = manifest_path.read_text(encoding="utf-8") if manifest_path.exists() else ""
        if current != generated:
            raise SystemExit(
                "allocate-req-ea.py --check: features/traceability.md is stale against the .feature files — "
                "run python3 features/scripts/allocate-req-ea.py and commit the result"
            )
        print(f"{len(manifest)} scenario row(s), manifest current")
        return

    manifest_path.write_text(generated, encoding="utf-8")
    print(f"Wrote manifest: {manifest_path} ({len(manifest)} rows)")


if __name__ == "__main__":
    main(check="--check" in sys.argv[1:])
