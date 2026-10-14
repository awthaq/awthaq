// MNA-001: the ordering "validate the delivery mode, then mint, then deliver" is `SessionDelivery.respond`'s job, so no
// plugin calls `SessionDelivery.mode` (or `deliver`) itself except where `respond` cannot apply. Pinned as a static guard
// over `packages/*/src` (the style of `core/test/SignInSeams.test.ts`): a new direct call fails CI instead of shipping a
// handler that can mint before the header is validated.
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = new URL("../../", import.meta.url);

const sources = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "server")
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

describe("SessionDelivery call sites (MNA-001)", () => {
  it("only an endpoint that mints no session calls SessionDelivery.mode directly", () => {
    assert.deepStrictEqual(countOf(/\bSessionDelivery\s*\.mode\(/g), {
      // The concealed sign-up (ADR-EA-026) answers 202 with no session, but still refuses a bad header first.
      "password/src/Password.ts": 1,
    });
  });

  it("only the device grant, whose delivery is fixed by the RFC, calls SessionDelivery.deliver directly", () => {
    assert.deepStrictEqual(countOf(/\bSessionDelivery\s*\.deliver\(/g), {
      "device-authorization/src/DeviceAuthorization.ts": 1,
    });
  });
});
