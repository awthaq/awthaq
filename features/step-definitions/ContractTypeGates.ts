// P20a/AH-003: compile-time half of 04-contract-stratum.feature (INV-EA-011, BEH-EA-030).
// Same convention as `PluginTypeGates.ts`: this file is compiled by the typecheck gate, and the
// steps assert each `// type-gate:` block is still present (see `assertTypeGate`).
import { Api } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

export const CsrfGuardedApi = HttpApi.make("csrf").add(
  HttpApiGroup.make("g").add(HttpApiEndpoint.get("x", "/x")).middleware(Api.CsrfProtection),
);

type CsrfMarker = HttpApiMiddleware.ForClient<Api.CsrfProtection>;
const clientEffect = HttpApiClient.make(CsrfGuardedApi);

// type-gate: csrf-client-required
export const clientCarriesTheCsrfMarker: [CsrfMarker] extends [Effect.Services<typeof clientEffect>]
  ? true
  : false = true;

// type-gate: csrf-client-layer-discharges
const withCsrfLayer = () => clientEffect.pipe(Effect.provide(AuthClient.CsrfClientLive));
export const csrfLayerDischargesTheMarker: [CsrfMarker] extends [
  Effect.Services<ReturnType<typeof withCsrfLayer>>,
]
  ? false
  : true = true;

// type-gate: csrf-client-omitted-fails
export const composeWithoutCsrfLayer = (): void => {
  // @ts-expect-error - ForClient<CsrfProtection> is still required, so the client is not closed (INV-EA-011)
  // @effect-diagnostics-next-line missingEffectContext:off
  const closed: Effect.Effect<unknown, unknown, never> = clientEffect;
  void closed;
};
