// spec/behaviors/14-rate-limiting.md, BEH-EA-108 — the key strategies and the one email normaliser
// (`RateLimits.Key`), plan 06 §5.1.
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as RateLimits from "../src/RateLimits.ts";

const Key = RateLimits.Key;
const context = { email: Key.emailKey };

describe("Key.emailKey (TMS-006)", () => {
  it("trims, lower-cases and strips a +tag from the local part", () => {
    assert.strictEqual(Key.emailKey("  Victim+1@X.com "), "victim@x.com");
    assert.strictEqual(Key.emailKey("victim@x.com"), "victim@x.com");
    assert.strictEqual(Key.emailKey("\t victim+a+b@x.com\n"), "victim@x.com");
  });

  it("keeps a local part that starts with +, and lower-cases an address without @", () => {
    assert.strictEqual(Key.emailKey("+odd@x.com"), "+odd@x.com");
    assert.strictEqual(Key.emailKey("No-At-Sign"), "no-at-sign");
  });
});

describe("Key.ip", () => {
  it("an unresolved address falls into one shared unknown bucket", () => {
    assert.strictEqual(Key.ip.part({}, context), "ip:unknown");
    assert.strictEqual(Key.ip.part({ ip: undefined }, context), "ip:unknown");
    assert.strictEqual(Key.ip.part({ ip: "1.2.3.4" }, context), "ip:1.2.3.4");
  });
});

describe("Key.phone (SOS-007)", () => {
  const phone = Key.phone();

  it("spellings of one number share a bucket, different numbers differ", () => {
    const a = phone.part({ phone: "+1 (555) 010-0100" }, context);
    assert.strictEqual(a, phone.part({ phone: "+15550100100" }, context));
    assert.notStrictEqual(a, phone.part({ phone: "+15550100101" }, context));
  });

  it("a value that is not a number shares one invalid bucket", () => {
    assert.strictEqual(phone.part({ phone: "not a number" }, context), "phone:invalid");
    assert.strictEqual(phone.part({ phone: "" }, context), "phone:invalid");
  });
});

describe("no secret reaches a key (BEH-EA-108)", () => {
  const hostile = {
    token: "SECRET",
    password: "SECRET",
    newPassword: "SECRET",
    currentPassword: "SECRET",
    email: "Alice@example.com",
    identifier: "public-id",
    userId: "user-1",
    sessionId: "session-1",
    clientId: "client-1",
    ip: "1.2.3.4",
    phone: "+15550100100",
  };

  it("every built-in part over a hostile input names only its own field", () => {
    const parts = [
      Key.ip.part(hostile, context),
      Key.email.part(hostile, context),
      Key.identifier.part(hostile, context),
      Key.user.part(hostile, context),
      Key.session.part(hostile, context),
      Key.client.part(hostile, context),
      Key.phone().part(hostile, context),
    ];
    for (const part of parts) {
      assert.isFalse(part.includes("SECRET"), part);
      assert.isFalse(part.includes("{") || part.includes("}"), part);
    }
  });

  it("wrong-shape input is inert: it lands in the rule's invalid bucket, not a key", () => {
    const signIn = RateLimits.rule({
      group: "g",
      endpoint: "e",
      key: Key.email,
      limit: 1,
      window: "1 minute",
    });
    assert.strictEqual(
      signIn.keyOf("g.n", { password: "SECRET" }, context),
      "ratelimit:g.n:invalid",
    );
    assert.strictEqual(
      signIn.keyOf("g.n", { email: "Alice+x@Example.com" }, context),
      "ratelimit:g.n:email:alice@example.com",
    );
  });
});

describe("strategy guards", () => {
  it("accepts ignores fields beyond the strategy's own", () => {
    assert.isTrue(Key.email.accepts({ email: "a@b.c", ip: "1.2.3.4", extra: 1 }));
    assert.isFalse(Key.email.accepts({ ip: "1.2.3.4" }));
    assert.isTrue(Key.ip.accepts({}));
  });

  it("custom prefixes custom: and narrows with its own schema", () => {
    const byTenant = Key.custom(
      "custom",
      Schema.Struct({ tenant: Schema.String }),
      (input) => `tenant-${input.tenant}`,
    );
    assert.strictEqual(byTenant.strategy, "custom");
    assert.strictEqual(byTenant.dimension, "custom");
    assert.isTrue(byTenant.accepts({ tenant: "acme" }));
    assert.isFalse(byTenant.accepts({ tenant: 1 }));
    assert.strictEqual(byTenant.part({ tenant: "acme" }, context), "custom:tenant-acme");
  });
});
