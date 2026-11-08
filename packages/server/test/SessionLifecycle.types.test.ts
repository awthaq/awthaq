// ADR-EA-045, BEH-EA-343: the type-level gate. Every `SessionDelivery` function requires the grant a
// `SessionLifecycle` marker provides, so a handler of an endpoint that does not declare the right kind leaves
// `HttpRouter.Request<"Requires", Grant>` in the group layer's requirements, and the layer cannot be served.
// Compile-time checks (`tsc -p tsconfig.test.json` is the assertion) with a token runtime test.
import { SessionLifecycle } from "@awthaq/api";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as SessionDelivery from "../src/SessionDelivery.ts";

type Leftover<L extends Layer.Any, S> = Extract<
  Layer.Services<L>,
  HttpRouter.Request<"Requires", S>
>;
type LeavesNothing<L extends Layer.Any> = [Leftover<L, unknown>] extends [never] ? true : false;
type Leaves<L extends Layer.Any, S> = [Leftover<L, S>] extends [never] ? false : true;

const api = HttpApi.make("auth").add(
  HttpApiGroup.make("gate")
    .add(
      HttpApiEndpoint.post("mint", "/gate/mint", { success: Schema.String }).middleware(
        SessionLifecycle.Mints,
      ),
    )
    .add(HttpApiEndpoint.post("end", "/gate/end").middleware(SessionLifecycle.Ends))
    .add(HttpApiEndpoint.post("plain", "/gate/plain", { success: Schema.String })),
);

const minted = Effect.as(SessionDelivery.decline(SessionLifecycle.MintGrant), "ok");

// 14: an undeclared endpoint whose handler calls SessionDelivery leaves the grant.
export const undeclared = HttpApiBuilder.group(api, "gate", (handlers) =>
  handlers
    .handle("mint", () => minted)
    .handle("end", () => SessionDelivery.end)
    .handle("plain", () => minted),
);
export const undeclaredLeavesTheMintGrant: Leaves<typeof undeclared, SessionLifecycle.MintGrant> =
  true;

// 15: an `Ends` handler calling a mint function leaves `MintGrant`; a `Mints` handler calling `end` leaves `EndGrant`.
export const crossed = HttpApiBuilder.group(api, "gate", (handlers) =>
  handlers
    .handle("mint", () => Effect.as(SessionDelivery.end, "ok"))
    .handle("end", () => SessionDelivery.decline(SessionLifecycle.MintGrant))
    .handle("plain", () => Effect.succeed("ok")),
);
export const crossedLeavesTheMintGrant: Leaves<typeof crossed, SessionLifecycle.MintGrant> = true;
export const crossedLeavesTheEndGrant: Leaves<typeof crossed, SessionLifecycle.EndGrant> = true;

// 16: each declared handler calling its own kind's function leaves nothing.
export const declared = HttpApiBuilder.group(api, "gate", (handlers) =>
  handlers
    .handle("mint", () => minted)
    .handle("end", () => SessionDelivery.end)
    .handle("plain", () => Effect.succeed("ok")),
);
export const declaredLeavesNothing: LeavesNothing<typeof declared> = true;

it("the guarantees above are checked by the compiler", () => {});
