# A beginner's guide to the procurement app

The app helps employees ask for things the company needs to buy. An employee can describe a request in chat, or a buyer can upload a CSV file, which is a table saved as text. The app checks the item and groups related requests. It estimates the total cost, checks existing supplier contracts, and applies the company's procurement policy. It then recommends a purchase order, called a PO, or a sourcing request, such as an RFQ (request for quotation) or RFP (request for proposal). A buyer can review the reason and approve or override the recommendation. The app stores its data in PostgreSQL, a database, and keeps an audit trail, which is a record of actions and their actors.

## How a request travels

```text
Employee chat                  CSV upload
chat-page.ts                   policy-page.ts
chat-routes.ts                 app.ts + cli/src/io.ts
chat.ts                        |
       \                       /
        -> Item matching: engine/src/matching.ts
        -> Group related lines: engine/src/engine.ts
        -> Value the group: engine/src/engine.ts
        -> Check contracts and remaining ceiling: engine/src/engine.ts
        -> Apply ordered policy rules: engine/src/policy.ts + engine.ts
        -> Choose contract supplier or rank suppliers: engine/src/suppliers.ts
        -> Recommend a PO or sourcing request: engine/src/engine.ts
        -> Buyer reviews and approves: api/src/buyer-page.ts + buyer.ts
```

The paths above are relative to `apps/api/src/` for API files and `packages/` for engine and CLI files. A contract ceiling is the maximum value the company can spend under that contract. The engine checks which contract is usable before it values the group, because the contract rate can be the value's price. The policy then decides the route. Each run starts with its own copy of the contract balances.

Chat uses Gemini to extract fields from a person's message. The matcher still checks the item. For a CSV, the matcher and the rest of the decision path do not call Gemini. The chat page currently creates one PR line per conversation. A CSV may contain many lines. A PR means purchase request. A requirement is one or more PR lines grouped for a decision.

## Project map

| Folder or file | Purpose |
| --- | --- |
| `packages/engine/` | Holds the decision engine and its tests. |
| `packages/engine/src/engine.ts` | Groups requests, values them, checks contracts and produces decisions. |
| `packages/engine/src/matching.ts` | Matches item codes or descriptions using fixed rules. |
| `packages/engine/src/policy.ts` | Checks policy data and evaluates its conditions. |
| `packages/engine/src/suppliers.ts` | Ranks preferred suppliers and suggests suppliers for sourcing. |
| `packages/engine/src/dates.ts` | Handles date and time calculations in India Standard Time (IST). |
| `packages/engine/src/model.ts` | Defines the shapes and basic checks for items, requests and results. |
| `packages/engine/src/index.ts` | Exposes the engine functions to the rest of the app. |
| `packages/engine/test/engine.test.ts` | Checks engine decisions, matching and date boundaries. |
| `packages/engine/test/fixtures.ts` | Supplies made-up example data for tests. |
| `packages/engine/package.json` | Identifies the engine package to the project. |
| `packages/cli/` | Holds the command-line interface, or CLI, for running from a terminal. |
| `packages/cli/src/main.ts` | Reads command options, runs the engine and writes output files. |
| `packages/cli/src/io.ts` | Reads kit files and creates decision and supplier CSVs. |
| `packages/cli/src/io.test.ts` | Tests CSV parsing and export. |
| `packages/cli/package.json` | Identifies the CLI package. |
| `apps/api/` | Holds the web server, its pages and database code. |
| `apps/api/src/server.ts` | Starts the server and connects it to the database and optional Gemini service. |
| `apps/api/src/app.ts` | Defines setup, batch, policy and export web endpoints. |
| `apps/api/src/db.ts` | Defines the database records and creates their table. |
| `apps/api/src/page.ts` | Provides the setup and import page. |
| `apps/api/src/policies.ts` | Extracts policy proposals and describes changes for review. |
| `apps/api/src/policy-page.ts` | Provides the policy review and batch run page. |
| `apps/api/src/chat.ts` | Extracts and validates chat fields and prepares a PR line. |
| `apps/api/src/chat-routes.ts` | Saves chat drafts and creates confirmed PRs. |
| `apps/api/src/chat-page.ts` | Provides the employee chat page. |
| `apps/api/src/buyer.ts` | Handles buyer decisions, supplier views and audit records. |
| `apps/api/src/buyer-page.ts` | Provides the buyer workspace. |
| `apps/api/src/*.test.ts` | Tests the API, chat and buyer behaviour. |
| `apps/api/package.json` | Identifies the API package. |
| `scripts/verify-local.ts` | Compares the API and CLI using your local kit and a temporary database. |
| `scripts/check-gemini.ts` | Makes one test call to Gemini using a made-up policy change. |
| `private/` | Holds ignored kit-derived data and local outputs on this laptop. |
| `.gitignore` | Lists files and folders Git should leave out. |
| `.env.example` | Lists environment variable names without real secrets. |
| `package.json` | Lists project commands and software dependencies. |
| `package-lock.json` | Records the exact installed dependency versions. |
| `tsconfig.json` | Configures TypeScript, the language used by the app. |
| `vitest.config.ts` | Configures the public test runner. |
| `vitest.private.config.ts` | Configures local private kit checks. |
| `render.yaml` | Describes the planned Render web service. |
| `README.md` | Explains how to run and verify the project. |
| `PLAN.md` | Records completed and remaining work. |
| `DECISIONS.md` | Explains assumptions and boundary choices. |
| `APPROACH.md` | Describes the implementation approach and AI use. |
| `DEPLOYMENT.md` | Gives the manual hosting and verification checklist. |
| `EXPLAINER.md` | Explains the project for a new reader. |

The pages currently come from the API files above. The planned React/Vite frontend has not been built. `node_modules/` contains installed libraries and `dist/` contains generated build output. Neither is source code.

## Policy as data

The policy is stored as JSON, a text format for structured data. It contains settings, ordered rules and actions. A rule says what to check, which policy clause it represents, and what route to recommend. `policy.ts` reads the conditions. `engine.ts` supplies facts such as the plant, value and whether a usable contract exists. The first matching rule supplies the action.

For example, the baseline policy stores a `spot` limit under `parameters.limits`. A rule refers to that setting by name. Procurement can copy an approved version in the policy review page, change the value, give the draft a new version and effective date, review the difference, and approve it. A simplified change might look like this:

```json
"limits": {
  "spot": "250000"
}
```

This changes the threshold read by rules that refer to `spot`. It does not change the other policy fields. The actual draft must include the complete policy, including its other limits and rules. Approval creates a new version. The batch screen lets the operator select the policy by requirement date, currently active date, or an explicitly chosen approved version. The chosen mode matters when a new version starts after the requests were created. The engine can combine facts it already understands, such as plant and value. A brand-new kind of fact would need a code change.

## Walkthrough of an invented request

This example uses made-up data. Imagine line 1 of `DEMO-PR-7`, created on 10 February 2027 for plant PUN1. It asks for **4 NOS** of `DEMO-ITEM-7`, a blue storage box. NOS means individual pieces. The requester estimates ₹150 per piece.

1. **Match.** The line has an item code. The item master contains that code with the same unit, so the matcher accepts it. It is a known item, so the new-item rule does not apply.
2. **Group.** The engine checks the plant and the configured grouping windows. In this example, no other request joins it. The requirement contains **4** pieces.
3. **Check the contract and value.** The invented contract `DEMO-CONTRACT-7` is valid on the requirement date, has an active supplier and has enough ceiling. Its rate is **₹125** per piece. The value is **4 × ₹125 = ₹500**. The engine uses this contract rate for valuation. Imagine the contract ceiling is ₹10,000 and ₹2,000 was already spent before this run.
4. **Apply the rule.** In this invented policy, clause **5.2** routes a usable contract to `CONTRACT_PO`. The selected supplier is **DEMO-SUPPLIER-7** at **₹125** per piece. The reason names the contract used to value and award the requirement.
5. **Review.** The output has decision `PO` and route `CONTRACT_PO`. A buyer can inspect the reason and approve it. IDs are assigned within each run.

## Quiz

1. What is a PR line?
2. What does the matcher do when a description is ambiguous?
3. Why does the engine group some request lines?
4. What is a contract ceiling?
5. Which price did the sample request use for valuation?
6. What does clause 5.2 recommend for the sample request?
7. What is the difference between a PO and an RFQ?
8. Where can Procurement change a limit without editing engine code?
9. Why can the selected policy mode affect a replay?
10. What records who approved or overrode a decision?

<details>
<summary>Show answers</summary>

1. One line in an employee's purchase request, describing an item and its quantity and other details.
2. It asks for clarification instead of choosing a candidate automatically.
3. Related lines can be treated as one requirement under the grouping rules.
4. The maximum amount that may be spent under a contract.
5. The invented contract rate, ₹125 per piece.
6. A contract PO with supplier DEMO-SUPPLIER-7.
7. A PO is an order to a supplier. An RFQ asks suppliers for quotations.
8. In a new policy JSON draft on the policy review page.
9. The modes select versions by different dates or by an explicit version.
10. The audit trail records the actor and time, and an override also records its comment.

</details>
