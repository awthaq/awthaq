// @awthaq/qadi — SubjectResolver
//
// spec/behaviors/18-roles-subject-resolver.md, BEH-EA-137 through BEH-EA-144.
// spec/decisions/012-slots-exclusive-registries-aggregate.md (ADR-EA-012):
// "core slots include `SubjectResolver` and `SessionViewExtension`" — a slot
// is a `Context.Reference` with a fail-closed default that a plugin may
// override; declared via `@awthaq/core`'s `Slots.define`, which is
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
// `MissingDep`) can ever observe a slot override. `@awthaq/roles`'s
// `Roles` claims this slot through `Slots.override`, which enforces the
// same conflict, at `Layer`-build time, through an explicit registry
// instead — see that call site, and `Slots.ts`'s own header comment, for
// how.
//
// **BEH-EA-140/141 (ApiKey/Service principal scopes -> permissions), OCM-002/MAPS-003.**
// `@awthaq/api-key` populates `scopes` on `ApiKeyPrincipal`/`ServicePrincipal`, and this
// default resolver maps them 1:1 onto `AuthSubject.permissions` (id `apikey:<keyId>` /
// `service:<clientId>`). Only scope strings shaped like a qadi permission key
// (`resource:action`) become permissions; any other scope string names no permission and
// is ignored, so a policy checking one simply denies (fail-closed). This is the one place
// the mapping lives, deliberately not a `SubjectResolver` override: `Roles` and
// `Organization` already contest the exclusive slot (ADR-EA-012) and both delegate every
// non-`User` principal here, so an API key never needs a third contender.
import { Api } from "@awthaq/api";
import { Assurance, Sessions, Slots } from "@awthaq/core";
import * as Effect from "effect/Effect";
import type { AuthSubject, PermissionKey } from "@qadi/core";
import { anonymous, makeSubject, withAttributes } from "@qadi/core";

/** A scope is a qadi permission when it is `resource:action` with both halves non-empty (`:` may appear in the action, e.g. `scim:users:write`). */
const isPermissionKey = (scope: string): scope is PermissionKey => {
  const colon = scope.indexOf(":");
  return colon > 0 && colon < scope.length - 1;
};

/**
 * AAPS-006/SOS-005/HSK-005 (BEH-EA-255): the attributes every `User` subject carries, from the
 * resolved principal — `actingAs` (BEH-EA-142) when impersonating, plus how the session was
 * authenticated: `amr` (RFC 8176 method references, `[]` when the issuing path recorded none —
 * the floor, never a guess), `authenticatedAt` (epoch seconds, absent when unknown), `aal` (the
 * derived NIST assurance level, `Assurance.assuranceLevel`) and `restrictedFactor` (an SMS factor
 * was used). A policy states `hasAttribute("aal", oneOf("aal2", "aal3"))` or
 * `amr contains "hwk"` rather than re-deriving them at each check. Exported so an overriding
 * resolver (`@awthaq/roles`) builds its subject with the identical attributes.
 */
export const principalAttributes = (
  principal: Api.UserPrincipal,
): Readonly<Record<string, unknown>> => {
  const amr = (principal.amr ?? []).filter(Sessions.isAuthMethod);
  const derived = Assurance.assurance(amr);
  return {
    ...(principal.actingAs === undefined
      ? {}
      : { actingAs: { type: principal.actingAs.type, id: principal.actingAs.id } }),
    amr,
    ...(principal.authenticatedAt === undefined
      ? {}
      : { authenticatedAt: principal.authenticatedAt }),
    aal: derived.level,
    restrictedFactor: derived.restricted,
  };
};

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
 * maps to qadi's own `anonymous` value exactly, never an awthaq-specific
 * stand-in.
 */
export const resolveIdentityOnly = (principal: Api.Principal): AuthSubject => {
  switch (principal._tag) {
    case "Anonymous":
      return anonymous;
    case "User":
      return withAttributes(
        makeSubject({ id: `user:${principal.ref.id}` }),
        principalAttributes(principal),
      );
    case "ApiKey":
      return makeSubject({
        id: `apikey:${principal.ref.id}`,
        permissions: principal.scopes.filter(isPermissionKey),
      });
    case "Service":
      return makeSubject({
        id: `service:${principal.ref.id}`,
        permissions: principal.scopes.filter(isPermissionKey),
      });
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
