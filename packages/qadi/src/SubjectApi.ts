// @awthaq/qadi — SubjectApi
//
// The server half of `@awthaq/api`'s `SubjectContract` (BEH-EA-026's
// `SubjectDto`) — added specifically so `@awthaq/react`'s `Providers`
// can satisfy BEH-EA-179 ("derive qadi's `subject` prop from `sessionAtom`'s
// current value, not from a second, independently fetched source") for
// real, rather than deriving `subject` from data that does not exist (see
// `@awthaq/api`'s `Subject.ts` header comment for the full reasoning,
// and for why `SessionView`'s single combined struct isn't what this is).
//
// **Why the middleware attachment and the handler live here, not in
// `@awthaq/api`/`@awthaq/server`**: those two strata sit *below*
// `@awthaq/qadi` (`spec/overview.md`) — neither can depend on
// `SubjectResolver`/`AuthSubject`/`CurrentSubject`/`AuthorizedSubject` at
// all without inverting that dependency. `@awthaq/api`'s `Subject.ts`
// therefore declares only the plain, middleware-free group/schema (so a
// browser client can depend on it without pulling in qadi's much heavier,
// server-only dependency graph — see that file's own header comment); this
// module attaches the real `AuthorizedSubject`/`OptionalAuthentication`
// middleware to that same base group and builds the actual served `HttpApi`
// and its handler, the one place both halves (a `@awthaq/server`
// dependency, and qadi's own resolver machinery) are available together.
//
// Fixed and standalone, exactly like `AuthCoreApi` — not yet folded into
// `Auth.make`'s plugin-composed `api` (that composition has no notion of a
// non-plugin package contributing a group at all yet; `AuthCoreApi`'s own
// header comment tracks the identical gap for the core `session` group).
// `OptionalAuthentication`, not `Authentication`: an anonymous caller has a
// real, well-formed `AuthSubject` too (qadi's own `anonymous` value,
// `SubjectResolver.ts`'s `resolveIdentityOnly`) — this endpoint should
// resolve for every caller, logged in or not, never 401.
import { Api, SubjectContract } from "@awthaq/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import type { AuthSubject } from "@qadi/core";
import { AttributeResolver, CurrentSubject } from "@qadi/core";
import { AuthorizedSubject } from "./AuthorizedSubject.ts";

// The same pair `withOptionalAuthorizedSubject` (YL-008) applies, spelled out
// here only because this module *exports* the resulting group: with
// `declaration` on, the emitted type must be able to name
// `Api.OptionalAuthentication`, which needs `Api` in this file's own scope.
// An application that does not emit declarations just uses the helper.
export const SubjectGroup = SubjectContract.SubjectGroup
  // Declaration order matters (`AuthorizedSubject.ts`'s own header comment):
  // the *last*-declared middleware is outermost and runs *first*, so
  // `OptionalAuthentication` — which `AuthorizedSubject` requires
  // `CurrentPrincipal` from — must be declared last.
  .middleware(AuthorizedSubject)
  .middleware(Api.OptionalAuthentication);

export const SubjectApi = HttpApi.make("auth-subject").add(SubjectGroup);

/**
 * AAPS-008: which resolver-backed attributes `GET /subject` puts in the DTO,
 * beyond the ones already embedded in the subject. Default: none — an attribute
 * an operator has not named stays server-side, so a client-side gate can read
 * exactly what was chosen to be exposed (and nothing about a user's org counts
 * or verification state leaks by default).
 */
export interface SubjectApiConfigShape {
  readonly exposedAttributes: ReadonlyArray<string>;
}

export const SubjectApiConfig = Context.Reference<SubjectApiConfigShape>("awthaq/qadi/SubjectApiConfig", {
  defaultValue: () => ({ exposedAttributes: [] }),
});

/** Sugar for `Layer.succeed(SubjectApiConfig, { exposedAttributes })`. */
export const config = (exposedAttributes: ReadonlyArray<string>) =>
  Layer.succeed(SubjectApiConfig, { exposedAttributes });

const toDto = (
  subject: AuthSubject,
  exposed: Readonly<Record<string, unknown>>,
): SubjectContract.SubjectDto =>
  new SubjectContract.SubjectDto({
    id: subject.id,
    roles: Array.from(subject.roles),
    permissions: Array.from(subject.permissions),
    attributes: { ...subject.attributes, ...exposed },
  });

/**
 * Does not itself provide `AuthorizedSubjectLive` — the same split
 * `Session.ts`'s own `SessionHandlers` (server) leaves to whatever composes
 * `AuthCoreApi`'s full `Layer` — so a caller wires `AuthorizedSubjectLive`
 * (and `Authentication`/`OptionalAuthentication`'s own live layer)
 * alongside this the same way `AuthHttp.test.ts` wires `Authentication`
 * alongside `SessionHandlers`.
 */
export const SubjectHandlers = HttpApiBuilder.group(SubjectApi, "subject", (handlers) =>
  handlers.handleAll({
    current: Effect.fnUntraced(function* () {
      const subject = yield* CurrentSubject;
      const { exposedAttributes } = yield* SubjectApiConfig;
      const exposed: Record<string, unknown> = {};
      const pending = exposedAttributes.filter((name) => !(name in subject.attributes));
      if (pending.length > 0) {
        // The operator named attributes to expose, so a resolver must be wired:
        // a missing one, or one that fails, is a server fault (5xx) — never a
        // silently omitted attribute a client would read as "not set".
        const resolver = yield* Effect.serviceOption(AttributeResolver);
        if (Option.isNone(resolver)) {
          return yield* Effect.die(
            new Error(
              "awthaq: SubjectApiConfig.exposedAttributes names resolver-backed attributes but no AttributeResolver is provided",
            ),
          );
        }
        for (const name of pending) {
          const value = yield* resolver.value.resolve(subject.id, name).pipe(Effect.orDie);
          if (value !== undefined) exposed[name] = value;
        }
      }
      return toDto(subject, exposed);
    }),
  }),
);
