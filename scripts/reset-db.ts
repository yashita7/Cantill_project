import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnvFile } from "node:process";
import { Pool } from "pg";

async function main() {
  const prompt = createInterface({ input: stdin, output: stdout });
  let answer: string;
  try {
    console.log(
      "This deletes all app snapshots, policies, PRs, runs, orders and audit records in the configured database.",
    );
    answer = await prompt.question(
      "Type RESET to permanently erase the application data: ",
    );
  } finally {
    prompt.close();
  }
  if (answer !== "RESET") {
    console.log("Cancelled. No data was deleted.");
    return;
  }
  try {
    try {
      loadEnvFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!process.env.DATABASE_URL) throw new Error("missing configuration");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
    });
    try {
      // The application currently owns one table in the procurement schema.
      await pool.query("DROP TABLE IF EXISTS procurement.records");
      console.log(
        "Application data deleted. Restart the app to create an empty table.",
      );
    } finally {
      await pool.end();
    }
  } catch {
    console.error(
      "Reset failed. Check the database connection and permissions.",
    );
    process.exitCode = 1;
  }
}
main().catch(() => {
  console.error("Reset cancelled or failed.");
  process.exitCode = 1;
});
