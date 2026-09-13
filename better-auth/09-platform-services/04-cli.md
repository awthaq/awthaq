# CLI

The CLI is a family of operator-facing commands that act as **clients** of
the same abstract adapter contract specified in
`01-core-domain/04-database-adapter-contract.md` — every command in this
document either reads a configuration to determine which adapter is in
play, generates artifacts describing that adapter's expected schema, or
(for one adapter family only) actually drives schema evolution against a
live database. This document specifies four operations —
**scaffolding** (`init`), **schema generation** (`generate`), **migration**
(`migrate`), and **administrative bootstrap** (`create-admin`, `secret`) —
plus the idempotency contract each carries under repeated invocation.

---

## 1. Scaffolding (`init`)

### 1.1 Precondition on project state

**Requires:** the target directory already contains a project descriptor
(a package manifest) — `init` explicitly refuses to run against what it
detects as an empty/uninitialized directory, instructing the operator to
initialize a package project first rather than attempting to bootstrap one
itself.

**On violation:** refused immediately, before any file is written. Blamed
party: **CLIENT** (the operator pointed the scaffolder at a directory that
is not yet a project).

### 1.2 The scaffolding workflow as a sequence

```
  operator                          init command
     │                                    │
     │──run init───────────────────────▶  │
     │                                    │── package manifest present? ──✗──▶ refuse, exit
     │                                    │                              ✓
     │                                    │── framework detected from manifest + directory shape
     │                                    │   (falls back to a default framework choice if
     │                                    │    detection fails, but skips generating a route
     │                                    │    handler file entirely when detection fails —
     │                                    │    an undetected framework gets a config file only)
     │◀── prompts: install core dep? ────│
     │──yes/no─────────────────────────▶  │
     │◀── prompts: create env file(s)? ──│
     │──yes/no + values─────────────────▶ │
     │◀── prompts: configure database? ──│  (yes / stateless / skip)
     │──choice─────────────────────────▶  │
     │        │
     │        ├─ if an ORM chosen: ask "generate schema now?"
     │        ├─ if a direct-SQL dialect chosen: ask "run migration now?"
     │        └─ if the schemaless store chosen: informational only,
     │           no generation/migration step offered (nothing to
     │           generate — see 01-storage-and-adapters.md §5.1)
     │◀── prompts: email/password? social providers? ──────────────────│
     │──choices───────────────────────────────────────────────────────▶│
     │                                    │── EACH artifact below is only
     │                                    │   written if its file does not
     │                                    │   already exist (idempotency,
     │                                    │   see §1.3):
     │                                    │     - auth configuration file
     │                                    │     - generated schema artifact
     │                                    │       (ORM path) or migration
     │                                    │       run (direct-SQL path)
     │                                    │     - framework route-handler file
     │                                    │     - client configuration file
     │                                    │── install collected dependencies
     │◀── prompts: connect to hosted dashboard? ─────────────────────── │
     │──yes/no─────────────────────────────────────────────────────────▶│
     │◀── prints numbered "next steps" for whatever was skipped ────────│
```

### 1.3 Idempotency contract of re-running `init`

**Ensures:** re-running `init` against a project it (or the operator) has
already scaffolded is **safe** — every one of the four generated-artifact
steps (auth config, schema, route handler, client config) independently
checks for the corresponding file's **existence** first and skips
generation entirely if a file is already present at any of the well-known
candidate locations, asking nothing further about that artifact.

**Invariant:** idempotency here is **existence-based, not
content-based** — re-running `init` never diffs an existing artifact
against what it would generate today, and never overwrites or merges into
an existing artifact. A previously-generated auth configuration file that
has since been hand-edited is never touched by a subsequent `init` run,
even if the operator's answers this time would imply a different
configuration.

**On violation:** this is a **documented narrowing** relative to a
"converges to the desired configuration" idempotency ideal — re-running
`init` after changing an answer (for example, choosing a different
database this time) does **not** reconcile the previously-generated
artifacts with the new answer; it silently leaves them as they were,
because their files already exist. Blamed party for surprise at this: none
in the Design-by-Contract sense (this is the documented contract, not a
violation of it) — an operator who wants a fresh scaffold for a changed
answer must remove the existing artifact first.

### 1.4 Postcondition on generated artifacts

**Ensures:** every file `init` does write is written completely and
atomically from the operator's point of view (the necessary parent
directories are created first) — there is no code path that leaves a
truncated or partially-written artifact behind if a later step in the
same run fails; a failure at any generation step aborts the entire run
with a non-zero exit and a diagnostic naming the failed step.

---

## 2. Schema generation (`generate`)

**Role:** produces a static artifact (in whatever representation the
target adapter's ecosystem natively consumes — a schema-definition source
file, an ORM's own declarative schema file, or a set of raw migration
statements) describing the tables/columns the currently configured
entities require, **without** ever touching a live database connection
for the two adapter families that consume a static schema file
(the two ORM adapters), and **with** a live, read-only introspection
connection for the SQL-adapter family (to compute a diff against the
live schema, described next).

### 2.1 Precondition

**Requires:** a resolvable configuration (either the project's own
configuration file, or an adapter identity supplied directly on the
command line for schema generation decoupled from a full configuration).
For the SQL-adapter family, the configured database connection must be
reachable for introspection; for the two ORM adapters, no live connection
is required at all — schema generation for those two is a pure,
offline function of the configured entities.

### 2.2 Postcondition: the diff, and its two severity classes

**Ensures:** the generated artifact is the **diff** between what the
currently configured entities require and what the target already has (a
previously generated schema file's own declarations for the ORM adapters,
or the live introspected schema for the SQL-adapter family) — not a full
re-statement from scratch. Two classes of finding are surfaced, and they
are **not** the same severity:

* **schema problems** — a column that exists but is shaped incompatibly
  with what is required (wrong nullability, wrong type) such that no
  migration can safely reconcile it; these are reported as warnings
  alongside whatever artifact is still produced, because `generate` is
  advisory and never blocks — see §3.2 for the contrast with `migrate`,
  which does block on this exact finding.
* **unsafe changes** — a column the migration would need to alter or drop
  in a way that would **corrupt data already present** in a populated
  target; for the SQL-adapter family, the generated artifact for such a
  change is still produced, but is prefixed with an explicit
  do-not-run-as-is warning banner naming every unsafe change, so an
  operator who blindly executes the generated artifact against a
  populated database has been given every opportunity to notice first.

**Invariant:** the artifact filename, when not overridden, is
adapter-specific and — for the SQL-adapter family specifically — carries a
generation timestamp, so successive `generate` runs against that family
never collide on filename; the two ORM adapters instead target one fixed,
well-known filename by default, which is what makes their idempotency
contract (§2.3) meaningful.

### 2.3 Idempotency contract

**Ensures:** if the computed diff between required and existing schema is
**empty**, `generate` performs **no file write at all** and reports that
the schema is already current — this holds regardless of how many times
`generate` is invoked in a row with no intervening change to the
configured entities.

**Ensures (non-empty diff, existing target file):** when the target file
already exists and the diff is non-empty, the operator is asked to confirm
before the file is overwritten or appended to (skippable via an explicit
auto-confirm flag for non-interactive use); declining leaves the existing
file completely untouched and exits with a non-zero status.

**On violation:** a `generate` invocation that is declined or aborted
before the write is a no-op with respect to the filesystem — nothing
observable changes. Blamed party for an operator surprised that a schema
they expected to be regenerated was not: **CLIENT** (declined the prompt,
or ran non-interactively without the auto-confirm flag).

---

## 3. Migration (`migrate`)

**Role:** the one command in this document that actually mutates a live
database's schema — and, correspondingly, the one command with the
strictest preconditions.

### 3.1 Precondition: adapter-family restriction

**Requires:** the configured adapter must be the SQL-adapter family
specifically. **On violation:** for either ORM adapter, `migrate` refuses
immediately and redirects the operator to that ecosystem's own native
migration tooling (having already produced a schema artifact via
`generate` first); for any other adapter identity, it refuses with a
generic "not supported for this adapter" diagnostic. Blamed party in every
refusal case: **CLIENT** (invoked the wrong command for the configured
adapter) — and every refusal is itself still telemetered (§ below) as a
distinct outcome, never silently swallowed.

### 3.2 Precondition: no unsafe changes, enforced (contrast with `generate`)

**Requires:** the same diff computation as `generate` §2.2, but here the
**unsafe-changes** finding is a hard precondition, not an advisory: if the
diff contains any change that would corrupt already-populated data,
`migrate` refuses to run **anything** — no partial migration, no
best-effort subset — and directs the operator to `generate` instead, to
read the exact statements without executing them.

**On violation:** refused before a single statement is executed against
the live database. Blamed party: **CLIENT** (the currently configured
entities are incompatible with the live, populated schema in a way that
cannot be safely auto-migrated; a hand-written migration is required).

### 3.3 Precondition: no incompatible columns, enforced

**Requires:** additionally, the same **schema problems** finding from
§2.2 (a column shaped so that no write can ever succeed against it) is
also a hard precondition for `migrate` specifically — **nothing runs** if
any such column is found, every one is named in the refusal.

### 3.4 Postcondition and idempotency

**Ensures:** if, after both preconditions above clear, the diff between
required and live schema is **empty**, `migrate` performs no database
mutation at all and reports that no migration is needed — this holds on
every repeated invocation with no intervening configuration change,
making `migrate` **idempotent to a fixed point**: running it repeatedly
against an unchanging configuration converges after the first run to a
permanent no-op.

**Ensures (non-empty diff):** the operator is shown exactly which
tables/columns/indexes will be added (this command only ever **adds** —
altering or dropping an existing, populated column is precisely the class
of change §3.2 refuses to attempt automatically) and is asked to confirm
before anything executes (skippable via the same auto-confirm flag as
`generate`, for non-interactive use); declining performs no mutation.

**Invariant:** every distinct outcome of a `migrate` invocation — refused
for wrong adapter, refused for unsafe changes, refused for incompatible
columns, no changes needed, declined by the operator, or successfully
applied — is reported through the telemetry contract (`03-telemetry.md`)
as a distinct, named outcome (never merely "success/failure"), subject to
that document's opt-in gate.

```
                         migrate command
                                │
                 configured adapter is the SQL-adapter family?
                          │no              │yes
                          ▼                 ▼
                     REFUSE          compute diff vs. live schema
                 (redirect to                  │
                 generate + native      any incompatible column found?
                 tooling)                   │yes         │no
                                              ▼            ▼
                                          REFUSE     any unsafe (data-
                                        (nothing         corrupting) change?
                                         executes)          │yes      │no
                                                             ▼         ▼
                                                         REFUSE   diff empty?
                                                       (nothing    │yes  │no
                                                        executes)  ▼     ▼
                                                              NO-OP  show plan,
                                                                     confirm
                                                                       │
                                                                confirmed?
                                                                 │no   │yes
                                                                 ▼      ▼
                                                            CANCELLED  APPLY
                                                                      (additive
                                                                       only)
```

---

## 4. Administrative bootstrap

### 4.1 `secret` — a pure generator, no precondition

**Ensures:** produces one cryptographically random value suitable for the
instance's signing/encryption secret, printed for the operator to place
into their own environment configuration. **Invariant:** stateless and
side-effect-free — it reads nothing and writes nothing; every invocation
is independent.

### 4.2 `create-admin` — a guarded, adapter-dependent bootstrap

**Requires:** a resolvable configuration naming a real (non-schemaless-
placeholder, non-absent) database, and an installed capability on that
configured instance for administrator-role user creation — the command
refuses immediately, before prompting for any credential, if either
precondition fails.

**Ensures:** before creating anything, the command counts existing users
through the configured adapter; if that count is nonzero, it requires an
explicit confirmation (or an explicit force flag, for non-interactive use)
before proceeding, precisely because creating an administrator into an
already-populated user base is a sensitive, rarely-intended operation
worth an extra confirmation gate that an empty, fresh database does not
need.

**On violation:** a failure to even inspect the existing user count
(unreachable database, unmigrated schema) refuses the entire operation
with a diagnostic instructing the operator to verify connectivity and
migration status first — it never proceeds to attempt user creation
against a database it could not first inspect. Blamed party: **CLIENT**.

**Invariant:** the underlying user-creation call is the same one the
public sign-up surface uses — this command grants no bypass of that
operation's own postconditions (password policy, email format, uniqueness)
described in `01-core-domain`; a failure there (for example, an email
already in use) surfaces as the same typed error and aborts with a
non-zero exit, having created nothing.
