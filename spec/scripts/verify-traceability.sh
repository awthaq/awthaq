#!/usr/bin/env bash
#
# Verifies the structural integrity of spec/ for awthaq.
#
# Modeled directly on qadi's spec/scripts/verify-traceability.sh (same
# report format, same philosophy: every check exists to make one class of
# drift impossible to merge silently), adapted for the EA infix and for a
# pre-implementation project that has no packages/ source tree yet. Two
# checks (5b anchor-fragment integrity, 8 BEH-EA completeness) are additions
# beyond qadi's own script, added because this tree was previously broken in
# exactly those two ways by hand. Check 4 (features -> traceability) now
# accepts either spec/traceability.md or features/traceability.md as the
# place a @REQ-EA-NNN tag is defined, since a Gherkin suite exists
# (features/features/*.feature) and its full per-scenario manifest lives in
# the latter, not duplicated into the former.
#
# Usage: bash spec/scripts/verify-traceability.sh [--strict]
#   --strict  treat SKIP as FAIL (mirrors qadi; no CI reads this yet, so
#             --strict is for a human choosing to hold a stricter local bar)

set -uo pipefail

STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

SPEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$SPEC_DIR/.." && pwd)"

PASS=0
FAIL=0
SKIP=0

report() { # status, check, detail
  printf '| %-6s | %-38s | %s\n' "$1" "$2" "$3"
  case "$1" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    SKIP) if [[ $STRICT -eq 1 ]]; then FAIL=$((FAIL + 1)); else SKIP=$((SKIP + 1)); fi ;;
  esac
}

slugify() { # GitHub-style heading slug (approximate; see note in file header)
  # Each space becomes one hyphen (NOT collapsed) — a removed em-dash between
  # two spaces must survive as a double hyphen, matching GitHub's algorithm.
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9_ -]//g' \
    | tr ' ' '-'
}

echo
echo "awthaq specification verification"
echo "| Status | Check                                | Detail"
echo "| ------ | ------------------------------------ | ------"

# ---------------------------------------------------------------------------
# 1. Every index.yaml entry resolves to a file on disk, and vice versa.
# ---------------------------------------------------------------------------
for index in "$SPEC_DIR"/*/index.yaml; do
  [[ -e "$index" ]] || continue
  dir="$(dirname "$index")"
  name="$(basename "$dir")"

  missing=""
  declared=""
  while IFS= read -r file; do
    declared="${declared} ${file}"
    [[ -f "$dir/$file" ]] || missing="${missing} ${file}"
  done < <(grep -oE '^\s+file:\s*"[^"]+"' "$index" | sed -E 's/.*"([^"]+)".*/\1/')

  if [[ -n "$missing" ]]; then
    report FAIL "$name/index.yaml -> disk" "missing:${missing}"
  else
    count=$(wc -w <<< "$declared" | tr -d ' ')
    report PASS "$name/index.yaml -> disk" "$count entry(ies) resolve"
  fi

  orphans=""
  for f in "$dir"/*.md; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"
    [[ "$base" == "README.md" ]] && continue
    grep -q "\"$base\"" "$index" || orphans="${orphans} ${base}"
  done

  if [[ -n "$orphans" ]]; then
    report FAIL "$name/ disk -> index.yaml" "orphaned:${orphans}"
  else
    report PASS "$name/ disk -> index.yaml" "no orphans"
  fi
done

# ---------------------------------------------------------------------------
# 2. Every INV-EA-NNN in invariants.md appears in traceability.md.
# ---------------------------------------------------------------------------
if [[ -f "$SPEC_DIR/invariants.md" && -f "$SPEC_DIR/traceability.md" ]]; then
  untraced=""
  count=0
  while IFS= read -r inv; do
    count=$((count + 1))
    grep -q "$inv" "$SPEC_DIR/traceability.md" || untraced="${untraced} ${inv}"
  done < <(grep -oE 'INV-EA-[0-9]{3}' "$SPEC_DIR/invariants.md" | sort -u)

  if [[ -n "$untraced" ]]; then
    report FAIL "invariants -> traceability" "untraced:${untraced}"
  else
    report PASS "invariants -> traceability" "all $count invariant(s) traced"
  fi
else
  report SKIP "invariants -> traceability" "invariants.md or traceability.md absent"
fi

# ---------------------------------------------------------------------------
# 3. Every ADR file maps to an ADR-EA-NNN present in traceability.md.
# ---------------------------------------------------------------------------
if [[ -d "$SPEC_DIR/decisions" && -f "$SPEC_DIR/traceability.md" ]]; then
  untraced=""
  found=0
  for f in "$SPEC_DIR"/decisions/[0-9][0-9][0-9]-*.md; do
    [[ -e "$f" ]] || continue
    found=$((found + 1))
    num="$(basename "$f" | cut -c1-3)"
    grep -q "ADR-EA-$num" "$SPEC_DIR/traceability.md" || untraced="${untraced} ADR-EA-$num"
  done

  if [[ $found -eq 0 ]]; then
    report SKIP "decisions -> traceability" "no ADR files yet"
  elif [[ -n "$untraced" ]]; then
    report FAIL "decisions -> traceability" "untraced:${untraced}"
  else
    report PASS "decisions -> traceability" "$found ADR(s) traced"
  fi
else
  report SKIP "decisions -> traceability" "decisions/ or traceability.md absent"
fi

# ---------------------------------------------------------------------------
# 3b. Every URS-EA/NFR-EA declared in urs.md appears at least twice in it —
# once as its heading, once more wherever it is traced to a behavior. A
# requirement added without a second occurrence is a requirement nobody
# traced.
# ---------------------------------------------------------------------------
if [[ -f "$SPEC_DIR/urs.md" ]]; then
  untraced=""
  declared=0
  while IFS= read -r urs; do
    declared=$((declared + 1))
    n=$(grep -c "$urs" "$SPEC_DIR/urs.md")
    [[ "$n" -ge 2 ]] || untraced="${untraced} ${urs}"
  done < <(grep -oE '^### (URS|NFR)-EA-[0-9]{3}' "$SPEC_DIR/urs.md" | sed -E 's/^### //' | sort -u)

  if [[ $declared -eq 0 ]]; then
    report SKIP "urs -> traceability table" "no requirements declared"
  elif [[ -n "$untraced" ]]; then
    report FAIL "urs -> traceability table" "untraced:${untraced}"
  else
    report PASS "urs -> traceability table" "$declared requirement(s) traced"
  fi
else
  report SKIP "urs -> traceability table" "urs.md absent"
fi

# ---------------------------------------------------------------------------
# 4. Every REQ-EA-NNN tag used in a .feature file is defined in traceability.md.
#
# A Gherkin suite now exists (features/features/*.feature, REQ-EA-001 through
# REQ-EA-602), so this check runs for real rather than SKIPping. The full
# per-scenario manifest — one row per REQ-EA-NNN, too large to duplicate
# inline in this file without drowning spec/traceability.md's other
# file-level tables — lives in features/traceability.md instead, generated by
# features/scripts/allocate-req-ea.py; spec/traceability.md §6 carries only a
# file-level summary and a pointer to it. So a tag is "defined" if it appears
# in either file; features/traceability.md is where 602 individual ids are
# actually expected to resolve.
# ---------------------------------------------------------------------------
if [[ -d "$ROOT_DIR/features/features" && -f "$SPEC_DIR/traceability.md" ]]; then
  undefined=""
  tags=$(grep -rhoE '@REQ-EA-[0-9]{3}' "$ROOT_DIR/features/features" 2>/dev/null | sort -u)
  if [[ -z "$tags" ]]; then
    report SKIP "features -> traceability" "no .feature tags yet"
  else
    while IFS= read -r tag; do
      if grep -q "${tag#@}" "$SPEC_DIR/traceability.md" 2>/dev/null; then
        continue
      fi
      if [[ -f "$ROOT_DIR/features/traceability.md" ]] && grep -q "${tag#@}" "$ROOT_DIR/features/traceability.md" 2>/dev/null; then
        continue
      fi
      undefined="${undefined} ${tag}"
    done <<< "$tags"
    if [[ -n "$undefined" ]]; then
      report FAIL "features -> traceability" "undefined:${undefined}"
    else
      report PASS "features -> traceability" "all REQ tags defined (spec/traceability.md + features/traceability.md)"
    fi
  fi
else
  report SKIP "features -> traceability" "no features/ suite yet (REQ-EA reserved)"
fi

# ---------------------------------------------------------------------------
# 5. No broken relative markdown links (path component only).
#
# Links inside fenced code blocks are illustrative syntax examples, not real
# references, and are skipped. A target that exists but is gitignored counts
# as broken — it resolves on the author's machine and nowhere else.
# ---------------------------------------------------------------------------
broken=""
untracked=""
checked=0
while IFS= read -r md; do
  dir="$(dirname "$md")"
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    case "$target" in
      http*|mailto*|\#*) continue ;;
    esac
    path="${target%%#*}"
    [[ -z "$path" ]] && continue
    checked=$((checked + 1))
    if [[ ! -e "$dir/$path" ]]; then
      broken="${broken} $(basename "$md")->${path}"
    elif git -C "$ROOT_DIR" check-ignore -q "$dir/$path" 2>/dev/null; then
      untracked="${untracked} $(basename "$md")->${path}"
    fi
  done < <(awk '/^[[:space:]]*```/ { fence = !fence; next } !fence' "$md" \
    | grep -oE '\]\([^)]+\)' | sed -E 's/^\]\((.*)\)$/\1/')
done < <(find "$SPEC_DIR" -name '*.md' -type f)

if [[ -n "$broken" ]]; then
  report FAIL "relative link integrity" "broken:${broken}"
elif [[ -n "$untracked" ]]; then
  report FAIL "relative link integrity" "gitignored:${untracked}"
else
  report PASS "relative link integrity" "$checked link(s) resolve, none gitignored"
fi

# ---------------------------------------------------------------------------
# 5b. Anchor fragments resolve to a real heading in the target file.
#
# qadi's own script does not check this (it strips the fragment and checks
# only the path). awthaq's tree was previously broken exactly this way:
# every anchor was a guessed slug of a block title rather than the real
# per-requirement heading, and it went undetected until a manual audit. This
# check exists so that regression is mechanical to catch from here on.
#
# The slugifier is an approximation of GitHub's algorithm (lowercase, strip
# punctuation other than word chars/hyphens/spaces, spaces -> hyphens); a
# heading with generic-type angle brackets or unusual punctuation may need a
# human to double check a flagged mismatch rather than trusting it blindly.
# ---------------------------------------------------------------------------
anchor_broken=""
anchor_checked=0
while IFS= read -r md; do
  dir="$(dirname "$md")"
  while IFS= read -r link; do
    [[ -z "$link" ]] && continue
    case "$link" in
      http*|mailto*) continue ;;
    esac
    frag="${link#*#}"
    [[ "$link" == "$frag" ]] && continue # no '#' in link at all
    path="${link%%#*}"
    if [[ -z "$path" ]]; then
      target="$md"
    else
      target="$dir/$path"
    fi
    [[ -f "$target" ]] || continue # path-existence already reported by check 5
    anchor_checked=$((anchor_checked + 1))

    found=0
    while IFS= read -r heading; do
      slug="$(slugify "$heading")"
      if [[ "$slug" == "$frag" ]]; then
        found=1
        break
      fi
    done < <(grep -oE '^#{1,6}[[:space:]]+.*' "$target" | sed -E 's/^#{1,6}[[:space:]]+//')

    [[ $found -eq 1 ]] || anchor_broken="${anchor_broken} $(basename "$md")->#${frag}"
  done < <(awk '/^[[:space:]]*```/ { fence = !fence; next } !fence' "$md" \
    | grep -oE '\]\([^)]+\)' | sed -E 's/^\]\((.*)\)$/\1/')
done < <(find "$SPEC_DIR" -name '*.md' -type f)

if [[ -n "$anchor_broken" ]]; then
  report FAIL "anchor fragment integrity" "mismatched:${anchor_broken}"
else
  report PASS "anchor fragment integrity" "$anchor_checked anchored link(s) resolve"
fi

# ---------------------------------------------------------------------------
# 6. Fence-language rule: behaviors/, models/, and appendices/ examples are
# uncompiled — a ```typescript or ```tsx fence would falsely claim the
# example compiles against a real API that does not exist yet.
# ---------------------------------------------------------------------------
fence_hits=""
for d in behaviors models appendices; do
  [[ -d "$SPEC_DIR/$d" ]] || continue
  hits=$(grep -rlE '^```(typescript|tsx)\b' "$SPEC_DIR/$d" 2>/dev/null || true)
  [[ -n "$hits" ]] && fence_hits="${fence_hits} ${hits}"
done

if [[ -n "$fence_hits" ]]; then
  report FAIL "fence-language rule" "found compiled-language fence in:${fence_hits}"
else
  report PASS "fence-language rule" "no \`\`\`typescript/\`\`\`tsx fence in behaviors/, models/, appendices/"
fi

# ---------------------------------------------------------------------------
# 7. Traceability §4 test-file cells reference no path that already exists.
#
# Inverse of qadi's own check 6: qadi's project has shipped test files, so it
# checks that every claimed test file exists. awthaq has shipped none —
# so a "Planned: <path>" cell whose path already exists on disk would mean
# either the banner is stale or a package was published without updating
# this table. Until that day, every such path should NOT exist.
# ---------------------------------------------------------------------------
if [[ -f "$SPEC_DIR/traceability.md" ]]; then
  premature=""
  checked=0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    checked=$((checked + 1))
    [[ -e "$ROOT_DIR/$path" ]] && premature="${premature} ${path}"
  done < <(grep -oE 'Planned: `[^`]+`' "$SPEC_DIR/traceability.md" | sed -E 's/^Planned: `//; s/`$//')

  if [[ $checked -eq 0 ]]; then
    report SKIP "traceability Planned: paths" "no Planned: cells found to check"
  elif [[ -n "$premature" ]]; then
    report FAIL "traceability Planned: paths" "already exist, update the banner:${premature}"
  else
    report PASS "traceability Planned: paths" "$checked planned path(s) correctly do not exist yet"
  fi
else
  report SKIP "traceability Planned: paths" "traceability.md absent"
fi

# ---------------------------------------------------------------------------
# 8. BEH-EA identifiers are unique and contiguous (no gap, no duplicate).
#
# The allocation rule (requirement-id-scheme.md §3) is blocks of eight per
# file with no renumbering; this check verifies that rule holds in practice
# across the whole behaviors/ directory, independent of how many files or
# blocks currently exist.
# ---------------------------------------------------------------------------
if [[ -d "$SPEC_DIR/behaviors" ]]; then
  ids=$(grep -ohE '^##[[:space:]]+BEH-EA-[0-9]{3}\b' "$SPEC_DIR"/behaviors/*.md \
    | grep -oE '[0-9]{3}' | sort -n)
  count=$(wc -l <<< "$ids" | tr -d ' ')
  dupes=$(sort <<< "$ids" | uniq -d | tr '\n' ' ')
  uniq_count=$(sort -u <<< "$ids" | wc -l | tr -d ' ')
  max=$(tail -1 <<< "$ids")
  gaps=""
  if [[ -n "$dupes" ]]; then
    report FAIL "BEH-EA id integrity" "duplicate id(s): ${dupes}"
  else
    expect=$(seq -f '%03g' 1 "$((10#$max))")
    have=$(sort -u <<< "$ids")
    missing=$(comm -23 <(echo "$expect") <(echo "$have") | tr '\n' ' ')
    if [[ -n "$missing" ]]; then
      report FAIL "BEH-EA id integrity" "gap(s) below BEH-EA-$max: ${missing}"
    else
      report PASS "BEH-EA id integrity" "$uniq_count id(s), contiguous 001-$max, no duplicates"
    fi
  fi
else
  report SKIP "BEH-EA id integrity" "behaviors/ absent"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "PASS: $PASS   FAIL: $FAIL   SKIP: $SKIP$([[ $STRICT -eq 1 ]] && echo ' (strict: skips count as failures)')"
echo

[[ $FAIL -eq 0 ]] || exit 1
