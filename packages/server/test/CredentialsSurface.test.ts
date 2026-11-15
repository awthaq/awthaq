// CRED-01, architecture deepening batch 3 phase 7: pins the Credentials namespace's value names at runtime and its type names at compile time, green before and after the split into internal/, never edited afterwards.
import { assert, it } from "@effect/vitest";
import * as Credentials from "../src/Credentials.ts";

export type {
  Carrier,
  ClaimCarrier,
  CredentialResolverContribution,
  CredentialResolversShape,
  Presented,
  PrincipalResolverShape,
  Resolved,
  Rotation,
  Scope,
  SessionCarrier,
  Source,
  Tier,
} from "../src/Credentials.ts";

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
