#!/usr/bin/env bash
# TS-001/ESR-009/PV-010: run every vitest project and then the BDD suite against a throwaway
# postgres:16 container: the set CI's `pnpm check` runs with AWTHAQ_POSTGRES_URL set (see
# `.github/workflows/check.yml`). This is the local equivalent.
#
#   pnpm run test:pg                                       # starts a container, runs, removes it
#   AWTHAQ_POSTGRES_URL=postgres://... pnpm run test:pg    # use an existing server
#   pnpm run test:pg packages/organization/test            # only those paths (no BDD run)
#
# A suite that builds its database through `TestSql` (directly, through `TestAuth`'s
# `records: "sql"`, `RecordsContract` or `runPluginContractTests`) runs on a Postgres schema per
# suite; the rest run unchanged. There is no list of files to keep: `pnpm check:contract-tests`
# fails when this script names a test file (plan 37, BEH-EA-336).
#
# The suites `DROP TABLE`/`DROP SCHEMA` -- point the URL at a scratch database.
set -euo pipefail

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

if [[ $# -gt 0 ]]; then
  pnpm exec vitest run --testTimeout=60000 "$@"
else
  pnpm exec vitest run --testTimeout=60000
  pnpm test:bdd
fi
