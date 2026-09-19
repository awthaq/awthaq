# awthaq acceptance suite

This is the Gherkin/BDD acceptance suite for awthaq. It exists because `spec/process/requirement-id-scheme.md` reserved `REQ-EA-NNN` for exactly this ("a BDD-testable acceptance requirement"), `spec/traceability.md` §6 was written as a stub waiting for it, and `spec/scripts/verify-traceability.sh` already contains check logic that looks for `features/features/*.feature` — this fills that slot in.

**This suite is pre-implementation, same as the rest of the repository.** There is no `package.json`, no Cucumber configuration, and no step-definition layer wiring these scenarios to real code — see `spec/behaviors/25-testing-harness.md` (`BEH-EA-193`–`200`) for the planned testing harness that will eventually execute them. Until then, every `.feature` file here is a specification artifact: it makes `spec/behaviors/`'s prose requirements Gherkin-shaped so a future BDD suite has scenarios to run, not a suite that currently passes or fails.

## How this maps to `spec/behaviors/`

One `.feature` file per `spec/behaviors/NN-*.md` file (27 total), grouped into 10 directories under `features/features/` that mirror the same stratification `spec/README.md` uses (foundations → contract/persistence → domain → HTTP → cross-cutting → authentication methods → authorization bridge → client integration → tooling → admin/impersonation):

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
