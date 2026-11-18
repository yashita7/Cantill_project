import { expect, it } from "vitest";
import {
  advance,
  inspect,
  resolveDate,
  createLine,
  type ChatDraft,
} from "./chat.js";
import { snapshot } from "../../../packages/engine/test/fixtures.js";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { buildApp } from "./app.js";
import { schemaSql, type Database } from "./db.js";
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
        fields: { ...complete.fields, description: "Laser spectrometer" },
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
      throw new Error("quota");
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

it('creates one stored PR and returns it on repeated confirmation', async () => {
 const pg=new PGlite();await pg.exec(schemaSql);
 const future={...complete.fields,needBy:'2099-01-01'};
 const app=buildApp(drizzle(pg) as unknown as Database,undefined,'token',async()=>future);
 try {
 const imported=await app.inject({method:'POST',url:'/api/snapshots',headers:{'x-setup-token':'token'},payload:{actor:{name:'Test',role:'Procurement'},snapshot:data}});
 const started=await app.inject({method:'POST',url:'/api/chat',payload:{actor:'Employee',snapshotId:imported.json().id}});
 const url='/api/chat/'+started.json().id;
 const draft=await app.inject({method:'POST',url,payload:{revision:0,message:'Complete request'}});
 expect(draft.json().ready).toBe(true);
 const confirmed=await app.inject({method:'POST',url,payload:{revision:1,confirm:true}});
 expect(confirmed.statusCode,confirmed.body).toBe(200);
 expect(confirmed.json().createdPr.pr_line).toBe('1');
 const repeated=await app.inject({method:'POST',url,payload:{revision:1,confirm:true}});
 expect(repeated.json().createdPr).toEqual(confirmed.json().createdPr);
 }finally{await app.close();await pg.close();}
},20000);
