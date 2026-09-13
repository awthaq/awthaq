# 05 — Package README: the globalThis-pinned runtime recipe and a worked example

**What to build:** `packages/next`'s README documents, as a
copy-pasteable recipe, the `globalThis`-pinned `ManagedRuntime` pattern a
Next.js application needs to construct its own runtime safely (this package
deliberately ships no such helper itself — see
`.scratch/next-package/spec.md`'s "No runtime construction owned by this
package" decision), plus one worked example wiring `getSession` (02),
`hasSessionCookie` (03), and `withNextCookies` (04) together across a page,
`proxy.ts`, and a server action — so an application developer has one place
that shows all three in context rather than three isolated doc comments.

**Blocked by:** 02 (getSession), 03 (hasSessionCookie), 04 (withNextCookies)

**Status:** done

## Result

`packages/next/README.md` replaced the pre-implementation placeholder
banner with real documentation (this package no longer matches that
banner's "no line of source has shipped" claim).

- [x] README shows the `globalThis`-pinned `ManagedRuntime` construction
      pattern, with SIGINT/SIGTERM disposal, and explains why a plain
      module-scope `ManagedRuntime.make` silently produces a second runtime
      under Next's dev-server hot reloading (no `effect/GlobalValue` exists
      in Effect v4 to do this automatically)
- [x] README shows `proxy.ts` using `hasSessionCookie` for an optimistic
      redirect, explicitly labeled as non-authoritative
- [x] README shows a Server Component using `getSession` as the real,
      database-backed boundary
- [x] README shows a server action using `withNextCookies` after
      dispatching a request through the composed router
- [x] No new runtime-construction helper export is added to the package —
      the recipe stays documentation, not code, per the spec's decision
