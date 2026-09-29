# ADR-EA-021: SMS OTP Is a Separate, Explicitly Restricted Plugin over the Email-OTP Substrate, Deferred

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-021 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — plugin deferred; substrate and vocabulary implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (SOS-006, SOS-001, SOS-005; wayfinder ticket 05 §3) |

---

## Context

An SMS-delivered one-time code is the factor users ask for and the one NIST SP 800-63B-4 restricts: out-of-band SMS is exposed to SIM-swap and number-porting attacks, so a verifier must offer an alternative, must be able to assess the risk of the number, and should not treat it as the only or default factor. Wayfinder ticket 05 §3 split the question: the *substrate* (a short numeric code, hashed, attempt-budgeted, resend-windowed, over `Verification`) is uncontroversial and ships now; the *SMS channel* is a product and compliance call. `research/07-passwords-2fa.md` (Q58, §252) reached the same place.

## Decision

1. **The substrate ships; the SMS plugin does not (yet).** `@awthaq/magic-link`'s `EmailOtp` is the channel-OTP substrate (BEH-EA-271 to 274): six digits minted inside `Verification`, hashed at rest, a per-code attempt budget, a resend window, per-source and per-address rate limits. SMS is *a channel over that substrate*, not a new mechanism.
2. **When SMS ships it is a separate plugin, `@awthaq/sms-otp`, explicitly degraded.** Never bundled into `two-factor` or `email-otp`; TOTP and passkeys stay the documented first choice.
3. **It can never be an account's only factor.** Enrolment is refused unless the account already has a confirmed non-restricted factor, and disabling the last non-restricted factor is refused while SMS remains — enforced at enrol time, not documented.
4. **The operator must acknowledge the restriction.** The plugin's configuration requires `acknowledgeRestricted: true`; without it the layer fails to build with a typed configuration error, so restricted status is a decision someone made, not a default.
5. **It is recorded as `sms`, never `otp`.** The session's `amr` (RFC 8176) names the method, so `Assurance` (SOS-005, BEH-EA-258) can rank it: `sms` alone never raises a session above aal1, `pwd + sms` reaches aal2 only with the `restricted` flag set, and `Assurance.satisfies` ignores a restricted factor unless the caller opts in. `AuthMethod` already includes `sms` so no plugin needs a core change.
6. **Its use is a distinguishable audit event**, `auth.factor.smsUsed` (added to the event registry when the plugin ships), so an application can see and alert on restricted-factor usage.
7. **A SIM-swap risk check is a documented extension point, not shipped.** An optional `SimSwapRiskCheck` port, consulted before a code is sent, lets an application plug in a carrier or fraud API; no implementation is provided.

## Alternatives considered

**Ship SMS now inside `EmailOtp` / `two-factor`.** Rejected: it would make the restricted authenticator a default-adjacent option in the plugins most compositions install.

**Never ship SMS.** Not decided against; whether awthaq should offer SMS at all, given the guidance it cites, is the maintainers' call. This ADR fixes the posture *if* it does and keeps the door open at the cost of one small, already-shipped vocabulary.

## Consequences

**Positive**: the restricted-factor risk is designed once, before any SMS code exists; policies can rank a factor before it is installable; the substrate is reused rather than duplicated.

**Negative**: applications wanting SMS today must build it themselves over `EmailOtp`'s pattern (the `Mailer` port is the analogue of an SMS gateway); the plugin's exact package surface is not fixed by this ADR.
