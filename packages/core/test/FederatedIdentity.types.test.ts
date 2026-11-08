// ADR-EA-043, BEH-EA-338: a federated plugin must state its trust verdict, must map every refusal, and cannot see
// the module's private lost-race marker. Each `@ts-expect-error` below must fail to compile; nothing executes,
// the assertions are the directives, checked by `tsc -p tsconfig.test.json`.
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Errors from "../src/Errors.ts";
import * as FederatedIdentity from "../src/FederatedIdentity.ts";
import type * as HookPoint from "../src/HookPoint.ts";

declare const federation: FederatedIdentity.FederatedIdentityShape;
declare const identity: FederatedIdentity.ExternalIdentity;
declare const settled: (
  effect: Effect.Effect<
    FederatedIdentity.Resolved,
    HookPoint.HookAborted | Errors.StoreUnavailable
  >,
) => void;

const gates = () => {
  // @ts-expect-error - `trust` is required: no caller can forget its email policy
  void federation.resolve(identity);

  // Every refusal mapped: only the infrastructure and the veto stay in the error channel.
  settled(
    federation.resolve(identity, FederatedIdentity.untrusted).pipe(
      Effect.catchTags({
        "FederatedIdentity/EmailInUse": () => Effect.die("refused"),
        "FederatedIdentity/Contended": () => Effect.die("contended"),
      }),
    ),
  );

  const partial = federation
    .resolve(identity, FederatedIdentity.untrusted)
    .pipe(Effect.catchTag("FederatedIdentity/Contended", () => Effect.die("contended")));
  type Left = Effect.Error<typeof partial>;
  type Gone = FederatedIdentity.EmailInUse extends Left ? false : true;
  // @ts-expect-error - a map missing `EmailInUse` leaves it in the error channel
  const closed: Gone = true;
  void closed;

  // @ts-expect-error - the lost-race marker is module-private: it never escapes `make`
  void FederatedIdentity.Lost;
};

describe("a federated plugin states its trust and maps every refusal (BEH-EA-338)", () => {
  it("resolve requires a verdict, the refusal union is closed, and the lost-race marker is private", () => {
    // The assertions are the `@ts-expect-error` lines above.
    void gates;
  });
});
