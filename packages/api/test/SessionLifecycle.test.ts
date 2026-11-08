// ADR-EA-045, BEH-EA-343: the session lifecycle is declared on the contract. `inventory` reads the
// declaration back; `openApi` documents it for exactly the declared operations.
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import { describe, expect, it } from "vitest";
import * as Api from "../src/Api.ts";
import * as SessionLifecycle from "../src/SessionLifecycle.ts";

const api = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("g")
      .add(
        HttpApiEndpoint.post("signIn", "/sign-in", { success: Schema.String }).middleware(
          SessionLifecycle.Mints,
        ),
      )
      .add(
        HttpApiEndpoint.post("change", "/change", { success: Schema.String }).middleware(
          SessionLifecycle.Rotates,
        ),
      )
      .add(HttpApiEndpoint.post("signOut", "/sign-out").middleware(SessionLifecycle.Ends))
      .add(HttpApiEndpoint.post("swap", "/swap").middleware(SessionLifecycle.Swaps))
      .add(HttpApiEndpoint.post("reauth", "/reauth").middleware(SessionLifecycle.Refreshes))
      .add(HttpApiEndpoint.get("plain", "/plain", { success: Schema.String }))
      .middleware(Api.Authentication)
      .middleware(Api.CsrfProtection)
      .middleware(Api.RequestContext),
  )
  .add(
    HttpApiGroup.make("top", { topLevel: true }).add(
      HttpApiEndpoint.post("exchange", "/exchange", { success: Schema.String }).middleware(
        SessionLifecycle.Mints,
      ),
    ),
  );

describe("SessionLifecycle.inventory (BEH-EA-343)", () => {
  it("keys a top-level and a grouped endpoint by operationId and returns each declared kind", () => {
    expect(Object.fromEntries(SessionLifecycle.inventory(api))).toEqual({
      "g.signIn": "mints",
      "g.change": "rotates",
      "g.signOut": "ends",
      "g.swap": "swaps",
      "g.reauth": "refreshes",
      exchange: "mints",
    });
  });

  it("throws naming the endpoint when it declares two kinds", () => {
    const twice = HttpApi.make("auth").add(
      HttpApiGroup.make("g").add(
        HttpApiEndpoint.post("both", "/both")
          .middleware(SessionLifecycle.Mints)
          .middleware(SessionLifecycle.Ends),
      ),
    );
    expect(() => SessionLifecycle.inventory(twice)).toThrow(/g\.both declares more than one/);
  });

  it("kindOf ignores unrelated middleware (Authentication, CsrfProtection)", () => {
    expect(SessionLifecycle.kindOf([Api.Authentication, Api.CsrfProtection])).toBeUndefined();
    expect(SessionLifecycle.kindOf([Api.Authentication, SessionLifecycle.Ends])).toBe("ends");
  });
});

describe("SessionLifecycle.openApi (ADR-EA-045)", () => {
  const spec = OpenApi.fromApi(
    api.annotate(OpenApi.Transform, SessionLifecycle.openApi(SessionLifecycle.inventory(api))),
  );
  const operation = (path: string, method: "get" | "post" = "post") =>
    spec.paths[path]?.[method] ?? expect.fail(`no ${method} ${path}`);
  const headersOf = (path: string, status: string, method: "get" | "post" = "post") =>
    Object.keys(operation(path, method).responses[Number(status)]?.headers ?? {}).sort();

  it("adds x-awthaq-session to declared operations only", () => {
    expect(Reflect.get(operation("/sign-in"), "x-awthaq-session")).toBe("mints");
    expect(Reflect.get(operation("/exchange"), "x-awthaq-session")).toBe("mints");
    expect(Reflect.get(operation("/sign-out"), "x-awthaq-session")).toBe("ends");
    expect(Reflect.get(operation("/reauth"), "x-awthaq-session")).toBe("refreshes");
    expect(Reflect.get(operation("/plain", "get"), "x-awthaq-session")).toBeUndefined();
  });

  it("documents no-store on every response, set-auth-token on a mint's 2xx, the ended header on an end's 2xx", () => {
    expect(headersOf("/sign-in", "200")).toEqual(["Cache-Control", Api.ROTATED_TOKEN_HEADER]);
    expect(headersOf("/change", "200")).toEqual(["Cache-Control", Api.ROTATED_TOKEN_HEADER]);
    expect(headersOf("/sign-in", "400")).toEqual(["Cache-Control"]);
    expect(headersOf("/sign-out", "204")).toEqual(["Cache-Control", Api.SESSION_ENDED_HEADER]);
    expect(headersOf("/swap", "204")).toEqual(["Cache-Control"]);
    expect(headersOf("/reauth", "204")).toEqual([]);
    expect(headersOf("/plain", "200", "get")).toEqual([]);
  });

  it("still documents the 400 InvalidTokenDelivery the marker declares", () => {
    expect(Object.keys(operation("/sign-in").responses)).toContain("400");
    expect(Object.keys(operation("/sign-out").responses)).not.toContain("400");
  });
});
