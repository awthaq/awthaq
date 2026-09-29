# @awthaq/example-memory-server

A runnable example, additional to (never a replacement for) the
[repository README's own quickstart](../../README.md#quickstart). Where that
one shows a single plugin (Password) over a real, migrated Postgres backend,
this one shows a **multi-plugin composition** — `Password` + `Organization`
together — over `@awthaq/test`'s real, production-quality memory backend.

No `DATABASE_URL`, no migration run, no `AWTHAQ_ENCRYPTION_KEY`. Just:

```sh
pnpm install
pnpm start   # builds the workspace packages first (prestart), then node --experimental-strip-types index.ts
```

It listens on `:3001`. Try it. Every mutating request needs the CSRF double-submit
pair (a `__Host-csrf` cookie and the same value in `x-csrf-token`); any request mints the
cookie, so fetch it once into a cookie jar:

```sh
curl -s -c jar.txt -o /dev/null localhost:3001/roles/catalog
CSRF=$(awk '$6=="__Host-csrf"{print $7}' jar.txt)
JSON=(-b jar.txt -c jar.txt -H 'content-type: application/json' -H "x-csrf-token: $CSRF")

curl "${JSON[@]}" -X POST localhost:3001/password/sign-up \
  -d '{"email":"demo@example.com","password":"Zx9-quartz-Lantern-7431-orbit"}'
# -> 200, sets a real __Host-session cookie (into the jar)

curl "${JSON[@]}" -X POST localhost:3001/password/sign-in \
  -d '{"email":"demo@example.com","password":"Zx9-quartz-Lantern-7431-orbit"}'
# -> 403 EmailNotVerified: sign-in blocks until the mailed token is consumed
```

There is no inbox. The example composes `Mailer.layerConsole`, a development mailer that
prints every message, token included, to the server's log. Copy the token out of the
`awthaq mail` line for `template: verify-email` (it looks like `verify-email:...`) and
consume it:

```sh
curl "${JSON[@]}" -X POST localhost:3001/verify-email -d '{"token":"<the token from the log>"}'
# -> 204

curl "${JSON[@]}" -X POST localhost:3001/password/sign-in \
  -d '{"email":"demo@example.com","password":"Zx9-quartz-Lantern-7431-orbit"}'
# -> 200, a session

curl "${JSON[@]}" -X POST localhost:3001/organization -d '{"name":"Acme","slug":"acme"}'
# -> 200, a real organization row in the same in-memory backend

curl localhost:3001/roles/catalog
# -> 403: `RolesAdmin` (opt-in role administration) is guarded by qadi's
#    Path B `RequirePermission`; only a subject whose `Roles` catalog role
#    carries `roles:read`/`roles:manage` gets through. On startup the example
#    also runs `AuthorizationAudit.auditAuthorizationAnnotations`, refusing to
#    serve if any guarded endpoint declares neither a permission nor `publicEndpoint`.
```

The rate limiter is the real, enforcing one (`RateLimiter.layerMemory`, a bounded
single-process store), not the permissive test limiter: five sign-in attempts per account
in fifteen minutes, and the sixth answers `429`. A deployment with more than one instance
swaps in a shared store (`RateLimiter.layer` over `RateLimiterStoreSql.layerStoreSql`).
`Mailer.layerConsole` is the same kind of stand-in: development only, never in production.

Sign-up is guarded by a `BeforeSignUp` allow-list tap (only `@example.com`
addresses; anything else is refused with the typed `HookAborted`, 403), the
hook seam a host uses for policy the library does not own. `GET /roles/catalog`
is the `RequirePermission` (qadi Path B) dogfood: 403 until a user is assigned
`platform:admin` (`Roles.assign` is the trusted primitive). `test/smoke.test.ts`
boots this exact composition in-process and asserts both, plus the walkthrough above
(sign-up, token from the console mail, verify, sign-in) and the `429` (`pnpm test`).

See `app.ts`'s own comments for what each composition step is doing and
why (`index.ts` only starts it). Backed entirely by `@awthaq/test`'s `TestAuth.layer` — the same memory
machinery this repository's own HTTP integration tests and BDD suite already
exercise, not new stub scaffolding built just for this example.
