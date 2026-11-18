import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { DateTime } from "luxon";
import {
  prSchema,
  snapshotSchema,
  type Contract,
  type DecisionRow,
  type PrLine,
} from "@cantill/engine";

export const outputColumns = [
  "pr_no",
  "pr_line",
  "resolved_item_code",
  "group_id",
  "po_id",
  "decision",
  "route",
  "supplier_id",
  "unit_price",
  "group_value_inr",
  "suggested_supplier_ids",
  "policy_version",
  "reason",
];

export function parseCsv(text: string): Record<string, string>[] {
  return parse<Record<string, string>>(text, {
    columns: (headers: string[]) => {
      const cleaned = headers.map((header) => header.trim());
      if (new Set(cleaned).size !== cleaned.length)
        throw new Error("Duplicate CSV column names");
      return cleaned;
    },
    skip_empty_lines: true,
    bom: true,
    trim: true,
  }).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value.trim()]),
    ),
  );
}

async function readCsv(path: string): Promise<Record<string, string>[]> {
  return parseCsv(await readFile(path, "utf8"));
}

export function parseBatchCsv(text: string): PrLine[] {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The CSV contains no PR lines");
  return rows.map((raw, index) => {
    const parsed = prSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `CSV row ${index + 2}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      );
    const row = parsed.data;
    // Accept ISO timestamps explicitly. Preserve seconds so the 24-hour boundary stays exact.
    if (/^\d{4}-\d{2}-\d{2}T/.test(row.created_at)) {
      const instant = DateTime.fromISO(row.created_at, {
        zone: "Asia/Kolkata",
      });
      if (instant.isValid)
        row.created_at = instant
          .setZone("Asia/Kolkata")
          .toFormat("yyyy-MM-dd HH:mm:ss.SSS");
    }
    return row;
  });
}

export async function loadBatch(path: string): Promise<PrLine[]> {
  return parseBatchCsv(await readFile(path, "utf8"));
}

export async function loadKit(
  kit: string,
  supplement: string,
  snapshotDate: string,
) {
  const [items, suppliers, history, plants, register, lines, extra] =
    await Promise.all([
      readCsv(join(kit, "master_data/item_master.csv")),
      readCsv(join(kit, "master_data/supplier_master.csv")),
      readCsv(join(kit, "master_data/po_history.csv")),
      readCsv(join(kit, "master_data/plants.csv")),
      readCsv(join(kit, "contracts/contract_register.csv")),
      readCsv(join(kit, "contracts/contract_lines.csv")),
      readFile(supplement, "utf8"),
    ]);
  return snapshotFromFiles(
    { items, suppliers, history, plants, register, lines, supplement: extra },
    snapshotDate,
  );
}

export function snapshotFromFiles(
  files: {
    items: Record<string, string>[];
    suppliers: Record<string, string>[];
    history: Record<string, string>[];
    plants: Record<string, string>[];
    register: Record<string, string>[];
    lines: Record<string, string>[];
    supplement: string;
  },
  snapshotDate: string,
) {
  const { items, suppliers, history, plants, register, lines } = files;
  const pdfContracts: Contract[] = JSON.parse(files.supplement);
  return snapshotSchema.parse({
    snapshot_id: `import-${snapshotDate}`,
    as_of: snapshotDate,
    items,
    suppliers: suppliers.map((s) => ({
      ...s,
      categories: s.categories.split(";").map((v) => v.trim()),
      on_time_pct: Number(s.on_time_pct),
      quality_rating: Number(s.quality_rating),
    })),
    history,
    plants: plants.map((p) => p.plant),
    contracts: [
      ...register.map((c) => ({
        ...c,
        lines: lines.filter((l) => l.contract_id === c.contract_id),
      })),
      ...pdfContracts,
    ],
  });
}

export function decisionsCsv(rows: DecisionRow[]): string {
  return stringify(rows, {
    header: true,
    columns: outputColumns,
    record_delimiter: "\n",
  });
}

export function preferredCsv(rows: unknown[]): string {
  return stringify(rows, {
    header: true,
    columns: ["item_code", "rank", "supplier_id", "reference_price"],
    record_delimiter: "\n",
  });
}
