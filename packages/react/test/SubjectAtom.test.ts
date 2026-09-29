// EAR-002 / spec/behaviors/23-react.md, BEH-EA-179: the subject qadi sees is
// derived from `sessionAtom` (the gate) and `subjectDtoAtom` (the data) — pure
// registry tests, no React and no network: both atoms are seeded, and an atom
// with a seeded value serves it until something invalidates it.
import { SessionContract, SubjectContract } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import {
  AuthStatus,
  authStatusAtom,
  sessionAtom,
  subjectAtom,
  subjectDtoAtom,
} from "../src/AuthClientAtom.ts";
import { installFetchStub, restoreFetch } from "./support/stubFetch.ts";
import { afterEach } from "vitest";

afterEach(restoreFetch);

const session = new SessionContract.SessionDto({
  id: "session-1",
  createdAt: "2024-01-01T00:00:00.000Z",
  lastActiveAt: "2024-01-01T00:00:00.000Z",
  expiresAt: "2024-02-01T00:00:00.000Z",
  userAgent: null,
  current: true,
});

const dto = new SubjectContract.SubjectDto({
  id: "user:1",
  roles: ["admin"],
  permissions: ["doc:read"],
  attributes: {},
});

// Both atoms fetch on first read even when seeded (the seed is served until
// the result lands), so every registry here has a stub that never resolves
// the way the assertions would notice: a hung request keeps the seed intact.
const hang = () => new Promise<Response>(() => undefined);
const stubHangingFetch = () => installFetchStub({ "GET /session": hang, "GET /subject": hang });

const registryWith = (
  seeds: ReadonlyArray<readonly [typeof sessionAtom | typeof subjectDtoAtom, unknown]>,
) => AtomRegistry.make({ initialValues: seeds });

describe("subjectAtom (BEH-EA-179)", () => {
  it("session success(null) => undefined even when subjectDtoAtom holds a subject", () => {
    stubHangingFetch();
    const registry = registryWith([
      [sessionAtom, AsyncResult.success(null)],
      [subjectDtoAtom, AsyncResult.success(dto)],
    ]);
    registry.mount(subjectAtom);
    assert.isUndefined(registry.get(subjectAtom));
  });

  it("session still pending => undefined", () => {
    stubHangingFetch();
    const registry = registryWith([[subjectDtoAtom, AsyncResult.success(dto)]]);
    registry.mount(subjectAtom);
    assert.isUndefined(registry.get(subjectAtom));
  });

  it("subject dto waiting (refetching against a new session) => undefined", () => {
    stubHangingFetch();
    const registry = registryWith([
      [sessionAtom, AsyncResult.success(session)],
      [subjectDtoAtom, AsyncResult.success(dto, { waiting: true })],
    ]);
    registry.mount(subjectAtom);
    assert.isUndefined(registry.get(subjectAtom));
  });

  it("a background session re-check (session waiting) does not close the gate", () => {
    stubHangingFetch();
    const registry = registryWith([
      [sessionAtom, AsyncResult.success(session, { waiting: true })],
      [subjectDtoAtom, AsyncResult.success(dto)],
    ]);
    registry.mount(subjectAtom);
    assert.strictEqual(registry.get(subjectAtom)?.id, "user:1");
  });

  it("both settled => an AuthSubject with the dto's roles and permissions", () => {
    stubHangingFetch();
    const registry = registryWith([
      [sessionAtom, AsyncResult.success(session)],
      [subjectDtoAtom, AsyncResult.success(dto)],
    ]);
    registry.mount(subjectAtom);
    const subject = registry.get(subjectAtom);
    assert.strictEqual(subject?.id, "user:1");
    assert.deepStrictEqual(Array.from(subject?.roles ?? []), ["admin"]);
    assert.deepStrictEqual(Array.from(subject?.permissions ?? []), ["doc:read"]);
  });
});

describe("authStatusAtom (EAR-006)", () => {
  it("is Ready for a settled session and subject", () => {
    stubHangingFetch();
    const registry = registryWith([
      [sessionAtom, AsyncResult.success(session)],
      [subjectDtoAtom, AsyncResult.success(dto)],
    ]);
    registry.mount(authStatusAtom);
    const status = registry.get(authStatusAtom);
    assert.strictEqual(status._tag, "Ready");
  });

  it("is SignedOut for a confirmed anonymous visitor, and Pending before anything settles", () => {
    stubHangingFetch();
    const signedOut = registryWith([[sessionAtom, AsyncResult.success(null)]]);
    signedOut.mount(authStatusAtom);
    assert.deepStrictEqual(signedOut.get(authStatusAtom), AuthStatus.SignedOut());

    const pending = registryWith([]);
    pending.mount(authStatusAtom);
    assert.deepStrictEqual(pending.get(authStatusAtom), AuthStatus.Pending());
  });
});
