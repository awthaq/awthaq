// RSC-005/NF-11-4 (encoded seeds) and RSC-006/BEH-EA-186/192 (server-decided
// gates) — the client half of the server -> client seam. The seeds here are
// the plain JSON shapes a Server Component can actually pass as props.
import { SessionContract, SubjectContract } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Allow,
  AttributeResolver,
  CustomPredicateNone,
  DecisionHistoryUnknown,
  EvaluationIdLive,
  RelationshipResolverNever,
  SignatureHistoryNone,
  eq,
  hasAttribute,
  literal,
  makeSubjectId,
} from "@qadi/core";
import { Can, dehydrateDecisions, makeQadiAtoms, useSubject } from "@qadi/react";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ReactElement } from "react";
import { afterEach, vi } from "vitest";
import { Providers } from "../src/Providers.tsx";
import { installFetchStub, restoreFetch } from "./support/stubFetch.ts";

afterEach(() => {
  cleanup();
  restoreFetch();
});

const session = new SessionContract.SessionDto({
  id: "session-1",
  createdAt: "2024-01-01T00:00:00.000Z",
  lastActiveAt: "2024-01-01T00:00:00.000Z",
  expiresAt: "2024-02-01T00:00:00.000Z",
  userAgent: null,
  current: true,
});

const subjectDto = new SubjectContract.SubjectDto({
  id: "user:1",
  roles: ["admin"],
  permissions: ["doc:read"],
  attributes: {},
});

const encodedSession = Schema.encodeSync(SessionContract.SessionDto)(session);
const encodedSubject = Schema.encodeSync(SubjectContract.SubjectDto)(subjectDto);

// The live queries never answer, so only seeds can produce anything visible.
const stubHanging = () =>
  installFetchStub({
    "GET /session": () => new Promise<Response>(() => undefined),
    "GET /subject": () => new Promise<Response>(() => undefined),
  });

const SubjectProbe = (): ReactElement => {
  const subject = useSubject();
  return <div data-testid="subject">{subject === undefined ? "undefined" : subject.id}</div>;
};

// A policy needing an attribute resolver cannot settle during the first
// render, so without a hydrated seed a gate is guaranteed pending (the same
// construction @qadi/react's own ServerRender suite uses as its control).
const needsAttribute = hasAttribute("tier", eq(literal("gold")));
const slow = makeQadiAtoms(
  Layer.mergeAll(
    Layer.succeed(AttributeResolver, {
      resolve: () => Effect.delay(Effect.succeed("gold"), "1 millis"),
    }),
    RelationshipResolverNever,
    DecisionHistoryUnknown,
    EvaluationIdLive,
    CustomPredicateNone,
    SignatureHistoryNone,
  ),
);

const serverAllow = (subjectId: string) =>
  new Allow({
    evaluationId: "eval-server",
    subjectId: makeSubjectId(subjectId),
    durationMillis: 2,
    trace: {
      policyTag: "HasAttribute",
      allowed: true,
      children: [],
      visibleFields: undefined,
      obligations: [],
    },
    visibleFields: undefined,
    obligations: [],
  });

const Gate = (): ReactElement => (
  <Can policy={needsAttribute} pending={<span>pending</span>} fallback={<span>denied</span>}>
    granted
  </Can>
);

describe("Providers accepts encoded seeds (RSC-005)", () => {
  it("initialSession/initialSubject as plain encoded objects seed the qadi subject", () => {
    stubHanging();
    render(
      <Providers atoms={slow} initialSession={encodedSession} initialSubject={encodedSubject}>
        <SubjectProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "user:1");
  });

  it("a malformed seed seeds nothing and is reported once through onError", () => {
    stubHanging();
    const onError = vi.fn();
    render(
      <Providers atoms={slow} initialSession={JSON.parse('{"id":1}')} onError={onError}>
        <SubjectProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "undefined");
    assert.strictEqual(onError.mock.calls.length, 1);
  });
});

describe("Providers hydrates server-decided gates (BEH-EA-192)", () => {
  it("a server-decided Can renders its verdict on first paint, not pending", () => {
    stubHanging();
    const decisions = dehydrateDecisions([
      { policy: needsAttribute, decision: serverAllow("user:1") },
    ]);
    render(
      <Providers
        atoms={slow}
        initialSession={encodedSession}
        initialSubject={encodedSubject}
        decisions={decisions}
      >
        <Gate />
      </Providers>,
    );
    assert.strictEqual(screen.getByText("granted").textContent, "granted");
    assert.isNull(screen.queryByText("pending"));
  });

  it("without decisions the same gate is pending on first paint (the control)", () => {
    stubHanging();
    render(
      <Providers atoms={slow} initialSession={encodedSession} initialSubject={encodedSubject}>
        <Gate />
      </Providers>,
    );
    assert.strictEqual(screen.getByText("pending").textContent, "pending");
  });

  it("a payload bound to another subject is dropped, so the gate stays pending", () => {
    stubHanging();
    const decisions = dehydrateDecisions([
      { policy: needsAttribute, decision: serverAllow("user:2") },
    ]);
    render(
      <Providers
        atoms={slow}
        initialSession={encodedSession}
        initialSubject={encodedSubject}
        decisions={decisions}
        onError={() => undefined}
      >
        <Gate />
      </Providers>,
    );
    assert.strictEqual(screen.getByText("pending").textContent, "pending");
    assert.isNull(screen.queryByText("granted"));
  });

  it("decisions are not hydrated without a trusted seeded session and subject", () => {
    stubHanging();
    const decisions = dehydrateDecisions([
      { policy: needsAttribute, decision: serverAllow("user:1") },
    ]);
    render(
      <Providers atoms={slow} initialSubject={encodedSubject} decisions={decisions}>
        <Gate />
      </Providers>,
    );
    assert.isNull(screen.queryByText("granted"));
  });
});
