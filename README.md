# Job Offer — Mock API

> **Reviewers:** [`SETUP-GUIDE.md`](./SETUP-GUIDE.md) walks through installing and
> running the entire deliverable (both parts, all test suites) end to end.

An **in-memory mock** of the Job Offer Microservice (`job-offer-swagger QA26.yml`).
Its only purpose is to let you **validate the Part 1 test scenarios** before/while
writing the real runnable collection (Postman / Bruno / Playwright).

It implements the OpenAPI contract **plus** the behaviour described in the
exercise's *Technical Reference* (state machine, completeness rules, multi-tenancy,
per-company workflow config) — enough that every test case in the matrix produces
the expected status code and response shape.

> This is a behavioural stand-in, not a production service. State lives in memory
> and is wiped on restart (or via the reset helper).

## Requirements

- Node.js ≥ 18 (uses the built-in `fetch` in the smoke test)

## Run

```bash
cd mock-api
npm install
npm start          # http://localhost:8080/api/v1   (set PORT to change)
```

Validate that the mock behaves as the test matrix expects:

```bash
npm test           # drives one representative case per area — expect "54 passed, 0 failed"
```

## Base URL & auth

- Base path: `http://localhost:8080/api/v1`
- Every request needs an `X-Company-Id` header (a UUID).
  - missing → `401`
  - not a UUID → `400`
  - valid → request is scoped to that company

Two handy company UUIDs used in the smoke test:

| Company | UUID |
|---|---|
| A | `550e8400-e29b-41d4-a716-446655440000` |
| B | `660e8400-e29b-41d4-a716-446655440111` |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/job-offers` | list + filter (`status`, `titleContains`, `locationCity`, `createdAfter/Before`) + `sort` + `page`/`size` |
| `POST` | `/job-offers` | create in `DRAFT`, returns `Location` header |
| `GET` | `/job-offers/{id}` | full offer incl. `availableTransitions`, `isComplete` |
| `PUT` | `/job-offers/{id}` | only editable in `DRAFT` / `TO_FINALIZE` (else `409`) |
| `DELETE` | `/job-offers/{id}` | only deletable in `DRAFT` (else `409`) |
| `GET` | `/job-offers/{id}/transitions` | available transitions for current state |
| `POST` | `/job-offers/{id}/transitions/{action}` | `submit/finalize/approve/reject/post/close/reopen/withdraw` |
| `GET` | `/job-offers/{id}/history` | audit log, chronological |
| `GET` | `/companies/{companyId}/configuration` | `403` if `companyId` ≠ header |
| `PUT` | `/companies/{companyId}/configuration` | set `approvalRequired` / `partialSaveEnabled` / `manualPostingRequired` |

### Test helper (not in the spec)

```bash
curl -X POST http://localhost:8080/__admin/reset   # 204 — wipes all offers & configs
```

Use it between test runs for clean isolation.

## Behaviour modelled

**State machine** — linear pipeline, optional states skipped when their flag is off:

```
DRAFT → [TO_FINALIZE] → [TO_APPROVE] → [TO_POST] → PUBLISHED → CLOSED
         partialSave      approval       manualPosting
```

- `withdraw()` → back to `DRAFT` from any active state · `reopen()` → `CLOSED` → `PUBLISHED`
- `reject()` requires a `reason` (else `422`)
- Each offer **snapshots** the company config at creation, so config changes only
  affect *new* offers (existing ones keep their original workflow).

**Validation (`422`, `VALIDATION_ERROR` with `fieldErrors`)** — the request body is
validated against the full contract before persisting: title required/blank/>200,
location/address/compensation types, `CUSTOM` location missing address/city, enum
values (`SalaryType`/`BonusType`/`LocationType`), string lengths, `countryCode`
(`^[A-Z]{2}$`), negative `amount`, `currency` (`^[A-Z]{3}$`), and explicit `null`s
in non-nullable fields. This is what keeps responses contract-conformant (verified
by Schemathesis — see `./contract-tests/`).

**Completeness (`422`, `INCOMPLETE_OFFER`)** — `submit` of an incomplete offer when
`partialSaveEnabled=false`. Complete = title + location (+ address city/country if
`CUSTOM`) + at least one `compensation.salaryEntries`.

**Multi-tenancy** — offers are scoped per company; cross-company access returns `404`
(no information leakage). Cross-company *config* access returns `403`.

## Coverage

The smoke test (`test/smoke.js`) maps directly to the test matrix and currently
exercises: `HDR-001..004`, `CRUD-001..008`, `VAL-001..008`, `STM-001..008`,
`TRN-001..006`, `MTN-001..004`, `LST-001..007`, `CFG-001..005`, `HIS-001..004`.

## Contract conformance

Beyond the functional smoke test, this repo includes a property-based **contract
conformance** suite (Schemathesis) that verifies every response matches the
OpenAPI contract. See [`contract-tests/`](./contract-tests/).

## Layout

```
mock-api/
├── src/
│   ├── server.js          # Express app: routes, tenancy middleware, serializers
│   ├── stateMachine.js    # states, allowed actions, transition resolution
│   ├── validation.js      # body validation + completeness rules
│   └── store.js           # in-memory data + reset
├── test/
│   └── smoke.js           # one assertion per matrix area (npm test)
├── contract-tests/        # Schemathesis conformance suite (mock vs contract)
├── job-offer-swagger.yml  # the OpenAPI contract this mock implements
├── package.json
└── README.md
```
