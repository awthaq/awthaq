# @awthaq/example-memory-server

A runnable example, additional to (never a replacement for) the
[repository README's own quickstart](../../README.md#quickstart). Where that
one shows a single plugin (Password) over a real, migrated Postgres backend,
this one shows a **multi-plugin composition** — `Password` + `Organization`
together — over `@awthaq/test`'s real, production-quality memory backend.

No `DATABASE_URL`, no migration run, no `AWTHAQ_ENCRYPTION_KEY`. Just:

```sh
pnpm install
node --experimental-strip-types index.ts
```

It listens on `:3001`. Try it:

```sh
curl -X POST localhost:3001/password/sign-up \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"correct horse battery staple"}'
# -> 200, sets a real __Host-session cookie

curl -X POST localhost:3001/password/sign-in \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"correct horse battery staple"}'
# -> 403 EmailNotVerified — signIn hard-blocks until the mailed token is
#    consumed via POST /verify-email (the memory Mailer just drops the
#    mail; there is no console-log stand-in wired into this example)

curl -X POST localhost:3001/organization \
  -H 'content-type: application/json' \
  -H 'cookie: __Host-session=<from sign-up>' \
  -d '{"name":"Acme","slug":"acme"}'
# -> 200, a real organization row in the same in-memory backend

curl localhost:3001/roles/catalog
# -> 403: `RolesAdmin` (opt-in role administration) is guarded by qadi's
#    Path B `RequirePermission`; only a subject whose `Roles` catalog role
#    carries `roles:read`/`roles:manage` gets through. On startup the example
#    also runs `AuthorizationAudit.auditAuthorizationAnnotations`, refusing to
#    serve if any guarded endpoint declares neither a permission nor `publicEndpoint`.
```

See `index.ts`'s own comments for what each composition step is doing and
why. Backed entirely by `@awthaq/test`'s `TestAuth.layer` — the same memory
machinery this repository's own HTTP integration tests and BDD suite already
exercise, not new stub scaffolding built just for this example.
