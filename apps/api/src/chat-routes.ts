import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
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
  ChatError,
  classifyChatError,
  chatRetryable,
  logChatFailure,
  type ChatDraft,
  type ExtractChat,
} from "./chat.js";

export function chatRoutes(
  app: FastifyInstance,
  db: Database,
  extract?: ExtractChat,
) {
  app.get("/api/chat/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const [row] = await db
      .select()
      .from(records)
      .where(and(eq(records.id, id), eq(records.kind, "chat")));
    if (!row) throw new Error("Chat not found");
    if (row.data.createdPr)
      return { id, revision: row.data.revision, createdPr: row.data.createdPr };
    const [stored] = await db
      .select()
      .from(records)
      .where(eq(records.id, String(row.data.snapshotId)));
    const state = inspect(
      row.data.draft as ChatDraft,
      snapshotSchema.parse(stored?.data),
      DateTime.now().setZone("Asia/Kolkata").toFormat("yyyy-MM-dd"),
    );
    const unresolvedCorrections = Array.isArray(row.data.unresolvedCorrections)
      ? row.data.unresolvedCorrections
      : [];
    return {
      id,
      revision: row.data.revision,
      draft: row.data.draft,
      ...state,
      unresolvedCorrections,
      ready:
        state.ready &&
        !row.data.pendingMessage &&
        !unresolvedCorrections.length,
    };
  });
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
        retryCorrection: z.string().uuid().optional(),
        discardCorrection: z.string().uuid().optional(),
        acknowledgeDiscard: z.boolean().optional(),
      })
      .refine(
        (value) =>
          Number(Boolean(value.message?.trim())) +
            Number(Boolean(value.candidate)) +
            Number(value.confirm === true) +
            Number(Boolean(value.retryCorrection)) +
            Number(Boolean(value.discardCorrection)) ===
          1,
      )
      .parse(req.body);
    let [row] = await db
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
    type Correction = { id: string; text: string };
    const unresolved = () =>
      (Array.isArray(row.data.unresolvedCorrections)
        ? row.data.unresolvedCorrections
        : []) as Correction[];
    if (
      (input.confirm || input.candidate) &&
      (row.data.pendingMessage || unresolved().length)
    )
      return reply.code(409).send({
        error:
          "Your latest message was not processed. Retry it before confirming or choosing an item.",
      });
    if (input.discardCorrection) {
      if (input.acknowledgeDiscard !== true)
        return reply.code(400).send({
          error:
            "Acknowledge that the saved draft will remain unchanged before discarding.",
        });
      if (!unresolved().some((c) => c.id === input.discardCorrection))
        return reply
          .code(409)
          .send({ error: "Correction no longer exists. Reload the draft." });
      const { pendingMessage, ...rest } = row.data;
      const next = {
        ...rest,
        ...(pendingMessage && pendingMessage !== input.discardCorrection
          ? { pendingMessage }
          : {}),
        unresolvedCorrections: unresolved().filter(
          (c) => c.id !== input.discardCorrection,
        ),
        revision: input.revision + 1,
      };
      const updated = await db
        .update(records)
        .set({ data: next })
        .where(and(eq(records.id, id), eq(records.data, row.data)))
        .returning();
      if (!updated.length)
        return reply
          .code(409)
          .send({ error: "Draft changed. Reload before editing." });
      const [snapshotRow] = await db
        .select()
        .from(records)
        .where(eq(records.id, String(row.data.snapshotId)));
      const snapshot = snapshotSchema.parse(snapshotRow?.data);
      const state = inspect(
        row.data.draft as ChatDraft,
        snapshot,
        DateTime.now().setZone("Asia/Kolkata").toFormat("yyyy-MM-dd"),
      );
      return {
        id,
        revision: next.revision,
        draft: row.data.draft,
        ...state,
        unresolvedCorrections: next.unresolvedCorrections,
        ready:
          state.ready &&
          !next.unresolvedCorrections.length &&
          !next.pendingMessage,
      };
    }
    let requestId: string | undefined;
    let message = input.message;
    if (input.retryCorrection) {
      const correction = unresolved().find(
        (c) => c.id === input.retryCorrection,
      );
      if (!correction)
        return reply
          .code(409)
          .send({ error: "Correction no longer exists. Reload the draft." });
      message = correction.text;
    }
    if (message) {
      if (!message.trim()) throw new Error("Enter a message");
      requestId = input.retryCorrection ?? randomUUID();
      // Claim the latest message before calling Gemini. A concurrent newer claim
      // replaces this marker; the older result can no longer commit.
      const [claimed] = await db
        .update(records)
        .set({
          data: input.retryCorrection
            ? sql`${records.data} || jsonb_build_object('pendingMessage', ${requestId}::text)`
            : sql`${records.data} || jsonb_build_object('pendingMessage', ${requestId}::text, 'unresolvedCorrections', coalesce(${records.data}->'unresolvedCorrections', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('id', ${requestId}::text, 'text', ${message}::text)))`,
        })
        .where(
          and(
            eq(records.id, id),
            eq(records.kind, "chat"),
            sql`${records.data}->>'revision' = ${String(input.revision)}`,
            sql`${records.data}->>'createdPr' IS NULL`,
            ...(input.retryCorrection
              ? [
                  sql`${records.data}->'unresolvedCorrections' @> ${JSON.stringify([{ id: requestId }])}::jsonb`,
                ]
              : []),
          ),
        )
        .returning();
      if (!claimed)
        return reply
          .code(409)
          .send({ error: "Draft changed. Reload before editing." });
      row = claimed;
    }
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
      if (!message?.trim() || !requestId) throw new Error("Enter a message");
      let update;
      try {
        if (!extract) throw new ChatError("configuration");
        update = fieldsSchema.parse(
          await extract(message, draft, { requestId }),
        );
        if (
          inspect(draft, snapshot, at.slice(0, 10)).ready &&
          !Object.values(update).some((value) => value?.trim())
        )
          throw new ChatError("validation");
      } catch (cause) {
        const error = classifyChatError(cause);
        // Production Gemini attempts are logged at the HTTP boundary; this also
        // records missing configuration and validation failures in injected extractors.
        if (!error.logged)
          logChatFailure(error, requestId, process.env.GEMINI_MODEL);
        const messages = {
          configuration:
            "AI chat is not configured correctly. Contact the administrator. Your draft is saved.",
          model_not_found:
            "The AI model configuration is unavailable. Contact the administrator. Your draft is saved.",
          rate_limit:
            "The AI rate limit has been reached. Please wait and retry this message. Your draft is saved.",
          service_unavailable:
            "The AI service is temporarily unavailable. Please retry this message. Your draft is saved.",
          timeout:
            "The AI request timed out. Please retry this message. Your draft is saved.",
          invalid_json:
            "The AI returned an invalid response. Please retry this message. Your draft is saved.",
          validation:
            "The AI returned an invalid response. Please retry this message. Your draft is saved.",
          internal:
            "Something went wrong on the server. Please retry this message. Your draft is saved.",
        };
        return reply.code(error.category === "internal" ? 500 : 503).send({
          error:
            messages[error.category] +
            " Your latest message was not processed; the previous draft was not updated.",
          retryable: chatRetryable(error),
          draft,
          revision: input.revision,
          unresolvedCorrections: unresolved(),
        });
      }
      try {
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
        logChatFailure(
          new ChatError("internal"),
          requestId,
          process.env.GEMINI_MODEL,
        );
        return reply.code(500).send({
          error:
            "Something went wrong on the server. Your latest message was not processed; the previous draft was not updated. Please retry.",
          retryable: true,
          draft,
          revision: input.revision,
          unresolvedCorrections: unresolved(),
        });
      }
    }
    const revision = input.revision + 1;
    const state = inspect(draft, snapshot, at.slice(0, 10));
    const { pendingMessage: _pendingMessage, ...completedData } = row.data;
    const remaining = unresolved().filter((c) => c.id !== requestId);
    const changed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(records)
        .set({
          data: {
            ...completedData,
            unresolvedCorrections: remaining,
            draft,
            revision,
            createdPr,
          },
        })
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
    return {
      id,
      revision,
      draft,
      ...state,
      ready: state.ready && remaining.length === 0,
      unresolvedCorrections: remaining,
      createdPr,
    };
  });
}
