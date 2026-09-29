# React Bindings
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-23 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): BEH-EA-177's example replaced with `Providers`' real props (`initialSession`, `initialSubject`, `decisions`, `atoms`) and the two-atom design noted; banner given implementation pointers; requirement texts unchanged (RSC-008, CCR-EA-006) |
---

> Implemented in `@awthaq/react` (`AuthClientAtom.ts`, `Subject.ts`, `Providers.tsx`; tests `packages/react/test`) — the code and tests behind each BEH id are mapped in [`spec/traceability.md`](../traceability.md) §5. BEH-EA-177, 178 and 179 are the package's own; BEH-EA-180 through 184 are `@qadi/react` re-exports. Its BDD scenarios are `@skip @unwired`.

## BEH-EA-177: `RegistryProvider` seeds the session atom for SSR

```ts
// app/layout.tsx (a Server Component) passes the server's session and subject as plain props
<Providers initialSession={session} initialSubject={subject} decisions={decisions} atoms={qadiAtoms}>
  {children}
</Providers>
```

```text
REQUIREMENT: `RegistryProvider` MUST be seeded with the server-resolved
             session as the session atom's initial value; the first client
             render MUST NOT show a loading state for a session the server
             already knew.
```

**Implementation (RSC-005, EAR-001).** The shipped `Providers` is a `"use client"` component that seeds `sessionAtom` from `initialSession` and, separately, `subjectDtoAtom` from `initialSubject` (BEH-EA-179's second atom); both may be the class instance or its encoded plain object, which is what a Server Component can pass across the boundary, and a malformed seed seeds nothing and is reported through `onError`. It runs exactly one atom registry (`QadiProvider`'s). Decision hydration (`decisions`, BEH-EA-192) is a further prop, not a wrapper component.

`usage-qadi.md` §12.1 and `usage-examples-v4.md` §12.2 both wire the identical seeding pattern. Without it, every page load would show a momentary "checking session" flash before the first client-side fetch resolves — seeding the atom directly with `AsyncResult.success(initialSession)` means the session the server rendered with is the session the client starts with, no round-trip required.

_Previous: [BEH-EA-176](22-client-effect.md#beh-ea-176-a-promise-facade-is-opt-in-never-a-second-client) | Next: [BEH-EA-178](23-react.md#beh-ea-178-mutations-invalidate-the-session-reactivity-key)_

## BEH-EA-178: Mutations invalidate the session reactivity key

```ts
run({ payload: { email, password }, reactivityKeys: ["session"] })
```

```text
REQUIREMENT: A mutation that changes the current session (sign-in, sign-out,
             role assignment, accepting an invite) MUST pass `["session"]` as
             its `reactivityKeys`; `sessionAtom` MUST NOT require an explicit
             manual refetch call from application code after such a mutation.
```

`usage-examples-v4.md` §12.3 shows the mechanism: `sessionAtom = AuthClient.query("session", "current", { reactivityKeys: ["session"] })`, and any mutation tagged with the same key triggers its refetch automatically. This is what makes "sign-in invalidates `[\"session\"]`; the session atom refetches; `subject` changes; every `Can` re-decides" (§12.4) true without application code wiring the refetch itself.

_Previous: [BEH-EA-177](23-react.md#beh-ea-177-registryprovider-seeds-the-session-atom-for-ssr) | Next: [BEH-EA-179](23-react.md#beh-ea-179-qadiprovider-is-fed-by-the-sessions-subject-field)_

## BEH-EA-179: `QadiProvider` is fed by the session's `subject` field

```ts
const toSubject = (v: SessionView | undefined) =>
  v && makeSubject({ id: v.subject.id, roles: v.subject.roles, permissions: v.subject.permissions as never, attributes: v.subject.attributes })
```

```text
REQUIREMENT: The React provider tree MUST derive qadi's `subject` prop from
             `sessionAtom`'s current value, not from a second, independently
             fetched source; when the session becomes `undefined` (sign-out),
             `subject` MUST become `undefined` in the same render.
```

`usage-qadi.md` §12.1 states the consequence directly: "Sign-out sets `subject` to `undefined` and every gate closes at once." Deriving `subject` from the one session atom, rather than from a parallel fetch, is what makes that guarantee hold — there is no window where the session has cleared but a stale subject still grants access in a `Can` gate somewhere on the page.

**Implementation (EAR-001/EAR-002).** `SessionView` does not carry a `subject` field (BEH-EA-026's single combined struct is not built; the subject is its own `SubjectApi` endpoint — `@awthaq/api`'s `SubjectContract`). The requirement is met by making `sessionAtom` the *gate* over that endpoint's data: `AuthClientAtom.subjectAtom` is `undefined` unless `sessionAtom` is a settled, real (`Success`, non-`null`) session **and** `subjectDtoAtom` is a settled `Success` (not `waiting`). Both queries carry `reactivityKeys: ["session"]`, so a session-changing mutation refetches both in one registry tick and the gate stays closed until both settle; sign-out (`success(null)`) closes it in the same registry batch. An anonymous visitor's `/subject` answer (an anonymous `SubjectDto`) is never handed to qadi. `Providers` runs exactly one registry (`QadiProvider`'s) and forwards `subjectAtom` into `atoms.subject` from a registry subscription, not a React effect.

_Previous: [BEH-EA-178](23-react.md#beh-ea-178-mutations-invalidate-the-session-reactivity-key) | Next: [BEH-EA-180](23-react.md#beh-ea-180-a-stale-decision-is-not-a-decision)_

## BEH-EA-180: A stale decision is not a decision

```ts
<Can policy={canDeleteProject} resource={resource} pending={<Spinner />} fallback={(deny) => <Why reason={deny.reason} />}>
  <DeleteButton id={resource.id} />
</Can>
```

```text
REQUIREMENT: While a policy re-evaluation is in flight, `Can`/`Cannot`/
             `useCan` MUST render the `pending` state, never the previous
             verdict held over; application code reading authorization state
             MUST go through these gates or `currentDecision`, never through
             the raw async result of a manual query.
```

`usage-qadi.md` §16 states this as one of the rules that keep the two libraries honest: "a stale decision is not a decision." Rendering the old verdict during re-evaluation would let a UI briefly show a delete button for a permission that has just been revoked — the `pending` prop exists exactly so that window renders a spinner instead of a false grant.

_Previous: [BEH-EA-179](23-react.md#beh-ea-179-qadiprovider-is-fed-by-the-sessions-subject-field) | Next: [BEH-EA-181](23-react.md#beh-ea-181-useinvalidate-re-decides-every-mounted-gate)_

## BEH-EA-181: `useInvalidate` re-decides every mounted gate

```ts
const invalidate = useInvalidate()
run({ params: { token }, reactivityKeys: ["session"] }).then(invalidate)
```

```text
REQUIREMENT: After a mutation that changes what a subject may do (accepting an
             invite, being granted a role), the application MUST call
             `useInvalidate()` so every currently mounted policy gate re-runs
             its decision against the refreshed subject.
```

`usage-qadi.md` §12.3 pairs the session refetch with `invalidate()` explicitly: "the session refetch updates roles; invalidate() re-decides every mounted gate against the new subject." Without the explicit call, a component whose gate decided "deny" before the invite was accepted would keep showing that stale denial until it happened to remount, rather than reflecting the grant the mutation just produced.

_Previous: [BEH-EA-180](23-react.md#beh-ea-180-a-stale-decision-is-not-a-decision) | Next: [BEH-EA-182](23-react.md#beh-ea-182-useprojected-trims-what-a-component-can-render)_

## BEH-EA-182: `useProjected` trims what a component can render

```ts
const view = useProjected(canReadProject, resource)   // only the fields the policy grants
```

```text
REQUIREMENT: A component rendering fields conditioned on a read policy MUST
             read them through `useProjected`, which returns only the fields
             the current decision grants; it MUST NOT read the full resource
             object and conditionally hide fields in JSX.
```

`usage-examples-v4.md` §12.4 and `usage-qadi.md` §12.2 show identical usage. Hiding a field in JSX still puts its value in the rendered component's props and, for a server-rendered tree, in the HTML the browser receives — `useProjected` withholds the field from the data itself, which is the client-side half of the same "decide against attributes, project content" discipline file 24 states for the Next.js server render.

_Previous: [BEH-EA-181](23-react.md#beh-ea-181-useinvalidate-re-decides-every-mounted-gate) | Next: [BEH-EA-183](23-react.md#beh-ea-183-typed-errors-drive-the-sign-in-form-not-strings)_

## BEH-EA-183: Typed errors drive the sign-in form, not strings

```ts
{AsyncResult.isFailure(result) && result.cause._tag === "InvalidCredentials" && <p>Wrong email or password.</p>}
```

```text
REQUIREMENT: A form component reacting to a mutation's failure MUST branch on
             the failure's `_tag`; it MUST NOT pattern-match on an error
             message string to decide what to render.
```

`usage-examples-v4.md` §12.3 shows this directly on the sign-in form. Branching on `_tag` ties the UI to the same typed union the contract declares (BEH-EA-172), so a later change to the error's message text — a copy edit, a localization pass — cannot silently break which UI branch renders, the way a string-match would.

_Previous: [BEH-EA-182](23-react.md#beh-ea-182-useprojected-trims-what-a-component-can-render) | Next: [BEH-EA-184](23-react.md#beh-ea-184-one-evaluation-path-across-server-client-and-tests)_

## BEH-EA-184: One evaluation path across server, client, and tests

```text
REQUIREMENT: `RequirePermission`, `guard`, `enforce`, the React gates
             (`Can`/`useCan`/…), and the Promise facade MUST all resolve a
             decision by calling the same qadi evaluator; awthaq's React
             bindings MUST NOT implement a second, client-only evaluation
             shortcut for any policy.
```

`usage-qadi.md` §16 states this as the last of its six house rules: "one evaluation path... Do not write a second check." The temptation in a React binding specifically is to special-case simple policies (`hasRole("admin")`) as a client-side boolean shortcut for snappier UI — but doing so would mean a policy could evaluate differently in a gate than it would through `check` or `enforce`, silently forking the one property (`usage-qadi.md` §16) the whole bridge exists to guarantee.

_Previous: [BEH-EA-183](23-react.md#beh-ea-183-typed-errors-drive-the-sign-in-form-not-strings) | Next: [BEH-EA-185](24-nextjs-ssr.md#beh-ea-185-getsession-verifies-the-cookie-against-the-database)_
