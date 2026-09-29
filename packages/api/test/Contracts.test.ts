// ETVS-003 / MW-008: core's own groups (`session`, `account`), the subject contract and
// the wire shapes they carry. spec/behaviors/04-contract-stratum.md, BEH-EA-026/031.
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { describe, expect, it } from "vitest";
import * as Account from "../src/Account.ts";
import * as AuthCore from "../src/AuthCore.ts";
import * as Session from "../src/Session.ts";
import * as Subject from "../src/Subject.ts";

const endpointsOf = (group: {
  readonly endpoints: Record<string, { readonly method: string; readonly path: string }>;
}) => Object.entries(group.endpoints).map(([id, e]) => `${id} ${e.method} ${e.path}`);

const middlewareKeysOf = (group: {
  readonly endpoints: Record<string, { readonly middlewares: ReadonlySet<{ readonly key: string }> }>;
}) => Object.values(group.endpoints).map((e) => [...e.middlewares].map((m) => m.key));

describe("AuthCoreApi (BEH-EA-031)", () => {
  it("is the one 'auth' api carrying exactly the session and account groups", () => {
    expect(AuthCore.AuthCoreApi.identifier).toBe("auth");
    expect(Object.keys(AuthCore.AuthCoreApi.groups).sort()).toEqual(["account", "session"]);
  });

  it("session exposes current/list/signOut/revoke/revokeOthers/revokeAll at the documented paths", () => {
    expect(endpointsOf(Session.SessionGroup).sort()).toEqual(
      [
        "current GET /session",
        "list GET /session/list",
        "revoke POST /session/revoke",
        "revokeAll POST /session/revoke-all",
        "revokeOthers POST /session/revoke-others",
        "signOut POST /session/sign-out",
      ].sort(),
    );
  });

  it("account exposes updateProfile, deleteUser and the export on /user", () => {
    expect(endpointsOf(Account.AccountGroup).sort()).toEqual([
      "deleteUser DELETE /user",
      "exportData GET /user/export",
      "updateProfile PATCH /user",
    ]);
  });

  it("every core endpoint is behind Authentication, with CsrfProtection declared last (outermost, runs first)", () => {
    for (const group of [Session.SessionGroup, Account.AccountGroup]) {
      for (const keys of middlewareKeysOf(group)) {
        expect(keys).toEqual(["Authentication", "CsrfProtection"]);
      }
    }
  });

  it("revoke answers a not-found error identical for unknown and foreign sessions (BEH-EA-086)", () => {
    const spec = OpenApi.fromApi(AuthCore.AuthCoreApi);
    expect(Object.keys(spec.paths["/session/revoke"]?.post?.responses ?? {})).toContain("404");
  });
});

describe("wire shapes", () => {
  it("SessionDto round-trips through its wire form, with amr defaulting to none", () => {
    const wire = {
      id: "s-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:05:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      userAgent: null,
      current: true,
    };
    const dto = Schema.decodeUnknownSync(Session.SessionDto)(wire);
    expect(dto.amr).toEqual([]);
    expect(Schema.encodeSync(Session.SessionDto)(dto)).toEqual({ ...wire, amr: [] });
  });

  it("AccountDto and SubjectDto round-trip", () => {
    const account = {
      id: "u",
      identity: { _tag: "Email", email: "a@b.co", emailVerified: false },
      name: "A",
      image: null,
    };
    expect(
      Schema.encodeSync(Account.AccountDto)(Schema.decodeUnknownSync(Account.AccountDto)(account)),
    ).toEqual(account);
    const subject = { id: "user:u", roles: ["r"], permissions: ["p:read"], attributes: { a: 1 } };
    expect(
      Schema.encodeSync(Subject.SubjectDto)(Schema.decodeUnknownSync(Subject.SubjectDto)(subject)),
    ).toEqual(subject);
  });
});

// MW-008: a timestamp is a contract, not a convention.
describe("SessionDto timestamps (MW-008)", () => {
  const base = {
    id: "s-1",
    userAgent: null,
    current: true,
  };

  it("rejects a non-ISO timestamp", () => {
    expect(() =>
      Schema.decodeUnknownSync(Session.SessionDto)({
        ...base,
        createdAt: "yesterday",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes an ISO string to DateTime.Utc and encodes it back to ISO-8601", () => {
    const iso = "2026-03-04T05:06:07.000Z";
    const dto = Schema.decodeUnknownSync(Session.SessionDto)({
      ...base,
      createdAt: iso,
      lastActiveAt: iso,
      expiresAt: iso,
    });
    expect(DateTime.isDateTime(dto.createdAt)).toBe(true);
    expect(DateTime.toEpochMillis(dto.createdAt)).toBe(Date.parse(iso));
    expect(Schema.encodeSync(Session.SessionDto)(dto).createdAt).toBe(iso);
  });

  it("the generated OpenAPI schema types each timestamp as a date-time string", () => {
    const spec = OpenApi.fromApi(AuthCore.AuthCoreApi);
    const timestamp = { type: "string", format: "date-time" };
    expect(spec.components.schemas["SessionDtoEncoded"]).toMatchObject({
      properties: { createdAt: timestamp, lastActiveAt: timestamp, expiresAt: timestamp },
    });
  });
});
