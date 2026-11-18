import { loadEnvFile } from "node:process";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";
import { matchItem } from "@cantill/engine";
import { snapshotFromFiles, parseCsv } from "../packages/cli/src/io.js";

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
let lastGeminiCall = 0;
async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const usesGemini =
    path === "/api/policies/propose" ||
    (/^\/api\/chat\/[^/]+$/.test(path) &&
      typeof body === "object" &&
      body !== null &&
      "message" in body);
  for (let attempt = 0; attempt < (usesGemini ? 3 : 1); attempt++) {
    if (usesGemini) {
      const delay = Math.max(0, 8000 - (Date.now() - lastGeminiCall));
      if (delay)
        await new Promise((resolveWait) => setTimeout(resolveWait, delay));
      lastGeminiCall = Date.now();
    }
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (response.ok) return response;
    if (
      usesGemini &&
      (response.status === 503 || response.status === 422) &&
      attempt < 2
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 12000));
      continue;
    }
    throw new Error(
      `${path.split("?")[0].replace(/\/CHAT-[^/]+/g, "/[id]")} returned HTTP ${response.status}`,
    );
  }
  throw new Error("Request failed");
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
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL) {
    const snapshot = snapshotFromFiles(
      {
        items: parseCsv(items),
        suppliers: parseCsv(suppliers),
        history: parseCsv(history),
        plants: parseCsv(plants),
        register: parseCsv(register),
        lines: parseCsv(lines),
        supplement,
      },
      "2026-11-16",
    );
    const item = snapshot.items[0];
    const future = DateTime.now()
      .setZone("Asia/Kolkata")
      .plus({ days: 30 })
      .toISODate();
    type Chat = {
      id: string;
      revision: number;
      ready: boolean;
      question: string;
      candidates: { item_code: string }[];
      summary?: { quantity: string; item_code: string };
      createdPr?: { pr_no: string; quantity: string };
    };
    const startChat = async () =>
      (await (
        await post("/api/chat", { snapshotId, actor: "Supabase verification" })
      ).json()) as Chat;
    const send = async (chat: Chat, message: string) =>
      (await (
        await post(`/api/chat/${chat.id}`, { revision: chat.revision, message })
      ).json()) as Chat;
    const select = async (chat: Chat, candidate: string) =>
      (await (
        await post(`/api/chat/${chat.id}`, {
          revision: chat.revision,
          candidate,
        })
      ).json()) as Chat;
    const confirm = async (chat: Chat) =>
      (await (
        await post(`/api/chat/${chat.id}`, {
          revision: chat.revision,
          confirm: true,
        })
      ).json()) as Chat;
    const text = (quantity: string) =>
      `I need ${quantity} ${item.uom} of ${item.description} for PUN1 by ${future}. Normal urgency.`;
    await runStep("Chat complete request", async () => {
      let chat = await send(await startChat(), text("2"));
      if (
        !chat.ready &&
        chat.candidates?.some(
          (candidate) => candidate.item_code === item.item_code,
        )
      )
        chat = await select(chat, item.item_code);
      assert(
        chat.ready &&
          chat.summary?.item_code === item.item_code &&
          chat.summary.quantity === "2",
        "Complete request was not understood correctly",
      );
      chat = await confirm(chat);
      assert(!!chat.createdPr?.pr_no, "PR was not created");
      return "confirmed";
    });
    await runStep("Chat missing quantity", async () => {
      let chat = await send(
        await startChat(),
        `I need ${item.description}, unit ${item.uom}, for PUN1 by ${future}. Normal urgency. I have not decided the quantity.`,
      );
      if (
        chat.candidates?.some(
          (candidate) => candidate.item_code === item.item_code,
        )
      )
        chat = await select(chat, item.item_code);
      assert(
        !chat.ready && /quantity/i.test(chat.question),
        "Expected a quantity follow-up",
      );
      chat = await send(chat, "The quantity is 3.");
      // The model may omit other fields from the first message. Answer any
      // subsequent questions instead of treating an incomplete draft as ready.
      for (let i = 0; i < 3 && !chat.ready; i++) {
        if (/plant/i.test(chat.question))
          chat = await send(chat, "The plant is PUN1.");
        else if (/when|date/i.test(chat.question))
          chat = await send(chat, `The need-by date is ${future}.`);
        else if (/normal|emergency/i.test(chat.question))
          chat = await send(chat, "The urgency is Normal.");
        else break;
      }
      assert(
        chat.ready && chat.summary?.quantity === "3",
        "Quantity follow-up was not retained",
      );
      chat = await confirm(chat);
      assert(!!chat.createdPr?.pr_no, "PR was not created");
      return "follow-up and confirmation passed";
    });
    await runStep("Chat ambiguous item", async () => {
      const variants = snapshot.items.flatMap((entry) =>
        entry.description
          .split(/\s+/)
          .slice(1, -1)
          .map((_, i) => ({
            description: entry.description
              .split(/\s+/)
              .slice(0, i + 1)
              .join(" "),
            uom: entry.uom,
          })),
      );
      const ambiguous = variants.find(
        (entry) =>
          matchItem(entry.description, entry.uom, "", snapshot.items).candidates
            .length >= 2,
      );
      assert(ambiguous, "No ambiguous item fixture found in snapshot");
      let chat = await send(
        await startChat(),
        `I need 2 ${ambiguous.uom} of ${ambiguous.description} for PUN1 by ${future}. Normal urgency.`,
      );
      assert(
        !chat.ready && chat.candidates?.length >= 2,
        "Expected multiple item candidates",
      );
      const chosen = chat.candidates[0].item_code;
      chat = await select(chat, chosen);
      assert(
        chat.ready && chat.summary?.item_code === chosen,
        "Candidate selection did not resolve the item",
      );
      chat = await confirm(chat);
      assert(!!chat.createdPr?.pr_no, "PR was not created");
      return "candidate selected and confirmed";
    });
    await runStep("Chat quantity correction", async () => {
      let chat = await send(await startChat(), text("2"));
      if (
        !chat.ready &&
        chat.candidates?.some(
          (candidate) => candidate.item_code === item.item_code,
        )
      )
        chat = await select(chat, item.item_code);
      assert(chat.ready, "Initial request is incomplete");
      chat = await send(chat, "Make it 300.");
      assert(
        chat.ready && chat.summary?.quantity === "300",
        "Correction did not update quantity",
      );
      chat = await confirm(chat);
      assert(
        chat.createdPr?.quantity === "300",
        "Confirmed PR lost correction",
      );
      return "correction confirmed";
    });
    await runStep("Policy chat extraction", async () => {
      const draft = baseline.versions.find(
        (p: { version: string }) => p.version === "5.0",
      );
      const newLimit = new Decimal(draft.parameters.limits.spot)
        .plus(12345)
        .toString();
      const proposed = (await (
        await post("/api/policies/propose", {
          baseVersion: "5.0",
          source: {
            kind: "chat",
            text: `Create version live-check-1, effective 2099-02-01. Set the spot limit to ${newLimit}.`,
          },
        })
      ).json()) as {
        draft: {
          version: string;
          effective_date: string;
          parameters: { limits: { spot: string } };
        };
      };
      assert(
        proposed.draft.version === "live-check-1" &&
          proposed.draft.effective_date === "2099-02-01" &&
          proposed.draft.parameters.limits.spot === newLimit,
        "Proposal did not contain the requested amendment",
      );
      return "synthetic change extracted";
    });
  } else {
    for (const name of [
      "Chat complete request",
      "Chat missing quantity",
      "Chat ambiguous item",
      "Chat quantity correction",
      "Policy chat extraction",
    ])
      record(name, "SKIP", "Gemini key and model are required");
  }
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
