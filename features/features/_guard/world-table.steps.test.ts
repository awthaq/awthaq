// WORLD-01 / WORLD-02: not a Gherkin feature — a repository guard that lives beside the suite (the
// `*.steps.test.ts` name is what the runner and both tsconfigs already pick up).
//
// Every `*World.ts` is classified: `scaffolded` (its events subscriber is the shared `captureEvents`),
// `hand-wired` (the wiring is the thing under test; the header says `Hand-wired on purpose`) or
// `no-tail` (nothing repeated to delete). The map below is the machine copy of
// `.planning/phases/07-world-scaffold-and-credentials-split-optional/07-WORLD-TABLE.md`; this guard
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
  OrganizationWorld: "no-tail",
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

describe("World classification", () => {
  it("classifies every World and pins the hand-wired and scaffolded ones", () => {
    const offenders: Array<string> = [];
    const onDisk = readdirSync(stepDefinitions)
      .filter((name) => name.endsWith("World.ts"))
      .map((name) => name.slice(0, -".ts".length));
    const classes: Record<string, string> = WORLDS;

    for (const name of onDisk) if (!(name in classes)) offenders.push(`${name}: unclassified`);
    for (const name of Object.keys(classes)) {
      if (!onDisk.includes(name)) offenders.push(`${name}: classified but missing`);
    }

    for (const name of onDisk) {
      const kind = classes[name];
      if (kind === undefined) continue;
      const source = readFileSync(`${stepDefinitions}${name}.ts`, "utf8");
      // Comment lines may quote the header or the subscription while explaining them.
      const code = source.replace(/^\s*\/\/.*$/gm, "");
      if (
        kind === "hand-wired" &&
        !source.split("\n").slice(0, 6).join("\n").includes("Hand-wired on purpose")
      ) {
        offenders.push(`${name}: hand-wired but its first six lines lack "Hand-wired on purpose"`);
      }
      if (kind === "scaffolded" && /\.stream\b/.test(code)) {
        offenders.push(`${name}: scaffolded but still subscribes inline (\`.stream\`)`);
      }
      const importsScaffold = code.includes("./shared/EventCapture.ts");
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
