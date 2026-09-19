// @awthaq/react — Providers
//
// spec/behaviors/23-react.md, BEH-EA-177/178/179.
//
// `@qadi/react@0.7.0`'s `QadiProvider` provides its own registry through
// `@effect/atom-react`'s `RegistryContext`, becoming the ambient registry
// for everything rendered as its `children` — which is where `Providers`
// places its own `children`. So the outer `RegistryProvider` here seeds an
// *outer* registry that only `SubjectBridge`'s own `useAtomValue(subjectDtoAtom)`
// read (evaluated before `QadiProvider` exists, to compute the `subject` prop
// `QadiProvider` needs) ever sees, and `QadiProvider`'s `initialValues` prop
// is given the same seed pairs so its own (now-ambient-for-`children`)
// registry has `sessionAtom`/`subjectDtoAtom` pre-seeded too — otherwise a
// consumer under `Providers` would see `sessionAtom` resolve from scratch,
// defeating BEH-EA-177's whole point. (See `Subject.ts`'s header comment,
// and `AuthClientAtom.ts`'s, for why the session and subject are two atoms,
// not one combined query.)
import type { SessionContract, SubjectContract } from "@awthaq/api";
import { RegistryProvider } from "@effect/atom-react/RegistryContext";
import { useAtomValue } from "@effect/atom-react/Hooks";
import type { InitialValues, QadiAtoms } from "@qadi/react";
import { QadiProvider } from "@qadi/react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type * as Atom from "effect/unstable/reactivity/Atom";
import type { ReactNode } from "react";
import { sessionAtom, subjectDtoAtom } from "./AuthClientAtom.ts";
import { toSubject } from "./Subject.ts";

export interface ProvidersProps {
  /**
   * BEH-EA-177: seeds `sessionAtom` so the first client render already
   * knows what the server knew — no loading flash for a session the server
   * already resolved. `undefined` (the ordinary case for a page with no
   * server-rendered session data) seeds nothing; `sessionAtom` resolves the
   * normal way, through its own query.
   */
  readonly initialSession?: SessionContract.SessionDto | undefined;
  /** The BEH-EA-179 counterpart of `initialSession` — seeds `subjectDtoAtom` identically. */
  readonly initialSubject?: SubjectContract.SubjectDto | undefined;
  /** The application's own qadi atom set, from `@qadi/react`'s `makeQadiAtoms`. */
  readonly atoms: QadiAtoms;
  /** Forwarded to `QadiProvider` verbatim — see that component's own doc comment. */
  readonly instrument?: boolean;
  readonly children: ReactNode;
}

const SubjectBridge = ({
  atoms,
  instrument,
  initialValues,
  children,
}: {
  readonly atoms: QadiAtoms;
  readonly instrument?: boolean | undefined;
  readonly initialValues: InitialValues;
  readonly children: ReactNode;
}): ReactNode => {
  const subjectResult = useAtomValue(subjectDtoAtom);
  // `QadiProvider.subject`'s own contract (`@qadi/react`'s `QadiProviderProps`
  // doc comment) is binary — `AuthSubject | undefined`, `undefined` meaning
  // "still loading" — so a genuine fetch failure has nowhere honest to go
  // through that prop; it is not silently treated as equivalent to
  // "loading" without at least being surfaced somewhere a developer would
  // see it, unlike the ordinary "not resolved yet" case below.
  if (AsyncResult.isFailure(subjectResult)) {
    console.error(
      "[@awthaq/react] subjectDtoAtom failed to resolve — QadiProvider will see `subject: undefined` " +
        "(indistinguishable from still-loading) until it succeeds:",
      subjectResult.cause,
    );
  }
  const dto = AsyncResult.isSuccess(subjectResult) ? subjectResult.value : undefined;
  return (
    <QadiProvider
      atoms={atoms}
      subject={toSubject(dto)}
      initialValues={initialValues}
      instrument={instrument ?? false}
    >
      {children}
    </QadiProvider>
  );
};

/** A properly-typed tuple, not a widened `Array<Atom.Atom<unknown> | unknown>` needing `as const` to narrow back. */
const seed = <A,>(atom: Atom.Atom<A>, value: A): readonly [Atom.Atom<A>, A] => [atom, value];

export const Providers = ({
  initialSession,
  initialSubject,
  atoms,
  instrument,
  children,
}: ProvidersProps): ReactNode => {
  const initialValues = [
    ...(initialSession === undefined
      ? []
      : [seed(sessionAtom, AsyncResult.success(initialSession))]),
    ...(initialSubject === undefined
      ? []
      : [seed(subjectDtoAtom, AsyncResult.success(initialSubject))]),
  ];
  return (
    <RegistryProvider initialValues={initialValues}>
      <SubjectBridge atoms={atoms} instrument={instrument} initialValues={initialValues}>
        {children}
      </SubjectBridge>
    </RegistryProvider>
  );
};
