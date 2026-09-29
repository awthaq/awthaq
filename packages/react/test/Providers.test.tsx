// spec/behaviors/23-react.md, BEH-EA-177/179 (+ EAR-001/EAR-002/EAR-004/
// EAR-006/FAMS-008 live-path coverage).
//
// Two halves. The seeded tests rely on `initialValues`' documented behavior —
// a seeded atom's value is visible on the very first render, no query needing
// to run — which is what BEH-EA-177's "no loading flash for a session the
// server already knew" and BEH-EA-179's "derive subject from the atoms, not a
// second source" rest on. The live-path tests (EAR-004) stub `fetch` (see
// `support/stubFetch.ts`; an unrouted request fails the test, no ECONNRESET
// noise) and drive the real queries and mutations through `Providers`:
// anonymous first load, a session-keyed mutation flipping the subject without
// a remount, the sign-out window, failure reporting, and focus revalidation.
import { SessionContract, SubjectContract } from "@awthaq/api";
import { useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import { assert, describe, it } from "@effect/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EvaluationServicesNone } from "@qadi/core";
import { makeQadiAtoms, useSubject } from "@qadi/react";
import type { ReactElement, ReactNode } from "react";
import { StrictMode } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import * as AuthClientAtom from "../src/AuthClientAtom.ts";
import { useAuthStatus } from "../src/Hooks.ts";
import { Providers } from "../src/Providers.tsx";
import { SESSION_KEY } from "../src/ReactClient.ts";
import { installFetchStub, jsonResponse, restoreFetch, sequence } from "./support/stubFetch.ts";

beforeEach(() => {
  // happy-dom enforces `__Host-` cookie rules that `document.cookie =` cannot
  // satisfy; the CSRF client only ever reads the getter.
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-csrf=token-1");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreFetch();
});

const atoms = makeQadiAtoms(EvaluationServicesNone);

const sessionDto = (id: string) =>
  new SessionContract.SessionDto({
    id,
    createdAt: "2024-01-01T00:00:00.000Z",
    lastActiveAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2024-02-01T00:00:00.000Z",
    userAgent: null,
    current: true,
  });

const subjectOf = (id: string, role: string, permission: string) =>
  new SubjectContract.SubjectDto({
    id,
    roles: [role],
    permissions: [permission],
    attributes: {},
  });

const session = sessionDto("session-1");
const subjectDto = subjectOf("user:1", "admin", "doc:read");

const encodeSession = (dto: SessionContract.SessionDto) => ({ ...dto });
const encodeSubject = (dto: SubjectContract.SubjectDto) => ({ ...dto });
const unauthenticated = () => jsonResponse({ _tag: "Unauthenticated" }, 401);
const anonymousSubject = () =>
  jsonResponse(encodeSubject(subjectOf("anonymous", "none", "none:none")));

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

const subjectLabel = (subject: ReturnType<typeof useSubject>): string =>
  subject === undefined
    ? "undefined"
    : `${subject.id}:${Array.from(subject.roles).join(",")}:${Array.from(subject.permissions).join(",")}`;

const SubjectProbe = (): ReactElement => {
  const subject = useSubject();
  return <div data-testid="subject">{subjectLabel(subject)}</div>;
};

/** Records `session|subject` on every render, so a test can inspect the whole render history. */
const HistoryProbe = ({ history }: { readonly history: Array<string> }): ReactElement => {
  const result = useAtomValue(AuthClientAtom.sessionAtom);
  const subject = useSubject();
  const session =
    result._tag === "Success"
      ? result.value === null
        ? "no-session"
        : result.value.id
      : "pending";
  const entry = `${session}|${subjectLabel(subject)}`;
  history.push(entry);
  return <div data-testid="both">{entry}</div>;
};

const RevokeOthers = (): ReactElement => {
  const run = useAtomSet(AuthClientAtom.ReactAuthClient.mutation("session", "revokeOthers"));
  return (
    <button data-testid="mutate" onClick={() => run({ reactivityKeys: [SESSION_KEY] })}>
      mutate
    </button>
  );
};

const StatusProbe = (): ReactElement => {
  const { status, retry } = useAuthStatus();
  return (
    <div>
      <div data-testid="status">{status._tag}</div>
      <button data-testid="retry" onClick={retry}>
        retry
      </button>
    </div>
  );
};

const sessionBody = (id: string) => () => jsonResponse(encodeSession(sessionDto(id)));
const subjectBody = (dto: SubjectContract.SubjectDto) => () => jsonResponse(encodeSubject(dto));
const noContent = () => new Response(null, { status: 204 });

describe("Providers (seeded)", () => {
  it("BEH-EA-177: initialSession seeds sessionAtom with no loading flash", () => {
    installFetchStub({
      "GET /session": sessionBody("session-1"),
      "GET /subject": subjectBody(subjectDto),
    });
    render(
      <Providers atoms={atoms} initialSession={session}>
        <SessionProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("session").textContent, "session-1");
  });

  it("BEH-EA-179: seeded session + subject reach QadiProvider as a real AuthSubject on the first render", () => {
    installFetchStub({
      "GET /session": sessionBody("session-1"),
      "GET /subject": subjectBody(subjectDto),
    });
    render(
      <Providers atoms={atoms} initialSession={session} initialSubject={subjectDto}>
        <SubjectProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "user:1:admin:doc:read");
  });

  it("EAR-002: a seeded subject without a seeded session is not trusted", () => {
    // The live queries never answer, so only the seeds could produce a subject.
    installFetchStub({
      "GET /session": () => new Promise<Response>(() => undefined),
      "GET /subject": () => new Promise<Response>(() => undefined),
    });
    render(
      <Providers atoms={atoms} initialSubject={subjectDto}>
        <SubjectProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "undefined");
  });
});

describe("Providers (live path)", () => {
  it("EAR-004: an anonymous first load resolves to no-session and no subject", async () => {
    installFetchStub({ "GET /session": unauthenticated, "GET /subject": anonymousSubject });
    render(
      <Providers atoms={atoms}>
        <SessionProbe />
        <SubjectProbe />
      </Providers>,
    );
    await waitFor(() =>
      assert.strictEqual(screen.getByTestId("session").textContent, "no-session"),
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "undefined");
  });

  it("EAR-004: a signed-in first load, with nothing seeded, resolves both", async () => {
    installFetchStub({
      "GET /session": sessionBody("session-1"),
      "GET /subject": subjectBody(subjectDto),
    });
    render(
      <Providers atoms={atoms}>
        <SessionProbe />
        <SubjectProbe />
      </Providers>,
    );
    await waitFor(() =>
      assert.strictEqual(screen.getByTestId("subject").textContent, "user:1:admin:doc:read"),
    );
    assert.strictEqual(screen.getByTestId("session").textContent, "session-1");
  });

  it("EAR-001: a session-keyed mutation under Providers flips useSubject without a remount", async () => {
    const requests = installFetchStub({
      "GET /session": sequence(sessionBody("session-1"), sessionBody("session-2")),
      "GET /subject": sequence(
        subjectBody(subjectDto),
        subjectBody(subjectOf("user:2", "editor", "doc:write")),
      ),
      "POST /session/revoke-others": noContent,
    });
    render(
      <Providers atoms={atoms} initialSession={session} initialSubject={subjectDto}>
        <SubjectProbe />
        <RevokeOthers />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "user:1:admin:doc:read");

    fireEvent.click(screen.getByTestId("mutate"));

    await waitFor(() =>
      assert.strictEqual(screen.getByTestId("subject").textContent, "user:2:editor:doc:write"),
    );
    // NF-11-1: the mutation went out with the CSRF header.
    const mutation = requests.find((r) => r.pathname === "/session/revoke-others");
    assert.strictEqual(mutation?.headers.get("x-csrf-token"), "token-1");
  });

  it("EAR-001: re-rendering Providers' parent does not reset the live subject to the seed", async () => {
    installFetchStub({
      "GET /session": sequence(sessionBody("session-1"), sessionBody("session-2")),
      "GET /subject": sequence(
        subjectBody(subjectDto),
        subjectBody(subjectOf("user:2", "editor", "doc:write")),
      ),
      "POST /session/revoke-others": noContent,
    });
    const Tree = ({ tick }: { readonly tick: number }): ReactNode => (
      <Providers atoms={atoms} initialSession={session} initialSubject={subjectDto}>
        <SubjectProbe />
        <RevokeOthers />
        <span data-testid="tick">{tick}</span>
      </Providers>
    );
    const { rerender } = render(<Tree tick={0} />);
    fireEvent.click(screen.getByTestId("mutate"));
    await waitFor(() =>
      assert.strictEqual(screen.getByTestId("subject").textContent, "user:2:editor:doc:write"),
    );
    rerender(<Tree tick={1} />);
    assert.strictEqual(screen.getByTestId("tick").textContent, "1");
    assert.strictEqual(screen.getByTestId("subject").textContent, "user:2:editor:doc:write");
  });

  it("EAR-002/BEH-EA-179: sign-out closes every gate in the same render the session goes away", async () => {
    installFetchStub({
      "GET /session": sequence(sessionBody("session-1"), unauthenticated),
      // What the real endpoint keeps answering after sign-out: an anonymous subject.
      "GET /subject": sequence(subjectBody(subjectDto), anonymousSubject),
      "POST /session/revoke-others": noContent,
    });
    const history: Array<string> = [];
    render(
      <Providers atoms={atoms} initialSession={session} initialSubject={subjectDto}>
        <HistoryProbe history={history} />
        <RevokeOthers />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("both").textContent, "session-1|user:1:admin:doc:read");

    fireEvent.click(screen.getByTestId("mutate"));

    await waitFor(() =>
      assert.strictEqual(screen.getByTestId("both").textContent, "no-session|undefined"),
    );
    // No render ever showed "signed out" while a subject was still granted.
    const offending = history.filter(
      (entry) => entry.startsWith("no-session|") && !entry.endsWith("|undefined"),
    );
    assert.deepStrictEqual(offending, []);
  });

  it("EAR-004/EAR-006: a 500 is a Failure (not no-session), surfaces via useAuthStatus, and onError fires exactly once", async () => {
    installFetchStub({
      "GET /session": () => new Response("boom", { status: 500 }),
      "GET /subject": anonymousSubject,
    });
    const onError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <StrictMode>
        <Providers atoms={atoms} onError={onError}>
          <StatusProbe />
          <SessionProbe />
        </Providers>
      </StrictMode>,
    );
    await waitFor(() => assert.strictEqual(screen.getByTestId("status").textContent, "Failed"));
    assert.strictEqual(screen.getByTestId("session").textContent, "pending");
    assert.strictEqual(onError.mock.calls.length, 1);
    assert.strictEqual(consoleError.mock.calls.length, 0);
  });

  it("EAR-006: without onError a failure is logged once, from a subscription rather than render", async () => {
    installFetchStub({
      "GET /session": () => new Response("boom", { status: 500 }),
      "GET /subject": anonymousSubject,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <StrictMode>
        <Providers atoms={atoms}>
          <StatusProbe />
        </Providers>
      </StrictMode>,
    );
    await waitFor(() => assert.strictEqual(screen.getByTestId("status").textContent, "Failed"));
    assert.strictEqual(consoleError.mock.calls.length, 1);
  });

  it("EAR-006: retry() refetches and recovers without a remount", async () => {
    installFetchStub({
      "GET /session": sequence(
        () => new Response("boom", { status: 500 }),
        sessionBody("session-1"),
      ),
      "GET /subject": subjectBody(subjectDto),
    });
    render(
      <Providers atoms={atoms} onError={() => undefined}>
        <StatusProbe />
      </Providers>,
    );
    await waitFor(() => assert.strictEqual(screen.getByTestId("status").textContent, "Failed"));
    fireEvent.click(screen.getByTestId("retry"));
    await waitFor(() => assert.strictEqual(screen.getByTestId("status").textContent, "Ready"));
  });

  it("FAMS-008: window focus revalidates the session, so an idle tab learns it expired", async () => {
    installFetchStub({
      "GET /session": sequence(sessionBody("session-1"), unauthenticated),
      "GET /subject": sequence(subjectBody(subjectDto), anonymousSubject),
    });
    render(
      <Providers atoms={atoms} initialSession={session} initialSubject={subjectDto}>
        <SessionProbe />
        <SubjectProbe />
      </Providers>,
    );
    assert.strictEqual(screen.getByTestId("session").textContent, "session-1");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      assert.strictEqual(screen.getByTestId("session").textContent, "no-session"),
    );
    assert.strictEqual(screen.getByTestId("subject").textContent, "undefined");
  });

  it("FAMS-008: revalidateOnFocus={false} opts out", async () => {
    const requests = installFetchStub({
      "GET /session": sessionBody("session-1"),
      "GET /subject": subjectBody(subjectDto),
    });
    render(
      <Providers
        atoms={atoms}
        initialSession={session}
        initialSubject={subjectDto}
        revalidateOnFocus={false}
      >
        <SessionProbe />
      </Providers>,
    );
    await waitFor(() => assert.isAbove(requests.length, 0));
    const before = requests.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    assert.strictEqual(requests.length, before);
  });
});
