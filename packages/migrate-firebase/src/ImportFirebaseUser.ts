// @awthaq/migrate-firebase — ImportFirebaseUser
//
// FAMS-010 (BEH-EA-207): the Firebase half of `awthaq import --from firebase`, mirroring
// `@awthaq/migrate-auth0`'s `ImportAuth0User` — but split the way decision 07 §6 asks: this module
// is the *mapping* (an `auth:export` user record onto `@awthaq/core`'s `UserImport.ImportedUser`, pure,
// decoded through Schemas, reporting what it could not map), and `UserImport.write` is the one writer
// that puts it through `Users`/`Accounts` (the CLI drives that inside its checkpointed batches).
//
// What maps, and how:
//
//   user            email, displayName (else the address's local part), emailVerified -> Users.create +
//                   verifyEmail. `photoUrl`, `phoneNumber`, `customAttributes`, `createdAt`,
//                   `lastSignedInAt` and every other field with data have no destination and are reported.
//   password        `passwordHash` + `salt` + the project's `hash_config` -> a `password` account whose
//                   credential is `FirebaseScryptVerifier.encodeHash(...)`, verified by
//                   `FirebaseScryptVerifier` at the user's first sign-in and rehashed to argon2id there — no
//                   forced reset (FAMS-010's acceptance).
//   providerUserInfo  the `password` entry is Firebase's own record of the credential and adds nothing; a
//                   federated one (`google.com`, `github.com`, ...) becomes an account with
//                   `providerId` = the Firebase id without its `.com` (`google`), `subject = rawId`, and the
//                   issuer (BEH-EA-125) from the caller's `issuers` map — the value the app's OAuth
//                   provider config sets, which Firebase's export does not contain. Anything else
//                   (`phone`, `anonymous`, a custom provider) is reported.
//
// Two source states are *unmappable* — reported, the row skipped, never silently imported:
//   - no email (awthaq accounts are keyed by address until FAMS-002 lands an email-less path);
//   - `disabled: true` (awthaq has no disabled-user concept: importing the row active would silently
//     re-enable an account Firebase had turned off).
// and a password hash with no `hash_config` is unmappable too, since the hash cannot be verified.

import type { UserImport } from "@awthaq/core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FirebaseScryptVerifier from "./FirebaseScryptVerifier.ts";

/** A source row that cannot be imported (and why): reported, the row skipped. */
export class UnmappableRow extends Data.TaggedError("UnmappableRow")<{
  readonly sourceRowId: string;
  readonly reason: string;
}> {}

/** The export files could not be read or are not the expected JSON. */
export class SourceReadError extends Data.TaggedError("SourceReadError")<{
  readonly message: string;
}> {}

/** `hash_config` as the Firebase console prints it (snake_case). */
const HashConfigJson = Schema.Struct({
  base64_signer_key: Schema.String,
  base64_salt_separator: Schema.String,
  rounds: Schema.Number,
  mem_cost: Schema.Number,
});

const ProviderUserInfo = Schema.Struct({
  providerId: Schema.String,
  rawId: Schema.optional(Schema.String),
  federatedId: Schema.optional(Schema.String),
});

const ExportUser = Schema.Struct({
  localId: Schema.String,
  email: Schema.optional(Schema.String),
  emailVerified: Schema.optional(Schema.Boolean),
  displayName: Schema.optional(Schema.String),
  passwordHash: Schema.optional(Schema.String),
  salt: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  providerUserInfo: Schema.optional(Schema.Array(ProviderUserInfo)),
});

const UsersFile = Schema.Struct({ users: Schema.Array(Schema.Unknown) });

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HashConfigJson));
const decodeUsersFile = Schema.decodeUnknownEffect(Schema.fromJsonString(UsersFile));
const decodeUser = Schema.decodeUnknownEffect(ExportUser);

export interface MappedUser {
  /** Firebase's `localId`: the key of the import's checkpoint. */
  readonly sourceRowId: string;
  readonly user: UserImport.ImportedUser;
  /** Source fields that hold data and have no awthaq destination, as `field` or `providerUserInfo.<id>`. */
  readonly unmapped: ReadonlyArray<string>;
}

const MAPPED_FIELDS = new Set([
  "localId",
  "email",
  "emailVerified",
  "displayName",
  "passwordHash",
  "salt",
  "disabled",
  "providerUserInfo",
]);

const hasData = (value: unknown) =>
  value !== null && value !== undefined && value !== "" && value !== false;

const isRecord = (u: unknown): u is Readonly<Record<string, unknown>> =>
  typeof u === "object" && u !== null;

/** `google.com` -> `google`: the convention for the awthaq provider id (documented in the README). */
export const providerIdFor = (firebaseProviderId: string) =>
  firebaseProviderId.endsWith(".com") ? firebaseProviderId.slice(0, -".com".length) : firebaseProviderId;

const readFailure = (what: string) => () => new SourceReadError({ message: `could not read ${what}` });

/** The project's `hash_config` (Firebase console -> "Password hash parameters"), from a JSON file. */
export const readHashConfig = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.mapError(readFailure("the hash config file")));
    const json = yield* decodeConfig(text).pipe(
      Effect.mapError(
        () =>
          new SourceReadError({
            message:
              "the hash config is not JSON with base64_signer_key, base64_salt_separator, rounds and mem_cost",
          }),
      ),
    );
    const config: FirebaseScryptVerifier.FirebaseHashConfig = {
      signerKey: json.base64_signer_key,
      saltSeparator: json.base64_salt_separator,
      rounds: json.rounds,
      memCost: json.mem_cost,
    };
    return config;
  });

/** The exported user records (`firebase auth:export users.json`), undecoded, as a stream. */
export const readUsers = (path: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(path).pipe(Effect.mapError(readFailure("the users file")));
      const file = yield* decodeUsersFile(text).pipe(
        Effect.mapError(() => new SourceReadError({ message: 'the users file is not JSON of the form {"users": [...]}' })),
      );
      return Stream.fromIterable(file.users);
    }),
  );

/**
 * Maps one exported record. `config` is the project's hash config (required only when the record has a
 * password hash); `issuers` maps an awthaq provider id (`google`) to the issuer its OAuth config sets.
 */
export const mapUser = (
  raw: unknown,
  options: {
    readonly config?: FirebaseScryptVerifier.FirebaseHashConfig | undefined;
    readonly issuers?: Readonly<Record<string, string>> | undefined;
  },
) =>
  Effect.gen(function* () {
    const sourceRowId = isRecord(raw) && typeof raw["localId"] === "string" ? raw["localId"] : "(no localId)";
    const user = yield* decodeUser(raw).pipe(
      Effect.mapError(() => new UnmappableRow({ sourceRowId, reason: "not a Firebase export user record (no localId)" })),
    );
    if (user.disabled === true) {
      return yield* new UnmappableRow({
        sourceRowId,
        reason:
          "the user is disabled in Firebase; awthaq has no disabled-user concept, so importing it active would re-enable it",
      });
    }
    if (user.email === undefined || user.email.trim() === "") {
      return yield* new UnmappableRow({
        sourceRowId,
        reason: "the user has no email address; awthaq identifies accounts by email until email-less import lands (FAMS-002)",
      });
    }

    const unmapped = new Set<string>();
    if (isRecord(raw)) {
      for (const field of Object.keys(raw)) {
        if (!MAPPED_FIELDS.has(field) && hasData(raw[field])) unmapped.add(field);
      }
    }

    const accounts: Array<UserImport.ImportedAccount> = [];
    if (user.passwordHash !== undefined && user.passwordHash !== "") {
      if (user.salt === undefined || options.config === undefined) {
        return yield* new UnmappableRow({
          sourceRowId,
          reason:
            "the user has a password hash but the salt or the project's hash config is missing, so the hash cannot be verified",
        });
      }
      accounts.push({
        providerId: "password",
        subject: undefined,
        credentialHash: FirebaseScryptVerifier.encodeHash({
          passwordHash: user.passwordHash,
          salt: user.salt,
          config: options.config,
        }),
      });
    }

    for (const info of user.providerUserInfo ?? []) {
      if (info.providerId === "password") continue;
      const subject = info.rawId ?? info.federatedId;
      const providerId = providerIdFor(info.providerId);
      const federated = info.providerId.endsWith(".com") || info.providerId.startsWith("oidc.") || info.providerId.startsWith("saml.");
      if (!federated || subject === undefined) {
        unmapped.add(`providerUserInfo.${info.providerId}`);
        continue;
      }
      const issuer = options.issuers?.[providerId];
      accounts.push({ providerId, subject, ...(issuer === undefined ? {} : { issuer }) });
    }

    const mapped: MappedUser = {
      sourceRowId: user.localId,
      user: {
        email: user.email,
        name: user.displayName !== undefined && user.displayName !== "" ? user.displayName : (user.email.split("@")[0] ?? user.email),
        emailVerified: user.emailVerified === true,
        accounts,
      },
      unmapped: Array.from(unmapped).sort(),
    };
    return mapped;
  });
