import { Decimal } from "decimal.js";
import { date, timestamp, calendarDays, inHistory } from "./dates.js";
import { matchItem } from "./matching.js";
import {
  snapshotSchema,
  prSchema,
  type BatchResult,
  type DecisionRow,
  type Requirement,
  type Snapshot,
  type PrLine,
} from "./model.js";
import {
  evaluate,
  policyBundleSchema,
  selectPolicy,
  type Policy,
  type PolicyBundle,
} from "./policy.js";
import {
  latestHistory,
  preferredSuppliers,
  suggestedSuppliers,
} from "./suppliers.js";

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

function emptyRow(line: PrLine, reason: string): DecisionRow {
  return {
    pr_no: line.pr_no,
    pr_line: line.pr_line,
    resolved_item_code: "",
    group_id: "",
    po_id: "",
    decision: "",
    route: "NOT_PROCESSED",
    supplier_id: "",
    unit_price: "",
    group_value_inr: "",
    suggested_supplier_ids: "",
    policy_version: "",
    reason,
  };
}

function validateSnapshot(snapshot: Snapshot) {
  date(snapshot.as_of);
  for (const [label, keys] of [
    ["item", snapshot.items.map((i) => i.item_code)],
    ["supplier", snapshot.suppliers.map((s) => s.supplier_id)],
    ["contract", snapshot.contracts.map((c) => c.contract_id)],
    ["plant", snapshot.plants],
  ] as const)
    if (new Set(keys).size !== keys.length)
      throw new Error(`Duplicate ${label} key in snapshot`);
  const itemCodes = new Set(snapshot.items.map((i) => i.item_code));
  const supplierIds = new Set(snapshot.suppliers.map((s) => s.supplier_id));
  for (const contract of snapshot.contracts) {
    date(contract.start_date);
    date(contract.end_date);
    if (contract.start_date > contract.end_date)
      throw new Error(`Invalid contract term: ${contract.contract_id}`);
    if (!supplierIds.has(contract.supplier_id))
      throw new Error(`Unknown contract supplier: ${contract.contract_id}`);
    if (
      new Set(contract.lines.map((l) => l.item_code)).size !==
      contract.lines.length
    )
      throw new Error(`Duplicate contract item: ${contract.contract_id}`);
    for (const line of contract.lines) {
      const item = snapshot.items.find((i) => i.item_code === line.item_code);
      if (!item || item.uom !== line.uom)
        throw new Error(`Invalid contract item/unit: ${contract.contract_id}`);
    }
  }
  for (const po of snapshot.history) {
    date(po.po_date);
    if (!itemCodes.has(po.item_code) || !supplierIds.has(po.supplier_id))
      throw new Error(`Invalid history reference: ${po.po_number}`);
  }
}

function rowError(
  line: PrLine,
  snapshot: Snapshot,
  duplicate: boolean,
): string | null {
  if (!line.pr_no || !/^\d+$/.test(line.pr_line))
    return "PR identity is missing or invalid";
  if (duplicate)
    return "Duplicate PR number and line in this batch; review both rows";
  if (!/^\d+(?:\.\d+)?$/.test(line.quantity) || !new Money(line.quantity).gt(0))
    return "Quantity must be positive";
  if (!snapshot.plants.includes(line.plant))
    return `Unknown plant ${line.plant}`;
  try {
    timestamp(line.created_at);
  } catch {
    return `Invalid created_at "${line.created_at}": expected YYYY-MM-DD HH:mm[:ss[.SSS]] in IST`;
  }
  try {
    date(line.need_by_date);
  } catch {
    return `Invalid need_by_date "${line.need_by_date}": expected YYYY-MM-DD`;
  }
  if (!line.urgency) return "Urgency is missing";
  return null;
}

function decide(
  requirement: Requirement,
  policy: Policy,
  snapshot: Snapshot,
  consumed: Map<string, Decimal>,
): DecisionRow {
  const item = requirement.item;
  const asOf = requirement.first.created_at.slice(0, 10);
  const quantity = new Money(requirement.quantity);
  const active = new Set(
    snapshot.suppliers
      .filter((s) => policy.parameters.active_statuses.includes(s.status))
      .map((s) => s.supplier_id),
  );
  const applicable = snapshot.contracts
    .filter(
      (c) =>
        item &&
        active.has(c.supplier_id) &&
        c.start_date <= asOf &&
        c.end_date >= asOf &&
        c.lines.some((l) => l.item_code === item.item_code),
    )
    .map((contract) => ({
      contract,
      rate: contract.lines.find((l) => l.item_code === item!.item_code)!.rate,
    }))
    .sort(
      (a, b) =>
        new Money(a.rate).comparedTo(b.rate) ||
        a.contract.contract_id.localeCompare(b.contract.contract_id),
    );
  const selected = applicable.find((c) =>
    consumed
      .get(c.contract.contract_id)!
      .plus(quantity.times(c.rate))
      .lte(c.contract.value_cap),
  );
  const history = item
    ? latestHistory(
        snapshot,
        item.item_code,
        asOf,
        policy.parameters.history_days,
      )
    : [];
  const preferred = item
    ? preferredSuppliers(policy, snapshot, item.item_code, asOf)
    : [];
  let valuationPrice: string | null = null;
  let valuationSource = "";
  if (!item) {
    const estimate = requirement.first.estimated_unit_price;
    if (/^\d+(?:\.\d+)?$/.test(estimate)) {
      valuationPrice = estimate;
      valuationSource = "requester estimate";
    }
  } else {
    for (const source of policy.parameters.valuation_sources) {
      if (source === "contract" && applicable.length) {
        const valuationContract = selected ?? applicable[0];
        valuationPrice = valuationContract.rate;
        valuationSource = `contract ${valuationContract.contract.contract_id}`;
      }
      if (source === "history" && history.length) {
        valuationPrice = history[0].unit_price;
        valuationSource = `PO ${history[0].po_number}`;
      }
      if (source === "standard") {
        valuationPrice = item.standard_price;
        valuationSource = "item standard price";
      }
      if (valuationPrice !== null) break;
    }
  }
  const value = valuationPrice === null ? null : quantity.times(valuationPrice);
  const facts = {
    item_type: item?.item_type ?? null,
    category: item?.category ?? null,
    plant: requirement.first.plant,
    value: value?.toString() ?? null,
    emergency: requirement.emergency,
    is_new: item === null,
    contract_available: !!selected,
    has_recent_active_history: history.some((h) => active.has(h.supplier_id)),
    preferred_available: preferred.length > 0,
    quantity: requirement.quantity,
  };
  const rule = policy.rules.find((r) => evaluate(r.when, facts, policy));
  const base = {
    ...emptyRow(requirement.first, ""),
    resolved_item_code: item?.item_code ?? "NEW",
    group_id: requirement.group_id,
    policy_version: policy.version,
    group_value_inr: value?.toFixed(2) ?? "",
  };
  if (!rule)
    return {
      ...base,
      reason: `Policy ${policy.version}: no rule matched; review required`,
    };
  let supplier = "";
  let price = "";
  let awardSource = "";
  if (rule.action.supplier === "contract") {
    if (!selected)
      return {
        ...base,
        reason: "Rule requires a usable contract; review required",
      };
    supplier = selected.contract.supplier_id;
    price = new Money(selected.rate).toFixed(2);
    awardSource = `contract ${selected.contract.contract_id}`;
    consumed.set(
      selected.contract.contract_id,
      consumed
        .get(selected.contract.contract_id)!
        .plus(quantity.times(selected.rate)),
    );
  }
  if (rule.action.supplier === "preferred") {
    if (!preferred.length)
      return {
        ...base,
        reason: "Rule requires a preferred supplier; review required",
      };
    supplier = preferred[0].supplier_id;
    price = preferred[0].reference_price;
    awardSource = preferred[0].reference_source;
  }
  const suggestions =
    item && rule.action.decision === "SOURCING_REQUEST"
      ? suggestedSuppliers(
          policy,
          snapshot,
          item,
          preferred,
          rule.action.suggestions,
        )
      : [];
  const explanation = [
    `Policy ${policy.version}, clause ${rule.clause}`,
    `requirement date ${asOf}`,
    valuationSource
      ? `valued using ${valuationSource}`
      : "missing or invalid estimated price; value unavailable",
  ];
  if (applicable.length && !selected)
    explanation.push("all applicable contracts lack sufficient ceiling");
  if (awardSource) explanation.push(`award using ${awardSource}`);
  if (rule.action.note) explanation.push(rule.action.note);
  return {
    ...base,
    decision: rule.action.decision,
    route: rule.action.route,
    supplier_id: supplier,
    unit_price: price,
    suggested_supplier_ids: suggestions.join(";"),
    reason: explanation.join("; "),
  };
}

export function process(
  policyJson: unknown,
  dataSnapshot: unknown,
  prLines: unknown,
): BatchResult {
  const bundle = policyBundleSchema.parse(policyJson);
  date(bundle.selection.execution_date);
  const snapshot = snapshotSchema.parse(dataSnapshot);
  validateSnapshot(snapshot);
  if (!Array.isArray(prLines)) throw new Error("PR lines must be an array");
  const lines = prLines.map((line) => prSchema.parse(line));
  const matches = lines.map((l) =>
    matchItem(l.description, l.uom, l.item_code, snapshot.items),
  );
  const keys = lines.map((l) => `${l.pr_no}\u0000${l.pr_line}`);
  const duplicateKeys = new Set(
    keys.filter((key, i) => keys.indexOf(key) !== i),
  );
  const decisions = lines.map((l) => emptyRow(l, ""));
  const eligible: number[] = [];
  lines.forEach((line, index) => {
    const error = rowError(line, snapshot, duplicateKeys.has(keys[index]));
    if (error) {
      decisions[index].reason = `Input row ${index + 2} (${line.pr_no}/${line.pr_line}): ${error}`;
      return;
    }
    if (matches[index].status === "AMBIGUOUS") {
      decisions[index].reason = matches[index].reason;
      return;
    }
    eligible.push(index);
  });
  eligible.sort(
    (a, b) =>
      lines[a].created_at.localeCompare(lines[b].created_at) ||
      lines[a].pr_no.localeCompare(lines[b].pr_no) ||
      new Money(lines[a].pr_line).comparedTo(lines[b].pr_line),
  );
  const requirements: Requirement[] = [];
  const groupPolicies = new Map<string, Policy>();
  for (const index of eligible) {
    const line = lines[index];
    const item =
      snapshot.items.find((i) => i.item_code === matches[index].item_code) ??
      null;
    const group = item
      ? requirements.find((g) => {
          const parameters = groupPolicies.get(g.group_id)!.parameters;
          return (
            g.item?.item_code === item.item_code &&
            g.first.plant === line.plant &&
            calendarDays(
              g.first.created_at.slice(0, 10),
              line.created_at.slice(0, 10),
            ) <= parameters.club_days &&
            Math.abs(calendarDays(g.first.need_by_date, line.need_by_date)) <=
              parameters.need_by_days
          );
        })
      : undefined;
    if (group) {
      group.indices.push(index);
      group.quantity = new Money(group.quantity).plus(line.quantity).toString();
      group.emergency ||= groupPolicies
        .get(group.group_id)!
        .parameters.emergency_labels.includes(line.urgency);
      continue;
    }
    const policy = selectPolicy(bundle, line.created_at.slice(0, 10));
    const id = `REQ-${String(requirements.length + 1).padStart(4, "0")}`;
    groupPolicies.set(id, policy);
    requirements.push({
      group_id: id,
      indices: [index],
      first: line,
      item,
      quantity: line.quantity,
      emergency: policy.parameters.emergency_labels.includes(line.urgency),
      policy_version: policy.version,
    });
  }
  const consumed = new Map(
    snapshot.contracts.map((c) => [c.contract_id, new Money(c.consumed_value)]),
  );
  const purchaseOrders: {
    id: string;
    supplier: string;
    plant: string;
    route: string;
    first: string;
    hours: number;
  }[] = [];
  for (const requirement of requirements) {
    const policy = groupPolicies.get(requirement.group_id)!;
    const decision = decide(requirement, policy, snapshot, consumed);
    if (decision.decision === "PO") {
      let po = purchaseOrders.find(
        (p) =>
          p.supplier === decision.supplier_id &&
          p.plant === requirement.first.plant &&
          p.route === decision.route &&
          timestamp(requirement.first.created_at).diff(
            timestamp(p.first),
            "hours",
          ).hours <= p.hours,
      );
      if (!po) {
        po = {
          id: `PO-${String(purchaseOrders.length + 1).padStart(4, "0")}`,
          supplier: decision.supplier_id,
          plant: requirement.first.plant,
          route: decision.route,
          first: requirement.first.created_at,
          hours: policy.parameters.consolidation_hours,
        };
        purchaseOrders.push(po);
      }
      decision.po_id = po.id;
    }
    requirement.decision = decision;
    for (const index of requirement.indices)
      decisions[index] = {
        ...decision,
        pr_no: lines[index].pr_no,
        pr_line: lines[index].pr_line,
      };
  }
  return {
    decisions,
    requirements,
    matches,
    contract_consumption: Object.fromEntries(
      [...consumed].map(([key, value]) => [key, value.toFixed(2)]),
    ),
    metadata: {
      snapshot_id: snapshot.snapshot_id,
      selection_mode: bundle.selection.mode,
      execution_date: bundle.selection.execution_date,
      policy_versions: [...new Set(requirements.map((r) => r.policy_version))],
    },
    warnings:
      bundle.selection.mode === "requirement_date"
        ? []
        : [
            `Policy applied in ${bundle.selection.mode} mode; requirement dates still govern contracts and history`,
          ],
  };
}
