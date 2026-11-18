import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("cancels database reset without the exact confirmation word", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/reset-db.ts"],
    {
      input: "NO\n",
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgres://invalid" },
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Cancelled. No data was deleted.");
  expect(result.stderr).toBe("");
});

it("marks today and past dates as immediately effective", async () => {
  const { effectiveDateNotice } = await import("./policies.js");
  expect(effectiveDateNotice("2026-11-18", "2026-11-18").immediate).toBe(true);
  expect(effectiveDateNotice("2026-11-17", "2026-11-18").immediate).toBe(true);
  expect(effectiveDateNotice("2026-11-19", "2026-11-18").immediate).toBe(false);
});

it("does not reveal the database URL when a confirmed reset cannot connect", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/reset-db.ts"],
    {
      input: "RESET\n",
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://synthetic:do-not-print@127.0.0.1:1/demo",
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Reset failed");
  expect(result.stdout + result.stderr).not.toContain("do-not-print");
});
