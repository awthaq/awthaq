// Shared by the records suites: the witness a test presents where a caller would, the framework the
// conformance suites run under, and a fixed-key `Encryption` for the sealed `clientSecret` column.
import { Users } from "@awthaq/core";
import { Encryption, KeyProvider, Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import type { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationMembers from "../src/OrganizationMembers.ts";

/** The witness a test presents where a cross-organization caller would. */
export const grant = TenantScoped.crossTenant(
  "organization records test: a cross-organization caller",
);

export const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => assert.fail(message),
};

export const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** The organization a conformance insert belongs to: the ambient tenant (the suite's tenants are organizations), or the platform's. */
export const ambientOrganization = Effect.map(
  Tenant.TenantContext,
  Option.getOrElse(() => "platform-organization"),
);

/**
 * Arranges a membership the way the old server-only `Organization.addMember` did: a trusted add
 * through `OrganizationMembers`, by the application, bounded by nothing.
 */
export const addMember = (input: {
  readonly organizationId: string;
  readonly userId: Users.UserId;
  readonly role: ReadonlyArray<string>;
}) =>
  Effect.flatMap(OrganizationMembers.OrganizationMembers, (members) =>
    members.add(OrganizationActor.application("organization test"), {
      ...input,
      bound: OrganizationActor.Bound.Unbounded(),
    }),
  );
