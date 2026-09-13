# better-auth — Behavioral Specification (Design by Contract)

This directory is a **conception-level specification** of every feature and
behavior implemented by the [better-auth](https://github.com/better-auth/better-auth)
TypeScript authentication framework (packages read at the `main` branch
checkout used to produce this tree: `better-auth` core, `core`, and all
first-party plugin/adapter/integration packages).

It exists to serve as the **behavioral source of truth** for designing
`awthaq` (an Effect-native reimplementation) without inheriting
better-auth's implementation choices — only its *contracts*: what every
capability requires of its caller, what it guarantees in return, what
invariants it protects, and who is at fault when something goes wrong.

## What this is not

* Not an implementation guide — there is no TypeScript, no SQL, no HTTP
  verb tables, no file/function names from the source.
* Not a port of the README/docs of better-auth — it is a re-derivation of
  behavior *from the source code* into contract form.
* Not exhaustive of internal mechanics — only of externally observable
  behavior and the invariants that protect it.

## Methodology

Every document in this tree uses one shared vocabulary, defined once in
`00-methodology/` and never redefined elsewhere:

| Paper | What it contributes to this spec |
|---|---|
| Meyer, *"Applying 'Design by Contract'"* (1992) | Precondition / postcondition / invariant vocabulary; the Hoare-triple reading of every operation; the client/supplier obligation split; the rule for how extensions (plugins) may specialize a contract. |
| Findler & Felleisen, *"Contracts for Higher-Order Functions"* (2002) | How to write contracts for values that are themselves behavior — hooks, matchers, plugin `init` functions, database adapters — checked lazily, at the point of invocation, as domain→range arrows. |
| Findler & Felleisen, *"A Theory of Contracts"* (2002) | The formal notion of **blame**: every contract violation is attributable to exactly one of the two parties at a boundary (the value's producer or its consumer), and blame survives being re-thrown through composed layers. |

Read `00-methodology/01-design-by-contract.md` →
`02-higher-order-contracts.md` → `03-theory-of-contracts-and-blame.md`, in
that order, before reading anything else in this tree — every later
document assumes that vocabulary without re-explaining it.

## How every behavior is written

```
Operation:      <name of the capability being specified>
Requires:       <precondition(s) — the client's obligation>
Ensures:        <postcondition(s) — the supplier's guarantee>
Invariant:      <what stays true of the affected entity across the call>
On violation:   <error category + blamed party, per 00-methodology/03>
```

Higher-order values (hooks, plugin lifecycle callbacks, adapters) are
additionally written as arrow contracts:

```
<value-name> :  <domain contract>  ->  <range contract>
```

## Directory map

```
better-auth/
├── README.md                        ← you are here
├── 00-methodology/                  ← shared vocabulary (read first)
│   ├── 01-design-by-contract.md
│   ├── 02-higher-order-contracts.md
│   └── 03-theory-of-contracts-and-blame.md
│
├── 01-core-domain/                  ← entities, sessions, credentials, adapter
│   ├── 01-entities-and-invariants.md
│   ├── 02-session-lifecycle.md
│   ├── 03-credentials-and-identity.md
│   └── 04-database-adapter-contract.md
│
├── 02-request-pipeline/             ← the HTTP-facing behavioral layer
│   ├── 01-http-endpoint-contract.md
│   ├── 02-hooks-and-middleware.md
│   ├── 03-cookies-and-csrf.md
│   ├── 04-rate-limiting.md
│   └── 05-error-model-and-blame.md
│
├── 03-plugin-system/                ← the extension mechanism itself
│   ├── 01-plugin-contract.md
│   ├── 02-plugin-composition-and-schema-extension.md
│   └── 03-client-plugin-contract.md
│
├── 04-oauth-and-federation/         ← OAuth2/OIDC as client AND as provider
│   ├── 01-oauth2-core-contract.md
│   ├── 02-social-sign-in.md
│   ├── 03-generic-oauth.md
│   ├── 04-oauth-provider.md
│   ├── 05-sso.md
│   └── 06-scim.md
│
├── 05-mfa-and-verification/         ← secondary factors & identity proofing
│   ├── 01-two-factor.md
│   ├── 02-passkey-webauthn.md
│   ├── 03-email-otp-and-magic-link.md
│   ├── 04-phone-number.md
│   ├── 05-anonymous-and-siwe.md
│   ├── 06-one-time-token.md
│   ├── 07-captcha-and-haveibeenpwned.md
│   └── 08-device-authorization-and-one-tap.md
│
├── 06-authorization/                ← roles, permissions, tenancy
│   ├── 01-access-control.md
│   ├── 02-admin-plugin.md
│   ├── 03-organization-plugin.md
│   └── 04-api-key-plugin.md
│
├── 07-session-extensions/           ← alternate session shapes/carriers
│   ├── 01-multi-session.md
│   ├── 02-custom-session.md
│   ├── 03-bearer-and-jwt.md
│   └── 04-last-login-method.md
│
├── 08-client-sdk/                   ← the contract offered to frontends
│   ├── 01-client-core-contract.md
│   └── 02-framework-bindings.md
│
├── 09-platform-services/            ← cross-cutting infrastructure
│   ├── 01-storage-and-adapters.md
│   ├── 02-i18n.md
│   ├── 03-telemetry.md
│   ├── 04-cli.md
│   └── 05-integrations-misc.md
│
└── GLOSSARY.md
```

## Reading order for a new implementer

```
00-methodology  →  01-core-domain  →  02-request-pipeline  →  03-plugin-system
        │
        └──▶ then any of 04 / 05 / 06 / 07 / 08 / 09 in any order —
             each is a self-contained extension built on 01–03.
```
