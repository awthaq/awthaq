---
"@awthaq/core": minor
"@awthaq/sql": minor
"@awthaq/ports": minor
"@awthaq/passkey": minor
---

A bounded session-rotation grace window, an `SmsSender` port with an E.164 rate-limit key, and passkey Related Origin Requests.

- **Rotation grace (RRS-005, RRC-006).** The secret a throttled touch replaces keeps verifying for `SessionConfig.rotationGrace` (default 30 seconds, `Duration.zero` disables it). Presenting it inside the window succeeds, re-rotates and hands back a fresh secret in `rotated`, so a lost `Set-Cookie` or `set-auth-token` no longer strands the client; it is per session, never a reuse signal (no family revocation, no `auth.session.reuse`), and `auth.session.rotated` carries `viaGrace` for those recoveries. New sessions columns `previousSecretHash`/`previousSecretExpiresAt` (core migration 29); `SessionsRepository.touch` takes them (optional).
- **`SmsSender` port (SOS-002).** `@awthaq/ports` exports `SmsSender` (`send`/`sent`, `layerNoop`/`layerMemory`/`layerConsole`, a typed `SmsDeliveryFailed`), mirroring `Mailer`. `RateLimits.phoneKey(read, options?)` (SOS-007) is a key strategy that normalises the destination to E.164 first, so an SMS endpoint gets a per-recipient cap alongside `"ip"` and `"principal"`.
- **Related Origin Requests (TC-008).** `PasskeyConfig.relatedOrigins` (default `[]`) lists exact https origins outside `rpId` that may use its passkeys; every ceremony accepts them and a new anonymous `GET /.well-known/webauthn` (group `passkey.wellKnown`) serves the list (404 while empty).

Migration: a deployment that relied on the replaced session secret dying instantly sets `SessionConfig.rotationGrace: Duration.zero`. Apply core migration 29 (two nullable columns). A hand-built `Sessions` table in tests needs `previousSecretHash TEXT, previousSecretExpiresAt TEXT`. `Auth.make([Passkey])` lists a fifth group, `passkey.wellKnown`. BEH-EA-052, BEH-EA-133.
