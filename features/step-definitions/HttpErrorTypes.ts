// BEH-EA-083 (REQ-EA-229): what `AuthHttp.routes(auth.api)` requires is a type, so its check is
// one — `tsc` (the `typecheck` gate) runs this file and the scenario's Then reads the constant.
// Every service the routes Layer needs is either a group service `auth.layer` (a plugin's handlers)
// or `AuthHttp.coreHandlers` (core's `session`/`account`) provides, or one of the platform
// services the host's server provides (`HttpServer.layerServices` / `toWebHandler`). Nothing else:
// no wiring step beyond the layers themselves.
import { AuthHttp } from "@awthaq/server";
import type * as Etag from "effect/unstable/http/Etag";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import type * as HttpRouter from "effect/unstable/http/HttpRouter";
import { builtPassword } from "./HttpErrorWorld.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const routes = AuthHttp.routes(builtPassword.api);

type RoutesNeed = Layer.Services<typeof routes>;
type Provided =
  | Layer.Success<typeof builtPassword.layer>
  | Layer.Success<typeof AuthHttp.coreHandlers>;
type Left = Exclude<RoutesNeed, Provided>;
type Platform =
  | HttpRouter.HttpRouter
  | Etag.Generator
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path;

type OnlyPlatformIsLeft = Expect<Equal<Left, Platform>>;

export const routesNeedOnlyWhatAuthLayerProvides: OnlyPlatformIsLeft = true;
