import { z } from "zod";

export const decimalString = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/, "Expected a nonnegative decimal string");
export const itemSchema = z.object({
  item_code: z.string().min(1),
  description: z.string().min(1),
  uom: z.string(),
  category: z.string(),
  item_type: z.string(),
  standard_price: decimalString,
});
export const supplierSchema = z.object({
  supplier_id: z.string().min(1),
  name: z.string(),
  status: z.string(),
  categories: z.array(z.string()),
  on_time_pct: z.number().min(0).max(100),
  quality_rating: z.number().min(0).max(5),
});
export const contractSchema = z.object({
  contract_id: z.string().min(1),
  supplier_id: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  value_cap: decimalString,
  consumed_value: decimalString,
  lines: z.array(
    z.object({ item_code: z.string(), uom: z.string(), rate: decimalString }),
  ),
});
export const snapshotSchema = z.object({
  snapshot_id: z.string(),
  as_of: z.string(),
  items: z.array(itemSchema),
  suppliers: z.array(supplierSchema),
  plants: z.array(z.string()),
  contracts: z.array(contractSchema),
  history: z.array(
    z.object({
      po_number: z.string(),
      po_date: z.string(),
      supplier_id: z.string(),
      item_code: z.string(),
      unit_price: decimalString,
      uom: z.string(),
      plant: z.string(),
    }),
  ),
});
export type Item = z.infer<typeof itemSchema>;
export type Supplier = z.infer<typeof supplierSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;

// CSV fields remain strings. Row-level validation must retain rejected rows in the export.
export const prSchema = z.object({
  pr_no: z.string(),
  pr_line: z.string(),
  created_at: z.string(),
  requester: z.string(),
  department: z.string(),
  plant: z.string(),
  item_code: z.string(),
  description: z.string(),
  quantity: z.string(),
  uom: z.string(),
  estimated_unit_price: z.string(),
  need_by_date: z.string(),
  urgency: z.string(),
});
export type PrLine = z.infer<typeof prSchema>;
export type Match = {
  status: "MATCHED" | "AMBIGUOUS" | "NEW";
  item_code: string | null;
  confidence: number;
  reason: string;
  candidates: string[];
};
export const routes = [
  "CONTRACT_PO",
  "EMERGENCY_PO",
  "SPOT_PO",
  "RFQ",
  "RFP",
  "CAPEX_SOURCING",
  "NEW_ITEM_SOURCING",
] as const;
export type Route = (typeof routes)[number];
export type DecisionRow = {
  pr_no: string;
  pr_line: string;
  resolved_item_code: string;
  group_id: string;
  po_id: string;
  decision: "PO" | "SOURCING_REQUEST" | "";
  route: Route | "NOT_PROCESSED";
  supplier_id: string;
  unit_price: string;
  group_value_inr: string;
  suggested_supplier_ids: string;
  policy_version: string;
  reason: string;
};
export type PreferredSupplier = {
  item_code: string;
  rank: number;
  supplier_id: string;
  reference_price: string;
  reference_source: string;
  score: number;
  components: {
    frequency: number;
    recency: number;
    contract: number;
    delivery: number;
    quality: number;
  };
};
export type Requirement = {
  group_id: string;
  indices: number[];
  first: PrLine;
  item: Item | null;
  quantity: string;
  emergency: boolean;
  policy_version: string;
  decision?: DecisionRow;
};
export type BatchResult = {
  decisions: DecisionRow[];
  requirements: Requirement[];
  matches: Match[];
  contract_consumption: Record<string, string>;
  metadata: {
    snapshot_id: string;
    selection_mode: string;
    execution_date: string;
    policy_versions: string[];
  };
  warnings: string[];
};
