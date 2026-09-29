// @awthaq/next — ServerActionClient
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-189/190. BO-002/NSA-008: a typed,
// in-process client for server actions.
//
// BO-004: the client (cookie forwarding, the CSRF double-submit echo, the
// bootstrap retry, `Set-Cookie` -> jar) is framework-neutral and lives in
// `@awthaq/web` (`InProcessClient.ts`, where the recipe is documented). These
// are its Next-named entry points: `headers` is `await headers()` and `jar` is
// `await cookies()`.
//
//   yield* makeServerActionClient(AppApi, { handler, headers: await headers(), jar: await cookies() })
//   await serverActionClient(AppApi, { handler, headers: await headers(), jar: await cookies() })
export {
  inProcessClient as serverActionClient,
  makeInProcessClient as makeServerActionClient,
} from "@awthaq/web";
export type { InProcessClientOptions as ServerActionOptions } from "@awthaq/web";
