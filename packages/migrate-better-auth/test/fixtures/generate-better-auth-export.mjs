import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";

rmSync("export.sqlite", { force: true });
const db = new Database("export.sqlite");
const auth = betterAuth({
  database: db,
  secret: "fixture-secret-fixture-secret-fixture-secret",
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      plan: { type: "string", required: false },
    },
  },
});

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();

// A password user (credential account), signed up through better-auth's own API.
await auth.api.signUpEmail({
  body: { name: "Ada Lovelace", email: "ada@example.com", password: "ExistingUser123!", plan: "pro" },
});
db.prepare("UPDATE user SET emailVerified = 1 WHERE email = ?").run("ada@example.com");

// A second password user, left unverified.
await auth.api.signUpEmail({
  body: { name: "Alan Turing", email: "alan@example.com", password: "Enigma-Breaker-1912" },
});

// A social user with a GitHub account carrying provider tokens.
const ctx = await auth.$context;
await ctx.internalAdapter.createOAuthUser(
  {
    email: "grace@example.com",
    name: "Grace Hopper",
    emailVerified: true,
    image: "https://avatars.example.com/grace.png",
  },
  {
    providerId: "github",
    accountId: "1815",
    accessToken: "gho_fixtureAccessToken",
    refreshToken: "ghr_fixtureRefreshToken",
    scope: "read:user,user:email",
    accessTokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
  },
);

for (const table of ["user", "account", "session", "verification"]) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  console.log(table, rows.length, Object.keys(rows[0] ?? {}).join(","));
}
db.close();
