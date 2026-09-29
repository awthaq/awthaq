"use client";
// @awthaq/react — Hooks
//
// spec/behaviors/23-react.md, BEH-EA-179/180. EAR-006: the public way to tell
// "still loading" from "the fetch failed" — `Providers` no longer logs from
// render. Everything else a component needs (`useSubject`, `useCan`, ...) is
// `@qadi/react`'s own export (BEH-EA-184).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react/Hooks";
import { authStatusAtom, subjectAtom } from "./AuthClientAtom.ts";

/**
 * The auth pipeline's status (`Pending` / `SignedOut` / `Ready` / `Failed`)
 * and a `retry` that re-runs the session and subject queries without a
 * remount. Must be used under `Providers`.
 */
export const useAuthStatus = () => {
  const status = useAtomValue(authStatusAtom);
  const retry = useAtomRefresh(subjectAtom);
  return { status, retry };
};
