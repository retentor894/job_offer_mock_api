# Reviewer Setup Guide

Everything needed to install and run the full deliverable and watch every test
suite pass. Two parts, three repositories, four runnable test layers.

## What you'll run

| # | Deliverable | Repo | Command | Expected |
|---|---|---|---|---|
| 1 | Mock API — functional smoke | `job_offer_mock_api` | `npm test` | **54 passed** |
| 2 | Mock API — contract conformance | `job_offer_mock_api` | `./contract-tests/run-schemathesis.sh` | **~2000 passed, 2 warnings** |
| 3 | Part 1 — API test suite | `job_offer_API_testing_framework` | `npx playwright test` | **70 passed** |
| 4 | Part 2 — E2E suite (against a **local** Conduit) | `real_work_example_test_framework` | `npx playwright test` | **10 passed** |

Repositories:
- https://github.com/retentor894/job_offer_mock_api
- https://github.com/retentor894/job_offer_API_testing_framework
- https://github.com/retentor894/real_work_example_test_framework

## Prerequisites

- **Node.js ≥ 18** and npm
- **Python 3.8+** (only for the contract tests, step 2)
- **git**
- *(Optional — only for running Conduit locally, Appendix B)*: **Docker**

---

# Part 1 — Job Offer Microservice

## Step 1 — Mock API + contract conformance

```bash
git clone https://github.com/retentor894/job_offer_mock_api.git
cd job_offer_mock_api
npm install

# (1) functional smoke test — spins up its own server, no setup needed
npm test                      # → 54 passed, 0 failed

# (2) start the mock for the other suites + contract tests
npm start                     # serves http://localhost:8080/api/v1  (leave running)
```

In a second terminal, run the **contract conformance** suite (creates an isolated
Python venv and installs Schemathesis on first run):

```bash
cd job_offer_mock_api/contract-tests
./run-schemathesis.sh         # → 1900-2200 generated, all passed, 2 benign warnings
```

> The 2 warnings ("missing authentication", "missing valid test data") are
> expected — they're documented in `contract-tests/README.md` as artifacts of
> testing a stateful, multi-tenant API statelessly, not failures.

## Step 2 — Part 1 API test suite (Playwright)

With the **mock still running** on `:8080` (from step 1):

```bash
git clone https://github.com/retentor894/job_offer_API_testing_framework.git
cd job_offer_API_testing_framework
npm install
npx playwright test           # → 70 passed
```

- No browser download needed (these are HTTP/API tests).
- Defaults to `http://localhost:8080/api/v1`. To target another instance:
  `BASE_URL=https://your-host/api/v1 npx playwright test`.
- HTML report: `npm run report`.

---

# Part 2 — Conduit E2E suite (Playwright)

```bash
git clone https://github.com/retentor894/real_work_example_test_framework.git
cd real_work_example_test_framework
npm install
npx playwright install chromium          # downloads the browser (~one time)
```

## Step 3 — Run against a local Conduit (reliable, full green run)

The tests are self-contained: each creates its own unique user and data. For a
**complete 10/10 run**, point them at a local Conduit instance:

```bash
# 1. Start Conduit locally first — see Appendix B (Docker Postgres + the app)
# 2. Then, with the app on :3000 / :3001:
npx playwright test                      # → 10 passed
```

HTML report: `npm run report`.

### About the public live demo

There is a hosted demo, and the suite can target it
(`npm run test:demo`). **However, the demo heavily rate-limits registration**
(~5 requests/hour, HTTP 429 with `Retry-After` up to ~1h). Because the suite
self-registers ~13 users, it **cannot complete against the demo** — a few tests
pass, then the rest hit 429. Use the demo only for a quick partial smoke, or point
the suite at your own un-throttled deployment. **For a full run, use a local
instance (Appendix B).**

---

# Appendix A — One-glance "run it all" (local mock)

```bash
# Terminal 1: mock
git clone https://github.com/retentor894/job_offer_mock_api.git
cd job_offer_mock_api && npm install && npm start

# Terminal 2: contract tests
cd job_offer_mock_api/contract-tests && ./run-schemathesis.sh

# Terminal 3: smoke + Part 1 API suite
cd job_offer_mock_api && npm test
git clone https://github.com/retentor894/job_offer_API_testing_framework.git
cd job_offer_API_testing_framework && npm install && npx playwright test

# Terminal 4: Part 2 E2E (needs a local Conduit running — see Appendix B)
git clone https://github.com/retentor894/real_work_example_test_framework.git
cd real_work_example_test_framework && npm install && npx playwright install chromium
npx playwright test     # → 10 passed (against local Conduit on :3000/:3001)
```

---

# Appendix B — Running Conduit locally (for the full Part 2 run)

This is the recommended way to get a complete 10/10 E2E run (the public demo
rate-limits registration — see Part 2). The upstream repo has **no Docker** and
needs a SQL database; the steps below use Postgres in a container. Two small config
fixes are required (the repo's defaults are inconsistent).

```bash
git clone https://github.com/TonyMckes/conduit-realworld-example-app.git
cd conduit-realworld-example-app
npm install

# 1. Postgres in Docker (host port 5433 to avoid conflicts)
docker run --name conduit-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5433:5432 -d postgres:16
```

**2. Create `backend/.env`** (note: in `backend/`, not the repo root — the README is
wrong about this):

```dotenv
PORT=3001
JWT_KEY=supersecretkey_local_dev

DEV_DB_USERNAME=postgres
DEV_DB_PASSWORD=postgres
DEV_DB_NAME=database_development
DEV_DB_HOSTNAME=127.0.0.1
DEV_DB_PORT=5433
DEV_DB_DIALECT=postgres
DEV_DB_LOGGING=false
```

**3. Patch `backend/config/config.js`** — in the `development` block, add a `port`
and fix `logging` (a string `"false"` crashes Sequelize's `sync`):

```js
development: {
  username: process.env.DEV_DB_USERNAME,
  password: process.env.DEV_DB_PASSWORD,
  database: process.env.DEV_DB_NAME,
  host: process.env.DEV_DB_HOSTNAME,
  port: process.env.DEV_DB_PORT,                                   // ← add
  dialect: process.env.DEV_DB_DIALECT,
  logging: process.env.DEV_DB_LOGGING === "true" ? console.log : false,  // ← fix
},
```

**4. Create the DB, seed, and start:**

```bash
npm run sqlz -- db:create
npm run sqlz -- db:migrate       # create the tables — the app also syncs on boot,
                                 # but seeding below needs the tables to exist first
npm run sqlz -- db:seed:all      # optional dummy data
npm run dev                      # frontend :3000, backend :3001
```

> If you skip `db:migrate` and run `db:seed:all` first, you'll get
> `ERROR: relation "Users" does not exist` — the seeders need the tables to exist.

Then run the E2E suite with default URLs:

```bash
cd ../real_work_example_test_framework
npx playwright test              # → 10 passed
```

## Notes / known app quirks (surfaced by the E2E tests)

- **Hash routing**: routes are `/#/register`, `/#/article/:slug`, etc.
- **Native confirm dialogs** on delete (article and comment) — the page objects
  accept them.
- **Seeded users can't log in**: the DB seeder bypasses password hashing, so the
  tests self-register instead of relying on seed accounts.
