import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { stringify } from "csv-stringify/sync";
import { buildApp } from "./app.js";
import { schemaSql, type Database } from "./db.js";
import {
  snapshot,
  line,
  bundle,
} from "../../../packages/engine/test/fixtures.js";

it("imports external files and supports batch, run, exports and health", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "test-token",
  );
  const actor = { name: "Synthetic reviewer", role: "Procurement" };
  const csv = (rows: unknown[]) => stringify(rows, { header: true });
  const base = snapshot();
  const files = {
    items: csv(base.items),
    suppliers: csv(
      base.suppliers.map((s) => ({ ...s, categories: s.categories.join(";") })),
    ),
    history: csv(base.history),
    plants: csv(base.plants.map((plant) => ({ plant }))),
    register: csv(base.contracts.map(({ lines, ...header }) => header)),
    lines: csv(
      base.contracts.flatMap((c) =>
        c.lines.map((l) => ({ ...l, contract_id: c.contract_id })),
      ),
    ),
    supplement: "[]",
    policy: JSON.stringify({
      ...bundle().versions[0],
      version: "5.0",
      effective_date: "2026-04-01",
    }),
  };
  // Empty tables still need their headers for a real CSV import.
  files.supplement = JSON.stringify([
    {
      contract_id: "SYNTHETIC-PDF",
      supplier_id: base.suppliers[0].supplier_id,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      value_cap: "1000",
      consumed_value: "0",
      lines: [
        {
          item_code: base.items[0].item_code,
          uom: base.items[0].uom,
          rate: "12.34",
        },
      ],
    },
  ]);
  if (!base.history.length)
    files.history =
      "po_number,po_date,supplier_id,item_code,unit_price,uom,plant\n";
  if (!base.contracts.length) {
    files.register =
      "contract_id,supplier_id,start_date,end_date,value_cap,consumed_value\n";
    files.lines = "contract_id,item_code,uom,rate\n";
  }
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers: { "x-setup-token": "test-token" },
      payload: payload as any,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  try {
    expect(
      (await app.inject({ method: "POST", url: "/api/snapshots", payload: {} }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup",
          headers: { "x-setup-token": "wrong" },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject("/")).body).toContain("Import procurement data");
    expect((await app.inject("/health")).json()).toEqual({
      status: "ok",
      database: "ok",
    });
    const imported = await post("/api/setup", {
      actor,
      asOf: base.as_of,
      files,
    });
    expect(imported.counts.items).toBe(base.items.length);
    expect(imported.counts.contracts).toBe(base.contracts.length + 1);
    expect(imported.counts.rates).toBe(
      base.contracts.reduce((n, c) => n + c.lines.length, 0) + 1,
    );
    const policies = (await app.inject("/api/policies")).json();
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      version: "5.0",
      effective_date: "2026-04-01",
      approval: { actor: actor.name },
    });
    const input = {
      actor,
      snapshotId: imported.id,
      csv: csv([line()]),
      selection: bundle().selection,
    };
    const form = new FormData();
    form.set("file", new Blob([input.csv], { type: "text/csv" }), "batch.csv");
    const encoded = new Request("http://localhost", {
      method: "POST",
      body: form,
    });
    const upload = await app.inject({
      method: "POST",
      url: "/api/process-batch",
      headers: { "content-type": encoded.headers.get("content-type")! },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    expect(upload.json().result.decisions).toHaveLength(1);
    expect(upload.json().result.metadata.selection_mode).toBe(
      "currently_active",
    );
    const first = await post("/api/process-batch", input);
    const second = await post("/api/process-batch", input);
    expect(second.result).toEqual(first.result);
    const stored = await app.inject(`/api/runs/${first.id}`);
    expect(stored.json().result).toEqual(first.result);
    const output = await app.inject(`/api/runs/${first.id}/export?slot=run2`);
    expect(output.statusCode).toBe(200);
    expect(output.headers["content-disposition"]).toContain(
      "yashita__run2.csv",
    );
    expect(output.body).toContain("policy_version,reason");
    const preferred = await app.inject({
      method: "POST",
      url: "/api/preferred/export",
      payload: { snapshotId: imported.id, asOf: "2023-01-01" },
    });
    expect(preferred.statusCode, preferred.body).toBe(200);
    expect(preferred.headers["content-disposition"]).toContain(
      "yashita__preferred.csv",
    );
    expect(preferred.body.trim()).toBe(
      "item_code,rank,supplier_id,reference_price",
    );
    expect(preferred.body).toContain(
      "item_code,rank,supplier_id,reference_price",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup",
          headers: { "x-setup-token": "test-token" },
          payload: {
            actor,
            asOf: base.as_of,
            files: { ...files, supplement: "oops" },
          },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/process-batch",
          payload: { ...input, snapshotId: "missing" },
        })
      ).statusCode,
    ).toBe(422);
  } finally {
    await app.close();
    await pg.close();
  }
}, 20000);

it("reviews and applies two amendments through approved policy selection", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const actor = { name: "Policy reviewer", role: "Procurement" };
  const { approval: _approval, ...base } = bundle().versions[0];
  const limitChange = {
    ...base,
    version: "demo-2",
    effective_date: "2026-04-02",
    parameters: {
      ...base.parameters,
      limits: { ...base.parameters.limits, spot: "10" },
    },
  };
  const plantChange = {
    ...limitChange,
    version: "demo-3",
    effective_date: "2026-04-03",
    rules: [
      {
        id: "east-only",
        clause: "D8",
        when: { op: "eq", left: { fact: "plant" }, right: "EAST" },
        action: {
          decision: "SOURCING_REQUEST",
          route: "RFP",
          supplier: "none",
          suggestions: 2,
          note: "",
        },
      },
      ...limitChange.rules,
    ],
  };
  const sources: string[] = [];
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    async (source, baseline) => {
      sources.push(source.kind);
      if (source.kind === "chat") {
        expect(baseline?.version).toBe(base.version);
        return limitChange;
      }
      if (source.kind === "pdf") {
        expect(baseline?.version).toBe(limitChange.version);
        return plantChange;
      }
      return { ...base, rules: [] };
    },
    "test-token",
  );
  const post = async (
    url: string,
    payload: Record<string, unknown>,
    expected = 200,
  ) => {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "x-setup-token": "test-token" },
      payload,
    });
    expect(response.statusCode, response.body).toBe(expected);
    return response.json();
  };
  try {
    expect((await app.inject("/policies")).body).toContain(
      'value="explicit_version"',
    );
    await post("/api/policies/approve", { actor, draft: base });
    const { id: snapshotId } = await post("/api/snapshots", {
      actor,
      snapshot: snapshot(),
    });
    const csv = stringify([line(), line({ pr_no: "WEST-1", plant: "WEST" })], {
      header: true,
    });
    const run = (mode: string, version?: string) =>
      post("/api/process-batch", {
        actor,
        snapshotId,
        csv,
        selection: {
          mode,
          version,
          execution_date: "2026-04-02",
        },
      });

    const { draft: limitDraft } = await post("/api/policies/propose", {
      source: { kind: "chat", text: "Set the spot limit to 10" },
      baseVersion: base.version,
    });
    const review = await post("/api/policies/review", {
      draft: limitDraft,
      baseVersion: base.version,
      batch: { csv },
    });
    expect(review.effective).toMatchObject({
      effectiveDate: "2026-04-02",
      immediate: true,
    });
    const futureReview = await post("/api/policies/review", {
      draft: { ...limitDraft, effective_date: "2099-01-01" },
    });
    expect(futureReview.effective).toEqual({
      effectiveDate: "2099-01-01",
      immediate: false,
    });
    const page = (await app.inject("/policies")).body;
    expect(page).toContain("This takes effect immediately.");
    expect(page).toContain("font-size:1.5rem");
    expect(review.changes.join(" ")).toContain(
      'spot changes from "200000" to "10"',
    );
    expect(review.impact).toEqual({
      affected: 0,
      warning: "Effective date is after all requirement dates",
    });
    await post(
      "/api/policies/review",
      { draft: { ...limitDraft, rules: [] } },
      400,
    );
    const { policy } = await post("/api/policies/approve", {
      actor,
      draft: limitDraft,
      batch: { csv },
    });
    expect(policy.approval.actor).toBe(actor.name);
    expect(policy.approval.at).toMatch(/\+05:30$/);
    await post(
      "/api/policies/approve",
      { actor, draft: { ...limitDraft, effective_date: "2026-01-01" } },
      409,
    );

    const { draft: plantDraft } = await post("/api/policies/propose", {
      source: {
        kind: "pdf",
        base64: Buffer.from("%PDF-synthetic").toString("base64"),
      },
      baseVersion: limitChange.version,
    });
    const plantReview = await post("/api/policies/review", {
      draft: plantDraft,
      baseVersion: limitChange.version,
    });
    expect(plantReview.changes.join(" ")).toContain('plant is "EAST"');
    await post("/api/policies/approve", { actor, draft: plantDraft });
    await post(
      "/api/policies/propose",
      { source: { kind: "text", text: "Invalid response fixture" } },
      400,
    );

    const byDate = await run("requirement_date");
    const active = await run("currently_active");
    const explicit = await run("explicit_version", plantChange.version);
    expect(
      byDate.result.decisions.map((r: { route: string }) => r.route),
    ).toEqual(["SPOT_PO", "SPOT_PO"]);
    expect(
      active.result.decisions.map((r: { route: string }) => r.route),
    ).toEqual(["RFQ", "RFQ"]);
    expect(
      explicit.result.decisions.map((r: { route: string }) => r.route),
    ).toEqual(["RFP", "RFQ"]);
    expect((await app.inject("/api/policies")).json()).toHaveLength(3);
    expect(sources).toEqual(["chat", "pdf", "text"]);
  } finally {
    await app.close();
    await pg.close();
  }
}, 20_000);
