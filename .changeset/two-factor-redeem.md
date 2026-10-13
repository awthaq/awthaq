---
"@awthaq/two-factor": minor
---

`SecondFactor.consumeChallenge` is replaced by `SecondFactor.redeemChallenge(challengeId, use)`: the challenge, the code check and the session commit in one `Verification.redeem` transaction (BEH-EA-262, ADR-EA-020 rev 1.2, ADR-EA-039). A wrong code, a lockout or a suspension still spends the challenge (a wrong code re-issues `attempt + 1`); an outage while issuing the session gives the challenge back, so the person retries the code instead of restarting from the first factor.

Migration: `consumeChallenge(id)` becomes `redeemChallenge(id, Effect.succeed)`. A custom `SecondFactorShape` implementation replaces `consumeChallenge` with `redeemChallenge`.
