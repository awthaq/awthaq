---
"@awthaq/organization": minor
"@awthaq/core": minor
---

Invitations are a system module, `OrganizationInvitations` (`find`, `findByToken`, `listForOrganization`, `listPendingForOrganization`, `listForUser`, `listForEmail`, `holdsToken`, `create`, `accept`, `reject`, `cancel`), exposed by `Organization.layer` (ADR-EA-040). It owns the emailed capability token (MTI-010), the expiry, the per-inviter quota, the team rules, role names and the `Bound`, the veto and observe points, the mail, and the transaction of an acceptance. The authorized `invite`, `acceptInvitation`, `rejectInvitation`, `cancelInvitation` and the reads delegate; the invitee's acts take the invitee's user id and no actor.

Behaviour: accepting an invitation is one transaction (the membership, the status and the team membership), so a failure no longer leaves a membership with a pending invitation; an invitation cancelled by a re-invite or by the member check publishes `auth.organization.invitationCanceled`; one found expired on acceptance publishes the new core event `auth.organization.invitationExpired` (`@awthaq/core`); a membership created by accepting an invitation (and a team membership it adds) now fires `AfterAddMember` / `AfterAddTeamMember`; a resent invitation runs `AfterCreateInvitation` again; the veto of `cancelInvitation` runs after the caller is authorized (it ran first), while `accept` and `reject` keep veto-first.

Migration: an event subscriber that switches exhaustively on `auth.organization.*` adds `invitationExpired`. A tap on `AfterAddMember` or `AfterAddTeamMember` now also sees invitation acceptances. `Organization.layer` additionally requires `Mailer` and `Users` for the exposed module (both were already required by the plugin).
