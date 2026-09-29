// @awthaq/cli — Application
//
// The one way a database-backed command (BEH-EA-208, class 2) gets the application's own services:
// build the `app` Layer the configuration module exports, once, on a short-lived runtime, hand the
// resulting `Context` to the command body, and close the scope when it returns. Nothing here
// starts a listener; it constructs services, exactly what the class allows.
//
// A build failure is *named*, never quoted: a `Config` error can carry the value it rejected (a
// secret), so the message is the failure's `_tag` (BEH-EA-201's no-secret-values rule).

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApplicationUnavailable } from "./CliErrors.ts";
import type { CliConfig } from "./Config.ts";

/** A failure's name for a message — its `_tag`, never its text, which may quote a secret. */
export const nameOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : "an unknown failure";

/** A service the application Layer must provide, or `ApplicationUnavailable` naming it. */
export const requireService = <I, S>(
  context: Context.Context<never>,
  key: Context.Key<I, S>,
  name: string,
  command: string,
) => {
  const found = Context.getOption(context, key);
  return found._tag === "Some"
    ? Effect.succeed(found.value)
    : Effect.fail(
        new ApplicationUnavailable({
          message: `the application Layer does not provide ${name}, which \`${command}\` needs`,
        }),
      );
};

/** Builds the application Layer for the duration of `use`; the scope closes when `use` returns. */
export const withApplication = <A, E, R>(
  config: CliConfig,
  use: (context: Context.Context<never>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const app = config.app;
    if (app === undefined) {
      return yield* new ApplicationUnavailable({
        message:
          "this command needs the application Layer: export `app` (auth.layer with every port and the SQL client provided) from the configuration module",
      });
    }
    const context = yield* Layer.build(app).pipe(
      Effect.mapError(
        (error) =>
          new ApplicationUnavailable({
            message: `the application Layer failed to build (${nameOf(error)})`,
          }),
      ),
    );
    return yield* use(context);
  }).pipe(Effect.scoped);
