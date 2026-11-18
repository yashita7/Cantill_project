import { describe, it, expect } from "vitest";
import {
  process as run,
  matchItem,
  preferredSuppliers,
  preferredExport,
  policySchema,
  evaluate,
  selectPolicy,
  amendmentImpact,
} from "../src/index.js";
import { inHistory, timestamp } from "../src/dates.js";
import {
  bundle,
  fixturePolicy,
  snapshot,
  line,
  exampleItem,
} from "./fixtures.js";
import type { Contract, Policy } from "../src/index.js";

function agreement(overrides: Partial<Contract> = {}): Contract {
  return {
    contract_id: "DEMO-C",
    supplier_id: "VENDOR-A",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    value_cap: "1000",
    consumed_value: "0",
    lines: [{ item_code: "DEMO-A", uom: "NOS", rate: "9.25" }],
    ...overrides,
  };
}

describe("Money and routing", () => {
  it("multiplies decimal quantities exactly and keeps source immutable", () => {
    const data = snapshot();
    data.history[0].unit_price = "0.10";
    const before = JSON.stringify(data);
    expect(
      run(bundle(), data, [line({ quantity: "3" })]).decisions[0]
        .group_value_inr,
    ).toBe("0.30");
    expect(JSON.stringify(data)).toBe(before);
  });
  it.each([
    ["199999.99", "Normal", "SPOT_PO"],
    ["200000.00", "Normal", "RFQ"],
    ["499999.99", "Emergency", "EMERGENCY_PO"],
    ["500000.00", "Emergency", "EMERGENCY_PO"],
    ["500000.01", "Emergency", "RFQ"],
    ["999999.99", "Normal", "RFQ"],
    ["1000000.00", "Normal", "RFP"],
    ["1000000.01", "Normal", "RFP"],
  ])("routes %s %s to %s", (price, urgency, route) => {
    const data = snapshot();
    data.history[0].unit_price = price;
    expect(
      run(bundle(), data, [line({ quantity: "1", urgency })]).decisions[0]
        .route,
    ).toBe(route);
  });
  it("uses latest historical valuation even if that supplier is blocked", () => {
    const data = snapshot();
    data.suppliers.push({
      ...data.suppliers[0],
      supplier_id: "VENDOR-B",
      status: "Blocked",
    });
    data.history.push({
      ...data.history[0],
      po_number: "H-2",
      po_date: "2026-03-20",
      supplier_id: "VENDOR-B",
      unit_price: "20.15",
    });
    const decision = run(bundle(), data, [line()]).decisions[0];
    expect(decision.group_value_inr).toBe("40.30");
    expect(decision.unit_price).toBe("10.25");
    expect(decision.supplier_id).toBe("VENDOR-A");
  });
  it("uses item standard price and RFQ without purchase history", () => {
    const data = snapshot();
    data.history = [];
    expect(run(bundle(), data, [line()]).decisions[0]).toMatchObject({
      route: "RFQ",
      group_value_inr: "20.50",
    });
  });
  it("routes new items without estimates to sourcing with blank value", () => {
    const result = run(bundle(), snapshot(), [
      line({
        item_code: "",
        description: "Unlisted water filter",
        estimated_unit_price: "",
      }),
    ]);
    expect(result.decisions[0]).toMatchObject({
      resolved_item_code: "NEW",
      route: "NEW_ITEM_SOURCING",
      group_value_inr: "",
      suggested_supplier_ids: "",
    });
    expect(result.decisions[0].reason).toContain("value unavailable");
  });
  it("does not club new items", () => {
    const a = line({
      item_code: "",
      description: "Unlisted water filter",
      estimated_unit_price: "12.34",
    });
    const result = run(bundle(), snapshot(), [a, { ...a, pr_no: "DEMO-PR-2" }]);
    expect(result.requirements).toHaveLength(2);
  });
  it.each(["0", "-1", "not a number"])(
    "rejects invalid quantity %s",
    (quantity) => {
      expect(
        run(bundle(), snapshot(), [line({ quantity })]).decisions[0].route,
      ).toBe("NOT_PROCESSED");
    },
  );
  it("preserves rejected and ambiguous rows", () => {
    const result = run(bundle(), snapshot(), [
      line({ plant: "UNKNOWN" }),
      line({ pr_no: "P2", created_at: "invalid" }),
      line({ pr_no: "P3", item_code: "", description: "Steel panel" }),
    ]);
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.every((r) => r.route === "NOT_PROCESSED")).toBe(
      true,
    );
  });
  it("rejects duplicate identities rather than losing rows", () => {
    const result = run(bundle(), snapshot(), [line(), line()]);
    expect(result.decisions).toHaveLength(2);
    expect(result.requirements).toHaveLength(0);
  });
});

describe("Deterministic matching and incompatible specifications", () => {
  it.each([
    "Steel panel 20x41 grade 7",
    "Steel panel 20x40 grade 8",
    "Steel panel 40x20 grade 7",
  ])("rejects %s", (description) => {
    expect(matchItem(description, "NOS", "", [exampleItem]).status).not.toBe(
      "MATCHED",
    );
  });
  it.each([
    "Ball bearing 8572-2RS",
    "Ball bearing 8571-ZZ",
    "Ball bearing 8571-RS",
  ])("rejects incompatible bearing %s", (description) => {
    const item = { ...exampleItem, description: "Ball bearing 8571-2RS" };
    expect(matchItem(description, "NOS", "", [item]).status).not.toBe(
      "MATCHED",
    );
  });
  it("preserves ordered pneumatic dimensions", () => {
    const item = { ...exampleItem, description: "Pneumatic cylinder 37x83" };
    expect(matchItem("pneu cylinder 83x37", "NOS", "", [item]).status).toBe(
      "NEW",
    );
  });
  it.each([
    ["Steel fastener grade A2", "Steel fastener grade B2"],
    ["Solar indicator 73W", "Solar indicator 73kW"],
    ["Metal sheet 20mm", "Metal sheet 20cm"],
  ])("protects grades and measurement units in %s", (master, requested) => {
    expect(
      matchItem(requested, "NOS", "", [{ ...exampleItem, description: master }])
        .status,
    ).not.toBe("MATCHED");
  });
  it("requires units to match", () =>
    expect(
      matchItem(exampleItem.description, "KG", "", [exampleItem]).status,
    ).toBe("AMBIGUOUS"));
  it("requests missing bearing suffix", () => {
    expect(
      matchItem("Ball bearing 8599", "NOS", "", [
        { ...exampleItem, description: "Ball bearing 8599-ZZ" },
      ]).status,
    ).toBe("AMBIGUOUS");
  });
  it("does not choose between equivalent candidates", () => {
    expect(
      matchItem(exampleItem.description, "NOS", "", [
        exampleItem,
        { ...exampleItem, item_code: "DEMO-B" },
      ]).status,
    ).toBe("AMBIGUOUS");
  });
  it("handles normalization and abbreviation expansion", () => {
    expect(
      matchItem("brg 8571 2rs for maintenance", "NOS", "", [
        { ...exampleItem, description: "Ball bearing 8571-2RS" },
      ]).item_code,
    ).toBe("DEMO-A");
    expect(
      matchItem("steel panel 20 × 40 grade 7 - urgent", "NOS", "", [
        exampleItem,
      ]).item_code,
    ).toBe("DEMO-A");
  });
});

describe("IST and date boundaries", () => {
  it("parses IST independently of machine timezone", () =>
    expect(timestamp("2026-04-01 00:00").toUTC().toISO()).toBe(
      "2026-03-31T18:30:00.000Z",
    ));
  it.each([
    ["2025-04-01", "2026-04-01", 365, true],
    ["2025-03-31", "2026-04-01", 365, false],
    ["2026-03-31", "2026-04-01", 365, true],
    ["2026-04-01", "2026-04-01", 365, false],
    ["2024-09-30", "2026-04-01", 548, true],
    ["2024-09-29", "2026-04-01", 548, false],
    ["2026-04-01", "2026-04-01", 548, false],
  ])("history %s before %s within %i => %s", (day, asOf, days, expected) =>
    expect(inHistory(day, asOf, days)).toBe(expected),
  );
  it.each([
    ["2026-04-15 23:59", 1],
    ["2026-04-16 00:00", 2],
  ])("calendar grouping %s", (created_at, count) => {
    const result = run(bundle(), snapshot(), [
      line(),
      line({ pr_no: "P2", created_at }),
    ]);
    expect(result.requirements).toHaveLength(count);
  });
  it.each([
    ["2026-04-24", 1],
    ["2026-04-23", 2],
    ["2026-05-08", 1],
    ["2026-05-09", 2],
  ])("need by %s", (need_by_date, count) => {
    expect(
      run(bundle(), snapshot(), [line(), line({ pr_no: "P2", need_by_date })])
        .requirements,
    ).toHaveLength(count);
  });
  it("anchors grouping to the first line, without transitive chaining", () => {
    const rows = [
      line(),
      line({ pr_no: "P2", created_at: "2026-04-14 10:00" }),
      line({ pr_no: "P3", created_at: "2026-04-25 10:00" }),
    ];
    const result = run(bundle(), snapshot(), rows);
    expect(result.requirements.map((g) => g.indices)).toEqual([[0, 1], [2]]);
  });
  it("joins the earliest eligible requirement", () => {
    const result = run(bundle(), snapshot(), [
      line({ need_by_date: "2026-05-01" }),
      line({
        pr_no: "P2",
        created_at: "2026-04-02 10:00",
        need_by_date: "2026-05-10",
      }),
      line({
        pr_no: "P3",
        created_at: "2026-04-03 10:00",
        need_by_date: "2026-05-05",
      }),
    ]);
    expect(result.requirements.map((g) => g.indices)).toEqual([[0, 2], [1]]);
  });
  it("propagates emergency and preserves plants", () => {
    const result = run(bundle(), snapshot(), [
      line(),
      line({ pr_no: "P2", urgency: "Emergency" }),
      line({ pr_no: "P3", plant: "WEST" }),
    ]);
    expect(result.requirements).toHaveLength(2);
    expect(result.decisions[0].route).toBe("EMERGENCY_PO");
  });
  it.each([
    ["2026-04-02 10:00", true],
    ["2026-04-02 10:01", false],
  ])("PO window %s", (created_at, shared) => {
    const result = run(bundle(), snapshot(), [
      line(),
      line({ pr_no: "P2", created_at, need_by_date: "2026-06-01" }),
    ]);
    expect(result.decisions[0].po_id === result.decisions[1].po_id).toBe(
      shared,
    );
  });
  it("sorts numeric PR line ties and keeps export input order", () => {
    const result = run(bundle(), snapshot(), [
      line({ pr_line: "10" }),
      line({ pr_line: "2" }),
    ]);
    expect(result.requirements[0].first.pr_line).toBe("2");
    expect(result.decisions.map((r) => r.pr_line)).toEqual(["10", "2"]);
  });
});

describe("Contracts and consumption", () => {
  it.each([
    ["2026-04-01", "2026-04-01", "CONTRACT_PO"],
    ["2026-03-01", "2026-03-31", "SPOT_PO"],
    ["2026-04-02", "2026-05-01", "SPOT_PO"],
  ])("term %s to %s", (start_date, end_date, route) => {
    const data = snapshot();
    data.contracts = [agreement({ start_date, end_date })];
    expect(run(bundle(), data, [line()]).decisions[0].route).toBe(route);
  });
  it("never awards a blocked supplier", () => {
    const data = snapshot();
    data.contracts = [agreement()];
    data.suppliers[0].status = "Blocked";
    expect(run(bundle(), data, [line()]).decisions[0]).toMatchObject({
      route: "RFQ",
      supplier_id: "",
      suggested_supplier_ids: "",
    });
  });
  it.each([
    ["18.50", "CONTRACT_PO"],
    ["18.49", "SPOT_PO"],
  ])("ceiling %s", (value_cap, route) => {
    const data = snapshot();
    data.contracts = [agreement({ value_cap })];
    const result = run(bundle(), data, [line()]);
    expect(result.decisions[0].route).toBe(route);
    expect(result.decisions[0].group_value_inr).toBe("18.50");
  });
  it("selects higher rate when lower rate lacks ceiling", () => {
    const data = snapshot();
    data.contracts = [
      agreement({ contract_id: "LOW", value_cap: "1" }),
      agreement({
        contract_id: "HIGH",
        lines: [{ item_code: "DEMO-A", uom: "NOS", rate: "9.50" }],
      }),
    ];
    expect(run(bundle(), data, [line()]).decisions[0]).toMatchObject({
      route: "CONTRACT_PO",
      unit_price: "9.50",
      group_value_inr: "19.00",
    });
  });
  it("shares ceiling across items in requirement time order", () => {
    const data = snapshot();
    data.items.push({
      ...exampleItem,
      item_code: "DEMO-B",
      description: "Other panel",
    });
    data.contracts = [
      agreement({
        value_cap: "20",
        lines: [
          { item_code: "DEMO-A", uom: "NOS", rate: "9" },
          { item_code: "DEMO-B", uom: "NOS", rate: "9" },
        ],
      }),
    ];
    const result = run(bundle(), data, [
      line({
        pr_no: "P2",
        item_code: "DEMO-B",
        created_at: "2026-04-02 10:00",
      }),
      line(),
    ]);
    expect(result.decisions.map((r) => r.route)).toEqual([
      "RFQ",
      "CONTRACT_PO",
    ]);
    expect(result.contract_consumption["DEMO-C"]).toBe("18.00");
  });
  it("capex takes precedence and does not consume contract ceiling", () => {
    const data = snapshot();
    data.items[0].item_type = "Capex";
    data.contracts = [agreement()];
    const result = run(bundle(), data, [line()]);
    expect(result.decisions[0].route).toBe("CAPEX_SOURCING");
    expect(result.contract_consumption["DEMO-C"]).toBe("0.00");
  });
  it("reruns leave baseline consumption intact and preserve IDs", () => {
    const data = snapshot();
    data.contracts = [agreement({ consumed_value: "100" })];
    const first = run(bundle(), data, [line()]);
    expect(run(bundle(), data, [line()])).toEqual(first);
    expect(data.contracts[0].consumed_value).toBe("100");
    expect(first.contract_consumption["DEMO-C"]).toBe("118.50");
  });
});

describe("Supplier lists", () => {
  it("includes expired contracts and excludes future contracts and inactive suppliers", () => {
    const data = snapshot();
    data.history = [];
    data.contracts = [agreement({ end_date: "2026-03-31" })];
    expect(
      preferredSuppliers(fixturePolicy(), data, "DEMO-A", "2026-04-01")[0]
        .reference_price,
    ).toBe("9.25");
    data.contracts[0].start_date = "2026-04-02";
    expect(
      preferredSuppliers(fixturePolicy(), data, "DEMO-A", "2026-04-01"),
    ).toHaveLength(0);
    data.contracts[0].start_date = "2026-01-01";
    data.suppliers[0].status = "Inactive";
    expect(
      preferredSuppliers(fixturePolicy(), data, "DEMO-A", "2026-04-01"),
    ).toHaveLength(0);
  });
  it("uses requirement date independently for each group", () => {
    const data = snapshot();
    data.history[0].po_date = "2025-04-10";
    const result = run(bundle(), data, [
      line(),
      line({ pr_no: "P2", created_at: "2026-04-20 10:00" }),
    ]);
    expect(result.decisions.map((r) => r.route)).toEqual(["SPOT_PO", "RFQ"]);
  });
});

describe("Generic amendments and effective dates", () => {
  function plantRule(): Policy["rules"][number] {
    return {
      id: "new-plant-rule",
      clause: "Demo amendment",
      when: {
        all: [
          { op: "eq", left: { fact: "plant" }, right: "WEST" },
          { op: "in", left: { fact: "category" }, right: ["Panels"] },
          { op: "gt", left: { fact: "value" }, right: "15" },
        ],
      },
      action: {
        decision: "SOURCING_REQUEST",
        route: "RFP",
        supplier: "none",
        suggestions: 5,
        note: "",
      },
    };
  }
  it("adds a plant/category/value rule without changing engine code", () => {
    const policies = bundle();
    policies.versions[0].rules.unshift(plantRule());
    const result = run(policies, snapshot(), [
      line(),
      line({ pr_no: "P2", plant: "WEST" }),
    ]);
    expect(result.decisions.map((r) => r.route)).toEqual(["SPOT_PO", "RFP"]);
  });
  it("adds a category-specific threshold and nested not/any rule", () => {
    const policies = bundle();
    const rule = plantRule();
    rule.when = {
      all: [
        { not: { op: "eq", left: { fact: "category" }, right: "Other" } },
        {
          any: [
            { op: "gt", left: { fact: "value" }, right: "20" },
            { op: "eq", left: { fact: "emergency" }, right: true },
          ],
        },
      ],
    };
    rule.action.route = "RFQ";
    rule.action.suggestions = 3;
    policies.versions[0].rules.unshift(rule);
    expect(run(policies, snapshot(), [line()]).decisions[0].route).toBe("RFQ");
  });
  it("validates unknown facts, parameter references, and malformed rules", () => {
    const p = fixturePolicy();
    p.rules[0].when = {
      op: "lt",
      left: { fact: "value" },
      right: { parameter: "missing" },
    };
    expect(() => policySchema.parse(p)).toThrow();
    expect(() =>
      policySchema.parse({ ...fixturePolicy(), rules: [{ id: "broken" }] }),
    ).toThrow();
  });
  it("selects dated, current, and explicitly approved versions without automatic switching", () => {
    const policies = bundle();
    const amended = fixturePolicy();
    amended.version = "demo-2";
    amended.effective_date = "2026-04-20";
    amended.rules.unshift(plantRule());
    policies.versions.push(amended);
    const rows = [line({ plant: "WEST" })];
    expect(run(policies, snapshot(), rows).decisions[0].route).toBe("SPOT_PO");
    expect(amendmentImpact(amended, ["2026-04-01"]).warning).toBe(
      "Effective date is after all requirement dates",
    );
    policies.selection.mode = "currently_active";
    expect(run(policies, snapshot(), rows).decisions[0].route).toBe("RFP");
    policies.selection.execution_date = "2026-04-10";
    expect(run(policies, snapshot(), rows).decisions[0].route).toBe("SPOT_PO");
    policies.selection.mode = "explicit_version";
    policies.selection.version = "demo-2";
    expect(run(policies, snapshot(), rows).decisions[0].route).toBe("RFP");
  });
  it("keeps group policy anchored to first line across effective dates", () => {
    const policies = bundle();
    const amended = fixturePolicy();
    amended.version = "demo-2";
    amended.effective_date = "2026-04-02";
    amended.parameters.club_days = 0;
    policies.versions.push(amended);
    const result = run(policies, snapshot(), [
      line(),
      line({ pr_no: "P2", created_at: "2026-04-03 10:00" }),
    ]);
    expect(result.requirements).toHaveLength(1);
    expect(result.decisions[1].policy_version).toBe("demo-1");
  });
  it("missing values cannot accidentally satisfy monetary comparisons", () => {
    expect(
      evaluate(
        { op: "lt", left: { fact: "value" }, right: "100" },
        { value: null },
        fixturePolicy(),
      ),
    ).toBe(false);
  });
  it("compares money equality numerically", () => {
    expect(
      evaluate(
        { op: "eq", left: { fact: "value" }, right: "20.00" },
        { value: "20" },
        fixturePolicy(),
      ),
    ).toBe(true);
  });
  it("rejects comparisons of text with money", () => {
    const policy = fixturePolicy();
    policy.rules[0].when = { op: "gt", left: { fact: "plant" }, right: "100" };
    expect(() => policySchema.parse(policy)).toThrow("numeric");
  });
  it("rejects incompatible action decisions and routes", () => {
    const policy = fixturePolicy();
    policy.rules[0].action.route = "CONTRACT_PO";
    expect(() => policySchema.parse(policy)).toThrow("Decision and route");
  });
});

it("exports preferred suppliers before any policy effective date", () => {
  expect(fixturePolicy().effective_date > "2023-01-01").toBe(true);
  expect(preferredExport(snapshot(), "2023-01-01")).toEqual([]);
});

it("identifies the input row and invalid date field", () => {
  const rows = run(bundle(), snapshot(), [line({created_at:"bad"}), line({pr_no:"P2",need_by_date:"2026-99-99"})]).decisions;
  expect(rows[0].reason).toContain("Input row 2 (" + line().pr_no + "/1): Invalid created_at");
  expect(rows[1].reason).toContain("Input row 3 (P2/1): Invalid need_by_date");
});
