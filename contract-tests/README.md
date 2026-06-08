# Contract conformance tests (Schemathesis)

These tests verify that this **mock API** faithfully implements the **OpenAPI
contract** (`../job-offer-swagger.yml`). They are property-based: Schemathesis
reads the spec, generates thousands of valid and invalid requests per operation,
and checks every response against the schema.

They live inside the mock repo because their subject *is* this mock — a second
test layer alongside `../test/smoke.js` (functional smoke). The functional
*deliverable* suite (Part 1, Playwright) lives in its own separate repository.

## Why Schemathesis and not Dredd

The spec is **OpenAPI 3.1**. Dredd's parser only supports 3.0.x — it emits dozens
of `unsupported key` warnings, drops `nullable`/`examples`, and finally aborts
with `Required URI parameter '...' has no example or default value` because it
can't build concrete request URLs. Schemathesis supports 3.1 natively and, being
property-based, doesn't need hand-written examples for every path parameter.

(Dredd is also a poor fit here for a deeper reason: it tests each documented
response in isolation, statelessly. This API is **stateful** — a `GET /{id}` that
returns `200` requires first creating that resource — so Dredd would need a hooks
file to create and substitute resources for almost every transaction.)

## Requirements

- Python 3.8+ (`python3`)
- The mock running locally (from the repo root: `npm start`)

The script creates an isolated venv at `contract-tests/.venv-schemathesis` on the
first run and installs Schemathesis there.

## Run

```bash
npm start                                     # terminal 1 (from repo root)
cd contract-tests && ./run-schemathesis.sh    # terminal 2

./run-schemathesis.sh 100                     # deeper run (100 examples/operation)
```

Override the target with env vars: `BASE_URL`, `COMPANY_ID`.

Expected result: **all generated cases pass** (only benign warnings remain — see
below).

## Checks we run (the conformance gate)

| Check | What it asserts |
|---|---|
| `not_a_server_error` | No `5xx` for any generated input |
| `status_code_conformance` | Every returned status is documented for that operation |
| `content_type_conformance` | Response content types match the spec |
| `response_headers_conformance` | Response headers (e.g. `Location`) match their schema |
| `response_schema_conformance` | Response bodies validate against their schema |
| `negative_data_rejection` | Schema-violating requests are rejected (`4xx`), not accepted |

Bugs these caught in the mock (all fixed):
- **2× `500`** — `null` array entries (`bonusEntries: [null]`) and a stored
  non-string `city` crashing the list filter.
- **Undocumented `400`** — an over-strict UUID regex rejecting valid IDs.
- **Location header** — was a relative URI; the schema requires `format: uri`.
- **20 response-schema violations** — the mock echoed back un-validated optional
  fields (bad enums, wrong types, over-length strings, explicit `null`s). Fixed by
  validating the full request body against the contract before persisting.

## Checks we deliberately exclude (with rationale)

These are not bugs — they are artifacts of testing a **stateful, gateway-authed,
multi-tenant** API statelessly. Each is covered elsewhere or is out of contract
scope:

| Excluded check | Why |
|---|---|
| `positive_data_acceptance` | The transition endpoint legitimately returns `400`/`422` for a schema-valid body when the action isn't allowed in the current state (e.g. `approve` from `DRAFT`). That's the core domain behaviour and can't be judged statelessly. Covered by `STM-*`/`TRN-*` functional tests. |
| `missing_required_header` | We inject a valid `X-Company-Id` on every request (the spec says auth is handled by an upstream gateway). The missing/invalid-header behaviour is asserted explicitly by `HDR-002` (401) and `HDR-003` (400). |
| `unsupported_method` | The spec defines no `405` responses; Express returns `404` for undefined method+path combos. Out of contract scope. |
| `use_after_free`, `ensure_resource_availability` | Require OpenAPI `links` to chain create→read→delete. The spec defines none, so these can't run meaningfully. |
| `ignored_auth` | Auth is an upstream-gateway concern, explicitly out of scope for this service. |

## Benign warnings

The run finishes with warnings (not failures) that are expected for this API:

- **Missing authentication (2 ops)** — `/companies/{companyId}/configuration`
  returns only `401/403` because the random path `companyId` rarely equals the
  fixed header company. Correct multi-tenant behaviour.
- **Missing valid test data (N ops)** — `/{jobOfferId}` operations return `404`
  for random UUIDs that don't exist (no `links` to create them first).
- **Schema validation mismatch (1 op)** — `POST/PUT /job-offers` rejects most
  randomly-generated bodies because required business fields are absent. Expected.
