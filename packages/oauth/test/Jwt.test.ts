// AH-001/ESS-004: `decode` must turn a malformed (including maliciously
// minimal) header/payload segment into a typed `JwtVerificationError`,
// never an unhandled defect — the attacker fully controls both segments,
// and this runs before signature verification.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Jwt from "../src/Jwt.ts";

const toBase64Url = (value: string): string =>
  Buffer.from(value).toString("base64url");

const buildToken = (header: string, payload: string, signature = "sig"): string =>
  `${toBase64Url(header)}.${toBase64Url(payload)}.${toBase64Url(signature)}`;

describe("Jwt.decode (AH-001/ESS-004)", () => {
  it.effect("decodes a well-formed header/payload", () =>
    Effect.gen(function* () {
      const token = buildToken(
        JSON.stringify({ alg: "RS256", kid: "key-1" }),
        JSON.stringify({ iss: "https://issuer.example.com", sub: "user-1" }),
      );
      const decoded = yield* Jwt.decode(token);
      assert.strictEqual(decoded.header.alg, "RS256");
      assert.strictEqual(decoded.header.kid, "key-1");
      assert.strictEqual(decoded.payload["iss"], "https://issuer.example.com");
    }),
  );

  it.effect("a JSON `null` header fails with JwtVerificationError, not a defect", () =>
    Effect.gen(function* () {
      const token = buildToken("null", JSON.stringify({ iss: "https://issuer.example.com" }));
      const failure = yield* Jwt.decode(token).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("a JSON `null` payload fails with JwtVerificationError, not a defect", () =>
    Effect.gen(function* () {
      const token = buildToken(JSON.stringify({ alg: "RS256" }), "null");
      const failure = yield* Jwt.decode(token).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("a header encoded as a JSON array fails with JwtVerificationError", () =>
    Effect.gen(function* () {
      const token = buildToken("[1,2,3]", JSON.stringify({ iss: "https://issuer.example.com" }));
      const failure = yield* Jwt.decode(token).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("a token with fewer than 3 segments fails with JwtVerificationError", () =>
    Effect.gen(function* () {
      const failure = yield* Jwt.decode("only.two").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("extra, unrecognized header fields are dropped, not rejected", () =>
    Effect.gen(function* () {
      const token = buildToken(
        JSON.stringify({ alg: "RS256", typ: "JWT", x5t: "thumbprint" }),
        JSON.stringify({}),
      );
      const decoded = yield* Jwt.decode(token);
      assert.strictEqual(decoded.header.alg, "RS256");
      assert.notProperty(decoded.header, "x5t");
    }),
  );
});
