import { z } from "zod";
import { DateTime } from "luxon";
import { Decimal } from "decimal.js";
import {
  matchItem,
  type Match,
  type Snapshot,
  type PrLine,
} from "@cantill/engine";
import { GoogleGenAI } from "@google/genai";

export const fieldsSchema = z
  .object({
    description: z.string().optional(),
    quantity: z.string().optional(),
    plant: z.string().optional(),
    uom: z.string().optional(),
    needBy: z.string().optional(),
    urgency: z.string().optional(),
    estimatedPrice: z.string().optional(),
  })
  .strict();
export type Fields = z.infer<typeof fieldsSchema>;
export type ChatDraft = {
  fields: Fields;
  selectedItem?: string;
  newDescriptionConfirmed?: boolean;
};
export type ExtractChat = (
  message: string,
  draft: ChatDraft,
  context?: { requestId: string },
) => Promise<Fields>;

export type ChatErrorCategory =
  | "configuration"
  | "model_not_found"
  | "rate_limit"
  | "service_unavailable"
  | "timeout"
  | "invalid_json"
  | "validation"
  | "internal";

export class ChatError extends Error {
  logged = false;
  constructor(
    public category: ChatErrorCategory,
    public upstreamStatus?: number,
    public retryAfterMs?: number,
  ) {
    super(category);
  }
}

export function classifyChatError(error: unknown): ChatError {
  if (error instanceof ChatError) return error;
  if (error instanceof z.ZodError) return new ChatError("validation");
  if (error instanceof SyntaxError) return new ChatError("invalid_json");
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return new ChatError("timeout");
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  if (status === 404) return new ChatError("model_not_found", status);
  if (status === 401 || status === 403)
    return new ChatError("configuration", status);
  if (status === 429) return new ChatError("rate_limit", status);
  if (status === 503) return new ChatError("service_unavailable", status);
  return new ChatError("internal", status);
}

export function chatRetryable(error: ChatError): boolean {
  return [
    "rate_limit",
    "service_unavailable",
    "timeout",
    "invalid_json",
    "validation",
    "internal",
  ].includes(error.category);
}

export function logChatFailure(
  error: ChatError,
  requestId: string,
  model?: string,
) {
  // Only fixed categories and non-sensitive metadata are logged; never the error body.
  console.error(
    JSON.stringify({
      event: "gemini_chat_failure",
      timestamp: new Date().toISOString(),
      requestId,
      category: error.category,
      upstreamStatus: error.upstreamStatus ?? null,
      model: model ?? null,
      apiVersion: process.env.GOOGLE_GENAI_API_VERSION || null,
      retryable: chatRetryable(error),
    }),
  );
  error.logged = true;
}

export function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function geminiChat(
  apiKey: string,
  model: string,
  options: {
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    timeoutMs?: number;
  } = {},
): ExtractChat {
  return async (message, draft, context) => {
    if (!apiKey.trim() || !model.trim()) throw new ChatError("configuration");
    const timeoutMs = options.timeoutMs ?? 30000;
    const deadline = Date.now() + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: timeoutMs,
        fetch: async (input, init) => {
          const response = await (options.fetch ?? fetch)(input, init);
          // The SDK's ApiError drops headers, so capture Retry-After before it does.
          if (!response.ok)
            throw new ChatError(
              response.status === 404
                ? "model_not_found"
                : response.status === 401 || response.status === 403
                  ? "configuration"
                  : response.status === 429
                    ? "rate_limit"
                    : response.status === 503
                      ? "service_unavailable"
                      : "internal",
              response.status,
              retryAfter(response.headers.get("retry-after")),
            );
          return response;
        },
      },
    });
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: JSON.stringify({ message, draft }),
          config: {
            abortSignal: signal,
            systemInstruction:
              "Extract every field explicitly supplied or corrected by the user in this message, including plant codes such as PUN1 or CHK1 and need-by dates. Return a partial update. Never invent item codes, units, prices, quantities or dates. Preserve relative date wording verbatim in needBy. For a short answer use the draft's missing fields as context. 'make it 300' corrects quantity. Use Normal or Emergency only when the wording supplies that urgency.",
            responseMimeType: "application/json",
            responseJsonSchema: z.toJSONSchema(fieldsSchema),
          },
        });
        return fieldsSchema.parse(JSON.parse(response.text ?? ""));
      } catch (cause) {
        const error = signal.aborted
          ? new ChatError("timeout")
          : classifyChatError(cause);
        logChatFailure(error, context?.requestId ?? "unavailable", model);
        if (
          attempt >= 2 ||
          !["rate_limit", "service_unavailable"].includes(error.category)
        )
          throw error;
        const delay = Math.max(
          error.retryAfterMs ?? 0,
          Math.floor((options.random ?? Math.random)() * 500 * 2 ** attempt),
        );
        if (delay >= deadline - Date.now()) throw error;
        await (
          options.sleep ??
          ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        )(delay);
        if (signal.aborted || Date.now() >= deadline)
          throw new ChatError("timeout");
      }
    }
  };
}

export function resolveDate(value: string, today: string): string | null {
  const start = DateTime.fromISO(today, { zone: "Asia/Kolkata" });
  const text = value.trim().toLowerCase();
  if (text === "today") return today;
  if (text === "tomorrow") return start.plus({ days: 1 }).toISODate();
  const weekdays = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const weekday = weekdays.indexOf(text.replace(/^next /, ""));
  if (weekday >= 0)
    return start
      .plus({ days: (weekday + 1 - start.weekday + 7) % 7 || 7 })
      .toISODate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = DateTime.fromISO(text, { zone: "Asia/Kolkata" });
  return date.isValid ? date.toISODate() : null;
}

export function advance(draft: ChatDraft, update: Fields): ChatDraft {
  // Structured output may contain empty strings for fields the user did not mention.
  // Keep the previous answer instead of erasing it on a follow-up.
  const supplied = Object.fromEntries(
    Object.entries(update).filter(
      ([, value]) => value !== undefined && value.trim() !== "",
    ),
  ) as Fields;
  const fields = { ...draft.fields, ...supplied };
  const descriptionChanged =
    supplied.description !== undefined &&
    supplied.description !== draft.fields.description;
  return {
    fields,
    selectedItem: descriptionChanged ? undefined : draft.selectedItem,
    newDescriptionConfirmed: descriptionChanged
      ? true
      : draft.newDescriptionConfirmed,
  };
}

// Only values explicitly present in the message or verified against the snapshot
// may override the model's plant and urgency suggestions.
export function groundChatFields(
  message: string,
  update: Fields,
  snapshot: Snapshot,
): Fields {
  const result = { ...update };
  const upper = message.toUpperCase();
  const prefixes = [
    ...new Set(
      snapshot.plants
        .map((p) => p.match(/^[A-Z]+/i)?.[0]?.toUpperCase())
        .filter(Boolean),
    ),
  ];
  const knownCodes = snapshot.plants
    .filter((code) =>
      new RegExp(
        `(?<![A-Z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Z0-9])`,
        "i",
      ).test(message),
    )
    .map((code) => code.toUpperCase());
  const codes = [...upper.matchAll(/\b([A-Z]{2,}\d+)\b/g)]
    .map((m) => m[1])
    .filter((code) => prefixes.some((prefix) => code.startsWith(prefix!)));
  const distinctCodes = [...new Set([...knownCodes, ...codes])];
  if (distinctCodes.length)
    result.plant = distinctCodes.length === 1 ? distinctCodes[0] : "AMBIGUOUS";
  else {
    const hits = snapshot.plants.filter((code) => {
      const name = snapshot.plantNames?.[code] ?? "";
      const terms = name.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      return terms
        .filter((term) => !["plant", "location"].includes(term))
        .some((term) => new RegExp(`\\b${term}\\b`, "i").test(message));
    });
    if (hits.length === 1) result.plant = hits[0];
    else if (hits.length > 1) result.plant = "AMBIGUOUS";
    else if (
      update.plant &&
      new RegExp(
        `\\b${update.plant.replace(/[^a-zA-Z0-9]/g, "")}\\b`,
        "i",
      ).test(message)
    )
      result.plant = update.plant.toUpperCase();
    else delete result.plant;
  }
  const urgency = [...message.matchAll(/\b(emergency|urgent|normal)\b/gi)];
  if (urgency.length) {
    const last = urgency.at(-1)!;
    const before = message
      .slice(Math.max(0, last.index! - 5), last.index)
      .toLowerCase();
    if (!/\bnot\s+$/.test(before))
      result.urgency =
        last[0].toLowerCase() === "normal" ? "Normal" : "Emergency";
    else delete result.urgency;
  } else delete result.urgency;
  return result;
}

export function differentKnownItem(
  draft: ChatDraft,
  description: string,
  snapshot: Snapshot,
): boolean {
  if (
    !draft.fields.description ||
    draft.fields.description.toLowerCase() === description.toLowerCase()
  )
    return false;
  const old =
    draft.selectedItem ??
    matchItem(
      draft.fields.description,
      draft.fields.uom ?? "",
      "",
      snapshot.items,
    ).item_code;
  if (!old) {
    const before = new Set(
      draft.fields.description.toLowerCase().match(/[a-z0-9]+/g) ?? [],
    );
    const after = description.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return Boolean(
      (draft.fields.quantity || draft.fields.plant || draft.fields.needBy) &&
      !after.some((word) => before.has(word)),
    );
  }
  const next = matchItem(description, "", "", snapshot.items);
  return next.item_code !== old && !next.candidates.includes(old);
}

export function inspect(draft: ChatDraft, snapshot: Snapshot, today: string) {
  const fields = draft.fields;
  const ask = (question: string, candidates: Snapshot["items"] = []) => ({
    ready: false,
    question,
    candidates,
    resolvedDate: null as string | null,
  });
  if (fields.plant && !snapshot.plants.includes(fields.plant.toUpperCase()))
    return ask(
      "Invalid plant. Please use " + snapshot.plants.join(" or ") + ".",
    );
  if (!fields.description?.trim())
    return ask(
      "What item do you need? Please include its size or specification.",
    );
  const selected = snapshot.items.find(
    (item) => item.item_code === draft.selectedItem,
  );
  const match: Match = selected
    ? {
        status: "MATCHED",
        item_code: selected.item_code,
        candidates: [],
        confidence: 1,
        reason: "User selected candidate",
      }
    : matchItem(
        fields.description,
        fields.uom?.toUpperCase() ?? "",
        "",
        snapshot.items,
      );
  if (match.status === "AMBIGUOUS")
    return ask(
      "Which item do you mean? Choose a candidate or add more specifications.",
      snapshot.items.filter((item) =>
        match.candidates.includes(item.item_code),
      ),
    );
  const item =
    selected ??
    snapshot.items.find((item) => item.item_code === match.item_code);
  if (
    match.status === "NEW" &&
    !draft.newDescriptionConfirmed &&
    (fields.description.match(/[a-z0-9]+/gi)?.length ?? 0) < 2
  )
    return ask("This looks like a new item. What is its full description?");
  if (!fields.uom && !item)
    return ask("What unit is the new item measured in?");
  const unit = fields.uom?.toUpperCase() ?? item?.uom;
  if (item && unit !== item.uom)
    return ask(
      "Please set the unit to " +
        item.uom +
        ". What quantity do you need in that unit?",
    );
  if (!item && !snapshot.items.some((entry) => entry.uom === unit))
    return ask(
      "Choose a unit from " +
        [...new Set(snapshot.items.map((entry) => entry.uom))].join(", ") +
        ".",
    );
  if (
    !fields.quantity ||
    !/^\d+(\.\d+)?$/.test(fields.quantity) ||
    !new Decimal(fields.quantity).gt(0)
  )
    return ask("What quantity do you need? Enter a number greater than zero.");
  if (!fields.plant || !snapshot.plants.includes(fields.plant.toUpperCase()))
    return ask("Which plant needs it, " + snapshot.plants.join(" or ") + "?");
  const resolvedDate = resolveDate(fields.needBy ?? "", today);
  if (!resolvedDate || resolvedDate < today)
    return ask(
      "When do you need it? Give a date today or later, such as YYYY-MM-DD.",
    );
  if (!["Normal", "Emergency"].includes(fields.urgency ?? ""))
    return ask("Is the request Normal or Emergency?");
  if (
    !item &&
    (!fields.estimatedPrice ||
      !/^\d+(\.\d+)?$/.test(fields.estimatedPrice) ||
      !new Decimal(fields.estimatedPrice).gt(0))
  )
    return ask("What is the estimated unit price in INR?");
  return {
    ready: true,
    question: "Confirm this request?",
    candidates: [],
    resolvedDate,
    summary: {
      description: item?.description ?? fields.description,
      item_code: item?.item_code ?? "NEW",
      quantity: fields.quantity,
      uom: unit!,
      plant: fields.plant!,
      need_by_date: resolvedDate,
      urgency: fields.urgency!,
      estimated_unit_price: fields.estimatedPrice ?? "",
    },
  };
}

export function createLine(
  draft: ChatDraft,
  snapshot: Snapshot,
  at: string,
  prNo: string,
  requester: string,
): PrLine {
  const result = inspect(draft, snapshot, at.slice(0, 10));
  if (!result.ready || !("summary" in result))
    throw new Error("Complete the request before confirming.");
  return {
    ...result.summary,
    item_code:
      result.summary.item_code === "NEW" ? "" : result.summary.item_code,
    pr_no: prNo,
    pr_line: "1",
    created_at: at,
    requester,
    department: "",
  };
}
