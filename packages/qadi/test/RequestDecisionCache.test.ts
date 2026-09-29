// Wayfinder ticket 12 (PCS-001/PCS-005): the safe default is a per-request
// `DecisionCache`. A real `HttpRouter.toWebHandler` test (the shape
// `AuthorizedSubject.test.ts` uses): within one request an identical second
// decision is served from the cache; across requests nothing survives, so a
// relationship revoked between two requests is visible on the next one with
// no invalidation layer at all.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { Authentication, AuthHttp } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import {
  evaluate,
  EvaluationServicesNone,
  hasRelationship,
  isAllowed,
  RelationshipResolver,
} from "@qadi/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuthorizedSubject from "../src/AuthorizedSubject.ts";
import * as RequestDecisionCache from "../src/RequestDecisionCache.ts";
import { TestAuth } from "@awthaq/test";

class Checked extends Schema.Class<Checked>("Checked")({
  first: Schema.Boolean,
  second: Schema.Boolean,
}) {}

const CheckGroup = HttpApiGroup.make("check")
  .add(HttpApiEndpoint.get("get", "/check", { success: Checked }))
  .middleware(AuthorizedSubject.AuthorizedSubject)
  .middleware(Api.OptionalAuthentication)
  // Declared last, so outermost: the cache wraps everything below it.
  .middleware(RequestDecisionCache.RequestDecisionCache);

const TestApi = HttpApi.make("auth").add(CheckGroup);

// The relationship store the decision consults; `answer` flips between
// requests, `calls` counts every real lookup.
const store = { answer: "Related" as "Related" | "Unrelated", calls: 0 };

const CountingResolver = Layer.succeed(RelationshipResolver, {
  name: "test/counting",
  check: () =>
    Effect.sync(() => {
      store.calls += 1;
      return store.answer;
    }),
});

const CheckHandlers = HttpApiBuilder.group(TestApi, "check", (handlers) =>
  handlers.handleAll({
    get: Effect.fnUntraced(function* () {
      const policy = hasRelationship("member");
      const first = isAllowed(yield* evaluate(policy, { resource: { id: "org-1" } }));
      const second = isAllowed(yield* evaluate(policy, { resource: { id: "org-1" } }));
      return new Checked({ first, second });
    }, Effect.orDie),
  }),
);

// The handler's evaluation services are a router-level requirement, supplied
// per call through `toWebHandler`'s context argument.
const EvaluationLive = Layer.mergeAll(EvaluationServicesNone, CountingResolver);

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(TestAuth.memoryFoundation),
);

const AppLayer = AuthHttp.routes(TestApi, {}).pipe(
  Layer.provide(CheckHandlers),
  Layer.provide(AuthorizedSubject.AuthorizedSubjectLive),
  Layer.provide(RequestDecisionCache.RequestDecisionCacheLive()),
  Layer.provide(Authentication.OptionalAuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

const get = (
  handler: (
    request: Request,
    context: Context.Context<Layer.Success<typeof EvaluationLive>>,
  ) => Promise<Response>,
  context: Context.Context<Layer.Success<typeof EvaluationLive>>,
) =>
  Effect.promise(async () => {
    const response = await handler(new Request("http://localhost/check"), context);
    return Schema.decodeUnknownSync(Checked)(await response.json());
  });

describe("RequestDecisionCache (per-request DecisionCache scope)", () => {
  it.effect(
    "an identical decision is cached within a request, and nothing survives into the next",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler } = HttpRouter.toWebHandler(AppLayer);
          const context = yield* Layer.build(EvaluationLive);
          store.calls = 0;
          store.answer = "Related";

          const first = yield* get(handler, context);
          assert.deepStrictEqual([first.first, first.second], [true, true]);
          // Two evaluations, one real lookup: the second was a cache hit.
          assert.strictEqual(store.calls, 1);

          // The relationship is revoked between requests — no invalidation layer.
          store.answer = "Unrelated";
          const second = yield* get(handler, context);
          assert.deepStrictEqual([second.first, second.second], [false, false]);
          assert.strictEqual(store.calls, 2);
        }),
      ),
  );
});
