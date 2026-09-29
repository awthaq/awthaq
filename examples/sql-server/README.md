# @awthaq/example-sql-server

The README quickstart as a runnable, tested app: **Password over a real, migrated SQL
backend**. It runs against a SQLite file by default (nothing to install) and against
Postgres the moment `DATABASE_URL` is set. Only the `SqlClient` layer differs between the two
(`SqlLive` in [`app.ts`](app.ts)); the plugin composition, migrations, repositories and
rate-limit store are the same code, which is the point: start embedded, move to Postgres without
rewriting plugin code.

```sh
pnpm install
export AWTHAQ_CSRF_SECRET="$(openssl rand -base64 32)"   # >= 32 bytes, required
pnpm start   # builds the workspace packages first (prestart), then node --experimental-strip-types index.ts
```

It listens on `:3002` and writes `./awthaq.sqlite` (`SQLITE_FILE` overrides the path, `:memory:`
keeps nothing). For Postgres, `DATABASE_URL=postgres://... pnpm start` runs the same migrations
against it.

## Keys

`KeyProvider.layerEnv` (`AWTHAQ_ENCRYPTION_KEYS`, or the single `AWTHAQ_ENCRYPTION_KEY`) is used
whenever a key is configured. With none, the example opts into `KeyProvider.layerEphemeral`: a
random key for this run, with a loud warning in the log, refused under `NODE_ENV=production`. The
Password plugin stores nothing encrypted, so a restart loses nothing here; an OAuth deployment
must configure a real key.

## Try it

Every mutating request needs the CSRF double-submit pair (a `__Host-csrf` cookie and the same
value in `x-csrf-token`); the curl walkthrough in
[`examples/memory-server`](../memory-server/README.md) applies unchanged (swap the port for
`3002`). [`test/smoke.test.ts`](test/smoke.test.ts) is the executable version: sign-up, the
verification token the development mailer prints to the log, verification, sign-in, then a second
boot on the same SQLite file that signs the same user in.

```sh
pnpm test
```
