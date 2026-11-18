import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { snapshotSchema } from "@cantill/engine";
import { records, type Database } from "./db.js";
import {
  advance,
  inspect,
  resolveDate,
  createLine,
  fieldsSchema,
  type ChatDraft,
  type ExtractChat,
} from "./chat.js";

export function chatRoutes(
  app: FastifyInstance,
  db: Database,
  extract?: ExtractChat,
) {
  app.post("/api/chat", async (req) => {
    const input = z
      .object({ snapshotId: z.string(), actor: z.string().trim().min(1) })
      .parse(req.body);
    const [snapshot] = await db
      .select()
      .from(records)
      .where(
        and(eq(records.id, input.snapshotId), eq(records.kind, "snapshot")),
      );
    if (!snapshot) throw new Error("Snapshot not found");
    const id = randomUUID();
    await db.insert(records).values({
      id,
      kind: "chat",
      data: { ...input, draft: { fields: {} }, revision: 0 },
    });
    return { id, revision: 0, question: "What item do you need?" };
  });
  app.post("/api/chat/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const input = z
      .object({
        revision: z.number().int(),
        message: z.string().max(10000).optional(),
        candidate: z.string().optional(),
        confirm: z.boolean().optional(),
      })
      .parse(req.body);
    const [row] = await db
      .select()
      .from(records)
      .where(and(eq(records.id, id), eq(records.kind, "chat")));
    if (!row) throw new Error("Chat not found");
    if (row.data.createdPr)
      return { createdPr: row.data.createdPr, revision: row.data.revision };
    if (row.data.revision !== input.revision)
      return reply
        .code(409)
        .send({ error: "Reload the latest draft before editing." });
    const [stored] = await db
      .select()
      .from(records)
      .where(eq(records.id, String(row.data.snapshotId)));
    const snapshot = snapshotSchema.parse(stored?.data);
    const at = DateTime.now()
      .setZone("Asia/Kolkata")
      .toFormat("yyyy-MM-dd HH:mm:ss");
    let draft = row.data.draft as ChatDraft;
    let createdPr: ReturnType<typeof createLine> | undefined;
    if (input.confirm) {
      createdPr = createLine(
        draft,
        snapshot,
        at,
        "CHAT-" + randomUUID(),
        String(row.data.actor),
      );
    } else if (input.candidate) {
      const state = inspect(draft, snapshot, at.slice(0, 10));
      if (!state.candidates.some((item) => item.item_code === input.candidate))
        throw new Error("Choose one of the displayed candidates");
      const item = snapshot.items.find(
        (item) => item.item_code === input.candidate,
      )!;
      draft = {
        ...draft,
        selectedItem: item.item_code,
        fields: { ...draft.fields, uom: item.uom },
      };
    } else {
      if (!input.message?.trim()) throw new Error("Enter a message");
      try {
        if (!extract) throw new Error("Unavailable");
        const update = fieldsSchema.parse(await extract(input.message, draft));
        const previous = inspect(draft, snapshot, at.slice(0, 10));
        if (update.needBy)
          update.needBy =
            resolveDate(update.needBy, at.slice(0, 10)) ?? update.needBy;
        draft = advance(draft, update);
        if (
          update.description?.trim() &&
          previous.question.includes("full description")
        )
          draft.newDescriptionConfirmed = true;
        else if (
          update.description?.trim() &&
          update.description !==
            (row.data.draft as ChatDraft).fields.description
        )
          draft.newDescriptionConfirmed = false;
      } catch {
        return reply.code(503).send({
          error:
            "Gemini is unavailable or its quota is exhausted. Your draft is saved. Retry this message.",
          retryable: true,
          draft,
          revision: input.revision,
        });
      }
    }
    const revision = input.revision + 1;
    const state = inspect(draft, snapshot, at.slice(0, 10));
    const changed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(records)
        .set({ data: { ...row.data, draft, revision, createdPr } })
        .where(and(eq(records.id, id), eq(records.data, row.data)))
        .returning();
      if (!updated.length) return false;
      if (createdPr) {
        await tx.insert(records).values({
          id: createdPr.pr_no,
          kind: "pr",
          data: { snapshotId: row.data.snapshotId, lines: [createdPr] },
        });
        await tx.insert(records).values({
          id: randomUUID(),
          kind: "audit",
          data: {
            action: "create_pr",
            actor: row.data.actor,
            at,
            target: createdPr.pr_no,
          },
        });
      }
      return true;
    });
    if (!changed)
      return reply
        .code(409)
        .send({ error: "Draft changed. Reload before confirming." });
    return { id, revision, draft, ...state, createdPr };
  });
}
