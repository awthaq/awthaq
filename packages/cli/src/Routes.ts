// @awthaq/cli — Routes
//
// spec/behaviors/26-cli.md BEH-EA-203, BEH-EA-208 class 1: a pure read of the composed `api`.
// `HttpApi.reflect` visits every endpoint of every group with its merged middleware, so the
// listing is the compiled contract exactly — nothing is filtered, nothing is requested, no
// handler runs, and no Layer is evaluated. The owning plugin is looked up in the manifest by the
// group identifier (`manifest.plugins[].groups`).

import * as Effect from "effect/Effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type { LoadedAuth } from "./Config.ts";
import { ConfigUnavailable } from "./CliErrors.ts";
import * as Output from "./Output.ts";

export interface Route {
  readonly method: string;
  readonly path: string;
  readonly group: string;
  /** The plugin whose contract owns the group; `undefined` if no manifest plugin claims it. */
  readonly plugin: string | undefined;
  /** The middleware keys applied to this endpoint (group and endpoint middleware, merged). */
  readonly middleware: ReadonlyArray<string>;
}

/** Every endpoint of the composed contract, in declaration order (group by group). */
export const routesOf = Effect.fnUntraced(function* (auth: LoadedAuth) {
  const api = auth.api;
  if (!HttpApi.isHttpApi(api)) {
    return yield* new ConfigUnavailable({
      message: "`auth.api` in the configuration module is not an HttpApi",
    });
  }
  const ownerOf = new Map<string, string>();
  for (const plugin of auth.manifest.plugins) {
    for (const group of plugin.groups) ownerOf.set(group, plugin.id);
  }
  const routes: Array<Route> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint, middleware }) => {
      routes.push({
        method: endpoint.method,
        path: endpoint.path,
        group: group.identifier,
        plugin: ownerOf.get(group.identifier),
        middleware: Array.from(middleware, (service) => service.key),
      });
    },
  });
  return routes;
});

export const renderText = (routes: ReadonlyArray<Route>) => {
  const width = (pick: (route: Route) => string, min: number) =>
    Math.max(min, ...routes.map((route) => pick(route).length));
  const methodWidth = width((route) => route.method, 6);
  const pathWidth = width((route) => route.path, 4);
  const groupWidth = width((route) => route.group, 5);
  const pluginWidth = width((route) => route.plugin ?? "-", 6);
  const row = (method: string, path: string, group: string, plugin: string, middleware: string) =>
    `${method.padEnd(methodWidth)}  ${path.padEnd(pathWidth)}  ${group.padEnd(groupWidth)}  ${plugin.padEnd(pluginWidth)}  ${middleware}`;
  return [
    row("METHOD", "PATH", "GROUP", "PLUGIN", "MIDDLEWARE"),
    ...routes.map((route) =>
      row(
        route.method,
        route.path,
        route.group,
        route.plugin ?? "-",
        route.middleware.length === 0 ? "-" : route.middleware.join(", "),
      ),
    ),
  ];
};

export const show = (auth: LoadedAuth) =>
  routesOf(auth).pipe(Effect.flatMap((routes) => Output.report(routes, renderText)));
