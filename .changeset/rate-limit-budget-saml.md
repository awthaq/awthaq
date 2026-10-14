---
"@awthaq/saml": minor
---

SAML and SSO declare their rate-limit rules and spend them through `RateLimits.budget` (plan 06). `saml.login`, `saml.acs`, `saml.slo`, `saml.admin` (per administrator, the admin action is the event's endpoint) and `sso.start` were enforced but never declared or registered; they now appear in `awthaq plugin list --rules`, in `Auth.make(...).manifest.rateLimits` and in `RateLimitsRegistry.registered`, and can be tuned with `RateLimits.overrides(RateLimits.tune(Saml, { login: { limit: 10 } }))`.

- `SamlConfig.config({ rateLimits })` now accepts a partial object: the endpoints it does not name keep their defaults (it used to replace the whole object).
- New exports `SamlConfig.defaultRateLimits` and `SamlConfig.defaultAdminRate`, the one source the config defaults and the rule tables share.
- `SamlConfig.rateLimits.sso` is the budget of the `Sso` plugin's `start` rule.

Migration: rate-limit buckets are renamed (`saml:login:<ip>` becomes `ratelimit:saml.login:ip:<ip>`, `saml:acs:<ip>` becomes `ratelimit:saml.acs:ip:<ip>`, `saml:slo:<ip>` becomes `ratelimit:saml.slo:ip:<ip>`, `saml:admin:<userId>` becomes `ratelimit:saml.admin.admin:user:<userId>`, `sso:start:<ip>` becomes `ratelimit:sso.start:ip:<ip>`), so a deploy resets the live counters once; entries in a shared store expire within one minute. `SamlAdmin.makeAdmin` and `SamlSlo.makeSlo`'s `limiter` dependency are internal and changed shape.
