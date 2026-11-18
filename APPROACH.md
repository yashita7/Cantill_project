# Approach and AI disclosure

OpenAI Codex assisted with kit analysis, implementation planning, TypeScript
code, test construction, and debugging. The candidate must review and understand
the implementation before submission and the live-change interview.

The implemented engine is a synchronous pure TypeScript package. Its policy
interpreter, matching, ranking, grouping, valuation, routing, and consolidation
execute locally. The batch CLI uses the engine without any AI calls.

Zod validates policy bundles and imported records. decimal.js handles prices and
quantities. Luxon interprets explicit IST dates. Vitest runs public synthetic
tests and a separate ignored suite against the provided private kit.

The planned app uses Gemini's official `@google/genai` SDK for chat interpretation
and policy-document extraction. Structured responses will be validated with
Zod. Chat follows an explicit state machine with candidate validation and user
confirmation before PR creation. Procurement reviews extracted policy changes
and can edit validated JSON when extraction fails or quota is exhausted.

The application will use straightforward API handlers and state transitions.
RAG, LangGraph, and agent frameworks are outside this implementation.

No application LLM integration has been implemented in the engine milestone.
The private verification fixtures include manually transcribed PDF-only contract
terms, checked against the supplied signed documents. Supplied datasets and
derived private expectations are excluded from the public source tree.
