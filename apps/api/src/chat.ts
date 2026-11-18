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
) => Promise<Fields>;

export function geminiChat(apiKey: string, model: string): ExtractChat {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 30000 } });
  return async (message, draft) => {
    const response = await ai.models.generateContent({
      model,
      contents: JSON.stringify({ message, draft }),
      config: {
        systemInstruction:
          "Extract every field explicitly supplied or corrected by the user in this message, including plant codes such as PUN1 or CHK1 and need-by dates. Return a partial update. Never invent item codes, units, prices, quantities or dates. Preserve relative date wording verbatim in needBy. For a short answer use the draft's missing fields as context. 'make it 300' corrects quantity. Use Normal or Emergency only when the wording supplies that urgency.",
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(fieldsSchema),
      },
    });
    return fieldsSchema.parse(JSON.parse(response.text ?? ""));
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

export function inspect(draft: ChatDraft, snapshot: Snapshot, today: string) {
  const fields = draft.fields;
  const ask = (question: string, candidates: Snapshot["items"] = []) => ({
    ready: false,
    question,
    candidates,
    resolvedDate: null as string | null,
  });
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
  if (match.status === "NEW" && !draft.newDescriptionConfirmed)
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
  if (
    !["PUN1", "CHK1"].includes(fields.plant ?? "") ||
    !snapshot.plants.includes(fields.plant!)
  )
    return ask("Which plant needs it, PUN1 or CHK1?");
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
