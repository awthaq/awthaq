// ADR-EA-047 (plan 26 §3.4): serving a group whose handlers or authentication middleware read the request context,
// without its populator, does not compile, in three distinct ways. Compile-time checks (`tsc -p tsconfig.test.json`
// is the assertion) with a token runtime test so the file is a suite. Each negative control was verified once by
// flipping its expected value.
import { Api } from "@awthaq/api";
import type { ClientAddress } from "@awthaq/ports";
import { it } from "@effect/vitest";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as RequestContext from "../src/RequestContext.ts";

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Includes<A, B> = [B] extends [A] ? true : false;

const ping = () => HttpApiEndpoint.get("ping", "/ping", { success: Schema.String });
/** A handler that reads the request context, as a session-minting or address-keyed operation does. */
const readsContext = () =>
  Effect.map(Effect.service(Api.AuthRequestContext), (context) => context._tag);

// Row 1, form 1: a public group that declares `RequestContext` last. Its layer needs the middleware (the id) only.
const Declared = HttpApi.make("auth").add(
  HttpApiGroup.make("declared").add(ping()).middleware(Api.RequestContext),
);
const declared = HttpApiBuilder.group(Declared, "declared", (handlers) =>
  handlers.handle("ping", readsContext),
);
export const form1NeedsTheMiddleware: Equals<
  Layer.Services<typeof declared>,
  Api.RequestContext
> = true;
// ...which `RequestContextLive` closes, leaving the topology and the randomness it reads.
const closed = declared.pipe(Layer.provide(RequestContext.RequestContextLive));
export const form1ClosedByTheLive: Equals<
  Layer.Services<typeof closed>,
  ClientAddress.ClientAddress | SecureRandom.SecureRandom
> = true;

// Row 2, form 2: the declaration forgotten. The read is an unsatisfiable `Request<"Requires", …>` marker.
const Forgotten = HttpApi.make("auth").add(HttpApiGroup.make("forgotten").add(ping()));
const forgotten = HttpApiBuilder.group(Forgotten, "forgotten", (handlers) =>
  handlers.handle("ping", readsContext),
);
export const form2LeavesAMarker: Includes<
  Layer.Services<typeof forgotten>,
  HttpRouter.Request<"Requires", Api.AuthRequestContext>
> = true;
export const form2IsNotTheMiddleware: Includes<
  Layer.Services<typeof forgotten>,
  Api.RequestContext
> = false;

// Row 3: an authenticated group, `Authentication` then `RequestContext` (outermost): both middleware ids, no marker.
const Authenticated = HttpApiGroup.make("authenticated")
  .add(ping())
  .middleware(Api.Authentication)
  .middleware(Api.RequestContext);
export const row3NeedsNothingElse: Equals<
  HttpApiGroup.MiddlewareServices<typeof Authenticated>,
  never
> = true;

// Row 4, form 3: `RequestContext` declared inside `Authentication`. `Authentication` requires the context, so the
// wrong order leaves `AuthRequestContext` as a plain requirement: a compile error, not a silent gap.
const Misordered = HttpApiGroup.make("misordered")
  .add(ping())
  .middleware(Api.RequestContext)
  .middleware(Api.Authentication);
export const form3LeavesTheContext: Includes<
  HttpApiGroup.MiddlewareServices<typeof Misordered>,
  Api.AuthRequestContext
> = true;
// The same for the other three authentication middlewares.
const bareGroup = () => HttpApiGroup.make("bare").add(ping());
const machine = bareGroup().middleware(Api.MachineAuthentication);
const admin = bareGroup().middleware(Api.AdminAuthentication);
const optional = bareGroup().middleware(Api.OptionalAuthentication);
export const authenticationRequiresTheContext: [
  Includes<HttpApiGroup.MiddlewareServices<typeof machine>, Api.AuthRequestContext>,
  Includes<HttpApiGroup.MiddlewareServices<typeof admin>, Api.AuthRequestContext>,
  Includes<HttpApiGroup.MiddlewareServices<typeof optional>, Api.AuthRequestContext>,
] = [true, true, true];

it("the guarantees above are checked by the compiler", () => {});
