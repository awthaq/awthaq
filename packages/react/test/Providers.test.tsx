// spec/behaviors/23-react.md, BEH-EA-177/179.
//
// `RegistryProvider`'s own documented behavior — a seeded atom's value is
// visible on the very first render, with no query ever needing to run —
// is exactly what BEH-EA-177's "no loading flash for a session the server
// already knew" and BEH-EA-179's "derive subject from the atom, not a
// second source" rest on, so these tests only exercise the seeded path
// (`initialSession`/`initialSubject`), never the live query path (which
// would need a real HTTP round trip to prove, `@awthaq/qadi`'s own
// `SubjectApi.test.ts` already covers the server half of that).
import { SessionContract, SubjectContract } from "@awthaq/api";
import { useAtomValue } from "@effect/atom-react";
import { assert, describe, it } from "@effect/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EvaluationServicesNone } from "@qadi/core";
import { makeQadiAtoms, useSubject } from "@qadi/react";
import type { ReactElement } from "react";
import { afterEach } from "vitest";
import { AuthClientAtom, Providers } from "../src/index.ts";

afterEach(cleanup);

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
  attributes: { plan: "pro" },
});

const SessionProbe = (): ReactElement => {
  const result = useAtomValue(AuthClientAtom.sessionAtom);
  const label =
    result._tag === "Success"
      ? result.value === null
        ? "no-session"
        : result.value.id
      : "pending";
  return <div data-testid="session">{label}</div>;
};

const SubjectProbe = (): ReactElement => {
  const subject = useSubject();
  return (
    <div data-testid="subject">
      {subject === undefined
        ? "undefined"
        : `${subject.id}:${Array.from(subject.roles).join(",")}:${Array.from(subject.permissions).join(",")}`}
    </div>
  );
};

describe("Providers", () => {
  it("BEH-EA-177: initialSession seeds sessionAtom with no loading flash", () => {
    render(
      <Providers atoms={atoms} initialSession={session}>
        <SessionProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("session").textContent, "session-1");
  });

  it("BEH-EA-179: initialSubject seeds subjectDtoAtom and reaches QadiProvider as a real AuthSubject", () => {
    render(
      <Providers atoms={atoms} initialSubject={subjectDto}>
        <SubjectProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "user:1:admin:doc:read");
  });

  it("BEH-EA-179: with no initialSubject seeded, QadiProvider sees no subject yet", () => {
    render(
      <Providers atoms={atoms}>
        <SubjectProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "undefined");
  });
});
