// MA-003 (.issues/high): proves `@awthaq/core`'s httpapi re-exports are a
// genuine re-export — the same nominal class Effect's own
// `effect/http-api/*` exports — not a second, awthaq-owned wrapper
// type. A wrapper would silently violate ADR-EA-003 ("one contract, no
// duplication"); this test would fail the moment anyone introduces one.
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
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
