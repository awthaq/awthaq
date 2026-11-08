# ADR-EA-042: Credential Resolution Is One Module; Every Entry Point Derives Its Chain From a Middleware Declaration

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-042 |
> | Revision | 1.0 |
> | Effective Date | 2026-10-18 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-18): Initial release (architecture plan 11) |

---

## Context

"Which credential on this request names the caller, and what is it allowed to be" is one policy: the impersonation cookie (only when its session carries `actingAs`), the session cookie, `x-api-key` on the machine tier, then `Authorization: Bearer` (offered to the claimed-credential registry first, to `Sessions` otherwise); a credential that does not resolve falls through to the next one; a store outage stops the chain with a 503; the tier admits only some principals; a rotated secret is delivered back the way it came.

It was written four times: `Authentication.ts` (the user and machine tiers and, separately, the optional tier), `@awthaq/qadi`'s `SubjectExtractor` (Path B) and `@awthaq/web`'s `getSession`. The copies drifted into two live bugs. `@awthaq/web` and `@awthaq/next` named the session cookie from the default constants, so under `SessionCookie.SecureDomain` (`__Secure-session`) `getSession` always resolved `undefined`, `hasSessionCookie` always answered `false` and a rotation was written as `__Host-session` with `SameSite=Strict`. Path B took the first present credential and never fell through, so a stale cookie beside a valid bearer was anonymous on Path B and the user on Path A, and a route behind both bridges authorised one identity and served another. Smaller divergences: Path B judged the impersonation rule after the `PrincipalResolver` (Path A before it), parsed the bearer and the API key differently, and admitted any claimed principal.

## Decision

**1. One module, `Credentials`, in `@awthaq/server`.** It reads what a request presents (`presented`), picks a tier derived from the middleware declaration (`tier(declaration, admits)`), and runs either one carrier (`step`) or the whole chain (`resolve`, a fold over the tier's carriers). Its implementation holds everything the copies shared: the per-request single-flight memo (for sessions and for claimed credentials), the outage short-circuit, the impersonation rule, tier admission, the rotation hand-off, spans and logs. `web` and `qadi` already depend on `server`, so no package edge is added; it cannot live in `core` (the tiers are `Api` declarations and `PrincipalResolver` and the registry are server modules) or in `api` (no implementations, ADR-EA-003).

**2. A `Scope` seam with two adapters.** `httpScope(request)` keys the memo on `request.source` (so `request.modify` re-wraps share it, NHS-006), delivers a rotation through a pre-response handler and claims through the `CredentialResolvers` registry. `collecting` is a framework call (web `getSession`): a fresh memo identity, rotations collected and rendered by the caller under the configured cookie.

**3. Path A keeps one handler per declared scheme**, each running exactly one carrier through `step`; Effect's security loop over the declaration is the chain (REQ-EA-203 redeclares the record and expects the order to change). The optional tier, Path B (over the machine tier's declaration) and the web adapter (over the user tier) call `resolve`, which falls through on `Unauthenticated` exactly as Effect's loop does. The group A parity tests serve the same table through both and so keep them equal.

**4. Tier admission applies to every principal**, session-derived or claimed: the user tier admits only a `User` (BEH-EA-066). A custom `PrincipalResolver` that maps a session to a non-`User` is `Unauthenticated` on the user tier instead of a defect in every handler.

**5. The impersonation rule is judged on the session** (`actingAs`), before the `PrincipalResolver`, for every entry point.

**6. Claimed credentials join the per-request memo.** One request through Path A and Path B spends one API-key throttle charge and verifies a JWT once.

**7. The web adapter renders inside the host's runtime.** `getSession` reads the cookie names from the runtime's `SessionCookieConfig`, renders a rotation with `SessionCookie.render` (runtime `Clock`) and returns it as `Session.rotated = { token, cookie }`; the dedup unit an adapter injects is the whole cookie-header resolution (`resolveSessionCookies`).

**8. The cookie naming rule lives in `@awthaq/api`** (`Api.sessionCookieName`), the stratum that already owns both default names, so `hasSessionCookie` can follow the configured mode without importing `@awthaq/core` at runtime (edge-safe). `hasSessionCookie(request, cookie)` takes the mode.

**9. Housekeeping on the same path:** `CurrentUser.current` (core) replaces eleven hand-written "the principal must be a `User`" guards; `Sessions.IssuedSession`/`VerifiedSession` replace seven declarations; `ClientAddress.facts`/`address` build the explicit `ip`/`userAgent` arguments plugin Shapes take (plan 01 Q1: they stay explicit).

## Alternatives considered

- **(a) A whole-chain handler for Path A too.** Rejected: a redeclared record would stop changing the order, against BEH-EA-072 and REQ-EA-203.
- **(b) The precedence as a `Context.Service` a host may override.** Rejected: BEH-EA-072 forbids a second ordering mechanism and no caller needs it.
- **(c) Living in `core`.** Rejected: the tiers are `Api` declarations and `PrincipalResolver` and the registry are server modules.
- **(d) Per-adapter copies kept in step by a shared test table only.** Rejected: the copies would still drift between test runs, as they did.
- **(e) A per-request whole-resolution memo.** Not needed: the per-credential memos and the outage record make a rerun of the chain free, and a whole-chain memo would have to be per tier.

## Consequences

**Positive**: one implementation of credential precedence, tier admission and rotation hand-off; both live bugs fixed and pinned by one table (23 request shapes over three tiers, plus the served Path A parity); Path A's adapter shrinks from 908 to about 230 lines and Path B to about 50; the claimed-credential memo removes a double throttle charge; the cookie name is one rule every reader and renderer follows.

**Negative**: a deployment whose custom `PrincipalResolver` maps a session to a non-`User` now gets 401 on user-tier groups instead of a `NonUserPrincipal` defect (the machine tier still admits it); Path B admits more than before (a fall-through can authorise as the bearer's principal where it was anonymous), which is what Path A already serves; `hasSessionCookie` takes the cookie mode and `Session.rotated` is `{ token, cookie }` (pre-1.0, with a changeset migration line).

## Related

[BEH-EA-065](../behaviors/09-authentication-middleware.md) to [BEH-EA-072](../behaviors/09-authentication-middleware.md), [BEH-EA-153](../behaviors/20-qadi-bridge-path-b.md#beh-ea-153-subjectextractor-runs-session-resolution-on-the-raw-request), [BEH-EA-185](../behaviors/24-nextjs-ssr.md#beh-ea-185-getsession-verifies-the-cookie-against-the-database), [BEH-EA-055](../behaviors/07-sessions.md), [ADR-EA-028](028-infrastructure-error-policy.md) (the outage record), [ADR-EA-015](015-qadi-bridge-path-selection.md) (both bridges resolve the same identity), [ADR-EA-012](012-slots-exclusive-registries-aggregate.md) (the registry).
