# Device Authorization

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-13 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is
A plan for a `DeviceAuthorization` plugin implementing the OAuth 2.0 Device Authorization Grant (RFC 8628): an input-constrained device (a smart TV, a CLI, a set-top box) displays a short user code and a URL, the user completes sign-in on a second device (their phone or laptop), and the first device polls until the grant is approved and receives a session or token. It shares the divert/step-up hook-point machinery `archive/PRD.md` §9.3 defines for `Two-Factor` — the first device's poll loop is diverted (pending, then approved or denied) in the same way a password sign-in is diverted to a 2FA challenge.

## Who asks for it
`archive/PRD.md` §17 lists `DeviceAuthorization` as a Phase-3 official plugin with no further elaboration; no worked example or design discussion exists for it in `archive/design/usage-examples-v4.md` or `archive/design/usage-qadi.md`. `research/03-auth-landscape.md`'s TL;DR situates the grant among CLI/TV/agent-facing authentication rather than the browser-first flows the rest of the matrix targets, grouping it with "the 2026 frontier" of agent/MCP identity work ("agent/MCP identity... is the 2026 frontier") rather than with the enterprise-tier B2B methods (SSO, SAML, SCIM) it is filed alongside in the phase table. The realistic asker is a developer tool or a TV/console application that cannot practically render effect-auth's normal browser-based sign-in surface.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase3 |
| Priority | P4 |
| Enabler(s) | E4 — Hook-point step-up/divert wiring |
| Breaking? | Additive: a device-authorization poll is a new endpoint pair (`/device/code`, `/device/token`) and a new divert outcome on top of existing session issuance: nothing about `Sessions`, `Password`, or the MVP contract needs to change shape to add it, per the plugin-as-Layer model in `archive/design/plugins-as-layers.md` where new plugins only add to the merged contract's groups and `RIn`. |

## How it would be expressed
No plugin-class sketch exists in `archive/PRD.md` beyond the one-line mention in §17. A plausible shape, consistent with the `AuthPlugin.Service` pattern in `archive/PRD.md` §9.1 and the divert hook-point machinery §9.3 describes for `Two-Factor`:
```ts
export class DeviceAuthorization extends AuthPlugin.Service<DeviceAuthorization, {
  requestCode(): Effect.Effect<{ deviceCode: string; userCode: string; verificationUri: string; interval: number }>
  poll(deviceCode: string): Effect.Effect<SessionView, DeviceAuthorizationPending | DeviceAuthorizationDenied | DeviceAuthorizationExpired>
  approve(userCode: string): Effect.Effect<void, InvalidUserCode>          // completed on the second, authenticated device
}>()("deviceAuthorization", {
  apiVersion: 1,
  contract: DeviceAuthorizationApi,
  tables: ["device_authorization_grant"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(DeviceAuthorization, {
    dependsOn: [Sessions, Users],
    make: Effect.gen(function*() {
      const config = yield* DeviceAuthorizationConfig   // code length, poll interval, expiry
      /* not yet designed beyond this shape */
      return DeviceAuthorization.of({ requestCode, poll, approve })
    }),
    handlers: DeviceAuthorizationHandlers
  })
}
```
This sketch is speculative in its entirety — it is not drawn from any PRD or cookbook text naming this plugin's shape, only from the general `AuthPlugin.Service` pattern and RFC 8628's well-known three-endpoint structure.

## Worked example
No worked example drafted yet. Neither `archive/design/usage-examples-v4.md` nor `archive/design/usage-qadi.md` carries a Device Authorization section as of this revision.

## What is missing
This is one of the two least-designed rows in the matrix, alongside SCIM. Beyond the one-line mention in `archive/PRD.md` §17, there is no `DeviceAuthorizationApi` contract, no decision on how the divert/poll outcome interacts with the `BeforeSessionIssue` hook point `archive/PRD.md` §13 already plans for `Two-Factor`, no rate-limiting or user-code entropy design, and no research file in this repository treats device-code flow as its primary subject — `research/03-auth-landscape.md` only situates it in passing, alongside the broader agent/MCP-identity trend, as background context rather than as design guidance.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
