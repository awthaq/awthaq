# ADR-EA-054: A Port's Interface Carries Only What a Production Adapter Implements; Test Observation Lives in `@awthaq/test`

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-054 |
> | Revision | 1.0 |
> | Effective Date | 2026-11-10 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-11-10): Initial release (architecture plan 35) |

---

## Context

`MailerShape` and `SmsSenderShape` carried `sent`, a read of recorded messages, so a test could assert against whichever adapter it had. Every adapter paid for it: `layerNoop` stubbed it, the README told adopters to implement it for a real provider, and 26 test doubles implemented it only to type-check. What tests needed instead, waiting for mail a detached fiber sends (BEH-EA-064, BEH-EA-113), was copied per suite as fixed scheduler turns or bounded polls.

## Decision

1. A port's interface holds only what a production adapter implements and production code calls. `MailerShape` and `SmsSenderShape` are `send` plus the optional `development` flag that `awthaq doctor --build` reads (BEH-EA-201).
2. Observing what was sent is test tooling. It lives in `@awthaq/test` as `TestMailbox`: one module provides `Mailer`, `SmsSender` and `TestMailbox.Mailbox` over one recording. `TestAuth.layer`'s base provides it (BEH-EA-354). The `Mailbox` key is not under `awthaq/ports/`: it is not a port.
3. `@awthaq/ports` keeps the adapters an application composes: `layerNoop` (dies on send) and `layerConsole` (logs, keeps nothing). `layerMemory` of both ports is removed.
4. Waiting for a forked send is the mailbox's job: by subscription, with a deadline on the real clock so a suite under `TestClock` still fails instead of hanging.
5. A double that overrides one member of a port is `Layer.mock` (BEH-EA-195).

## Alternatives considered

- **Keep `sent`.** Every provider implements a test read, and a development adapter left in production keeps every token.
- **A read tag in ports.** It splits one concept over two packages.
- **A non-recording `layerMemory`.** A name that lies.

## Consequences

- Positive: a provider adapter is `Mailer.Mailer.of({ send })`; no development adapter retains credentials; one tested wait replaces five copies.
- Negative: a breaking change to `@awthaq/ports` (ADR-EA-034, migration note in the changeset); a test outside `@awthaq/test`'s reach (`core`, `server`) composes `layerNoop` and cannot read mail; a "nothing was sent" assertion is a real-time window, not a proof.

## Related

ADR-EA-010 (the mailbox is provided where the application provides ports, never by a plugin), ADR-EA-034, ADR-EA-044 (`TestAuth.layer` is `AuthHost.layer` over the test ports).
