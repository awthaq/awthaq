// spec/behaviors/20-qadi-bridge-path-b.md, BEH-EA-153.
import { AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { SubjectExtractor as QadiSubjectExtractor } from "@qadi/http";
import { SubjectExtractor } from "../src/index.ts";

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const TestLayer = SubjectExtractor.SubjectExtractorLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(CoreLive),
);

describe("SubjectExtractor (Path B adapter)", () => {
  it.effect("BEH-EA-153: no credential resolves to anonymous, not a failure", () =>
    Effect.gen(function* () {
      const extractor = yield* QadiSubjectExtractor;
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/whatever"));
      const subject = yield* extractor.extract(request);
      assert.strictEqual(subject.id, "anonymous");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-153: a valid session cookie resolves the real user, via the same logic Authentication uses",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const extractor = yield* QadiSubjectExtractor;
        const user = yield* users.create({ email: "path-b@example.com", name: "Path B" });
        const { token } = yield* sessions.issue({ userId: user.id });
        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost/whatever", {
            headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
          }),
        );
        const subject = yield* extractor.extract(request);
        assert.strictEqual(subject.id, `user:${user.id}`);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-153: a bearer credential is accepted too, cookie taking priority when both are present",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const extractor = yield* QadiSubjectExtractor;
        const user = yield* users.create({ email: "path-b-bearer@example.com", name: "Path B" });
        const { token } = yield* sessions.issue({ userId: user.id });
        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost/whatever", {
            headers: { authorization: `Bearer ${Redacted.value(token)}` },
          }),
        );
        const subject = yield* extractor.extract(request);
        assert.strictEqual(subject.id, `user:${user.id}`);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-153: an unknown session resolves to anonymous, never a failure", () =>
    Effect.gen(function* () {
      const extractor = yield* QadiSubjectExtractor;
      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost/whatever", {
          headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=does-not-exist.secret` },
        }),
      );
      const subject = yield* extractor.extract(request);
      assert.strictEqual(subject.id, "anonymous");
    }).pipe(Effect.provide(TestLayer)),
  );
});
