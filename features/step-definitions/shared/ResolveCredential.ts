// The BDD worlds resolve one raw credential the way the middleware does, without serving a request: the credential
// module's `step` for the one carrier it came in on (ADR-EA-042), over a synthetic request (the per-request memo
// and the claimed-credential resolvers read it). Admits any principal, like the machine tier.
import { Credentials } from "@awthaq/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

const presentedIn = (carrier: Credentials.Carrier, credential: string): Credentials.Presented => {
  const here = (name: Credentials.Carrier) =>
    carrier === name
      ? Option.some(Redacted.make(credential))
      : Option.none<Redacted.Redacted<string>>();
  return {
    impersonation: here("impersonation"),
    cookie: here("cookie"),
    apiKey: here("apiKey"),
    bearer: here("bearer"),
  };
};

/** The principal a raw `credential` presented as `carrier` resolves to; `Unauthenticated` when it does not. */
export const resolveCredential = (carrier: Credentials.Carrier, credential: string) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials.make;
    const request = HttpServerRequest.fromWeb(new Request("http://localhost/"));
    const resolved = yield* credentials.step(
      carrier,
      presentedIn(carrier, credential),
      Credentials.machineTier,
      Credentials.httpScope(request),
    );
    return resolved.principal;
  });
