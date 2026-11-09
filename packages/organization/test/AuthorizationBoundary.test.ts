// Plan 30 ticket 11 (ADR-EA-040 decision 6, BEH-EA-330): organization authorization lives in one file. The
// authorized interface (`Organization.ts`) holds no authorization step of its own: it takes a proof from
// `internal/access.ts` and acts with the proof's organization id, actor and ceiling. The two brands that
// make a proof and a ceiling unforgeable are constructed only in their owning files, and the denial audit
// is published from one place. A static scan, like `RecordsBoundary.test.ts`.
import * as Fs from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const srcDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const sources: ReadonlyArray<{ readonly file: string; readonly text: string }> = Fs.readdirSync(
  srcDir,
  { recursive: true, encoding: "utf8" },
)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  .map((file) => ({
    file: file.split(Path.sep).join("/"),
    text: Fs.readFileSync(Path.join(srcDir, file), "utf8"),
  }));

/** Code only: comments may name what the code must not do. */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The files whose code matches `pattern`. */
const filesMatching = (
  files: ReadonlyArray<{ readonly file: string; readonly text: string }>,
  pattern: RegExp,
) => files.filter(({ text }) => pattern.test(codeOf(text))).map(({ file }) => file);

/** What `Organization.ts` must not contain: every one is a step `OrganizationAccess` owns. */
const forbiddenInAuthorizedInterface: ReadonlyArray<RegExp> = [
  /\brequireActive\(/,
  /\bfindActive\(/,
  /\b(memberSystem|members|invitationSystem|invitations)\.find\(/,
  /\beffectivePermissions\b/,
  /\bscopedStatements\b/,
  /\bhasPermission\b/,
  /\bActorSchema\.cases\.User\.make\b/,
  /\bBound\./,
  /auth\.organization\.permissionDenied/,
];

describe("organization authorization boundary", () => {
  it("Organization.ts holds no authorization step of its own", () => {
    const authorized = sources.filter(({ file }) => file === "Organization.ts");
    assert.strictEqual(authorized.length, 1);
    const offenders = forbiddenInAuthorizedInterface.filter(
      (pattern) => filesMatching(authorized, pattern).length > 0,
    );
    assert.deepStrictEqual(
      offenders.map((pattern) => pattern.source),
      [],
    );
  });

  it("CeilingStatements is constructed only in OrganizationAuthority.ts", () => {
    assert.deepStrictEqual(filesMatching(sources, /Brand\.nominal<[^>]*CeilingStatements/), [
      "OrganizationAuthority.ts",
    ]);
  });

  it("MemberAccess and StatementAccess are constructed only in internal/access.ts", () => {
    assert.deepStrictEqual(filesMatching(sources, /Brand\.nominal<[^>]*(Member|Statement)Access/), [
      "internal/access.ts",
    ]);
  });

  it("only internal/access.ts publishes auth.organization.permissionDenied", () => {
    // ADR-EA-049: the tag is named once, by its definition; publishing it means emitting that definition.
    assert.deepStrictEqual(filesMatching(sources, /auth\.organization\.permissionDenied/), [
      "OrganizationEvents.ts",
    ]);
    assert.deepStrictEqual(
      filesMatching(sources, /\.emit\(\s*OrganizationEvents\.OrganizationPermissionDeniedEvent\b/),
      ["internal/access.ts"],
    );
  });

  it("the scan catches a planted token", () => {
    const planted = [
      {
        file: "Organization.ts",
        text: "const bound = OrganizationActor.Bound.Ceiling({ statements });\n// requireActive( in a comment is fine",
      },
    ];
    assert.deepStrictEqual(
      forbiddenInAuthorizedInterface
        .filter((pattern) => filesMatching(planted, pattern).length > 0)
        .map((pattern) => pattern.source),
      ["\\bBound\\."],
    );
  });
});
