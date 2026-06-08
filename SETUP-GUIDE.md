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

## Prerequisites

- **Node.js ≥ 18** and npm
- **Python 3.8+** (only for the contract tests, step 2)
- **git**
- **Docker** (only for running Conduit locally, Part 2)

## Step 0 — Create one workspace and clone everything

Clone all repos into a **single parent folder** so every path below is unambiguous:

```bash
mkdir qa-homework && cd qa-homework      # your workspace — run all commands from here

git clone https://github.com/retentor894/job_offer_mock_api.git
git clone https://github.com/retentor894/job_offer_API_testing_framework.git
git clone https://github.com/retentor894/real_work_example_test_framework.git
git clone https://github.com/TonyMckes/conduit-realworld-example-app.git   # Part 2 only
```

Resulting layout (all siblings under `qa-homework/`):

```
qa-homework/
├── job_offer_mock_api/
├── job_offer_API_testing_framework/
├── real_work_example_test_framework/
└── conduit-realworld-example-app/
```

> Every `cd` below is **relative to this `qa-homework/` workspace folder**. Each
> step uses its own terminal; open new ones from `qa-homework/`.

---

# Part 1 — Job Offer Microservice

## Step 1 — Mock API + contract conformance

```bash
cd job_offer_mock_api
npm install

# (1) functional smoke test — spins up its own server, no setup needed
npm test                      # → 54 passed

# (2) start the mock for the other suites + contract tests
npm start                     # serves http://localhost:8080/api/v1  (leave running)
```

In a **new terminal** (from `qa-homework/`), run the **contract conformance** suite
(creates an isolated Python venv and installs Schemathesis on first run):

```bash
cd job_offer_mock_api/contract-tests
./run-schemathesis.sh         # → ~2000 generated, all passed, 2 benign warnings
```

> The 2 warnings ("missing authentication", "missing valid test data") are expected
> — documented in `contract-tests/README.md` as artifacts of testing a stateful,
> multi-tenant API statelessly, not failures.

## Step 2 — Part 1 API test suite (Playwright)

With the **mock still running** on `:8080`, in a **new terminal** (from `qa-homework/`):

```bash
cd job_offer_API_testing_framework
npm install
npx playwright test           # → 70 passed
```

- No browser download needed (these are HTTP/API tests).
- Defaults to `http://localhost:8080/api/v1`. Target another instance with
  `BASE_URL=https://your-host/api/v1 npx playwright test`.
- HTML report: `npm run report`.

---

# Part 2 — Conduit E2E suite (Playwright)

The E2E tests are self-contained (each creates its own unique user and data), so a
**local Conduit instance gives a full 10/10**. Start Conduit (Step 3), then run the
suite (Step 4).

> ⚠️ There is a hosted demo and the suite can target it (`npm run test:demo`), but it
> **heavily rate-limits registration** (~5 requests/hour, HTTP 429). Since the suite
> self-registers ~13 users, it **cannot complete against the demo** — use a local
> instance for a full run.

## Step 3 — Start Conduit locally

The upstream repo has **no Docker** and needs a SQL database; we use Postgres in a
container. Two small config fixes are required (the repo's defaults are inconsistent).

```bash
cd conduit-realworld-example-app
npm install

# Postgres in Docker (host port 5433 to avoid conflicts with a local 5432)
docker run --name conduit-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5433:5432 -d postgres:16
```

**Create `backend/.env`** (in `backend/`, not the repo root — the README is wrong):

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

**Patch `backend/config/config.js`** — in the `development` block add a `port` and
fix `logging` (a string `"false"` crashes Sequelize's `sync`):

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

**Create the DB and start the app:**

```bash
npm run sqlz -- db:create        # create the database
npm run dev                      # start the app — its sync({ alter: true }) builds the
                                 # FULL schema. Wait for "Server running on http://localhost:3001".
```

`npm run dev` **keeps this terminal busy** (the app must stay running). Leave it open.

> **Seeding is optional — the E2E suite does NOT need it.** If you want sample data
> for manual browsing, run `npm run sqlz -- db:seed:all` in another terminal **after
> the app is already running**. Seeding before the app starts fails with
> `relation "Users" does not exist` / `column "userId" ... does not exist`, because
> the association columns are only created by the app's `sync` on boot.

## Step 4 — Run the E2E suite

With Conduit running (Step 3), open a **new terminal** (from `qa-homework/`):

```bash
cd real_work_example_test_framework
npm install
npx playwright install chromium  # downloads the browser (~one time)
npx playwright test              # → 10 passed (default URLs :3000/:3001)
```

HTML report: `npm run report`.

## Reset Conduit / start fresh

To wipe the database and start clean (handy between manual runs):

```bash
docker rm -fv conduit-pg     # stop + remove the container AND its data (-v drops the volume)
```

Then re-create it and recreate the DB:

```bash
docker run --name conduit-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5433:5432 -d postgres:16
npm run sqlz -- db:create     # (run from conduit-realworld-example-app/)
npm run dev                   # rebuilds the schema on boot
```

## Known app quirks (surfaced while testing)

- **`NotFoundError: Article not found` in the Conduit console after a run** —
  **expected**. The delete test (ART-003) re-visits the article it just deleted to
  confirm it's gone, so the backend logs a handled 404 (`singleArticle`/`allComments`).
  The tests pass; the app just logs 404s verbosely.
- **Hash routing**: routes are `/#/register`, `/#/article/:slug`, etc.
- **Native confirm dialogs** on delete (article and comment) — the page objects
  accept them.
- **Seeded users can't log in**: the DB seeder bypasses password hashing, so the
  tests self-register instead of relying on seed accounts.
- **Backend tag-creation race**: creating articles in parallel that share a
  brand-new tag 500s on the losing requests; the suite gives each article a unique
  tag to avoid it. Flagged as a real app bug.

---

# Appendix — One-glance "run it all"

From `qa-homework/` after Step 0 (clones done), using four terminals:

```bash
# Terminal 1 — mock (leave running)
cd job_offer_mock_api && npm install && npm start

# Terminal 2 — contract tests
cd job_offer_mock_api/contract-tests && ./run-schemathesis.sh

# Terminal 3 — Part 1 smoke + API suite
cd job_offer_mock_api && npm test
cd job_offer_API_testing_framework && npm install && npx playwright test

# Terminal 4 — Conduit + Part 2 E2E (see Step 3 for the .env / config.js fixes)
cd conduit-realworld-example-app && npm install
docker run --name conduit-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -p 5433:5432 -d postgres:16
# ...create backend/.env + patch config.js (Step 3)...
npm run sqlz -- db:create && npm run dev      # leave running
# then in a 5th terminal:
cd real_work_example_test_framework && npm install && npx playwright install chromium && npx playwright test
```
