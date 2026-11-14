// Phase 6 Wave 0 oracle (REC-03): the equal-createdAt order of the SAML listings the comparator helper rewrites
// (SamlRecords.listByOrganization ascending, listSpKeys descending), on both adapters. Expected orders are literals
// over canonical ids. Never edited after its add commit.
import { Auth } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { RateLimiter } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as XmlSignatureNode from "../src/XmlSignatureNode.ts";
import { BASE_URL, fakeFetcher } from "./support.ts";
import { idp, NOT_AFTER, NOT_BEFORE } from "./samlFixtures.ts";

const X = "019a8f00-0000-7000-8000-000000000009";
const A = "019a8f00-0000-7000-8000-000000000001";
const B = "019a8f00-0000-7000-8000-000000000002";
const C = "019a8f00-0000-7000-8000-000000000003";

const input = (id: string, organizationId: string): SamlRecords.NewConnection => ({
  id,
  organizationId,
  name: `connection ${id}`,
  idpEntityId: `https://idp-${id}.example.com/metadata`,
  ssoUrl: `https://idp-${id}.example.com/sso`,
  idpCertificates: [
    { pem: idp.cert, fingerprint: idp.fingerprint, notBefore: NOT_BEFORE, notAfter: NOT_AFTER },
  ],
  emailDomains: [],
  trustsEmail: false,
});

const spKey = (id: string, connectionId: string): SamlRecords.NewSpKey => ({
  id,
  connectionId,
  certificate: `cert-${id}`,
  privateKey: Redacted.make(`sealed-${id}`),
  fingerprint: `fp-${id}`,
  notBefore: NOT_BEFORE,
  notAfter: NOT_AFTER,
});

const built = Auth.make([Organization.Organization, Saml.Saml]);
const services = Layer.mergeAll(
  Saml.config({ baseUrl: BASE_URL }),
  Organization.config({}),
  XmlSignatureNode.layer,
  fakeFetcher({}).layer,
  RateLimiter.layerPermissive,
);

const compositions = {
  memory: TestAuth.layer(built, { services }),
  sql: TestAuth.layer(built, { records: "sql", suite: "saml_RecordOrderPins", services }),
};

for (const [mode, Live] of Object.entries(compositions)) {
  describe(`saml record order pins (${mode})`, () => {
    it.effect("SamlRecords.listByOrganization: time first, then id, ascending", () =>
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input(X, "org-pin"));
        yield* TestClock.adjust("1 millis");
        yield* records.create(input(C, "org-pin"));
        yield* records.create(input(A, "org-pin"));
        yield* records.create(input(B, "org-pin"));
        yield* records.create(input("019a8f00-0000-7000-8000-000000000007", "org-other"));
        const listed = yield* records.listByOrganization("org-pin");
        assert.deepStrictEqual(
          listed.map((row) => row.id),
          [X, A, B, C],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("SamlRecords.listSpKeys: newest first, then id descending", () =>
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input("019a8f00-0000-7000-8000-0000000000a1", "org-pin"));
        const connectionId = "019a8f00-0000-7000-8000-0000000000a1";
        yield* records.saveSpKey(spKey(X, connectionId));
        yield* TestClock.adjust("1 millis");
        yield* records.saveSpKey(spKey(C, connectionId));
        yield* records.saveSpKey(spKey(A, connectionId));
        yield* records.saveSpKey(spKey(B, connectionId));
        const listed = yield* records.listSpKeys(connectionId);
        assert.deepStrictEqual(
          listed.map((row) => row.id),
          [C, B, A, X],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );
  });
}
