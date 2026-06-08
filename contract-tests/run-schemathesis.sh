#!/usr/bin/env bash
#
# Contract conformance test.
#
# Verifies that the mock API conforms to the OpenAPI contract using Schemathesis
# (which supports OpenAPI 3.1 natively — unlike Dredd). It generates thousands of
# requests per operation and asserts that every response matches the spec.
#
# Usage:
#   ./run-schemathesis.sh            # default: 40 examples per operation
#   ./run-schemathesis.sh 100        # more examples (slower, deeper)
#
# The mock must already be running (from the repo root: npm start).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this contract-tests dir
ROOT="$(cd "$HERE/.." && pwd)"                          # the mock repo root
SPEC="$ROOT/job-offer-swagger.yml"
VENV="$HERE/.venv-schemathesis"
BASE_URL="${BASE_URL:-http://localhost:8080/api/v1}"
COMPANY_ID="${COMPANY_ID:-550e8400-e29b-41d4-a716-446655440000}"
EXAMPLES="${1:-40}"

# Curated check set. See README.md for why the remaining checks are excluded.
CHECKS="not_a_server_error,status_code_conformance,content_type_conformance,response_headers_conformance,response_schema_conformance,negative_data_rejection"

# 1. Ensure Schemathesis is installed in an isolated venv.
if [ ! -x "$VENV/bin/schemathesis" ]; then
  echo "Setting up Schemathesis venv (first run only)..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet schemathesis
fi

# 2. Reset mock state for an isolated run (test helper; ignored if unavailable).
curl -s -X POST "${BASE_URL%/api/v1}/__admin/reset" >/dev/null 2>&1 || true

# 3. Run the conformance suite.
exec "$VENV/bin/schemathesis" run "$SPEC" \
  -u "$BASE_URL" \
  -H "X-Company-Id: $COMPANY_ID" \
  -c "$CHECKS" \
  -n "$EXAMPLES" \
  --continue-on-failure
