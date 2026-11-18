import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  process as processBatch,
  policyBundleSchema,
  snapshotSchema,
  preferredExport,
  type BatchResult,
  type PrLine,
} from "@cantill/engine";
import { records, type Database } from "./db.js";
import { buyerPage } from "./buyer-page.js";

const actor = z.object({
  name: z.string().trim().min(1),
  role: z.literal("Buyer"),
});
const selection = z.object({
  mode: z.enum(["requirement_date", "currently_active", "explicit_version"]),
  execution_date: z.iso.date(),
  version: z.string().optional(),
});
const route = z.enum([
  "CONTRACT_PO",
  "EMERGENCY_PO",
  "SPOT_PO",
  "RFQ",
  "RFP",
  "CAPEX_SOURCING",
  "NEW_ITEM_SOURCING",
]);
export function buyerRoutes(app: FastifyInstance, db: Database) {
  const load = async (id: string, kind: string) => {
    const [record] = await db
      .select()
      .from(records)
      .where(and(eq(records.id, id), eq(records.kind, kind)));
    if (!record) throw new Error(kind + " not found");
    return record.data;
  };
  const audit = (
    action: string,
    target: string,
    who: z.infer<typeof actor>,
    detail: Record<string, unknown> = {},
  ) => ({
    id: randomUUID(),
    kind: "audit",
    data: {
      action,
      target,
      actor: who,
      at: DateTime.now().setZone("Asia/Kolkata").toISO(),
      ...detail,
    },
  });
  app.get("/buyer", async (_req, reply) =>
    reply.type("text/html").send(buyerPage),
  );
  app.get("/api/buyer/prs", async () =>
    db.select().from(records).where(eq(records.kind, "pr")),
  );
  app.get("/api/buyer/runs", async () =>
    db.select().from(records).where(eq(records.kind, "run")),
  );
  app.post("/api/buyer/process-pr", async (req) => {
    const body = z
      .object({ prId: z.string(), actor, selection })
      .parse(req.body);
    const pr = await load(body.prId, "pr");
    const snapshot = await load(String(pr.snapshotId), "snapshot");
    const versions = (
      await db.select().from(records).where(eq(records.kind, "policy"))
    ).map((r) => r.data);
    const policy = policyBundleSchema.parse({
      versions,
      selection: body.selection,
    });
    const lines = pr.lines as PrLine[];
    const result = processBatch(policy, snapshot, lines);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx
        .insert(records)
        .values({
          id,
          kind: "run",
          data: { snapshotId: pr.snapshotId, lines, policy, result },
        });
      await tx
        .insert(records)
        .values(audit("process_pr", id, body.actor, { prId: body.prId }));
    });
    return { id, result };
  });
  app.get("/api/buyer/runs/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const run = await load(id, "run");
    const result = run.result as BatchResult;
    const lines = run.lines as PrLine[];
    const actions = await db
      .select()
      .from(records)
      .where(eq(records.kind, "buyer_action"));
    return {
      requirements: result.requirements.map((r) => ({
        ...r,
        lines: r.indices.map((i) => lines[i]),
        action:
          actions.find((a) => a.id === `buyer:${id}:${r.group_id}`)?.data ??
          null,
      })),
      rejected: result.decisions.filter((r) => r.route === "NOT_PROCESSED"),
    };
  });
  app.post("/api/buyer/runs/:id/:group/action", async (req, reply) => {
    const { id, group } = z
      .object({ id: z.string(), group: z.string() })
      .parse(req.params);
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("approve"), actor }),
        z.object({
          action: z.literal("override"),
          actor,
          comment: z.string().trim().min(1),
          route,
          supplierId: z.string().default(""),
          unitPrice: z.string().default(""),
          suggestedSupplierIds: z.string().default(""),
        }),
      ])
      .parse(req.body);
    const run = await load(id, "run");
    const requirement = (run.result as BatchResult).requirements.find(
      (r) => r.group_id === group,
    );
    const original = requirement?.decision;
    if (!original || original.route === "NOT_PROCESSED")
      throw new Error("Requirement has no actionable decision");
    const effective =
      body.action === "approve"
        ? original
        : {
            ...original,
            route: body.route,
            decision: body.route.endsWith("_PO") ? "PO" : "SOURCING_REQUEST",
            supplier_id: body.supplierId,
            unit_price: body.unitPrice,
            suggested_supplier_ids: body.suggestedSupplierIds,
          };
    if (
      effective.decision === "PO" &&
      (!effective.supplier_id || !/^\d+(\.\d+)?$/.test(effective.unit_price))
    )
      throw new Error("A PO requires a supplier and nonnegative unit price");
    const key = `buyer:${id}:${group}`;
    const at = DateTime.now().setZone("Asia/Kolkata").toISO()!;
    const value = {
      runId: id,
      group,
      original,
      effective,
      action: body.action,
      comment: body.action === "override" ? body.comment : "",
      actor: body.actor,
      at,
      recordType: effective.decision === "PO" ? "PO" : effective.route,
    };
    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(records)
        .values({ id: key, kind: "buyer_action", data: value })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) return false;
      await tx
        .insert(records)
        .values({
          id: "order:" + (body.action === "approve" && effective.decision === "PO" && effective.po_id ? id + ":" + effective.po_id : key),
          kind:
            effective.decision === "PO" ? "purchase_order" : "sourcing_request",
          data: value,
        });
      await tx
        .insert(records)
        .values(
          audit(body.action, key, body.actor, { comment: value.comment }),
        );
      return true;
    });
    const existing = await load(key, "buyer_action");
    if (!created && JSON.stringify(existing) !== JSON.stringify(value)) {
      if (existing.action === body.action && JSON.stringify(existing.effective) === JSON.stringify(value.effective) && existing.comment === value.comment)
        return { created: false, record: existing };
      return reply
        .code(409)
        .send({
          error: "This requirement already has a buyer action",
          record: existing,
        });
    }
    return { created, record: existing };
  });
  app.get("/api/buyer/audit", async () =>
    db.select().from(records).where(eq(records.kind, "audit")),
  );
  app.get("/api/buyer/preferred", async (req) => {
    const query = z
      .object({
        snapshotId: z.string(),
        itemCode: z.string(),
        asOf: z.iso.date(),
      })
      .parse(req.query);
    const snapshot = snapshotSchema.parse(
      await load(query.snapshotId, "snapshot"),
    );
    if (!snapshot.items.some((i) => i.item_code === query.itemCode))
      throw new Error("Item not found");
    return preferredExport(snapshot, query.asOf).filter(
      (row) => row.item_code === query.itemCode,
    );
  });
}
