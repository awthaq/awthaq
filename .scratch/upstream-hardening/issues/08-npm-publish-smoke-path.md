# npm publish smoke path (`package:smoke`, optional pkg-pr-new previews)

Type: grilling
Status: open

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
