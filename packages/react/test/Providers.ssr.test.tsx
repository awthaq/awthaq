// @vitest-environment node
// RSC-002 / EAR-005 (invalid, pinned here): seeded `Providers` renders on the
// server with no `window`/`document`, then hydrates on the client with no
// recoverable error. The seed is applied while the registry is constructed,
// during the server render as well, so server and client read the same value.
import * as DateTime from "effect/DateTime";
import { SessionContract, SubjectContract } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import { EvaluationServicesNone } from "@qadi/core";
import { makeQadiAtoms, useSubject } from "@qadi/react";
import { renderToString } from "react-dom/server";
import { afterEach } from "vitest";
import { Providers } from "../src/Providers.tsx";
import { installFetchStub, restoreFetch } from "./support/stubFetch.ts";

afterEach(restoreFetch);

const atoms = makeQadiAtoms(EvaluationServicesNone);

const session = new SessionContract.SessionDto({
  id: "session-1",
  createdAt: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
  lastActiveAt: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2024-02-01T00:00:00.000Z"),
  userAgent: null,
  current: true,
});

const subjectDto = new SubjectContract.SubjectDto({
  id: "user:1",
  roles: ["admin"],
  permissions: ["doc:read"],
  attributes: {},
});

const Probe = () => {
  const subject = useSubject();
  return <p>{subject === undefined ? "no-subject" : subject.id}</p>;
};

describe("Providers on the server (RSC-002)", () => {
  it("renders the seeded subject during a server render with no DOM globals", () => {
    assert.isUndefined(Reflect.get(globalThis, "window"));
    // The server render also starts the (relative-URL) live queries; they must not throw the render.
    installFetchStub({
      "GET /session": () => new Promise<Response>(() => undefined),
      "GET /subject": () => new Promise<Response>(() => undefined),
    });
    const html = renderToString(
      <Providers atoms={atoms} initialSession={session} initialSubject={subjectDto}>
        <Probe />
      </Providers>,
    );
    assert.include(html, "user:1");
  });

  it("renders no subject when nothing is seeded", () => {
    installFetchStub({
      "GET /session": () => new Promise<Response>(() => undefined),
      "GET /subject": () => new Promise<Response>(() => undefined),
    });
    const html = renderToString(
      <Providers atoms={atoms}>
        <Probe />
      </Providers>,
    );
    assert.include(html, "no-subject");
  });
});
