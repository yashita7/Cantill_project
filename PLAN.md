# All-TypeScript delivery plan

## Current status — 17 Nov

- **Done:** pure engine and CLI; worked examples verified against private kit; deterministic matching, boundary tests, repeatable runs, CSV parsing and synthetic fixtures. Preferred CLI export uses fixed standalone ranking parameters independent of policy effective dates.
- **Done locally:** minimal Fastify/Drizzle API, setup upload screen, stored snapshots and runs, CSV exports, preferred export independent of policy date, and database health check. Endpoint tests use PGlite. The policy workflow supports PDF/text or chat proposals, raw JSON review with a plain-language diff, immutable approval and all three batch modes. Tests verify two synthetic amendments with a stub extractor. Live Gemini and hosted Supabase verification are pending.
- **Prepared:** Render Blueprint, production build and manual deployment checklist in `DEPLOYMENT.md`. Hosting and post-deploy checks remain unverified.
- **Not started:** hosted Supabase/Render setup, manual contract entry, deployment, monitoring, and hosted rehearsals. GitHub repository exists but has not been pushed by this agent.
- **Hardening complete locally:** setup token, CSV-only multipart processing, first-import policy v5.0 from private JSON, early-date preferred export test, and a live Gemini check script. Live Gemini and hosting remain unverified.
- **Employee chat implemented locally:** persisted drafts, deterministic matching and field validation, relative IST dates, candidate selection, explicit confirmation, PR storage and retry on Gemini failure. Ten automated scenarios pass. Live Gemini and browser verification remain pending.
- **Buyer workspace implemented locally:** process chat PRs and inspect runs, approve or override with audit, and view dated preferred scores. Hosted and browser verification remain pending.
- **Next:** verify the policy workflow with configured Gemini and Supabase, then deploy and rehearse. Keep kit data in ignored `private/`; do not commit it. After 19 Nov 10:00 IST only the three submission CSVs may be committed.
- **Date input:** sample `created_at` uses `YYYY-MM-DD HH:mm` in IST; `need_by_date` uses `YYYY-MM-DD`. Invalid dates retain their output row with a field-specific reason.

## Stack and package boundaries

- `packages/engine` owns the pure `process(policyJson, dataSnapshot, prLines)`
  function, Zod models, matching, policy evaluation, and decision logic.
- `packages/cli` owns filesystem reads and CSV exports.
- `apps/api` will use Fastify, Drizzle, and node-postgres. Database numeric columns
  remain strings until converted to decimal.js values by the engine.
- `apps/web` will use React, Vite, and TypeScript. Render serves its built assets
  from the same Node service as the API.
- Use Zod for API inputs and Gemini structured responses. Chat is an explicit
  understand/match/clarify/confirm/create state machine.

PDF extraction is the main additional integration concern in TypeScript. Start
with manual contract entry. Use the official Gemini SDK for policy-document
extraction, with plain text input and raw JSON correction available in the app.
Automatic contract prefill is optional after the complete workflow works.

## Schedule

| Date                                                  | Outcome                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Mon 16 Nov kickoff, completing engine gate Tue 17 Nov | Pure engine, CLI, private kit checks and public synthetic tests                                                              |
| Tue 17 Nov following gate report                      | Drizzle/Postgres persistence, setup/manual contracts, batch API/export, policy JSON editor/review/approval, first deployment |
| Wed 18 Nov                                            | Chat, buyer workspace, explanations/audit, guided blind-test workflow, Compose, documentation, two rehearsals, monitors      |
| Thu 19 Nov before 10 AM IST                           | Frozen deployment, hosting/import/export verification, public repository and hosted-link submission                          |
| Thu 10 AM–noon IST                                    | Baseline run, amendment approval/replay, preferred export, only three permitted CSV commits                                  |

The engine gate must report all fourteen worked examples, exact underlying
amounts, supplier choices, suggestions, grouping, and PO sharing before API/UI
implementation begins. Supplied numbered PO IDs are illustrative; tests assert
sharing relationships and rerun stability.

## Persistence and API

Use a Drizzle schema with a documented initialization command, avoiding schema
changes after freeze. Store immutable imported snapshots, contracts, source
metadata, approved policy versions, chat drafts, runs, original decisions,
buyer actions, and audit events. Actor names and roles come from the role switcher.

Implement `POST /api/process-batch`, run retrieval and CSV exports, policy
proposal/validation/approval, chat, manual contracts, preferred-supplier exports,
and `/health`. Use one snapshot and a fresh consumption ledger for each replay.
Run records retain policy mode, selected version, input, baseline, and results.
Buyer approval creates an order once. Overrides preserve original decisions and
require a comment.

## Hosted contract verification

The setup screen will load the external master CSVs and register/line CSVs. The
manual contract form will accept supplier, dates, value ceiling, starting
consumption, and multiple item/unit/rate rows. It will also accept the same
private JSON supplement used by the CLI. Save these values in PostgreSQL so they
survive Render restarts.

Verify the baseline screen shows 12 contracts and 31 item-rate lines. Open the
two manually added contracts, compare their five rates and zero starting
consumption with the local signed PDFs, refresh the page, and verify persistence.
Run a private sample request covered by each contract on or after its start date
and inspect the selected contract, supplier, exact price, and remaining ceiling.
The repository contains no embedded copy of those records.

## Policy updates and blind testing

The review screen shows the structured before/after change in plain language,
raw editable JSON, validation errors, effective date, and approval attribution.
Accept either document upload or a change described in chat. Preserve an
unapproved draft if Gemini fails and allow correction in the JSON editor.

Default to requirement-date mode. Show currently-active and explicit-approved
version options, preserving the operator's selection. When the amendment starts
after all requirement dates, warn that requirement-date replay has no affected
lines. The operator decides whether to select a different mode, and the run
records the choice. Preserve the documented procedure in DECISIONS.md before
freeze; record actual blind-test choices in run metadata/output reasons afterward
because only the three CSVs may be committed then.

Provide one guided flow to upload a batch, run v5.0 and download
`yashita__run1.csv`, approve an amendment and reprocess the retained batch for
`yashita__run2.csv`, then export `yashita__preferred.csv` for the requested date.
Test two synthetic amendments, including a plant/category/value rule, and run
one rehearsal with Gemini unavailable. All batch decisions remain deterministic.

## Hosting and review period

Provision Supabase plain PostgreSQL and Render's single free service. Use the
Supabase session-pooler connection on port 5432. Add a `/health` query against
PostgreSQL and report failures without exposing credentials. Configure local
two-minute and cron-job.org five-minute checks before Thursday 10 AM IST. Keep
the external check running through review and check Supabase pause warnings.

On Thursday at 9:30 AM IST, verify the frozen commit, health response, baseline
counts, private contract rates, sample export, and monitor history. Freeze
automatic deploys so later CSV pushes keep the reviewed app version.

Compare-runs UI, automated contract PDF prefill, and idempotent import enhancements
follow only if all required workflows and rehearsals are complete.
