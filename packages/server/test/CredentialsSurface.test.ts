// CRED-01, architecture deepening batch 3 phase 7: freezes the Credentials namespace behind its facade, green
// before and after the split into internal/. Values: `Object.keys` at runtime. Type names: the facade source
// (no compiler API here, the TypeScript JS API is not a dependency), so an added `export type`, `export *` or
// inline export fails the test. Shapes of `Rotation`, `Scope` and `Resolved`: type-level equality, checked by
// `tsc -p tsconfig.test.json` (nothing runs). Shapes of the other types are not pinned here.
import { readFileSync } from "node:fs";
import type { Api } from "@awthaq/api";
import type { Sessions } from "@awthaq/core";
import { assert, it } from "@effect/vitest";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Credentials from "../src/Credentials.ts";
import type {
  ClaimCarrier,
  Resolved,
  Rotation,
  Scope,
  SessionCarrier,
} from "../src/Credentials.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Failure = Api.Unauthenticated | Api.StoreUnavailable;

export type RotationShape = Expect<
  Equal<
    Rotation,
    {
      readonly carrier: SessionCarrier;
      readonly session: Sessions.SessionView;
      readonly token: Redacted.Redacted<string>;
    }
  >
>;

export type ScopeShape = Expect<
  Equal<
    Scope,
    {
      readonly key: object;
      readonly deliver: (rotation: Rotation) => Effect.Effect<void>;
      readonly claim: (
        carrier: ClaimCarrier,
        credential: Redacted.Redacted<string>,
      ) => Effect.Effect<Option.Option<Api.Principal>, Failure>;
    }
  >
>;

export type ResolvedShape = Expect<
  Equal<
    Resolved<Api.UserPrincipal>,
    | {
        readonly _tag: "Session";
        readonly carrier: SessionCarrier;
        readonly principal: Api.UserPrincipal;
        readonly session: Sessions.SessionView;
      }
    | {
        readonly _tag: "Claimed";
        readonly carrier: ClaimCarrier;
        readonly principal: Api.UserPrincipal;
      }
  >
>;

it("the Credentials value surface is exactly these 18 names", () => {
  assert.deepStrictEqual(Object.keys(Credentials).sort(), [
    "CredentialResolvers",
    "CredentialResolversFrozen",
    "CredentialResolversLive",
    "DuplicateCredentialResolver",
    "PrincipalResolver",
    "PrincipalResolverLive",
    "PrincipalResolverWithUserFactsLive",
    "collecting",
    "contribute",
    "fromRequest",
    "httpScope",
    "machineTier",
    "make",
    "optionalTier",
    "presented",
    "principalFields",
    "tier",
    "userTier",
  ]);
});

it("the Credentials type surface is exactly these 12 names, and the facade only re-exports", () => {
  // shortcut: reads the facade as text; it only holds `export [type] { ... } from "..."` lists, so a
  // regex is enough. Upgrade to the compiler API if the facade ever declares anything itself.
  const source = readFileSync(new URL("../src/Credentials.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const reexport = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*"[^"]+";/g;
  const typeNames = [...source.matchAll(reexport)]
    .filter((match) => match[1] !== undefined)
    .flatMap((match) => (match[2] ?? "").split(","))
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .sort();
  assert.deepStrictEqual(typeNames, [
    "Carrier",
    "ClaimCarrier",
    "CredentialResolverContribution",
    "CredentialResolversShape",
    "Presented",
    "PrincipalResolverShape",
    "Resolved",
    "Rotation",
    "Scope",
    "SessionCarrier",
    "Source",
    "Tier",
  ]);
  assert.notInclude(
    source.replace(reexport, ""),
    "export",
    "the facade declares or star-exports something",
  );
});
