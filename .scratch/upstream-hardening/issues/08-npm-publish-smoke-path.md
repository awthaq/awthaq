# npm publish smoke path (`package:smoke`, optional pkg-pr-new previews)

Type: grilling
Status: resolved

## Question

All 21 `package.json`s are `"private": true`; there's no `package:smoke`
script anywhere. `release.yml`'s own header comment already documents
this as known, wired-but-inert debt pending a package going public
(`shipping-gaps` ticket 06's residual note) — but a dry-run smoke test
needs no publish credentials and is agent-doable now, unlike the actual
publish.

Decide: what `package:smoke` actually checks (an `npm pack --dry-run`
per-package, or something that also validates the resulting tarball's
contents against `package.json`'s `files`/`exports`?); whether it runs in
CI on every PR (catching a broken pack before merge, the pasted report's
core value-add) or only on demand; whether pkg-pr-new previews are in
scope for this ticket or a separate follow-on (they need the packages to
not be typecheck/build-broken, but not necessarily un-private — confirm
that assumption); and whether `"private": true` itself should flip before
the real publish, or stay as-is until `shipping-gaps` ticket 06's deferred
OIDC task actually runs.

## Answer

Researched against `publint`/`@arethetypeswrong/cli`'s own docs and
`pkg.pr.new`'s own README, grounded against this repo's actual package
shapes (`packages/ports/package.json`'s `exports`/`files`) and
`scripts/circular.mjs`'s existing root-script convention.

**`package:smoke` checks more than a bare pack — richest option, per
this map's standing preference.** A plain `npm pack --dry-run` only
proves the tarball assembles; it doesn't catch a broken `exports` map or
a `.d.ts` that resolves wrong for consumers, which is exactly the class
of bug the pasted report's own value-add ("catches broken `main`
publishes") is about. Three checks per package, all local, all needing
no publish credentials:
1. `npm pack --dry-run` (or `--json`) — the tarball actually assembles.
2. `publint` — package.json metadata shape, `exports`/`files`/`main`
   correctness (the standard tool for exactly this failure class).
3. `@arethetypeswrong/cli` — catches the specific "works locally, breaks
   for TS consumers" case a bare pack/publint can't see.
Both `publint` and `@arethetypeswrong/cli` become new root
`devDependencies` (matching how `oxlint`/`knip` are already pinned root
deps, not ad-hoc `dlx`-invoked), not `pnpm dlx`'d per run.

**New root script — `scripts/package-smoke.mjs`**, following
`scripts/circular.mjs`'s exact convention (`glob.globSync` over
`packages/*`, a harmless no-op if none match), iterating every package uniformly — including the still-empty stub
packages (`cli`, `api-key`, `magic-link`, `two-factor`, each a bare
`export {};`). Metadata correctness is worth checking even for an empty
stub; cheap and catches config drift early.

**Runs in CI on every PR — folded into `pnpm check` as a new step**,
not a separate on-demand-only script. Placed after `pnpm typecheck` in
`package.json`'s `check` chain (`typecheck` already emits real `lib/`
output via `tsc -b`'s project references — same command each package's
own `build` script runs — so by the time `package:smoke` runs, real
built artifacts already exist to pack; no separate build step needed).
Matches this repo's existing "strict 8-gate check" culture rather than
leaving a 9th real gate opt-in.

**`pkg-pr-new` — deferred, but not for the reason this ticket's question
assumed.** Confirmed via its own README: it does **not** care about
`"private": true` at all — it never publishes to npm, it serves its own
npm-compatible URLs instead. The real blocker is more fundamental: it
requires installing a GitHub App on the repository (`github.com/apps/
pkg-pr-new`), which needs a real GitHub remote to attach to — and this
repo has none yet (`docs/agents/issue-tracker.md`'s own header: "no
GitHub/GitLab to point at yet"). Deferred as a separate follow-on,
blocked on the same category of manual, agent-inaccessible setup as
`shipping-gaps` ticket 06's OIDC trusted-publishing task — not on
anything this ticket's own scope could resolve.

**`"private": true` — stays exactly as-is, untouched by this ticket.**
None of `npm pack --dry-run`, `publint`, or `arethetypeswrong` read or
care about that field — it's purely an npm-publish-time gate, irrelevant
to local dry-run/lint tooling. Flipping it stays owned by `shipping-gaps`
ticket 06's deferred OIDC task, exactly as that map already decided.
