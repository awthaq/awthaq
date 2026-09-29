# Requirement ID Scheme
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-PROC-01 |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Process Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Broadened MOD-EA-NNN's description from authentication-method-only to authentication-method-or-core-plugin, to cover Organization and Admin (CCR-EA-002) <br> 1.2 (2026-09-12): `REQ-EA-NNN` is no longer reserved-only — a Gherkin suite now exists at `features/features/*.feature`, allocating `REQ-EA-001` through `REQ-EA-602` (CCR-EA-003) <br> 1.3 (2026-09-29): Dropped the hard-coded `REQ-EA` allocation range (it drifted from 602 to 685) and the claim that no `REQ` scenario runs: the suite is wired for some feature files, and the manifest and id uniqueness are checked by `spec/scripts/verify-traceability.sh` (BDD-003, DTWS-006, CCR-EA-006) |
---

## 1. Package Infix

All identifiers in this specification use the infix **`EA`** (awthaq).

The infix exists to keep awthaq's identifiers distinct from those of
sibling projects that are frequently open side by side with this
specification — most importantly qadi, whose identifiers use the infix `QD`.
`BEH-EA-009` and `BEH-QD-009` are unrelated requirements in unrelated
documents; the infix is what makes a bare citation like "BEH-009" ambiguous
enough that this specification never writes one. Any future sibling project
gets its own infix rather than reusing `EA` or `QD`.

## 2. Identifier Registry

| Prefix | Meaning | Defined in | Range |
|---|---|---|---|
| `BEH-EA-NNN` | Functional behavior requirement | `behaviors/NN-*.md` headings | 001– |
| `URS-EA-NNN` | User requirement | `urs.md` | 001– |
| `NFR-EA-NNN` | Non-functional requirement | `urs.md` | 001– |
| `INV-EA-NNN` | Invariant (type-level or runtime) | `invariants.md` | 001– |
| `ADR-EA-NNN` | Architecture decision | `decisions/NNN-*.md` | 001– |
| `REQ-EA-NNN` | BDD-testable acceptance requirement | `features/features/**/*.feature` (`Scenario:`/`Scenario Outline:` tags) | 001– (allocated by `features/scripts/allocate-req-ea.py`) |
| `MOD-EA-NNN` | Authentication-method or core-plugin adoption record (non-normative) | `models/NN-*.md` | 001– |
| `CCR-EA-NNN` | Change Control Record | Document Control headers, Change History cells | 001– |
| `EFAUTH-*` | Document ID | Document Control headers | — |

`REQ-EA-NNN` was originally reserved rather than assigned: the repository
was pre-implementation, and there was no `features/**/*.feature` suite (or
equivalent) for the identifier to tag yet. The Gherkin acceptance suite at
`features/features/*.feature` (see
[`spec/traceability.md` §6](../traceability.md#6-acceptance-scenarios-req-ea)
and [`features/README.md`](../../features/README.md)) now allocates them, one id
per scenario, assigned in one deterministic, idempotent pass by
[`features/scripts/allocate-req-ea.py`](../../features/scripts/allocate-req-ea.py)
so that new scenarios added later receive the next free number rather than
disturbing existing ones. An id is claimed by exactly one scenario: the
allocator refuses a duplicate, and `spec/scripts/verify-traceability.sh` fails
on a duplicate or on a manifest that no longer matches what the allocator would
generate (`allocate-req-ea.py --check`), which is what stops parallel branches
that each took "the next number" from merging into a collision. Hand-assigning a
number is the one way to break that, so do not. The suite runs
(`pnpm test:bdd`) for the feature files that are wired to step definitions; the
rest are tagged `@skip @unwired` (see `spec/traceability.md` §6), and the
[testing harness](../behaviors/25-testing-harness.md)
([BEH-EA-193 through BEH-EA-200](../behaviors/25-testing-harness.md)) is
implemented in `@awthaq/test`.

`MOD-EA-NNN` mirrors qadi's `MOD-QD-NNN`: it is the one series that asserts no
verified behavior. It records which authentication methods and flows, and which core plugins,
awthaq can express — and what an unadopted one would cost to add — so
that intent has somewhere to live that is not the behavior specification. A
method becomes normative by acquiring `BEH-EA`, `INV-EA`, and (once it exists)
`REQ-EA` identifiers in the ordinary way, never by being described in
`models/`.

## 3. Allocation Rules

- Identifiers are permanent. A requirement that is withdrawn keeps its
  number and is marked `Withdrawn` rather than deleted or reused —
  reuse would silently repoint every existing cross-reference and
  invalidate whatever traceability material exists at the time.
- Identifiers are allocated contiguously within their series. A gap is
  permitted only where a number has been withdrawn, and the withdrawal
  is recorded where the number was defined.
- `BEH-EA` identifiers are allocated in blocks of eight per behavior file, so
  that a later sub-requirement can be inserted into a file without
  renumbering any neighboring file. The current allocation is:

  | Range | File |
  |---|---|
  | 001–008 | 01 Plugin Contract |
  | 009–016 | 02 Plugin Composition and Validate\<P\> |
  | 017–024 | 03 Ports, Slots, Hook Points, and Registries |
  | 025–032 | 04 The Contract Stratum |
  | 033–040 | 05 The Persistence Stratum |
  | 041–048 | 06 Users and Accounts |
  | 049–056 | 07 Sessions |
  | 057–064 | 08 Verification Tokens |
  | 065–072 | 09 Authentication Middleware |
  | 073–080 | 10 CSRF Protection |
  | 081–088 | 11 HTTP Serving and Error Mapping |
  | 089–096 | 12 Hooks |
  | 097–104 | 13 Events |
  | 105–112 | 14 Rate Limiting |
  | 113–120 | 15 Password Authentication |
  | 121–128 | 16 OAuth and OIDC |
  | 129–136 | 17 Passkey and WebAuthn |
  | 137–144 | 18 Roles and the Subject Resolver |
  | 145–152 | 19 Qadi Bridge — Path A |
  | 153–160 | 20 Qadi Bridge — Path B |
  | 161–168 | 21 Qadi Resolvers and Obligations |
  | 169–176 | 22 The Effect Client |
  | 177–184 | 23 React Bindings |
  | 185–192 | 24 Next.js Server Rendering |
  | 193–200 | 25 Testing Harness |
  | 201–208 | 26 CLI |

  A file needing fewer than eight identifiers simply leaves the tail of its
  block unused — those numbers are reserved, not withdrawn, and remain
  available only to that file. A file needing more than eight is a signal
  that the file covers more than one behavior and should be split, not a
  license to spill into the next file's block.

## 4. Cross-Reference Syntax

Cross-references are relative markdown links whose text is the identifier
itself:

```markdown
[BEH-EA-009](../behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple)
```

The anchor fragment is the heading's GitHub-slugified full heading text. It is
**not independently verified by any tooling yet** — no `verify-traceability`
script exists for awthaq, unlike qadi's
`spec/scripts/verify-traceability.sh`. A traceability-verification gate is
itself a planned, not-yet-active gate of this specification; see
[`definitions-of-done.md`](./definitions-of-done.md). Until that gate exists,
an anchor naming a heading that does not exist will not be caught mechanically
— authors must get it right by inspection, and reviewers should treat a
broken anchor in a diff as a defect regardless of the absence of a checker.

## 5. Change Control Records

`CCR-EA-NNN` is a single, shared, sequential series across the whole spec
tree. It records every substantive edit to any spec document — a changed
requirement, a corrected cross-reference, a renamed infix — in that
document's own Change History cell, in its own Document Control header. There
is no separate changelog file: the record of what changed and why lives next
to what it changed, the same discipline qadi's `CCR-QD` series follows.

---

_Next: [Definitions of Done](./definitions-of-done.md)_
