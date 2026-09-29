#!/usr/bin/env bash
#
# Verifies the structural integrity of spec/ for awthaq.
#
# Modeled directly on qadi's spec/scripts/verify-traceability.sh (same
# report format, same philosophy: every check exists to make one class of
# drift impossible to merge silently), adapted for the EA infix. Checks 5b
# (anchor-fragment integrity) and 8 (BEH-EA completeness) are additions
# beyond qadi's own script, added because this tree was previously broken in
# exactly those two ways by hand. Check 4 (features -> traceability) accepts
# either spec/traceability.md or features/traceability.md as the place a
# @REQ-EA-NNN tag is defined, since the Gherkin suite
# (features/features/*.feature) keeps its full per-scenario manifest in the
# latter, not duplicated into the former.
#
# Checks 4b and 9-15 keep the tree honest about the shipped state (DTWS-001,
# TMS-009, MM-005, AVS-008, DTWS-008, BDD-003): a stale "nothing is built"
# claim, a test path that no longer exists, a gate marked Active with no
# command behind it, or an inventory table that disagrees with the exports it
# describes fails here. The Node checks live in spec/scripts/check-drift.mjs.
#
# Usage: bash spec/scripts/verify-traceability.sh [--strict]
#   --strict  treat SKIP as FAIL (mirrors qadi). `pnpm check` runs this with
#             --strict as its last step, so CI holds the strict bar.

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
# A Gherkin suite exists (features/features/*.feature), so this check runs for
# real rather than SKIPping. The full
# per-scenario manifest — one row per REQ-EA-NNN, too large to duplicate
# inline in this file without drowning spec/traceability.md's other
# file-level tables — lives in features/traceability.md instead, generated by
# features/scripts/allocate-req-ea.py; spec/traceability.md §6 carries only a
# file-level summary and a pointer to it. So a tag is "defined" if it appears
# in either file; features/traceability.md is where every individual id is
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
# 4a. AH-010: the @REQ-EA tags in features/features and the rows of
# features/traceability.md are the same set, and each tag is used once.
#
# Check 4 only proves a tag is defined *somewhere*; it cannot notice a tag
# that appears on two scenarios, a manifest row whose scenario was deleted, or
# a header count that no longer matches. The allocator refuses duplicates, but
# only when someone runs it — this makes CI the second line.
# ---------------------------------------------------------------------------
if [[ -d "$ROOT_DIR/features/features" && -f "$ROOT_DIR/features/traceability.md" ]]; then
  # Tag occurrences on non-comment lines (a comment may mention a tag id).
  tag_lines=$(grep -rhE '^[[:space:]]*@' "$ROOT_DIR/features/features" --include='*.feature' 2>/dev/null \
    | grep -oE '@REQ-EA-[0-9]{3}' | sed -E 's/^@//' | sort)
  tag_set=$(printf '%s\n' "$tag_lines" | sed '/^$/d' | sort -u)
  dup_tags=$(printf '%s\n' "$tag_lines" | sed '/^$/d' | uniq -d | tr '\n' ' ')
  row_ids=$(grep -oE '^\| REQ-EA-[0-9]{3} ' "$ROOT_DIR/features/traceability.md" | sed -E 's/^\| //; s/ $//' | sort)
  row_set=$(printf '%s\n' "$row_ids" | sed '/^$/d' | sort -u)
  dup_rows=$(printf '%s\n' "$row_ids" | sed '/^$/d' | uniq -d | tr '\n' ' ')
  tags_only=$(comm -23 <(printf '%s\n' "$tag_set") <(printf '%s\n' "$row_set") | tr '\n' ' ')
  rows_only=$(comm -13 <(printf '%s\n' "$tag_set") <(printf '%s\n' "$row_set") | tr '\n' ' ')
  row_count=$(printf '%s\n' "$row_set" | sed '/^$/d' | wc -l | tr -d ' ')
  header_count=$(grep -oE '[0-9]+ `REQ-EA-NNN` ids allocated' "$ROOT_DIR/features/traceability.md" | grep -oE '^[0-9]+' | head -1)
  if [[ -n "$dup_tags" ]]; then
    report FAIL "features tags <-> manifest rows" "tag used more than once:${dup_tags}"
  elif [[ -n "$dup_rows" ]]; then
    report FAIL "features tags <-> manifest rows" "manifest row duplicated:${dup_rows}"
  elif [[ -n "$tags_only" ]]; then
    report FAIL "features tags <-> manifest rows" "tag without manifest row (re-run features/scripts/allocate-req-ea.py): ${tags_only}"
  elif [[ -n "$rows_only" ]]; then
    report FAIL "features tags <-> manifest rows" "manifest row without a tag: ${rows_only}"
  elif [[ "${header_count:-}" != "$row_count" ]]; then
    report FAIL "features tags <-> manifest rows" "header says ${header_count:-?} ids, manifest has ${row_count} rows"
  else
    report PASS "features tags <-> manifest rows" "${row_count} tag(s) = ${row_count} manifest row(s), each used once"
  fi
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
# uncompiled illustrations — a ```typescript or ```tsx fence would falsely
# claim the example compiles against the real API (gate 8, doc-example
# compilation, is not wired).
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
# 7. Traceability "Planned:" cells reference no path that already exists.
#
# A "Planned: <path>" cell names a test or module that is intended but not
# written. If that path exists on disk, the cell is stale: the work landed
# and the cell should cite it as enforcing evidence instead. (The inverse
# direction, a cited path that does not exist, is check 10.)
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
# 4b. features/traceability.md is exactly what the allocator would generate
# (BDD-003). `pnpm check` runs this script, so adding or retitling a scenario
# without regenerating the manifest fails CI instead of drifting until an
# audit finds it. Fix: python3 features/scripts/allocate-req-ea.py
# ---------------------------------------------------------------------------
if [[ -f "$ROOT_DIR/features/scripts/allocate-req-ea.py" ]] && command -v python3 > /dev/null 2>&1; then
  if drift="$(python3 "$ROOT_DIR/features/scripts/allocate-req-ea.py" --check 2>&1)"; then
    report PASS "features manifest is current" "$drift"
  else
    report FAIL "features manifest is current" "$(tail -n 1 <<< "$drift")"
  fi
else
  report SKIP "features manifest is current" "allocate-req-ea.py or python3 absent"
fi

# ---------------------------------------------------------------------------
# 9-15. Checks implemented in Node (spec/scripts/check-drift.mjs): stale
# status phrases, enforcement cells vs tree, gates vs package.json scripts,
# core-API and ports inventories vs source, Document Control revisions, unique
# REQ-EA tags. The Node script prints `STATUS<TAB>name<TAB>detail` lines.
# ---------------------------------------------------------------------------
if command -v node > /dev/null 2>&1; then
  while IFS=$'\t' read -r status name detail; do
    [[ -z "$status" ]] && continue
    report "$status" "$name" "$detail"
  done < <(node "$SPEC_DIR/scripts/check-drift.mjs" 2>&1 || true)
else
  report SKIP "drift checks (check-drift.mjs)" "node absent"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "PASS: $PASS   FAIL: $FAIL   SKIP: $SKIP$([[ $STRICT -eq 1 ]] && echo ' (strict: skips count as failures)')"
echo

[[ $FAIL -eq 0 ]] || exit 1
