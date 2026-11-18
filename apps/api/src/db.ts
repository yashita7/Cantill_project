import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Kept outside public: Supabase's public Data API must not expose kit data.
const procurement = pgSchema("procurement");
export const records = procurement.table("records", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const schemaSql = `CREATE SCHEMA IF NOT EXISTS procurement;
CREATE TABLE IF NOT EXISTS procurement.records (
 id text PRIMARY KEY, kind text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS records_kind ON procurement.records(kind);`;
export function database(url: string) {
  const pool = new Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 10000,
  });
  return { db: drizzle(pool), close: () => pool.end() };
}
export type Database = ReturnType<typeof database>["db"];
export async function initialize(db: Database) {
  await db.execute(sql.raw(schemaSql));
}
