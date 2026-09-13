// @effect-auth/qadi — SubjectResolver
//
// spec/behaviors/18-roles-subject-resolver.md, BEH-EA-137 through BEH-EA-144.
// spec/decisions/012-slots-exclusive-registries-aggregate.md (ADR-EA-012):
// "core slots include `SubjectResolver` and `SessionViewExtension`" — a slot
// is a `Context.Reference` with a fail-closed default that a plugin may
// override; declared via `@effect-auth/core`'s `Slots.define`, which is
// exactly that (`Context.Reference`, not `Context.Service`, which has no
// default and would make every application that installs no roles plugin
// fail to resolve it at all), plus a literal, introspectable key.
//
// **BEH-EA-012's compile-time `SlotConflict<P>` check (INV-EA-004: two
// plugins overriding the same slot is a type error at `Auth.make`) does not
// exist, for a confirmed structural reason, not a gap left open for later**:
// `Slots.ts`'s own header comment records the finding — `Context.Reference`'s
// `Identifier` is fixed to `never`, so an override `Layer`'s own `ROut`
// (`Layer.Success`) is `never` too, which vanishes from a union instead of
// appearing in it, so no pairwise walk over plugins' `ROut` types (the
// mechanism `Auth.ts`'s `Validate<P>` already uses for `DuplicateId`/
// `MissingDep`) can ever observe a slot override. `@effect-auth/roles`'s
// `Roles` claims this slot through `Slots.override`, which enforces the
// same conflict, at `Layer`-build time, through an explicit registry
// instead — see that call site, and `Slots.ts`'s own header comment, for
// how.
//
// **BEH-EA-140/141 (ApiKey/Service principal scopes → permissions) are also
// not implemented, for a different reason**: `@effect-auth/api`'s
// `ApiKeyPrincipal`/`ServicePrincipal` (`Api.ts`) carry only a `ref`, no
// `scopes` field — there is no `@effect-auth/api-key` plugin yet (M7,
// unbuilt) or any other mechanism that would populate one. Inventing a
// `scopes` field on these Principal schemas now, with no code path that ever
// sets it, would be exactly the kind of speculative infrastructure this
// project avoids building ahead of a real caller (`WebAuthn`'s own port
// interface is deferred for the identical reason — see `@effect-auth/ports`).
// The default resolver below still maps both principal kinds to a real,
// well-formed `AuthSubject` — `id` only, per BEH-EA-137's own "identity-only"
// default — so a policy checking a permission against either simply denies,
// which is the correct fail-closed behavior in the absence of a scope
// source, not a broken one.
import { Api } from "@effect-auth/api";
import { Slots } from "@effect-auth/core";
import * as Effect from "effect/Effect";
import type { AuthSubject } from "@qadi/core";
import { anonymous, makeSubject, withAttributes } from "@qadi/core";

export interface SubjectResolverShape {
  /** BEH-EA-145: what `AuthorizedSubject`/`SubjectExtractorLive` both call. */
  readonly resolve: (principal: Api.Principal) => Effect.Effect<AuthSubject>;
}

/**
 * BEH-EA-137: `id` only, no roles, no permissions — for every principal kind,
 * not only `User`. BEH-EA-142: a `UserPrincipal.actingAs`, when present, is
 * placed on `AuthSubject.attributes.actingAs` unconditionally — this is a
 * static fact about the principal itself (set once, wherever a `Principal`
 * carrying `actingAs` is minted), not something that requires an `Admin`
 * plugin to be installed; no `Admin` plugin exists yet to mint one, but the
 * mapping is correct the moment one does. BEH-EA-143: `AnonymousPrincipal`
 * maps to qadi's own `anonymous` value exactly, never an effect-auth-specific
 * stand-in.
 */
export const resolveIdentityOnly = (principal: Api.Principal): AuthSubject => {
  switch (principal._tag) {
    case "Anonymous":
      return anonymous;
    case "User": {
      const subject = makeSubject({ id: `user:${principal.ref.id}` });
      return principal.actingAs === undefined
        ? subject
        : withAttributes(subject, {
            actingAs: { type: principal.actingAs.type, id: principal.actingAs.id },
          });
    }
    case "ApiKey":
      return makeSubject({ id: `apikey:${principal.ref.id}` });
    case "Service":
      return makeSubject({ id: `service:${principal.ref.id}` });
  }
};

/**
 * BEH-EA-138: exclusive — see this module's own header comment, and
 * `Slots.ts`'s own, for exactly what "exclusive" means today (a real
 * override, checked at `Layer`-build time, not by `Auth.make`'s type
 * checker).
 */
export const SubjectResolver: Slots.Slot<"SubjectResolver", SubjectResolverShape> =
  Slots.define<SubjectResolverShape>()("SubjectResolver", {
    defaultValue: () => ({
      resolve: (principal) => Effect.succeed(resolveIdentityOnly(principal)),
    }),
  });
