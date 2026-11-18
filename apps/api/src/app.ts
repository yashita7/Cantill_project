import Fastify from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DateTime } from "luxon";
import {
  process as processBatch,
  snapshotSchema,
  policyBundleSchema,
  policySelectionSchema,
  policySchema,
  amendmentImpact,
  prSchema,
  preferredExport,
} from "@cantill/engine";
import {
  parseBatchCsv,
  decisionsCsv,
  preferredCsv,
  parseCsv,
  snapshotFromFiles,
  BatchCsvValidationError,
  CsvFormatError,
} from "../../../packages/cli/src/io.js";
import { records, type Database } from "./db.js";
import { buyerRoutes } from "./buyer.js";
import { chatRoutes } from "./chat-routes.js";
import type { ExtractChat } from "./chat.js";
import { chatPage } from "./chat-page.js";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { homePage } from "./home-page.js";
import { styles } from "./ui/styles.js";
import { setupPage } from "./page.js";
import { policyPage } from "./policy-page.js";
import {
  describeChanges,
  effectiveDateNotice,
  parseDraft,
  sourceSchema,
  type ExtractPolicy,
} from "./policies.js";

const actorSchema = z.object({
  name: z.string().trim().min(1),
  role: z.enum(["Requester", "Buyer", "Procurement"]),
});
export function buildApp(
  db: Database,
  extractPolicy?: ExtractPolicy,
  setupToken?: string,
  extractChat?: ExtractChat,
) {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  app.addContentTypeParser(
    /^multipart\/form-data(?:;|$)/i,
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  // Only these fixed, application-authored messages may cross the error boundary.
  const knownErrors = new Set([
    "snapshot not found",
    "run not found",
    "policy not found",
    "requirement not found",
    "Snapshot not found",
    "Chat not found",
    "Item not found",
    "Upload the private v5.0 policy JSON for initial setup",
    "Initial policy must be v5.0 effective 2026-04-01",
    "Gemini is unavailable. Use the raw JSON editor.",
    "Policy extraction failed. Retry or use the raw JSON editor.",
    "Upload one CSV file in the file field",
    "Import a snapshot before processing a batch",
    "Approve a policy before processing batches.",
    "Requirement has no actionable decision",
    "A PO requires a supplier and nonnegative unit price",
    "Choose one of the displayed candidates",
    "Enter a message",
    "Complete the request before confirming.",
    "Contract supplement must be valid JSON",
    "Duplicate CSV column names",
    "The CSV contains no PR lines",
  ]);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CsvFormatError)
      return reply
        .code(422)
        .send({
          error: error.message,
          details: [
            { row: error.row, message: "Invalid CSV format or column count" },
          ],
        });
    if (error instanceof BatchCsvValidationError) {
      const details = error.columns.map((column) => ({
        path: column,
        row: error.row,
        message: "Missing or invalid field",
      }));
      return reply.code(422).send({
        error: `CSV row ${error.row}: ${error.columns.join(", ")}: Missing or invalid field`,
        details,
      });
    }
    if (error instanceof z.ZodError) {
      // Paths and messages are selected from fixed schema names and fixed text;
      // never echo input values, arbitrary record keys, or Zod's raw messages.
      const fields = new Set(
        "draft version effective_date approval actor at parameters club_days need_by_days consolidation_hours history_days preferred_days active_statuses emergency_labels valuation_sources limits ranking frequency recency contract delivery quality recent_days older_days older_score rules id clause when all any not op left right fact parameter action decision route supplier suggestions note selection mode execution_date snapshotId csv batch runId baseVersion source kind text actor name role files items suppliers history plants register lines supplement policy quantity plant uom description needBy urgency estimatedPrice created_at pr_no pr_line requester department item_code estimated_unit_price need_by_date revision message candidate confirm".split(
          " ",
        ),
      );
      const customMessages = new Set([
        "Rule IDs must be unique",
        "Comparison requires a right operand",
        "PO requires a supplier strategy",
        "Decision and route must agree",
        "Ordered comparisons require numeric facts, limits, or literals",
        "Membership comparison requires an array",
        "Expected a PDF file",
      ]);
      const details = error.issues.map((issue) => ({
        path: issue.path.map((part) =>
          typeof part === "number"
            ? part
            : fields.has(String(part))
              ? String(part)
              : "[key]",
        ),
        message:
          issue.code === "custom" && customMessages.has(issue.message)
            ? issue.message
            : issue.code === "invalid_type"
              ? "Required or incorrect type"
              : issue.code === "too_small"
                ? "Value is too small or missing"
                : issue.code === "too_big"
                  ? "Value is too large"
                  : issue.code === "invalid_value"
                    ? "Choose an allowed value"
                    : issue.code === "unrecognized_keys"
                      ? "Contains unrecognized fields"
                      : "Invalid value",
      }));
      return reply.code(400).send({
        error: details
          .map((d) => `${d.path.join(".") || "request"}: ${d.message}`)
          .join("; "),
        details,
      });
    }
    if (
      error instanceof Error &&
      error.constructor === Error &&
      knownErrors.has(error.message)
    )
      return reply.code(422).send({ error: error.message });
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply
        .code(error.statusCode)
        .send({ error: "Invalid request. Check the supplied fields." });
    const dbError =
      error instanceof DrizzleQueryError ||
      (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[0-9A-Z]{5}$/.test(error.code));
    const requestId = randomUUID();
    console.error(
      JSON.stringify({
        event: "request_failure",
        timestamp: new Date().toISOString(),
        requestId,
        category: dbError ? "database" : "internal",
      }),
    );
    return reply.code(500).send({
      error: "An unexpected error occurred. Please try again.",
      requestId,
    });
  });
  const get = async (id: string, kind: string) => {
    const [row] = await db.select().from(records).where(eq(records.id, id));
    if (!row || row.kind !== kind) throw new Error(`${kind} not found`);
    return row.data;
  };
  // Mutation and actor audit are committed together; runs never change baseline consumption.
  const save = async (
    kind: string,
    data: Record<string, unknown>,
    actor: z.infer<typeof actorSchema>,
  ) => {
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(records).values({ id, kind, data });
      await tx.insert(records).values({
        id: randomUUID(),
        kind: "audit",
        data: {
          actor,
          action: `create_${kind}`,
          target: id,
          at: DateTime.now().setZone("Asia/Kolkata").toISO(),
        },
      });
    });
    return id;
  };
  app.get("/", async (_req, reply) => reply.type("text/html").send(homePage));
  app.get("/setup", async (_req, reply) =>
    reply.type("text/html").send(setupPage),
  );
  app.get("/ui.css", async (_req, reply) =>
    reply.type("text/css").send(styles),
  );
  app.get("/health", async (_req, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: "ok", database: "ok" };
    } catch {
      return reply
        .code(503)
        .send({ status: "unavailable", database: "unavailable" });
    }
  });
  const protectSetup = async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const received = req.headers["x-setup-token"];
    const expected = Buffer.from(setupToken ?? "");
    const supplied = Buffer.from(typeof received === "string" ? received : "");
    if (
      !expected.length ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(401).send({ error: "Invalid setup token" });
  };
  app.post("/api/snapshots", { preHandler: protectSetup }, async (req) => {
    const body = z
      .object({ actor: actorSchema, snapshot: snapshotSchema })
      .parse(req.body);
    return { id: await save("snapshot", body.snapshot, body.actor) };
  });
  app.post("/api/setup", { preHandler: protectSetup }, async (req) => {
    const body = z
      .object({
        actor: actorSchema,
        asOf: z.iso.date(),
        files: z.object({
          items: z.string(),
          suppliers: z.string(),
          history: z.string(),
          plants: z.string(),
          register: z.string(),
          lines: z.string(),
          supplement: z.string(),
          policy: z.string().optional(),
        }),
      })
      .parse(req.body);
    const f = body.files;
    try {
      JSON.parse(f.supplement);
    } catch {
      throw new Error("Contract supplement must be valid JSON");
    }
    const snapshot = snapshotFromFiles(
      {
        items: parseCsv(f.items),
        suppliers: parseCsv(f.suppliers),
        history: parseCsv(f.history),
        plants: parseCsv(f.plants),
        register: parseCsv(f.register),
        lines: parseCsv(f.lines),
        supplement: f.supplement,
      },
      body.asOf,
    );
    const existing = await db
      .select()
      .from(records)
      .where(eq(records.id, "policy:5.0"));
    let initialPolicy: z.infer<typeof policySchema> | undefined;
    if (!existing.length) {
      if (!f.policy)
        throw new Error(
          "Upload the private v5.0 policy JSON for initial setup",
        );
      const supplied = JSON.parse(f.policy);
      const candidate = Array.isArray(supplied.versions)
        ? supplied.versions.find(
            (p: { version: string }) => p.version === "5.0",
          )
        : supplied;
      const { approval: _approval, ...draft } = policySchema.parse(candidate);
      if (draft.version !== "5.0" || draft.effective_date !== "2026-04-01")
        throw new Error("Initial policy must be v5.0 effective 2026-04-01");
      initialPolicy = policySchema.parse({
        ...draft,
        approval: {
          actor: body.actor.name,
          at: DateTime.now().setZone("Asia/Kolkata").toISO()!,
        },
      });
    }
    const id = randomUUID();
    await db.transaction(async (tx) => {
      if (initialPolicy)
        await tx
          .insert(records)
          .values({ id: "policy:5.0", kind: "policy", data: initialPolicy })
          .onConflictDoNothing();
      await tx.insert(records).values({ id, kind: "snapshot", data: snapshot });
      await tx.insert(records).values({
        id: randomUUID(),
        kind: "audit",
        data: {
          actor: body.actor,
          action: "setup_import",
          target: id,
          policy: initialPolicy?.version ?? null,
        },
      });
    });
    return {
      id,
      counts: {
        items: snapshot.items.length,
        suppliers: snapshot.suppliers.length,
        contracts: snapshot.contracts.length,
        rates: snapshot.contracts.reduce((n, c) => n + c.lines.length, 0),
      },
    };
  });
  const approvedPolicies = async () => {
    const rows = await db
      .select()
      .from(records)
      .where(eq(records.kind, "policy"));
    return rows
      .map((row) => policySchema.parse(row.data))
      .sort(
        (a, b) =>
          b.effective_date.localeCompare(a.effective_date) ||
          a.version.localeCompare(b.version),
      );
  };
  const baseline = async (version?: string) => {
    if (version === undefined) return undefined;
    const policy = policySchema.parse(await get("policy:" + version, "policy"));
    const { approval: _approval, ...draft } = policy;
    return draft;
  };
  const reviewInput = z.object({
    draft: z.unknown(),
    baseVersion: z.string().optional(),
    batch: z
      .union([
        z.object({ runId: z.string() }),
        z.object({ csv: z.string().min(1) }),
      ])
      .optional(),
  });
  const review = async (input: z.infer<typeof reviewInput>) => {
    const draft = parseDraft(input.draft);
    const before = await baseline(input.baseVersion);
    const lines = !input.batch
      ? []
      : "csv" in input.batch
        ? parseBatchCsv(input.batch.csv)
        : z.array(prSchema).parse((await get(input.batch.runId, "run")).lines);
    const requirementDates = lines
      .map((line) => line.created_at.slice(0, 10))
      .filter((day) => z.iso.date().safeParse(day).success);
    return {
      draft,
      changes: describeChanges(before, draft),
      impact: amendmentImpact(draft, requirementDates),
      effective: effectiveDateNotice(
        draft.effective_date,
        DateTime.now().setZone("Asia/Kolkata").toISODate()!,
      ),
    };
  };
  app.get("/policies", async (_req, reply) =>
    reply.type("text/html").send(policyPage),
  );
  app.get("/api/policies", approvedPolicies);
  app.post("/api/policies/propose", async (req) => {
    const { source, baseVersion } = z
      .object({ source: sourceSchema, baseVersion: z.string().optional() })
      .parse(req.body);
    if (!extractPolicy)
      throw new Error("Gemini is unavailable. Use the raw JSON editor.");
    const value = await extractPolicy(source, await baseline(baseVersion));
    return { draft: parseDraft(value) };
  });
  app.post("/api/policies/review", async (req) =>
    review(reviewInput.parse(req.body)),
  );
  app.post("/api/policies/approve", async (req, reply) => {
    const input = reviewInput.extend({ actor: actorSchema }).parse(req.body);
    if (input.actor.role !== "Procurement")
      return reply
        .code(403)
        .send({ error: "Select the Procurement role to approve policies." });
    const { draft, impact } = await review(input);
    const at = DateTime.now().setZone("Asia/Kolkata").toISO()!;
    const policy = policySchema.parse({
      ...draft,
      approval: { actor: input.actor.name, at },
    });
    const id = "policy:" + policy.version;
    const inserted = await db.transaction(async (tx) => {
      const result = await tx
        .insert(records)
        .values({ id, kind: "policy", data: policy })
        .onConflictDoNothing()
        .returning({ id: records.id });
      if (!result.length) return false;
      await tx.insert(records).values({
        id: randomUUID(),
        kind: "audit",
        data: {
          actor: input.actor,
          action: "approve_policy",
          target: id,
          at,
          baseVersion: input.baseVersion ?? null,
        },
      });
      return true;
    });
    if (!inserted)
      return reply.code(409).send({
        error: "This policy version is already approved. Choose a new version.",
      });
    return { policy, impact };
  });
  app.post("/api/process-batch", async (req) => {
    const contentType = req.headers["content-type"] ?? "";
    let body: {
      actor: z.infer<typeof actorSchema>;
      snapshotId: string;
      csv: string;
      selection: z.infer<typeof policySelectionSchema>;
    };
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const form = await new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Uint8Array(req.body as Buffer),
      }).formData();
      const files = form.getAll("file");
      if (files.length !== 1 || typeof files[0] === "string")
        throw new Error("Upload one CSV file in the file field");
      const [latest] = await db
        .select()
        .from(records)
        .where(eq(records.kind, "snapshot"))
        .orderBy(desc(records.createdAt), desc(records.id))
        .limit(1);
      if (!latest)
        throw new Error("Import a snapshot before processing a batch");
      body = {
        actor: { name: "Batch upload", role: "Requester" },
        snapshotId: latest.id,
        csv: await files[0].text(),
        selection: {
          mode: "currently_active",
          execution_date: DateTime.now().setZone("Asia/Kolkata").toISODate()!,
        },
      };
    } else {
      body = z
        .object({
          actor: actorSchema,
          snapshotId: z.string(),
          csv: z.string().min(1),
          selection: policySelectionSchema,
        })
        .parse(req.body);
    }
    const snapshot = await get(body.snapshotId, "snapshot");
    const lines = parseBatchCsv(body.csv);
    const versions = await approvedPolicies();
    if (!versions.length)
      throw new Error("Approve a policy before processing batches.");
    const policy = policyBundleSchema.parse({
      versions,
      selection: body.selection,
    });
    const result = processBatch(policy, snapshot, lines);
    const id = await save(
      "run",
      { snapshotId: body.snapshotId, lines, policy, result },
      body.actor,
    );
    return { id, result };
  });
  app.get("/api/runs/:id", async (req) =>
    get(z.object({ id: z.string() }).parse(req.params).id, "run"),
  );
  app.get("/api/runs/:id/export", async (req, reply) => {
    const run = await get(
      z.object({ id: z.string() }).parse(req.params).id,
      "run",
    );
    const query = z
      .object({ slot: z.enum(["run1", "run2"]).default("run1") })
      .parse(req.query);
    // Revalidate immutable inputs and replay through the same pure engine.
    const result = processBatch(
      run.policy,
      await get(String(run.snapshotId), "snapshot"),
      run.lines,
    );
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="yashita__${query.slot}.csv"`,
      )
      .type("text/csv")
      .send(decisionsCsv(result.decisions));
  });
  app.post("/api/preferred/export", async (req, reply) => {
    const body = z
      .object({ snapshotId: z.string(), asOf: z.iso.date() })
      .parse(req.body);
    const snapshot = snapshotSchema.parse(
      await get(body.snapshotId, "snapshot"),
    );
    const rows = preferredExport(snapshot, body.asOf);
    return reply
      .header(
        "Content-Disposition",
        'attachment; filename="yashita__preferred.csv"',
      )
      .type("text/csv")
      .send(preferredCsv(rows));
  });
  buyerRoutes(app, db);
  chatRoutes(app, db, extractChat);
  app.get("/chat", async (_req, reply) =>
    reply.type("text/html").send(chatPage),
  );
  return app;
}
