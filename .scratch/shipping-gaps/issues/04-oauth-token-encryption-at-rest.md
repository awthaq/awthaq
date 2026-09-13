# 04 — OAuth provider-token encryption at rest

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

`packages/sql/src/Models.ts` L93-95 marks `accessToken`/`refreshToken` as
`Model.Sensitive(Schema.NullOr(Schema.String))` — excluded from JSON/logs,
but stored in plaintext at rest. `packages/oauth/src/OAuth.ts` also
carries plain `accessToken: string` fields (L172, L202, L487) with no
redaction wrapper at that layer at all. No encryption call exists
anywhere in `packages/sql` or `packages/oauth`. Upstream's AES-256-GCM
envelope (ADR 0006, their `ea_pt_v1` format) is reference material for
the *technique* — this is a different library building its own
independent implementation, not porting their code.

Decide: (a) envelope design — AES-256-GCM with AAD is the report's cited
technique and a reasonable default; confirm algorithm choice, and decide
what belongs in the AAD (provider id? user id? both, to bind ciphertext
to its row and prevent cross-row swap attacks?). (b) key source and
rotation — a single env-provided key (simplest, matches this library's
existing `Redacted`-handled secret conventions elsewhere, e.g. `Jwt`'s
`privateKeyJwk`), versus a KMS integration point; if rotation matters,
does that mean a keyed envelope format (`kid`-tagged, so old ciphertext
stays decryptable after a key rotation) from day one, or is that
explicitly deferred? (c) where does encrypt/decrypt happen — a
transform on the `Model.Sensitive` field itself (encrypted at the
persistence boundary, so `packages/oauth`'s in-memory `accessToken`
stays plain), or a dedicated service both `packages/sql` and
`packages/oauth` depend on (closer to a `@effect-auth/ports` port,
matching this codebase's existing hexagonal seam convention)? (d) does
PKCE verifier/nonce get the same treatment, or is that intentionally
narrower in scope than provider tokens (PKCE state is short-lived and
already carried in a signed `__Host-oauth-state` cookie plus
`Verification` `FlowPayload`, versus provider tokens which persist for
the life of the linked account)?

## Answer

**(a) Envelope.** AES-256-GCM, AAD binding ciphertext to both provider id
and user id (prevents cross-row ciphertext-swap attacks) — the technique
the origin report cited from upstream's ADR 0006, reimplemented
independently, not ported.

**(b) Key source — a KMS integration point from day one, not a flat env
var.** A new capability (either a dedicated port or an addition to an
existing one in `@effect-auth/ports`) abstracts key retrieval/decryption
behind a provider-agnostic interface, with a concrete env-key-backed
"local KMS" layer satisfying that same interface for dev/test — so
nothing is blocked on an actual cloud KMS account existing, but the seam
is real from the start rather than retrofitted later. Rotation: a
`kid`-tagged keyed envelope format from day one (consistent with wanting
a real key-provider story rather than one static key that can never
rotate without a flag day).

**(c) Where encrypt/decrypt happens — a dedicated service, not a bare
`Model` transform.** Both `packages/sql` and `packages/oauth` depend on
it; this is now required regardless, since PKCE is also in scope (below)
and PKCE state doesn't live in `packages/sql`'s models at all — a
Model-level transform couldn't cover it.

**(d) PKCE scope — also encrypted, matching upstream's full scope.**
Verifier/nonce get the same envelope treatment as provider tokens. This
reaches into the `__Host-oauth-state` cookie / `Verification`
`FlowPayload` path, not just SQL-persisted state — a real cross-cutting
implication the spec needs to capture explicitly: the encryption service
from (c) must be callable from both the SQL persistence path and the
cookie/FlowPayload path, not just one.
