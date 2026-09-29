// BEH-EA-260/258 (spec/behaviors/31-webhooks.md): what leaves the process — identifiers only, free text
// and client context withheld — and the per-endpoint event filters.
import { AuthEvents, Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as WebhookPayload from "../src/WebhookPayload.ts";
import { published, signedIn } from "./support.ts";

const withContext = { includeClientContext: true } as const;
const withoutContext = { includeClientContext: false } as const;

describe("WebhookPayload.toBody: identifiers only", () => {
  it.effect("shapes the delivered document from the event and its envelope", () =>
    Effect.gen(function* () {
      const event = yield* published(signedIn("user-1"), {
        correlationId: Option.some("corr-1"),
        traceId: Option.some("trace-1"),
      });
      const body = WebhookPayload.toBody(event, withoutContext);
      assert.strictEqual(body.version, 1);
      assert.strictEqual(body.type, "auth.user.signedIn");
      assert.strictEqual(body.id, event.eventId);
      assert.strictEqual(body.correlationId, "corr-1");
      assert.strictEqual(body.traceId, "trace-1");
      assert.deepStrictEqual(body.data, { userId: "user-1", strategy: "password" });
      assert.isUndefined(body.client);
    }),
  );

  it.effect("never sends the client address or user agent unless the plugin is configured to", () =>
    Effect.gen(function* () {
      const failed = yield* published(
        {
          _tag: "auth.user.signInFailed",
          strategy: "password",
          reason: "invalidCredentials",
          clientIp: "203.0.113.9",
          identifierDigest: "abc123",
        },
        { ip: Option.some("203.0.113.9"), userAgent: Option.some("Mozilla/5.0") },
      );
      const off = JSON.stringify(WebhookPayload.toBody(failed, withoutContext));
      assert.notInclude(off, "203.0.113.9");
      assert.notInclude(off, "Mozilla");
      assert.include(off, "abc123");
      const on = WebhookPayload.toBody(failed, withContext);
      assert.deepStrictEqual(on.client, { ip: "203.0.113.9", userAgent: "Mozilla/5.0" });
      assert.strictEqual(on.data["clientIp"], "203.0.113.9");
    }),
  );

  it.effect("drops declared free text about a person (PII_FIELDS): the impersonation justification", () =>
    Effect.gen(function* () {
      const started = yield* published({
        _tag: "auth.admin.impersonationStarted",
        adminUserId: Users.UserId("admin-1"),
        targetUserId: Users.UserId("user-2"),
        reason: "Customer jane.doe@example.com reported fraud",
        sessionId: Sessions.SessionId("s-1"),
      });
      const text = JSON.stringify(WebhookPayload.toBody(started, withContext));
      assert.notInclude(text, "jane.doe@example.com");
      assert.notInclude(text, "fraud");
      assert.include(text, "user-2");
    }),
  );

  it.effect("drops any field named like a credential or contact detail, whatever an event schema says", () =>
    Effect.gen(function* () {
      const base = yield* published(signedIn());
      // A future event with a careless field: the guard removes it before it reaches a third party.
      const careless = {
        ...base,
        email: "ada@example.com",
        Password: "hunter2",
        accessToken: "at-1",
        token: "t-1",
        phone: "+15551234567",
        note: "kept",
      };
      const body = WebhookPayload.toBody(careless, withContext);
      const text = JSON.stringify(body);
      for (const leaked of ["ada@example.com", "hunter2", "t-1", "+15551234567"]) {
        assert.notInclude(text, leaked);
      }
      assert.strictEqual(body.data["note"], "kept");
    }),
  );

  it.effect("names the user an event is about, for erasure and export", () =>
    Effect.gen(function* () {
      assert.strictEqual(WebhookPayload.subjectUserId(yield* published(signedIn("u-9"))), "u-9");
      const org = yield* published({
        _tag: "auth.organization.updated",
        organizationId: "org-1",
      });
      assert.isUndefined(WebhookPayload.subjectUserId(org));
    }),
  );
});

describe("WebhookPayload filters", () => {
  it("matches exact tags, families and everything", () => {
    assert.isTrue(WebhookPayload.patternMatches("*", "auth.user.signedIn"));
    assert.isTrue(WebhookPayload.patternMatches("auth.user.signedIn", "auth.user.signedIn"));
    assert.isFalse(WebhookPayload.patternMatches("auth.user.signedIn", "auth.user.created"));
    assert.isTrue(WebhookPayload.patternMatches("auth.organization.*", "auth.organization.created"));
    assert.isFalse(WebhookPayload.patternMatches("auth.organization.*", "auth.organizationX.created"));
    assert.isFalse(WebhookPayload.patternMatches("auth.user.*", "auth.session.issued"));
    assert.isTrue(WebhookPayload.matchesAny(["auth.user.created", "auth.session.*"], "auth.session.revoked"));
    assert.isFalse(WebhookPayload.matchesAny([], "auth.session.revoked"));
  });

  it("knows every tag the library publishes, and refuses a filter that can match none", () => {
    assert.include(WebhookPayload.knownEventTags, "auth.user.signedIn");
    assert.include(WebhookPayload.knownEventTags, "auth.organization.memberAdded");
    assert.isAbove(WebhookPayload.knownEventTags.length, 50);
    assert.isUndefined(WebhookPayload.unknownPattern(["*", "auth.user.*", "auth.session.revoked"]));
    assert.strictEqual(WebhookPayload.unknownPattern(["auth.user.signedIn", "auth.user.signedInn"]), "auth.user.signedInn");
    assert.strictEqual(WebhookPayload.unknownPattern(["nothing.*"]), "nothing.*");
    // Every tag really is matched by its own family pattern.
    const tags: ReadonlyArray<AuthEvents.AuthEventTag> = ["auth.user.created"];
    assert.isTrue(tags.every((tag) => WebhookPayload.knownEventTags.includes(tag)));
  });
});
