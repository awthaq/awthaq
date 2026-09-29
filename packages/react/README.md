# @awthaq/react

React bindings for awthaq: reactive `AtomHttpApi` clients over your contract (CSRF
via [`@awthaq/client`](../client/README.md)), and `Providers` — one atom registry
carrying the session, the qadi subject and every gate. Everything else you use
(`Can`, `useCan`, `useSubject`, ...) is `@qadi/react`'s own export.

Spec: [`spec/behaviors/23-react.md`](../../spec/behaviors/23-react.md)
(BEH-EA-177–184).

## Providers

```tsx
"use client";
import { Providers } from "@awthaq/react";
import { makeQadiAtoms } from "@qadi/react";
import { EvaluationServicesNone } from "@qadi/core";

const atoms = makeQadiAtoms(EvaluationServicesNone);

export function ClientProviders(props: React.ComponentProps<typeof Providers>) {
  return <Providers {...props} atoms={atoms} />;
}
```

`Providers` is a client module (the barrel carries `"use client"` too) and runs
**exactly one** atom registry — `QadiProvider`'s. Seeds, live queries and your own
mutations all share it, so a session-keyed mutation flips `useSubject()` without a
remount.

- **Seeds** (`initialSession`, `initialSubject`) make the first render already
  know what the server knew. They accept the class instance *or* the encoded plain
  object a Server Component can pass as a prop (`@awthaq/next`'s
  `toInitialSession`/`toInitialSubject`); they are decoded and validated, and a
  malformed one is ignored and reported through `onError`. Read once, at mount.
- **`decisions`** takes `dehydrateDecisions(...)` output from the server, hydrated
  against the seeded subject, so a server-decided `<Can>` renders its verdict on
  first paint. Bound to a subject id; nothing hydrates without a trusted seeded
  session and subject. **`initialValues`** is an escape hatch for extra seeds.
- **`onError`** fires once per failure of the session/subject queries (or a bad
  seed); the default is one `console.error`. **`revalidateOnFocus`** (default on)
  re-checks the session when the tab regains focus.

## The subject is gated on the session

`AuthClientAtom.subjectAtom` — what qadi sees — is `undefined` unless the session
is a settled, real one **and** the subject query has settled (BEH-EA-179):

- sign-out makes it `undefined` in the same registry batch — no render shows
  "signed out" while the old user's grants are still live;
- a session-changing mutation refetches both queries at once
  (`reactivityKeys: [SESSION_KEY]`) and the gate stays closed until both settle;
- an anonymous visitor gets `undefined`, not the anonymous DTO the endpoint would
  answer.

```tsx
import { AuthClientAtom, useAuthStatus } from "@awthaq/react";
import { useAtomValue } from "@effect/atom-react/Hooks";

export function Status() {
  const { status, retry } = useAuthStatus(); // Pending | SignedOut | Ready | Failed
  const session = useAtomValue(AuthClientAtom.sessionAtom); // pending | null | SessionDto
  return status._tag === "Failed" ? <button onClick={retry}>Retry</button> : null;
}
```

`useAuthStatus()` tells "still loading" from "the fetch failed" and gives a
`retry` that re-runs both queries without a remount.

## Session model

The session is an opaque `HttpOnly`-cookie session: there is no token to store or
refresh in the browser. `useAtomValue(sessionAtom)` is the `onAuthStateChanged`
analogue (`success(null)` means "confirmed signed out", never a raw 401), and it
revalidates on window focus, so an idle tab learns about expiry or revocation
without acting. Server-side rotation replaces client refresh loops.

## Your own reactive client: `makeReactClient`

`ReactAuthClient`/`ReactSubjectClient` cover only the core session. For your
plugin endpoints, build one over your composed `auth.api` — typed atoms for every
installed group from one call, CSRF header included (`AtomHttpApi` casts a missing
client middleware away, so a client built on it directly 403s every mutation):

```tsx
import { ReactClient } from "@awthaq/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import { auth } from "./auth.ts";

class AppClient extends ReactClient.makeReactClient<AppClient>()("app/Client", {
  api: auth.api,
  baseUrl: "/api/auth", // where the auth routes are mounted; default: same origin
}) {}

// An organization switcher: one query, one mutation that invalidates the session.
export function ActiveOrganization() {
  const active = useAtomValue(AppClient.query("organization", "getActive", {}));
  const setActive = useAtomSet(AppClient.mutation("organization", "setActive"));
  return (
    <button
      onClick={() =>
        setActive({ payload: { organizationId: "org_1" }, reactivityKeys: [ReactClient.SESSION_KEY] })
      }
    >
      {active._tag}
    </button>
  );
}
```

Pass `httpClient` to replace the default `fetch` + CSRF transport (bearer mode, a
test double, extra client middleware).

## Provenance

| Export | Owner |
| --- | --- |
| `Providers`, `useAuthStatus`, `AuthClientAtom.*` (`sessionAtom`, `subjectDtoAtom`, `subjectAtom`, `authStatusAtom`, `ReactAuthClient`, `ReactSubjectClient`), `Subject.toSubject`, `ReactClient.*` (`makeReactClient`, `SESSION_KEY`) | `@awthaq/react` |
| `Can`, `Cannot`, `useCan`, `useSubject`, `useDecision`, `useInvalidate`, `useProjected`, `makeQadiAtoms`, `dehydrateDecisions`, `hydrateDecisions`, `QadiProvider`, ... | passthrough of `@qadi/react` (BEH-EA-184: no awthaq wrapper around evaluation) |

`@qadi/react`, `@qadi/core` and `@effect/atom-react` are peer dependencies, so an
app resolves exactly one copy of the libraries that own the React contexts.

## What this package does not ship

No sign-in, sign-up, user-button or organization-switcher components — ever.
awthaq is headless: build forms against the typed contract errors (BEH-EA-183) and
your organization screens with `makeReactClient`.
