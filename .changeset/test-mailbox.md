---
"@awthaq/ports": minor
"@awthaq/test": minor
"@awthaq/cli": patch
---

Test observation leaves the production ports (ADR-EA-054, BEH-EA-354).

- `@awthaq/ports`: `MailerShape` and `SmsSenderShape` are `send` plus the optional `development` flag; `sent` is removed. `Mailer.layerMemory` and `SmsSender.layerMemory` are removed. `layerConsole` logs each message and no longer keeps it.
- `@awthaq/test`: `TestMailbox` (`layer`, `Mailbox`, `secret`) records every mail and SMS; `Mailbox.mail.waitFor` waits for a matching message by subscription with a real-clock deadline, `refute` fails if one arrives within a window. `TestAuth.layer` provides it in place of `Mailer.layerMemory`; its output now also holds `SmsSender` and `TestMailbox.Mailbox`.
- `@awthaq/cli`: the `mailer-development` finding names `layerNoop`, `layerConsole` or a test mailbox.

Migration: a provider adapter drops `sent` (`Mailer.Mailer.of({ send })`; the same for `SmsSender`). A test that composed `Mailer.layerMemory` composes `TestMailbox.layer` from `@awthaq/test` (or `Mailer.layerNoop` when nothing is sent) and reads `TestMailbox.Mailbox` instead of `mailer.sent`: `waitFor({ to, template })` replaces a read after cooperative yields, `refute` replaces a "nothing was sent" read, `TestMailbox.secret(mail)` replaces unwrapping `data.token`. A double that only fails or never answers is `Layer.mock(Mailer.Mailer)({ send })`.
