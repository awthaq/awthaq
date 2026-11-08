---
"@awthaq/server": minor
---

`AuthHost.layer(auth, { persistence, csrf, ... })` turns an `Auth.make` result into the servable layer: routes, core handlers, every plugin's records bundle and hook points, core services and registries, the derived middleware, user fields, `RequestContext` and `BodyLimit`, and in SQL mode the migrations (`migrations: "apply" | "verify"`). Its requirements are exactly the ports and platform services the host owns (ADR-EA-044, BEH-EA-340, BEH-EA-341).

Migration: none required (additive). A hand-built host composition can be replaced by one call; keep your ports, your `SqlClient` and your jobs (`Retention.layerScheduled`, `SecuritySignals.layer`) beside it, and drop `BodyLimit.layer`/`RequestContext.layer` from your own list (or pass `bodyLimit: false` / `requestContext: false`).
