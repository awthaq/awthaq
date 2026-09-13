# 01 — Wire package dependencies for @effect-auth/passkey and the WebAuthn port

**What to build:** `@effect-auth/ports` can import `@simplewebauthn/server`
v14 (the WebAuthn port's only new external dependency); `@effect-auth/passkey`
can import `@effect-auth/core` (`Sessions`, `Users`, `Accounts`,
`AuthPlugin`), `@effect-auth/ports` (the new `WebAuthn` port),
`@effect-auth/api` (contract stratum types), and `@effect-auth/sql`
(for `ChallengeStore.layerSql` and the plugin's own `passkey_credential`
table). This is a prefactor, not a feature — no new exported symbols, no
behavior change. It exists as its own ticket so every ticket it unblocks
doesn't separately touch the same `package.json`/tsconfig files.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] `packages/ports/package.json` lists `@simplewebauthn/server` (v14) as
      a dependency
- [ ] `packages/passkey/package.json` lists `@effect-auth/core`,
      `@effect-auth/ports`, `@effect-auth/api`, and `@effect-auth/sql` as
      `workspace:*` dependencies
- [ ] `packages/passkey/tsconfig.src.json`'s `paths`/`references` include
      all four, the same way every other plugin package's scaffold already
      wires its own dependencies
- [ ] `pnpm install` resolves cleanly
- [ ] `pnpm typecheck` and `pnpm build` succeed for both packages with no
      exported symbols added yet

## Result

Done as specified. `@simplewebauthn/server` (^14.0.1) added to `packages/ports/package.json`; `packages/passkey/package.json`/`tsconfig.src.json` already carried `@effect-auth/core`/`ports`/`api`/`sql` (and `@effect-auth/server`) from the earlier full-repo package scaffold — verified the wiring rather than re-adding it. `pnpm install`, `pnpm typecheck`, `pnpm build` all pass.
