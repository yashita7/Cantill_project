import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  process as processBatch,
  preferredExport,
  policyBundleSchema,
} from "@cantill/engine";
import { loadKit, loadBatch, decisionsCsv, preferredCsv } from "./io.js";

const { values } = parseArgs({
  options: {
    kit: { type: "string" },
    supplement: { type: "string" },
    policy: { type: "string" },
    batch: { type: "string" },
    out: { type: "string" },
    "snapshot-date": { type: "string" },
    "preferred-date": { type: "string" },
    "preferred-out": { type: "string" },
  },
});

async function main() {
  for (const key of [
    "kit",
    "supplement",
    "policy",
    "batch",
    "out",
    "snapshot-date",
  ] as const)
    if (!values[key]) throw new Error(`Missing --${key}`);
  const snapshot = await loadKit(
    values.kit!,
    values.supplement!,
    values["snapshot-date"]!,
  );
  const policy = policyBundleSchema.parse(
    JSON.parse(await readFile(values.policy!, "utf8")),
  );
  const batch = await loadBatch(values.batch!);
  const result = processBatch(policy, snapshot, batch);
  await writeFile(values.out!, decisionsCsv(result.decisions));
  const routes = result.decisions.reduce<Record<string, number>>(
    (counts, row) => {
      counts[row.route] = (counts[row.route] ?? 0) + 1;
      return counts;
    },
    {},
  );
  console.log(
    JSON.stringify(
      {
        rows: result.decisions.length,
        requirements: result.requirements.length,
        routes,
        metadata: result.metadata,
        warnings: result.warnings,
      },
      null,
      2,
    ),
  );
  if (values["preferred-date"] || values["preferred-out"]) {
    if (!values["preferred-date"] || !values["preferred-out"])
      throw new Error("Provide both preferred-date and preferred-out");
    const rows = preferredExport(snapshot, values["preferred-date"]!);
    await writeFile(values["preferred-out"], preferredCsv(rows));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
