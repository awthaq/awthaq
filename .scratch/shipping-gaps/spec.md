# Shipping-gap closure — upstream comparison follow-through

**Status:** ready-for-agent

## Problem Statement

A 50-agent head-to-head comparison against `EduSantosBrito/effect-auth`
v0.5.0 (an unrelated library, not a fork or predecessor of this one)
surfaced real production-readiness gaps in this repo, even though the
report itself turned out to be measurably stale by the time it was acted
on — four of the eight packages it called "empty stubs" (`Organization`,
`Admin`, `Passkey`, `Jwt`) were fully implemented in the days after the
report's snapshot, and CI already runs the full test suite despite the
report claiming otherwise.

Re-grounded against current `main`, the real gaps are: no HTTP endpoint
consumes the already-real email-verification token flow, and no
capability exists at all for an authenticated user to change their own
password; a fully-built `RateLimitsRegistry` sits unconsumed by every
plugin, leaving sign-in, reset, and OAuth-callback surfaces unthrottled;
there is no persistent SQL backend behind `packages/sql`'s repository
layer and no executed migration runner, so nothing here can actually be
deployed against a real database yet; OAuth provider tokens and PKCE
state are persisted in plaintext, with `Model.Sensitive` only hiding them
from logs, not encrypting them at rest; 601 of the 602 authored Gherkin
behavior scenarios never execute, so the spec corpus provides no real
regression coverage; and the project has no LICENSE, CHANGELOG,
CONTRIBUTING, or SECURITY.md, and its README still claims "no line of
source exists yet" against 12,000+ lines of real, tested implementation.

Collectively, these gaps mean a prospective adopter or contributor
evaluating this repo today — by reading the README, by trying to deploy
it, or by trying to trust its test suite — would reasonably conclude the
project is far less real and far less safe to use than it actually is,
and an operator who did deploy it today would be running unthrottled,
unencrypted, SQLite-only, unlicensed software.

## Solution

Six independent workstreams close these gaps, each scoped to **this
repository's own code only** — every report recommendation about
upstream's own repository (its weak `scrypt` parameters, its ~2,050-LOC
god-files, its `oauth`↔`storage` import cycle, its missing CSRF/RBAC) is
out of scope, since `EduSantosBrito/effect-auth` is a different,
unrelated library this repo has no relationship to and no way to act on:

1. **Account-lifecycle HTTP wiring** — a new core-owned `Account` HTTP
   group closes the verify-email/update-profile/delete-user wiring gap,
   and a new `Password`-plugin capability closes the change-password gap
   entirely (no core capability for it exists today).
2. **RateLimits consumption** — the existing `RateLimitsRegistry` gets
   real consumers across every mutating endpoint, dual-keyed by identity
   and/or IP per rule.
3. **Persistent SQL backend & migrations** — a real Postgres backend
   ships via Effect's own `@effect/sql-pg` and `Migrator` primitives
   (both already exist in the framework, confirmed by direct survey —
   this is a wiring effort, not new infrastructure), plus a new
   transactional port, without regressing the existing SQLite path.
4. **OAuth token encryption at rest** — an AES-256-GCM envelope, behind a
   swappable key-provider seam, covers both persisted provider tokens and
   PKCE verifier/nonce state.
5. **BDD execution** — step-definitions for every currently-implemented
   plugin turn the spec corpus into real, CI-executed regression
   coverage.
6. **Release & governance readiness** — LICENSE, CHANGELOG, CONTRIBUTING,
   SECURITY.md, a working changeset, knip, dependabot, a provenance-publish
   workflow, and a rewritten, accurate README with a real quickstart —
   landing the scaffolding for a first real release without actually
   cutting one yet.

Each workstream is expressed through this codebase's own established
conventions (ports, plugins, `HookPoint`, `AuthEvents`, the dual-backend
contract-test kit) rather than by porting anything from upstream's
implementation — upstream's ADR 0006 (its own token-encryption approach)
is cited only as prior art for the *technique*, never as code to reuse.

## User Stories

1. As an application developer integrating effect-auth, I want a wire-level endpoint that consumes email-verification tokens, so that users who signed up with email+password can complete verification without me hand-rolling the HTTP layer myself.
2. As an authenticated user, I want to update my profile (name) via HTTP, so that I don't need direct database access to change basic account details.
3. As an authenticated user, I want to delete my own account via HTTP, so that I can exercise a right-to-be-forgotten request without contacting support.
4. As an authenticated user, I want to change my password while already logged in, given my current password, so that I can rotate credentials without going through the unauthenticated forgot-password email flow.
5. As an application developer, I want account-lifecycle endpoints at a consistent top-level route convention, so that they're discoverable independent of which auth method a given user originally signed up with.
6. As an application developer, I want update-profile and delete-user to reuse the exact core capabilities that already exist, so that this effort doesn't duplicate logic that's already correct and tested.
7. As an operator running effect-auth in production, I want sign-in attempts rate-limited, so that credential-stuffing attacks are throttled automatically rather than relying on the application to build this itself.
8. As an operator, I want password-reset-request and change-password endpoints rate-limited, so that email-enumeration and reset-spam are bounded.
9. As an operator, I want sign-up rate-limited, so that registration spam is bounded from day one, not added later as an afterthought.
10. As an operator, I want OAuth callback endpoints rate-limited by IP, so that callback abuse is bounded even before any user identity is known.
11. As an operator, I want a sign-in rate-limit rule keyed on both attempted identity and source IP, so that distributed attacks against one account and single-IP sprays across many accounts are both caught.
12. As a test author working on this codebase, I want `TestAuth`'s default layer to provide a working `RateLimits` configuration, so that existing dual-backend contract tests don't start failing the moment real consumers exist.
13. As an application developer, I want to run effect-auth against a real Postgres database, so that I can deploy it in production rather than only in tests or an in-memory demo.
14. As an application developer, I want SQLite to keep working exactly as it does today, so that adding Postgres support doesn't regress my existing test or dev setup.
15. As a maintainer, I want a migration runner that tracks which migrations have already applied, so that schema changes deploy safely and idempotently across every environment.
16. As a maintainer, I want the migration file convention to match Effect's own primitives, so that this repo isn't maintaining a bespoke migration runner alongside a real one that already exists.
17. As a plugin author (e.g. `Organization`, future plugins), I want a transactional port available through the existing ports convention, so that multi-step operations commit atomically instead of leaving partial state on failure.
18. As a maintainer, I want OAuth account-linking completion to be the first real consumer of the new transactional port, so that the riskiest existing multi-step flow in this codebase gets atomicity first.
19. As a security-conscious operator, I want OAuth provider access/refresh tokens encrypted at rest, so that a database compromise doesn't directly hand an attacker live third-party credentials.
20. As a security-conscious operator, I want PKCE verifier/nonce state encrypted wherever it's persisted, so that the OAuth flow's own short-lived secrets aren't stored in plaintext either.
21. As an application developer, I want a swappable key-provider seam rather than a hardcoded key, so that I can plug in a real KMS in production while using a simple env-key layer in dev and test.
22. As an operator, I want encrypted tokens keyed by a rotatable key id, so that rotating the encryption key doesn't require synchronously re-encrypting every existing row.
23. As a security reviewer, I want the encryption envelope's authenticated data bound to the specific provider-and-user row it belongs to, so that ciphertext can't be silently swapped between rows.
24. As a maintainer, I want the 602 authored Gherkin scenarios to actually execute for every currently-implemented plugin, so that the spec corpus functions as real regression coverage, not just documentation nobody runs.
25. As a maintainer, I want scenarios describing behavior that doesn't exist yet to be explicitly pruned and tracked rather than left to fail silently, so that a green CI run means what it says.
26. As a new contributor reading a `.feature` file, I want to trust that it's actually exercised in CI, so that the spec corpus is a reliable source of truth about what this library does.
27. As a prospective adopter, I want a LICENSE file, so that I can legally use this library at all.
28. As a prospective contributor, I want a CONTRIBUTING.md, so that I know how to propose a change without guessing at process.
29. As a security researcher, I want a SECURITY.md, so that I know how to responsibly disclose a vulnerability instead of filing a public issue.
30. As a maintainer, I want a changeset-driven CHANGELOG, so that version history is generated from real changes instead of hand-maintained and inevitably stale.
31. As a maintainer, I want a provenance-publish workflow wired but not yet triggered, so that actually publishing is a configuration step away, not a from-scratch build, once npm/GitHub OIDC trusted publishing is set up.
32. As a maintainer, I want knip and dependabot configured, so that dead exports and dependency drift are caught automatically instead of discovered by hand.
33. As a prospective adopter evaluating this library, I want an accurate README that doesn't claim "no source exists," so that I don't dismiss a real, working, tested library based on stale documentation.
34. As a prospective adopter, I want a runnable quickstart showing a real Postgres-backed composition, so that I can see the actual production path, not just a toy in-memory example that doesn't reflect how I'd deploy it.
35. As a prospective adopter, I want the README to cover account-lifecycle, OAuth, and RBAC in one document, so that I don't have to piece capability together from scattered spec files just to decide whether to adopt this library.

## Implementation Decisions

**Account-lifecycle HTTP wiring (workstream 1).** A new core-owned
`Account` HTTP group (mirroring `Session`/`Subject`'s own root-level,
core-owned placement, not nested under any plugin) exposes verify-email,
update-profile, and delete-user — all pure wiring onto capabilities that
already exist (`Users.verifyEmail`/`Verification.consume`,
`Users.updateProfile`, `Users.delete`). Delete-user's existing
cascade-to-caller behavior is invoked explicitly by the new handler, not
redesigned. Change-password is new: a `Password`-plugin capability
(alongside the existing `signUp`/`signIn`/`requestReset`/`confirmReset`)
that verifies the caller's current password via the existing
`PasswordHasher` port before rotating the stored hash — distinct from
the unauthenticated forgot-password pair, and living in `Password`
rather than the new `Account` group because it needs plugin-owned
password-hashing state the core group doesn't have. Route convention is
top-level for every endpoint in this workstream (e.g. `/verify-email`,
`/user`, `/change-password`), independent of which plugin owns the
handler — account-lifecycle actions apply regardless of which auth
method a given user originally signed up with. Each new endpoint's
errors map onto this codebase's existing per-service `Data.TaggedError`
→ `Schema.TaggedError` convention, not upstream's single flat error
taxonomy.

**RateLimits consumption (workstream 2).** The existing
`RateLimitsRegistry` gains real consumers on every mutating endpoint from
day one: sign-in, sign-up, reset-request, reset-confirm, change-password,
and OAuth callback. Keying is dual per rule rather than one global
strategy — sign-in keys on both attempted-identity and source IP; reset-
request and change-password key on identity/email; sign-up and OAuth
callback key on IP alone, since no identity exists yet at that point in
the flow. Because this is an embedded library rather than a standalone
server, IP extraction is caller-suppliable rather than assumed from a raw
socket. `TestAuth`'s default layer now provides a real `RateLimits.layer`
(superseding its current "no plugin calls `RateLimits.rule`" state);
tests that specifically want to exercise limiting take a tightened-window
test layer instead of the default's permissive one.

**Persistent SQL backend & migrations (workstream 3).** Postgres ships
now via the framework's own real driver and migrator, which a direct
survey of the Effect source confirmed already exist and need no new
framework-level work — only wiring. This deliberately supersedes an
earlier, narrower decision in this repo (`ADR-EA-016`) that had rejected
designing Postgres support as "speculative"; that decision was scoped to
one specific primitive at one moment in the codebase's history, not a
blanket freeze, and this workstream's whole purpose — the production
backend gap the project's own database-neutrality ADR (`ADR-EA-004`)
already committed to generally — makes that supersession appropriate
here. SQLite stays exactly as it is today; nothing about the existing
tested path regresses. The existing migration scaffold gets wired onto
the framework's own real migrator rather than a third-party tool: file-
based, forward-only migrations tracked in a dedicated migrations table,
with the whole pending batch applied inside one transaction. A new
transactional port joins the existing ports package (alongside password-
hashing, mail, and rate-limiting), wrapping the framework's own
first-class transaction primitive — its first real consumer is OAuth
account-linking completion, the clearest multi-step atomicity need in
this codebase today. OAuth's own persistence design (as opposed to the
transactional mechanism) is workstream 4's scope, not this one's.

**OAuth token encryption at rest (workstream 4).** An AES-256-GCM
envelope, with its authenticated associated data bound to both the
provider id and the user id a given ciphertext belongs to (so ciphertext
can't be swapped between rows undetected), covers OAuth provider access
and refresh tokens. Key retrieval sits behind a new, swappable key-
provider seam — a provider-agnostic interface with a concrete env-key-
backed implementation satisfying it for dev/test, so nothing here is
blocked on an actual cloud KMS account existing, while the seam itself is
real and KMS-shaped from the start. Encrypted values carry a key id so a
future key rotation doesn't require synchronously re-encrypting every
existing row. Encrypt/decrypt live behind a single dedicated service —
not a bare model-field transform — because PKCE verifier/nonce state is
in scope for the same treatment, and PKCE state doesn't live in the SQL
persistence layer at all; it's carried in a signed cookie and in the
existing verification-flow payload mechanism. The encryption service is
therefore callable from both the SQL persistence path and the cookie/
flow-payload path, not just one.

**BDD execution (workstream 5).** Step-definitions get written for every
currently-implemented plugin — password, session, OAuth, organization,
admin, passkey, and JWT — not a single representative slice, using the
already-real Gherkin test-runner integration this codebase has (no
tooling gap exists; only the step-definitions themselves are missing).
Given the scale, this is explicitly the single largest workstream here
and is expected to be split into one implementation-ticket set per plugin
rather than one flat range. Scenarios describing behavior gated on this
same spec's still-in-flight pieces, or on packages this spec explicitly
excludes, are pruned from the executed set and tracked rather than
force-implemented or silently left failing.

**Release & governance readiness (workstream 6).** MIT license.
CONTRIBUTING.md and SECURITY.md are structurally templated from
upstream's own five governance files — reusing document *structure* only,
never upstream's actual prose or specifics, and not in conflict with
keeping this effort local-only, since nothing here edits upstream's own
repository. The existing changeset tooling gains real changeset entries
and a provenance-publish workflow that's fully wired but deliberately
never triggered in this effort — actually cutting and publishing a first
version needs one-time, human-only npm/GitHub OIDC trusted-publishing
setup that no agent can perform, so that step is explicitly out of this
spec's own scope (see Further Notes). knip (a dead-export gate) and a
dependabot configuration land as a minor addition to CI alongside this
workstream, rather than as their own separate effort. The README's stale
"pre-implementation, no source exists" banner is replaced with an
accurate status line linking to real progress tracking, and gains a
single flat quickstart (mirroring upstream's own document shape, not
split across links to `spec/`) demonstrating a real Postgres-backed
composition — sequenced after workstreams 1 and 3 land, since the
quickstart needs to demonstrate real, current capability rather than
describe work still in flight. No separate runnable `examples/` app is
built; the quickstart lives entirely in the README itself.

## Testing Decisions

Every new test in this effort asserts on external, wire-observable
behavior — status codes, response shapes, persisted-vs-plaintext
comparisons, whether a request is throttled — never on internal
repository or service implementation shape, matching every existing
plugin's own testing convention in this codebase.

- **Account-lifecycle (workstream 1).** Primary seam: a wire-level
  contract test over a real HTTP router boot, extending the existing
  root-level `Session`/`Subject` wire-test file for the new `Account`
  group's endpoints, and extending the existing `Password`-plugin
  wire-test file for change-password — both mirroring the exact
  real-router-boot pattern this codebase's `Password`, `Admin`, and
  `Passkey` plugins already use for their own wire tests. Supporting
  seam: domain-level tests against the underlying `Users`/`Verification`/
  `Password` service shapes directly (in-memory layers), the same shape
  every other plugin's own domain-level test suite already takes.
- **RateLimits (workstream 2).** Extends each affected plugin's existing
  wire-level test file with an assertion that exceeding a rule's
  threshold yields a throttled response, plus a dedicated contract suite
  for the `RateLimitsRegistry` itself (rule registration, scope
  violations, freeze behavior) mirroring this codebase's existing
  service-level contract-test shape.
- **Persistent SQL & migrations (workstream 3).** The existing
  dual-backend repository contract-test kit runs a third time against a
  real Postgres layer in CI, alongside the existing memory and SQLite
  runs — same test bodies, one more backend layer, proving the
  dialect-agnostic design actually holds. A dedicated migrator test
  asserts a freshly-migrated database ends up schema-equal to what the
  models declare. The new transactional port gets a contract test
  proving a failure partway through a multi-step operation leaves no
  partial state, exercised against the real transactional consumer (OAuth
  account-linking completion).
- **OAuth encryption (workstream 4).** Extends the existing OAuth and SQL
  test suites with round-trip assertions at the new encryption service's
  boundary — a token or PKCE value encrypted and then decrypted equals
  the original, and the raw bytes actually persisted are demonstrably not
  the plaintext. No test asserts on ciphertext internals or the specific
  encryption scheme's implementation details.
- **BDD (workstream 5).** No new test *infrastructure* — the seam is
  already the existing `@effect-cucumber/vitest` integration running
  `features/**/*.steps.test.ts` via the existing `test:bdd` script. This
  workstream's own testing decision is that each new step-definition
  calls into the same wire-level or domain-level seam its own plugin's
  existing tests already use, rather than inventing a parallel
  BDD-specific testing path.
- **Release/governance/README (workstream 6).** No test seam — these are
  non-code artifacts (license text, workflow YAML, documentation). CI
  configuration changes (knip, dependabot) are verified by the CI run
  itself succeeding, not by a dedicated test.

## Out of Scope

- Every report recommendation about `EduSantosBrito/effect-auth`'s own
  repository (its `scrypt` parameters, its god-files, its `oauth`↔
  `storage` cycle, its missing CSRF/RBAC) — that project is unrelated to
  this one and this spec has no way to act on someone else's repository.
- The 8-stub-package cleanup (`two-factor`, `passkey`, `magic-link`,
  `admin`, `organization`, `api-key`, `next`, `cli`) — ruled out as
  future work independent of this spec's destination; four of the eight
  are no longer stubs as of this effort's own charting round regardless.
- Actually publishing a `0.1.0` release to npm — workstream 6 lands the
  scaffolding only; publishing needs one-time, human-only npm/GitHub OIDC
  trusted-publishing setup outside any agent's reach, and becomes its own
  future ticket once a human completes that setup.
- A runnable `examples/` app — the quickstart lives in the README's own
  code blocks; a separate example application is a possible future
  effort, not part of this one.
- Writing the actual 602 Gherkin step-definitions themselves — this spec
  fixes the *target* (every currently-implemented plugin) and the seam
  they call into; the step-definitions are implementation-ticket work,
  likely split one ticket-set per plugin.
- Recording workstream 3's supersession of `ADR-EA-016`'s prior
  "speculative Postgres" rejection as its own follow-up documentation
  note against `ADR-EA-004`/`ADR-EA-016` — a documentation task alongside
  implementation, not a design decision this spec needs to resolve
  further.
- Any change to MySQL support timing — `ADR-EA-004`/`research/10` already
  plan MySQL for a later `v1.x`; this spec does not pull that forward.

## Further Notes

This spec resolves the `Shipping-gap closure` wayfinder map's
(`.scratch/shipping-gaps/map.md`) full frontier — all seven grilling
tickets (01 through 07) plus the one research ticket (00) — synthesized
directly per `/to-spec`'s own "do not interview, just synthesize"
instruction, following a compressed quick-fire grilling round the user
explicitly asked for instead of resolving each ticket in its own separate
session. The map's own "Decisions so far" section carries the full
per-ticket detail this spec draws from; that map's frontier is now empty
and its destination reached.

Every genuine design fork in this spec defaults to the richer,
more-complete option, consistent with the standing preference recorded
repeatedly across this repo's prior maps and reconfirmed through this
effort's own quick-fire answers (Postgres now rather than deferred, a
KMS-shaped key-provider seam rather than a flat env key, PKCE included in
the encryption scope rather than left out, every implemented plugin in
the BDD scope rather than one representative slice, every mutating
endpoint rate-limited rather than a phased rollout). The two narrower
calls in this spec — SQLite left exactly as-is rather than removed or
demoted, and publishing deliberately deferred out of this effort — are
both explicit scope boundaries tied to a real external constraint (an
existing tested path not being regressed; a human-only manual setup step
this agent cannot perform), not scope reductions made for their own sake.

The origin comparison report this spec traces back to
(`/tmp/effect-auth-compare/full-report.md`) was already measurably stale
by the time this spec was written — a live fact worth carrying forward
for whoever picks up implementation: re-verify any remaining claim in
that report against current `main` before trusting it, the same way this
spec's own charting round had to.
