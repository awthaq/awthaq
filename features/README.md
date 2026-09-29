# awthaq acceptance suite

This is the Gherkin/BDD acceptance suite for awthaq. It exists because `spec/process/requirement-id-scheme.md` reserved `REQ-EA-NNN` for exactly this ("a BDD-testable acceptance requirement"), `spec/traceability.md` §6 was written as a stub waiting for it, and `spec/scripts/verify-traceability.sh` already contains check logic that looks for `features/features/*.feature` — this fills that slot in.

## Running the suite

```sh
pnpm run test:bdd                      # the whole suite (== pnpm --filter @awthaq/features test)
pnpm --filter @awthaq/features exec vitest run features/03-http-layer   # one directory or file
```

The runner is [`@effect-cucumber/vitest`](https://www.npmjs.com/package/@effect-cucumber/vitest) on top of vitest. Each `.feature` file has a sibling `<feature>.steps.test.ts` that loads it (`loadFeature`), builds a fresh **World** layer per scenario (`describeFeature`) and registers the step definitions; the World and step modules live in [`step-definitions/`](step-definitions/) (`*World.ts` composes the real HTTP groups or services over memory ports, `*Steps.ts` holds the `Given`/`When`/`Then` definitions, [`shared/Harness.ts`](step-definitions/shared/Harness.ts) holds what every World reuses: the cheap KDF layers, the capturing mailer, cookie helpers and the named-actor registry). Scenarios drive the plugins through their real HTTP surface wherever the behavior is wire-level, and through the real services where it is not.

Packages are consumed through their built `lib/`, so run `pnpm run typecheck` (which builds every project) once after a fresh checkout or after changing a package's source.

## Wired versus unwired, and what `@skip` means

Every scenario is exactly one of:

| State | How it looks | What it means |
| ----- | ------------ | ------------- |
| **Wired** | no `@skip` | A step definition runs it against real code; it passes or fails CI. |
| **Pruned** | scenario-level `@skip`, with a `# @skip: <reason>` comment directly above | Wired in spirit but not observable *yet*. The reason is concrete: the unit test that covers it, or the issue that blocks it. A skipped scenario is a visible, non-blocking node in the report, never a silently absent one. |
| **Unwired** | Feature-level `@skip @unwired` **and** the pre-implementation banner | The behavior has no shipped implementation to run against (today only `28-device-authorization.feature`). Its `*.steps.test.ts` registers zero steps. |

`@unwired` is a grep-able marker separating "never wired" from an ordinary pruned scenario; the banner and the tag travel together, and `spec:verify` fails if one appears without the other. Wiring a Feature removes both. Each file's wiring status is tracked in [`spec/traceability.md`](../spec/traceability.md) §6, and the requirement id of every scenario in [`traceability.md`](traceability.md).

`REQ-EA-NNN` tags are **allocator-owned**: write new scenarios untagged, then run `python3 features/scripts/allocate-req-ea.py` (idempotent; existing ids are never renumbered; it also regenerates `traceability.md`). `pnpm run spec:verify:strict` fails if a tag is duplicated, missing from the manifest, or a manifest row has no tag.

## How this maps to `spec/behaviors/`

One `.feature` file per `spec/behaviors/NN-*.md` file (30 total), grouped into 12 directories under `features/features/` that mirror the same stratification `spec/README.md` uses (foundations → contract/persistence → domain → HTTP → cross-cutting → authentication methods → authorization bridge → client integration → tooling → admin/impersonation):

| Directory                            | Feature files                                                                              | `BEH-EA` range |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | -------------- |
| `00-foundations/`                    | plugin-contract, plugin-composition-validate, ports-slots-hooks-registries                 | 001–024        |
| `01-contract-and-persistence/`       | contract-stratum, persistence-stratum                                                      | 025–040        |
| `02-domain/`                         | users-accounts, sessions, verification-tokens                                              | 041–064        |
| `03-http-layer/`                     | authentication-middleware, csrf, http-error-mapping                                        | 065–088        |
| `04-cross-cutting/`                  | hooks, events, rate-limiting                                                               | 089–112        |
| `05-authentication-methods/`         | password, oauth, passkey                                                                   | 113–136        |
| `06-roles-and-authorization-bridge/` | roles-subject-resolver, qadi-bridge-path-a, qadi-bridge-path-b, qadi-resolvers-obligations | 137–168        |
| `07-client-integration/`             | client-effect, react, nextjs-ssr                                                           | 169–192        |
| `08-tooling/`                        | testing-harness, cli                                                                       | 193–208        |
| `09-admin-and-impersonation/`        | admin-impersonation                                                                        | 209–220        |

One exception: `05-authentication-methods/28-device-authorization.feature` (`@skip @unwired`, DAG-007) specifies a plugin that has no behavior file or `BEH-EA` range yet, so its `Rule:`s are tagged `@MOD-EA-013` and trace to [`spec/models/13-device-authorization.md`](../spec/models/13-device-authorization.md); it gets `BEH-EA` ids when a milestone schedules the plugin.

Inside each `.feature` file: one `Rule:` per `BEH-EA-NNN` (tagged `@BEH-EA-NNN`), one or more `Scenario:`/`Scenario Outline:` per rule covering its requirement clauses and the edge cases the source prose names. See [`STYLE.md`](STYLE.md) for the full authoring contract, and [`traceability.md`](traceability.md) for the complete `REQ-EA-NNN` → `BEH-EA-NNN` → scenario manifest.

## Authorization is out of scope here

awthaq ships no authorizer; authorization is delegated to the sibling library **qadi** (`ADR-EA-009`). Scenarios that touch an authorization decision treat qadi's evaluator as a black box and assert only on awthaq's own bridge responsibilities. See [`STYLE.md`](STYLE.md#the-qadi-boundary) for the exact rule, and qadi's own `features/features/*.feature` for the authorization-decision suite this one deliberately does not duplicate.

## Reading a scenario against the spec

Every `Rule:` carries a comment naming its source heading and any `ADR-EA`/`INV-EA` it cites, e.g.:

```gherkin
# BEH-EA-049 — spec/behaviors/07-sessions.md; see also ADR-EA-014
@BEH-EA-049
Rule: A session token is an opaque id.secret pair
```

To go from a scenario back to its normative requirement, open the named `spec/behaviors/NN-*.md` file at that heading. To go from a requirement forward to its scenarios, `grep -r '@BEH-EA-NNN' features/features/`.
