import { Decimal } from "decimal.js";
import { calendarDays, inHistory, date } from "./dates.js";
import type { Item, PreferredSupplier, Snapshot } from "./model.js";
import type { Policy } from "./policy.js";

export function latestHistory(
  snapshot: Snapshot,
  itemCode: string,
  asOf: string,
  days: number,
  supplierId?: string,
) {
  return snapshot.history
    .filter(
      (h) =>
        h.item_code === itemCode &&
        (!supplierId || h.supplier_id === supplierId) &&
        inHistory(h.po_date, asOf, days),
    )
    .sort(
      (a, b) =>
        b.po_date.localeCompare(a.po_date) ||
        b.po_number.localeCompare(a.po_number, "en", { numeric: true }),
    );
}

export function preferredSuppliers(
  policy: Pick<Policy, "parameters">,
  snapshot: Snapshot,
  itemCode: string,
  asOf: string,
): PreferredSupplier[] {
  date(asOf);
  const params = policy.parameters;
  const candidates = snapshot.suppliers
    .filter((s) => params.active_statuses.includes(s.status))
    .map((supplier) => {
      const history = latestHistory(
        snapshot,
        itemCode,
        asOf,
        params.preferred_days,
        supplier.supplier_id,
      );
      const contracts = snapshot.contracts
        .filter(
          (c) =>
            c.supplier_id === supplier.supplier_id &&
            c.start_date <= asOf &&
            c.lines.some((l) => l.item_code === itemCode),
        )
        .sort(
          (a, b) =>
            b.start_date.localeCompare(a.start_date) ||
            a.contract_id.localeCompare(b.contract_id),
        );
      return { supplier, history, contracts };
    })
    .filter((c) => c.history.length || c.contracts.length);
  const maxFrequency = Math.max(
    1,
    ...candidates.map((c) => new Set(c.history.map((h) => h.po_number)).size),
  );
  const weights = params.ranking;
  const ranked = candidates
    .map((c) => {
      const last = c.history[0];
      const age = last ? calendarDays(last.po_date, asOf) : Infinity;
      const recency =
        age <= weights.recent_days
          ? 1
          : age <= weights.older_days
            ? weights.older_score
            : 0;
      const components = {
        frequency:
          (new Set(c.history.map((h) => h.po_number)).size / maxFrequency) *
          weights.frequency,
        recency: recency * weights.recency,
        contract: Number(c.contracts.length > 0) * weights.contract,
        delivery: (c.supplier.on_time_pct / 100) * weights.delivery,
        quality: (c.supplier.quality_rating / 5) * weights.quality,
      };
      const contractLine = c.contracts[0]?.lines.find(
        (l) => l.item_code === itemCode,
      );
      return {
        item_code: itemCode,
        rank: 0,
        supplier_id: c.supplier.supplier_id,
        reference_price: new Decimal(
          last?.unit_price ?? contractLine!.rate,
        ).toFixed(2),
        reference_source: last
          ? `PO ${last.po_number}`
          : `contract ${c.contracts[0].contract_id}`,
        score: Object.values(components).reduce((sum, v) => sum + v, 0),
        components,
        last_date: last?.po_date ?? "",
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.last_date.localeCompare(a.last_date) ||
        a.supplier_id.localeCompare(b.supplier_id),
    );
  return ranked.map(({ last_date, ...row }, index) => ({
    ...row,
    rank: index + 1,
  }));
}

export function suggestedSuppliers(
  policy: Policy,
  snapshot: Snapshot,
  item: Item,
  preferred: PreferredSupplier[],
  count: number,
): string[] {
  const first = preferred.map((p) => p.supplier_id);
  const additional = snapshot.suppliers
    .filter(
      (s) =>
        policy.parameters.active_statuses.includes(s.status) &&
        s.categories.includes(item.category) &&
        !first.includes(s.supplier_id),
    )
    .sort(
      (a, b) =>
        b.on_time_pct / 100 +
          b.quality_rating / 5 -
          (a.on_time_pct / 100 + a.quality_rating / 5) ||
        a.supplier_id.localeCompare(b.supplier_id),
    );
  return [...first, ...additional.map((s) => s.supplier_id)].slice(0, count);
}

// Standalone export convention: fixed ranking parameters, independent of policy effective dates.
export function preferredExport(snapshot: Snapshot, asOf: string): PreferredSupplier[] {
  const parameters = { preferred_days: 548, active_statuses: ["Active"], ranking: { frequency: 40, recency: 25, contract: 15, delivery: 10, quality: 10, recent_days: 90, older_days: 365, older_score: 0.5 } };
  return snapshot.items.flatMap(item => preferredSuppliers({ parameters } as Pick<Policy, "parameters">, snapshot, item.item_code, asOf).slice(0, 3));
}
