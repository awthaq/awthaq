// @awthaq/core — DataExport
//
// CSG-005 (GDPR Art. 15 access / Art. 20 portability), wayfinder ticket 30's "natural
// next step", ADR-EA-033. The mirror image of `Erasure`: "give me everything you hold
// about this person" is something every plugin that stores personal data must take part
// in, so it is an aggregating registry (ADR-EA-012 style) plugins contribute a section to
// (`DataExport.contribute`, folded into a plugin's own layer with
// `AuthPlugin.layer(Self, { contributes })`), and `AccountExport.exportAccount` is the one
// service that assembles the document, so an HTTP handler, an admin console or a support
// script produce the same complete export.
//
// The document holds, from core: the user, the linked accounts (provider and subject —
// never a password hash or a provider token), the live sessions (never a secret), and the
// person's own audit activity (event, time, client address and user agent); then one
// `sections[<plugin id>]` per contribution. It never contains a secret of any kind.
//
// A failing contribution fails the whole export: a subject must not be handed a document
// that silently omits a category. A successful export publishes `auth.user.dataExported`,
// so the audit trail records who exported whose data.
//
// Not covered, and documented: the raw IP address stored on a session row (core's session
// service does not expose it; the same address appears in `activity` from the audit log),
// and `admin_impersonation` ledger rows naming the user (retained under a legal-obligation
// basis, ADR-EA-033).

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Accounts } from "./Accounts.ts";
import { AuditLog } from "./AuditLog.ts";
import { AuthEvents } from "./AuthEvents.ts";
import { DataExportRegistry, type ExportSection } from "./DataExportRegistry.ts";
import type { StoreUnavailable } from "./Errors.ts";
import { Sessions } from "./Sessions.ts";
import { Users, emailOf, type UserId, type UserIdentity, type UserNotFound } from "./Users.ts";

export * from "./DataExportRegistry.ts";

export interface AccountExportDocument {
  readonly generatedAt: string;
  readonly user: {
    readonly id: string;
    /** FAMS-002: the identity union (email, phone or anonymous), as `Users` holds it. */
    readonly identity: UserIdentity;
    readonly name: string;
    readonly metadata: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly accounts: ReadonlyArray<{
    readonly providerId: string;
    readonly subject: string;
    readonly issuer: string | null;
    readonly createdAt: string;
  }>;
  readonly sessions: ReadonlyArray<{
    readonly id: string;
    readonly createdAt: string;
    readonly lastActiveAt: string;
    readonly expiresAt: string;
    readonly userAgent: string | null;
    readonly amr: ReadonlyArray<string>;
  }>;
  readonly activity: ReadonlyArray<{
    readonly event: string;
    readonly occurredAt: string;
    readonly ip: string | null;
    readonly userAgent: string | null;
  }>;
  /** One entry per registered contribution, keyed by its id. */
  readonly sections: Readonly<Record<string, ExportSection>>;
}

export interface AccountExportShape {
  /**
   * Assembles `userId`'s export (see the module header). Fails `UserNotFound` for an
   * unknown user; a contribution that cannot read its store dies, failing the export.
   * Publishes `auth.user.dataExported` once the document is complete.
   */
  readonly exportAccount: (
    userId: UserId,
    options?: { readonly requestedBy?: "self" | "admin" },
  ) => Effect.Effect<AccountExportDocument, UserNotFound | StoreUnavailable>;
}

export class AccountExport extends Context.Service<AccountExport, AccountExportShape>()(
  "awthaq/core/AccountExport",
) {}

const iso = (value: DateTime.Utc): string => DateTime.formatIso(value);

export const layer = Layer.effect(
  AccountExport,
  Effect.gen(function* () {
    const users = yield* Users;
    const accounts = yield* Accounts;
    const sessions = yield* Sessions;
    const auditLog = yield* AuditLog;
    const events = yield* AuthEvents;
    const registry = yield* DataExportRegistry;

    const exportAccount: AccountExportShape["exportAccount"] = (userId, options) =>
      Effect.gen(function* () {
        const user = yield* users.findById(userId);
        const email = Option.getOrUndefined(emailOf(user));
        const subject = email === undefined ? { userId } : { userId, email };
        const linked = yield* accounts.listByUser(userId);
        const live = yield* sessions.list(userId);
        // Newest first, as `AuditLog.list` orders; the person's own trail, no one else's.
        const trail = yield* auditLog.list({ actorUserId: userId }).pipe(Effect.orDie);
        const sections: Record<string, ExportSection> = {};
        for (const contribution of yield* registry.contributions) {
          sections[contribution.id] = yield* contribution.collect(subject);
        }
        const document: AccountExportDocument = {
          generatedAt: iso(yield* DateTime.now),
          user: {
            id: user.id,
            identity: user.identity,
            name: user.name,
            metadata: Option.getOrNull(user.metadata),
            createdAt: iso(user.createdAt),
            updatedAt: iso(user.updatedAt),
          },
          // A stable order (the stores return them in no particular one).
          accounts: linked
            .toSorted(
              (a, b) =>
                DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
                (`${a.providerId}:${a.subject}` < `${b.providerId}:${b.subject}` ? -1 : 1),
            )
            .map((account) => ({
              providerId: account.providerId,
              subject: account.subject,
              issuer: Option.getOrNull(account.issuer),
              createdAt: iso(account.createdAt),
            })),
          sessions: live.map((session) => ({
            id: session.id,
            createdAt: iso(session.createdAt),
            lastActiveAt: iso(session.lastActiveAt),
            expiresAt: iso(session.expiresAt),
            userAgent: Option.getOrNull(session.userAgent),
            amr: session.amr,
          })),
          activity: trail.map((row) => ({
            event: row.eventTag,
            occurredAt: iso(row.occurredAt),
            ip: Option.getOrNull(row.ip),
            userAgent: Option.getOrNull(row.userAgent),
          })),
          sections,
        };
        yield* events.publish({
          _tag: "auth.user.dataExported",
          userId,
          requestedBy: options?.requestedBy ?? "self",
        });
        return document;
      });

    return AccountExport.of({ exportAccount });
  }),
);
