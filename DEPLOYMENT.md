# Manual Render and Supabase deployment

The current frontend consists of HTML pages served by Fastify at `/` and `/policies`. The build bundles those pages and the API into `dist/server.js`. It does not yet contain the planned React/Vite frontend.

## Configure and deploy

1. Push the committed repository to GitHub yourself. Keep kit files and `.env` outside Git.
2. In Supabase, create or select a project. In **Connect**, copy the **Session pooler** connection string on port **5432** and substitute your database password. The shared session pooler supports IPv4. Copy the entire string from the dashboard because its host and username are project-specific. See [Supabase connection options](https://supabase.com/docs/guides/database/connecting-to-postgres).
3. In Render, create a Blueprint from the repository and `render.yaml`, or create a single Node web service with build command `npm ci --include=dev && npm run build` and start command `npm start`. Use the free plan and `/health` for the health check. Render supplies `PORT` automatically. See [Render Blueprint reference](https://render.com/docs/blueprint-spec).
4. Set these environment variable names in Render. Enter the values in the dashboard, not in Git.

   - `SETUP_TOKEN` — required for setup and snapshot imports.
   - `DATABASE_URL` — the Supabase session pooler connection string.
   - `GEMINI_API_KEY` — required for policy extraction.
   - `GEMINI_MODEL` — a Gemini model ID supporting PDF input and structured output.
   - `NODE_VERSION` — set to `22` by `render.yaml`.
   - `PORT` — supplied by Render, so do not set it manually.

5. Deploy and check the build and application logs for a successful start. The application initializes the `procurement` schema at startup. The database role must be able to create the schema and tables.

## Verify the hosted app

- [ ] Open `/health` and confirm HTTP 200 and `{"status":"ok","database":"ok"}`.
- [ ] Open `/`, supply your name and snapshot date, then upload the six master and register CSVs, the private contract supplement JSON, and the private v5.0 policy JSON on first setup. Record the returned snapshot ID. Compare the displayed counts with your local source files and supplement. The setup screen does not currently display those two counts, so verify them in the Supabase database if needed.
- [ ] On `/policies`, confirm v5.0 is approved from setup. Select the snapshot ID and the intended policy mode for the checks below.
- [ ] For each of the two PDF-only contracts, choose an item from your private contract supplement and create a separate request dated within that contract's valid term. Use a valid plant, unit and need-by date.
- [ ] Compare the resulting route, supplier, unit price and contract named in the reason with your private supplement and the source PDF. A competing contract may be selected when it has a lower usable rate.
- [ ] Use the complete sample CSV header and valid values for all mandatory columns. Use unique PR identities, normal urgency and a need-by date after the creation date. Process each check in a separate run so each starts from the imported baseline. If another valid contract competes for the same item, inspect the reason and rate rather than assuming the PDF contract must win.
- [ ] Verify both contract headers and all five rates in the private supplement against the original PDFs before import. The current setup screen reports counts but has no contract detail viewer. The two checks above validate one rate per PDF through the decision engine, not all five hosted rates individually.
- [ ] Test a preferred export and policy review with a synthetic amendment. Keep a record of the deployed commit and snapshot ID.

The app currently has no authentication. Anyone who can reach it can approve policies and run requests. Setup imports require the setup token. Protect the hosted service before loading the kit data or sharing its URL.

Set `SETUP_TOKEN` in the server environment and enter it on the setup screen. The `/api/setup` and `/api/snapshots` endpoints require the `X-Setup-Token` header. Batch runs, policies and exports remain open.
