// ETVS-003: the contract stratum's security-relevant declarations, tested directly
// (before this, only `@awthaq/server`'s tests exercised them, through a running router).
// spec/behaviors/04-contract-stratum.md, BEH-EA-025/027/028/029/030.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { describe, expect, it } from "vitest";
import * as Api from "../src/Api.ts";

const ref = { type: "user", id: "u-1" };

describe("Principal (BEH-EA-025)", () => {
  it("decodes and encodes each of the four declared tags, keeping the tag", () => {
    const wire = [
      { _tag: "User", ref, sessionId: "s-1" },
      { _tag: "ApiKey", ref: { type: "apiKey", id: "k-1" } },
      { _tag: "Service", ref: { type: "service", id: "svc" } },
      { _tag: "Anonymous", ref: { type: "anonymous", id: "anonymous" } },
    ];
    for (const value of wire) {
      const decoded = Schema.decodeUnknownSync(Api.Principal)(value);
      expect(decoded._tag).toBe(value._tag);
      expect(Schema.encodeSync(Api.Principal)(decoded)).toEqual(value);
    }
  });

  it("rejects a payload carrying an undeclared tag", () => {
    expect(() =>
      Schema.decodeUnknownSync(Api.Principal)({ _tag: "Root", ref, sessionId: "s-1" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(Api.Principal)({ ref })).toThrow();
  });

  it("actingAs, amr and emailVerified are optional on a UserPrincipal", () => {
    const plain = Schema.decodeUnknownSync(Api.UserPrincipal)({
      _tag: "User",
      ref,
      sessionId: "s-1",
    });
    expect(plain.actingAs).toBeUndefined();
    expect(plain.amr).toBeUndefined();
    expect(plain.emailVerified).toBeUndefined();

    const impersonated = Schema.decodeUnknownSync(Api.UserPrincipal)({
      _tag: "User",
      ref,
      sessionId: "s-1",
      actingAs: { type: "user", id: "target" },
      amr: ["pwd"],
      emailVerified: true,
    });
    expect(impersonated.actingAs).toEqual(new Api.PrincipalRef({ type: "user", id: "target" }));
    expect(impersonated.amr).toEqual(["pwd"]);
  });

  it("anonymousPrincipal is the one shared Anonymous value", () => {
    expect(Api.anonymousPrincipal._tag).toBe("Anonymous");
    expect(Api.anonymousPrincipal.ref.id).toBe("anonymous");
  });
});

describe("CurrentPrincipal (BEH-EA-070)", () => {
  it("has no default: outside an authenticated handler it is simply absent", () => {
    const found = Effect.runSync(Effect.serviceOption(Api.CurrentPrincipal));
    expect(Option.isNone(found)).toBe(true);
  });

  it("is provided by whoever supplies it", () => {
    const found = Effect.runSync(
      Effect.serviceOption(Api.CurrentPrincipal).pipe(
        Effect.provideService(Api.CurrentPrincipal, Api.anonymousPrincipal),
      ),
    );
    expect(Option.getOrUndefined(found)?._tag).toBe("Anonymous");
  });
});

describe("contract errors (BEH-EA-027/078/106/165)", () => {
  // The status a generated OpenAPI document (and so a client) sees, read off a one-endpoint api.
  const statusesDeclaredBy = (errors: ReadonlyArray<Schema.Top>) => {
    const api = HttpApi.make("auth").add(
      HttpApiGroup.make("probe").add(
        // The endpoint's `error` is a plain array of tagged errors.
        HttpApiEndpoint.get("probe", "/probe", { error: errors }),
      ),
    );
    const spec = OpenApi.fromApi(api);
    return Object.keys(spec.paths["/probe"]?.get?.responses ?? {}).sort();
  };

  it("Unauthenticated and InvalidCredentials answer 401, CsrfRejected and ReauthRequired 403, RateLimited 429", () => {
    expect(statusesDeclaredBy([Api.Unauthenticated, Api.InvalidCredentials])).toContain("401");
    expect(statusesDeclaredBy([Api.CsrfRejected])).toContain("403");
    expect(statusesDeclaredBy([Api.ReauthRequired])).toContain("403");
    expect(statusesDeclaredBy([Api.RateLimited])).toContain("429");
    // MA-004: a store outage is the retryable 503, distinct from every client-fault status.
    expect(statusesDeclaredBy([Api.StoreUnavailable])).toContain("503");
  });

  it("RateLimited carries retryAfterMillis as a typed field, not text", () => {
    const error = Schema.decodeUnknownSync(Api.RateLimited)({
      _tag: "RateLimited",
      retryAfterMillis: 1500,
    });
    expect(error.retryAfterMillis).toBe(1500);
    expect(() =>
      Schema.decodeUnknownSync(Api.RateLimited)({ _tag: "RateLimited", retryAfterMillis: "soon" }),
    ).toThrow();
  });

  it("ReauthRequired round-trips its window and is recognised by isReauthRequired", () => {
    const error = new Api.ReauthRequired({ maxAgeSeconds: 300 });
    const wire = Schema.encodeSync(Api.ReauthRequired)(error);
    expect(wire).toEqual({ _tag: "ReauthRequired", maxAgeSeconds: 300 });
    expect(Api.isReauthRequired(Schema.decodeUnknownSync(Api.ReauthRequired)(wire))).toBe(true);
    expect(Api.isReauthRequired(new Api.Unauthenticated())).toBe(false);
  });
});

describe("middleware declarations (BEH-EA-028/029/030, NHS-010)", () => {
  const order = ["impersonation", "cookie", "bearer"];

  it("Authentication, AdminAuthentication and OptionalAuthentication declare the same strategy order, impersonation first", () => {
    // The declaration's `security` key order IS the strategy chain (NHS-010).
    expect(Object.keys(Api.Authentication.security)).toEqual(order);
    expect(Object.keys(Api.AdminAuthentication.security)).toEqual(order);
    expect(Object.keys(Api.OptionalAuthentication.security)).toEqual(order);
  });

  it("the cookie schemes are keyed on the fixed cookie names", () => {
    expect(Api.SESSION_COOKIE_NAME).toBe("__Host-session");
    expect(Api.IMPERSONATION_COOKIE_NAME).toBe("__Host-impersonation");
    expect(Api.CSRF_COOKIE_NAME).toBe("__Host-csrf");
    expect(Api.CSRF_HEADER_NAME).toBe("x-csrf-token");
    expect(Api.ROTATED_TOKEN_HEADER).toBe("set-auth-token");
  });

  it("OptionalAuthentication cannot answer 401; the others answer it, and all three answer a store outage 503", () => {
    expect([...Api.OptionalAuthentication.error]).toEqual([Api.StoreUnavailable]);
    expect([...Api.Authentication.error]).toEqual([Api.Unauthenticated, Api.StoreUnavailable]);
    expect([...Api.AdminAuthentication.error]).toEqual([Api.Unauthenticated, Api.StoreUnavailable]);
  });

  it("CsrfProtection is a plain middleware every generated client must supply, failing with CsrfRejected", () => {
    expect(Api.CsrfProtection.requiredForClient).toBe(true);
    expect([...Api.CsrfProtection.error]).toEqual([Api.CsrfRejected, Api.StoreUnavailable]);
  });
});
