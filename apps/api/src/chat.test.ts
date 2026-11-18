import { expect, it, vi } from "vitest";
import {
  advance,
  inspect,
  resolveDate,
  createLine,
  geminiChat,
  ChatError,
  type ChatDraft,
} from "./chat.js";
import { snapshot } from "../../../packages/engine/test/fixtures.js";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { buildApp } from "./app.js";
import { schemaSql, type Database } from "./db.js";
import { records } from "./db.js";
import { eq } from "drizzle-orm";
import { runInNewContext } from "node:vm";
import { chatPage } from "./chat-page.js";
const data = snapshot();
data.plants = ["PUN1", "CHK1"];
const today = "2026-11-17";
const complete: ChatDraft = {
  fields: {
    description: data.items[0].description,
    uom: "NOS",
    quantity: "2",
    plant: "PUN1",
    needBy: "2026-11-20",
    urgency: "Normal",
  },
};
it("accepts a complete request", () =>
  expect(inspect(complete, data, today).ready).toBe(true));
it("asks for missing quantity", () =>
  expect(
    inspect(
      { ...complete, fields: { ...complete.fields, quantity: undefined } },
      data,
      today,
    ).question,
  ).toContain("quantity"));
it("matches abbreviations", () => {
  const bearings = {
    ...data,
    items: [{ ...data.items[0], description: "Bearing 6205" }],
  };
  expect(
    inspect(
      { ...complete, fields: { ...complete.fields, description: "brg 6205" } },
      bearings,
      today,
    ).ready,
  ).toBe(true);
});
it("shows ambiguous candidates", () =>
  expect(
    inspect(
      {
        ...complete,
        fields: { ...complete.fields, description: "Steel panel" },
      },
      data,
      today,
    ).candidates.length,
  ).toBeGreaterThan(0));
it("asks for a new item description", () =>
  expect(
    inspect(
      {
        ...complete,
        fields: { ...complete.fields, description: "Laser" },
      },
      data,
      today,
    ).question,
  ).toContain("new item"));
it("rejects a wrong plant", () =>
  expect(
    inspect(
      { ...complete, fields: { ...complete.fields, plant: "PUN2" } },
      data,
      today,
    ).question,
  ).toContain("plant"));
it("rejects zero quantity", () =>
  expect(
    inspect(
      { ...complete, fields: { ...complete.fields, quantity: "0" } },
      data,
      today,
    ).question,
  ).toContain("greater than zero"));
it("resolves next Friday in IST", () =>
  expect(resolveDate("next Friday", today)).toBe("2026-11-20"));
it("applies a quantity correction before confirmation", () => {
  const draft = advance(complete, { quantity: "300" });
  expect(
    createLine(draft, data, today + " 10:00:00", "CHAT-1", "Employee").quantity,
  ).toBe("300");
});
it("keeps a draft when Gemini is down", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async () => {
      throw new ChatError("service_unavailable", 503);
    },
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const chat = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Employee", snapshotId: imported.json().id },
    });
    const failure = await app.inject({
      method: "POST",
      url: "/api/chat/" + chat.json().id,
      payload: { revision: 0, message: "make it 300" },
    });
    expect(failure.statusCode).toBe(503);
    expect(failure.json().retryable).toBe(true);
    expect(failure.json().draft).toEqual({ fields: {} });
  } finally {
    await app.close();
    await pg.close();
  }
}, 20000);

it("creates one stored PR and returns it on repeated confirmation", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const future = { ...complete.fields, needBy: "2099-01-01" };
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async () => future,
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Employee", snapshotId: imported.json().id },
    });
    const url = "/api/chat/" + started.json().id;
    const draft = await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "Complete request PUN1 normal" },
    });
    expect(draft.json().ready).toBe(true);
    const confirmed = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, confirm: true },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().createdPr.pr_line).toBe("1");
    const repeated = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, confirm: true },
    });
    expect(repeated.json().createdPr).toEqual(confirmed.json().createdPr);
  } finally {
    await app.close();
    await pg.close();
  }
}, 20000);

it("keeps prior answers when extraction returns empty fields", () => {
  const draft = advance(complete, {
    quantity: "3",
    plant: "",
    description: "",
    urgency: "",
  });
  expect(draft.fields.plant).toBe("PUN1");
  expect(draft.fields.description).toBe(complete.fields.description);
  expect(draft.fields.urgency).toBe("Normal");
  expect(draft.fields.quantity).toBe("3");
});

it.each([
  [404, "model_not_found", 1],
  [429, "rate_limit", 3],
  [503, "service_unavailable", 3],
] as const)(
  "classifies HTTP %s and retries only transient statuses",
  async (status, category, calls) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(
      async () =>
        new Response("{}", { status, headers: { "Retry-After": "2" } }),
    );
    const sleep = vi.fn(async (_ms: number) => {});
    try {
      const extract = geminiChat("test-key", "test-model", {
        fetch: request,
        sleep,
        random: () => 0,
      });
      await expect(
        extract("private request", { fields: {} }, { requestId: "test-id" }),
      ).rejects.toMatchObject({ category, upstreamStatus: status });
      expect(request).toHaveBeenCalledTimes(calls);
      if (calls > 1) expect(sleep).toHaveBeenCalledWith(2000);
      const diagnostics = log.mock.calls
        .map(([line]) => String(line))
        .join(" ");
      expect(diagnostics).toContain('"requestId":"test-id"');
      expect(diagnostics).not.toContain("test-key");
      expect(diagnostics).not.toContain("private request");
    } finally {
      log.mockRestore();
    }
  },
);

it.each([
  ["not json", "invalid_json"],
  ['{"quantity": 5}', "validation"],
] as const)(
  "rejects invalid structured output without retry",
  async (content, category) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: content }], role: "model" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await expect(
        geminiChat("key", "model", { fetch: request })("test", { fields: {} }),
      ).rejects.toMatchObject({ category });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  },
);

it("classifies timeouts and does not automatically retry them", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi.fn(async () => {
    throw new DOMException("expired", "TimeoutError");
  });
  try {
    await expect(
      geminiChat("key", "model", { fetch: request })("test", { fields: {} }),
    ).rejects.toMatchObject({ category: "timeout" });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

it("returns a valid extraction", async () => {
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: '{"quantity":"3"}' }], role: "model" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  await expect(
    geminiChat("key", "model", { fetch: request })("test", { fields: {} }),
  ).resolves.toEqual({ quantity: "3" });
});

it("recovers after a transient failure without repeating a successful call", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response("{}", { status: 503 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: '{"quantity":"3"}' }], role: "model" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  try {
    await expect(
      geminiChat("key", "model", {
        fetch: request,
        sleep: async () => {},
        random: () => 0,
      })("test", { fields: {} }),
    ).resolves.toEqual({ quantity: "3" });
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
  }
});

it("does not retry when Retry-After exceeds the overall deadline", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi.fn(
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "60" } }),
  );
  const sleep = vi.fn(async (_ms: number) => {});
  try {
    await expect(
      geminiChat("key", "model", { fetch: request, sleep })("test", {
        fields: {},
      }),
    ).rejects.toMatchObject({ category: "rate_limit" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it("aborts an in-flight request at the overall timeout", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const request: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("expired", "AbortError")),
      );
    });
  try {
    await expect(
      geminiChat("key", "model", { fetch: request, timeoutMs: 30 })("test", {
        fields: {},
      }),
    ).rejects.toMatchObject({ category: "timeout" });
  } finally {
    log.mockRestore();
  }
});

it("reports missing configuration and keeps prior stored answers after a failure", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let shouldFail = false;
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async () => {
      if (shouldFail) throw new ChatError("service_unavailable", 503);
      return { quantity: "2" };
    },
  );
  const missing = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Employee", snapshotId: imported.json().id },
    });
    const url = "/api/chat/" + started.json().id;
    const first = await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "two" },
    });
    expect(first.json().draft.fields.quantity).toBe("2");
    shouldFail = true;
    const failed = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "change" },
    });
    expect(failed.json()).toMatchObject({
      revision: 1,
      draft: { fields: { quantity: "2" } },
      retryable: true,
    });
    const notConfigured = await missing.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "change" },
    });
    expect(notConfigured.json()).toMatchObject({
      revision: 1,
      draft: { fields: { quantity: "2" } },
      retryable: false,
    });
    expect(notConfigured.json().error).toContain("not configured");
    shouldFail = false;
    const retry = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "two" },
    });
    expect(retry.json().revision).toBe(2);
  } finally {
    log.mockRestore();
    await missing.close();
    await app.close();
    await pg.close();
  }
}, 20000);

it("blocks a failed correction until it is retried and confirms the corrected draft exactly once", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const db = drizzle(pg) as unknown as Database;
  let fail = true;
  const app = buildApp(db, undefined, "token", async (message) => {
    if (message === "initial PUN1 normal")
      return { ...complete.fields, needBy: "2099-01-01" };
    if (fail) throw new ChatError("service_unavailable", 503);
    return { quantity: "300" };
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Employee", snapshotId: imported.json().id },
    });
    const url = "/api/chat/" + started.json().id;
    const initial = await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "initial PUN1 normal" },
    });
    expect(initial.json().ready).toBe(true);
    const failed = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "correction" },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({
      revision: 1,
      draft: { fields: { quantity: "2" } },
    });
    expect(failed.json().error).toContain("not processed");
    const blocked = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, confirm: true },
    });
    expect(blocked.statusCode).toBe(409);
    fail = false;
    const corrected = await app.inject({
      method: "POST",
      url,
      payload: {
        revision: 1,
        retryCorrection: failed.json().unresolvedCorrections[0].id,
      },
    });
    expect(corrected.json()).toMatchObject({
      revision: 2,
      ready: true,
      draft: { fields: { quantity: "300" } },
    });
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url,
          payload: { revision: 2, confirm: true },
        }),
      ),
    );
    expect([first.statusCode, second.statusCode]).toContain(200);
    expect(
      [first.statusCode, second.statusCode].every(
        (s) => s === 200 || s === 409,
      ),
    ).toBe(true);
    const repeat = await app.inject({
      method: "POST",
      url,
      payload: { revision: 2, confirm: true },
    });
    expect(repeat.json().createdPr.quantity).toBe("300");
    const prs = await db.select().from(records).where(eq(records.kind, "pr"));
    expect(prs).toHaveLength(1);
  } finally {
    log.mockRestore();
    await app.close();
    await pg.close();
  }
}, 20000);

it("does not allow an older in-flight correction to overwrite a newer correction", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    began = resolve;
  });
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async (message) => {
      if (message === "initial PUN1 normal")
        return { ...complete.fields, needBy: "2099-01-01" };
      if (message === "older") {
        began();
        await gate;
        return { quantity: "10" };
      }
      return { quantity: "20" };
    },
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Employee", snapshotId: imported.json().id },
    });
    const url = "/api/chat/" + started.json().id;
    await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "initial PUN1 normal" },
    });
    const older = app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "older" },
    });
    await entered;
    const during = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, confirm: true },
    });
    expect(during.statusCode).toBe(409);
    const newer = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "newer" },
    });
    expect(newer.json()).toMatchObject({
      revision: 2,
      draft: { fields: { quantity: "20" } },
    });
    release();
    expect((await older).statusCode).toBe(409);
    const olderId = newer.json().unresolvedCorrections[0].id;
    const discarded = await app.inject({
      method: "POST",
      url,
      payload: {
        revision: 2,
        discardCorrection: olderId,
        acknowledgeDiscard: true,
      },
    });
    expect(discarded.statusCode).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url,
      payload: { revision: 3, confirm: true },
    });
    expect(confirmed.json().createdPr.quantity).toBe("20");
  } finally {
    release();
    await app.close();
    await pg.close();
  }
}, 20000);

it("hides confirmation immediately and keeps it hidden after a failed correction", async () => {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id))
      elements.set(id, {
        value: "",
        hidden: false,
        disabled: false,
        textContent: "",
        addEventListener() {},
        append() {},
        replaceChildren() {},
      });
    return elements.get(id);
  };
  let release!: (value: unknown) => void;
  const failure = new Promise((resolve) => {
    release = resolve;
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "chat", revision: 0, question: "Start" }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ revision: 1, ready: true, question: "Confirm?" }),
    })
    .mockReturnValueOnce(failure);
  const script = chatPage.slice(
    chatPage.lastIndexOf("<script>") + 8,
    chatPage.lastIndexOf("</script>"),
  );
  runInNewContext(script, {
    document: {
      getElementById: element,
      createElement: () => ({ append() {}, textContent: "" }),
    },
    workspace: { actor: "Test", save() {} },
    localStorage: { getItem: () => "snapshot", setItem() {} },
    fetch,
  });
  await element("start").onclick();
  element("message").value = "initial";
  element("form").onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  expect(element("confirm").hidden).toBe(false);
  element("message").value = "correction";
  element("form").onsubmit({ preventDefault() {} });
  expect(element("confirm").hidden).toBe(true);
  release({
    ok: false,
    json: async () => ({ error: "Temporary failure", retryable: true }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(element("confirm").hidden).toBe(true);
  expect(element("status").textContent).toContain("not processed");
  expect(element("retry").hidden).toBe(false);
});

it("does not start another request while corrections are unresolved", async () => {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id))
      elements.set(id, {
        value: "",
        hidden: false,
        disabled: false,
        textContent: "",
        addEventListener() {},
        append() {},
        replaceChildren() {},
      });
    return elements.get(id);
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "chat", revision: 0 }),
    })
    .mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        error: "Failed",
        retryable: true,
        unresolvedCorrections: [{ id: "1", text: "correction" }],
      }),
    })
    .mockRejectedValueOnce(new Error("offline"));
  const script = chatPage.slice(
    chatPage.lastIndexOf("<script>") + 8,
    chatPage.lastIndexOf("</script>"),
  );
  runInNewContext(script, {
    document: {
      getElementById: element,
      createElement: () => ({ append() {}, textContent: "" }),
    },
    workspace: { actor: "Test", save() {} },
    localStorage: { getItem: () => "snapshot", setItem() {} },
    fetch,
  });
  await element("start").onclick();
  element("message").value = "correction";
  element("form").onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await element("start").onclick();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(element("status").textContent).toContain("unresolved correction");
});

it("clears the old confirmation when a new draft starts", async () => {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id))
      elements.set(id, {
        value: "",
        hidden: false,
        disabled: false,
        textContent: "",
        addEventListener() {},
        append() {},
        replaceChildren() {},
      });
    return elements.get(id);
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "first", revision: 0 }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "first", revision: 1, ready: true }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "second", revision: 0 }),
    });
  const script = chatPage.slice(
    chatPage.lastIndexOf("<script>") + 8,
    chatPage.lastIndexOf("</script>"),
  );
  runInNewContext(script, {
    document: {
      getElementById: element,
      createElement: () => ({ append() {}, textContent: "" }),
    },
    workspace: { actor: "Test", save() {} },
    localStorage: { getItem: () => "snapshot", setItem() {} },
    fetch,
  });
  await element("start").onclick();
  element("message").value = "first";
  element("form").onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  expect(element("confirm").hidden).toBe(false);
  element("message").value = "old text";
  await element("start").onclick();
  expect(element("confirm").hidden).toBe(true);
  expect(element("summary").hidden).toBe(true);
  expect(element("message").value).toBe("");
});

it("keeps confirmation blocked when a newer correction fails before an older one finishes", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    began = resolve;
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async (message) => {
      if (message === "initial PUN1 normal")
        return { ...complete.fields, needBy: "2099-01-01" };
      if (message === "older") {
        began();
        await gate;
        return { quantity: "10" };
      }
      throw new ChatError("service_unavailable", 503);
    },
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Employee", snapshotId: imported.json().id },
    });
    const url = "/api/chat/" + started.json().id;
    await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "initial PUN1 normal" },
    });
    const older = app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "older" },
    });
    await entered;
    const failed = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "newer" },
    });
    expect(failed.statusCode).toBe(503);
    release();
    expect((await older).statusCode).toBe(409);
    const confirm = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, confirm: true },
    });
    expect(confirm.statusCode).toBe(409);
  } finally {
    release();
    log.mockRestore();
    await app.close();
    await pg.close();
  }
}, 20000);

it("keeps multiple failed corrections until each is retried or explicitly discarded", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  let failures = true;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async (message) => {
      if (message === "initial PUN1 normal")
        return { ...complete.fields, needBy: "2099-01-01" };
      if (message.startsWith("fail") && failures)
        throw new ChatError("service_unavailable", 503);
      return message === "plant CHK1" ? { plant: "CHK1" } : { quantity: "300" };
    },
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { actor: "Employee", snapshotId: imported.json().id },
    });
    const url = "/api/chat/" + started.json().id;
    await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "initial PUN1 normal" },
    });
    const first = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "fail quantity" },
    });
    const second = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "fail other" },
    });
    expect(second.json().unresolvedCorrections).toHaveLength(2);
    const plant = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "plant CHK1" },
    });
    expect(plant.json()).toMatchObject({
      revision: 2,
      ready: false,
      draft: { fields: { quantity: "2", plant: "CHK1" } },
    });
    expect(plant.json().unresolvedCorrections).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { revision: 2, candidate: "DEMO-A" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { revision: 2, confirm: true },
        })
      ).statusCode,
    ).toBe(409);
    const firstId = first.json().unresolvedCorrections[0].id;
    const secondId = second.json().unresolvedCorrections[1].id;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { revision: 2, discardCorrection: secondId },
        })
      ).statusCode,
    ).toBe(400);
    failures = false;
    const retry = await app.inject({
      method: "POST",
      url,
      payload: { revision: 2, retryCorrection: firstId },
    });
    expect(retry.json()).toMatchObject({
      revision: 3,
      ready: false,
      draft: { fields: { quantity: "300" } },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { revision: 3, confirm: true },
        })
      ).statusCode,
    ).toBe(409);
    const discard = await app.inject({
      method: "POST",
      url,
      payload: {
        revision: 3,
        discardCorrection: secondId,
        acknowledgeDiscard: true,
      },
    });
    expect(discard.json()).toMatchObject({
      revision: 4,
      ready: true,
      unresolvedCorrections: [],
    });
    const confirm = await app.inject({
      method: "POST",
      url,
      payload: { revision: 4, confirm: true },
    });
    expect(confirm.json().createdPr).toMatchObject({
      quantity: "300",
      plant: "CHK1",
    });
    const repeat = await app.inject({
      method: "POST",
      url,
      payload: { revision: 4, confirm: true },
    });
    expect(repeat.json().createdPr).toEqual(confirm.json().createdPr);
  } finally {
    log.mockRestore();
    await app.close();
    await pg.close();
  }
}, 20000);
