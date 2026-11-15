// WORLD-01 / WORLD-02: not a Gherkin feature — a repository guard that lives beside the suite (the
// `*.steps.test.ts` name is what the runner and both tsconfigs already pick up).
//
// Every `*World.ts` is classified: `scaffolded` (its events subscriber is the shared `captureEvents`),
// `hand-wired` (the wiring is the thing under test; the header says `Hand-wired on purpose`) or
// `no-tail` (nothing the scaffold must delete here). The map below is the machine copy of
// `.planning/milestones/v1.0-phases/07-world-scaffold-and-credentials-split-optional/07-WORLD-TABLE.md`; this guard
// deliberately never reads `.planning/`, so the suite does not depend on planning-document layout.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stepDefinitions = fileURLToPath(new URL("../../step-definitions/", import.meta.url));

const WORLDS = {
  AdminWorld: "scaffolded",
  AuthenticationWorld: "hand-wired",
  ClientEffectWorld: "no-tail",
  CliWorld: "no-tail",
  ContractStratumWorld: "hand-wired",
  CsrfWorld: "hand-wired",
  DeviceAuthorizationWorld: "no-tail",
  DomainWorld: "scaffolded",
  EventsWorld: "no-tail",
  FoundationsWorld: "no-tail",
  HooksWorld: "no-tail",
  HttpErrorWorld: "no-tail",
  JwtWorld: "no-tail",
  MagicLinkWorld: "no-tail",
  NextSsrWorld: "no-tail",
  OAuthWorld: "no-tail",
  OrganizationWorld: "scaffolded",
  PasskeyWorld: "no-tail",
  PasswordWorld: "scaffolded",
  PersistenceStratumWorld: "no-tail",
  QadiBridgeWorld: "hand-wired",
  RateLimitingWorld: "no-tail",
  ReactWorld: "no-tail",
  SamlWorld: "no-tail",
  ScimWorld: "no-tail",
  SessionWorld: "no-tail",
  SmokeWorld: "no-tail",
  TenancyWorld: "hand-wired",
  TestingHarnessWorld: "no-tail",
  TwoFactorWorld: "no-tail",
  WebhooksWorld: "no-tail",
} as const satisfies Record<string, "scaffolded" | "hand-wired" | "no-tail">;

// Comments may quote the header, the import or a subscription while explaining them; code is what counts.
// shortcut: one pass that knows strings, templates and both comment forms, but not regex literals or nested
// templates; upgrade if a World ever trips it (the self-check in the test below fails first).
const stripComments = (source: string): string => {
  let code = "";
  let at = 0;
  while (at < source.length) {
    const char = source.charAt(at);
    const pair = source.slice(at, at + 2);
    if (pair === "//") {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
    } else if (pair === "/*") {
      const end = source.indexOf("*/", at + 2);
      at = end === -1 ? source.length : end + 2;
      code += " ";
    } else if (char === '"' || char === "'" || char === "`") {
      let end = at + 1;
      while (end < source.length && source.charAt(end) !== char) {
        end += source.charAt(end) === "\\" ? 2 : 1;
      }
      code += source.slice(at, end + 1);
      at = end + 1;
    } else {
      code += char;
      at += 1;
    }
  }
  return code;
};

describe("World classification", () => {
  it("classifies every World and pins the hand-wired and scaffolded ones", () => {
    const offenders: Array<string> = [];
    const onDisk = readdirSync(stepDefinitions)
      .filter((name) => name.endsWith("World.ts"))
      .map((name) => name.slice(0, -".ts".length));
    const classes: Record<string, string> = WORLDS;

    const sample = stripComments('a /* x */ b // y\nc "//z" d `/*w*/`');
    if (/[xy]/.test(sample) || !sample.includes('"//z"') || !sample.includes("`/*w*/`")) {
      offenders.push("stripComments: comments survive or string contents were stripped");
    }

    for (const name of onDisk) if (!(name in classes)) offenders.push(`${name}: unclassified`);
    for (const name of Object.keys(classes)) {
      if (!onDisk.includes(name)) offenders.push(`${name}: classified but missing`);
    }

    for (const name of onDisk) {
      const kind = classes[name];
      if (kind === undefined) continue;
      const source = readFileSync(`${stepDefinitions}${name}.ts`, "utf8");
      const code = stripComments(source);
      if (
        kind === "hand-wired" &&
        !source.split("\n").slice(0, 6).join("\n").includes("Hand-wired on purpose")
      ) {
        offenders.push(`${name}: hand-wired but its first six lines lack "Hand-wired on purpose"`);
      }
      if (kind === "scaffolded" && /\.(stream|subscribe|on|onBatch)\b/.test(code)) {
        offenders.push(
          `${name}: scaffolded but still subscribes inline (\`.stream\`, \`.subscribe\`, \`.on\` or \`.onBatch\`)`,
        );
      }
      if (kind === "scaffolded" && !/\bcaptureEvents\(/.test(code)) {
        offenders.push(`${name}: scaffolded but never calls captureEvents(`);
      }
      const importsScaffold = /\bimport\b[^;]*?\bfrom\s*["']\.\/shared\/EventCapture\.ts["']/.test(
        code,
      );
      if (importsScaffold !== (kind === "scaffolded")) {
        offenders.push(
          `${name}: ${kind} but ${importsScaffold ? "imports" : "does not import"} ./shared/EventCapture.ts`,
        );
      }
    }

    expect(
      offenders,
      "classify the new World in this map and in 07-WORLD-TABLE.md (only scaffolded Worlds import the scaffold)",
    ).toEqual([]);
  });
});
