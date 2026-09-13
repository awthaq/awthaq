# 06 — Invitation lifecycle

**Type:** grilling
**Status:** resolved
**Blocked by:** 03, 04

## Question

Lock the full invitation flow, translating better-auth's feature set
(ticket 00) into effect-auth's own primitives, reusing the existing
`Mailer` port (`packages/ports/src/Mailer.ts`, already `Password`'s own
pattern — settled, no question) for delivery:

- `organization_invitation` fields, token/id shape, `invitationExpiresIn`
  default and config
- invite/accept/reject/cancel/get/list(org)/list(user) semantics and error
  cases (already-member, already-invited + resend, org deleted mid-flight —
  better-auth's own docs don't specify this last one; effect-auth must
  decide)
- `invitationLimit`, `cancelPendingInvitationsOnReInvite`,
  `requireEmailVerificationOnInvitation` (and whether effect-auth's own
  invitation-id generation makes the guessability heuristic even relevant,
  or whether it should just always require verification — the
  richest/safest option)
- Team-targeted invitations (`teamId` on invite, from ticket 04)

## Answer

Resolved directly by `/to-spec`, folded into `.scratch/organization/spec.md`'s
"Implementation Decisions" (§ Invitations). Summary: `organization_invitation`
(opaque non-guessable id via `crypto.randomUUIDv7`, email/inviterId/
organizationId/teamId?/role-array/status/createdAt/expiresAt). Re-invite is a
no-op unless `resend`, or auto-cancel-then-reinvite via
`cancelPendingInvitationsOnReInvite`. `invitationExpiresIn` (default 48h),
`invitationLimit` (default 100), `requireEmailVerificationOnInvitation`
(default off — ids are non-guessable by construction). Deleting an
organization cascades to remove its pending invitations (better-auth leaves
this case undocumented; effect-auth decides cascade-delete).
