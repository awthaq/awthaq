---
"@awthaq/core": minor
"@awthaq/organization": patch
---

Organization events say who acted (ADR-EA-040, BEH-EA-290, plan 04 F11). Every `auth.organization.*` event except `permissionDenied` gains an optional `actorUserId`, and the audit actor of those events is now that field: `memberAdded`, `memberRemoved`, `memberRoleUpdated`, `invitationAccepted` and the team-member events used to record the *subject* as the actor, so "who removed X" was lost. The system modules publish `actorUserId` from their `Actor` (the user, or the platform administrator; a directory, an identity provider or the application leaves it absent). `auth.organization.created` records the actor rather than the creator (`creatorUserId` is unchanged).

Migration: an event subscriber (a webhook consumer, an `EventRelay` transport) that decodes organization events sees an optional `actorUserId`. An audit query that filtered `actorUserId` on `auth.organization.memberRemoved` and friends to find "what happened to this user" must read the event payload's `userId` instead; `actorUserId` is now the actor.
