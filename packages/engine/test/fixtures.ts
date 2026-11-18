import type {
  Policy,
  PolicyBundle,
  PrLine,
  Snapshot,
  Item,
} from "../src/index.js";

// Independently authored fixtures. No supplied company records are stored here.
export const exampleItem: Item = {
  item_code: "DEMO-A",
  description: "Steel panel 20x40 grade 7",
  uom: "NOS",
  category: "Panels",
  item_type: "Material",
  standard_price: "10.25",
};

export function fixturePolicy(): Policy {
  return {
    version: "demo-1",
    effective_date: "2024-01-01",
    approval: { actor: "Demo reviewer", at: "2024-01-01T00:00:00+05:30" },
    parameters: {
      club_days: 14,
      need_by_days: 7,
      consolidation_hours: 24,
      history_days: 365,
      preferred_days: 548,
      active_statuses: ["Active"],
      emergency_labels: ["Emergency"],
      valuation_sources: ["contract", "history", "standard"],
      limits: { spot: "200000", emergency: "500000", rfp: "1000000" },
      ranking: {
        frequency: 40,
        recency: 25,
        contract: 15,
        delivery: 10,
        quality: 10,
        recent_days: 90,
        older_days: 365,
        older_score: 0.5,
      },
    },
    rules: [
      {
        id: "unlisted",
        clause: "D1",
        when: { op: "eq", left: { fact: "is_new" }, right: true },
        action: {
          decision: "SOURCING_REQUEST",
          route: "NEW_ITEM_SOURCING",
          supplier: "none",
          suggestions: 0,
          note: "",
        },
      },
      {
        id: "investment",
        clause: "D2",
        when: { op: "eq", left: { fact: "item_type" }, right: "Capex" },
        action: {
          decision: "SOURCING_REQUEST",
          route: "CAPEX_SOURCING",
          supplier: "none",
          suggestions: 5,
          note: "Requires capex approval",
        },
      },
      {
        id: "agreement",
        clause: "D3",
        when: { op: "eq", left: { fact: "contract_available" }, right: true },
        action: {
          decision: "PO",
          route: "CONTRACT_PO",
          supplier: "contract",
          suggestions: 0,
          note: "",
        },
      },
      {
        id: "urgent",
        clause: "D4",
        when: {
          all: [
            { op: "eq", left: { fact: "emergency" }, right: true },
            {
              op: "lte",
              left: { fact: "value" },
              right: { parameter: "emergency" },
            },
            {
              op: "eq",
              left: { fact: "has_recent_active_history" },
              right: true,
            },
          ],
        },
        action: {
          decision: "PO",
          route: "EMERGENCY_PO",
          supplier: "preferred",
          suggestions: 0,
          note: "",
        },
      },
      {
        id: "small",
        clause: "D5",
        when: {
          all: [
            { op: "lt", left: { fact: "value" }, right: { parameter: "spot" } },
            {
              op: "eq",
              left: { fact: "has_recent_active_history" },
              right: true,
            },
          ],
        },
        action: {
          decision: "PO",
          route: "SPOT_PO",
          supplier: "preferred",
          suggestions: 0,
          note: "",
        },
      },
      {
        id: "quotes",
        clause: "D6",
        when: {
          op: "lt",
          left: { fact: "value" },
          right: { parameter: "rfp" },
        },
        action: {
          decision: "SOURCING_REQUEST",
          route: "RFQ",
          supplier: "none",
          suggestions: 3,
          note: "",
        },
      },
      {
        id: "proposal",
        clause: "D7",
        when: {
          op: "gte",
          left: { fact: "value" },
          right: { parameter: "rfp" },
        },
        action: {
          decision: "SOURCING_REQUEST",
          route: "RFP",
          supplier: "none",
          suggestions: 5,
          note: "",
        },
      },
    ],
  };
}
export function bundle(): PolicyBundle {
  return {
    versions: [fixturePolicy()],
    selection: { mode: "requirement_date", execution_date: "2026-05-01" },
  };
}
export function snapshot(): Snapshot {
  return {
    snapshot_id: "synthetic",
    as_of: "2026-03-31",
    items: [{ ...exampleItem }],
    plants: ["EAST", "WEST"],
    contracts: [],
    suppliers: [
      {
        supplier_id: "VENDOR-A",
        name: "Demo supplier",
        status: "Active",
        categories: ["Panels"],
        on_time_pct: 90,
        quality_rating: 4,
      },
    ],
    history: [
      {
        po_number: "H-1",
        po_date: "2026-03-01",
        supplier_id: "VENDOR-A",
        item_code: "DEMO-A",
        unit_price: "10.25",
        uom: "NOS",
        plant: "EAST",
      },
    ],
  };
}
export function line(overrides: Partial<PrLine> = {}): PrLine {
  return {
    pr_no: "DEMO-PR-1",
    pr_line: "1",
    created_at: "2026-04-01 10:00",
    requester: "Demo requester",
    department: "Workshop",
    plant: "EAST",
    item_code: "DEMO-A",
    description: exampleItem.description,
    quantity: "2",
    uom: "NOS",
    estimated_unit_price: "",
    need_by_date: "2026-05-01",
    urgency: "Normal",
    ...overrides,
  };
}
