# deployment.md — Campus ERP core

## Run locally
1. Install Node.js **22 or newer** (the app uses the built-in `node:sqlite`).
2. `git clone <your repo URL> && cd campus-erp-core`
3. `npm install`
4. `cp .env.example .env`, then set `SESSION_SECRET` to a long random string (for example `openssl rand -hex 32`). Export the variables, or run `export $(grep -v '^#' .env | xargs)`.
5. `npm test` (20 tests should pass).
6. `npm start`, then open http://localhost:3000. The database file is created and seeded on first start.

## How it is deployed
One Node web service on Render (free tier), defined in `render.yaml`. Express serves the API and the static frontend from the same origin. Data is in SQLite.
**Limit:** the free tier has an ephemeral disk, so the database resets to the seed data on restart. This is fine for review. A real rollout would use a persistent disk or PostgreSQL.

Live app: https://campus-erp-core.onrender.com (repo: https://github.com/aakarshgopishetty/campus-erp-core)

To deploy: create a Render **Web Service** from the public GitHub repo with branch `main`, build command `npm install`, start command `node src/server.js`, instance type Free, and the environment variables below (`NODE_VERSION=22`, `SESSION_SECRET`). `render.yaml` in the repo describes the same setup for a Blueprint deploy.

## Environment variables (names only)
- `NODE_VERSION` (set to 22 on Render)
- `SESSION_SECRET` (required; signs sign-in tokens)
- `DEMO_PASSWORD` (optional; password for the seeded demo users)
- `DB_PATH` (optional; defaults to `./erp.db`)
- `PORT` (optional; set by Render)
- `ANTHROPIC_API_KEY` (optional; enables the AI path of the question assistant)
- `ASSISTANT_MODEL` (optional; model name for that path)

## Demo logins for the reviewer
Demo data only, no real personal data. Type the email and password below on the sign-in page. Leave `DEMO_PASSWORD` unset so the default applies.

| Role | Email | Password |
|---|---|---|
| Faculty | faculty@demo.test | demo-pass-1 |
| Office admin | admin@demo.test | demo-pass-1 |

## Suggested review path
1. Faculty: **Attendance**. Mark a class, then turn the network off in browser dev tools and save. The header shows "N pending". Go back online and it syncs.
2. Faculty: **Marks**. Edit a score. Then sign in as admin, press **Lock after moderation**, and sign back in as faculty to see that edits are blocked.
3. Faculty: **Leave** (request 2 days). Admin: **Dashboard**, then **Leave** (approve). **Admissions** (press Import on the sample CSV; the under-18 row is held). **Fees** (test payment, then Export receipts). **Ask** (try "second-year students below 75%" or "students with fee dues"). **Audit** shows every change. **Fees** has a test-mode payment. **At-risk** has *Create mentor tasks*.
