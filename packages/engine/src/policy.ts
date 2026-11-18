import { z } from "zod";
import { Decimal } from "decimal.js";
import { date } from "./dates.js";
import { routes } from "./model.js";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const factNames = [
  "item_type",
  "category",
  "plant",
  "value",
  "emergency",
  "is_new",
  "contract_available",
  "has_recent_active_history",
  "preferred_available",
  "quantity",
] as const;
const operandSchema = z.union([
  scalar,
  z.array(scalar),
  z.object({ fact: z.enum(factNames) }).strict(),
  z.object({ parameter: z.string() }).strict(),
]);
type Operand = z.infer<typeof operandSchema>;
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | {
      op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "exists";
      left: Operand;
      right?: Operand;
    };
const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z
      .object({
        op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "in", "exists"]),
        left: operandSchema,
        right: operandSchema.optional(),
      })
      .strict()
      .refine(
        (c) => c.op === "exists" || c.right !== undefined,
        "Comparison requires a right operand",
      ),
  ]),
);

const policyFields = z
  .object({
    version: z.string().min(1),
    effective_date: z.string().refine((v) => {
      try {
        date(v);
        return true;
      } catch {
        return false;
      }
    }),
    approval: z.object({
      actor: z.string().min(1),
      at: z.iso.datetime({ offset: true }),
    }),
    parameters: z.object({
      club_days: z.number().int().nonnegative(),
      need_by_days: z.number().int().nonnegative(),
      consolidation_hours: z.number().nonnegative(),
      history_days: z.number().int().positive(),
      preferred_days: z.number().int().positive(),
      active_statuses: z.array(z.string()).min(1),
      emergency_labels: z.array(z.string()).min(1),
      valuation_sources: z
        .array(z.enum(["contract", "history", "standard"]))
        .min(1),
      limits: z.record(z.string(), z.string().regex(/^\d+(?:\.\d+)?$/)),
      ranking: z.object({
        frequency: z.number().nonnegative(),
        recency: z.number().nonnegative(),
        contract: z.number().nonnegative(),
        delivery: z.number().nonnegative(),
        quality: z.number().nonnegative(),
        recent_days: z.number().int().nonnegative(),
        older_days: z.number().int().nonnegative(),
        older_score: z.number().min(0).max(1),
      }),
    }),
    rules: z
      .array(
        z
          .object({
            id: z.string().min(1),
            clause: z.string().min(1),
            when: conditionSchema,
            action: z
              .object({
                decision: z.enum(["PO", "SOURCING_REQUEST"]),
                route: z.enum(routes),
                supplier: z.enum(["contract", "preferred", "none"]),
                suggestions: z.number().int().nonnegative(),
                note: z.string().default(""),
              })
              .strict()
              .refine(
                (a) => (a.decision === "PO") === (a.supplier !== "none"),
                "PO requires a supplier strategy",
              )
              .refine(
                (a) => (a.decision === "PO") === a.route.endsWith("_PO"),
                "Decision and route must agree",
              ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

function validateRules(
  p: Pick<z.infer<typeof policyFields>, "rules" | "parameters">,
  ctx: z.RefinementCtx,
) {
  if (new Set(p.rules.map((r) => r.id)).size !== p.rules.length)
    ctx.addIssue({ code: "custom", message: "Rule IDs must be unique" });
  const visit = (c: Condition): void => {
    if ("all" in c) {
      c.all.forEach(visit);
      return;
    }
    if ("any" in c) {
      c.any.forEach(visit);
      return;
    }
    if ("not" in c) {
      visit(c.not);
      return;
    }
    const isReference = (v: Operand | undefined) =>
      v !== null && typeof v === "object" && !Array.isArray(v);
    const isNumeric = (v: Operand | undefined) => {
      if (isReference(v)) {
        const ref = v as { fact?: string; parameter?: string };
        return (
          ref.parameter !== undefined ||
          ref.fact === "value" ||
          ref.fact === "quantity"
        );
      }
      return (
        (typeof v === "number" || typeof v === "string") &&
        /^-?\d+(?:\.\d+)?$/.test(String(v))
      );
    };
    if (
      ["lt", "lte", "gt", "gte"].includes(c.op) &&
      (!isNumeric(c.left) || !isNumeric(c.right))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Ordered comparisons require numeric facts, limits, or literals",
      });
    if (c.op === "in" && !Array.isArray(c.right))
      ctx.addIssue({
        code: "custom",
        message: "Membership comparison requires an array",
      });
    for (const value of [c.left, c.right]) {
      if (
        value &&
        typeof value === "object" &&
        "parameter" in value &&
        !(value.parameter in p.parameters.limits)
      )
        ctx.addIssue({
          code: "custom",
          message: `Unknown parameter: ${value.parameter}`,
        });
    }
  };
  p.rules.forEach((r) => visit(r.when));
}
export const policyDraftSchema = policyFields
  .omit({ approval: true })
  .superRefine(validateRules);
export const policySchema = policyFields.superRefine(validateRules);
export type Policy = z.infer<typeof policySchema>;
export const policySelectionSchema = z
  .object({
    mode: z.enum(["requirement_date", "currently_active", "explicit_version"]),
    execution_date: z.iso.date(),
    version: z.string().optional(),
  })
  .strict();
export const policyBundleSchema = z
  .object({
    versions: z.array(policySchema).min(1),
    selection: policySelectionSchema,
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (
      new Set(bundle.versions.map((p) => p.version)).size !==
      bundle.versions.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Policy versions must be unique",
      });
    if (
      bundle.selection.mode === "explicit_version" &&
      !bundle.versions.some((p) => p.version === bundle.selection.version)
    )
      ctx.addIssue({
        code: "custom",
        message: "Select an approved policy version",
      });
  });
export type PolicyBundle = z.infer<typeof policyBundleSchema>;

export function selectPolicy(
  bundle: PolicyBundle,
  requirementDate: string,
): Policy {
  date(requirementDate);
  date(bundle.selection.execution_date);
  if (bundle.selection.mode === "explicit_version")
    return bundle.versions.find((p) => p.version === bundle.selection.version)!;
  const asOf =
    bundle.selection.mode === "currently_active"
      ? bundle.selection.execution_date
      : requirementDate;
  const candidates = bundle.versions
    .filter((p) => p.effective_date <= asOf)
    .sort(
      (a, b) =>
        b.effective_date.localeCompare(a.effective_date) ||
        b.approval.at.localeCompare(a.approval.at) ||
        a.version.localeCompare(b.version),
    );
  if (!candidates.length)
    throw new Error(`No approved policy effective on ${asOf}`);
  return candidates[0];
}

function resolve(
  value: Operand | undefined,
  facts: Record<string, unknown>,
  policy: Policy,
): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("fact" in value) return facts[value.fact];
    return policy.parameters.limits[value.parameter];
  }
  return value;
}

export function evaluate(
  condition: Condition,
  facts: Record<string, unknown>,
  policy: Policy,
): boolean {
  if ("all" in condition)
    return condition.all.every((c) => evaluate(c, facts, policy));
  if ("any" in condition)
    return condition.any.some((c) => evaluate(c, facts, policy));
  if ("not" in condition) return !evaluate(condition.not, facts, policy);
  const left = resolve(condition.left, facts, policy);
  const right = resolve(condition.right, facts, policy);
  if (condition.op === "exists") return left !== null && left !== undefined;
  const numericFact =
    condition.left !== null &&
    typeof condition.left === "object" &&
    "fact" in condition.left &&
    ["value", "quantity"].includes(condition.left.fact);
  const comparableNumbers =
    /^-?\d+(?:\.\d+)?$/.test(String(left)) &&
    /^-?\d+(?:\.\d+)?$/.test(String(right));
  const equal =
    numericFact && comparableNumbers
      ? new Decimal(String(left)).equals(String(right))
      : left === right;
  if (condition.op === "eq") return equal;
  if (condition.op === "ne") return !equal;
  if (condition.op === "in")
    return Array.isArray(right) && right.includes(left);
  if (left == null || right == null) return false;
  const comparison = new Decimal(String(left)).comparedTo(String(right));
  switch (condition.op) {
    case "lt":
      return comparison < 0;
    case "lte":
      return comparison <= 0;
    case "gt":
      return comparison > 0;
    case "gte":
      return comparison >= 0;
  }
}

export function amendmentImpact(
  policy: Pick<Policy, "effective_date">,
  requirementDates: string[],
) {
  const affected = requirementDates.filter(
    (d) => d >= policy.effective_date,
  ).length;
  return {
    affected,
    warning:
      requirementDates.length && affected === 0
        ? "Effective date is after all requirement dates"
        : null,
  };
}
