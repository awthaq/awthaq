// @awthaq/cli — Seed
//
// spec/behaviors/26-cli.md BEH-EA-206 (BE-003 sub-ticket E, RRM-011, ECS-006, SMS-008).
//
// `seed admin` provisions the first privileged account through the *same* domain services an
// application uses at runtime — `Users`, `Roles`, `Accounts`, `AuthEvents` — never by writing rows
// (BEH-EA-206), so the account it produces obeys the invariants the rest of the system holds
// (uniqueness, hashing, role-catalog validity). It builds the application's own Layer on a
// short-lived runtime (BEH-EA-208 class 2: constructs services, serves nothing).
//
// - No `Roles` plugin, no admin concept: `RolesNotInstalled` (exit 9).
// - An administrator already exists: refuse — publish `auth.admin.seedRefused` and fail
//   `ConfirmationRequired` (exit 6) — unless `--force`.
// - Every grant publishes `auth.admin.seeded` (created vs promoted, forced, role) through
//   `AuthEvents`, which `AuditLog` persists inline (BEH-EA-100): a CLI run has no session to
//   attribute the grant to, so the event is the record.
// - The password, when there is one, comes from the environment or a prompt, never from argv
//   (a process listing shows argv). An email the operator vouches for is marked verified through
//   the sanctioned `Users.verifyEmail` transition, so a seeded administrator can sign in with the
//   password the operator just set (the verified-email gate is on by default).
//
// The account is created and granted in separate steps, not one transaction: the command is
// idempotent on a re-run (an existing user is promoted, an already-held role is a no-op), so a
// failure midway is repaired by running it again.

import { Accounts, AuthEvents, Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { Roles } from "@awthaq/roles";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { requireService, withApplication } from "./Application.ts";
import { ConfirmationRequired, RolesNotInstalled, UsageError } from "./CliErrors.ts";
import type { CliConfig } from "./Config.ts";
import * as Output from "./Output.ts";

/** The default administrative role name (`@awthaq/roles` catalogs conventionally define it). */
export const DEFAULT_ADMIN_ROLE = "admin";

/** A seeded password is a credential of the most privileged account: no shorter than the plugin's own default minimum. */
export const MIN_PASSWORD_LENGTH = 12;

export interface SeedInput {
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly force: boolean;
  /** From the environment or a prompt (never argv); `None` seeds an account with no password credential. */
  readonly password: Option.Option<Redacted.Redacted<string>>;
}

export interface SeedResult {
  readonly outcome: "created" | "promoted";
  readonly userId: string;
  readonly role: string;
  readonly forced: boolean;
}

/** BEH-EA-206: create or promote one account to the administrative role; refuse over an existing administrator without `--force`. */
export const seedAdmin = (config: CliConfig, input: SeedInput) =>
  withApplication(config, (context) =>
    Effect.gen(function* () {
      if (
        Option.isSome(input.password) &&
        Redacted.value(input.password.value).length < MIN_PASSWORD_LENGTH
      ) {
        return yield* new UsageError({
          message: `the seeded password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
      }
      const roles = Context.getOption(context, Roles.Roles);
      if (roles._tag === "None") {
        return yield* new RolesNotInstalled({
          message:
            "the Roles plugin is not installed: without it there is no administrative role for `seed admin` to grant (BEH-EA-137)",
        });
      }
      const users = yield* requireService(context, Users.Users, "Users", "seed admin");
      const events = yield* requireService(
        context,
        AuthEvents.AuthEvents,
        "AuthEvents",
        "seed admin",
      );

      const holders = yield* roles.value.holders(input.role);
      if (holders.length > 0 && !input.force) {
        yield* events.publish({ _tag: "auth.admin.seedRefused", reason: "adminExists" });
        return yield* new ConfirmationRequired({
          command: "seed admin",
          message: `an account already holds the "${input.role}" role; re-run with --force to grant another`,
        });
      }

      const existing = yield* users.findByEmail(input.email);
      const outcome = Option.isSome(existing) ? "promoted" : "created";
      const user = Option.isSome(existing)
        ? existing.value
        : yield* users
            .create({ identity: { _tag: "Email", email: input.email }, name: input.name })
            .pipe(
              // An email create can only lose to a concurrent creation of the same address (the phone
              // arm is the union's other case and cannot fire for an Email identity).
              Effect.catchTags({
                "Users/EmailAlreadyExists": () =>
                  Effect.fail(
                    new UsageError({
                      message: "an account with that email appeared while seeding; re-run",
                    }),
                  ),
                "Users/PhoneAlreadyExists": Effect.die,
              }),
            );
      yield* users.verifyEmail(user.id).pipe(Effect.orDie);

      if (Option.isSome(input.password)) {
        const accounts = yield* requireService(
          context,
          Accounts.Accounts,
          "Accounts",
          "seed admin",
        );
        const hasher = yield* requireService(
          context,
          PasswordHasher.PasswordHasher,
          "PasswordHasher",
          "seed admin",
        );
        const linked = yield* accounts.findByProviderSubject(
          Accounts.PASSWORD_PROVIDER_ID,
          user.id,
        );
        if (Option.isNone(linked)) {
          const hash = yield* hasher.hash(input.password.value);
          yield* accounts
            .link({
              userId: user.id,
              providerId: Accounts.PASSWORD_PROVIDER_ID,
              subject: user.id,
              credentialHash: Redacted.make(hash),
            })
            .pipe(Effect.orDie);
        }
      }

      yield* roles.value.assign(user.id, input.role).pipe(
        Effect.catchTag("Roles/UnknownRole", (error) =>
          Effect.fail(
            new UsageError({
              message: `the role "${error.roleName}" is not in the Roles catalog; pass --role with a catalog role`,
            }),
          ),
        ),
      );
      yield* events.publish({
        _tag: "auth.admin.seeded",
        targetUserId: user.id,
        outcome,
        forced: input.force && holders.length > 0,
        role: input.role,
        via: "cli",
      });

      const result: SeedResult = {
        outcome,
        userId: user.id,
        role: input.role,
        forced: input.force && holders.length > 0,
      };
      yield* Output.report(result, (value) => [
        `${value.outcome} administrator ${value.userId} (role ${value.role}${value.forced ? ", forced" : ""})`,
      ]);
      return result;
    }).pipe(
      // MA-004: a store outage is typed in core's `E`; the operator sees it as a retryable failure.
      Effect.catchTag("StoreUnavailable", (error) =>
        Effect.fail(
          new UsageError({
            message: `the database is unavailable (${error.operation}); check the connection and re-run`,
          }),
        ),
      ),
    ),
  );
