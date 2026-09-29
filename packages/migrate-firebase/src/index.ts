// @awthaq/migrate-firebase
//
// FAMS-001 (decision 21): lets users exported from Firebase Authentication keep
// their passwords. See this package's README for the migration recipe.
//
// FAMS-010: `ImportFirebaseUser` maps an `auth:export` user onto `@awthaq/core`'s
// `UserImport` shape — the adapter behind `awthaq import --from firebase`.

export * as FirebaseScryptVerifier from "./FirebaseScryptVerifier.ts";
export * as ImportFirebaseUser from "./ImportFirebaseUser.ts";
