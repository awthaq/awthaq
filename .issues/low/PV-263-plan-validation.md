---
ID: "PV-263"
Title: "BEH-EA-179 says the qadi subject is derived from sessionAtom's value with no second fetch; subjectAtom actually gates on sessionAtom but reads roles/permissions from GET /subject"
Level: low
Category: "docs"
Status: open
Package: "react"
Source: "packages/react/src/AuthClientAtom.ts:118"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-263 — the qadi subject is not derived from sessionAtom's value alone

`LOW` · `docs` · `react` · found while wiring `features/features/07-client-integration/23-react.feature` (P20a)

Status: **open**

## Summary

`spec/behaviors/23-react.md` BEH-EA-179 and REQ-EA-506 say `subject` is `toSubject(sessionAtom's value)` and "no second, independently fetched source is queried". The shipped `subjectAtom` (EAR-002) uses `sessionAtom` only as a gate (the subject exists only while the session is a settled, real one); the subject's roles and permissions come from a second query, `GET /subject` (`subjectDtoAtom`), because a session carries none. The property that matters (sign-out clears the subject in the same registry batch) is wired as REQ-EA-507; REQ-EA-506 stays `@skip` citing this issue.

## Recommended fix

Amend BEH-EA-179 / REQ-EA-506 to state the gate-plus-`/subject` design (or fold roles/permissions into the session DTO, which would contradict the api/qadi layering `SubjectApi.ts` documents).

## Comments

_Triage notes and discussion append here._
