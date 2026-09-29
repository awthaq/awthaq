# @awthaq/magic-link

Passwordless sign-in over the `Verification` substrate. Two plugins in one package, sharing one channel-credential step (`Channel`) and declaring no table of their own:

- `MagicLink.MagicLink` — a single-use emailed link. `POST /magic-link/request` (always `202`) and `POST /magic-link/verify`. See [`spec/behaviors/32-magic-link.md`](../../spec/behaviors/32-magic-link.md) (BEH-EA-264–243).
- `EmailOtp.EmailOtp` — a six-digit emailed code, hashed at rest, with a per-code attempt budget and a resend window. `POST /email-otp/request` and `POST /email-otp/verify`. See [`spec/behaviors/33-email-otp.md`](../../spec/behaviors/33-email-otp.md) (BEH-EA-268–247).

Both mount under the shared `"auth"` id (groups `"magicLink"` and `"emailOtp"`), require `Verification`, `Mailer`, `RateLimiter` and the core services, and run the same finishing step as every first factor: find or create the user (only with `allowSignUp`), mark the mailbox verified, run the sign-in gate, the `BeforeSignIn` veto and the MFA divert. A user with a confirmed second factor (`@awthaq/two-factor`) is diverted to `TwoFactorRequired` instead of receiving a session.

## The interstitial page a magic link needs

A link that signs a person in on GET is consumed by the mail scanner or link previewer that dereferences it before the person clicks, so this package has **no GET route**. The mailed URL is `<baseUrl>/magic-link#token=<token>` (`MagicLink.config({ baseUrl })`, or `link` for a custom builder); the fragment is never sent to a server, logged or put in a `Referer`. Your application serves a static page at that path:

```html
<button id="continue">Continue signing in</button>
<script>
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  document.getElementById("continue").onclick = async () => {
    history.replaceState(null, "", location.pathname);
    const res = await fetch("/magic-link/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ token }),
    });
    /* 200: signed in; 410: expired or already used; 401 TwoFactorRequired: ask for the second factor */
  };
</script>
```

## Notes

- `request` answers `202` for every address, known or not, inside its resend window or not; the lookup, the token and the mail run in background work. Rate limits: 30 per source and 5 per address per 15 minutes for links; 10 per address per 15 minutes on verify for codes (`+tag` variants share a bucket).
- An address is mailed at most one artifact per `resendWindow` (default 60 s, `Verification.reserve`). Codes live five minutes with three wrong guesses before the row is burned; links live ten minutes.
- SMS is deliberately not part of this package: an SMS channel would be a separate, restricted plugin recording the method as `sms` ([ADR-EA-021](../../spec/decisions/021-sms-otp-restricted-plugin.md)).
