// BEH-EA-076/INV-EA-011 (REQ-EA-214/215): `requiredForClient: true` is a compile-time contract,
// so its check is a type — `tsc` (the `typecheck` gate) runs this file; the scenarios' Thens read
// the constants it exports. A client built over a `CsrfProtection`-guarded group carries
// `ForClient<CsrfProtection>` in its requirements until `AuthClient.CsrfClientLive` discharges it.
import { Api } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { AppApi } from "./CsrfWorld.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type CsrfMarker = HttpApiMiddleware.ForClient<Api.CsrfProtection>;

const clientEffect = AuthClient.make(AppApi, { baseUrl: "http://csrf.test" });
const anyHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
);
const withHttpOnly = clientEffect.pipe(Effect.provide(anyHttpClient));
const withCsrf = withHttpOnly.pipe(Effect.provide(AuthClient.CsrfClientLive));

/** REQ-EA-215: without the CSRF layer the build still needs the marker — and needs nothing else once a transport is given. */
type OnlyCsrfIsMissing = Expect<Equal<Effect.Services<typeof withHttpOnly>, CsrfMarker>>;
/** REQ-EA-214: with it supplied, nothing is left unsatisfied. */
type CsrfIsDischarged = Expect<Equal<Effect.Services<typeof withCsrf>, never>>;

export const onlyCsrfIsMissing: OnlyCsrfIsMissing = true;
export const csrfIsDischarged: CsrfIsDischarged = true;
