#!/usr/bin/env bash
# TS-001/ESR-009/PV-010: run the real-Postgres suites against a throwaway
# postgres:16 container. This repo has no git remote, so the CI Postgres service
# in `.github/workflows/check.yml` has never run these; this is the local
# equivalent.
#
#   pnpm run test:pg                                       # starts a container, runs, removes it
#   AWTHAQ_POSTGRES_URL=postgres://... pnpm run test:pg    # use an existing server
#
# Two kinds of suite run:
#   * `*.postgres.test.ts` in @awthaq/sql (skipped without AWTHAQ_POSTGRES_URL);
#   * every plugin record-store suite (admin, jwt, organization, passkey, roles,
#     qadi claims, migrate-better-auth), which builds its database through
#     `packages/sql/test/support/TestSql.ts`: the same tests, on Postgres instead
#     of `:memory:` SQLite, each suite in its own schema.
#
# The suites `DROP TABLE`/`DROP SCHEMA` — point the URL at a scratch database.
set -euo pipefail

suites=(
  packages/cli/test/Migration.postgres.test.ts
  packages/sql/test/Repositories.postgres.test.ts
  packages/sql/test/RateLimiterStoreSql.postgres.test.ts
  packages/admin/test/ImpersonationRecords.test.ts
  packages/core/test/Users.test.ts
  packages/core/test/UserFields.test.ts
  packages/core/test/UserImport.test.ts
  packages/device-authorization/test/DeviceAuthorization.test.ts
  packages/device-authorization/test/AuthHttp.test.ts
  packages/jwt/test/KeyRing.test.ts
  packages/jwt/test/RevocationStore.test.ts
  packages/migrate-better-auth/test/LegacySessionBridgeLive.test.ts
  packages/organization/test/ActiveContextRecords.test.ts
  packages/organization/test/ConnectionRecords.test.ts
  packages/organization/test/InvitationRecords.test.ts
  packages/organization/test/MembershipRecords.test.ts
  packages/organization/test/OrgRoleRecords.test.ts
  packages/organization/test/OrganizationRecords.test.ts
  packages/organization/test/OrganizationSql.test.ts
  packages/organization/test/TeamRecords.test.ts
  packages/passkey/test/ChallengeStore.test.ts
  packages/passkey/test/PasskeyCredentials.test.ts
  packages/passkey/test/PasskeyUserHandle.test.ts
  packages/qadi/test/UserClaims.test.ts
  packages/scim/test/ScimRecords.test.ts
  packages/two-factor/test/TwoFactorStore.test.ts
  packages/roles/test/RolesSql.test.ts
  packages/saml/test/SamlRecords.test.ts
  packages/webhooks/test/WebhookRecords.test.ts
)

if [[ -z "${AWTHAQ_POSTGRES_URL:-}" ]]; then
  name="awthaq-test-pg-$$"
  port="${AWTHAQ_TEST_PG_PORT:-55432}"
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  docker run -d --name "$name" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=awthaq \
    -p "$port:5432" postgres:16-alpine >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  export AWTHAQ_POSTGRES_URL="postgres://postgres:pw@localhost:$port/awthaq"
fi

pnpm exec vitest run --testTimeout=60000 "${suites[@]}"
