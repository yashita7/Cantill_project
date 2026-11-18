# Implementation decisions

## Deterministic execution

The engine receives approved policy JSON, a data snapshot, and PR lines. It uses
no I/O, database, network calls, or current time. A caller explicitly supplies the
execution date and policy-selection mode. Every run copies its starting contract
consumption into a separate ledger. Proposed awards in a batch do not become
purchase history for other requirements in that batch.

Requirement IDs and PO IDs are sequential after deterministic chronological
sorting. Identical reruns produce identical IDs. Different batches or different
grouping policies may produce different IDs. The database will associate these
identifiers with a run ID when persistence is implemented.

## Money

Prices and quantities enter as decimal strings. Valuation and consumption use
decimal.js with 40-digit precision and half-up rounding for two-decimal output.
Supplier ranking uses numeric scores because those scores are dimensionless.
Requirement valuation and the selected supplier's purchase price are recorded
separately. Historical valuation uses the latest eligible-dated purchase even
when that historical supplier is currently blocked. Awards and suggestions use
eligible Active suppliers under the supplied policy.

## Date boundaries

All PR timestamps are interpreted in Asia/Kolkata using Luxon. Creation dates
govern contracts, history, and effective-policy selection.

| Boundary                    | Convention                                                              |
| --------------------------- | ----------------------------------------------------------------------- |
| Historical window of N days | Lower date inclusive, requirement date excluded                         |
| Contract term               | Both start and end dates inclusive                                      |
| Clubbing creation window    | Calendar-date difference at most the configured days                    |
| Need-by window              | Absolute difference from the first line at most the configured days     |
| PO consolidation            | Elapsed time from first requirement at most the configured hours        |
| Contract ceiling            | Existing consumption plus contract-valued requirement may equal ceiling |

Clubbing uses the earliest eligible group's first line as its anchor. It never
chains through the most recently added line. Creation ties are ordered by PR
number and numeric line number. A group retains the first line's effective
policy and grouping parameters when later lines cross an amendment date.
Consolidation likewise retains the first requirement's configured time window.

## Policy interpretation and replay

Policy rules contain a clause, a condition tree, and an action. The interpreter
supports `all`, `any`, `not`, equality/inequality, numeric comparisons,
membership, and existence. Facts include plant, category, item type, value,
urgency, contract availability, history eligibility, preferred availability,
quantity, and new-item status. New combinations of supported facts require only
JSON changes. Introducing an entirely new external fact source would require
implementation work.

`requirement_date` is the default mode. `currently_active` selects the approved
version effective on the explicit execution date. `explicit_version` pins an
approved version, including a future-effective version, for replay. Contract and
history dates remain the requirement dates in all three modes. Every run records
the mode and versions. The engine never changes modes automatically.

The amendment-impact helper reports when the effective date is after all supplied
requirement dates. The planned policy UI will show this warning before approval
and preserve the selected mode. Candidate choices during the blind test must be
recorded in the permitted submission notes/process before the code freeze or in
the output reasons/run metadata afterward. The deadline permits only the three
submission CSVs to be committed after the freeze, so `DECISIONS.md` itself must
remain frozen then.

## Matching and incomplete input

Supplied item codes take precedence, with unit validation. Description matching
normalizes case, punctuation, and supported abbreviations. Numeric tokens,
ordered dimension tuples, grades, bearing/electrical suffixes, and measurement
units must agree before a candidate can be accepted. Token and bigram similarity
provide deterministic matching with a minimum separation between candidates.
The confidence is a similarity score and is not a calibrated probability.

Ambiguous descriptions, unknown supplied codes, and conflicting units require
review. A clearly distinct specification is a new item. Batch matching never
uses an LLM. New items remain separate requirements and receive no suppliers.
An absent or invalid new-item estimate leaves the value blank while the sourcing
route is preserved.

Nonpositive/invalid quantities, unknown plants, invalid dates, unresolved
matches, and duplicate PR identities receive `NOT_PROCESSED`. All duplicate
identities within a batch are held for review. Distinct PR identities remain
distinct demand and can be clubbed. Missing required CSV columns are a file-level
validation error. An input file with valid columns retains every row in output.

## Supplier ranking

Eligible suppliers have Active status and either item history in the configured
window or a contract for the item that has already started. Expired contracts
still establish eligibility. Future contracts do not. Purchase frequency counts
distinct PO numbers.

The ranking combines purchase frequency, recency, contract history, on-time
delivery and quality. The weights and recency boundaries are policy parameters. Ties use latest
purchase date, then supplier ID. The three supplied ranking examples pass with
these weights. No weight adjustment was needed.

Reference price is the latest supplier/item PO in the preferred-history window,
otherwise the most recently started contract's rate. Equal history dates use
descending natural PO-number order. Equal contract starts use ascending contract
ID. The complete preferred list is recomputed as of each requirement date.

Sourcing suggestions start with that list and add other eligible category
suppliers ordered by the sum of normalized delivery and quality ratings, with
supplier ID breaking ties. If too few eligible suppliers exist, return the
available suppliers. Preferred exports contain up to three eligible suppliers
per item and omit items with an empty list.

## Contracts

Starting consumed values come from the imported baseline. PDF-only contracts
signed after that baseline start at zero. The lowest-rate applicable contract
with sufficient ceiling is chosen. Equal rates use ascending contract ID.
The ceiling is shared across all items in a contract and consumed in requirement
chronology. Only requirements actually assigned a contract PO consume ceiling.
If all applicable contracts lack ceiling, the lowest applicable rate still
values the requirement. Capex routing takes precedence over contract awards.

## Demonstration identity and infrastructure

The planned role switcher records the self-declared actor and role with each
action. Overrides require a comment and preserve original decisions. The stack
uses Fastify, Drizzle with PostgreSQL numeric strings, React/Vite, Zod, and the
official Gemini TypeScript SDK. Supabase supplies plain PostgreSQL. Persistence
and application screens are the next milestone.
