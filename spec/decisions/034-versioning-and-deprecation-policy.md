# ADR-EA-034: Before 1.0 Breaking Changes Are Allowed, Each With a Changeset That Carries a Migration Note

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-034 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented (policy in `CONTRIBUTING.md`; changeset gate in `.github/workflows/check.yml`) |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (AVS-009) |

---

## Context

The versioning tooling was wired (Changesets, a fixed version group, an OIDC release workflow) but no policy said what a "breaking change" is, how one is communicated, or how the rules change at 1.0. ADR-EA-003 already accepts that a break in the `HttpApi` contract is a break for every plugin; nothing said how that break reaches a consumer. Nothing is published yet, so there are no consumers to protect today, and the ongoing API consolidation (folding overlapping surfaces together) should not be slowed by a deprecation ceremony that has no one to serve.

## Decision

1. **What counts as a change to the public surface.** Three surfaces are versioned: the `Schema` shapes that cross a package boundary or the wire (request, response, error and event payloads); the `HttpApi` contract (paths, methods, status codes, error tags); and the `Layer`/`Service` signatures (a service's shape, a layer's requirements, a plugin's `Api`). Each change is *additive* (a new optional field, endpoint, service member or export), *compatible* (a bug fix or tightening that no correct caller observes) or *breaking* (anything else: a removed or renamed export, a narrowed input, a changed status code or error tag, a new requirement on a layer that composed before).
2. **Before 1.0, breaking changes are allowed in any release, and each one is announced.** Every pull request that changes a package's public behavior carries a changeset. A breaking change's changeset has a `Migration:` section that says what a consumer must change, and names the ADR-EA and BEH-EA ids involved. There is no deprecation window and no runtime warning: the product's value wins over API stability while there are no consumers.
3. **From 1.0, a break needs a major version, after a window.** A behavior to be removed is first marked `@deprecated` in JSDoc with its replacement and logged once at layer build (`Effect.logWarning`), and removed no earlier than the next minor release. Additive and compatible changes are minor and patch releases.
4. **An `effect` release-candidate bump that changes a public type counts as breaking**, because the pinned `effect` is part of every package's surface (ADR-EA-003). It is announced in the same way.
5. **The changeset requirement is enforced.** `.github/workflows/check.yml` runs `changeset status` on every pull request, so a change under `packages/` without a changeset fails; `pnpm changeset --empty` is the explicit "no release impact" answer for tooling, test or documentation-only changes.
6. **Versions move in lockstep.** All packages are one Changesets `fixed` group (kept in sync with the package roster by `pnpm workspace:check`), so a breaking change in any package is a version bump for all of them.

## Alternatives considered

**Strict one-minor deprecation windows with runtime warnings starting now.** Rejected: with no consumers it costs every consolidation a shim and a warning path and protects nobody; it also fights the standing preference that product value wins over API stability in a pre-release library.

**Defer any policy until the first publication.** Rejected: the first breaking change lands long before it, and the habit (a changeset per change, a migration note per break) is cheapest to build while the history is short.

## Consequences

**Positive**: every break is communicated from the first release; the rule flips cleanly at 1.0; the changelog is a real migration guide.

**Negative**: contributors write a changeset for changes they would previously have merged without one; a pre-1.0 consumer must read release notes on every upgrade.
