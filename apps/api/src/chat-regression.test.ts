import { expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { snapshot } from "../../../packages/engine/test/fixtures.js";
import { buildApp } from "./app.js";
import { schemaSql, type Database } from "./db.js";
import {
  advance,
  groundChatFields,
  inspect,
  ChatError,
  type ChatDraft,
} from "./chat.js";

const data = snapshot();
data.plants = ["PUN1", "CHK1"];
data.plantNames = { PUN1: "Northfield plant", CHK1: "Southport plant" };
const today = "2026-11-18";

it.each([
  ["urgent", "Emergency"],
  ["emergency", "Emergency"],
  ["normal", "Normal"],
])("grounds %s as %s even if the model omits it", (word, expected) => {
  expect(groundChatFields(word, {}, data).urgency).toBe(expected);
});

it("uses only unique plant names in the supplied snapshot", () => {
  expect(groundChatFields("at Southport", {}, data).plant).toBe("CHK1");
  expect(groundChatFields("at Northfield", {}, data).plant).toBe("PUN1");
  expect(
    groundChatFields("at Unknownville", { plant: "CHK1" }, data).plant,
  ).toBeUndefined();
  expect(
    groundChatFields(
      "Southport",
      {},
      {
        ...data,
        plantNames: { PUN1: "Southport plant", CHK1: "Southport site" },
      },
    ).plant,
  ).toBe("AMBIGUOUS");
  expect(
    groundChatFields("Southport", {}, { ...data, plantNames: undefined }).plant,
  ).toBeUndefined();
});

it("does not invent urgency and preserves explicit urgency through clarification", () => {
  const first = advance({ fields: {} }, groundChatFields("urgent", {}, data));
  const next = advance(
    first,
    groundChatFields("PUN1", { urgency: "Normal" }, data),
  );
  expect(next.fields).toMatchObject({ urgency: "Emergency", plant: "PUN1" });
  expect(
    advance(next, groundChatFields("normal", {}, data)).fields.urgency,
  ).toBe("Normal");
  expect(
    groundChatFields("by tomorrow", { urgency: "Emergency" }, data).urgency,
  ).toBeUndefined();
});

it("rejects an explicitly invalid plant before item matching, even when the model suggests a valid one", () => {
  const fields = groundChatFields(
    "need 10 gloves for PUN2",
    { plant: "PUN1", description: data.items[0].description },
    data,
  );
  expect(fields.plant).toBe("PUN2");
  expect(inspect({ fields }, data, today).question).toBe(
    "Invalid plant. Please use PUN1 or CHK1.",
  );
  for (const plant of ["PUN1", "CHK1"])
    expect(groundChatFields(plant, {}, data).plant).toBe(plant);
});

it("asks for a price for a sufficiently described new item without inventing one", () => {
  const draft: ChatDraft = {
    fields: {
      description: "Novel printer",
      quantity: "1",
      uom: "NOS",
      plant: "PUN1",
      needBy: "2099-01-01",
      urgency: "Normal",
    },
  };
  expect(inspect(draft, data, today).question).toContain(
    "estimated unit price",
  );
  expect(
    inspect({ fields: { ...draft.fields, urgency: undefined } }, data, today)
      .question,
  ).toContain("Normal or Emergency");
});

it("isolates independent chats and refuses changing a known item within a populated draft", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const item = data.items[0];
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async (message) => {
      if (message.startsWith("first"))
        return {
          description: item.description,
          quantity: "200",
          uom: item.uom,
          plant: "PUN1",
          needBy: "2099-01-01",
          urgency: "Normal",
        };
      if (message.startsWith("other"))
        return { description: "Unlisted precision instrument" };
      return { quantity: "300" };
    },
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const start = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/chat",
          payload: { actor: "Test", snapshotId: imported.json().id },
        })
      ).json().id;
    const firstId = await start();
    const url = "/api/chat/" + firstId;
    const first = await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "first PUN1 normal" },
    });
    expect(first.json().ready).toBe(true);
    const correction = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "make it 300" },
    });
    expect(correction.json().draft.fields).toMatchObject({
      quantity: "300",
      plant: "PUN1",
      urgency: "Normal",
    });
    const switched = await app.inject({
      method: "POST",
      url,
      payload: { revision: 2, message: "other item" },
    });
    expect(switched.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { revision: 2, confirm: true },
        })
      ).statusCode,
    ).toBe(409);
    const secondId = await start();
    const second = await app.inject({
      method: "POST",
      url: "/api/chat/" + secondId,
      payload: { revision: 0, message: "other item" },
    });
    expect(second.json().draft.fields.quantity).toBeUndefined();
    expect(second.json().draft.fields.plant).toBeUndefined();
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { revision: 2, confirm: true },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
    await pg.close();
  }
}, 20000);

it("overrules an incorrect Gemini plant and preserves urgency through item selection", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async (message) =>
      message.startsWith("need")
        ? {
            description: "Steel panel",
            quantity: "10",
            plant: "CHK1",
            urgency: "Normal",
          }
        : {},
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
      payload: { actor: "Test", snapshotId: imported.json().id },
    });
    const url = "/api/chat/" + started.json().id;
    const invalid = await app.inject({
      method: "POST",
      url,
      payload: { revision: 0, message: "need 10 Steel panel for PUN2 urgent" },
    });
    expect(invalid.json().question).toBe(
      "Invalid plant. Please use PUN1 or CHK1.",
    );
    expect(invalid.json().draft.fields).toMatchObject({
      plant: "PUN2",
      urgency: "Emergency",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { revision: 1, confirm: true },
        })
      ).statusCode,
    ).not.toBe(200);
    const valid = await app.inject({
      method: "POST",
      url,
      payload: { revision: 1, message: "PUN1" },
    });
    expect(valid.json().draft.fields).toMatchObject({
      plant: "PUN1",
      urgency: "Emergency",
    });
    const candidate = valid.json().candidates[0].item_code;
    const selected = await app.inject({
      method: "POST",
      url,
      payload: { revision: 2, candidate },
    });
    expect(selected.json().draft.fields.urgency).toBe("Emergency");
    expect(selected.json().question).not.toContain("Normal or Emergency");
  } finally {
    await app.close();
    await pg.close();
  }
}, 20000);

it("keeps interleaved drafts, revisions, failures, and confirmations independent", async () => {
  const pg = new PGlite();
  await pg.exec(schemaSql);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = buildApp(
    drizzle(pg) as unknown as Database,
    undefined,
    "token",
    async (message) => {
      if (message === "failure")
        throw new ChatError("service_unavailable", 503);
      if (message.startsWith("first"))
        return {
          description: data.items[0].description,
          quantity: "2",
          uom: data.items[0].uom,
          plant: "PUN1",
          needBy: "2099-01-01",
          urgency: "Normal",
        };
      if (message.startsWith("second"))
        return {
          description: "Novel printer",
          quantity: "7",
          uom: "NOS",
          plant: "CHK1",
          needBy: "2099-01-02",
          urgency: "Normal",
          estimatedPrice: "10",
        };
      return { quantity: "9" };
    },
  );
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      headers: { "x-setup-token": "token" },
      payload: { actor: { name: "Test", role: "Procurement" }, snapshot: data },
    });
    const start = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/chat",
          payload: { actor: "Test", snapshotId: imported.json().id },
        })
      ).json().id;
    const a = await start(),
      b = await start();
    expect(a).not.toBe(b);
    const post = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/chat/" + id, payload });
    expect(
      (await post(a, { revision: 0, message: "first PUN1 normal" })).json()
        .ready,
    ).toBe(true);
    expect(
      (await post(b, { revision: 0, message: "second CHK1 normal" })).json()
        .ready,
    ).toBe(true);
    const fail = await post(a, { revision: 1, message: "failure" });
    expect(fail.statusCode).toBe(503);
    const editedB = await post(b, { revision: 1, message: "make it 9" });
    expect(editedB.json().draft.fields).toMatchObject({
      quantity: "9",
      plant: "CHK1",
    });
    expect((await post(a, { revision: 1, confirm: true })).statusCode).toBe(
      409,
    );
    expect((await post(b, { revision: 1, confirm: true })).statusCode).toBe(
      409,
    );
    const confirmed = await post(b, { revision: 2, confirm: true });
    expect(confirmed.json().createdPr).toMatchObject({
      quantity: "9",
      plant: "CHK1",
    });
    expect(
      (await post(b, { revision: 2, confirm: true })).json().createdPr,
    ).toEqual(confirmed.json().createdPr);
    const aState = await app.inject({ method: "GET", url: "/api/chat/" + a });
    expect(aState.json().draft.fields).toMatchObject({
      quantity: "2",
      plant: "PUN1",
    });
    expect(aState.json().unresolvedCorrections).toHaveLength(1);
  } finally {
    log.mockRestore();
    await app.close();
    await pg.close();
  }
}, 20000);
