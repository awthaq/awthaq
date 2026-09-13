# 17 — Key-provider port + env-backed KMS-shaped layer

**What to build:** A new, swappable key-provider seam exists in
`@effect-auth/ports`, with a concrete env-key-backed implementation
usable in dev/test today, shaped so a real KMS can satisfy the same
interface later.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] New key-provider port/interface added to `@effect-auth/ports` —
      provider-agnostic (not hardcoded to env vars in its own type),
      returning key material keyed by a rotatable `kid`
- [ ] A concrete `layerEnv` (or similarly named) implementation satisfies
      the interface, backed by a single env-provided key for dev/test
- [ ] Contract test proves: a caller can retrieve the current key by
      `kid`, and retrieval for an unknown `kid` fails with a typed error
- [ ] No consumer wired yet — that's tickets 18/19; this ticket is the
      port plus one concrete layer only
