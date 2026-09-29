// @awthaq/migrate-better-auth — BetterAuthSource
//
// spec/behaviors/26-cli.md BEH-EA-207, decision 07 §6 (BAM-001): the better-auth half of
// `awthaq import --from better-auth`. Two pure-ish pieces and no CLI dependency:
//
//   - `read` streams a better-auth database's `user` rows with their `account` rows (keyset
//     pagination on the user id, so a large table is never held in memory), and `counts` reports
//     the four tables' sizes for the plan;
//   - `mapUser` decodes one such row through Schemas and maps it onto `UserImport.ImportUserInput`
//     (`@awthaq/core`) — the shape `Users.create` + `verifyEmail` + `Accounts.link` takes —
//     *reporting* every source column that has data and no awthaq destination instead of dropping it.
//
// Validated against a real export: `test/fixtures/better-auth-export.sqlite` is a database produced
// by better-auth 1.7.6 itself (see `generate-better-auth-export.mjs` beside it): password users
// signed up through its API, a GitHub user created through its internal adapter, and a
// plugin-style extra column (`user.plan`).
//
// What maps, and how:
//
//   user            email, name, emailVerified, image -> Users.create + verifyEmail. `createdAt`,
//                   `updatedAt` and any extra column (a plugin's or `additionalFields`) have no
//                   destination and are reported (`user.image`, ...) when they hold data.
//   account         `providerId = "credential"` is better-auth's password: its `password`
//                   (`<saltHex>:<keyHex>`, scrypt over the NFKC password) is stored *verbatim* as the
//                   `password` account's credential hash, subject = the new user id, and
//                   `BetterAuthScryptVerifier` verifies it at sign-in so `rehashOnLogin` retires it.
//                   Any other provider keeps its `providerId`, `subject = accountId`, and carries its
//                   tokens (access/refresh/id token, expiries, scope). The `issuer` (BEH-EA-125) is not
//                   in better-auth's data, so it comes from the caller's `issuers` map (providerId ->
//                   issuer), exactly the value the app's own OAuth provider config sets.
//   session,        not imported here: a live session is bridged on its next request by
//   verification    `LegacySessionBridgeLive` (BAM-003), and a verification token is short-lived; `counts`
//                   reports both so the plan says so.

import { UserImport, type Accounts } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { betterAuthScryptVerifier } from "./BetterAuthScryptVerifier.ts";

/** better-auth's own provider id for the email + password credential. */
export const CREDENTIAL_PROVIDER_ID = "credential";

/** A source row could not be mapped (a required column is missing or malformed). */
export class UnmappableRow extends Data.TaggedError("UnmappableRow")<{
  readonly sourceRowId: string;
  readonly reason: string;
}> {}

/** The source database could not be read. The message names the table, never the connection. */
export class SourceReadError extends Data.TaggedError("SourceReadError")<{
  readonly message: string;
}> {}

/** One better-auth user with every one of its accounts, as read (undecoded). */
export interface RawUser {
  readonly user: Readonly<Record<string, unknown>>;
  readonly accounts: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface MappedUser {
  /** The source row id (the better-auth `user.id`): the key of the import's checkpoint. */
  readonly sourceRowId: string;
  readonly user: UserImport.ImportUserInput;
  /** Source columns that hold data and have no awthaq destination, as `table.column`. */
  readonly unmapped: ReadonlyArray<string>;
}

const BooleanLike = Schema.Union([Schema.Boolean, Schema.Literals([0, 1])]);

const UserRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: BooleanLike,
  image: Schema.optional(Schema.NullOr(Schema.String)),
});

const AccountRow = Schema.Struct({
  providerId: Schema.String,
  accountId: Schema.String,
  password: Schema.optional(Schema.NullOr(Schema.String)),
  accessToken: Schema.optional(Schema.NullOr(Schema.String)),
  refreshToken: Schema.optional(Schema.NullOr(Schema.String)),
  idToken: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Columns `mapUser` carries over; everything else with data is reported — `createdAt`/`updatedAt`
 * included: `Users.create` stamps its own timestamps, so better-auth's are not preserved.
 */
const MAPPED_USER_COLUMNS = new Set(["id", "name", "email", "emailVerified", "image"]);
const MAPPED_ACCOUNT_COLUMNS = new Set([
  // structural: the account's own id, and the foreign key the read groups it under
  "id",
  "userId",
  "providerId",
  "accountId",
  "password",
  "accessToken",
  "refreshToken",
  "idToken",
  "scope",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
]);
const decodeUser = Schema.decodeUnknownEffect(UserRow);
const decodeAccount = Schema.decodeUnknownEffect(AccountRow);

const hasData = (value: unknown) => value !== null && value !== undefined && value !== "";

const unmappedColumns = (
  table: string,
  row: Readonly<Record<string, unknown>>,
  mapped: ReadonlySet<string>,
) =>
  Object.keys(row)
    .filter((column) => !mapped.has(column) && hasData(row[column]))
    .map((column) => `${table}.${column}`);

const asDateTime = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || value instanceof Date
    ? DateTime.make(value)
    : Option.none<DateTime.Utc>();

const optionalSecret = (value: string | null | undefined) =>
  value === null || value === undefined || value === ""
    ? Option.none<Redacted.Redacted<string>>()
    : Option.some(Redacted.make(value));

const optionalString = (value: string | null | undefined) =>
  value === null || value === undefined || value === "" ? Option.none<string>() : Option.some(value);

/** Maps one better-auth user (and its accounts) onto the domain-service import shape. */
export const mapUser = (
  raw: RawUser,
  options?: { readonly issuers?: Readonly<Record<string, string>> | undefined },
) =>
  Effect.gen(function* () {
    const sourceRowId = typeof raw.user["id"] === "string" ? raw.user["id"] : "(no id)";
    const decodedUser = yield* decodeUser(raw.user).pipe(
      Effect.mapError(
        () =>
          new UnmappableRow({
            sourceRowId,
            reason: "the user row lacks a string id, name and email, or a 0/1 emailVerified",
          }),
      ),
    );
    if (decodedUser.email.trim() === "") {
      return yield* new UnmappableRow({ sourceRowId, reason: "the user's email is empty" });
    }
    const unmapped = new Set<string>(unmappedColumns("user", raw.user, MAPPED_USER_COLUMNS));

    const credentials: Array<UserImport.ImportCredential> = [];
    for (const rawAccount of raw.accounts) {
      const account = yield* decodeAccount(rawAccount).pipe(
        Effect.mapError(
          () =>
            new UnmappableRow({
              sourceRowId,
              reason: "an account row lacks a string providerId and accountId",
            }),
        ),
      );
      for (const found of unmappedColumns("account", rawAccount, MAPPED_ACCOUNT_COLUMNS)) unmapped.add(found);

      if (account.providerId === CREDENTIAL_PROVIDER_ID) {
        if (account.password === null || account.password === undefined || account.password === "") {
          unmapped.add("account.credential-without-password");
          continue;
        }
        const hash = PasswordHasher.PhcHash(account.password);
        if (!betterAuthScryptVerifier.recognizes(hash)) {
          return yield* new UnmappableRow({
            sourceRowId,
            reason:
              "a credential account's password is not a better-auth <saltHex>:<keyHex> scrypt hash; refusing to import a hash nothing can verify",
          });
        }
        // `subject` omitted: a password account is keyed by the new user's own id (`Password.signUp`).
        credentials.push({ providerId: "password", credentialHash: Redacted.make(hash) });
        continue;
      }

      if (hasData(account.password)) unmapped.add("account.password");
      const accessToken = optionalSecret(account.accessToken);
      const issuer = options?.issuers?.[account.providerId];
      credentials.push({
        providerId: account.providerId,
        subject: account.accountId,
        ...(issuer === undefined ? {} : { issuer }),
        ...(Option.isNone(accessToken)
          ? {}
          : {
              tokens: {
                accessToken: accessToken.value,
                refreshToken: optionalSecret(account.refreshToken),
                idToken: optionalSecret(account.idToken),
                accessTokenExpiresAt: asDateTime(rawAccount["accessTokenExpiresAt"]),
                refreshTokenExpiresAt: asDateTime(rawAccount["refreshTokenExpiresAt"]),
                scope: optionalString(account.scope),
                tokenType: Option.none(),
              } satisfies Accounts.ProviderTokenSet,
            }),
      });
    }

    const mapped: MappedUser = {
      sourceRowId: decodedUser.id,
      user: {
        identity: { _tag: "Email", email: decodedUser.email },
        name: decodedUser.name,
        verified: decodedUser.emailVerified === true || decodedUser.emailVerified === 1,
        ...(hasData(decodedUser.image) && decodedUser.image !== null && decodedUser.image !== undefined
          ? { image: decodedUser.image }
          : {}),
        credentials,
      },
      unmapped: Array.from(unmapped).sort(),
    };
    return mapped;
  });

const readFailure = (table: string) => () =>
  new SourceReadError({ message: `could not read the better-auth "${table}" table` });

/**
 * Streams every user with its accounts, `batchSize` users at a time (keyset on `user.id`, so the
 * order is stable and a resumed run sees the same sequence). Read-only: it issues `SELECT`s.
 */
export const read = (options?: { readonly batchSize?: number | undefined }) => {
  const batchSize = Math.max(1, options?.batchSize ?? 500);
  const page = (
    rows: ReadonlyArray<RawUser>,
    next: Option.Option<string>,
  ): readonly [ReadonlyArray<RawUser>, Option.Option<string>] => [rows, next];
  // The cursor is the last user id seen; `""` sorts before every id, so the first page needs no special case.
  return Stream.paginate("", (cursor) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const users = yield* sql<Record<string, unknown>>`SELECT * FROM ${sql("user")} WHERE id > ${cursor} ORDER BY id LIMIT ${batchSize}`.pipe(
        Effect.mapError(readFailure("user")),
      );
      const ids = users.flatMap((row) => (typeof row["id"] === "string" ? [row["id"]] : []));
      const accounts =
        ids.length === 0
          ? []
          : yield* sql<Record<string, unknown>>`SELECT * FROM ${sql("account")} WHERE ${sql("userId")} IN ${sql.in(ids)} ORDER BY id`.pipe(
              Effect.mapError(readFailure("account")),
            );
      const rows = users.map(
        (user): RawUser => ({
          user,
          accounts: accounts.filter((account) => account["userId"] === user["id"]),
        }),
      );
      const last = ids.at(-1);
      return page(
        rows,
        users.length < batchSize || last === undefined ? Option.none() : Option.some(last),
      );
    }),
  );
};

/** Row counts of the four tables, for the plan (`session` and `verification` are never imported here). */
export const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const count = (table: string) =>
    sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`.pipe(
      Effect.map((rows) => Number(rows[0]?.n ?? 0)),
      Effect.mapError(readFailure(table)),
    );
  return {
    user: yield* count("user"),
    account: yield* count("account"),
    session: yield* count("session").pipe(Effect.orElseSucceed(() => 0)),
    verification: yield* count("verification").pipe(Effect.orElseSucceed(() => 0)),
  };
});
