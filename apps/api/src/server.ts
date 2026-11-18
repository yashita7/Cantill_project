import { loadEnvFile } from "node:process";
try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
import { database, initialize } from "./db.js";
import { buildApp } from "./app.js";
import { geminiChat } from "./chat.js";
import { geminiExtractor } from "./policies.js";
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("Set DATABASE_URL to your Postgres connection string");
const connection = database(url);
await initialize(connection.db);
const { GEMINI_API_KEY, GEMINI_MODEL } = process.env;
const extract =
  GEMINI_API_KEY && GEMINI_MODEL
    ? geminiExtractor(GEMINI_API_KEY, GEMINI_MODEL)
    : undefined;
const app = buildApp(
  connection.db,
  extract,
  process.env.SETUP_TOKEN,
  GEMINI_API_KEY && GEMINI_MODEL
    ? geminiChat(GEMINI_API_KEY, GEMINI_MODEL)
    : undefined,
);
app.addHook("onClose", () => connection.close());
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
