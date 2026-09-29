"use client";
// @awthaq/react — Providers
//
// spec/behaviors/23-react.md, BEH-EA-177/178/179.
//
// RSC-002: `"use client"` — this module owns hooks and context, so a Server
// Component importing `{ Providers }` must receive a client reference instead
// of evaluating it on the server (`index.ts` carries the directive too, for
// the barrel).
//
// EAR-001: exactly ONE atom registry lives under `Providers` — `@qadi/react`'s
// `QadiProvider` builds its own and provides it through `RegistryContext` to
// everything it renders, so an outer `RegistryProvider` here would seed a
// registry that no application code under it ever reaches: a `session`-keyed
// mutation would invalidate the inner registry only, and the subject read
// outside it would never refetch. Everything — the session/subject seeds and
// the live queries — therefore goes through `QadiProvider`'s `initialValues`
// and its registry. `SubjectSync` (inside the provider, so `RegistryContext`
// *is* qadi's registry) forwards `subjectAtom` (`AuthClientAtom.ts`, which
// explains the session gating) into `atoms.subject` from a registry
// subscription rather than a React effect, so qadi's gates re-decide in the
// same registry batch as the session change.
import type { SessionContract, SubjectContract } from "@awthaq/api";
import { useAtomRefresh, useAtomSubscribe } from "@effect/atom-react/Hooks";
import { RegistryContext } from "@effect/atom-react/RegistryContext";
import type { AuthSubject } from "@qadi/core";
import type { QadiAtoms } from "@qadi/react";
import { QadiProvider } from "@qadi/react";
import type * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type * as Atom from "effect/unstable/reactivity/Atom";
import type { ReactNode } from "react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { AuthStatus } from "./AuthClientAtom.ts";
import { authStatusAtom, sessionAtom, subjectAtom, subjectDtoAtom } from "./AuthClientAtom.ts";
import { toSubject } from "./Subject.ts";

export interface ProvidersProps {
  /**
   * BEH-EA-177: seeds `sessionAtom` so the first client render already
   * knows what the server knew — no loading flash for a session the server
   * already resolved. `undefined` (the ordinary case for a page with no
   * server-rendered session data) seeds nothing; `sessionAtom` resolves the
   * normal way, through its own query. Read once, at mount.
   */
  readonly initialSession?: SessionContract.SessionDto | undefined;
  /**
   * The BEH-EA-179 counterpart of `initialSession` — seeds `subjectDtoAtom`
   * identically. A seeded subject without a seeded session is not trusted:
   * the qadi subject stays `undefined` until the live queries settle.
   */
  readonly initialSubject?: SubjectContract.SubjectDto | undefined;
  /** The application's own qadi atom set, from `@qadi/react`'s `makeQadiAtoms`. */
  readonly atoms: QadiAtoms;
  /** Forwarded to `QadiProvider` verbatim — see that component's own doc comment. */
  readonly instrument?: boolean;
  /**
   * EAR-006: called once each time the auth pipeline *enters* the `Failed`
   * state (a session or subject fetch that failed for a reason other than
   * "not signed in"). Default: one `console.error` per failure. Retry through
   * `useAuthStatus().retry`.
   */
  readonly onError?: ((cause: Cause.Cause<unknown>) => void) | undefined;
  /**
   * FAMS-008: re-check the session whenever the tab regains focus or becomes
   * visible, so an idle tab learns about expiry or revocation without the user
   * acting (next-auth's `refetchOnWindowFocus`). On by default; only the
   * session query re-runs, so guarded controls do not blink back to pending —
   * a session that turned out to be gone settles to signed out and closes them.
   */
  readonly revalidateOnFocus?: boolean | undefined;
  readonly children: ReactNode;
}

/** A properly-typed tuple, not a widened `Array<Atom.Atom<unknown> | unknown>` needing `as const` to narrow back. */
const seed = <A,>(atom: Atom.Atom<A>, value: A): readonly [Atom.Atom<A>, A] => [atom, value];

const makeSeeds = (
  initialSession: SessionContract.SessionDto | undefined,
  initialSubject: SubjectContract.SubjectDto | undefined,
) => ({
  values: [
    ...(initialSession === undefined
      ? []
      : [seed(sessionAtom, AsyncResult.success(initialSession))]),
    ...(initialSubject === undefined
      ? []
      : [seed(subjectDtoAtom, AsyncResult.success(initialSubject))]),
  ],
  // EAR-002: a seeded subject is only believed alongside a seeded session.
  subject:
    initialSession !== undefined && initialSubject !== undefined
      ? toSubject(initialSubject)
      : undefined,
});

const reportFailure = (cause: Cause.Cause<unknown>): void => {
  console.error("[@awthaq/react] the session/subject queries failed:", cause);
};

const SubjectSync = ({
  atoms,
  onError,
  revalidateOnFocus,
}: {
  readonly atoms: QadiAtoms;
  readonly onError: ((cause: Cause.Cause<unknown>) => void) | undefined;
  readonly revalidateOnFocus: boolean;
}): null => {
  const registry = useContext(RegistryContext);

  const syncSubject = useCallback(
    (subject: AuthSubject | undefined) => registry.set(atoms.subject, subject),
    [registry, atoms],
  );
  useAtomSubscribe(subjectAtom, syncSubject, { immediate: true });

  // EAR-006: report a failure on the transition into `Failed`, not per render
  // and not per subscription — the ref outlives StrictMode's simulated
  // remount, so the same failure is never reported twice.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const reported = useRef<Cause.Cause<unknown> | undefined>(undefined);
  const reportStatus = useCallback((status: AuthStatus) => {
    if (status._tag !== "Failed") {
      reported.current = undefined;
      return;
    }
    if (reported.current === status.cause) return;
    reported.current = status.cause;
    (onErrorRef.current ?? reportFailure)(status.cause);
  }, []);
  useAtomSubscribe(authStatusAtom, reportStatus, { immediate: true });

  const revalidate = useAtomRefresh(sessionAtom);
  useEffect(() => {
    if (!revalidateOnFocus) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revalidateOnFocus, revalidate]);

  return null;
};

export const Providers = ({
  initialSession,
  initialSubject,
  atoms,
  instrument,
  onError,
  revalidateOnFocus,
  children,
}: ProvidersProps): ReactNode => {
  // Once, not per render: `QadiProvider` re-syncs `atoms.subject` to its
  // `subject` prop whenever that prop's identity changes, so a freshly
  // allocated seed on every parent re-render would overwrite the live
  // subject with a stale one.
  const [seeds] = useState(() => makeSeeds(initialSession, initialSubject));
  return (
    <QadiProvider
      atoms={atoms}
      subject={seeds.subject}
      initialValues={seeds.values}
      instrument={instrument ?? false}
    >
      <SubjectSync atoms={atoms} onError={onError} revalidateOnFocus={revalidateOnFocus ?? true} />
      {children}
    </QadiProvider>
  );
};
