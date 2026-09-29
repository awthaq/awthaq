// RSC-005: `toSessionDto` is the one SessionView -> SessionDto mapper
// (password/admin/passkey handlers and @awthaq/next's `toInitialSession` all use it).
import { Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { toSessionDto } from "../src/Session.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const view: Sessions.SessionView = {
  id: Sessions.SessionId("session-1"),
  userId: Users.UserId("user-1"),
  createdAt: at("2024-01-01T00:00:00.000Z"),
  authenticatedAt: at("2024-01-01T00:00:00.000Z"),
  lastActiveAt: at("2024-01-02T00:00:00.000Z"),
  absoluteExpiresAt: at("2024-02-01T00:00:00.000Z"),
  idleExpiresAt: at("2024-01-09T00:00:00.000Z"),
  ipAddress: Option.some("203.0.113.9"),
  userAgent: Option.some("test-agent"),
  actingAs: Option.none(),
  amr: ["pwd"],
};

describe("toSessionDto (RSC-005)", () => {
  it("maps the view onto the wire shape, expiresAt being the absolute expiry", () => {
    const dto = toSessionDto(view);
    assert.strictEqual(dto.id, "session-1");
    assert.strictEqual(dto.createdAt, "2024-01-01T00:00:00.000Z");
    assert.strictEqual(dto.lastActiveAt, "2024-01-02T00:00:00.000Z");
    assert.strictEqual(dto.expiresAt, "2024-02-01T00:00:00.000Z");
    assert.strictEqual(dto.userAgent, "test-agent");
    assert.deepStrictEqual(dto.amr, ["pwd"]);
    assert.isTrue(dto.current);
  });

  it("carries a missing user agent as null and honors an explicit current flag", () => {
    const dto = toSessionDto({ ...view, userAgent: Option.none() }, false);
    assert.isNull(dto.userAgent);
    assert.isFalse(dto.current);
  });
});
