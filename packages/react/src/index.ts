// @effect-auth/react — Client
//
// React provider glue over @effect-auth/client, including QadiProvider integration.
//
// Implemented: AuthClientAtom.ts (spec/behaviors/22-client-effect.md's
// BEH-EA-169 reactive `AtomHttpApi.Service` alternative; BEH-EA-177/178),
// Subject.ts (BEH-EA-179's `AuthSubject` derivation), Providers.tsx
// (BEH-EA-177/178/179's `RegistryProvider`/`QadiProvider` composition).
//
// BEH-EA-180 through 184 (`Can`/`Cannot`/`useCan`/`useInvalidate`/
// `useProjected`/`useSubject`/`useDecision`/etc.) are `@qadi/react`'s own
// exports, re-exported here verbatim — BEH-EA-184 explicitly forbids a
// second, effect-auth-specific evaluation shortcut, so this package adds no
// wrapper around any of them, only what actually differs per application
// (the session/subject atoms and the provider composing them, all real
// effect-auth concerns qadi has no opinion about).
// See spec/overview.md for the full package map.

export * from "@qadi/react";
export * as AuthClientAtom from "./AuthClientAtom.ts";
export * from "./Providers.tsx";
export * as Subject from "./Subject.ts";
