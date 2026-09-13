# 28 — knip + dependabot + provenance-publish workflow (wired, unrun)

**What to build:** CI gains a dead-export gate and dependency-update
automation, and a provenance-publish workflow exists and is correct but
is never triggered as part of this effort.

**Blocked by:** None — can start immediately

**Status:** done

## Result

- **knip**: added, configured (`knip.json`), and wired into `pnpm check`
  (`pnpm knip` is its own script too). Found real dead code, all of it
  fixed rather than ignored:
  - 21 genuinely-unused `dependencies` entries across 14 real, implemented
    packages (verified each by grep before removing, not just trusting
    knip — e.g. `@effect-auth/sql` declared but never imported in
    `admin`/`jwt`/`oauth`/`organization`/`passkey`/`password`/`qadi`/`roles`/`server`/`test`).
  - Two BDD `Worlds` (`OAuthWorld.ts`'s `optionalField`, `AdminWorld.ts`'s
    `getLastResponse`) that were truly dead code (zero usage anywhere,
    including same-file) — deleted, not just un-exported.
  - Several exports (`ORIGIN`/`appHandle` in `AdminWorld.ts`, `appHandle`
    in `PasskeyWorld.ts`, `STRONG_PASSWORD`/`setCookieHeader` in
    `SessionWorld.ts`, the `FakeRoutes` interface in `OAuthWorld.ts`) that
    genuinely are used, just only within their own file — narrowed from
    `export const`/`export interface` to plain module-private ones instead
    of deleting real, in-use code (caught this distinction the hard way:
    an initial pass deleted two functions in
    `packages/ports/test/webauthnFixtures.ts`
    that looked unused by the same "grep everywhere but the file itself"
    method, which turned out to be wrong methodology — they were used
    later in that same file; restored before it ever reached a commit).
  - The 5 packages the wayfinder map already ruled out of scope for stub
    cleanup (`api-key`, `two-factor`, `magic-link`, `next`, `cli`) get a
    `knip.json`-scoped `ignoreDependencies` instead of dep removal —
    their currently-unused `dependencies`/`@effect/vitest` are there for
    when those stubs get filled in, not dead weight to strip now.
  - Along the way, found and fixed a **real Changesets misconfiguration**
    unrelated to knip itself but blocking ticket 27's own pipeline proof:
    `privatePackages.version` defaults to `false`, so every workspace
    package (all `"private": true`) was silently invisible to
    `changeset status`/`version` until set explicitly — see ticket 27's
    own Result for the full account.
- **Dependabot**: `.github/dependabot.yml` — weekly `npm` (pnpm-aware)
  updates for the workspace, grouped (`effect`/`@effect/*` together,
  `@qadi/*` together) to avoid one-PR-per-package churn on a monorepo this
  size, plus weekly `github-actions` updates.
- **Provenance-publish workflow**: `.github/workflows/release.yml`,
  following `spec/process/definitions-of-done.md`'s gate 12 exactly —
  `changesets/action` driving `pnpm changeset-version`/`changeset-publish`,
  `id-token: write` for npm OIDC trusted publishing, no `NPM_TOKEN`
  anywhere. Wired but genuinely inert: every package is still `private`,
  so `changeset publish` has nothing to publish, and going fully live also
  needs a trusted-publisher registration on npmjs.com for this repo — real
  external setup no agent can do from here, exactly the follow-up the
  wayfinder map's own ticket 06 decision already named.
- `check.yml` unchanged (still just `pnpm install --frozen-lockfile && pnpm check`) —
  knip runs *inside* `pnpm check` now, so no separate CI step was needed.

`pnpm check` (the full local gate: typecheck, lint, knip, format:check,
circular, coverage, `test:bdd`, `spec:verify:strict`) passes clean
end-to-end, including 93%+ statement coverage and all 19 spec-traceability
checks — run for real, not asserted from memory.

- [x] knip configured and added as a `pnpm check` step, passing against
      current source — dead exports fixed or explicitly ignored, the gate
      never weakened to pass trivially
- [x] `.github/dependabot.yml` configured for the workspace's package
      managers
- [x] A provenance-publish GitHub Actions workflow exists, following
      `spec/process/definitions-of-done.md`'s already-committed plan —
      wired but not run; no npm publish occurs as part of this ticket
- [x] `check.yml` passes with the new knip step included (via `pnpm check`)
