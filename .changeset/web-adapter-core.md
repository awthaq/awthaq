---
"@awthaq/web": minor
"@awthaq/next": minor
---

Extract the framework-neutral adapter core into a new `@awthaq/web` package (BO-004): the cookie-jar bridge (`applyResponseCookies`), database-verified `getSession`/`makeGetSession`/`applyRotatedSession`, `hasSessionCookie`, and the CSRF-echoing in-process client (`makeInProcessClient`/`inProcessClient`), plus an edge-safe `@awthaq/web/cookies` subpath. `@awthaq/next` is now the Next adapter over it and keeps its public names (`getSession`, `withNextCookies`, `serverActionClient`, ...), so an Astro or SvelteKit adapter can reuse the core.

`CookieJarLike.set` now receives an explicit `path` (BO-010; defaulted to `/` when a `Set-Cookie` omits it), so SvelteKit's `Cookies.set` and Astro's `AstroCookies.set` are structurally accepted.

Migration: `@awthaq/next` no longer depends on `@awthaq/client`/`@awthaq/core` directly; import framework-neutral helpers from `@awthaq/web` in non-Next code. A custom jar whose `set` declared `options?: CookieSetOptions` keeps working unchanged.
