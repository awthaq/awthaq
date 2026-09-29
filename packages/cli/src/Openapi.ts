// @awthaq/cli — Openapi
//
// spec/behaviors/26-cli.md BEH-EA-205, BEH-EA-208 class 1: one OpenAPI document generated from
// the same composed `api` the Effect client is generated from, by Effect's own generator
// (`OpenApi.fromApi`) — a team that never imports `effect` runs `openapi-typescript`, `hey-api`
// or `orval` over this file and never assembles per-plugin documents. `--out <file>` writes it
// with the platform FileSystem; otherwise it goes to stdout so `awthaq openapi > openapi.json`
// works. The output is always the JSON document (the `--json` flag changes nothing here).

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { ConfigUnavailable, MigrationFailed } from "./CliErrors.ts";
import type { LoadedAuth } from "./Config.ts";
import * as Output from "./Output.ts";

export const document = Effect.fnUntraced(function* (auth: LoadedAuth) {
  const api = auth.api;
  if (!HttpApi.isHttpApi(api)) {
    return yield* new ConfigUnavailable({
      message: "`auth.api` in the configuration module is not an HttpApi",
    });
  }
  return OpenApi.fromApi(api);
});

export const emit = (auth: LoadedAuth, options: { readonly out: string | undefined }) =>
  Effect.gen(function* () {
    const spec = yield* document(auth);
    const text = JSON.stringify(spec, null, 2);
    if (options.out === undefined) {
      const out = yield* Output.Output;
      return yield* out.line(text);
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(options.out, `${text}\n`)
      .pipe(
        Effect.mapError(() => new MigrationFailed({ message: `could not write ${options.out}` })),
      );
  });
