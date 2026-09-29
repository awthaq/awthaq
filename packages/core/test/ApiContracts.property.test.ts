// ETVS-002: Schema-derived property tests for `@awthaq/api`'s wire contracts (kept in core's suite:
// `@awthaq/api` itself has no `@effect/vitest`).
// Schema-derived property tests for the wire contracts. The generators come from the
// schemas themselves (`Arbitrary.schema`), so a change to a contract is exercised without
// anyone updating a hand-written example — and the two directions the API relies on (a server's
// encode is what a client decodes; what a schema rejects at decode is rejected for every input,
// not just the examples someone thought of) are stated as properties.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import {
  EmailContract as Email,
  SessionContract as Session,
  SubjectContract as Subject,
} from "@awthaq/api";

describe("Email contract properties (BEH-EA-085, ESS-006)", () => {
  // An oracle written from the documented rule, not from the implementation's own branches.
  const looksLikeAnEmail = (value: string): boolean => {
    if (value.length > 254 || /\s/.test(value)) return false;
    const at = value.indexOf("@");
    if (at < 0 || value.indexOf("@", at + 1) >= 0) return false;
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    return (
      local.length >= 1 &&
      local.length <= 64 &&
      domain.includes(".") &&
      !domain.startsWith(".") &&
      !domain.endsWith(".")
    );
  };

  it.prop(
    "BEH-EA-085: decoding accepts exactly the documented shape, for any input, and never throws",
    { value: Schema.String },
    ({ value }) => {
      const accepted = Schema.decodeUnknownOption(Email.Email)(value)._tag === "Some";
      assert.strictEqual(accepted, looksLikeAnEmail(value));
    },
  );

  const Local = Schema.String.check(Schema.isPattern(/^[^@\s]{1,64}$/));
  const Label = Schema.String.check(Schema.isPattern(/^[^@\s.]{1,60}$/));

  it.prop(
    "ESS-006: every address built as local@label.label decodes to itself, byte for byte (no normalisation)",
    { local: Local, host: Label, tld: Label },
    ({ local, host, tld }) => {
      const address = `${local}@${host}.${tld}`;
      assert.strictEqual(Schema.decodeUnknownSync(Email.Email)(address), address);
    },
  );

  it.prop(
    "ESS-006: appending or prepending any whitespace to a valid address makes it invalid",
    { local: Local, host: Label, tld: Label, space: Schema.Literals([" ", "\t", "\n", " "]) },
    ({ local, host, tld, space }) => {
      const address = `${local}@${host}.${tld}`;
      assert.isFalse(Schema.decodeUnknownOption(Email.Email)(`${address}${space}`)._tag === "Some");
      assert.isFalse(Schema.decodeUnknownOption(Email.Email)(`${space}${address}`)._tag === "Some");
    },
  );
});

describe("wire DTO round trips", () => {
  const sessionWire = Schema.toCodecJson(Session.SessionDto);

  // The wire timestamp is a four-digit-year ISO-8601 string, so the round trip is stated over the
  // instants that format can name (0000-01-01 .. 9999-12-31); outside it, encode refuses by design.
  const Instant = Arbitrary.map(
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 253_402_300_799_999 })),
    ),
    (millis) => DateTime.makeUnsafe(millis),
  );

  it.prop(
    "MW-008: a SessionDto survives encode -> JSON text -> decode with every field intact",
    {
      id: Schema.String,
      createdAt: Instant,
      lastActiveAt: Instant,
      expiresAt: Instant,
      userAgent: Schema.NullOr(Schema.String),
      amr: Schema.Array(Schema.String),
      current: Schema.Boolean,
      token: Schema.optional(Schema.String),
    },
    (fields) => {
      const session = new Session.SessionDto(fields);
      const wire = JSON.stringify(Schema.encodeSync(sessionWire)(session));
      const back = Schema.decodeUnknownSync(sessionWire)(JSON.parse(wire));
      assert.deepStrictEqual(back, session);
    },
  );

  it.prop(
    "MW-008: a SessionDto timestamp decodes only from an ISO-8601 date-time string, whatever else is sent",
    { junk: Schema.String },
    ({ junk }) => {
      const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
      const decoded = Schema.decodeUnknownOption(sessionWire)({
        id: "s",
        createdAt: junk,
        lastActiveAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-01T00:00:00Z",
        userAgent: null,
        current: true,
      });
      if (!iso.test(junk)) assert.strictEqual(decoded._tag, "None");
    },
  );

  const subjectWire = Schema.toCodecJson(Subject.SubjectDto);

  it.prop(
    "AAPS-008: a generated SubjectDto survives encode -> JSON text -> decode (attributes are public JSON)",
    {
      id: Schema.String,
      roles: Schema.Array(Schema.String),
      permissions: Schema.Array(Schema.String),
      attributes: Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Boolean, Schema.Null]),
      ),
    },
    (fields) => {
      const subject = new Subject.SubjectDto(fields);
      const wire = JSON.stringify(Schema.encodeSync(subjectWire)(subject));
      const back = Schema.decodeUnknownSync(subjectWire)(JSON.parse(wire));
      assert.deepStrictEqual(back, subject);
    },
  );
});
