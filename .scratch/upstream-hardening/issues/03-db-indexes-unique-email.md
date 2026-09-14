# DB indexes and a real unique constraint on `users.email`

Type: grilling
Status: open

## Question

`packages/sql/src/CoreMigrations.ts:58-143` has zero indexes on
`accounts.userId` and `sessions.userId`, and email uniqueness is enforced
only at the service layer, not as a `users_email_unique` DB constraint —
confirmed by direct read, not just the pasted report.

Decide: whether this ships as a new forward-only migration (consistent
with `shipping-gaps` ticket 03's migrator choice) or folded into
`CoreMigrations.ts`'s existing migration if it hasn't shipped anywhere
yet; the exact index set beyond the two named lookups (e.g. does
`sessions.token`/`secretHash` need an index for the rotation lookup ticket
01 will add?); and how a unique-constraint violation on email surfaces
today at the service layer vs. how it should surface once the DB itself
enforces it (does the service-layer check become redundant, or does it
stay as a friendlier pre-check with the DB constraint as the real
guarantee?).
