#!/usr/bin/env bash
# TS-001/ESR-009: run the real-Postgres suites (`*.postgres.test.ts`) against a
# throwaway postgres:16 container. This repo has no git remote, so the CI
# Postgres service in `.github/workflows/check.yml` has never run these; this
# is the local equivalent.
#
#   pnpm run test:pg                                       # starts a container, runs, removes it
#   AWTHAQ_POSTGRES_URL=postgres://... pnpm run test:pg    # use an existing server
#
# The suites `DROP SCHEMA public CASCADE` — point the URL at a scratch database.
set -euo pipefail

suites=(packages/sql/test/Repositories.postgres.test.ts packages/sql/test/RateLimiterStoreSql.postgres.test.ts)

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

pnpm exec vitest run "${suites[@]}"
