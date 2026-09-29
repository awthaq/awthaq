// MA-003 (.issues/high): proves `@awthaq/core`'s httpapi re-exports are a
// genuine re-export — the same nominal class Effect's own
// `effect/unstable/httpapi/*` exports — not a second, awthaq-owned wrapper
// type. A wrapper would silently violate ADR-EA-003 ("one contract, no
// duplication"); this test would fail the moment anyone introduces one.
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import { describe, expect, it } from "@effect/vitest";
import * as Core from "../src/HttpApiTypes.ts";

describe("HttpApiTypes (MA-003)", () => {
  it("re-exports each httpapi module's own values verbatim, not a wrapper", () => {
    expect(Core.HttpApi.make).toBe(HttpApi.make);
    expect(Core.HttpApiEndpoint.get).toBe(HttpApiEndpoint.get);
    expect(Core.HttpApiGroup.make).toBe(HttpApiGroup.make);
    expect(Core.HttpApiMiddleware.Service).toBe(HttpApiMiddleware.Service);
    expect(Core.HttpApiSchema.NoContent).toBe(HttpApiSchema.NoContent);
    expect(Core.HttpApiSecurity.apiKey).toBe(HttpApiSecurity.apiKey);

    // Nominal identity, not merely a structural lookalike: a value built
    // through the re-exported path must be assignable where Effect's own
    // direct import is expected (ADR-EA-003's "one contract" made concrete).
    const api: HttpApi.HttpApi<"proof", never> = Core.HttpApi.make("proof");
    expect(HttpApi.isHttpApi(api)).toBe(true);
  });
});
