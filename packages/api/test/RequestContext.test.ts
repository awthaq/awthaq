// ADR-EA-047 (plan 26): the one request-context value. spec/behaviors/09-authentication-middleware.md.
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import * as Api from "../src/Api.ts";

describe("AuthRequestContext (ADR-EA-047)", () => {
  it("request caps a 600-character user agent at 512 and keeps a short one", () => {
    const long = Api.AuthRequestContext.request({ correlationId: "c", userAgent: "u".repeat(600) });
    expect(Option.getOrThrow(long.userAgent)).toHaveLength(Api.MAX_USER_AGENT_LENGTH);
    expect(Api.MAX_USER_AGENT_LENGTH).toBe(512);
    const short = Api.AuthRequestContext.request({ correlationId: "c", userAgent: "curl/8" });
    expect(Option.getOrThrow(short.userAgent)).toBe("curl/8");
  });

  it("request records the address and correlation id, and omitted facts are None", () => {
    const facts = Api.AuthRequestContext.request({ correlationId: "req-1", ip: "203.0.113.7" });
    expect(facts._tag).toBe("Request");
    expect(facts.correlationId).toBe("req-1");
    expect(facts.ip).toEqual(Option.some("203.0.113.7"));
    expect(facts.userAgent).toEqual(Option.none());
    expect(Api.AuthRequestContext.request({ correlationId: "c" }).ip).toEqual(Option.none());
  });

  it("noRequest is the explicit absence of a request", () => {
    expect(Api.AuthRequestContext.noRequest).toEqual({ _tag: "NoRequest" });
  });

  it("a UserAgentHeader is made only by toUserAgentHeader", () => {
    const header: Api.UserAgentHeader = Api.toUserAgentHeader("x".repeat(513));
    expect(header).toHaveLength(512);
    // @ts-expect-error a bare string is not a capped header
    const forged: Api.UserAgentHeader = "forged";
    expect(forged).toBe("forged");
  });

  it("RequestContext is a reflectable endpoint middleware that is not required for clients", () => {
    expect(Api.RequestContext.key).toBe("RequestContext");
    expect(Api.RequestContext.requiredForClient).toBe(false);
  });
});
