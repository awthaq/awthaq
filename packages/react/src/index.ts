"use client";
// @awthaq/react — Client
//
// RSC-002: `"use client"` on the barrel — it re-exports `@qadi/react`'s hooks and
// `Providers`, so a Server Component importing anything from here gets client
// references rather than evaluating hook-bearing modules on the server.
//
// React bindings: reactive AtomHttpApi clients over the awthaq contract (CSRF via @awthaq/client) and Providers with QadiProvider integration.
//
// Implemented: AuthClientAtom.ts (spec/behaviors/22-client-effect.md's
// BEH-EA-169 reactive `AtomHttpApi.Service` alternative; BEH-EA-177/178),
// Subject.ts (BEH-EA-179's `AuthSubject` derivation), Providers.tsx
// (BEH-EA-177/178/179's single-registry `QadiProvider` composition), Hooks.ts
// (EAR-006's `useAuthStatus`),
// ReactClient.ts (BE-004: `makeReactClient`, the CSRF-carrying reactive
// client factory over an application's own composed api).
//
// BEH-EA-180 through 184 (`Can`/`Cannot`/`useCan`/`useInvalidate`/
// `useProjected`/`useSubject`/`useDecision`/etc.) are `@qadi/react`'s own
// exports, re-exported here verbatim (by name, BO-007) — BEH-EA-184 explicitly forbids a
// second, awthaq-specific evaluation shortcut, so this package adds no
// wrapper around any of them, only what actually differs per application
// (the session/subject atoms and the provider composing them, all real
// awthaq concerns qadi has no opinion about).
// See spec/overview.md for the full package map.

// BO-007: an explicit list, not `export *` — an upstream rename or addition now
// fails this file's typecheck instead of silently changing this package's public
// API. The gate-instrumentation registry (`GateRegistry`: `gateInstances`,
// `registerGate`, ...) is qadi's devtools surface and deliberately not re-exported;
// import it from `@qadi/react` (a peer dependency) where a devtools panel needs it.
export {
  Can,
  Cannot,
  MissingQadiProviderError,
  QadiProvider,
  currentDecision,
  dehydrateDecisions,
  hydrateDecisions,
  makeQadiAtoms,
  useAtomValue,
  useCan,
  useDecision,
  useDecisionSuspense,
  useInvalidate,
  usePolicies,
  useProjected,
  useQadiContext,
  useSubject,
} from "@qadi/react";
export type {
  AskedQuestion,
  CanProps,
  CannotProps,
  DecisionEntry,
  DecisionResult,
  DehydrateOptions,
  DehydratedDecisions,
  DehydratedEntry,
  DeniedNode,
  HydrateOptions,
  HydrationDrop,
  HydrationDropReporter,
  HydrationMismatch,
  HydrationMismatchReporter,
  InitialValues,
  QadiAtoms,
  QadiAtomsOptions,
  QadiContextValue,
  QadiLayer,
  QadiProviderProps,
  QadiRuntimeServices,
} from "@qadi/react";
export * as AuthClientAtom from "./AuthClientAtom.ts";
export * from "./Hooks.ts";
export * from "./Providers.tsx";
export * as ReactClient from "./ReactClient.ts";
export * as Subject from "./Subject.ts";
