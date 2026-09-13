# 14 — Invitation lifecycle

**What to build:** `organization_invitation` and the full invite→accept/
reject/cancel round trip, using the existing `Mailer` port for delivery
(`teamId` on invite is accepted here as an optional field but only
meaningfully wired once ticket 16's teams exist — see ticket 17).

**Blocked by:** 11, 12.

**Status:** done

- [x] `organization_invitation` table/persistence module: `id` (opaque,
      `crypto.randomUUIDv7`), `email`, `inviterId`, `organizationId`,
      `teamId?`, `role` (array), `status`
      (`pending`/`accepted`/`rejected`/`canceled`/`expired`), `createdAt`,
      `expiresAt`; both layers
- [x] `invite`: re-inviting an already-pending email is a no-op unless
      `resend`, or auto-cancels-then-reinvites when
      `cancelPendingInvitationsOnReInvite` is configured; inviting an
      existing member cancels their prior pending invitations; sends via
      `Mailer.send({..., template: "organization-invite", ...})`
- [x] `accept` requires the accepting session's own email to match the
      invitation's, and creates the resulting membership (reusing ticket
      12's membership-creation path, respecting `membershipLimit`);
      `reject`/`cancel`/`get`/`listForOrganization`/`listForUser` (caller's
      own verified email only) all exist
- [x] `invitationExpiresIn` (default 48h), `invitationLimit` (default 100),
      `requireEmailVerificationOnInvitation` (default off) config knobs
      enforced
- [x] Deleting an organization (ticket 11) cascades to remove its pending
      invitations — extend that ticket's `delete` here
- [x] Publishes `auth.organization.invitationCreated`/`accepted`/
      `rejected`/`canceled` audit events
- [x] Domain + wire-level tests: full invite→accept round trip creating a
      real membership; resend no-op; already-a-member cancels prior
      invite; expiry; each config knob

## Result

Done. `InvitationRecords.ts` persists `organization_invitation` (opaque
`crypto.randomUUIDv7` id, email/inviterId/organizationId/teamId?/role-array/
status/createdAt/expiresAt), both layers. `Organization.ts`'s `invite`
enforces `invitationLimit` (pending count by inviter), handles the
resend/no-op/cancelPendingInvitationsOnReInvite matrix, cancels a prior
pending invite when the invitee is already a member, and sends via the
existing `Mailer` port. `acceptInvitation` checks expiry (marking the row
`expired` on the way out), email match, `requireEmailVerificationOnInvitation`,
and `membershipLimit`, then creates the membership via the same
`MembershipRecords.create` path ticket 12 already owns.
`rejectInvitation`/`cancelInvitation`/`getInvitation`/
`listInvitationsForOrganization`/`listInvitationsForUser` all exist.
`Organization.delete` now also cascades `InvitationRecords.removeAllForOrganization`.
`getFull` (ticket 11's own deferred field) now returns pending invitations.
Six new `auth.organization.invitation*` events added to `AuthEvents.ts`'s
closed union. Covered by `InvitationRecords.test.ts` (both layers) and an
extensive `Organization.test.ts` domain-level suite (full invite→accept
round trip against a real `Users` record, reject, cancel+permission-denied,
resend no-op vs resend, cancel-on-reinvite, already-member cancels prior
invite, expiry via `TestClock`, email-mismatch, `invitationLimit`, `getFull`
inclusion) plus a wire-level invite→list→cancel test in `AuthHttp.test.ts`.

**Design decision**: `acceptInvitation`/`rejectInvitation`/
`listInvitationsForUser` require a genuine `Users` record backing the
caller (`users.findById(callerId).pipe(Effect.orDie)`) to read their real
email — a defect (not a typed error) if the caller's principal doesn't
correspond to a real user, the same "internal invariant, not a normal-flow
error" posture `Organization.ts` already uses elsewhere (e.g. "organization
vanished between check and write"). This means the wire-level test suite's
synthetic-principal-without-a-real-Users-row pattern (used everywhere else
in this plugin's tests) can't exercise `accept`/`reject` at the HTTP layer
directly — that round trip is proven at the domain level instead, where a
real `Users.create` backs the caller.
