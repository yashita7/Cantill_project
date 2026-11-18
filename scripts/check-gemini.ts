import { loadEnvFile } from "node:process";
import { fixturePolicy } from "../packages/engine/test/fixtures.js";
import { geminiExtractor, parseDraft } from "../apps/api/src/policies.js";

try {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { GEMINI_API_KEY, GEMINI_MODEL } = process.env;
  if (!GEMINI_API_KEY || !GEMINI_MODEL)
    throw new Error("Set GEMINI_API_KEY and GEMINI_MODEL");
  const { approval: _approval, ...baseline } = fixturePolicy();
  const result = await geminiExtractor(GEMINI_API_KEY, GEMINI_MODEL)(
    {
      kind: "text",
      text: "Amend the synthetic policy to version demo-2 effective 2026-04-02. Set the spot limit to 100000.",
    },
    baseline,
  );
  const draft = parseDraft(result);
  if (
    draft.version !== "demo-2" ||
    draft.effective_date !== "2026-04-02" ||
    draft.parameters.limits.spot !== "100000"
  )
    throw new Error("Extraction did not apply the requested amendment");
  console.log("Gemini extraction: PASS");
} catch {
  console.error(
    "Gemini extraction: FAIL. Check configuration or retry after quota resets.",
  );
  process.exitCode = 1;
}
