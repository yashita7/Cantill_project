import { loadEnvFile } from "node:process";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";

// Credentials stay in this process and inherited environment, never in command arguments.
try {
  loadEnvFile();
} catch {
  console.error("FAIL: unable to read .env");
  process.exit(1);
}
const kit = process.env.CANTILL_KIT_PATH;
const root = process.cwd();
const output = join(root, "private/supabase-verification");
const read = (path: string) => readFile(path, "utf8");
const actor = { name: "Supabase verification", role: "Procurement" };
const buyer = { name: "Supabase verification", role: "Buyer" };
const baseUrl = "http://127.0.0.1:3101";
let child: ChildProcess | undefined;
let snapshotId = "";
let emptyDirectory: string | undefined;
const results: {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}[] = [];
function record(
  name: string,
  status: "PASS" | "FAIL" | "SKIP",
  detail: string,
) {
  results.push({ name, status, detail });
  console.log(`${status}: ${name} — ${detail}`);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function request(path: string, init?: RequestInit) {
  const response = await fetch(baseUrl + path, {
    ...init,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(
      `${path.split("?")[0].replace(/\/CHAT-[^/]+/g, "/[id]")} returned HTTP ${response.status}`,
    );
  return response;
}
async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function rows(csv: string): Record<string, string>[] {
  return parse(csv, { columns: true, bom: true, skip_empty_lines: true });
}
async function runStep(
  name: string,
  fn: () => Promise<string>,
): Promise<boolean> {
  try {
    record(name, "PASS", await fn());
    return true;
  } catch (error) {
    record(
      name,
      "FAIL",
      error instanceof Error ? error.message : "Unexpected failure",
    );
    return false;
  }
}
async function main() {
  assert(kit, "CANTILL_KIT_PATH is not set");
  assert(process.env.DATABASE_URL, "DATABASE_URL is missing");
  assert(process.env.SETUP_TOKEN, "SETUP_TOKEN is missing");
  const folder = resolve(kit);
  const [
    items,
    suppliers,
    history,
    plants,
    register,
    lines,
    supplement,
    policyText,
    batchCsv,
  ] = await Promise.all([
    read(join(folder, "master_data/item_master.csv")),
    read(join(folder, "master_data/supplier_master.csv")),
    read(join(folder, "master_data/po_history.csv")),
    read(join(folder, "master_data/plants.csv")),
    read(join(folder, "contracts/contract_register.csv")),
    read(join(folder, "contracts/contract_lines.csv")),
    read(join(root, "private/contracts.json")),
    read(join(root, "private/policy.json")),
    read(join(folder, "pr_batches/sample_pr_batch.csv")),
  ]);
  await mkdir(output, { recursive: true });
  const baseline = JSON.parse(policyText);
  const build = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "ignore",
  });
  assert(
    build.status === 0,
    "Build failed; run npm run build separately for details",
  );
  // A free port is required. Never use a server already listening on it.
  try {
    await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(1500) });
    throw new Error("Port 3101 is already in use");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Port 3101 is already in use"
    )
      throw error;
  }
  emptyDirectory = await mkdtemp(join(tmpdir(), "cantill-supabase-"));
  child = spawn(process.execPath, [join(root, "dist/server.js")], {
    cwd: emptyDirectory,
    env: { ...process.env, PORT: "3101" },
    stdio: "ignore",
  });
  let launchError = false;
  child.on("error", () => {
    launchError = true;
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (launchError || child.exitCode !== null) break;
    try {
      const r = await fetch(baseUrl + "/health", {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* waiting for startup */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!ready) {
    record("Health", "FAIL", "server did not start or database is unavailable");
    return;
  }
  await runStep("Health", async () => {
    const health = (await (await request("/health")).json()) as {
      status: string;
      database: string;
    };
    assert(
      health.status === "ok" && health.database === "ok",
      "Database health is not OK",
    );
    return "server and database are healthy";
  });
  const imported = await runStep("Setup import", async () => {
    const r = (await (
      await post(
        "/api/setup",
        {
          actor,
          asOf: "2026-11-16",
          files: {
            items,
            suppliers,
            history,
            plants,
            register,
            lines,
            supplement,
            policy: policyText,
          },
        },
        { "x-setup-token": process.env.SETUP_TOKEN! },
      )
    ).json()) as { id: string; counts: Record<string, number> };
    snapshotId = r.id;
    assert(
      r.counts.items === 73 &&
        r.counts.suppliers === 48 &&
        r.counts.contracts === 12 &&
        r.counts.rates === 31,
      "Unexpected import counts",
    );
    return `73 items, 48 suppliers, 12 contracts, 31 rates; snapshot ${snapshotId}`;
  });
  if (!imported) return;
  let runId = "",
    firstRows: Record<string, string>[] = [];
  const batchOk = await runStep("Batch and CLI comparison", async () => {
    const form = new FormData();
    form.set(
      "file",
      new Blob([batchCsv], { type: "text/csv" }),
      "sample_pr_batch.csv",
    );
    const run = (await (
      await request("/api/process-batch", { method: "POST", body: form })
    ).json()) as { id: string; result: { decisions: unknown[] } };
    runId = run.id;
    assert(
      run.result.decisions.length === 186,
      "API did not return 186 decisions",
    );
    const api = await (
      await request(`/api/runs/${runId}/export?slot=run1`)
    ).text();
    const cliPath = join(output, "cli-decisions.csv");
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/cli/src/main.ts",
        "--kit",
        folder,
        "--supplement",
        join(root, "private/contracts.json"),
        "--policy",
        join(root, "private/policy.json"),
        "--batch",
        join(folder, "pr_batches/sample_pr_batch.csv"),
        "--out",
        cliPath,
        "--snapshot-date",
        "2026-11-16",
      ],
      { cwd: root, stdio: "ignore" },
    );
    assert(cli.status === 0, "CLI failed");
    const cliText = await read(cliPath);
    firstRows = rows(api);
    const expected = rows(cliText);
    assert(
      firstRows.length === 186 && expected.length === 186,
      "Unexpected CSV row count",
    );
    assert(
      JSON.stringify(firstRows) === JSON.stringify(expected),
      "API and CLI CSV rows differ",
    );
    await writeFile(join(output, "api-decisions.csv"), api);
    return "186 rows identical";
  });
  await runStep("Preferred suppliers", async () => {
    const csv = await (
      await post("/api/preferred/export", { snapshotId, asOf: "2026-11-01" })
    ).text();
    assert(rows(csv).length === 155, "Expected 155 rows");
    await writeFile(join(output, "preferred.csv"), csv);
    return "155 rows for 2026-11-01";
  });
  await runStep("Synthetic amendment", async () => {
    const { approval: _approval, ...draft } = baseline.versions.find(
      (p: { version: string }) => p.version === "5.0",
    );
    draft.version = `synthetic-verification-${randomUUID()}`;
    draft.effective_date = "2099-01-01";
    draft.parameters.limits.spot = new Decimal(draft.parameters.limits.spot)
      .times(2)
      .toString();
    const review = (await (
      await post("/api/policies/review", {
        draft,
        baseVersion: "5.0",
        batch: { csv: batchCsv },
      })
    ).json()) as { changes: unknown[] };
    assert(review.changes.length > 0, "Review did not show changes");
    await post("/api/policies/approve", {
      actor,
      draft,
      baseVersion: "5.0",
      batch: { csv: batchCsv },
    });
    const selection = {
      mode: "explicit_version",
      version: draft.version,
      execution_date: draft.effective_date,
    };
    const changed = (await (
      await post("/api/process-batch", {
        actor,
        snapshotId,
        csv: batchCsv,
        selection,
      })
    ).json()) as { result: { decisions: Record<string, string>[] } };
    assert(
      changed.result.decisions.length === 186,
      "Amendment run has wrong row count",
    );
    const original = (await (
      await post("/api/process-batch", {
        actor,
        snapshotId,
        csv: batchCsv,
        selection: { ...selection, version: "5.0" },
      })
    ).json()) as { result: { decisions: Record<string, string>[] } };
    const fields = [
      "decision",
      "route",
      "supplier_id",
      "unit_price",
      "group_value_inr",
      "suggested_supplier_ids",
      "po_id",
    ];
    const differences = changed.result.decisions.filter((row, i) =>
      fields.some(
        (field) => row[field] !== original.result.decisions[i][field],
      ),
    ).length;
    return `approved ${draft.version}; ${differences} of 186 rows changed in decision fields`;
  });
  if (batchOk)
    await runStep("Buyer approve and override", async () => {
      const run = (await (
        await request(`/api/buyer/runs/${runId}`)
      ).json()) as {
        requirements: {
          group_id: string;
          decision: { decision: string; route: string };
        }[];
      };
      const candidates = run.requirements.filter(
        (r) => r.decision && r.decision.route !== "NOT_PROCESSED",
      );
      assert(candidates.length >= 2, "Need two actionable requirements");
      const url = (group: string) => `/api/buyer/runs/${runId}/${group}/action`;
      const first = (await (
        await post(url(candidates[0].group_id), {
          actor: buyer,
          action: "approve",
        })
      ).json()) as { created: boolean };
      const repeat = (await (
        await post(url(candidates[0].group_id), {
          actor: buyer,
          action: "approve",
        })
      ).json()) as { created: boolean };
      assert(
        first.created && !repeat.created,
        "Approval retry was not idempotent",
      );
      await post(url(candidates[1].group_id), {
        actor: buyer,
        action: "override",
        route: "RFQ",
        comment: "Synthetic verification override",
      });
      return "approval, retry and override succeeded";
    });
  else record("Buyer approve and override", "SKIP", "batch did not succeed");
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL)
    await runStep("Chat confirmation", async () => {
      const item = rows(items)[0];
      const started = (await (
        await post("/api/chat", { snapshotId, actor: "Supabase verification" })
      ).json()) as { id: string; revision: number };
      const future = DateTime.now()
        .setZone("Asia/Kolkata")
        .plus({ days: 30 })
        .toISODate();
      const message = `I need 1 ${item.uom} of ${item.description} for PUN1 by ${future}. Normal urgency.`;
      let state = (await (
        await post(`/api/chat/${started.id}`, {
          revision: started.revision,
          message,
        })
      ).json()) as {
        ready: boolean;
        revision: number;
        candidates: { item_code: string }[];
      };
      if (!state.ready && state.candidates?.length === 1)
        state = (await (
          await post(`/api/chat/${started.id}`, {
            revision: state.revision,
            candidate: state.candidates[0].item_code,
          })
        ).json()) as typeof state;
      assert(state.ready, "Chat requires an additional answer");
      const confirmed = (await (
        await post(`/api/chat/${started.id}`, {
          revision: state.revision,
          confirm: true,
        })
      ).json()) as { createdPr: { pr_no: string } };
      assert(!!confirmed.createdPr?.pr_no, "Chat did not create a PR");
      return "chat PR confirmed";
    });
  else record("Chat confirmation", "SKIP", "Gemini key and model are required");
  if (process.env.GEMINI_API_KEY) {
    const check = spawnSync("npm", ["run", "check:gemini"], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, VERIFY_SUPABASE_CHILD: "1" },
    });
    record(
      "Gemini extraction",
      check.status === 0 ? "PASS" : "FAIL",
      check.status === 0 ? "synthetic extraction validated" : "check failed",
    );
  } else record("Gemini extraction", "SKIP", "GEMINI_API_KEY is not set");
}
main()
  .catch((error) => {
    record(
      "Verification",
      "FAIL",
      error instanceof Error ? error.message : "Unexpected failure",
    );
  })
  .finally(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolveExit) =>
          child!.once("exit", () => resolveExit()),
        ),
        new Promise<void>((resolveExit) => setTimeout(resolveExit, 5000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (emptyDirectory)
      await rm(emptyDirectory, { recursive: true, force: true });
    console.log(`Snapshot ID: ${snapshotId || "not created"}`);
    if (results.some((result) => result.status === "FAIL"))
      process.exitCode = 1;
  });
