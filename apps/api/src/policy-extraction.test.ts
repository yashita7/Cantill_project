import { expect, it, vi } from "vitest";
import { geminiExtractor } from "./policies.js";
import { fixturePolicy } from "../../../packages/engine/test/fixtures.js";

it.each([
  [404, "model_not_found"],
  [429, "rate_limit"],
  [503, "service_unavailable"],
] as const)(
  "logs policy HTTP %s without sensitive content",
  async (status, category) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "sensitive-policy" } }),
          { status, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await expect(
        geminiExtractor("secret-test-key", "test-model", {
          fetch,
          sleep: async () => {},
          random: () => 0,
        })({
          kind: "text",
          text: "private-input",
        }),
      ).rejects.toThrow("Policy extraction failed");
      expect(fetch).toHaveBeenCalledTimes(status === 404 ? 1 : 3);
      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain(category);
      expect(output).not.toContain("secret-test-key");
      expect(output).not.toContain("sensitive-policy");
      expect(output).not.toContain("private-input");
    } finally {
      log.mockRestore();
    }
  },
);

it.each([
  ["broken", "invalid_json"],
  ["{}", "validation"],
])("classifies malformed policy output", async (content, category) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.fn(
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
      geminiExtractor("test-key", "test-model", { fetch })({
        kind: "text",
        text: "private-input",
      }),
    ).rejects.toThrow("Policy extraction failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).toContain(category);
  } finally {
    log.mockRestore();
  }
});

it("honors Retry-After and succeeds after a transient outage", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { approval: _approval, ...policy } = fixturePolicy();
  const payload = {
    ...policy,
    rules: policy.rules.map((rule) => ({
      ...rule,
      when: JSON.stringify(rule.when),
    })),
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("{}", { status: 503, headers: { "Retry-After": "2" } }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: JSON.stringify(payload) }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const sleep = vi.fn(async (_ms: number) => {});
  try {
    const result = await geminiExtractor("key", "model", {
      fetch,
      sleep,
      random: () => 0,
    })({ kind: "text", text: "synthetic" });
    expect(result).toMatchObject({ version: policy.version });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  } finally {
    log.mockRestore();
  }
});

it("does not wait beyond the deadline for Retry-After", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.fn(
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "60" } }),
  );
  const sleep = vi.fn(async (_ms: number) => {});
  try {
    await expect(
      geminiExtractor("key", "model", { fetch, sleep })({
        kind: "text",
        text: "synthetic",
      }),
    ).rejects.toThrow("Policy extraction failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it("aborts policy extraction at the shared deadline", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch: typeof globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("expired", "AbortError")),
      ),
    );
  try {
    await expect(
      geminiExtractor("key", "model", { fetch, timeoutMs: 30 })({
        kind: "text",
        text: "synthetic",
      }),
    ).rejects.toThrow("Policy extraction failed");
    expect(JSON.stringify(log.mock.calls)).toContain("timeout");
  } finally {
    log.mockRestore();
  }
});
