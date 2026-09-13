# Effect Native Auth

An authentication runtime for TypeScript, built natively on Effect v4, with authorization delegated to the sibling library [qadi](../qadi).

**Start here: [`spec/README.md`](spec/README.md).** That is the canonical specification — user requirements, architectural decisions, functional behaviors, invariants, and a traceability matrix tying them together, in the same ID-tagged, cross-referenced format qadi uses for its own spec.

This project is currently **pre-implementation**: no package has been published and no line of source exists yet. `spec/` describes what will be built, not what has shipped.

## Repository map

| Path | What it is |
|---|---|
| [`spec/`](spec/README.md) | The canonical specification. Read this first. |
| [`research/`](research/README.md) | The evidence base: 100 design questions answered by domain research, plus a five-part literature review on plugin-system science. Cited from `spec/decisions/` and `spec/behaviors/` as supporting evidence — not itself normative. |
| [`better-auth/`](better-auth/README.md) | A Design-by-Contract analysis of better-auth, a competing framework, used as a comparison point throughout the research and decisions. |
| [`archive/`](archive/PRD.md) | The pre-`spec/` product requirements document and design series. Superseded; kept for historical and evidentiary record. |
