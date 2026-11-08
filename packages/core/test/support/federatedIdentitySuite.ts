// ADR-EA-043, BEH-EA-338: `FederatedIdentity`, the one implementation of "which local user is this external
// identity". The per-plugin linking tests (the email table, verify-on-create, the image rule, the anonymous
// user, the returning sign-in) are these cases; each plugin keeps its protocol, its verdict wiring, its refusal
// mapping and one race regression. `suite` runs over any base composition: `FederatedIdentity.test.ts` gives it
// memory, `FederatedIdentitySql.test.ts` gives it SQLite (and Postgres under `pnpm test:pg`) and adds the
// transaction cases.
import * as Rendezvous from "../../../test/src/Rendezvous.ts";
import type { SqlTransaction } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Accounts from "../../src/Accounts.ts";
import * as AuditLog from "../../src/AuditLog.ts";
import type * as AuthEvents from "../../src/AuthEvents.ts";
import * as Errors from "../../src/Errors.ts";
import * as FederatedIdentity from "../../src/FederatedIdentity.ts";
import * as HookPoint from "../../src/HookPoint.ts";
import * as Hooks from "../../src/Hooks.ts";
import type * as Sessions from "../../src/Sessions.ts";
import * as Users from "../../src/Users.ts";

/** What every base composition provides (memory or SQL). */
type BaseServices =
  | Users.Users
  | Accounts.Accounts
  | Sessions.Sessions
  | AuthEvents.AuthEvents
  | AuditLog.AuditLog
  | SecureRandom.SecureRandom
  | SqlTransaction.SqlTransaction;

export interface EnvOptions {
  /** The first `n` anchor reads finish together: no write can slip between them. */
  readonly meet?: number;
  /** `BeforeSignUp` aborts. */
  readonly vetoSignUp?: boolean;
  /** Every `BeforeSignUp` input, in order. */
  readonly beforeSignUp?: Array<{ readonly strategy: string }>;
  /** The first anchor read that finds an account removes it right after reading (a stale read). */
  readonly removeAfterFirstRead?: boolean;
  /** The first anchor read that would find an account answers `None` instead (a read from before the winner's write). */
  readonly staleFirstRead?: boolean;
  /** `Accounts.link` always answers `AccountAlreadyLinked`. */
  readonly linkAlwaysTaken?: boolean;
  /** The anchor read is an outage. */
  readonly anchorOutage?: boolean;
  /** The email-holder read is an outage. */
  readonly holderOutage?: boolean;
}

const outage = (operation: string) => new Errors.StoreUnavailable({ operation });

const accountsDecorator = (options: EnvOptions) =>
  Layer.effect(
    Accounts.Accounts,
    Effect.gen(function* () {
      const inner = yield* Accounts.Accounts;
      const meeting = options.meet === undefined ? undefined : yield* Rendezvous.make(options.meet);
      const removed = yield* Ref.make(false);
      const stale = yield* Ref.make(false);
      return Accounts.Accounts.of({
        ...inner,
        findByProviderSubject: (providerId, subject, issuer) =>
          Effect.gen(function* () {
            if (options.anchorOutage === true)
              return yield* outage("Accounts.findByProviderSubject");
            const found = yield* inner.findByProviderSubject(providerId, subject, issuer);
            if (meeting !== undefined) yield* meeting.arrive;
            if (
              options.staleFirstRead === true &&
              Option.isSome(found) &&
              !(yield* Ref.getAndSet(stale, true))
            ) {
              return Option.none();
            }
            if (
              options.removeAfterFirstRead === true &&
              Option.isSome(found) &&
              !(yield* Ref.getAndSet(removed, true))
            ) {
              yield* inner.deleteAllByUser(found.value.userId);
            }
            return found;
          }),
        link: (input) =>
          options.linkAlwaysTaken === true
            ? Effect.fail(
                new Accounts.AccountAlreadyLinked({
                  message: "awthaq: account already linked",
                  providerId: input.providerId,
                  subject: input.subject,
                }),
              )
            : inner.link(input),
      });
    }),
  );

const usersDecorator = (options: EnvOptions) =>
  Layer.effect(
    Users.Users,
    Effect.map(Users.Users, (inner) =>
      Users.Users.of({
        ...inner,
        findByEmail: (email) =>
          options.holderOutage === true
            ? Effect.fail(outage("Users.findByEmail"))
            : inner.findByEmail(email),
      }),
    ),
  );

/** The decorators of `options`: build them over a base composition with `Layer.provideMerge(decorate(options), base)`. */
export const decorate = (options: EnvOptions) =>
  Layer.mergeAll(accountsDecorator(options), usersDecorator(options));

/** The `BeforeSignUp` tap of `options` and the hook points it taps: build it over the decorated composition. */
export const tap = (options: EnvOptions) =>
  Hooks.BeforeSignUp.tap((input) =>
    Effect.suspend(() => {
      options.beforeSignUp?.push({ strategy: input.strategy });
      return options.vetoSignUp === true
        ? Effect.fail(new HookPoint.HookAbort({ code: "NO_SIGNUPS" }))
        : Effect.succeed(input);
    }),
  ).pipe(Layer.provideMerge(Hooks.HooksLive));

/** Everything the suite's effects need: the base services and what `FederatedIdentity.make` requires. */
export type Provided = BaseServices | Effect.Services<typeof FederatedIdentity.make>;

const tokens = (access: string): Accounts.ProviderTokenSet => ({
  accessToken: Redacted.make(access),
  refreshToken: Option.none(),
  idToken: Option.none(),
  accessTokenExpiresAt: Option.none(),
  refreshTokenExpiresAt: Option.none(),
  scope: Option.none(),
  tokenType: Option.none(),
});

const ISSUER = "https://idp.acme.example";

/** A federated identity with an asserted, verified address; override what a case varies. */
export const identity = (
  overrides: Partial<FederatedIdentity.ExternalIdentity> = {},
): FederatedIdentity.ExternalIdentity => ({
  providerId: "acme",
  subject: "sub-1",
  issuer: Option.some(ISSUER),
  email: Option.some({ address: "ada@acme.example", verified: true }),
  name: Option.some("Ada"),
  image: Option.none(),
  tokens: Option.none(),
  ...overrides,
});

export const withEmail = (address: string, verified = true) => ({
  email: Option.some({ address, verified }),
});

export const withoutEmail = { email: Option.none<FederatedIdentity.AssertedEmail>() };

export const countOf = (eventTag: "auth.account.linked" | "auth.user.created") =>
  Effect.map(
    Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag })),
    (rows) => rows.length,
  );

/** The `reason` of an `EmailInUse` failure, or the failing tag when it is anything else. */
const refusalOf = (error: { readonly _tag: string }) =>
  error instanceof FederatedIdentity.EmailInUse ? error.reason : error._tag;

/** A local user whose address is (or is not) verified. */
const seedUser = (email: string, verified: boolean) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Local" });
    if (verified) yield* users.verifyEmail(user.id);
    return user;
  });

const accountCount = (userId: Users.UserId) =>
  Effect.map(
    Effect.flatMap(Accounts.Accounts, (accounts) => accounts.listByUser(userId)),
    (rows) => rows.length,
  );

export const suite = (
  name: string,
  env: (options?: EnvOptions) => Layer.Layer<Provided, unknown>,
) => {
  describe(`FederatedIdentity.resolve (${name})`, () => {
    it.effect(
      "Linked: a returning identity resolves to its anchor's user, creates nothing, runs no BeforeSignUp, and replaces the stored token set (BE-002)",
      () => {
        const beforeSignUp: Array<{ readonly strategy: string }> = [];
        return Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const accounts = yield* Accounts.Accounts;
          const first = yield* federation.resolve(
            identity({ tokens: Option.some(tokens("first")) }),
            FederatedIdentity.untrusted,
          );
          assert.strictEqual(first._tag, "Created");
          const second = yield* federation.resolve(
            identity({ tokens: Option.some(tokens("second")) }),
            FederatedIdentity.untrusted,
          );
          assert.strictEqual(second._tag, "Linked");
          assert.strictEqual(second.userId, first.userId);
          assert.strictEqual(beforeSignUp.length, 1);
          const [account] = yield* accounts.listByUser(first.userId);
          assert.isDefined(account);
          const stored = yield* accounts.findProviderTokens(account!.id);
          assert.strictEqual(Option.getOrThrow(stored).accessToken.pipe(Redacted.value), "second");
          assert.strictEqual(yield* accountCount(first.userId), 1);
        }).pipe(Effect.provide(env({ beforeSignUp })));
      },
    );

    it.effect(
      "BEH-EA-125/INV-EA-015: the anchor is the triple: the same subject under another issuer or providerId is another identity",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const trust = FederatedIdentity.untrusted;
          const base_ = identity(withoutEmail);
          const a = yield* federation.resolve(base_, trust);
          const again = yield* federation.resolve(base_, trust);
          const otherIssuer = yield* federation.resolve(
            { ...base_, issuer: Option.some("https://other.example") },
            trust,
          );
          const otherProvider = yield* federation.resolve(
            { ...base_, providerId: "globex" },
            trust,
          );
          const noIssuer = yield* federation.resolve({ ...base_, issuer: Option.none() }, trust);
          assert.strictEqual(again._tag, "Linked");
          assert.strictEqual(again.userId, a.userId);
          assert.strictEqual(
            new Set([a.userId, otherIssuer.userId, otherProvider.userId, noIssuer.userId]).size,
            4,
          );
        }).pipe(Effect.provide(env())),
    );

    const rows: ReadonlyArray<{
      readonly label: string;
      readonly trust: FederatedIdentity.EmailTrust;
      readonly claimVerified: boolean;
      readonly localVerified: boolean;
      readonly address: string;
      readonly outcome: string;
    }> = [
      {
        label: "untrusted",
        trust: FederatedIdentity.untrusted,
        claimVerified: true,
        localVerified: true,
        address: "ada@acme.example",
        outcome: "untrusted",
      },
      {
        label: "trusted(any), claim unverified",
        trust: FederatedIdentity.trusted("any"),
        claimVerified: false,
        localVerified: true,
        address: "ada@acme.example",
        outcome: "claimUnverified",
      },
      {
        label: "trusted(any), local unverified",
        trust: FederatedIdentity.trusted("any"),
        claimVerified: true,
        localVerified: false,
        address: "ada@acme.example",
        outcome: "localUnverified",
      },
      {
        label: "trusted(any), both verified",
        trust: FederatedIdentity.trusted("any"),
        claimVerified: true,
        localVerified: true,
        address: "ada@acme.example",
        outcome: "AutoLinked",
      },
      {
        label: "trusted(domains), inside",
        trust: FederatedIdentity.trusted(["acme.example"]),
        claimVerified: true,
        localVerified: true,
        address: "ada@acme.example",
        outcome: "AutoLinked",
      },
      {
        label: "trusted(domains), outside",
        trust: FederatedIdentity.trusted(["acme.example"]),
        claimVerified: true,
        localVerified: true,
        address: "ada@other.example",
        outcome: "outsideTrustedDomains",
      },
      {
        label: "trusted([]), nothing is inside",
        trust: FederatedIdentity.trusted([]),
        claimVerified: true,
        localVerified: true,
        address: "ada@acme.example",
        outcome: "outsideTrustedDomains",
      },
    ];
    for (const row of rows) {
      it.effect(
        `TMS-007/BEH-EA-124/245: an address held by a local user (${row.label}) is ${row.outcome}`,
        () =>
          Effect.gen(function* () {
            const federation = yield* FederatedIdentity.make;
            const holder = yield* seedUser(row.address, row.localVerified);
            const outcome = yield* federation
              .resolve(
                identity({
                  ...withEmail(row.address, row.claimVerified),
                  tokens: Option.some(tokens("t")),
                }),
                row.trust,
              )
              .pipe(
                Effect.map((resolved) => resolved._tag),
                Effect.catch((error) => Effect.succeed(refusalOf(error))),
              );
            if (row.outcome === "AutoLinked") {
              assert.strictEqual(outcome, "AutoLinked");
              assert.strictEqual(yield* accountCount(holder.id), 1);
              assert.strictEqual(yield* countOf("auth.account.linked"), 1);
              const accounts = yield* Accounts.Accounts;
              const [account] = yield* accounts.listByUser(holder.id);
              assert.isTrue(Option.isSome(yield* accounts.findProviderTokens(account!.id)));
            } else {
              assert.strictEqual(outcome, row.outcome);
              assert.strictEqual(yield* accountCount(holder.id), 0);
              assert.strictEqual(yield* countOf("auth.account.linked"), 0);
            }
          }).pipe(Effect.provide(env())),
      );
    }

    const verifiedRows: ReadonlyArray<{
      readonly label: string;
      readonly trust: FederatedIdentity.EmailTrust;
      readonly verified: boolean;
      readonly address: string;
      readonly expected: boolean;
    }> = [
      {
        label: "untrusted + claim",
        trust: FederatedIdentity.untrusted,
        verified: true,
        address: "new@acme.example",
        expected: false,
      },
      {
        label: "trusted + claim",
        trust: FederatedIdentity.trusted("any"),
        verified: true,
        address: "new@acme.example",
        expected: true,
      },
      {
        label: "trusted + no claim",
        trust: FederatedIdentity.trusted("any"),
        verified: false,
        address: "new@acme.example",
        expected: false,
      },
      {
        label: "trusted(domains) + inside",
        trust: FederatedIdentity.trusted(["acme.example"]),
        verified: true,
        address: "new@acme.example",
        expected: true,
      },
      {
        label: "trusted(domains) + outside",
        trust: FederatedIdentity.trusted(["acme.example"]),
        verified: true,
        address: "new@other.example",
        expected: false,
      },
    ];
    for (const row of verifiedRows) {
      it.effect(
        `AOMS-007: a created user is verified exactly when the party is trusted, the address is in its domains and the claim is verified (${row.label}: ${row.expected})`,
        () =>
          Effect.gen(function* () {
            const federation = yield* FederatedIdentity.make;
            const users = yield* Users.Users;
            const resolved = yield* federation.resolve(
              identity(withEmail(row.address, row.verified)),
              row.trust,
            );
            assert.strictEqual(resolved._tag, "Created");
            const stored = yield* users.findById(resolved.userId);
            assert.strictEqual(Users.isEmailVerified(stored), row.expected);
          }).pipe(Effect.provide(env())),
      );
    }

    it.effect(
      "FAMS-002: no address creates an Anonymous user named after the subject, never a synthetic email; the next resolve is Linked to it",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const users = yield* Users.Users;
          const input = identity({ ...withoutEmail, name: Option.none(), subject: "opaque-9" });
          const created = yield* federation.resolve(input, FederatedIdentity.untrusted);
          assert.strictEqual(created._tag, "Created");
          const user = yield* users.findById(created.userId);
          assert.deepStrictEqual(Users.emailField(user), {});
          assert.strictEqual(user.name, "opaque-9");
          const again = yield* federation.resolve(input, FederatedIdentity.untrusted);
          assert.strictEqual(again._tag, "Linked");
          assert.strictEqual(again.userId, created.userId);
        }).pipe(Effect.provide(env())),
    );

    it.effect(
      "NAM-009: an http(s) image lands on the created user; javascript: and data: are dropped",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const users = yield* Users.Users;
          const imageOf = (subject: string, image: string) =>
            Effect.gen(function* () {
              const resolved = yield* federation.resolve(
                identity({ ...withoutEmail, subject, image: Option.some(image) }),
                FederatedIdentity.untrusted,
              );
              return (yield* users.findById(resolved.userId)).image;
            });
          assert.deepStrictEqual(
            yield* imageOf("a", "https://cdn.example/avatar.png"),
            Option.some("https://cdn.example/avatar.png"),
          );
          assert.isTrue(Option.isNone(yield* imageOf("b", "javascript:alert(1)")));
          assert.isTrue(Option.isNone(yield* imageOf("c", "data:image/png;base64,AAAA")));
        }).pipe(Effect.provide(env())),
    );

    it.effect("the name falls back to the address, then the subject", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const users = yield* Users.Users;
        const nameOf = (input: FederatedIdentity.ExternalIdentity) =>
          Effect.gen(function* () {
            const resolved = yield* federation.resolve(input, FederatedIdentity.untrusted);
            return (yield* users.findById(resolved.userId)).name;
          });
        assert.strictEqual(yield* nameOf(identity({ subject: "s1" })), "Ada");
        assert.strictEqual(
          yield* nameOf(
            identity({ subject: "s2", name: Option.none(), ...withEmail("grace@acme.example") }),
          ),
          "grace@acme.example",
        );
        assert.strictEqual(
          yield* nameOf(identity({ subject: "s3", name: Option.none(), ...withoutEmail })),
          "s3",
        );
      }).pipe(Effect.provide(env())),
    );

    it.effect(
      "BEH-EA-323: BeforeSignUp sees strategy = providerId; a veto is HookAborted and nothing is created",
      () => {
        const beforeSignUp: Array<{ readonly strategy: string }> = [];
        return Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const error = yield* Effect.flip(
            federation.resolve(
              identity({ providerId: "saml:org:conn" }),
              FederatedIdentity.untrusted,
            ),
          );
          assert.strictEqual(error._tag, "HookAborted");
          assert.deepStrictEqual(beforeSignUp, [{ strategy: "saml:org:conn" }]);
          assert.isTrue(Option.isNone(yield* users.findByEmail("ada@acme.example")));
          assert.isTrue(
            Option.isNone(yield* accounts.findByProviderSubject("saml:org:conn", "sub-1", ISSUER)),
          );
        }).pipe(Effect.provide(env({ beforeSignUp, vetoSignUp: true })));
      },
    );

    it.effect(
      "an address asserted in another case matches its holder, and the domain bound folds case",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const holder = yield* seedUser("ada@acme.example", true);
          const resolved = yield* federation.resolve(
            identity(withEmail("ADA@Acme.Example")),
            FederatedIdentity.trusted(["ACME.example"]),
          );
          assert.strictEqual(resolved._tag, "AutoLinked");
          assert.strictEqual(resolved.userId, holder.id);
        }).pipe(Effect.provide(env())),
    );

    describe("a lost race resolves to the anchor", () => {
      const twice = (
        federation: FederatedIdentity.FederatedIdentityShape,
        input: FederatedIdentity.ExternalIdentity,
        trust: FederatedIdentity.EmailTrust,
      ) =>
        Effect.all([federation.resolve(input, trust), federation.resolve(input, trust)], {
          concurrency: "unbounded",
        });

      it.effect(
        "(a) anonymous: one Created and one Linked, one user, one account, auth.user.created once",
        () =>
          Effect.gen(function* () {
            const federation = yield* FederatedIdentity.make;
            const [a, b] = yield* twice(
              federation,
              identity({ ...withoutEmail, subject: "anon-1" }),
              FederatedIdentity.untrusted,
            );
            assert.deepStrictEqual([a._tag, b._tag].toSorted(), ["Created", "Linked"]);
            assert.strictEqual(a.userId, b.userId);
            assert.strictEqual(yield* accountCount(a.userId), 1);
            assert.strictEqual(yield* countOf("auth.user.created"), 1);
          }).pipe(Effect.provide(env({ meet: 2 }))),
      );

      it.effect(
        "(b) email: one Created and one Linked, one user, one account, auth.user.created once",
        () =>
          Effect.gen(function* () {
            const federation = yield* FederatedIdentity.make;
            const [a, b] = yield* twice(
              federation,
              identity(withEmail("new@acme.example")),
              FederatedIdentity.untrusted,
            );
            assert.deepStrictEqual([a._tag, b._tag].toSorted(), ["Created", "Linked"]);
            assert.strictEqual(a.userId, b.userId);
            assert.strictEqual(yield* accountCount(a.userId), 1);
            assert.strictEqual(yield* countOf("auth.user.created"), 1);
          }).pipe(Effect.provide(env({ meet: 2 }))),
      );

      it.effect(
        "(c) trusted auto-link: one AutoLinked and one Linked, one account, auth.account.linked once",
        () =>
          Effect.gen(function* () {
            const federation = yield* FederatedIdentity.make;
            const holder = yield* seedUser("ada@acme.example", true);
            const [a, b] = yield* twice(federation, identity(), FederatedIdentity.trusted("any"));
            assert.deepStrictEqual([a._tag, b._tag].toSorted(), ["AutoLinked", "Linked"]);
            assert.strictEqual(a.userId, holder.id);
            assert.strictEqual(b.userId, holder.id);
            assert.strictEqual(yield* accountCount(holder.id), 1);
            assert.strictEqual(yield* countOf("auth.account.linked"), 1);
          }).pipe(Effect.provide(env({ meet: 2 }))),
      );
    });

    it.effect(
      "an account removed between the anchor read and the token refresh is resolved again (the email policy decides), never a defect",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          yield* federation.resolve(identity(), FederatedIdentity.untrusted);
          const error = yield* Effect.flip(
            federation.resolve(
              identity({ tokens: Option.some(tokens("fresh")) }),
              FederatedIdentity.untrusted,
            ),
          );
          assert.strictEqual(refusalOf(error), "untrusted");
        }).pipe(Effect.provide(env({ removeAfterFirstRead: true }))),
    );

    it.effect("a resolution that loses twice is Contended", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        yield* seedUser("ada@acme.example", true);
        const error = yield* Effect.flip(
          federation.resolve(identity(), FederatedIdentity.trusted("any")),
        );
        assert.strictEqual(error._tag, "FederatedIdentity/Contended");
      }).pipe(Effect.provide(env({ linkAlwaysTaken: true }))),
    );

    it.effect("ADR-EA-028: an outage of the anchor read is StoreUnavailable", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const error = yield* Effect.flip(
          federation.resolve(identity(), FederatedIdentity.untrusted),
        );
        assert.strictEqual(error._tag, "StoreUnavailable");
      }).pipe(Effect.provide(env({ anchorOutage: true }))),
    );

    it.effect("ADR-EA-028: an outage of the holder read is StoreUnavailable", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const error = yield* Effect.flip(
          federation.resolve(identity(), FederatedIdentity.untrusted),
        );
        assert.strictEqual(error._tag, "StoreUnavailable");
      }).pipe(Effect.provide(env({ holderOutage: true }))),
    );
  });

  describe(`FederatedIdentity.attach (${name})`, () => {
    it.effect(
      "REQ-EA-337: attaches to the target user whatever the address says, publishes auth.account.linked{explicit}",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const target = yield* seedUser("alice@example.com", true);
          const attached = yield* federation.attach(identity(), target.id);
          assert.deepStrictEqual(attached, { userId: target.id, already: false });
          assert.strictEqual(yield* accountCount(target.id), 1);
          const rows = yield* (yield* AuditLog.AuditLog).list({ eventTag: "auth.account.linked" });
          assert.strictEqual(rows.length, 1);
        }).pipe(Effect.provide(env())),
    );

    it.effect("BE-002: the token set lands on the attached account", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const accounts = yield* Accounts.Accounts;
        const target = yield* seedUser("alice@example.com", true);
        yield* federation.attach(identity({ tokens: Option.some(tokens("linked")) }), target.id);
        const [account] = yield* accounts.listByUser(target.id);
        const stored = yield* accounts.findProviderTokens(account!.id);
        assert.strictEqual(Option.getOrThrow(stored).accessToken.pipe(Redacted.value), "linked");
      }).pipe(Effect.provide(env())),
    );

    it.effect(
      "a repeated attach to the same user is already: true, replaces the tokens, and publishes nothing",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const accounts = yield* Accounts.Accounts;
          const target = yield* seedUser("alice@example.com", true);
          yield* federation.attach(identity({ tokens: Option.some(tokens("one")) }), target.id);
          const again = yield* federation.attach(
            identity({ tokens: Option.some(tokens("two")) }),
            target.id,
          );
          assert.deepStrictEqual(again, { userId: target.id, already: true });
          const [account] = yield* accounts.listByUser(target.id);
          const stored = yield* accounts.findProviderTokens(account!.id);
          assert.strictEqual(Option.getOrThrow(stored).accessToken.pipe(Redacted.value), "two");
          assert.strictEqual(yield* countOf("auth.account.linked"), 1);
        }).pipe(Effect.provide(env())),
    );

    it.effect(
      "an identity linked to another user is LinkedElsewhere, and that user's tokens are unchanged",
      () =>
        Effect.gen(function* () {
          const federation = yield* FederatedIdentity.make;
          const accounts = yield* Accounts.Accounts;
          const bob = yield* seedUser("bob@example.com", true);
          const alice = yield* seedUser("alice@example.com", true);
          yield* federation.attach(identity({ tokens: Option.some(tokens("bobs")) }), bob.id);
          const error = yield* Effect.flip(
            federation.attach(identity({ tokens: Option.some(tokens("alices")) }), alice.id),
          );
          assert.strictEqual(error._tag, "FederatedIdentity/LinkedElsewhere");
          assert.strictEqual(yield* accountCount(alice.id), 0);
          const [account] = yield* accounts.listByUser(bob.id);
          const stored = yield* accounts.findProviderTokens(account!.id);
          assert.strictEqual(Option.getOrThrow(stored).accessToken.pipe(Redacted.value), "bobs");
        }).pipe(Effect.provide(env())),
    );

    it.effect("a vanished target user is TargetGone and nothing is linked", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const accounts = yield* Accounts.Accounts;
        const error = yield* Effect.flip(
          federation.attach(identity(), Users.UserId("no-such-user")),
        );
        assert.strictEqual(error._tag, "FederatedIdentity/TargetGone");
        assert.isTrue(
          Option.isNone(yield* accounts.findByProviderSubject("acme", "sub-1", ISSUER)),
        );
      }).pipe(Effect.provide(env())),
    );

    it.effect("two concurrent attaches to one user: one already: false, one already: true", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const target = yield* seedUser("alice@example.com", true);
        const [a, b] = yield* Effect.all(
          [federation.attach(identity(), target.id), federation.attach(identity(), target.id)],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual([a.already, b.already].toSorted(), [false, true]);
        assert.strictEqual(yield* accountCount(target.id), 1);
        assert.strictEqual(yield* countOf("auth.account.linked"), 1);
      }).pipe(Effect.provide(env({ meet: 2 }))),
    );

    it.effect("two concurrent attaches to two users: one Attached, one LinkedElsewhere", () =>
      Effect.gen(function* () {
        const federation = yield* FederatedIdentity.make;
        const alice = yield* seedUser("alice@example.com", true);
        const bob = yield* seedUser("bob@example.com", true);
        const tagOf = (attempt: ReturnType<typeof federation.attach>) =>
          attempt.pipe(
            Effect.map(() => "Attached"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
        const tags = yield* Effect.all(
          [
            tagOf(federation.attach(identity(), alice.id)),
            tagOf(federation.attach(identity(), bob.id)),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(tags.toSorted(), ["Attached", "FederatedIdentity/LinkedElsewhere"]);
        assert.strictEqual((yield* accountCount(alice.id)) + (yield* accountCount(bob.id)), 1);
      }).pipe(Effect.provide(env({ meet: 2 }))),
    );
  });
};
