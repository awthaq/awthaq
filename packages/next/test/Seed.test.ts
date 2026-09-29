// RSC-005/NF-11-4: what a Server Component hands to `<Providers>` must survive
// React's server -> client serialization — plain JSON, no class instances.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Session } from "../src/GetSession.ts";
import { toInitialSession, toInitialSubject } from "../src/Seed.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const view: Sessions.SessionView = {
  id: Sessions.SessionId("session-1"),
  userId: Users.UserId("user-1"),
  createdAt: at("2024-01-01T00:00:00.000Z"),
  authenticatedAt: at("2024-01-01T00:00:00.000Z"),
  lastActiveAt: at("2024-01-02T00:00:00.000Z"),
  absoluteExpiresAt: at("2024-02-01T00:00:00.000Z"),
  idleExpiresAt: at("2024-01-09T00:00:00.000Z"),
  ipAddress: Option.none(),
  userAgent: Option.some("test-agent"),
  actingAs: Option.none(),
  amr: ["pwd"],
};

const session = (): Session => ({
  principal: Api.anonymousPrincipal,
  user: {
    id: Users.UserId("user-1"),
    email: "user@example.com",
    emailVerified: true,
    name: "User",
    metadata: Option.none(),
    createdAt: at("2024-01-01T00:00:00.000Z"),
    updatedAt: at("2024-01-01T00:00:00.000Z"),
  },
  session: view,
  rotated: Redacted.make("secret-must-never-leak"),
});

/** True when React's serializer would accept the value: JSON scalars, arrays and *plain* objects only. */
const isPlainJson = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return typeof value !== "function";
  if (Array.isArray(value)) return value.every(isPlainJson);
  return (
    Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isPlainJson)
  );
};

describe("toInitialSession (RSC-005)", () => {
  it("undefined in, undefined out", () => {
    assert.isUndefined(toInitialSession(undefined));
  });

  it("yields a JSON-round-trippable plain object with the absolute expiry as expiresAt", () => {
    const seed = toInitialSession(session());
    assert.isDefined(seed);
    assert.isTrue(isPlainJson(seed));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(seed)), seed);
    assert.strictEqual(seed?.expiresAt, "2024-02-01T00:00:00.000Z");
    assert.strictEqual(seed?.id, "session-1");
    assert.strictEqual(seed?.current, true);
  });

  it("never carries the rotated secret or any server-only field", () => {
    const serialized = JSON.stringify(toInitialSession(session()));
    assert.notInclude(serialized, "secret-must-never-leak");
    assert.notInclude(serialized, "user-1");
  });
});

describe("toInitialSubject (NF-11-4)", () => {
  it("undefined in, undefined out", () => {
    assert.isUndefined(toInitialSubject(undefined));
  });

  it("flattens sets to arrays in a plain object", () => {
    const seed = toInitialSubject({
      id: "user:1",
      roles: new Set(["admin"]),
      permissions: new Set(["doc:read"]),
      attributes: { plan: "pro" },
    });
    assert.isTrue(isPlainJson(seed));
    assert.deepStrictEqual(seed, {
      id: "user:1",
      roles: ["admin"],
      permissions: ["doc:read"],
      attributes: { plan: "pro" },
    });
  });
});
