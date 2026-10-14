---
"@awthaq/core": minor
"@awthaq/cli": minor
---

`AuthPlugin.layer` takes an `exposes` option (ADR-EA-040, BEH-EA-329): a plugin may expose namespaced domain services (`awthaq/plugin/<id>/<name>`) beside its own service, so trusted callers reach its invariants through an interface of their own instead of its records. The exposed services join the layer's `ROut`, `Auth.make`'s fold discharges a dependent's requirement on them, and `Validate<P>` refuses a dependent that requires one without listing the exposer in `dependsOn`. `Manifest.exposes` lists them and `awthaq plugin list --graph` prints an `exposes:` line; `AuthPlugin.Class` gains the static `exposes`.

Migration: additive. A hand-built `Manifest` value (a test fixture) gains `exposes: []`; a `GraphNode` consumer sees a new `exposes` array.
