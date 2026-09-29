// @awthaq/cli — Browser
//
// BEH-EA-307: the interactive `login` offers to open the verification page in the person's browser
// (`--no-browser` opts out). Opening a page is a courtesy, never a requirement — the URL and the user
// code are always printed — so this port answers `false` instead of failing when no opener exists (a
// headless box, an SSH session, a container).
//
// The URL comes from the auth server, so it is only ever opened when it is an `http(s)` URL, and it
// travels as one argv element (no shell), so a `&` or a quote in it cannot become a command.
// The opener is the platform's own: `open` (macOS), `xdg-open` (Linux), `rundll32 url.dll,FileProtocolHandler`
// (Windows, which needs no shell quoting), run through the same `Exec` port the credential store uses.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Exec } from "./CredentialStore.ts";
import type { ExecShape } from "./CredentialStore.ts";

export interface BrowserShape {
  /** Tries to open `url`; `false` when it could not (no opener, a refused scheme, a non-zero exit). */
  readonly open: (url: string) => Effect.Effect<boolean>;
}

export class Browser extends Context.Service<Browser, BrowserShape>()("awthaq/cli/Browser") {}

/** Only a web page is ever opened: never `file:`, `javascript:` or an app-scheme URL a server might send. */
export const isWebUrl = (url: string): boolean => URL.canParse(url) && /^https?:\/\//i.test(url);

/** The opener for `platform` and the argv that carries the URL; `undefined` where none is known. */
export const openerFor = (
  platform: string,
  url: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined =>
  platform === "darwin"
    ? { command: "open", args: [url] }
    : platform === "linux"
      ? { command: "xdg-open", args: [url] }
      : platform === "win32"
        ? { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
        : undefined;

export const make = (platform: string, exec: ExecShape): BrowserShape => ({
  open: (url) => {
    const opener = isWebUrl(url) ? openerFor(platform, url) : undefined;
    if (opener === undefined) return Effect.succeed(false);
    return exec
      .run(opener.command, opener.args)
      .pipe(Effect.map((result) => result !== undefined && result.exitCode === 0));
  },
});

/** The real opener: the process's platform over the `Exec` port (`CredentialStore.layerExec` in the binary). */
export const layer = Layer.effect(
  Browser,
  Effect.gen(function* () {
    const exec = yield* Exec;
    return Browser.of(make(process.platform, exec));
  }),
);

/** An opener that never opens anything: what tests (and any non-interactive embedder) provide. */
export const layerNone = Layer.succeed(Browser, Browser.of({ open: () => Effect.succeed(false) }));
