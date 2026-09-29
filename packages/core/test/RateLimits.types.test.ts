// BEH-EA-108 (REQ-EA-292): a rate-limit rule's key is one of two built-in strategies or an
// explicit function — a compile-time fact. The built-ins do not accept an arbitrary
// caller-supplied string (an unvalidated header name, say); only a custom key function opts
// into deriving a key from request data. Nothing here executes: the assertions are the
// `@ts-expect-error` directives, checked by `tsc -p tsconfig.test.json`.
import { describe, it } from "@effect/vitest";
import type * as RateLimits from "../src/RateLimits.ts";

describe("RateLimitKey (BEH-EA-108)", () => {
  it("accepts the two built-in strategies and an explicit function, and nothing else", () => {
    const principal: RateLimits.RateLimitKey = "principal";
    const ip: RateLimits.RateLimitKey = "ip";
    const custom: RateLimits.RateLimitKey = (input) => `signin:${JSON.stringify(input)}`;
    // @ts-expect-error — a bare string other than the two strategies is not a key: keying on a caller-supplied value needs a function
    const arbitrary: RateLimits.RateLimitKey = "x-forwarded-for";
    void [principal, ip, custom, arbitrary];
  });
});
