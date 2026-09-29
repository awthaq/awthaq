// BEH-EA-170/172 are compile-time contracts (22-client-effect.feature marks them @compile-time):
// the enforcing mechanism is the TypeScript compiler, not a runtime step. Each witness below is a
// value whose *type* only exists while the property holds (`Expect<Equal<...>>`), or a
// `@ts-expect-error` line that fails `tsc` the moment the error it expects stops occurring — so
// `pnpm run typecheck` (which compiles this file) is what fails when the contract drifts, and the
// scenario steps merely surface the witnesses. Same convention as
// `packages/client/test/Csrf.test.ts` and `ErrorCodes.test.ts`.
import { Api } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { mergedTuple } from "./ClientEffectWorld.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type CsrfMarker = HttpApiMiddleware.ForClient<Api.CsrfProtection>;

const clientEffect = AuthClient.make(mergedTuple.api, { baseUrl: "http://auth.test" });
const anyHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
);
const withHttpOnly = clientEffect.pipe(Effect.provide(anyHttpClient));
const withCsrf = withHttpOnly.pipe(Effect.provide(AuthClient.CsrfClientLive));

// BEH-EA-170: the merged contract's client really carries the marker; providing
// `CsrfClientLive` discharges exactly that requirement.
type CsrfIsRequired = Expect<
  Equal<Extract<Effect.Services<typeof clientEffect>, CsrfMarker>, CsrfMarker>
>;
type CsrfIsDischarged = Expect<Equal<Effect.Services<typeof withCsrf>, never>>;
/** With everything but the CSRF layer provided, the *only* thing left unsatisfied is `ForClient<CsrfProtection>`. */
type OnlyCsrfIsMissing = Expect<Equal<Effect.Services<typeof withHttpOnly>, CsrfMarker>>;

export const csrfIsRequired: CsrfIsRequired = true;
export const csrfIsDischarged: CsrfIsDischarged = true;
export const onlyCsrfIsMissing: OnlyCsrfIsMissing = true;

/** Omitting the layer leaves a non-empty requirement, so the program cannot be run: `Effect.runPromise` needs `R = never`. */
type OmissionLeavesARequirement = Expect<
  Equal<[Effect.Services<typeof withHttpOnly>] extends [never] ? true : false, false>
>;
export const omissionLeavesARequirement: OmissionLeavesARequirement = true;

// BEH-EA-172: error codes derive from the compiled contract.
class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}, { httpApiStatus: 404 }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}, { httpApiStatus: 403 }) {}
class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimitedHarness",
  {},
  { httpApiStatus: 429 },
) {}

const widgets = HttpApiGroup.make("widgets").add(
  HttpApiEndpoint.get("byId", "/widgets/:id", { success: Schema.Void, error: [NotFound] }),
);
const before = HttpApi.make("auth").add(widgets);
/** The same plugin after it grows one endpoint that fails with a new typed error. */
const after = HttpApi.make("auth").add(
  widgets.add(
    HttpApiEndpoint.post("create", "/widgets", { success: Schema.Void, error: [Forbidden] }),
  ),
);
const afterAgain = HttpApi.make("auth").add(
  widgets
    .add(HttpApiEndpoint.post("create", "/widgets", { success: Schema.Void, error: [Forbidden] }))
    .add(
      HttpApiEndpoint.post("throttle", "/widgets/throttle", {
        success: Schema.Void,
        error: [RateLimited],
      }),
    ),
);

type BeforeCodes = AuthClient.ErrorCodes<typeof before>;
type AfterCodes = AuthClient.ErrorCodes<typeof after>;
type AfterAgainCodes = AuthClient.ErrorCodes<typeof afterAgain>;

/** REQ-EA-485: exactly the two typed errors a contract declares, no more. */
const twoErrors = HttpApi.make("auth").add(
  HttpApiGroup.make("session").add(
    HttpApiEndpoint.post("signIn", "/sign-in", {
      success: Schema.Void,
      error: [Api.InvalidCredentials, Api.RateLimited],
    }),
  ),
);
type TwoErrorCodes = Expect<
  Equal<AuthClient.ErrorCodes<typeof twoErrors>, "InvalidCredentials" | "RateLimited">
>;
export const twoErrorCodesAreExact: TwoErrorCodes = true;

/** The merged contract's own codes include the password plugin's typed failure — with no list maintained anywhere. */
type MergedCodes = AuthClient.ErrorCodes<typeof mergedTuple.api>;
type MergedHasInvalidCredentials = Expect<"InvalidCredentials" extends MergedCodes ? true : false>;
type BeforeIsExact = Expect<Equal<BeforeCodes, "NotFound">>;
type AfterIsExtended = Expect<Equal<AfterCodes, "NotFound" | "Forbidden">>;
type AfterAgainIsExtended = Expect<
  Equal<AfterAgainCodes, "NotFound" | "Forbidden" | "RateLimitedHarness">
>;

export const mergedHasInvalidCredentials: MergedHasInvalidCredentials = true;
export const beforeIsExact: BeforeIsExact = true;
export const afterIsExtended: AfterIsExtended = true;
export const afterAgainIsExtended: AfterAgainIsExtended = true;

// BEH-EA-172's i18n catalog: it must be a total `Record` over the codes. (Scenario REQ-EA-487 and
// spec/behaviors/22 say `Partial<Record<...>>`, which accepts a missing tag; only the total record
// makes the compiler report an untranslated tag — see PV-262.)
export const catalogBefore = { NotFound: "Not found" } satisfies Record<BeforeCodes, string>;
export const catalogAfterMissingATag = () =>
  // @ts-expect-error -- "Forbidden" has no translation yet
  ({ NotFound: "Not found" }) satisfies Record<AfterCodes, string>;
export const catalogAfter = {
  NotFound: "Not found",
  Forbidden: "Forbidden",
} satisfies Record<AfterCodes, string>;
