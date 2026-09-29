# Gherkin authoring style — awthaq

This is the contract every `.feature` file in `features/features/` follows. It exists so that the ~700 scenarios written by different authors (human or agent) read as one suite, not thirty. Read this in full before writing or editing any `.feature` file.

## Where this suite comes from

Every scenario here is a Gherkin restatement of a requirement already specified in `spec/behaviors/NN-*.md`. This suite does not invent requirements — it makes the existing `BEH-EA-NNN` catalog executable-shaped. If a scenario needs a fact the source `.md` doesn't state, that's a signal to re-read the source (and its cross-referenced `ADR-EA`/`INV-EA`/`MOD-EA` entries), not to invent one.

The suite is executable. A Feature whose behavior is implemented is wired to real step definitions (see [`README.md`](README.md)); only a Feature with no shipped implementation yet is `@unwired`, and only that Feature carries the pre-implementation banner (see "Banner" below).

## File structure

One `.feature` file per source `spec/behaviors/NN-*.md` file. Inside:

```
Feature: <exact title of the source .md file>

  Rule: <BEH-EA heading text, with the id stripped>       # one per BEH-EA-NNN in the file, in order
    Scenario: <happy path>
    Scenario: <edge case 1>
    Scenario: <edge case 2>
    ...
```

- **`Feature:`** — one line, the source file's `# <Title>` heading verbatim.
- **`Rule:`** — one per `BEH-EA-NNN`, in the same order as the source file, carrying the `@BEH-EA-NNN` tag. The rule text is the `## BEH-EA-NNN: <text>` heading with the `BEH-EA-NNN:` prefix removed.
- **`Scenario:` / `Scenario Outline:`** — see "How many scenarios" below.

Do not merge two `BEH-EA` ids into one `Rule`, and do not split one `BEH-EA` id across two `Rule`s. The 1:1 mapping between `Rule` and `BEH-EA-NNN` is what keeps traceability mechanical.

## Tagging

- `Feature:` gets 1–2 free-text domain tags (`@sessions`, `@oauth`, `@authorization-bridge`, ...) — pick words that would help someone run `cucumber --tags` for a subsystem later. Not load-bearing; use your judgment.
- `Rule:` gets exactly one tag: `@BEH-EA-NNN`, matching the source heading. This is load-bearing — it is how `spec/traceability.md` and `verify-traceability.sh` will trace back to the specification.
- **`Scenario:` gets no `@REQ-EA` tag from you, but it does get one.** `REQ-EA-NNN` tags are mandatory and _allocator-owned_: `python3 features/scripts/allocate-req-ea.py` assigns them in one deterministic, idempotent pass (existing ids are permanent), so parallel authors never collide on a number. Add scenarios untagged, run the allocator, commit the regenerated [`traceability.md`](traceability.md). Never hand-tag; `pnpm run spec:verify:strict` fails on a duplicate, an unmanifested tag or an orphan manifest row.
- **`@skip`, `@only`, `@unwired`.** `@skip` on a `Scenario:` marks a _pruned_ scenario, and a comment directly above it must state the concrete reason — `# @skip: <why it is not observable>; covered by <test file/name>` or `# @skip: blocked by <issue id>`. Never a bare `@skip`, never a pointer to a ticket that is not in the repository. `@skip @unwired` on the `Feature:` marks a Feature with no implementation to run against; it is removed the moment the Feature is wired. `@only` is for local debugging and must not be committed.
- A `Rule` whose source heading cites an `ADR-EA` or `INV-EA` gets a one-line comment directly above it: `# BEH-EA-NNN — spec/behaviors/NN-*.md; see also ADR-EA-xxx, INV-EA-xxx`. Copy the citations straight from the source heading's `> **See:**` / `> **Invariant:**` line — don't re-derive them.

## Banner (top of an `@unwired` `.feature` file only)

A Feature that is `@unwired` opens with this banner; **wiring the Feature removes it** (`27-admin-impersonation.feature` is the model of a wired file — it has no banner). The banner may appear only on an `@unwired` Feature (`spec/scripts/verify-traceability.sh` fails otherwise); an `@unwired` Feature may instead open with a more specific note saying what blocks it, as `28-device-authorization.feature` does.

```gherkin
# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.
```

## How many scenarios, and where edge cases come from

Do not write one scenario per `Rule` and call it done. For each `BEH-EA-NNN`:

1. Read its `REQUIREMENT: ... MUST ...` block. Every `MUST` gets a positive scenario (the thing happens correctly); every `MUST NOT` gets a negative scenario (the forbidden thing is confirmed not to happen). A requirement combining several `MUST`/`MUST NOT` clauses gets one scenario per clause, not one scenario that asserts everything at once.
2. Read the prose paragraph(s) below the requirement block. This spec's authors consistently spell out the edge case a requirement exists to rule out — a throttle, a race, a boundary, a replay, a leak, a downgrade. Each one named there is its own scenario. Do not fold an explicitly-named edge case into the happy-path scenario's `And` clauses — give it its own `Scenario:` so it can fail independently and read as a title in a test report.
3. Where a requirement is parametrized by a boundary value (a duration, a count, a size), use `Scenario Outline:` with an `Examples:` table rather than N near-identical scenarios.

Expect roughly 2–5 scenarios per `BEH-EA-NNN` in most files; a handful of purely structural behaviors may need only 1–2, and a few security-critical ones (sessions, verification tokens, CSRF, OAuth, the qadi bridge) will want more. If you find yourself writing zero edge-case scenarios for a `Rule` whose source prose clearly names one ("this is a deliberate, bounded window", "throttled to at most once per...", "never... because a 403 confirms the ID exists"), go back — that named case is missing a scenario.

## Compile-time / type-level behaviors

Roughly `BEH-EA-001`–`024` (the plugin contract, `Auth.make`/`Validate<P>` composition, and ports/slots/hooks/registries), plus anything citing `INV-EA-001` through `INV-EA-006`, describe properties the **TypeScript compiler** enforces — there is no runtime step to execute. Write these `Rule`s and `Scenario`s exactly like any other, in ordinary `Given/When/Then`, describing the developer-observable outcome ("the tuple fails to compose, naming the missing dependency and the plugin that requires it"). Add one line directly under the `Rule:` (not per-scenario) noting that real verification is a future type-level test tool, not this Cucumber step:

```gherkin
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-009 @compile-time
  Rule: Auth.make computes three outputs from one plugin tuple
```

Never write a scenario that pretends to observe a compiler error via an HTTP response or a thrown runtime exception — say "composition is rejected" / "fails to compile", not "returns a 500".

## The qadi boundary (all of `06-roles-and-authorization-bridge/`, and anywhere else a scenario touches authorization)

awthaq ships no authorizer. qadi decides; awthaq only bridges a resolved identity into qadi's evaluation context and reacts to the decision qadi hands back. Every scenario that involves an authorization decision must:

- Treat qadi's evaluation as a **black box `Given`**: `Given qadi's evaluator would return an Allow decision for this policy` / `Given qadi's AttributeResolver fails while evaluating a policy`. Never write a `Given` that constructs roles, permissions, or a policy tree and expects a specific combinator result — that is qadi's own specification's job (see `../qadi/spec/behaviors/`, and its own `features/features/*.feature`), not awthaq's.
- Assert only on what awthaq's bridge itself owns: middleware ordering (`Authentication` before `AuthorizedSubject`), `CurrentPrincipal` → `CurrentSubject` derivation happening at all (not what it derives to, beyond the documented claim-mapping), `AccessDenied` → 404 mapping for tenant-scoped-by-id reads, a resolver failure surfacing as a 5xx defect and never as a denial, witness (`guard`) usage, and Path B's unannotated-endpoint-is-refused default.
- Never assert that a specific role grants or withholds a specific permission, that a policy combinator (`allOf`/`anyOf`/`not`/...) evaluates a certain way, or that role inheritance flattens correctly — those are qadi's invariants, already covered by qadi's own suite, and restating them here would duplicate (and risk drifting from) qadi's specification rather than awthaq's.

## Vocabulary consistency

Reuse the same phrasing for the same concept across every file, so `grep` across the suite finds every occurrence of a concept:

- A signed-in identity: `Given a signed-in user "alice"` (not "a logged in user", "an authenticated account", etc.)
- A session: refer to it by an explicit id in quotes (`session "s1"`) once more than one is in play.
- Time: state literal durations from the spec (`"touchEvery" is configured to 1 hour`), not vague relative time.
- Decisions from qadi: always "qadi's evaluator would return an Allow/Deny decision", never "the system allows/denies" (that would blur who decided).
- HTTP outcomes: cite the literal status line ("404 Not Found", "5xx server error"), matching `spec/behaviors/11-http-error-mapping.md`.

## Three fully worked examples

### 1. An ordinary runtime behavior (Sessions)

```gherkin
@domain @sessions
Feature: Sessions

  # BEH-EA-049 — spec/behaviors/07-sessions.md; see also ADR-EA-014
  @BEH-EA-049
  Rule: A session token is an opaque id.secret pair

    Scenario: Issuing a session returns a token composed of a public id and a secret
      Given a signed-in user "alice"
      When a session is issued for "alice"
      Then the returned token has the shape "<id>.<secret>"
      And the secret component is redacted in any log or span

  # BEH-EA-052 — spec/behaviors/07-sessions.md
  @BEH-EA-052
  Rule: Idle-window refresh is throttled to at most one write per touchEvery

    Scenario: A single request within touchEvery does not trigger a refresh write
      Given a session last touched 10 minutes ago
      And "touchEvery" is configured to 1 hour
      When a request is served using that session
      Then no idle-refresh write occurs

    Scenario: Repeated requests within touchEvery collapse to at most one refresh write
      Given a session last touched 10 minutes ago
      And "touchEvery" is configured to 1 hour
      When 50 requests are served using that session within the next 5 minutes
      Then at most one idle-refresh write occurs

  # BEH-EA-054 — spec/behaviors/07-sessions.md
  @BEH-EA-054
  Rule: Sessions expose a device list, per-device revocation, and revoke-others

    Scenario: A user lists their own live sessions
      Given "alice" has 3 active sessions
      When "alice" requests her session list
      Then she sees 3 sessions, each with its own userAgent and a "current" flag on the session serving the request

    Scenario: Revoking one session by id ends that session only
      Given "alice" has sessions "s1" and "s2"
      When "alice" revokes session "s1"
      Then session "s1" is no longer valid
      And session "s2" remains valid

    Scenario: Revoke-others ends every session except the caller's current one
      Given "alice" has sessions "s1" (current), "s2", and "s3"
      When "alice" revokes all other sessions
      Then "s2" and "s3" are no longer valid
      And "s1" remains valid

    Scenario: A request already validated before a concurrent revoke is allowed to complete
      Given "alice"'s session "s1" is validated by the authentication middleware for an in-flight request
      When session "s1" is revoked by a concurrent request before "s1"'s handler completes
      Then the in-flight request completes normally on the principal it already resolved
      And the next request presenting session "s1" is rejected
```

### 2. A compile-time / type-level behavior (Plugin composition)

```gherkin
@foundations @plugin-composition
Feature: Plugin Composition and Validate<P>

  # BEH-EA-009 — spec/behaviors/02-plugin-composition-validate.md; see also
  # ADR-EA-002, INV-EA-001.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-009 @compile-time
  Rule: Auth.make computes three outputs from one plugin tuple

    Scenario: A self-sufficient plugin tuple composes successfully
      Given a plugin tuple containing "Password" and its declared dependency "Core"
      When "Auth.make" composes the tuple
      Then composition succeeds and produces "api", "layer", "migrations", and "manifest"

    Scenario: A missing plugin dependency fails composition, naming the missing plugin
      Given a plugin tuple containing "TwoFactor" without its declared dependency "Password"
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names "Password" as the missing dependency of "TwoFactor"

    Scenario: Two plugins declaring the same id fail composition, naming both
      Given a plugin tuple containing two plugins both declaring id "invite"
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names "invite" as a duplicate plugin id

    Scenario: Two plugins overriding the same exclusive slot fail composition, naming both and the slot
      Given a plugin tuple containing "Roles" and "Organization", both overriding the "SubjectResolver" slot
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names "Roles", "Organization", and "SubjectResolver"
```

### 3. A qadi-boundary behavior (Qadi Bridge — Path A)

```gherkin
@authorization-bridge @qadi-bridge-path-a
Feature: Qadi Bridge — Path A (Decide in Handler)

  # BEH-EA-147 — spec/behaviors/19-qadi-bridge-path-a.md. qadi's own policy
  # evaluation is a black box throughout: "qadi's evaluator would return an
  # Allow/Deny decision" is a Given, never something derived from role or
  # permission logic here — that logic is qadi's own specification's job.
  @BEH-EA-147
  Rule: Cross-tenant denial becomes 404, not 403

    Scenario: A request for another tenant's resource by valid id is reported as not found
      Given a resource "project-42" that exists in a tenant the caller cannot access
      And qadi's evaluator would return a Deny decision for the caller against "project-42"
      When the caller requests "project-42" by id
      Then the response is "404 Not Found"
      And the response does not distinguish "denied" from "does not exist"

  # BEH-EA-148 — spec/behaviors/19-qadi-bridge-path-a.md
  @BEH-EA-148
  Rule: Resolver outages stay 5xx

    Scenario: An attribute-resolver outage surfaces as a defect, not a denial
      Given qadi's AttributeResolver fails while evaluating a policy for the caller
      When the caller requests a resource gated by that policy
      Then the response is a 5xx server error
      And the response is never mapped to "403 Forbidden" or "404 Not Found"

    Scenario: A resolver outage and a policy denial are never collapsed into the same handler branch
      Given a handler that separately catches "AccessDenied" into 404 and resolver-outage errors into a defect
      When a resolver-outage error occurs
      Then it is not caught by the "AccessDenied" branch
      And it propagates as a defect
```

## What not to do

- Don't invent a requirement the source `.md` doesn't state, even a plausible one — file it as a gap in your final summary instead, don't quietly add it as a scenario.
- Don't hand-tag scenarios with `@REQ-EA-*` — the allocator does (see "Tagging").
- Don't leave a bare `@skip`: every scenario-level `@skip` carries its rationale comment.
- Don't write a step that claims something it does not check (a `Then` that is an empty effect, a `Given` that performs the `When`'s request).
- Don't touch any file outside your assigned `.feature` file(s).
- Don't collapse a named edge case into the happy path's `And` clauses.
- Don't write a scenario that asserts qadi's own policy-evaluation result.
- Don't use `\`\`\`typescript`/`\`\`\`tsx`-style compiled-language framing in a `.feature` file — scenarios describe developer- and user-observable behavior in Gherkin, not code.
