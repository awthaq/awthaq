---
"@awthaq/test": minor
---

`TestAuth.layer` is now `AuthHost.layer` over the test ports and the redaction guard (BEH-EA-342), and takes `tier: "all" | "public" | "admin"`. In `records: "sql"` mode the migrations run through `Migrations.apply`, so a drifted ledger refuses the build. A tap passed in `taps` must tap a point the composition declares (it now fails to compile otherwise). The registries (`RateLimits.layer`, `Slots.layer`, `Credentials.CredentialResolversLive`) now come from `AuthHost`'s base rather than the test ports; the composition's output is otherwise the same set of services, plus the core stores of the chosen bundle.

Migration: none for callers that already compile. A suite whose `taps` tapped an undeclared point (it never ran) must compose the plugin that owns the point; a helper that typed `taps` as `Layer.Layer<never, never, unknown>` should make the requirement a type parameter (see `packages/password/test/harness.ts`).
