# @awthaq/example-sql-server

The README quickstart as a runnable, tested app: **Password and Organization over a real, migrated
SQL backend**, served by `AuthHost.layer` (`@awthaq/server`). It runs against a SQLite file by
default (nothing to install) and against Postgres the moment `DATABASE_URL` is set. Only the
`SqlClient` layer differs between the two (`SqlLive` in [`app.ts`](app.ts)); the plugin
composition, migrations, store adapters and rate-limit store are the same code, which is the point:
start embedded, move to Postgres without rewriting plugin code. `Organization` owns tables, so the
example is also the proof that a table-owning plugin migrates and serves over SQL from a production
module: `AuthHost` runs core's migrations and then the composition's when the layer is built.

```sh
pnpm install
export AWTHAQ_CSRF_SECRET="$(openssl rand -base64 32)"   # >= 32 bytes, required
pnpm start   # builds the workspace packages first (prestart), then node --experimental-strip-types index.ts
```

It listens on `:3002` and writes `./awthaq.sqlite` (`SQLITE_FILE` overrides the path, `:memory:`
keeps nothing). For Postgres, `DATABASE_URL=postgres://... pnpm start` runs the same migrations
against it.

## Migrations

By default the server migrates at boot (`migrations: "apply"`): core's pending migrations, then
the plugins', refusing a ledger that disagrees with the composition (a plugin inserted before one
already applied). When `awthaq migration apply` is your deploy step, set
`AWTHAQ_MIGRATE_ON_BOOT=false` (`migrations: "verify"`): the server then never migrates, and
refuses to start while anything is pending, naming each pending migration.

## Keys

`KeyProvider.layerEnv` (`AWTHAQ_ENCRYPTION_KEYS`, or the single `AWTHAQ_ENCRYPTION_KEY`) is used
whenever a key is configured. With none, the example opts into `KeyProvider.layerEphemeral`: a
random key for this run, with a loud warning in the log, refused under `NODE_ENV=production`.
Organization seals OAuth client secrets under it (and an OAuth deployment its provider tokens), so a
real deployment must configure a key.

## Try it

Every mutating request needs the CSRF double-submit pair (a `__Host-csrf` cookie and the same
value in `x-csrf-token`); the curl walkthrough in
[`examples/memory-server`](../memory-server/README.md) applies unchanged (swap the port for
`3002`). [`test/smoke.test.ts`](test/smoke.test.ts) is the executable version: sign-up, the
verification token the development mailer prints to the log, verification, sign-in, an
organization created over SQL, a second boot on the same SQLite file that applies nothing and signs
the same user in, and a verify-mode boot that refuses an unmigrated database.

```sh
pnpm test
```
