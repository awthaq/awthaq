// ADR-EA-047 (plan 26 ticket 24): request facts are read from `Api.AuthRequestContext` and nowhere else. The compiler
// enforces that the context is present; this pins that nothing reads the facts around it. Every allowed occurrence is
// a named, counted exception with its reason, so a new resolution of the client address, a new `User-Agent` read or a
// second `signInFailed` publisher fails CI instead of shipping as a second source that can disagree.
//
// Reads `packages/*/src/**/*.ts` from the filesystem (no cross-package import: the dependency direction forbids one
// from core), in the style of `SignInSeams.test.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = new URL("../../", import.meta.url);

/** Library source, comment lines removed (a header that names a pattern is not a use). */
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

const countOf = (pattern: RegExp, only: (file: string) => boolean = () => true) =>
  Object.fromEntries(
    sources
      .filter(({ file }) => only(file))
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

/** The plugin packages that used to thread `ip`/`userAgent` (plan 26 §2.3). */
const pluginPackages =
  /^(api-key|device-authorization|magic-link|oauth|passkey|password|saml|two-factor)\//;

describe("request facts have one source (ADR-EA-047)", () => {
  it("the ClientAddress port is resolved only by the request context's capture", () => {
    assertExactly(countOf(/\b(clientAddress|address)\s*\.resolve\(/g), [
      {
        file: "server/src/RequestContext.ts",
        count: 1,
        why: "captureWith: the one resolution, shared by RequestContextLive and capture",
      },
    ]);
  });

  it("only the server's request context and the host-facing types name the ClientAddress service", () => {
    assertExactly(countOf(/\bClientAddress\.ClientAddress\b/g), [
      {
        file: "server/src/RequestContext.ts",
        count: 2,
        why: "RequestContextLive and capture read the port",
      },
      {
        file: "server/src/AuthHttp.ts",
        count: 1,
        why: "middlewareFor's RIn: the derived populator needs it",
      },
      {
        file: "server/src/AuthHost.ts",
        count: 1,
        why: "AuthHost.Requires names it for the populator",
      },
      {
        file: "qadi/src/SubjectExtractor.ts",
        count: 2,
        why: "Path B's fallback capture on a route without the middleware (@qadi/http's interface carries no requirement)",
      },
      {
        file: "test/src/TestAuth.ts",
        count: 2,
        why: "the harness's fixed `clientAddress` resolver (a port layer, not a read)",
      },
    ]);
  });

  it("no plugin requires or reads the ClientAddress port", () => {
    assertExactly(
      countOf(/\bClientAddress\b/g, (file) => pluginPackages.test(file)),
      [],
    );
  });

  it("the User-Agent header is read only by the capture (and forwarded by two clients)", () => {
    assertExactly(countOf(/"user-agent"/g), [
      {
        file: "server/src/RequestContext.ts",
        count: 1,
        why: "the capture, capped by Api.toUserAgentHeader",
      },
      {
        file: "webhooks/src/WebhookHeaders.ts",
        count: 1,
        why: "an outbound delivery header, not a request fact",
      },
      {
        file: "webhooks/src/WebhookDelivery.ts",
        count: 1,
        why: "the outbound delivery's own user agent",
      },
      {
        file: "web/src/InProcessClient.ts",
        count: 1,
        why: "forwards the browser's header to the in-process request, which the capture then reads",
      },
    ]);
  });

  it("the socket peer is read only by the ClientAddress port's own layers", () => {
    assertExactly(countOf(/\bremoteAddress\b/g), [
      {
        file: "ports/src/ClientAddress.ts",
        count: 3,
        why: "layerDirect and layerTrustedProxy's fallback",
      },
    ]);
  });

  it("the removed helpers stay removed", () => {
    assertExactly(countOf(/\bClientAddress\.(facts|address)\(/g), []);
  });

  it("no plugin interface takes an address or a user agent", () => {
    assertExactly(
      countOf(/readonly (ip|userAgent)\?: string/g, (file) => pluginPackages.test(file)),
      [],
    );
  });

  it("auth.user.signInFailed has one publisher, SignIn.failed", () => {
    assertExactly(countOf(/_tag: "auth\.user\.signInFailed"/g), [
      {
        file: "core/src/internal/signInSteps.ts",
        count: 1,
        why: "SignIn.failed stamps clientIp from the context",
      },
    ]);
  });

  it("no library source silences the compiler with a fixed or absent request", () => {
    assertExactly(countOf(/Layer\.succeed\(\s*Api\.AuthRequestContext/g), []);
    assertExactly(countOf(/AuthRequestContext\.noRequest/g), [
      {
        file: "core/src/RateLimits.ts",
        count: 2,
        why: "the key context of a rule that reads no request, and bucketKey's default (no request by construction)",
      },
      {
        file: "test/src/TestAuth.ts",
        count: 1,
        why: "TestAuth.withoutRequest, the harness's explicit absence",
      },
    ]);
  });
});
