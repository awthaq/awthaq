---
"@awthaq/core": minor
"@awthaq/cli": patch
"@awthaq/api": patch
---

`Auth.LinkError`, `Auth.linkErrorTags` and `Auth.isLinkError` name every error the composition path raises, and the CLI loader classifies with them instead of keeping its own list. `awthaq doctor` now reports an invalid user field, a conflicting `dependsOn`, an invalid sealed column and an endpoint with two session lifecycles as `link-<code>` findings. The last is a tagged `SessionLifecycle.Conflict` (was a plain `Error`).

Migration: a script that matched exit 9 from `doctor` for these misconfigurations now sees exit 3 and a `link-<code>` finding; other commands still exit 9, with the error tag `LinkProblem` instead of `ConfigUnavailable`.
