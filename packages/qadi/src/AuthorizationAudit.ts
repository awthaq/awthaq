// @awthaq/qadi — AuthorizationAudit
//
// YL-004 (BEH-EA-156): `@qadi/http`'s `RequirePermission` already refuses, per
// request, an endpoint in a guarded group that declares neither
// `RequiredPermission` nor `PublicEndpoint` (fail closed: a 500, never an
// allow). That is a *runtime* answer — the mistake surfaces only when someone
// hits the route. `auditAuthorizationAnnotations` is its composition-time
// counterpart: walk the `HttpApi` once at startup and list every such
// endpoint, so an un-annotated route is caught before the server starts
// serving instead of after a user finds it.
import { PublicEndpoint, RequirePermission, RequiredPermission } from "@qadi/http";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

/** One endpoint in a `RequirePermission`-guarded group that says nothing about who may call it. */
export interface UnannotatedEndpoint {
  readonly group: string;
  readonly method: string;
  readonly path: string;
}

export class UnannotatedEndpoints extends Data.TaggedError("UnannotatedEndpoints")<{
  readonly endpoints: ReadonlyArray<UnannotatedEndpoint>;
}> {
  override get message(): string {
    return `awthaq: ${this.endpoints.length} endpoint(s) in a RequirePermission-guarded group declare neither RequiredPermission nor PublicEndpoint (they would answer 500 at request time): ${this.endpoints
      .map((e) => `${e.method} ${e.path} (${e.group})`)
      .join(", ")}`;
  }
}

/**
 * Fails with `UnannotatedEndpoints` naming every endpoint whose group carries
 * the `RequirePermission` middleware but which has neither annotation. Run it
 * from application startup (before `HttpRouter.serve`); succeeds when every
 * guarded endpoint either requires a permission or is deliberately public.
 * Endpoints outside a `RequirePermission`-guarded group are not this audit's
 * business (they are not opted in to qadi enforcement).
 */
export const auditAuthorizationAnnotations = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  api: HttpApi.HttpApi<Id, Groups>,
) =>
  Effect.suspend(() => {
    const unannotated: Array<UnannotatedEndpoint> = [];
    HttpApi.reflect(api, {
      onGroup: () => {},
      onEndpoint: ({ endpoint, group, mergedAnnotations, middleware }) => {
        if (!Array.from(middleware).some((service) => service.key === RequirePermission.key))
          return;
        const annotated =
          Context.getOption(mergedAnnotations, RequiredPermission)._tag === "Some" ||
          Context.getOption(mergedAnnotations, PublicEndpoint)._tag === "Some";
        if (!annotated) {
          unannotated.push({
            group: group.identifier,
            method: endpoint.method,
            path: endpoint.path,
          });
        }
      },
    });
    return unannotated.length === 0
      ? Effect.void
      : Effect.fail(new UnannotatedEndpoints({ endpoints: unannotated }));
  });
