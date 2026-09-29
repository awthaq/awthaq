# @awthaq/client

## 0.2.0

### Minor Changes

- 8dd72b6: A native client's first sign-in no longer needs the CSRF warm-up: an unsafe request that carries no `Cookie` header at all skips the double-submit pair.
  
  CSRF defends ambient browser credentials, and a request with no `Cookie` header (and no `Authorization`) carries none, so `CsrfProtection` no longer demands the `__Host-csrf` pair of it, which a cookie-less client could only obtain through a warm-up `GET` and a cookie jar. The site checks still run, in a stricter form that guards login CSRF: `Sec-Fetch-Site` must be `same-origin` or `none`; `same-site` is admitted only with an allow-listed `Origin`; `cross-site`, a foreign `Origin` or `Origin: null` are refused; with neither header the caller is a non-browser and is admitted. A request carrying any cookie (a stale session cookie, an analytics cookie) keeps the full double-submit check. `CsrfConfig.requireTokenWithoutCookies: true` withdraws the exemption; `@awthaq/client` adds `CsrfClientNative`, the client half for a program with no cookie jar (no cookie read, no `CsrfRejected` retry). BEH-EA-077 (cookie-less exemption and threat model), BEH-EA-079.
  
  Migration: none required. A deployment that authenticates by an ambient non-cookie credential (mTLS client certificates, an intranet network position, HTTP Basic) or that must cover a browser sending neither `Sec-Fetch-Site` nor `Origin` sets `requireTokenWithoutCookies: true`.

### Patch Changes

- Updated dependencies
- Updated dependencies [d7351b7]
- Updated dependencies [3514b28]
- Updated dependencies [cb155d4]
- Updated dependencies [f831b6c]
- Updated dependencies [e073887]
- Updated dependencies
- Updated dependencies [4688890]
- Updated dependencies
- Updated dependencies [4cd6174]
- Updated dependencies
  - @awthaq/core@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/passkey@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
