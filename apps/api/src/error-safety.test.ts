import { expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { buildApp } from "./app.js";
import { schemaSql, type Database } from "./db.js";
import {
  snapshot,
  fixturePolicy,
} from "../../../packages/engine/test/fixtures.js";

it("redacts database and unexpected errors globally while retaining known errors", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const app = buildApp(drizzle(pg) as unknown as Database);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const secret = "SENSITIVE_PURCHASE_PARAMETER";
  app.get("/test-db-error", async () => {
    throw new DrizzleQueryError(
      "select private_sql",
      [secret],
      new Error(secret),
    );
  });
  app.get("/test-internal-error", async () => {
    throw new Error(secret);
  });
  app.get("/test-known-error", async () => {
    throw new Error("Chat not found");
  });
  try {
    for (const path of ["/test-db-error", "/test-internal-error"]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain("private_sql");
      expect(response.json().requestId).toBeTruthy();
    }
    const known = await app.inject({ method: "GET", url: "/test-known-error" });
    expect(known.statusCode).toBe(422);
    expect(known.json().error).toBe("Chat not found");
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain("private_sql");
    expect(logs).toContain("database");
    expect(logs).toContain("internal");
  } finally {
    log.mockRestore();
    await app.close();
    await pg.close();
  }
}, 20000);

it("returns actionable policy field and CSV row validation without echoing input", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const app = buildApp(drizzle(pg) as unknown as Database, undefined, "token");
  try {
    const { approval: _approval, ...draft } = fixturePolicy();
    const invalid = {
      ...draft,
      parameters: {
        ...draft.parameters,
        club_days: "SENSITIVE_PURCHASE_PARAMETER",
      },
    };
    const policy = await app.inject({
      method: "POST",
      url: "/api/policies/review",
      payload: { draft: invalid },
    });
    expect(policy.statusCode).toBe(400);
    expect(policy.json().details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["parameters", "club_days"],
          message: "Required or incorrect type",
        }),
      ]),
    );
    expect(policy.body).not.toContain("SENSITIVE_PURCHASE_PARAMETER");
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: {
        actor: { name: "Test", role: "Procurement" },
        snapshot: snapshot(),
      },
    });
    const batch = await app.inject({
      method: "POST",
      url: "/api/process-batch",
      payload: {
        actor: { name: "Test", role: "Requester" },
        snapshotId: imported.json().id,
        csv: "pr_no,pr_line\nPRIVATE_VALUE,1",
        selection: { mode: "currently_active", execution_date: "2026-11-01" },
      },
    });
    expect(batch.statusCode).toBe(422);
    expect(batch.json().error).toContain("CSV row 2");
    expect(batch.json().error).toContain("created_at");
    expect(batch.body).not.toContain("PRIVATE_VALUE");
    const malformed = await app.inject({
      method: "POST",
      url: "/api/process-batch",
      payload: {
        actor: { name: "Test", role: "Requester" },
        snapshotId: imported.json().id,
        csv: "pr_no,pr_line\nPRIVATE_VALUE,1,extra",
        selection: { mode: "currently_active", execution_date: "2026-11-01" },
      },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().error).toContain("CSV row 2");
    expect(malformed.body).not.toContain("PRIVATE_VALUE");
  } finally {
    await app.close();
    await pg.close();
  }
}, 20000);

it("redacts chat transaction failures", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const db = drizzle(pg) as unknown as Database;
  const app = buildApp(db, undefined, "token", async () => ({ quantity: "2" }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: {
        actor: { name: "Test", role: "Procurement" },
        snapshot: snapshot(),
      },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Test", snapshotId: imported.json().id },
    });
    vi.spyOn(db, "transaction").mockRejectedValueOnce(
      new DrizzleQueryError(
        "private_sql",
        ["SENSITIVE_PURCHASE_PARAMETER"],
        new Error("secret"),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/" + started.json().id,
      payload: { revision: 0, message: "two" },
    });
    expect(response.statusCode).toBe(500);
    for (const value of [
      "private_sql",
      "SENSITIVE_PURCHASE_PARAMETER",
      "secret",
    ]) {
      expect(response.body).not.toContain(value);
      expect(JSON.stringify(log.mock.calls)).not.toContain(value);
    }
    const confirm = await app.inject({
      method: "POST",
      url: "/api/chat/" + started.json().id,
      payload: { revision: 0, confirm: true },
    });
    expect(confirm.statusCode).toBe(409);
  } finally {
    log.mockRestore();
    await app.close();
    await pg.close();
  }
}, 20000);
