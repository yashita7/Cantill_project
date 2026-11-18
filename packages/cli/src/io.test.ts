import { it, expect, describe } from "vitest";
import { stringify } from "csv-stringify/sync";
import { parse } from "csv-parse/sync";
import { decisionsCsv, outputColumns, parseBatchCsv } from "./io.js";
import { process as run } from "@cantill/engine";
import { bundle, snapshot, line } from "../../engine/test/fixtures.js";

it("exports exactly the specified columns and correctly quotes reasons", () => {
  const result = run(bundle(), snapshot(), [
    line(),
    line({ pr_no: "SECOND", plant: "BAD" }),
  ]);
  result.decisions[0].reason = 'Clause, source "A"\nadditional explanation';
  const csv = decisionsCsv(result.decisions);
  expect(csv.split("\n")[0]).toBe(outputColumns.join(","));
  const parsed = parse<Record<string, string>>(csv, { columns: true });
  expect(parsed).toHaveLength(2);
  expect(parsed[0].reason).toBe(result.decisions[0].reason);
  expect(parsed[1].route).toBe("NOT_PROCESSED");
});

describe("New batch CSV parser", () => {
  function csv(rows = [line()], columns = Object.keys(line())) {
    return stringify(rows, { header: true, columns });
  }
  it("accepts a UTF-8 BOM", () =>
    expect(parseBatchCsv("\ufeff" + csv())).toEqual([line()]));
  it("accepts reordered columns and drops extras", () => {
    const record = { ...line(), extra: "unused" };
    expect(
      parseBatchCsv(
        stringify([record], {
          header: true,
          columns: Object.keys(record).reverse(),
        }),
      ),
    ).toEqual([line()]);
  });
  it("trims header and field whitespace including quoted fields", () => {
    const record = Object.fromEntries(
      Object.entries(line()).map(([key, value]) => [` ${key} `, ` ${value} `]),
    );
    expect(
      parseBatchCsv(stringify([record], { header: true, quoted: true })),
    ).toEqual([line()]);
  });
  it("preserves blank estimated prices", () =>
    expect(parseBatchCsv(csv())[0].estimated_unit_price).toBe(""));
  it.each([
    "2026-04-01T10:00:00+05:30",
    "2026-04-01T04:30:00Z",
    "2026-04-01T10:00:00",
  ])("normalizes ISO %s to IST", (created_at) => {
    const rows = parseBatchCsv(csv([line({ created_at })]));
    expect(rows[0].created_at).toBe("2026-04-01 10:00:00.000");
    expect(run(bundle(), snapshot(), rows).decisions[0].route).toBe("SPOT_PO");
  });
  it("preserves seconds at the consolidation boundary", () => {
    const rows = parseBatchCsv(
      csv([
        line(),
        line({
          pr_no: "P2",
          created_at: "2026-04-02T10:00:01+05:30",
          need_by_date: "2026-06-01",
        }),
      ]),
    );
    const result = run(bundle(), snapshot(), rows);
    expect(result.decisions[0].po_id).not.toBe(result.decisions[1].po_id);
  });
  it.each(["01/04/2026 10:00", "04/01/2026 10:00", "2026-04-01"])(
    "holds unsupported/ambiguous timestamp %s for review",
    (created_at) => {
      expect(
        run(bundle(), snapshot(), parseBatchCsv(csv([line({ created_at })])))
          .decisions[0].route,
      ).toBe("NOT_PROCESSED");
    },
  );
  it("holds unsupported need-by format for review", () => {
    expect(
      run(
        bundle(),
        snapshot(),
        parseBatchCsv(csv([line({ need_by_date: "01/05/2026" })])),
      ).decisions[0].route,
    ).toBe("NOT_PROCESSED");
  });
  it("retains duplicate lines for engine rejection", () => {
    const rows = parseBatchCsv(csv([line(), line()]));
    expect(rows).toHaveLength(2);
    expect(
      run(bundle(), snapshot(), rows).decisions.every(
        (row) => row.route === "NOT_PROCESSED",
      ),
    ).toBe(true);
  });
  it("rejects duplicate header names", () =>
    expect(() => parseBatchCsv("pr_no,pr_no\na,b")).toThrow("Duplicate CSV"));
  it("rejects missing required columns", () =>
    expect(() => parseBatchCsv("pr_no,pr_line\nP,1")).toThrow("created_at"));
  it("rejects a header-only batch", () =>
    expect(() => parseBatchCsv(Object.keys(line()).join(","))).toThrow(
      "no PR lines",
    ));
});

it('exports one decision row for each duplicate PR input line', async () => {
  const { process } = await import('@cantill/engine');
  const { bundle, snapshot, line } = await import('../../engine/test/fixtures.js');
  const { decisionsCsv, parseCsv } = await import('./io.js');
  const input = [line(), line()];
  const rows = parseCsv(decisionsCsv(process(bundle(), snapshot(), input).decisions));
  expect(rows).toHaveLength(input.length);
  expect(rows.every(row => row.route === 'NOT_PROCESSED' && row.reason.includes('Duplicate'))).toBe(true);
});
