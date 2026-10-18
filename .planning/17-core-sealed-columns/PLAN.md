# Plan 17: Core's sealed columns run on `SealedColumn`, and `sweepAll` covers them

| Property | Value |
|---|---|
| Strength | Strong. Six core columns are encrypted by hand next to a substrate that exists to stop that. The hand-rolled copies have drifted from it in AAD spelling, failure policy and re-seal switch, and the key-retirement flow ADR-EA-019 decision 3 promises cannot finish for core rows |
| Dependency category | ports & adapters (`UserStore`, `SessionStore`, `AccountStore` in `@awthaq/ports`; their SQL adapters over `Repositories.ts`) and local-substitutable (the `Ref` adapters) |
| Wave / order | After plans 02 and 05 (both done). **Before plan 16** (sql-store-adapters), so 16 moves code that is already on the substrate (§8). Independent of 11–15 and 18–24 |
| Fixes live bugs | (1) Following the operator runbook (`docs/plugin-authoring.md:156`, "plus the core token and PII columns") with a hand-declared core column makes `sweep` count every healthy row `unreadable` **and re-seal every plaintext row under an AAD the repository cannot open**, so the value then reads as `null`: silent loss of `users.metadata`. (2) The provider-token AAD `<providerId>:<userId>:<field>` does not bind the account: a token copied between two same-provider accounts of one user opens, against `packages/sql/README.md:194` ("a ciphertext cannot be moved between rows"). (3) No production caller of `sweepAll` exists, so a retired key can never be dropped safely for core rows nobody reads. All three were reproduced (§2.6) |
| Execution tickets | `.scratch/core-sealed-columns/issues/NN-*.md`, one per phase in §4 (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check them before editing. If plan 16 lands first it moves the code in `Repositories.ts` into the `*StoreSql` adapters, and §8 maps every location to its post-16 home.

---

## 1. Summary, goals, non-goals

### Summary

Plan 05 built **`SealedColumn`** (`packages/sql/src/SealedColumn.ts`) as the one module for a column stored as an `Encryption` envelope. It owns the AAD convention (`aadOf` = `<table>:<rowKey>:<column>`), lazy re-seal by compare-and-swap, the typed `Unreadable`, the sanctioned call-site treatments, and the operator's `sweep`/`sweepAll`. Seven plugin columns are declared on it. Core's six sealed columns are not:

- `users.metadata`, AAD `user:<id>:metadata`
- `sessions.ipAddress` and `sessions.userAgent`, AAD `session:<id>:<field>`
- `accounts.accessToken`, `accounts.refreshToken` and `accounts.idToken`, AAD `<providerId>:<userId>:<field>`

Plan 05 left them out on purpose (`.planning/05-plugin-table-substrate/PLAN.md:74-77`: "Moving core columns to declarations is plan 02's choice"). It only re-implemented core's `PiiCodec` over the low-level `SealedColumn.reveal` (plan 05 `:764`). Plan 02 kept "U-12 (lazy re-encryption on read) unchanged" (`.planning/02-domain-store-seam/PLAN.md:1374`) and never declared them. So core still has its own AAD spellings, a private `PiiCodec`, three hand-written compare-and-swap write-backs that duplicate `sqlSwap`/`codec`, a second re-seal switch (`AccountsRepositoryConfig.reencryptOnRead` beside `SealedColumnConfig.resealOnRead`), and three copies of "unreadable": `AccountTokenUndecryptable` (sql), `TokensRead.Undecryptable` (ports) and `null`-and-warn (sql). The substrate's `sweepAll` cannot reach them. The runbook tells operators to list them anyway, and doing so corrupts data (§2.6).

This plan makes the core columns ordinary declared `SealedColumn`s:

- Six declarations in a new `CoreSealedColumns` module, under the canonical AAD.
- The SQL adapters use `SealedColumn.codec`. The three write-backs, `PiiCodec`, `AccountTokenUndecryptable` and `AccountsRepositoryConfig` are deleted.
- The core store ports carry `Sealed<A>` values for the six columns (the type moves to `@awthaq/ports` as the `Sealed` module), so the treatment of an unreadable value is chosen in the domain where its meaning is known, not hidden in an adapter. Session PII and user metadata **degrade** (`Sealed.optional`: absent plus a warning, as today). Provider tokens **fail typed** (`ProviderTokensUnreadable`, re-consent, as today).
- `Persistence.sql(options)` provides `SealedColumn.Deployed`, the list of the columns that composition actually seals, built from the same `options`. `SealedColumn.sweepDeployed()` therefore covers core rows, and cannot sweep a PII column the composition stores in plaintext.

### Goals

1. One sealing implementation: no `Encryption.encrypt`/`decrypt` call, no AAD string and no compare-and-swap statement for a sealed column outside `SealedColumn.ts` (`grep` gate, §9).
2. One AAD convention for all thirteen sealed columns. The token AAD binds the account id (fixes bug 2).
3. One unreadable shape (`Sealed.Unreadable`) from store to domain; each domain call site picks its treatment.
4. Key retirement finishes for core rows: rotate, `sweepDeployed`, `resealed: 0`, drop the key, and every row still opens (phase 0 test).
5. Each core column is proven by the same `TestAuth.runSealedColumnTests` wiring suite as the plugin columns. `PiiEncryption.test.ts` and `AccountsTokenReadPath.test.ts` are replaced, not kept alongside.
6. One re-seal switch (`SealedColumnConfig.resealOnRead`).

### Non-goals

- Changing *what* is sealed. `email`, `phone`, `name`, `image` and `statusReason` stay plaintext (`packages/sql/README.md:196-198`). `encryptPii` stays opt-in, and provider tokens stay always-sealed.
- Sealing in the core `Ref` adapters. They stay plaintext and test-grade (TRBS-005) and hand out `Sealed.plain` (Q6).
- Making `SessionView.ipAddress`/`userAgent` lazy so `Sessions.verify` skips two decryptions on the hot path. The cost is unchanged by this plan (today's encrypted repository decrypts both on every read, `Repositories.ts:1487-1509`). It is a follow-up if wanted.
- Turning `encryptPii` **off** after it was on. Today a plaintext adapter would hand back the envelope text as the value. This is unchanged and stated as unsupported in §6.
- A CLI command (`awthaq sealed sweep`). Plan 05 phase 14 decided against it (ADR-EA-019 rev 1.2). Q5 revisits it.
- Folding `Repositories.ts` into the adapters, and deleting the stray `packages/sql/src/Repositories.ts-E`. Both belong to plan 16.

---

## 2. Verified current state

### 2.1 The substrate (`packages/sql/src/SealedColumn.ts`, 368 lines)

| Piece | Lines | What it is |
|---|---|---|
| `Column<A>`, `column(...)` | `:37-45`, `:72-80` | `{ table, column, key, schema, adoptPlaintext }`; identifiers validated (`InvalidDeclaration`, `:32-35`) |
| `Sweepable` | `:83` | a column without its schema; what `aadOf` and `sweep` need |
| `aadOf` | `:86-87` | `${table}:${rowKey}:${column}`. The doc comment says it "matches core's `<entity>:<id>:<field>` shape", but no core spelling equals it (`users` ≠ `user`, `sessions` ≠ `session`, and accounts have no row key) |
| `Unreadable` | `:89-94` | `Data.TaggedError("SealedColumn/Unreadable")`, `{ table, column, rowKey, reason }` |
| `Sealed<A>` | `:97-99` | `{ open: Effect<Redacted<A>, Unreadable> }` |
| `SealedColumnConfig` | `:102-105` | `Context.Reference`, `resealOnRead` (default `true`) |
| `Swap`, `sqlSwap` | `:108-121` | `UPDATE t SET c = fresh WHERE key = rowKey AND c = stored RETURNING key`. Not in a savepoint (§2.5 R-4) |
| `reveal` | `:140-170` | the low-level primitive, under one `aad` with optional `adoptPlaintext`. Core calls it directly (`Repositories.ts:105`, `:877`) |
| `codec` | `:179-244` | `{ seal, sealed }`: seal under `aadOf`, open, decode, re-seal by `swap`; a failed or lost swap is logged and never fails the read |
| `orDie`, `option` | `:258-264`, `:269-277` | the two sanctioned treatments |
| `sweep`, `sweepAll` | `:293-332`, `:345-368` | keyset-paged batch re-seal under `aadOf` only; one report and one Info line per column |

`grep -rn "sweepAll\|SealedColumn.sweep\b" packages examples features scripts` (excluding `node_modules`/`lib`) finds only `packages/sql/test/SealedColumn.test.ts:331-424`. **There is no production caller** (the claim is confirmed). The runbook (`docs/plugin-authoring.md:152-161`) is the only thing that tells anyone to run it.

### 2.2 The seven declared plugin columns

| Column | Declaration | Treatment (ADR-EA-019 table) |
|---|---|---|
| `webhooks_endpoint.secret` | `packages/webhooks/src/WebhookRecords.ts:49` | `option` |
| `webhooks_endpoint.previousSecret` | `WebhookRecords.ts:54` | `option` |
| `webhooks_endpoint.headers` | `WebhookRecords.ts:59` | `option` |
| `organization_oauth_connection.clientSecret` | `packages/organization/src/ConnectionRecords.ts:147` | `option` |
| `saml_sp_key.privateKey` | `packages/saml/src/SamlRecords.ts:116` | `orDie` |
| `jwt_signing_key.privateKeyJwk` | `packages/jwt/src/SigningKeyRecords.ts:72` | `orDie` |
| `two_factor_secret.secret` | `packages/two-factor/src/TwoFactorStore.ts:56` | `orDie` |

Each is exported as a constant, but nothing collects them. An operator has to assemble the `sweepAll` list by hand (Q4).

### 2.3 The six hand-sealed core columns (`packages/sql/src/Repositories.ts`, 2,552 lines)

**Shared PII codec (users and sessions):**

- `PiiCodec` (`:84-94`) and `sealedPii` (`:96-124`): `conceal` encrypts under a caller-supplied AAD. `reveal` runs `SealedColumn.reveal(…, { aad, adoptPlaintext: true })` and maps `DecryptionFailed`/`UnknownKeyId` to `{ plaintext: null }` with a warning (`:113-122`). There is no `Malformed` (no schema), and the warning carries no ids at all (no annotations, unlike `SealedColumn.option`).

**`users.metadata`:**

- `userMetadataAad` (`:247`) is `user:${id}:metadata`. `makeUsersRepository(pii)` is at `:277`.
- `concealMetadata` (`:321-325`) is used by `insert` (`:353`), `insertIfAbsent` (`:410`) and `updateProfile` (`:488`).
- `revealUser` (`:327-350`) runs on **every** returned row: `insert` (`:357`), `findById` (`:361`), `findByEmail` (`:379`), `findByPhone` (`:396`), `insertIfAbsent` (`:417`), `listPage` (`:448`), `updateProfile` (`:500`), `setStatus` (`:528`), `casIdentity` (`:584`). `insert` therefore decrypts the envelope it has just written.
- Hand-written compare-and-swap #1 (`:334-346`): `UPDATE users SET metadata = … WHERE id = … AND metadata = …`. It is gated by **`AccountsRepositoryConfig.reencryptOnRead`** (`:333`), the accounts switch, not `SealedColumnConfig`.
- Layers: `UsersRepositoryLive` (`:646-647`, plaintext) and `UsersRepositoryEncryptedLive` (`:656-665`).

**`sessions.ipAddress` and `sessions.userAgent`:**

- `sessionAad` (`:1440`) is `session:${id}:${field}`. `makeSessionsRepository(pii)` is at `:1442`.
- `concealPii` (`:1456-1467`) runs at insert only. The columns are immutable afterwards.
- `revealSession` (`:1487-1509`) runs on every returned row: `insert` (`:1522`), `findById` (`:1526`), `listByUser` (`:1590`), `touch` (`:1643`), `rotate`/`insertSuperseding` (`:1751`), `reauthenticate` (`:1826`).
- Hand-written compare-and-swap #2 (`writeBackSealed`, `:1469-1485`), gated by `AccountsRepositoryConfig` (`:1494`).
- Layers: `SessionsRepositoryLive` (`:1847-1848`) and `SessionsRepositoryEncryptedLive` (`:1858-1867`).

**`accounts.accessToken`, `accounts.refreshToken` and `accounts.idToken` (always sealed; `AccountsRepositoryLive`, `:837-1279`):**

- `tokenAad` (`:834-835`) is `${providerId}:${userId}:${field}`. **It has no account id and no table.**
- `encryptToken` (`:854-862`) is used by `insert` (`:966-989`), `insertIdentityIfAbsent` (`:1107-1147`) and `writeTokens` (`:1205-1247`).
- `readColumn` (`:871-898`) turns a failure into `AccountTokenUndecryptable` (`:787-798`). Tokens do **not** adopt plaintext (`:877`).
- `readColumnDegraded` (`:901-917`) turns a failure into `null` plus a warning.
- Hand-written compare-and-swap #3 (`persistRefreshed`, `:919-932`), three hand-spelled `UPDATE`s. `decryptRowWith` (`:934-960`) gates it on `AccountsRepositoryConfig` (`:939`).
- `AccountsRepositoryConfig` (`:800-814`), the second re-seal switch.
- Degraded reads: `findById` (`:991-992`), `listByUser` (`:1271-1275`), and `insert`'s return. Strict read: `findTokensById` (`:994-997`). **The degraded reads have no production caller.** `AccountStoreSql` uses the identity-only reads (`findIdentityById` `:1043`, `findIdentityByKey` `:1057`, `listIdentitiesByUser` `:1072`). `grep -rn "AccountsRepository" packages/*/src` outside `Repositories.ts` finds only `AccountStoreSql.ts`. The degraded path survives only in tests (`AccountsTokenReadPath.test.ts`, `contract.ts`).
- `writeTokens` runs **two** statements: `findAadQuery` (`:1001-1005`, `SELECT "providerId","userId"`) and then the `UPDATE`. This exists only because the AAD needs those two columns.

### 2.4 The ports, the adapters and the domain call sites

| Layer | Location | Today |
|---|---|---|
| `UserStore.StoredUser.metadata` | `packages/ports/src/UserStore.ts:41-42` | `Option<string>`. `NewUser = Omit<StoredUser, "tenantId">` (`:53`) |
| `SessionStore.SessionRecord.ipAddress/userAgent` | `packages/ports/src/SessionStore.ts:53-54`; `NewSession` `:78-80` | `Option<string>` |
| `AccountStore.TokensRead` | `packages/ports/src/AccountStore.ts:71-77`; `readProviderTokens` `:110-113` | `Tokens{ tokens: Option<ProviderTokens> } \| Undecryptable{ field, reason }`, a hand-rolled copy of `Unreadable` |
| `UserStoreSql.toStored` | `packages/sql/src/UserStoreSql.ts:35-52` | `Option.fromNullOr(row.metadata)`: an unreadable value has **already** become `None` in the repository |
| `SessionStoreSql.toRecord` | `packages/sql/src/SessionStoreSql.ts:55-65` | same |
| `AccountStoreSql.readProviderTokens` | `packages/sql/src/AccountStoreSql.ts:134-151` | `AccountTokenUndecryptable` → `TokensRead.Undecryptable` |
| Memory adapters | `UserStore.layerMemory` `:269`, `SessionStore.layerMemory` `:255`, `AccountStore.layerMemory` `:177` (`readProviderTokens` `:236-242`) | plaintext and never unreadable (TRBS-005). Plugin memory adapters **do** seal (`WebhookRecords.layerMemory` requires `Encryption`, plan 05 phase 4) |
| `Users.toUserRecord` | `packages/core/src/Users.ts:513-526` | copies `metadata` as is. It is already an `Effect` |
| `Sessions.toView` / `toItem` | `packages/core/src/Sessions.ts:630-644` / `:646-657` | pure. Eight call sites (`:744`, `:859`, `:868`, `:899`, `:910`, `:995`, `:1002`, `:1024`) |
| `Accounts.findProviderTokens` | `packages/core/src/Accounts.ts:337-350`; error `:96-100` | `Undecryptable` → `ProviderTokensUnreadable{ id, field, reason }` |
| `OAuthTokenAccess.withAccessToken` | `packages/oauth/src/OAuthTokenAccess.ts:175-188` | `ProviderTokensUnreadable` → `OAuthTokenUnavailable` ("the user must re-authorize"). `idToken` is passed through on refresh (`:233`) |
| Other readers of the PII | `DataExport.ts:141` (metadata), `:164`/`:171` (userAgent); `admin/src/Admin.ts:379` | read through the domain records, so they see `None` for an unreadable value |
| `Persistence.sql` | `packages/core/src/Persistence.ts:50-87` | picks the plaintext or encrypted repository by `encryptPii` |

### 2.5 Drift between the hand-rolled copies and the substrate

| # | Concern | Substrate (plugins) | Core today | Severity |
|---|---|---|---|---|
| D-1 | AAD | `<table>:<rowKey>:<column>` | three other spellings; tokens bind no row | **bug 2** |
| D-2 | Undecryptable value | typed `Unreadable`, the call site picks `orDie`/`option` | PII: `null` in the adapter, warning without ids. Tokens: typed on the strict path, `null` on the degraded one | policy hidden in adapter |
| D-3 | Re-seal switch | `SealedColumnConfig.resealOnRead` | `AccountsRepositoryConfig.reencryptOnRead`, for all six | two switches for one decision |
| D-4 | Compare-and-swap | `sqlSwap`, one place | three hand copies (`:339`, `:1476-1477`, `:921-924`) | duplication |
| D-5 | Failure logging | ids-only annotations (`table`, `column`, `rowKey`, `reason`) | PII warning has no ids; tokens log `accountId`/`field` | observability |
| D-6 | `Malformed` | decoded through the column schema | no schema | none (all are `Schema.String`) |
| D-7 | Sweep coverage | `sweep`/`sweepAll` | unreachable (D-1); nothing lists the columns | **bugs 1 and 3** |
| D-8 | Insert path | records hand back what they sealed | `insert` decrypts the envelope it just wrote (`:357`, `:988`, `:1522`) | wasted AES-GCM per insert |
| D-9 | `writeTokens` | one statement | two (`findAadQuery` + `UPDATE`) | one extra read per token refresh |

**R-4 (substrate, affects plugins too):** `persist` (`SealedColumn.ts:198-212`) catches a failed swap and lets the read succeed. On Postgres, a failed statement inside a transaction aborts it (SQLSTATE 25P02). A failed re-seal `UPDATE` inside a caller's transaction, for example a request under `TenantScope.withTenant`, which wraps the request in one, would leave the read "successful" and the next statement failing with `StoreUnavailable` misattributed. The core copies have the same flaw (`:341`, `:1480`, `:927`). Once core runs on the substrate, `Sessions.verify` does this on the hottest path. Phase 1 runs `sqlSwap`'s `UPDATE` under `SqlTransaction.transactional(sql)`, which is a savepoint when nested. This needs a pg-only test, because SQLite does not abort.

### 2.6 Live bugs, reproduced

All three were run as a throwaway vitest file in the scratchpad (not the repo), over the real `Repositories.ts` and `SealedColumn.ts` at `fc990c88`, on SQLite with `contract.ts`'s `EncryptionLive`.

**Bug 1. The runbook corrupts core metadata.** An operator follows `docs/plugin-authoring.md:156` ("each plugin's declarations, plus the core token and PII columns your composition enables") and declares `users.metadata`:

```ts
// encrypted repository: row A sealed (AAD user:<a>:metadata); plaintext repository: row B, metadata '{"b":2}'
const column = { table: "users", column: "metadata", key: "id", adoptPlaintext: true };
yield* SealedColumn.sweep(column);
// observed: { scanned: 2, resealed: 1, unreadable: 1 }
//   A (healthy) counted unreadable: sweep tried AAD users:<a>:metadata
//   B adopted and sealed under users:<b>:metadata
(yield* encryptedUsers.findById(b)).metadata; // observed: null (+ "undecryptable; reading it as null")
```

The plaintext value is now sealed under an AAD the repository never tries, so it is gone from every read. The sweep's own report hides this, because it counts B as `resealed`. Sessions behave the same way. For tokens there is no `key` column that reproduces `<providerId>:<userId>`, so any declaration reports every token `unreadable`. That report is harmless but makes "`resealed: 0`, drop the key" impossible to reach.

**Bug 2. A token moved between a user's two same-provider accounts opens:**

```ts
const a = yield* accounts.insert({ userId, providerId: "github", subject: "one", accessToken: "access-one", … });
const b = yield* accounts.insert({ userId, providerId: "github", subject: "two", accessToken: "access-two", … });
yield* sql`UPDATE accounts SET "accessToken" = ${stored(a)} WHERE id = ${b.id}`;
(yield* accounts.findTokensById(b.id)).accessToken; // observed: "access-one" (no DecryptionFailed)
```

Both rows share the AAD `github:<userId>:accessToken`. `(providerId, subject, issuer)` is the unique key (BEH-EA-125), so one user can link two GitHub identities. The impact is limited to one user's own tokens, but it contradicts `packages/sql/README.md:194`, BEH-EA-034 (`spec/behaviors/05-persistence-stratum.md:61`, "AES-GCM ciphertext bound to the row and column") and the ticket-18 comment at `Repositories.ts:828-832`.

**Bug 3. Key retirement cannot finish for core rows.** ADR-EA-019 decision 2(b) is "wait until nothing references the old kid". For a session or metadata row that is never read again, the only way to learn that is a sweep, and bug 1 shows the sweep cannot be pointed at core columns. Dropping the key then turns those rows `UnknownKeyId`, which reads as `null` (PII) or fails as `ProviderTokensUnreadable` (re-consent for every dormant linked account).

### 2.7 Claims in the candidate description, re-checked

- "An undecryptable core value reads as `null`": **only half right.** PII does, and so do the degraded token reads (test-only). The strict token path, the only production one, is already typed end to end (`TokensRead.Undecryptable` → `ProviderTokensUnreadable` → `OAuthTokenUnavailable`).
- "`makeUsersRepository(pii)` ~277, `makeSessionsRepository(pii)` ~1442, `tokenAad` ~876": `tokenAad` is defined at `:834`. `:876` is its use in `readColumn`. The rest is confirmed.
- "Plugins declare 7 sealed columns": confirmed (§2.2).
- "`sweepAll` has no production caller": confirmed (§2.1).
- "Plan 05 left this to plan 02, and plan 02 didn't do it": confirmed (§1).
- `Retention` (`packages/core/src/Retention.ts`) only deletes expired rows and never reads a sealed value. `KeyProvider` (`packages/ports/src/KeyProvider.ts:68-70`, `layerEnv` keyset `:111-188`) needs no change. The CLI (`packages/cli/src/Cli.ts`) has `config`, `plugin`, `routes`, `migration`, `seed`, `login`/`logout`/`whoami` and no re-seal command, as ADR-EA-019 rev 1.2 decided.
- What "existing data" means: `git tag` is empty, all 29 packages are `0.1.0`, and the examples are private. ADR-EA-034 decision 2 allows breaks before 1.0, and ADR-EA-019 rev 1.2 used exactly this to drop the plugin legacy spellings with no migration (Q1).

---

## 3. Target design

### 3.1 `Sealed` moves to `@awthaq/ports` (new `packages/ports/src/Sealed.ts`)

The core ports have to carry the sealed values, and ports cannot import `@awthaq/sql`. So the value type, its error and the treatments move down one layer. `SealedColumn` re-exports them, so plugin code that uses `SealedColumn.Sealed`, `SealedColumn.Unreadable`, `SealedColumn.orDie` and `SealedColumn.option` compiles unchanged. There is one class, and its tag stays `"SealedColumn/Unreadable"`.

```ts
// @awthaq/ports — Sealed
// ADR-EA-019 decision 6: a value an adapter stores sealed, handed to domain code unopened.

export class Unreadable extends Data.TaggedError("SealedColumn/Unreadable")<{
  readonly table: string;
  readonly column: string;
  readonly rowKey: string;
  readonly reason: "DecryptionFailed" | "UnknownKeyId" | "Malformed";
}> {}

export interface Sealed<A> {
  readonly open: Effect.Effect<Redacted.Redacted<A>, Unreadable>;
}

/** A value its adapter holds in plaintext (a `Ref` store, `encryptPii: false`): it always opens. */
export const plain = <A>(value: A) => ({ open: Effect.succeed(Redacted.make(value)) });

/** `None` stays `None`; a present value is opened (fails `Unreadable`). */
export const openOption = <A>(value: Option.Option<Sealed<A>>) =>
  Option.match(value, {
    onNone: () => Effect.succeedNone,
    onSome: (sealed) => Effect.map(sealed.open, Option.some),
  });

export const orDie = /* moved verbatim from SealedColumn.ts:258-264 */;
export const option = /* moved verbatim from SealedColumn.ts:269-277 */;

/** `option` over an optional column: absent, or unreadable (one ids-only warning), are both `None`. */
export const optional = <A>(value: Option.Option<Sealed<A>>) =>
  Effect.map(option(openOption(value)), Option.flatten);
```

`packages/ports/src/index.ts` adds `export * as Sealed from "./Sealed.ts"`. In `SealedColumn.ts`, the definitions at `:89-99` and `:246-277` are replaced by re-exports of `Sealed.Unreadable`, `Sealed.Sealed`, `Sealed.orDie` and `Sealed.option`. `codec` and `sweep` keep using them.

### 3.2 The six declarations (new `packages/sql/src/CoreSealedColumns.ts`)

```ts
// @awthaq/sql — CoreSealedColumns
// Plan 17 (ADR-EA-019 rev 1.3): core's sealed columns, declared once like every plugin column.

/** CSG-006: sealed only when the composition opts in (`Persistence.sql({ encryptPii: true })`). */
export const usersMetadata = SealedColumn.column({
  table: "users",
  column: "metadata",
  key: "id",
  adoptPlaintext: true,
});
export const sessionsIpAddress = SealedColumn.column({
  table: "sessions",
  column: "ipAddress",
  key: "id",
  adoptPlaintext: true,
});
export const sessionsUserAgent = SealedColumn.column({
  table: "sessions",
  column: "userAgent",
  key: "id",
  adoptPlaintext: true,
});

/** SMS-002: always sealed. Bound to the account row, so a token cannot move between a user's accounts. */
export const accountsAccessToken = SealedColumn.column({
  table: "accounts",
  column: "accessToken",
  key: "id",
});
export const accountsRefreshToken = SealedColumn.column({
  table: "accounts",
  column: "refreshToken",
  key: "id",
});
export const accountsIdToken = SealedColumn.column({ table: "accounts", column: "idToken", key: "id" });

export const providerTokens: ReadonlyArray<SealedColumn.Sweepable> = [
  accountsAccessToken,
  accountsRefreshToken,
  accountsIdToken,
];
export const personalData: ReadonlyArray<SealedColumn.Sweepable> = [
  usersMetadata,
  sessionsIpAddress,
  sessionsUserAgent,
];

/** The columns a `Persistence.sql(options)` composition seals. Plaintext PII is never listed: sweeping it would seal it behind a plaintext adapter. */
export const deployed = (options: { readonly encryptPii: boolean }) =>
  options.encryptPii ? [...providerTokens, ...personalData] : providerTokens;
```

The resulting AADs are `users:<id>:metadata`, `sessions:<id>:ipAddress`, `sessions:<id>:userAgent` and `accounts:<id>:<field>`. `SealedColumn.ts:85-87`'s doc comment loses its "matches core's" clause and says instead that core runs on the same convention.

### 3.3 The deployed-column list and `sweepDeployed` (`SealedColumn.ts`)

```ts
/** Every sealed column a composition writes, as its persistence bundle declares them. */
export class Deployed extends Context.Service<
  Deployed,
  { readonly columns: ReadonlyArray<Sweepable> }
>()("awthaq/sql/SealedColumn/Deployed") {}

/**
 * The operator's whole-deployment pass after a key rotation: the bundle's columns, plus `also`
 * (plugin columns, Q4), deduplicated by `table.column`. Never run inside `TenantScope.withTenant`.
 */
export const sweepDeployed = (options?: {
  readonly batch?: number;
  readonly also?: ReadonlyArray<Sweepable>;
}) =>
  Effect.flatMap(Deployed, ({ columns }) =>
    sweepAll(uniqueColumns([...columns, ...(options?.also ?? [])]), options),
  );
```

`Persistence.sql` (`packages/core/src/Persistence.ts:69-87`) builds the list from the same `options` it uses to choose the repositories, so the two cannot disagree:

```ts
export const sql = (options?: SqlOptions) => {
  const encryptPii = options?.encryptPii === true;
  return Layer.mergeAll(
    UserStoreSql.layer,
    AccountStoreSql.layer,
    SessionStoreSql.layer,
    VerificationStoreSql.layer,
    AuditLogStoreSql.layer,
    SqlTransaction.layerSql,
    Layer.succeed(SealedColumn.Deployed, { columns: CoreSealedColumns.deployed({ encryptPii }) }),
  ).pipe(Layer.provide(/* the repositories, chosen by encryptPii as today */));
};
```

`SqlRequirements` is unchanged. `Persistence.memory` provides no `Deployed`: nothing there is sealed, so a `sweepDeployed` against a memory composition is a compile error (missing `Deployed`), not a silent no-op.

Why a service and not a `Persistence.sealedColumns(options)` function: a function called with different options than `sql(...)` would reproduce bug 1. The service is built from the one options value (type-system first).

### 3.4 The ports carry `Sealed` for the six columns

```ts
// UserStore.ts
export interface StoredUser {
  // …
  /** CSG-006: sealed by the adapter where it encrypts; `Sealed.plain` where it does not. */
  readonly metadata: Option.Option<Sealed.Sealed<string>>;
}
/** What `insertOrHolder` writes: the plaintext, which the store seals where it encrypts. */
export interface NewUser extends Omit<StoredUser, "tenantId" | "metadata"> {
  readonly metadata: Option.Option<string>;
}

// SessionStore.ts
export interface SessionRecord {
  // …
  readonly ipAddress: Option.Option<Sealed.Sealed<string>>;
  readonly userAgent: Option.Option<Sealed.Sealed<string>>;
}
// NewSession keeps plaintext `Option<string>` for both.

// AccountStore.ts
/** BE-002: the stored token set, unopened. `readProviderTokens` is still the one path that carries it. */
export interface SealedProviderTokens
  extends Omit<ProviderTokens, "accessToken" | "refreshToken" | "idToken"> {
  readonly accessToken: Sealed.Sealed<string>;
  readonly refreshToken: Option.Option<Sealed.Sealed<string>>;
  readonly idToken: Option.Option<Sealed.Sealed<string>>;
}
/** Outer `None` = no such account; inner `None` = the account holds no tokens. Opening may re-seal a stale envelope. */
readonly readProviderTokens: (
  id: AccountId,
) => Effect.Effect<Option.Option<Option.Option<SealedProviderTokens>>, StoreUnavailable>;
```

`TokensRead` is deleted. The write sides (`NewAccount.tokens`, `writeProviderTokens`) stay plaintext `ProviderTokens`. Each `Ref` adapter wraps its plaintext in `Sealed.plain` on the way out (`UserStore.ts:~290-320`, `SessionStore.ts:~275-285`, `AccountStore.ts:236-242`).

Why the port carries `Sealed` instead of the SQL adapter applying `option` and the port staying plaintext (Q2):

1. **Locality.** The meaning of an unreadable value belongs to the domain. "Absent for display" (session PII) and "re-consent" (tokens) are domain decisions. Today the PII decision is made in the adapter, where the domain cannot see it, and the token decision is a hand-written union.
2. **One shape** replaces three (`AccountTokenUndecryptable`, `TokensRead.Undecryptable`, `null`).
3. **The wiring suite fits as is.** `runSealedColumnTests`' `read` returns a `Sealed<A>` (`packages/test/src/SealedConformance.ts:62-64`), which a port read now does. Core runs the very suite the plugins run (§5.1).
4. Identity reads still never open anything (`AccountStore.get` and friends return no tokens), and `Users`/`Sessions` open only where they build a domain record.

### 3.5 The domain treatments

| Column | Call site | Treatment | Behaviour vs today |
|---|---|---|---|
| `users.metadata` | `Users.toUserRecord` (`Users.ts:513`) | `Sealed.optional` → `UserRecord.metadata: Option<string>` | same (absent plus warning), and the warning now carries ids |
| `sessions.ipAddress` / `userAgent` | `Sessions.toView` (`:630`), `toItem` (`:646`) | `Sealed.optional` | same. `toView`/`toItem` become effects (eight call sites) |
| the three tokens | `Accounts.findProviderTokens` (`Accounts.ts:337`) | open all three; `Unreadable` → `ProviderTokensUnreadable` (typed, re-consent) | same (any one unreadable token fails the read, Q3). `reason` widens to include `Malformed` |

```ts
// Users.ts
const toUserRecord = (user: UserStore.StoredUser) =>
  Effect.all({ identity: toIdentity(user), metadata: Sealed.optional(user.metadata) }).pipe(
    Effect.map(({ identity, metadata }) => ({
      id: UserId(user.id),
      identity,
      name: user.name,
      metadata: Option.map(metadata, Redacted.value),
      // … unchanged fields
    })),
  );

// Accounts.ts
const openToken = (id: AccountId, field: ProviderTokenField, sealed: Sealed.Sealed<string>) =>
  sealed.open.pipe(
    Effect.mapError(
      (unreadable) => new ProviderTokensUnreadable({ id, field, reason: unreadable.reason }),
    ),
  );
const openOptionalToken = (
  id: AccountId,
  field: ProviderTokenField,
  sealed: Option.Option<Sealed.Sealed<string>>,
) =>
  Option.match(sealed, {
    onNone: () => Effect.succeedNone,
    onSome: (value) => Effect.map(openToken(id, field, value), Option.some),
  });

const findProviderTokens: AccountsShape["findProviderTokens"] = Effect.fnUntraced(function* (id) {
  const read = yield* store.readProviderTokens(id);
  if (Option.isNone(read)) return yield* notFound(id);
  if (Option.isNone(read.value)) return Option.none();
  const sealed = read.value.value;
  const opened = yield* Effect.all({
    accessToken: openToken(id, "accessToken", sealed.accessToken),
    refreshToken: openOptionalToken(id, "refreshToken", sealed.refreshToken),
    idToken: openOptionalToken(id, "idToken", sealed.idToken),
  });
  return Option.some({ ...sealed, ...opened });
}, relabel("Accounts.findProviderTokens"));
```

`ProviderTokenField` is the existing literal union of `ProviderTokensUnreadable.field` (`Accounts.ts:98`), extracted as a type. The field is passed as a literal, so nothing is narrowed with `as`. ADR-EA-019 decision 6's "exactly one of two treatments" is amended (§6.2) to allow a third: **map it to the domain's own typed failure** (this call site). `orDie` would be wrong here (a defect for an outage of trust in one row), and so would `option` (a silent "no tokens").

### 3.6 The SQL adapters over `codec`

Each sealed repository builds one `SealedColumn.codec` per column at layer build. The plaintext variants build none, and hand out `Sealed.plain`. Rows leave the repository **as stored**. The repository exposes how to read their sealed cells, and the store adapter calls that in `toStored`/`toRecord`:

```ts
// Repositories.ts (users) — PiiCodec, sealedPii, userMetadataAad and revealUser are deleted
type MetadataCodec = Effect.Success<ReturnType<typeof SealedColumn.codec<string>>>;

const metadataCodec = Effect.flatMap(SealedColumn.sqlSwap(CoreSealedColumns.usersMetadata), (swap) =>
  SealedColumn.codec(CoreSealedColumns.usersMetadata, swap),
);

const makeUsersRepository = (codec: Option.Option<MetadataCodec>) =>
  Effect.gen(function* () {
    // … as today, minus revealUser on every return …
    const sealMetadata = (id: string, metadata: string | null) =>
      metadata === null
        ? Effect.succeed(null)
        : Option.match(codec, {
            onNone: () => Effect.succeed(metadata),
            onSome: (c) => c.seal(id, Redacted.make(metadata)),
          });
    /** The stored cell as a `Sealed`: the column codec when sealing, `Sealed.plain` otherwise. */
    const metadataOf = (row: User) =>
      Option.map(Option.fromNullOr(row.metadata), (stored) =>
        Option.match(codec, {
          onNone: () => Sealed.plain(stored),
          onSome: (c) => c.sealed(row.id, stored),
        }),
      );
    return { /* …, */ metadataOf };
  });

export const UsersRepositoryEncryptedLive: Layer.Layer<
  UsersRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  UsersRepository,
  Effect.flatMap(metadataCodec, (codec) => makeUsersRepository(Option.some(codec))),
);
```

- If `Effect.Success<…>` is not the rc.116 spelling, name the codec type with a module-private `interface` of `{ seal, sealed }`. That is a declaration, not an assertion. The existing explicit `Layer.Layer<…>` annotations on the exported layers stay. They predate this plan and are the TS2883 exception.
- `UserStoreSql.toStored` (`UserStoreSql.ts:35`) becomes `toStored(repo)(row)`, with `metadata: repo.metadataOf(row)`. `insertOrHolder` returns the inserted user with `Sealed.plain(input.metadata)` rather than reopening what it just sealed (D-8). The holder it lost to comes from storage and goes through `metadataOf`.
- Sessions follow the same pattern: two codecs (`sessionsIpAddress`, `sessionsUserAgent`), `piiOf(row) => { ipAddress, userAgent }`, and `insert` hands back `Sealed.plain` for what it wrote.
- Accounts: three codecs, always built (`AccountsRepositoryLive` already requires `Encryption`). `encryptToken(field, id, value)` becomes `codecs[field].seal(id, …)`. `insertIdentityIfAbsent` seals under the new id. `writeTokens` drops `findAadQuery` (`:1001-1005`, `:1206-1210`) and is one `UPDATE … RETURNING id` (D-9). `findTokensById` becomes `findSealedTokensById: (id) => Effect<Option<SealedTokenRow>, RepositoryError>`, which selects the token group as stored and wraps each non-null cell with `codecs[field].sealed(id, stored)`. `readColumn`, `readColumnDegraded`, `persistRefreshed`, `decryptRowWith`, `AccountTokenUndecryptable`, `AccountsRepositoryConfig` and the degraded `insert`/`findById`/`listByUser` are deleted. Their only callers are tests (§2.3), which §5.3 moves.
- `AccountStoreSql.readProviderTokens` maps `Option<SealedTokenRow>` to `Option<Option<SealedProviderTokens>>`. Its `catchTags({ AccountTokenUndecryptable })` (`:141-147`) is gone, because the read can no longer fail that way.

### 3.7 `sqlSwap` in a savepoint (R-4)

```ts
export const sqlSwap = (declared: Pick<Sweepable, "table" | "column" | "key">) =>
  Effect.map(
    SqlClient.SqlClient,
    (sql): Swap =>
      (rowKey, stored, fresh) =>
        SqlTransaction.transactional(sql)(
          sql`UPDATE ${sql(declared.table)} SET ${sql(declared.column)} = ${fresh}
            WHERE ${sql(declared.key)} = ${rowKey} AND ${sql(declared.column)} = ${stored}
            RETURNING ${sql(declared.key)}`,
        ).pipe(Effect.map((rows) => rows.length > 0)),
  );
```

Inside a transaction this is a savepoint, so a failed re-seal rolls back only itself and the enclosing transaction stays usable. Outside one it is a one-statement transaction. `check:transactions` already requires `transactional` rather than a bare `withTransaction` (plan 05 decisions, phase 1). The `(sql): Swap =>` annotation is today's code. The cost is one `SAVEPOINT`/`RELEASE` pair, paid only on a stale read.

### 3.8 Existing rows under today's core spellings: two designs (Q1)

The canonical AAD differs from all three core spellings, so a row sealed before this plan does not open after it.

**Design A: a per-column AAD hook** (`column({ …, aad?: (rowKey, row) => string })`). The substrate would keep each column's historical spelling permanently.

- Rejected. It brings back the per-column spellings ADR-EA-019 rev 1.2 deleted, so "one convention" holds only by convention.
- `aadOf`, `runSealedColumnTests`' rotation check (`SealedConformance.ts:162-165`), `sweep` and every future tool would have to thread the hook.
- For tokens, it would need the row's `providerId`/`userId` inside `sweep` (a wider select per column), and it **keeps bug 2**.
- Type-system first argues against it: a hook is an escape hatch the compiler cannot police.

**Design B: a one-time re-key** (`SealedColumn.rekey`). This is an operator effect that pages a column like `sweep` does. It opens each value under its *previous* AAD, and writes it back under `aadOf` by the same compare-and-swap. There is no permanent read path.

```ts
/** One-shot: re-seal every value of `declared` from a previous AAD to the canonical one. Idempotent. */
export const rekey = <F extends Schema.Struct.Fields>(
  declared: Sweepable,
  previous: {
    /** The extra columns the old AAD was built from (e.g. `providerId`, `userId`). */
    readonly fields: F;
    readonly aad: (row: Schema.Struct<F>["Type"], rowKey: string) => string;
  },
  options?: { readonly batch?: number },
) => Effect.gen(function* () {
  // SELECT key, column, ...fields WHERE column IS NOT NULL, keyset-paged by key (as `sweep`),
  // decoded with Schema.Struct(previous.fields) (a defect on a decode failure: a schema bug).
  // Per row: reveal under aadOf → already canonical (count `current`);
  //          else reveal under previous.aad(row, rowKey) → seal under aadOf, swap (count `rekeyed`);
  //          else count `unreadable` (never touched).
  // Answers { scanned, rekeyed, current, unreadable }.
});
```

The core mapping would ship beside it as `CoreSealedColumns.previousAad`, three entries: metadata `user:<id>:metadata`; ip/UA `session:<id>:<field>`; tokens `<providerId>:<userId>:<field>` with `fields: { providerId: Schema.String, userId: Schema.String }`. That mapping gets a deletion ticket, the way plan 05 phase 14 handled the plugin spellings.

**Recommendation: B's shape over A, and by default ship neither (Q1).** The release state is what ADR-EA-019 rev 1.2 relied on for the plugin spellings: no tags, everything at 0.1.0, no published consumer, private examples. Rows sealed under the old core spellings exist only in internal pre-release environments, and the plan has no named one. In such an environment the losses are:

- every linked account's tokens become unreadable, which means re-consent through the existing `OAuthTokenUnavailable` path, and the next sign-in heals the row (`writeTokens` never reads the old value);
- the IP and user agent of live sessions, which only affects display;
- `users.metadata`, but only where `encryptPii` was on. This is real data loss.

If the maintainer names such an environment, phase 2b (§4) adds `rekey` and the mapping exactly as sketched. That is the richer option, with a real caller.

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, plus `pnpm test:pg`, because SQL adapters change in every phase. The plan gate is `pnpm check && pnpm test:pg`. Line numbers are those of §2. When a phase says "the users SQL adapter", that means `makeUsersRepository` in `Repositories.ts` today, or `UserStoreSql.ts` after plan 16 (§8).

### Phase 0: pin the bugs (failing tests, committed as `it.effect.fails`)

New file `packages/sql/test/CoreSealedColumns.test.ts`, built on `TestSql.layer("sql_CoreSealedColumns")` so it also runs on Postgres. Add it to `scripts/test-pg.sh`. Keys come from `packages/sql/test/support/RotatingKeys.ts` (rotate and retire). Each test is `it.effect.fails`, so the tree stays green, and the phase that fixes it flips it to `it.effect`.

1. `runbook: a sweep over users.metadata re-seals a stale row and counts no healthy row unreadable`. Seal under `k1` through the encrypted users store, rotate to `k2`, `sweep` a hand-declared `{ table: "users", column: "metadata", key: "id", adoptPlaintext: true }`, and expect `{ resealed: 1, unreadable: 0 }`. Fixed in phase 2.
2. `runbook: a sweep never makes a plaintext metadata value unreadable to the store`. Write the value plaintext, sweep the same declaration, read it through the encrypted users store, and expect the original value. Fixed in phase 2.
3. `a token moved to another account of the same user and provider does not open`. Two `github` accounts for one user, copy `accessToken` across, `findTokensById`, and expect `AccountTokenUndecryptable`. This becomes the port-level assertion in phase 3, which fixes it.
4. `key retirement: after rotating and sweeping every deployed column, the retired key can be dropped and every core value still opens`. Seal metadata, session PII and tokens under `k1`, rotate to `k2`, sweep, retire `k1`, then read all six through the stores. Phase 0 sweeps hand-declared columns (it fails, per bug 1). Phase 4 rewrites it to `SealedColumn.sweepDeployed()` under `Persistence.sql({ encryptPii: true })` and flips it.

Files: the test file, `scripts/test-pg.sh`. Tickets: `.scratch/core-sealed-columns/issues/00-pin-bugs.md`.

### Phase 1: substrate (additive)

1. `packages/ports/src/Sealed.ts` (new, §3.1) and `packages/ports/src/index.ts` (export). `@awthaq/ports` already depends on `effect` only, so there is no new dependency.
2. `packages/sql/src/SealedColumn.ts`:
   - Re-export `Unreadable`, `Sealed`, `orDie` and `option` from ports, and delete the local definitions (`:89-99`, `:246-277`).
   - Add `Deployed` and `sweepDeployed` (§3.3), and a module-private `uniqueColumns`.
   - Change `sqlSwap` (§3.7).
   - Header comment: name core columns and `Deployed`.
3. `packages/sql/src/CoreSealedColumns.ts` (new, §3.2), exported from `packages/sql/src/index.ts`. Not used yet.
4. Tests in `packages/sql/test/SealedColumn.test.ts`: `sweepDeployed` covers `Deployed` plus `also`, and sweeps a column listed twice once; `Sealed.plain` opens and never re-seals; pg-only, a failed re-seal inside an outer transaction leaves that transaction usable (inject with `TestSql.injectFailure({ table, event: "UPDATE" })` and assert a later statement in the same transaction commits). Add `packages/ports/test/Sealed.test.ts` for `optional` (absent, readable, unreadable with one warning).
5. `.changeset/sealed-port.md` (§6.4).

### Phase 2: users and session PII on the codec

1. `packages/ports/src/UserStore.ts` and `SessionStore.ts`: the shapes of §3.4. `layerMemory` wraps reads with `Sealed.plain`.
2. Users and sessions SQL adapters (`Repositories.ts`):
   - Delete `PiiCodec` and `sealedPii` (`:74-124`), `userMetadataAad` (`:247`), `revealUser` (`:327-350`) with its compare-and-swap, `sessionAad` (`:1440`), `writeBackSealed` (`:1469-1485`) and `revealSession` (`:1487-1509`).
   - Add the codecs, `metadataOf` and `piiOf` (§3.6).
   - Repository methods return rows as stored. Every `Effect.flatMap(revealUser)` and `Effect.flatMap(revealSession)` listed in §2.3 goes.
   - `ReadRouting.test.ts` (`packages/test/test/ReadRouting.test.ts:93-227`) uses `SessionsRepository` directly. Its assertions read ids and liveness, not PII, so check it compiles.
3. `UserStoreSql.ts` and `SessionStoreSql.ts`: `toStored`/`toRecord` take the repository's `metadataOf`/`piiOf`, and `insert`/`insertOrHolder` return `Sealed.plain` for the values they wrote.
4. `packages/core/src/Users.ts:513` and `Sessions.ts:630-657`: the §3.5 treatments. `toView` and `toItem` become effects at their eight call sites.
5. `AccountsRepositoryConfig` stays for this phase, because tokens still read it.
6. Flip phase 0 tests 1 and 2.
7. Tests: §5.1 (three `runSealedColumnTests` calls), §5.3 (delete `PiiEncryption.test.ts`, `UserStoreSql.test.ts:77`), and `StoreContract` cases comparing `StoredUser`/`SessionRecord` values open the PII first (`packages/test/src/StoreContract.ts`).
8. `.changeset/core-sealed-pii.md`.

### Phase 2b (only if Q1 = "ship a re-key"): `SealedColumn.rekey`

`rekey` and `CoreSealedColumns.previousAad` (§3.8). Tests in `SealedColumn.test.ts`:

- rekeys a value from a previous AAD;
- a second run rekeys nothing (counted as `current`);
- an unreadable value is counted and untouched;
- a value written concurrently under the canonical AAD wins the compare-and-swap.

Add one core case per column family in `CoreSealedColumns.test.ts`, plus a deletion ticket `.scratch/core-sealed-columns/issues/NN-previous-aad-sunset.md` with the plan 05 phase 14 criteria. Runbook step 0 in `docs/plugin-authoring.md`.

### Phase 3: provider tokens on the codec

1. `packages/ports/src/AccountStore.ts`:
   - Add `SealedProviderTokens` and the new `readProviderTokens` type (§3.4), and delete `TokensRead`.
   - `layerMemory` returns `Sealed.plain` tokens.
   - Rewrite the header comment (`:9-16`).
2. Accounts SQL adapter (`Repositories.ts:787-1279`):
   - Add the three codecs and `findSealedTokensById`, and switch `encryptToken` to the codecs.
   - Make `writeTokens` a single statement.
   - Delete `TokenField`'s companions `AccountTokenUndecryptable` (`:789-798`), `readColumn`/`readColumnDegraded`/`persistRefreshed`/`decryptRowWith` (`:864-964`), `findAadQuery` (`:999-1005`), the degraded `insert`/`findById`/`listByUser` and their shape members (`:672-694`), and `tokenAad` (`:821-835`, including the ticket-18 comment, which now lives on the declaration).
   - Confirm by `grep -rn "AccountsRepository" packages/*/src` that only `AccountStoreSql.ts` calls the repository.
3. `packages/sql/src/AccountStoreSql.ts:134-151`: map the sealed row and drop `catchTags`.
4. `packages/core/src/Accounts.ts`: §3.5. Widen `ProviderTokensUnreadable.reason` to `Sealed.Unreadable["reason"]`. `OAuthTokenAccess.ts` is unchanged (it maps the same error).
5. Delete `AccountsRepositoryConfig` (`:800-814`). Every reader is gone, and `SealedColumnConfig.resealOnRead` is the one switch.
6. Flip phase 0 test 3, rewritten at the port: `store.readProviderTokens(b)` opens `accessToken` to `Unreadable("DecryptionFailed")`.
7. Tests: §5.1 (three token columns), §5.3 (delete `AccountsTokenReadPath.test.ts`; rewrite `AccountStoreSql.test.ts:137-200`, `contract.ts:288-330` and `core/test/Accounts.test.ts:527-560`).
8. `.changeset/core-sealed-tokens.md`.

### Phase 4: the deployed list, the runbook, the docs

1. `packages/core/src/Persistence.ts`: provide `SealedColumn.Deployed` (§3.3), and rewrite the `SqlOptions.encryptPii` doc (`:52-58`) with the new AAD and "swept by `SealedColumn.sweepDeployed`".
2. Flip phase 0 test 4 using `sweepDeployed()` under `Persistence.sql({ encryptPii: true })`. Add a case under `Persistence.sql()` (PII off) whose sweep list has the three token columns only.
3. `docs/plugin-authoring.md:152-161`. The runbook becomes:
   1. After rotating, run `SealedColumn.sweepDeployed({ also: [/* plugin columns */] })` with the production `Persistence.sql(...)` layer. After phase 5 this is `also: auth.sealedColumns`.
   2. Read the reports.
   3. Repeat until `resealed: 0`.
   4. Drop the key.

   Delete "plus the core token and PII columns your composition enables" (the cause of bug 1). Add one line: never run it inside `TenantScope.withTenant`, because RLS would hide rows from the sweep.
4. `packages/sql/README.md:188-209`:
   - The table row for tokens becomes AAD `accounts:<id>:<field>`, and adds `idToken`, which is missing today.
   - The PII row names `Persistence.sql({ encryptPii: true })` instead of swapping repository layers by hand.
   - `AccountsRepositoryConfig.reencryptOnRead` becomes `SealedColumnConfig.resealOnRead`.
   - "Reads as `null`" becomes "is `SealedColumn/Unreadable`; core degrades session PII and metadata with a warning and fails a token read with `ProviderTokensUnreadable`".
   - Add one line: turning `encryptPii` off after it was on is unsupported.
5. `.scratch/plugin-table-substrate/issues/16-adopt-plaintext-sunset.md`: tick "Decide whether the adopting columns are swept by `sweepAll` today". The answer is yes, through `Deployed`, when `encryptPii` is on. The `plaintext` count stays open.
6. Spec, ADR and traceability edits (§6).

### Phase 5 (Q4, recommended): plugins declare their sealed columns

1. `packages/core/src/AuthPlugin.ts`:
   - `AuthPlugin.Service` gains an optional `sealedColumns: ReadonlyArray<SealedColumn.Sweepable>`, structural, so core needs no `@awthaq/sql` import (the same trick as `AuthPlugin.Table.*`, plan 05 phase 3).
   - `Auth.make` validates that each `table` is one of the plugin's own declared `tables`, and that no `table.column` is declared twice. It exposes `auth.sealedColumns`.
2. The seven plugins list their exported constants (§2.2).
3. `docs/plugin-authoring.md` gets a checklist item: a sealed column is declared on the plugin as well as in its records.
4. The runbook's `also` becomes `auth.sealedColumns`.
5. A BDD type-gate is optional (a column on a table the plugin does not own).

---

## 5. Test plan

The rule is **replace, don't layer**. The mechanism is proven once, in `SealedColumn.test.ts`. Each column's wiring is proven by `runSealedColumnTests`. The domain treatments are proven by domain tests over store doubles.

### 5.1 New: the core columns through the wiring suite (`packages/sql/test/CoreSealedColumns.test.ts`)

There are six `TestAuth.runSealedColumnTests(framework, config)` calls, one per declaration in §3.2. Each has one SQL adapter: `Persistence.sql({ encryptPii: true })` over `TestSql.layer`, with the core migrations. This runs on SQLite, and on Postgres under `test:pg`.

| Column | `write(rowKey, value)` | `read(rowKey)` | `raw` / `plant` |
|---|---|---|---|
| `users.metadata` | `UserStore.insertOrHolder` with `id = rowKey`, `metadata = Some(value)` | `UserStore.get(rowKey)` → `metadata` | `SELECT`/`UPDATE users.metadata` |
| `sessions.ipAddress` / `userAgent` | `SessionStore.insert` with `id = rowKey` | `SessionStore.get(rowKey)` → the field | `sessions."ipAddress"` / `"userAgent"` |
| `accounts.<token>` | `AccountStore.insertIfAbsent` with `id = rowKey`, distinct `subject` per row, the token in its field (`accessToken` always present) | `AccountStore.readProviderTokens(rowKey)` → the field | `accounts."<token>"` |

Each call contributes the suite's three cases: envelope at rest and round trip, a moved ciphertext does not open (for tokens this **is** the bug-2 regression, two rows of one user and provider), and re-seal to the current key on read. That is 18 cases.

Kept beside them in the same file, because these are core-specific and not part of the mechanism:

1. Phase 0 tests 1, 2 and 4, flipped (runbook, plaintext adoption by sweep, key retirement through `sweepDeployed`).
2. `encryptPii: false: the PII columns are stored as given, open through Sealed.plain, and Deployed lists only the token columns`. This replaces `PiiEncryption.test.ts` "default repositories store the columns as given".
3. `a plaintext metadata row written before opting in opens and is sealed on read`. This is the `adoptPlaintext` wiring and replaces `PiiEncryption.test.ts` "plaintext rows written before opting in…". The mechanism's own adoption case stays in `SealedColumn.test.ts`.
4. `writes that never touch a sealed column leave its ciphertext alone` (`touch`, `reauthenticate`, `casIdentity`, `writeCredentialHash`). This is the at-rest invariant from `PiiEncryption.test.ts` and `AccountsTokenReadPath.test.ts` "writePasswordHash never touches the token columns".
5. `writeProviderTokens heals an unreadable token without reading it, in one statement`. Count statements with a wrapping `SqlClient`, or assert that no `SELECT` reaches `accounts` (D-9).
6. `insertOrHolder and insert hand back what they wrote without decrypting it`. Assert through a counting `Encryption` that the decrypt count is 0 (D-8).

### 5.2 New and changed: the domain treatments

- `packages/core/test/Users.test.ts`, over a `Layer.mock(UserStore…)` whose `get` returns `metadata: Some({ open: Effect.fail(new Sealed.Unreadable({ … })) })`: `an unreadable metadata value reads as absent and logs one warning with the column ids`.
- `packages/core/test/Sessions.test.ts`, same double pattern: `an unreadable ipAddress/userAgent is absent in the view and the device list; verify still succeeds`.
- `packages/core/test/Accounts.test.ts:527-560` (rewritten): the `UnreadableStore` double returns `SealedProviderTokens` whose `refreshToken` fails to open. `findProviderTokens fails ProviderTokensUnreadable naming the field and the reason` keeps its name and now asserts `field: "refreshToken"`.
- `packages/ports/test/Sealed.test.ts` (phase 1).
- The `oauth` tests that map `ProviderTokensUnreadable` → `OAuthTokenUnavailable` are unchanged.

### 5.3 Deleted or moved, by name

- **`packages/sql/test/PiiEncryption.test.ts` is deleted** (5 tests):
  - "default repositories store the columns as given" → §5.1 item 2.
  - "sessions: ipAddress/userAgent are ciphertext at rest and plaintext through every read" → `runSealedColumnTests` (at rest, round trip) plus §5.1 item 4 (the untouched-by-other-writes half).
  - "sessions: null columns stay null, and a ciphertext moved to another row does not decrypt" → `runSealedColumnTests` (moved ciphertext); null handling is now `Option` at the port, covered by `StoreContract.sessions`.
  - "plaintext rows written before opting in stay readable and are sealed on read" → §5.1 item 3.
  - "users.metadata: ciphertext at rest, plaintext through insert/update/reads; email stays plaintext" → `runSealedColumnTests` plus §5.1 item 4; "email stays plaintext" joins item 4's assertions.
- **`packages/sql/test/AccountsTokenReadPath.test.ts` is deleted** (11 tests):
  - "a tampered accessToken fails findTokensById with AccountTokenUndecryptable" → `runSealedColumnTests` moved ciphertext, and the mechanism's tamper case (`SealedColumn.test.ts`).
  - "findById degrades only the unreadable column to null" and "listByUser returns every row when one row's token is undecryptable" → deleted with the degraded path (no production caller, §2.3).
  - "findIdentityByKey still resolves the identity row when its token ciphertext is unreadable" → kept in `AccountStoreSql.test.ts:161` (already there).
  - "writeTokens overwrites an undecryptable token without reading it" → §5.1 item 5.
  - "writePasswordHash never touches the token columns" → §5.1 item 4.
  - "a row written under a retired kid still decrypts…", "findById rewrites a stale-kid ciphertext under the current key", "once migrated, the retired key can be dropped…", "reencryptOnRead: false leaves a stale-kid ciphertext untouched" and "a token under a key missing from the keyset reports reason UnknownKeyId" → the mechanism's stale-key, `resealOnRead: false` and unknown-key cases (`SealedColumn.test.ts`), `runSealedColumnTests` rotation, and §5.1 item 1 (key retirement).
- `packages/sql/test/UserStoreSql.test.ts:77` "the metadata is ciphertext in the table and plaintext through the port" → `runSealedColumnTests`.
- `packages/sql/test/AccountStoreSql.test.ts`:
  - `:115` "the tokens are ciphertext in the table and plaintext through the port" → `runSealedColumnTests`.
  - `:137` "identity reads never decrypt or re-encrypt a token; the strict token read may" is kept, opening the sealed tokens.
  - `:161` is kept, asserting `Unreadable` on `open`.
- `packages/sql/test/contract.ts:288` "AccountsRepository.writeTokens re-encrypts a real accessToken/refreshToken under the row's AAD" → deleted (the AAD no longer comes from a read). Any other `contract.ts` case calling the deleted `AccountsRepository.insert/findById/listByUser` moves to `insertIdentityIfAbsent`/`findIdentityById`/`listIdentitiesByUser`.
- **Net:** 16 tests are deleted, plus 2 adapter tests and 1 contract case. 18 suite cases, 6 core cases (plus 1 PII-off case) and 4 domain/port cases are added.

### 5.4 BDD

No feature exercises core PII sealing or token unreadability today (`grep -rln "encryptPii\|AccountTokenUndecryptable\|TokensRead" features` finds only `features/traceability.md`). Add one scenario to `features/features/02-domain/` (the persistence or accounts feature; pick the one whose world builds `Persistence.sql`): "After a key rotation and a sweep of every deployed sealed column, the retired key can be dropped and the user's sessions, metadata and linked-account tokens still read". Use the next free REQ id, which is above `REQ-EA-1306` today. Re-check, because sibling plans allocate too.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviours (each gets a Document Control revision and a change-history line)

`spec/behaviors/05-persistence-stratum.md` → **1.6**:

- **BEH-EA-034, `:61`:** "bound to the row and column through additional authenticated data" stays true and becomes literally true. Add the AAD: "(`accounts:<id>:<field>`, ADR-EA-019 decision 6)".
- **BEH-EA-034, `:63`:**
  - Replace the AADs `session:<id>:<field>`, `user:<id>:metadata` with `sessions:<id>:<field>`, `users:<id>:metadata`.
  - Replace "when the deployment chooses `Repositories.SessionsRepositoryEncryptedLive`/`UsersRepositoryEncryptedLive`" with "when the composition chooses `Persistence.sql({ encryptPii: true })`".
  - Add: "These six columns are declared `SealedColumn`s (`CoreSealedColumns`) and follow BEH-EA-324."
- **BEH-EA-324, `:179-194`:**
  - In the REQUIREMENT, change "a call site MUST handle it with `SealedColumn.orDie` or `SealedColumn.option`" to "a call site MUST handle it with `SealedColumn.orDie`, `SealedColumn.option` (or `Sealed.optional`), or by mapping it to its own typed domain failure".
  - Add the paragraph: "Core's columns (`users.metadata`, `sessions.ipAddress`/`userAgent` when `encryptPii` is on; `accounts.accessToken`/`refreshToken`/`idToken` always) are declared the same way. The core store ports carry them as `Sealed` values (`@awthaq/ports` `Sealed`); `Users` and `Sessions` degrade an unreadable value to absent, `Accounts.findProviderTokens` fails `ProviderTokensUnreadable`. `Persistence.sql(options)` provides `SealedColumn.Deployed`, the columns that composition seals, and `SealedColumn.sweepDeployed` sweeps them."
- **New BEH-EA-(next free; 338 today, re-check), "A composition's sealed columns are swept as one list".** REQUIREMENT: "`Persistence.sql(options)` MUST provide the exact list of sealed columns it writes, derived from the same options; a column stored in plaintext MUST NOT be listed; `SealedColumn.sweepDeployed` MUST sweep that list plus the columns the caller adds, each once." Append it at the end of the file, as plan 05 did with BEH-EA-324/325, and update `spec/behaviors/index.yaml` and `spec/README.md`'s per-file range.

`spec/behaviors/16-oauth.md`: check whether any text names the token AAD or the null-degrade on identity reads, and replace it if so. The re-consent path is unchanged.

### 6.2 Decisions

**ADR-EA-019 → revision 1.3** (`spec/decisions/019-encryption-key-rotation.md`; Document Control row and change history: "1.3 (date): decision 6 covers core's six columns (plan 17)").

Decision 6:

- The last sentence ("Core's own columns keep their formats and null-and-warn policy and run on the same primitive") is struck and marked *Superseded by revision 1.3* inline, the style rev 1.2 used. It is replaced by: "Core's columns are declared too (`CoreSealedColumns`), under the same AAD; the core store ports carry `Sealed` values and the domain picks the treatment."
- The treatment sentence gains the third treatment (a typed domain failure, for provider tokens).
- `sweepDeployed`/`Deployed` is added after `sweepAll`.
- The table gains six rows:

  | Column | Canonical AAD | Treatment |
  |---|---|---|
  | `users.metadata` (encryptPii) | `users:<id>:metadata` | `Sealed.optional`: absent |
  | `sessions.ipAddress` (encryptPii) | `sessions:<id>:ipAddress` | `Sealed.optional`: absent |
  | `sessions.userAgent` (encryptPii) | `sessions:<id>:userAgent` | `Sealed.optional`: absent |
  | `accounts.accessToken` | `accounts:<id>:accessToken` | `ProviderTokensUnreadable` (re-consent) |
  | `accounts.refreshToken` | `accounts:<id>:refreshToken` | `ProviderTokensUnreadable` |
  | `accounts.idToken` | `accounts:<id>:idToken` | `ProviderTokensUnreadable` |

New paragraph, **"Revision 1.3: core columns."**

- Reasons: bugs 1 to 3 of §2.6.
- The previous core spellings stop opening, with the same timing argument as rev 1.2 (no tags, 0.1.0) and the same caveat: an internal environment with sealed core rows either accepts re-consent and the loss of encrypted metadata, or runs `SealedColumn.rekey` if Q1 ships it.
- Rejected alternative: the per-column AAD hook (§3.8 A).
- `AccountsRepositoryConfig` is removed and `SealedColumnConfig.resealOnRead` is the one switch.
- `sqlSwap` runs in a savepoint.

In the Consequences section, the negative list gains "rows sealed under the pre-1.3 core spellings no longer open". `spec/decisions/index.yaml`: no field changes (status stays "Accepted — implemented"). ADR-EA-028 and ADR-EA-041 need no change, because the ports keep `StoreUnavailable` as their only failure.

### 6.3 Traceability, glossary, overview

- `spec/traceability.md`: revision bump (1.32 → next).
  - The ADR-EA-019 row (`:162`) adds `packages/sql/test/CoreSealedColumns.test.ts` and `packages/ports/test/Sealed.test.ts`.
  - A new row for `CoreSealedColumns.test.ts`: "BEH-EA-034/324/(new): the six core columns through `runSealedColumnTests` over `Persistence.sql({ encryptPii: true })` (SQLite and Postgres), the runbook sweep, plaintext adoption, key retirement through `sweepDeployed`, the PII-off list, writes that leave ciphertext alone, the one-statement token write, and an insert that never decrypts".
  - The `SealedColumn.test.ts` row (`:219`) adds `sweepDeployed`, `Sealed.plain` and the savepoint case.
  - Remove any mention of `PiiEncryption.test.ts`/`AccountsTokenReadPath.test.ts` (none today).
- `spec/glossary.md`: add **Sealed column**: "A table column stored as an `Encryption` envelope, declared once (`SealedColumn.column`), AAD `<table>:<rowKey>:<column>`, read as a `Sealed<A>` whose `open` is the only place the plaintext appears (ADR-EA-019 decision 6)."
- `spec/overview.md`: the ports surface block lists `Sealed`, and the sql row names `CoreSealedColumns`.
- `features/traceability.md`: the new REQ row (§5.4).

### 6.4 Changesets (ADR-EA-034: each has a `Migration:` section naming ADR and BEH ids)

- **Phase 1, `.changeset/sealed-port.md`** (`@awthaq/ports`: minor; `@awthaq/sql`: minor):

  > `Sealed` (the value, `Unreadable`, `plain`, `openOption`, `optional`, `orDie`, `option`) moves to `@awthaq/ports`; `SealedColumn` re-exports it unchanged. `SealedColumn.Deployed` and `SealedColumn.sweepDeployed` sweep every sealed column a composition writes. A lazy re-seal now runs in a savepoint, so a failed one no longer aborts an enclosing Postgres transaction (ADR-EA-019 rev 1.3, BEH-EA-324).
  >
  > Migration: none.

- **Phase 2, `.changeset/core-sealed-pii.md`** (`@awthaq/ports`, `@awthaq/sql`, `@awthaq/core`: minor):

  > `users.metadata` and `sessions.ipAddress`/`userAgent` (with `encryptPii`) are declared `SealedColumn`s under the canonical AAD (`users:<id>:metadata`, `sessions:<id>:<field>`). `UserStore.StoredUser.metadata` and `SessionStore.SessionRecord.ipAddress`/`userAgent` are `Option<Sealed<string>>`; `NewUser.metadata` stays plaintext. Users and sessions degrade an unreadable value to absent with an ids-only warning, as before (BEH-EA-034, BEH-EA-324, ADR-EA-019 rev 1.3).
  >
  > Migration: values sealed under the old `user:<id>:metadata` / `session:<id>:<field>` AADs no longer open (they read as absent). A custom `UserStore`/`SessionStore` returns `Sealed.plain(value)` for a plaintext column. `Repositories.UsersRepository`/`SessionsRepository` rows now carry the stored cell; read it through `metadataOf`/`piiOf`.

- **Phase 3, `.changeset/core-sealed-tokens.md`** (`@awthaq/ports`, `@awthaq/sql`, `@awthaq/core`: minor):

  > Provider tokens are sealed under `accounts:<id>:<field>`, which binds the account: a token copied to another account of the same user and provider no longer opens. `AccountStore.readProviderTokens` returns `Option<Option<SealedProviderTokens>>`; `TokensRead`, `AccountTokenUndecryptable`, `AccountsRepositoryConfig` and the decrypting `AccountsRepository.insert/findById/listByUser` are removed; `writeTokens` is one statement. `ProviderTokensUnreadable.reason` may be `Malformed` (ADR-EA-019 rev 1.3, BEH-EA-034).
  >
  > Migration: tokens sealed under `<providerId>:<userId>:<field>` no longer open, so the account needs one OAuth sign-in to re-store them (`OAuthTokenUnavailable` until then). Use `SealedColumnConfig.resealOnRead` instead of `AccountsRepositoryConfig.reencryptOnRead`. A custom `AccountStore` returns sealed tokens (`Sealed.plain` for plaintext).

- **Phase 4, `.changeset/persistence-sealed-columns.md`** (`@awthaq/core`: minor):

  > `Persistence.sql(options)` provides `SealedColumn.Deployed`; after a key rotation run `SealedColumn.sweepDeployed({ also: [...pluginColumns] })` (BEH-EA-(new)).
  >
  > Migration: replace a hand-built `sweepAll` list of core columns with `sweepDeployed`.

- **Phase 5, `.changeset/plugin-sealed-columns.md`** (`@awthaq/core` and the seven plugin packages: minor). `AuthPlugin.Service.sealedColumns` and `auth.sealedColumns`. Migration: none (optional field).
- **Phase 2b, if shipped:** `.changeset/sealed-column-rekey.md`.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **Rows under the old core AADs stop opening** (internal environments only) | Q1. The default follows ADR-EA-019 rev 1.2. Tokens heal on the next OAuth sign-in, and session PII is display-only. Encrypted metadata is the only real loss, and phase 2b exists for it. The changesets say so |
| **Port shape change ripples** (`StoredUser`, `SessionRecord`, `readProviderTokens`): `StoreContract`, store doubles (`Layer.mock`), BDD worlds | Phase 2 and phase 3 each run `pnpm typecheck` across the workspace. Doubles use `Sealed.plain`. Plan 16 has not written its single contract suite yet if 17 goes first (§8) |
| **`toView`/`toItem` become effects** on the `Sessions.verify` hot path | They already run on an `Effect` path. The cost is the same as today's repository-side decryption. No new I/O, except the re-seal on a stale key, which today's code also does |
| **Re-seal runs later than before**, when the domain opens rather than when the repository reads | The swap is a compare-and-swap on the stored value, so it is order-independent. A row read from a replica (`listLive` eventual) and opened later re-seals against the primary through the codec's captured client, and loses harmlessly if the primary moved |
| **A savepoint per re-seal** (§3.7) | Paid only on a stale read. Outside a transaction it is a one-statement transaction |
| **`Deployed` missing from a hand-assembled composition** (not via `Persistence.sql`) | `sweepDeployed` then fails to compile (missing service), which is the intended signal. The runbook names `Persistence.sql` |
| **Moving `Unreadable` to ports changes its module, not its tag** | The tag string is unchanged, so `catchTag("SealedColumn/Unreadable")` and `check:error-tags` are unaffected. `SealedColumn.Unreadable` is the same class |
| **Turning `encryptPii` off after on** returns envelope text as the value | Pre-existing. Documented as unsupported (§4 phase 4, README). Not widened |
| **Plan 16 lands first** and the `Repositories.ts` locations move | §8 maps each location. The design is stated in terms of the adapters, not the file |

**Rollback.** Each phase is one commit series:

- Phases 1 and 4 are additive or doc-only.
- Phase 2 and phase 3 each revert as a unit (port shape, adapter, domain, tests, changeset).
- Phase 3 depends on phase 1 only, so phases 2 and 3 can land in either order.
- Reverting phase 3 restores the old token AAD, so tokens written in between stop opening. That is the same re-consent consequence, and the commit message must say so.

---

## 8. Interactions with other plans

- **05 (plugin table substrate, done):** this plan finishes 05's non-goal (`:74-77`). It reuses `codec`, `sqlSwap`, `sweep`, `runSealedColumnTests` and the rev 1.2 precedent unchanged, except for the savepoint (§3.7), which also fixes R-4 for the seven plugin columns.
- **02 (store seam, done):** the core ports change shape for six fields (§3.4). Q2 of plan 02 made `StoreContract` public, so its cases that compare stored records open the PII (phase 2). The ADR-EA-041 atomicity contract is unchanged.
- **16 (sql-store-adapters), the main interaction.** Recommended order: **17 first** (Q8).
  - 17 deletes about 300 lines of hand sealing from `Repositories.ts` (`PiiCodec`, three compare-and-swaps, `AccountTokenUndecryptable`, `AccountsRepositoryConfig`, the degraded token reads, `findAadQuery`), so 16 moves six `codec` declarations instead.
  - 17 changes the port shapes before 16 writes its one contract suite, so that suite is written once.
  - If 16 lands first, every "users/sessions/accounts SQL adapter" step here applies to `UserStoreSql.ts`/`SessionStoreSql.ts`/`AccountStoreSql.ts`. `metadataOf`/`piiOf`/`findSealedTokensById` become private helpers of those adapters instead of repository members. Phase 0 tests and §5 are unchanged, because they go through the ports.
  - 16 owns `Repositories.ts-E` and the `packages/sql/README.md:9-25` fix. 17 edits only README `:188-209`.
- **15 (host composition):** if Q4 lands (phase 5), `auth.sealedColumns` is one more field the host-composition module derives from `Auth.make`. Plan 15 should carry it through to whatever it hands an operator job, and `TestAuth.layer` needs nothing.
- **22 (table DDL locality):** a plugin's sealed-column declarations sit beside its table DDL in its records module. If 22 moves DDL, it moves the `SealedColumn.column` constants with it. `CoreSealedColumns` stays in `@awthaq/sql` beside `CoreMigrations`.
- **19 (session verdict):** the pure verdict extracted from `Sessions.verify` must work on `SessionRecord` without opening `ipAddress`/`userAgent`. Opening happens in `toView`, after the verdict. This keeps the verdict pure under this plan's port change.
- **11 (credential resolution) and 13 (admin gate):** they read `SessionView`/`UserRecord`, which are unchanged. `Admin.ts:379` reads `session.userAgent` from the view.
- **14 (federated identity):** OAuth and SAML linking write tokens through `AccountStore.insertIfAbsent`/`writeProviderTokens`, whose plaintext write side is unchanged. The AAD now comes from the account id the domain mints.
- **24 (memory records over SQLite):** if core `Persistence.memory` ever moves onto SQLite `:memory:`, Q6 becomes free: it could use the SQL adapters with sealing. Nothing here blocks or depends on 24.
- **18, 20, 21, 23:** no interaction.

---

## 9. Acceptance checklist

- [ ] `grep -rn "\.encrypt(\|\.decrypt(" packages/sql/src` lists only `SealedColumn.ts`.
- [ ] `grep -rn "user:\${\|session:\${\|tokenAad\|PiiCodec\|sealedPii\|AccountTokenUndecryptable\|AccountsRepositoryConfig\|TokensRead\|reencryptOnRead" packages docs features` returns nothing.
- [ ] `CoreSealedColumns` declares six columns. `Persistence.sql(options)` provides `SealedColumn.Deployed` built from the same options (three columns with PII off, six with it on).
- [ ] The core ports carry `Sealed` for the six columns. The `Ref` adapters return `Sealed.plain`. There are no type assertions (`as`) and no new return-type annotations in touched source.
- [ ] `Users`/`Sessions` degrade through `Sealed.optional`, and `Accounts.findProviderTokens` maps `Unreadable` to `ProviderTokensUnreadable` per field.
- [ ] `sqlSwap` runs under `SqlTransaction.transactional`. The pg-only savepoint case passes under `pnpm test:pg`.
- [ ] The four phase 0 tests are flipped to `it.effect` and pass, on SQLite and Postgres.
- [ ] There are six `runSealedColumnTests` calls for core columns, and `PiiEncryption.test.ts` and `AccountsTokenReadPath.test.ts` are deleted (§5.3).
- [ ] The runbook and `packages/sql/README.md` name `sweepDeployed`, the new AADs, `idToken` and `SealedColumnConfig.resealOnRead`. The "plus the core token and PII columns" sentence is gone.
- [ ] ADR-EA-019 is at rev 1.3. BEH-EA-034/324 are revised and the new BEH is added and indexed. The glossary, overview and both traceability files are updated, and `pnpm spec:verify:strict` passes.
- [ ] Every package-visible phase has a changeset with a `Migration:` section.
- [ ] (Phase 5, if Q4 = yes) `auth.sealedColumns` lists all seven plugin columns, and the runbook uses it.
- [ ] `pnpm check && pnpm test:pg` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **Rows sealed under today's core AADs.** Does any environment you care about hold core rows sealed under `user:<id>:metadata`, `session:<id>:<field>` or `<providerId>:<userId>:<field>`, in particular `users.metadata` with `encryptPii` on? **Recommended default: no, a clean break as in ADR-EA-019 rev 1.2.** Tokens heal on the next OAuth sign-in. If yes, phase 2b ships `SealedColumn.rekey` plus a one-release `CoreSealedColumns.previousAad` mapping with a sunset ticket. The per-column AAD hook (§3.8 A) is not recommended either way.
2. **Where the unreadable decision lives.** Should the core ports carry `Sealed` values, so the domain picks the treatment (recommended, §3.4)? Or should the SQL adapter apply `SealedColumn.option` itself, keeping the ports plaintext (smaller change; behaviour identical today; no domain caller can tell "absent" from "unreadable")?
3. **Token strictness.** Today any one unreadable token (including `idToken`) fails `findProviderTokens`, so a still-valid access token is not used and the user must re-consent. **Recommended default: keep it strict.** `idToken` is carried through a refresh (`OAuthTokenAccess.ts:233`), and re-consent heals all three at once. The alternative degrades `idToken` alone (`Sealed.optional`).
4. **Plugins declare their sealed columns on the contract** (`AuthPlugin.Service.sealedColumns`, `auth.sealedColumns`, phase 5), so a rotation sweep cannot forget, say, the TOTP secret, which is `orDie` once its key is dropped. **Recommended default: yes.** The caller is the runbook. Otherwise the operator concatenates the seven exported constants by hand.
5. **A CLI command** (`awthaq sealed sweep`) now that `Deployed` (and `auth.sealedColumns`) make the list derivable. **Recommended default: no.** It stays a library effect (ADR-EA-019 rev 1.2), and is revisited when an operator asks.
6. **Should the core `Ref` adapters seal for real** (requiring `Encryption` in `Persistence.memory`, and therefore in every test composition and `TestAuth`)? **Recommended default: no.** They are test-grade (TRBS-005), sealing is proven at the SQL adapter by the wiring suite, and plugin memory adapters seal only because they have no SQL-only option.
7. **Data export of an unreadable value.** `DataExport` (`DataExport.ts:141`, `:164`) receives `metadata`/`userAgent` through the domain records, so an unreadable value is exported as absent. **Recommended default: keep that** (with the warning). The alternative marks it `"<unreadable>"` in the export, which needs an export-specific read.
8. **Order with plan 16.** **Recommended: 17 first** (§8). The plan holds either way.

---

## Decisions taken (implementation, 2026-10-18)

Open questions took the plan's recommended default:

1. **Q1, rows under today's core AADs: no environment, clean break.** Phase 2b (`SealedColumn.rekey`, `CoreSealedColumns.previousAad`) is NOT built. ADR-EA-019 rev 1.3 records the break and the rejected per-column AAD hook; the changesets carry the `Migration:` lines.
2. **Q2, the core ports carry `Sealed` values: yes** (`StoredUser.metadata`, `SessionRecord.ipAddress`/`userAgent`, `readProviderTokens` returns `Option<Option<SealedProviderTokens>>`; `TokensRead` is deleted).
3. **Q3, token strictness: strict.** Any one unreadable token fails `findProviderTokens` (`ProviderTokensUnreadable` per field).
4. **Q4, plugins declare their sealed columns: yes** (phase 5): `AuthPlugin.Service` `sealedColumns`, `Auth.make` validation (`Auth/SealedColumnDeclarationInvalid`: `UnknownTable`, `Duplicate`), `auth.sealedColumns`; the runbook uses it.
5. **Q5, no CLI command. Q6, the core `Ref` adapters stay plaintext** and hand out `Sealed.plain`. **Q7, `DataExport` exports an unreadable value as absent** (with the warning). **Q8, order: 17 before 16** (16 is not implemented; `Repositories.ts` still holds the repositories).

Divergences from the plan, and what was not done:

- **`AccountsRepository.insert` is kept**, as a writer that seals under `accounts:<id>:<field>` and returns the row as stored (no decrypt, D-8). The plan deletes the decrypting `insert`; about a dozen test and BDD seeds use it, so deleting would have meant rewriting them for no gain. `findById`, `listByUser`, `findTokensById`, `AccountTokenUndecryptable` and `AccountsRepositoryConfig` are deleted as planned; `findSealedTokensById` replaces `findTokensById`.
- **The core columns test lives in `packages/test/test/CoreSealedColumns.test.ts`**, not `packages/sql/test/`: it needs `Persistence.sql` (core) and `TestAuth.runSealedColumnTests`, and `@awthaq/sql` cannot depend on either. It is in `scripts/test-pg.sh`.
- **The phase 0 token test (3)** was written at the store port (`readProviderTokens` returned `Undecryptable`) and flipped in phase 3 to `open` failing `DecryptionFailed`; key retirement (4) flipped in phase 4.
- **The BDD scenario** is REQ-EA-1320 under the new BEH-EA-339 (a new Rule at the end of `05-persistence-stratum.feature`), run on `Persistence.sql({ encryptPii: true })` with a rotatable keyset (`sealedStack` in `PersistenceStratumWorld.ts`).
- **The pg-only savepoint case** runs on SQLite too (it passes there trivially); it was seen red on Postgres with the old `sqlSwap` (SQLSTATE 25P02).
- **BEH-EA-339** is the new behavior id (the plan guessed 338, taken by plan 14). ADR-EA-019 is rev 1.3, BEH file 05 rev 1.6, overview 1.13, glossary 1.10, traceability 1.43, spec README 1.9.
- **`.scratch/plugin-table-substrate/issues/16-adopt-plaintext-sunset.md` was not ticked** (untracked, not staged by instruction), and the per-phase tickets under `.scratch/core-sealed-columns/` were not written. The answer for the former is yes: `Deployed` covers the adopting columns when `encryptPii` is on.
- **`ReadRouting.test.ts`** needed no change (it reads ids and liveness only).
- **Gates run:** typecheck, test, lint, circular, knip (only `.reports/` files), format:check, check:readmes, check:error-tags, check:contract-tests, check:transactions, package:smoke, test:bdd, spec:verify:strict and `test:pg` (Docker postgres:16).
