# @awthaq/passkey

The Passkey plugin over the `WebAuthn` port: registration and authentication ceremonies (`/passkey/register/*`, `/passkey/authenticate/*`), credential listing/management, reauthentication (`/passkey/reauthenticate/*`) and a `ChallengeStore` (memory, SQL and stateless cookie variants). Mounted under `"auth"`, group `"passkey"`. `PasskeyReauthRequired` is this plugin's step-up error.

See [`spec/behaviors/17-passkey.md`](../../spec/behaviors/17-passkey.md) (BEH-EA-129–136).
