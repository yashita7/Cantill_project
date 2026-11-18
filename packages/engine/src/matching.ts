import type { Item, Match } from "./model.js";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[×✕]/g, "x")
    .replace(/"/g, " inch ")
    .replace(/\b(for maintenance|as per sample|urgent|repeat)\b/g, " ")
    .replace(/\bbrg\b/g, "bearing")
    .replace(/\bpneu\b/g, "pneumatic")
    .replace(/\bhyd\b/g, "hydraulic")
    .replace(/\bwelding rod\b/g, "welding electrode")
    .replace(/\s*x\s*(?=\d)/g, "x")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return text.match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
}

function specifications(text: string) {
  return {
    numbers: tokens(text)
      .filter((t) => /^\d/.test(t))
      .sort()
      .join("|"),
    dimensions: (text.match(/\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)+/g) ?? [])
      .sort()
      .join("|"),
    suffixes: (text.match(/\b(?:2rs|zz|rs|pnp|npn)\b/g) ?? []).sort().join("|"),
    grade:
      text.match(/\b(?:gr|grade)\s*([a-z]*\d+(?:\.\d+)?[a-z]*)\b/)?.[1] ?? "",
    units: [
      ...text.matchAll(
        /\d\s*(mm|cm|inch|sqmm|micron|gsm|ltr|lph|kg|kw|hp|psi|bar|ton|ml|ft|w|v|a)\b/g,
      ),
    ]
      .map((match) => match[1])
      .sort()
      .join("|"),
  };
}

function similarity(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const intersection = [...left].filter((t) => right.has(t)).length;
  return intersection / new Set([...left, ...right]).size;
}

function fuzzyScore(a: string, b: string): number {
  const left = new Set(
    Array.from({ length: Math.max(0, a.length - 1) }, (_, i) =>
      a.slice(i, i + 2),
    ),
  );
  const right = new Set(
    Array.from({ length: Math.max(0, b.length - 1) }, (_, i) =>
      b.slice(i, i + 2),
    ),
  );
  if (!left.size || !right.size) return 0;
  return (
    (2 * [...left].filter((t) => right.has(t)).length) /
    (left.size + right.size)
  );
}

export function matchItem(
  description: string,
  uom: string,
  code: string,
  items: Item[],
): Match {
  if (code) {
    const item = items.find((i) => i.item_code === code);
    if (!item)
      return {
        status: "AMBIGUOUS",
        item_code: null,
        confidence: 0,
        reason: "Unknown supplied item code",
        candidates: [],
      };
    if (item.uom.toUpperCase() !== uom.toUpperCase())
      return {
        status: "AMBIGUOUS",
        item_code: null,
        confidence: 0,
        reason: "Unit differs from the item master",
        candidates: [code],
      };
    return {
      status: "MATCHED",
      item_code: code,
      confidence: 1,
      reason: "Supplied item code",
      candidates: [code],
    };
  }
  const query = normalize(description);
  if (!query)
    return {
      status: "AMBIGUOUS",
      item_code: null,
      confidence: 0,
      reason: "Description is missing",
      candidates: [],
    };
  const queryTokens = tokens(query);
  const spec = specifications(query);
  const candidates = items.map((item) => {
    const candidate = normalize(item.description);
    const candidateTokens = tokens(candidate);
    const candidateSpec = specifications(candidate);
    const compatible =
      item.uom.toUpperCase() === uom.toUpperCase() &&
      spec.numbers === candidateSpec.numbers &&
      spec.dimensions === candidateSpec.dimensions &&
      spec.suffixes === candidateSpec.suffixes &&
      spec.grade === candidateSpec.grade &&
      spec.units === candidateSpec.units;
    const exact =
      [...queryTokens].sort().join("|") ===
      [...candidateTokens].sort().join("|");
    const tokenScore = similarity(queryTokens, candidateTokens);
    const fuzzy = fuzzyScore(
      [...queryTokens].sort().join(" "),
      [...candidateTokens].sort().join(" "),
    );
    return {
      item,
      compatible,
      exact,
      tokenScore,
      fuzzy,
      score: exact ? 1 : Math.max(tokenScore, fuzzy),
    };
  });
  const eligible = candidates
    .filter(
      (c) =>
        c.compatible && (c.exact || c.tokenScore >= 0.75 || c.fuzzy >= 0.9),
    )
    .sort(
      (a, b) =>
        b.score - a.score || a.item.item_code.localeCompare(b.item.item_code),
    );
  if (
    eligible.length &&
    (eligible.length === 1 || eligible[0].score - eligible[1].score >= 0.1)
  ) {
    const winner = eligible[0];
    return {
      status: "MATCHED",
      item_code: winner.item.item_code,
      confidence: winner.score,
      reason: winner.exact
        ? "Unique normalized match with compatible specifications and unit"
        : "Unique compatible token/fuzzy match; specifications and unit agree",
      candidates: eligible.map((c) => c.item.item_code),
    };
  }
  if (eligible.length)
    return {
      status: "AMBIGUOUS",
      item_code: null,
      confidence: eligible[0].score,
      reason: "Multiple compatible candidates need review",
      candidates: eligible.map((c) => c.item.item_code),
    };
  // An underspecified known product needs clarification. Conflicting complete specifications are new demand.
  const incomplete = candidates.filter((c) => {
    const candidate = specifications(normalize(c.item.description));
    const queryWords = queryTokens.filter((t) => !/^\d/.test(t));
    const masterWords = tokens(normalize(c.item.description)).filter(
      (t) => !/^\d/.test(t),
    );
    const wordsAreSubset =
      queryWords.length > 0 &&
      queryWords.every((word) => masterWords.includes(word));
    return (
      (similarity(queryWords, masterWords) >= 0.6 || wordsAreSubset) &&
      ((!spec.numbers && !!candidate.numbers) ||
        (spec.numbers === candidate.numbers &&
          !spec.suffixes &&
          !!candidate.suffixes) ||
        c.item.uom.toUpperCase() !== uom.toUpperCase())
    );
  });
  if (incomplete.length)
    return {
      status: "AMBIGUOUS",
      item_code: null,
      confidence: 0,
      reason: "Specifications or unit need clarification",
      candidates: incomplete.map((c) => c.item.item_code),
    };
  return {
    status: "NEW",
    item_code: null,
    confidence: 0,
    reason: "No compatible item in the master",
    candidates: [],
  };
}
