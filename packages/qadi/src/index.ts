// @awthaq/qadi — Authorization bridge (6)
//
// AuthorizedSubject middleware (Path A), SubjectExtractor layer (Path B),
// the SubjectResolver slot, and resolvers/obligation handlers — the bridge
// to qadi, not an authorizer of its own (ADR-EA-009).
//
// Implemented: SubjectResolver.ts (spec/behaviors/18-roles-subject-resolver.md,
// BEH-EA-137/142/143 — the identity-only default, see that module's own
// header comment for what BEH-EA-138/140/141 still need), AuthorizedSubject.ts
// (spec/behaviors/19-qadi-bridge-path-a.md, BEH-EA-145), SubjectExtractor.ts
// (spec/behaviors/20-qadi-bridge-path-b.md, BEH-EA-153), Resolvers.ts
// (spec/behaviors/21-qadi-resolvers-obligations.md, BEH-EA-161/165 — see
// that module's own header comment for what is deliberately deferred),
// SubjectApi.ts (the server half — real middleware attachment plus the
// handler — of `@awthaq/api`'s `SubjectContract`, BEH-EA-026's
// `SubjectDto`; added for spec/behaviors/23-react.md's BEH-EA-179 — see
// that module's own header comment for why the middleware/handler live
// here while the plain contract lives in `@awthaq/api`).
// See spec/overview.md for the full package map.

export * as AuthorizedSubject from "./AuthorizedSubject.ts";
export * as Resolvers from "./Resolvers.ts";
export * as SubjectApi from "./SubjectApi.ts";
export * as SubjectExtractor from "./SubjectExtractor.ts";
export * as SubjectResolver from "./SubjectResolver.ts";
