import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { buildApp } from "./app.js";
import { schemaSql, type Database } from "./db.js";
import {
  bundle,
  snapshot,
  line,
} from "../../../packages/engine/test/fixtures.js";
import { stringify } from "csv-stringify/sync";
it("approves once, validates overrides and records buyer audit", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const app = buildApp(drizzle(pg) as unknown as Database, undefined, "token");
  const procurement = { name: "Pat", role: "Procurement" },
    buyer = { name: "Buyer One", role: "Buyer" };
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers: { "x-setup-token": "token" },
      payload: payload as any,
    });
  try {
    const snap = await post("/api/snapshots", {
      actor: procurement,
      snapshot: snapshot(),
    });
    const { approval, ...draft } = bundle().versions[0];
    expect(
      (await post("/api/policies/approve", { actor: procurement, draft }))
        .statusCode,
    ).toBe(200);
    const run = await post("/api/process-batch", {
      actor: buyer,
      snapshotId: snap.json().id,
      csv: stringify([line()], { header: true }),
      selection: bundle().selection,
    });
    expect(run.statusCode, run.body).toBe(200);
    const id = run.json().id,
      group = run.json().result.requirements[0].group_id;
    const url = `/api/buyer/runs/${id}/${group}/action`;
    expect(
      (
        await post(url, {
          action: "override",
          actor: buyer,
          comment: "   ",
          route: "RFQ",
        })
      ).statusCode,
    ).toBe(400);
    const first = await post(url, { action: "approve", actor: buyer });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().created).toBe(true);
    const again = await post(url, { action: "approve", actor: buyer });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    const audit = (await app.inject("/api/buyer/audit")).json();
    expect(
      audit.filter((row: any) => row.data.action === "approve"),
    ).toHaveLength(1);
    expect(
      audit.find((row: any) => row.data.action === "approve").data.actor,
    ).toEqual(buyer);
    const run2 = await post("/api/process-batch", {
      actor: buyer,
      snapshotId: snap.json().id,
      csv: stringify([line()], { header: true }),
      selection: bundle().selection,
    });
    const group2 = run2.json().result.requirements[0].group_id;
    const override = await post(
      `/api/buyer/runs/${run2.json().id}/${group2}/action`,
      {
        action: "override",
        actor: buyer,
        comment: "Need competitive bids",
        route: "RFQ",
      },
    );
    expect(override.statusCode, override.body).toBe(200);
    expect(override.json().record.original.route).toBe("SPOT_PO");
    expect(override.json().record.effective.route).toBe("RFQ");
    expect(
      (await app.inject("/api/buyer/audit"))
        .json()
        .some(
          (row: any) =>
            row.data.action === "override" &&
            row.data.comment === "Need competitive bids",
        ),
    ).toBe(true);
    const preferred = await app.inject(
      `/api/buyer/preferred?snapshotId=${snap.json().id}&itemCode=DEMO-A&asOf=2026-04-01`,
    );
    expect(preferred.statusCode).toBe(200);
    expect(preferred.json()[0].components).toBeDefined();
  } finally {
    await app.close();
    await pg.close();
  }
}, 20000);
