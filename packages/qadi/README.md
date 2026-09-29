# @awthaq/qadi

The authorization bridge to [qadi](https://github.com/leaderiop/qadi): awthaq answers _who is asking_, qadi answers _what they may do_ (ADR-EA-009). This package is the bridge, not an authorizer of its own.

**Shipped**

- **Path A** — `AuthorizedSubject` middleware (`CurrentPrincipal` → qadi's `CurrentSubject`), with `withAuthorizedSubject` / `withOptionalAuthorizedSubject` applying the middleware pair in the one order that works (BEH-EA-145).
- **Path B** — `SubjectExtractorLive` (raw request → `AuthSubject` for `@qadi/http`'s `RequirePermission`, BEH-EA-153) and `AuthorizationAudit.auditAuthorizationAnnotations(api)`, a startup check that every endpoint in a `RequirePermission`-guarded group declares a permission or `publicEndpoint`.
- `SubjectResolver` — the slot `@awthaq/roles` overrides; the default resolves identity only (BEH-EA-137).
- `Resolvers` — `UserAttributes` (`email`, `emailVerified`, `name`; typed via `userAttr`, memoized per request, outages map to `AttributeResolveError`) and `ObligationHandlers.reauth` (step-up; fails with the wire-decodable `Api.ReauthRequired`, fails closed on a malformed obligation).
- `AttributeResolvers.attributeResolverRegistry` — composes several `AttributeResolver` layers without one silently shadowing another.
- `SubjectApi` — `GET /subject`; `SubjectApi.config([...])` names resolver-backed attributes to expose to the client.
- `UserClaims` — opt-in per-user custom-claims store (a plugin like `Roles`, id `claims`, table `claims_user`; `UserClaims.layer` memory / `layerSql`) plus `UserClaimsAttributes`, which answers the single attribute `claims` (the user's JSON record). `merge` is shallow and a `null` value deletes a key; a real change publishes `auth.user.claimsUpdated` (keys only, never values) and announces `AfterUserAttributesChanged`, so an app-scoped decision cache is flushed. Read a field in a policy with `hasAttribute(claimsAttr("claims"), fieldMatch("plan", eq(literal("pro"))))`; add `{ names: UserClaimsAttributeNames, layer: UserClaimsAttributes }` to `attributeResolverRegistry` next to `UserAttributes`. It is a trusted primitive: the gate on who may change claims is yours, and there is no size cap.
- `DecisionLogging` — opt-in `DecisionSinkLog` / `DecisionSinkAudit` (denials into the log / the durable `AuditLog`).

**Decision cache scope** (wayfinder ticket 12). qadi's `DecisionCache` is safe against token downgrade but unsafe against _backend_ revocation when it outlives a request. The default is a per-request cache: declare `RequestDecisionCache` last (outermost) on a guarded group. If you provide `decisionCacheLayer` at application scope instead, you must also provide `DecisionCacheInvalidationLive` once, application-wide — it flushes the cache on every organization/team observe hook, dynamic-role change and user-attribute change. It cannot cover _your own_ resolvers' data: call `DecisionCache.clear` from those mutations. See [`spec/appendices/02-qadi-path-a-end-to-end.md`](../../spec/appendices/02-qadi-path-a-end-to-end.md).

**Firebase `setCustomUserClaims` mapping (FAMS-004).** `role`-shaped claims (`role: "admin"`) go to `@awthaq/roles` (`Roles.assign`); every other custom claim goes to `UserClaims.merge` / `set`. A JWT `definePayload` that must carry a claim copies it from `UserClaims.get` when it builds the payload — nothing mints tokens from the store automatically.

**Claims authenticate; they do not authorize.** A JWT (`@awthaq/jwt`'s `definePayload` claims) or any other bearer token proves who the caller is; its claims are _not_ projected into `AuthSubject`, and the default `SubjectResolver` yields identity only (BEH-EA-137). Re-home `auth.jwt()`-style facts: platform roles into `@awthaq/roles`, tenant membership/roles into `@awthaq/organization` relations, everything else into an `AttributeResolver` or your own `SubjectResolver` override — read from the live session, so revocation is immediate. The RLS migration guide ([`spec/appendices/04-rls-to-qadi-migration.md`](../../spec/appendices/04-rls-to-qadi-migration.md)) maps each shape.

**Consistency and bringing your own graph engine.** A relationship answer is as fresh as the organization records layer it reads; a request-scoped cache preserves that. To use OpenFGA/SpiceDB instead, replace the `OrganizationQadi.relationships` layer with one backed by that engine and export membership tuples from the `AfterAddMember` / `AfterRemoveMember` hook points — no adapter ships.

See [`spec/behaviors/19-qadi-bridge-path-a.md`](../../spec/behaviors/19-qadi-bridge-path-a.md), [`20-qadi-bridge-path-b.md`](../../spec/behaviors/20-qadi-bridge-path-b.md) and [`21-qadi-resolvers-obligations.md`](../../spec/behaviors/21-qadi-resolvers-obligations.md).
