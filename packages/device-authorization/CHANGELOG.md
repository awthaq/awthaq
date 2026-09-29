# @awthaq/device-authorization

## 0.2.0

### Minor Changes

- 3514b28: The OAuth 2.0 device authorization grant (RFC 8628) ships as `@awthaq/device-authorization`, and `awthaq login` uses it (DAG-002, DAG-004, DAG-005; BEH-EA-299 to BEH-EA-307).
  
  - `@awthaq/device-authorization`: `POST /device/code` and `POST /device/token` (the polling states `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, at-most-once redemption), `POST /device/verify` / `approve` / `deny` for the page a signed-in user approves on, public clients from configuration or an operator's `registerClient`, hashed user and device codes, per-address, per-session and per-client rate limits, a `BeforeDeviceApproval` veto, erasure and export contributions, and `purgeExpired`. The minted session is an ordinary bearer session carrying the approving session's `amr`. Tables `device_authorization_grant` and `device_authorization_client` (append-only migrations); Postgres-tested.
  - `@awthaq/cli`: `awthaq login` without a token runs the device flow (a code and URL on stderr, a browser opened unless `--no-browser`, polling with +5 seconds on every `slow_down`); `--client-id` names the client (default `awthaq-cli`, which the plugin registers by default). A server without the plugin exits 9 naming it; a denied or expired request exits 8. `--token` and `AWTHAQ_TOKEN` are unchanged.
  - `@awthaq/core`: two audit events, `auth.deviceAuthorization.approved` and `.denied`.
  - `@awthaq/two-factor`: the session gate no longer diverts an `amr` that already records `mfa` (only this plugin's own completed challenge writes it), so a device approved from a session that proved a second factor is not asked again.
  - `@awthaq/api`: `Api.BackChannel`, an annotation for credential-in-the-request endpoints called by non-browser clients (`apikey.token`, the device `code`/`token` pair): they deliberately carry no `CsrfProtection`, and `awthaq doctor` no longer flags them as unprotected mutating endpoints (`@awthaq/api-key` annotates its token group).

### Patch Changes

- Updated dependencies
- Updated dependencies [d7351b7]
- Updated dependencies [8dd72b6]
- Updated dependencies [3514b28]
- Updated dependencies [cb155d4]
- Updated dependencies [f831b6c]
- Updated dependencies [e073887]
- Updated dependencies
- Updated dependencies [4688890]
- Updated dependencies
- Updated dependencies [4cd6174]
- Updated dependencies [5d5b3c6]
- Updated dependencies
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/sql@0.2.0
