// EAR-005 (INVALID; pinned): seeded server HTML hydrates without a mismatch —
// the seeded subtree is the same on the server and the client, so no
// recoverable error fires (hydrateRoot's `onRecoverableError` is the signal).
import { SessionContract, SubjectContract } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import { act } from "@testing-library/react";
import { EvaluationServicesNone } from "@qadi/core";
import { makeQadiAtoms, useSubject } from "@qadi/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach } from "vitest";
import { Providers } from "../src/Providers.tsx";
import { installFetchStub, restoreFetch } from "./support/stubFetch.ts";

afterEach(restoreFetch);

const atoms = makeQadiAtoms(EvaluationServicesNone);
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

const Probe = () => {
  const subject = useSubject();
  return <p id="subject">{subject === undefined ? "no-subject" : subject.id}</p>;
};

const tree = (
  <Providers atoms={atoms} initialSession={session} initialSubject={subjectDto}>
    <Probe />
  </Providers>
);

describe("Providers hydration (EAR-005)", () => {
  it("hydrates seeded server HTML with no recoverable error", async () => {
    // Live queries stay pending so only the seeds are observable.
    installFetchStub({
      "GET /session": () => new Promise<Response>(() => undefined),
      "GET /subject": () => new Promise<Response>(() => undefined),
    });
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree);
    assert.include(container.innerHTML, "user:1");
    const errors: Array<unknown> = [];
    await act(async () => {
      hydrateRoot(container, tree, { onRecoverableError: (error) => errors.push(error) });
    });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(container.querySelector("#subject")?.textContent, "user:1");
  });
});
