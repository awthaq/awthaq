// ADR-EA-038: the sign-in seam is a discipline the compiler cannot fully enforce (`Sessions` is an
// ordinary service, `HookPoint.run` is an ordinary call), so pin it. A session for a proven
// credential is minted only by `SignIn.issue` (from a `Clearance`), the sign-in hook points are run
// only by `SignIn`, and `SignIn.resume` is called only by the one divert owner. Every other
// `Sessions.issue` is a named, counted exception with its reason; a new one fails CI instead of
// shipping as a second, drifting copy of "gate, veto, divert, mint, announce".
//
// Reads `packages/*/src/**/*.ts` from the filesystem (no cross-package import: the dependency
// direction forbids one from core), in the style of `organization/test/TenantScoping.test.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = new URL("../../", import.meta.url);

/** Library source, comment lines removed (a header that names `sessions.issue(` is not a call). */
const sources = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const src = new URL(`${entry.name}/src/`, packagesDir);
    try {
      return readdirSync(src, { recursive: true })
        .filter((name) => /\.(ts|tsx)$/.test(String(name)))
        .map((name) => {
          const path = fileURLToPath(new URL(String(name), src));
          const code = readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join("\n");
          return { file: relative(fileURLToPath(packagesDir), path), code };
        });
    } catch {
      return [];
    }
  });

const countOf = (pattern: RegExp) =>
  Object.fromEntries(
    sources
      .map(({ file, code }) => [file, Array.from(code.matchAll(pattern)).length] as const)
      .filter(([, count]) => count > 0),
  );

interface Allowed {
  readonly file: string;
  readonly count: number;
  readonly why: string;
}

const assertExactly = (found: Record<string, number>, allowed: ReadonlyArray<Allowed>) => {
  const expected = Object.fromEntries(allowed.map(({ file, count }) => [file, count]));
  assert.deepStrictEqual(
    found,
    expected,
    `found ${JSON.stringify(found)}; each allowed entry is: ${allowed
      .map(({ file, why }) => `${file} (${why})`)
      .join("; ")}`,
  );
};

describe("the sign-in seam (ADR-EA-038)", () => {
  it("Sessions.issue is called only by SignIn.issue and the named non-sign-in mints", () => {
    assertExactly(countOf(/\bsessions\s*\.issue\(/g), [
      {
        file: "core/src/internal/signInSteps.ts",
        count: 1,
        why: "SignIn.issue: the only mint for a proven credential",
      },
      {
        file: "password/src/Password.ts",
        count: 1,
        why: "changePassword rotates the caller's own session",
      },
      {
        file: "admin/src/Admin.ts",
        count: 1,
        why: "impersonation (BEH-EA-209): an operator investigating an account is not that account signing in",
      },
      {
        file: "test/src/TestAuth.ts",
        count: 1,
        why: "signInAs mints a session for an authorization test, with no credential involved",
      },
    ]);
  });

  it("the sign-in hook points are run only by SignIn", () => {
    assertExactly(countOf(/\b(beforeSessionIssue|beforeSignIn)\s*\.run\(/g), [
      {
        file: "core/src/internal/signInSteps.ts",
        count: 2,
        why: "SignIn.clear consults BeforeSignIn and BeforeSessionIssue",
      },
    ]);
  });

  it("SignIn.resume is called only by the second factor", () => {
    assertExactly(countOf(/\.resume\(/g), [
      {
        file: "two-factor/src/TwoFactor.ts",
        count: 1,
        why: "finalizeSignIn is the one divert owner that completes a sign-in later",
      },
    ]);
  });

  it("the sign-in hook points and BeforeSignUp are run only by their module", () => {
    assertExactly(countOf(/\b(beforeSignUp|afterSignUp)\s*\.run\(/g), [
      {
        file: "core/src/SignUp.ts",
        count: 2,
        why: "SignUp.vet consults BeforeSignUp; the create* methods run AfterSignUp after the commit",
      },
    ]);
  });
});

describe("the sign-up seam (ADR-EA-038)", () => {
  it("a user is created for a sign-up only by SignUp; imports are the named exemption", () => {
    assertExactly(countOf(/\busers\s*\.(create|createOrGet|createWith)\(/g), [
      {
        file: "core/src/SignUp.ts",
        count: 1,
        why: "SignUp.createWith is the one creation path for a sign-up",
      },
      {
        file: "core/src/UserImport.ts",
        count: 1,
        why: "an operator migration is not a sign-up (UserImport.importUser)",
      },
      {
        file: "cli/src/Seed.ts",
        count: 1,
        why: "`awthaq seed admin` is an operator bootstrap, not a sign-up",
      },
      {
        file: "test/src/TestAuth.ts",
        count: 1,
        why: "signInAs fixes a user for an authorization test, with no sign-up policy involved",
      },
    ]);
  });
});
