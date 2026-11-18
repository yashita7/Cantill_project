import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { parse } from "csv-parse/sync";
import { buildApp } from "../apps/api/src/app.js";
import { schemaSql, type Database } from "../apps/api/src/db.js";

const kit = process.env.CANTILL_KIT_PATH;
if (!kit)
  throw new Error(
    "Set CANTILL_KIT_PATH to your local task kit folder. See README.md.",
  );
const root = resolve(kit);
const output = resolve("private/local-verification");
const supplement = resolve("private/contracts.json");
const policy = resolve("private/policy.json");
const batch = join(root, "pr_batches/sample_pr_batch.csv");
const read = (path: string) => readFile(path, "utf8");

function compare(
  label: string,
  apiText: string,
  cliText: string,
  expected: number,
): boolean {
  const options = { columns: true, bom: true, skip_empty_lines: true } as const;
  const api = parse(apiText, options) as Record<string, string>[];
  const cli = parse(cliText, options) as Record<string, string>[];
  const apiHeaders = parse(apiText, { to_line: 1, bom: true })[0] as string[];
  const cliHeaders = parse(cliText, { to_line: 1, bom: true })[0] as string[];
  const columns = [...new Set([...apiHeaders, ...cliHeaders])];
  const differences: string[] = [];
  if (JSON.stringify(apiHeaders) !== JSON.stringify(cliHeaders))
    differences.push(
      `Header order or columns differ: API ${apiHeaders.join(", ")} / CLI ${cliHeaders.join(", ")}`,
    );
  for (let i = 0; i < Math.max(api.length, cli.length); i++) {
    if (!api[i] || !cli[i])
      differences.push(`Row ${i + 1}: missing from ${api[i] ? "CLI" : "API"}`);
    else {
      const changed = columns.filter(
        (column) => api[i][column] !== cli[i][column],
      );
      if (changed.length)
        differences.push(
          `Row ${i + 1}: ${changed.map((column) => `${column} (API ${JSON.stringify(api[i][column])}, CLI ${JSON.stringify(cli[i][column])})`).join(", ")}`,
        );
    }
  }
  if (
    differences.length ||
    api.length !== expected ||
    cli.length !== expected
  ) {
    console.error(
      `${label}: MISMATCH (API ${api.length} rows, CLI ${cli.length} rows, expected ${expected})`,
    );
    for (const difference of differences.slice(0, 10))
      console.error(difference);
    return false;
  }
  console.log(`${label}: MATCH: ${api.length} rows identical`);
  return true;
}

async function main() {
  await mkdir(output, { recursive: true });
  const [
    items,
    suppliers,
    history,
    plants,
    register,
    lines,
    extra,
    baseline,
    batchCsv,
  ] = await Promise.all([
    read(join(root, "master_data/item_master.csv")),
    read(join(root, "master_data/supplier_master.csv")),
    read(join(root, "master_data/po_history.csv")),
    read(join(root, "master_data/plants.csv")),
    read(join(root, "contracts/contract_register.csv")),
    read(join(root, "contracts/contract_lines.csv")),
    read(supplement),
    read(policy),
    read(batch),
  ]);
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const token = randomBytes(24).toString("hex");
  const app = buildApp(drizzle(pg) as unknown as Database, undefined, token);
  try {
    await app.ready();
    async function post(
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers,
        payload: body as object,
      });
      if (response.statusCode >= 400)
        throw new Error(
          `${path} failed (${response.statusCode}): ${response.body}`,
        );
      return response;
    }
    const setup = await post(
      "/api/setup",
      {
        actor: { name: "Local verifier", role: "Procurement" },
        asOf: "2026-11-16",
        files: {
          items,
          suppliers,
          history,
          plants,
          register,
          lines,
          supplement: extra,
          policy: baseline,
        },
      },
      { "x-setup-token": token },
    );
    const { id: snapshotId, counts } = setup.json() as {
      id: string;
      counts: unknown;
    };
    console.log("Imported snapshot", JSON.stringify(counts));
    const form = new FormData();
    form.set(
      "file",
      new Blob([batchCsv], { type: "text/csv" }),
      "sample_pr_batch.csv",
    );
    const request = new Request("http://localhost/api/process-batch", {
      method: "POST",
      body: form,
    });
    const processed = await app.inject({
      method: "POST",
      url: "/api/process-batch",
      headers: { "content-type": request.headers.get("content-type")! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
    if (processed.statusCode >= 400)
      throw new Error(
        `Batch failed (${processed.statusCode}): ${processed.body}`,
      );
    const run = processed.json() as { id: string };
    const download = await app.inject({
      method: "GET",
      url: `/api/runs/${encodeURIComponent(run.id)}/export?slot=run1`,
    });
    if (download.statusCode >= 400)
      throw new Error(`Decision export failed (${download.statusCode})`);
    const apiDecisions = download.body;
    const preferred = await post("/api/preferred/export", {
      snapshotId,
      asOf: "2026-11-01",
    });
    const apiPreferred = preferred.body;
    const apiFile = join(output, "api-decisions.csv"),
      cliFile = join(output, "cli-decisions.csv");
    const apiPreferredFile = join(output, "api-preferred.csv"),
      cliPreferredFile = join(output, "cli-preferred.csv");
    await Promise.all([
      writeFile(apiFile, apiDecisions),
      writeFile(apiPreferredFile, apiPreferred),
    ]);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/cli/src/main.ts",
        "--kit",
        root,
        "--supplement",
        supplement,
        "--policy",
        policy,
        "--batch",
        batch,
        "--out",
        cliFile,
        "--snapshot-date",
        "2026-11-16",
        "--preferred-date",
        "2026-11-01",
        "--preferred-out",
        cliPreferredFile,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(
        `CLI failed: ${result.stderr || result.error?.message || "unknown error"}`,
      );
    const decisionMatch = compare(
      "Decisions",
      apiDecisions,
      await read(cliFile),
      186,
    );
    const preferredMatch = compare(
      "Preferred suppliers",
      apiPreferred,
      await read(cliPreferredFile),
      155,
    );
    console.log(`CSV files saved in ${output}`);
    if (!decisionMatch || !preferredMatch) process.exitCode = 1;
  } finally {
    await app.close();
    await pg.close();
  }
}
main().catch((error) => {
  console.error(
    `Local verification failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
