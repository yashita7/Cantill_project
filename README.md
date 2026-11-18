# Cantill procurement application

The pure TypeScript engine and CSV CLI are implemented. The API, web interface,
database integration, Docker Compose application, and hosted deployment are the
next milestone. See [PLAN.md](PLAN.md) for the implementation order.

## Local engine verification

Use Node.js 22 or newer.

```sh
npm ci
npm run typecheck
npm test
```

Public tests contain synthetic fixtures. Private kit verification is available
in the original development checkout with `npm run verify:kit`. The supplied kit
and its derived fixtures are excluded from the repository.

## Run an external kit

Prepare a private policy bundle and a contract supplement using the exported
Zod schemas. A policy bundle contains approved `versions` and a `selection` with
`mode`, `execution_date`, and an optional explicit `version`. The supplement is
an array of contract headers with their `lines`, including starting consumption.

```sh
npm run cli -- \
  --kit /absolute/path/to/kit \
  --supplement private/contracts.json \
  --policy private/policy.json \
  --batch /absolute/path/to/batch.csv \
  --snapshot-date 2026-10-31 \
  --out private/decisions.csv \
  --preferred-date 2026-11-01 \
  --preferred-out private/preferred.csv
```

The CLI prints route counts and run metadata. Decision CSVs contain one row per
input row in input order. Rejected rows carry `NOT_PROCESSED` and a reason.

```text
pr_no,pr_line,resolved_item_code,group_id,po_id,decision,route,supplier_id,unit_price,group_value_inr,suggested_supplier_ids,policy_version,reason
```

Preferred CSVs contain `item_code,rank,supplier_id,reference_price`, with up to
three eligible suppliers per item for the selected date. The chosen date selects
the effective ranking policy independently of the decision run's replay mode.

## Structure

```text
packages/engine/      Pure engine, Zod models, policy interpreter, synthetic tests
packages/cli/         Filesystem/CSV adapter and command-line entry point
apps/api/             Planned Fastify service and Drizzle persistence
apps/web/             Planned React/Vite interface
private/              Ignored policy, contract supplement, private tests, outputs
```

The engine accepts `process(policyJson, dataSnapshot, prLines)` and returns a
serializable result containing decisions, matching evidence, requirements,
contract consumption, and metadata. Money and quantities cross this boundary
as decimal strings. Timestamps use `yyyy-MM-dd HH:mm` in Asia/Kolkata. Dates use
`yyyy-MM-dd`. Neither the wall clock nor external services are engine inputs.

## Repository handling

Keep supplied datasets, PDFs, extracted records, private expectations, outputs,
and secrets in `private/` or outside the repository. The initial commit excludes
`private/` explicitly and allows synthetic CSV fixtures elsewhere. Check
`git ls-files` before any push. This checkout currently has no remote.

Keep the hosted repository private until the candidate is ready to submit.
After 19 November 2026 at 10 AM IST, permitted commits contain only
`submission/yashita__run1.csv`, `submission/yashita__run2.csv`, and
`submission/yashita__preferred.csv`. Freeze deployment auto-updates before then.

## Deployment plan

Use one Render web service for Fastify and the compiled Vite assets, with
Supabase as plain PostgreSQL. Drizzle maps PostgreSQL numeric values to strings.
Use the Supabase **Session pooler** URL from Dashboard → Connect, port **5432**,
with a small node-postgres pool and verified TLS. Keep this URL server-side.

Direct connections suit persistent servers with IPv6 reachability. The session
pooler provides an IPv4-compatible connection for the planned deployment.
[Supabase connection documentation](https://supabase.com/docs/guides/database/connecting-to-postgres)

The Free plan includes a 500 MB database and permits two active free projects.
Projects with low database activity over seven days can pause. Check usage and
pause notifications throughout the review period.
[Supabase database-only limits](https://supabase.com/kb/faqs/platform/database-only-cost)
[Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)

The planned `/health` endpoint will execute `SELECT 1`, return database readiness,
and return a failure status if the query fails. Start a local two-minute checker
before Thursday 9:30 AM IST. Configure a free cron-job.org GET request every five
minutes before the freeze and retain it while the app is being reviewed. Verify
its execution history and failure notification settings. Perform a normal
application request each day and monitor Supabase status because free-tier
pausing is based on activity and has no uptime guarantee.
[Render free-service behavior](https://render.com/docs/free)
[cron-job.org capabilities](https://cron-job.org/en/)

Hosting, the health endpoint, and both monitors are pending implementation and
account setup. The final application milestone will add `docker compose up`
for the web/API service and a local PostgreSQL database.

## Minimal API and setup

Copy `.env.example` to `.env` and set `DATABASE_URL` to your Postgres session pooler connection string. The file is ignored by Git. Run `npm install` and `npm run build && npm start` (or `npm run dev` for local development), then open `http://localhost:3000/` and select the six kit CSVs, private contract supplement JSON, and the private v5.0 policy JSON for the first import. The response shows a snapshot ID and counts; save the ID for API calls. Files are sent to the running server and stored in its database. The setup screen is intentionally unauthenticated; protect access to any hosted instance yourself.

Open **Policies and batch runs** after importing data. The first setup imports and approves v5.0 using the actor name you supply. The server records the Procurement actor and approval time. To draft an amendment, choose an approved baseline and either upload a PDF/text file, describe the change, or copy the baseline and edit the JSON. Document and chat proposals send the selected source and baseline to Gemini. Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the server environment to enable extraction. The editor works without these settings.

Select the batch CSV before reviewing an amendment to see any effective-date warning. Approval leaves the batch mode as selected. For batch runs, supply the snapshot ID and choose **As of requirement date**, **Currently active version**, or **Explicit approved version**.

`POST /api/process-batch` accepts `{actor:{name,role},snapshotId,csv,selection:{mode,execution_date,version?}}`. Use an IST calendar date for `execution_date`. The server loads approved versions and saves the inputs and results. The run ID supports `GET /api/runs/:id` and `GET /api/runs/:id/export?slot=run1` (or `run2`). `POST /api/preferred/export` accepts `{snapshotId,asOf}`. `GET /health` checks the database.

For Render and Supabase setup, see [DEPLOYMENT.md](DEPLOYMENT.md).

Set `SETUP_TOKEN` in the server environment and enter it on the setup screen. The `/api/setup` and `/api/snapshots` endpoints require the `X-Setup-Token` header. Batch runs, policies and exports remain open.

For a CSV-only batch, send multipart form data with one `file` field to `POST /api/process-batch`. It uses the latest imported snapshot and the policy active on the current IST date. Run `npm run check:gemini` to make one live synthetic extraction check.

## Employee intake

Open `/chat`, enter your name and imported snapshot ID, then describe one item request. Answer the displayed question or select a candidate. Confirmation stores one PR line with a generated PR number and IST timestamp. Start another request for an additional item. Gemini extracts partial field updates. Follow-up questions currently use deterministic templates. Relative weekday dates mean the next occurrence strictly after today in IST, including “next Friday”. The summary displays the resolved calendar date before confirmation. Failed extraction preserves the database draft and the entered message for retry.

## Verify the local kit against the API

This check runs entirely on your laptop. It needs Node.js 22 or newer, the unmodified Cantill kit folder, and the private files `private/contracts.json` and `private/policy.json` prepared earlier for this project. The first file contains the five manually checked rates from the two PDF-only contracts. The second contains the validated v5.0 policy. Both stay in the Git-ignored `private/` folder. If either is missing, restore it from your private copy before running the check.

1. Open Terminal and go to the project folder. Run `npm install` once if dependencies are not installed.
2. Set the kit folder path for this terminal session. Replace the example with your own path, keeping the quotes if the path contains spaces.

   ```sh
   export CANTILL_KIT_PATH="$HOME/Downloads/Cantill_FullStack_Task_Kit"
   ```

3. Run `npm run verify:local`.
4. The command starts the API in the same process as a temporary PGlite database. It imports the local master CSVs, contract register, private supplement and policy through the setup API. It then sends the sample batch as a multipart upload to the process-batch API and downloads its decision CSV.
5. The command runs the CLI on the same inputs and compares every row and column. It also compares the API and CLI preferred-supplier exports for 1 November 2026. The command prints the expected row count for each matching export. If there is a difference, it prints the first ten differing rows and column names and exits with an error. A wrong row count also causes an error.
6. Find all four CSVs in `private/local-verification/`. That folder is ignored by Git. The temporary database is discarded when the command finishes. The API is exercised through Fastify's in-process HTTP request interface, so no local port or external account is needed.
