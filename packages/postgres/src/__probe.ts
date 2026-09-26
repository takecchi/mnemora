import { sql } from "drizzle-orm";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryOutboxStore, InMemoryEventStore, InMemoryVectorStore, InMemoryLexicalStore } from "@mnemora/testkit/fixtures";
import { createPostgresClient } from "./client.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { PostgresOutboxStore } from "./outbox-store.js";
import { PostgresEventStore } from "./event-store.js";
import { PostgresVectorStore } from "./vector-store.js";
import { PostgresLexicalStore } from "./lexical-store.js";
const c = createPostgresClient(process.env.DATABASE_URL!);
const show = async (label: string, f: () => Promise<unknown>) => {
  try { const r = await f(); console.log(label, "=>", JSON.stringify(r)?.slice(0, 120)); }
  catch (e) { console.log(label, "=> THROW", String((e as Error).cause ?? (e as Error).message).split("\n")[0].slice(0, 110)); }
};
const now = new Date("2026-01-01T00:00:00Z");
async function seed(store: { createMemory: Function }, tenant: string, n: number) {
  for (let i = 0; i < n; i++) await store.createMemory({ tenantId: tenant }, buildNewMemoryFixture({ tenantId: tenant, contentHash: `h${i}`, embeddingStatus: "failed" }));
}
const vals = [0, 1, 3, 4, -1, NaN, Infinity, 1.5, 2 ** 63, 2 ** 62];
for (const v of vals) {
  const t = `probe-req-${Math.random()}`;
  const pg = new PostgresMemoryStore(c.db); await seed(pg, t, 3);
  await show(`PG   requeue limit=${v}`, async () => (await pg.requeueEmbedJobs({ tenantId: t }, { statuses: ["failed"], limit: v })).requeued);
  const f = new InMemoryMemoryStore(); await seed(f, t, 3);
  await show(`Fake requeue limit=${v}`, async () => (await f.requeueEmbedJobs({ tenantId: t }, { statuses: ["failed"], limit: v })).requeued);
}
for (const lease of [NaN, Infinity, -Infinity, -1000, 0.5]) {
  const t = `probe-lease-${Math.random()}`;
  const pg = new PostgresMemoryStore(c.db);
  await pg.createObservationWithOutbox?.({ tenantId: t }, { tenantId: t, kind: "utterance", payload: { text: "x" }, recordedAt: now } as never, ["extract"]).catch((e: Error) => console.log("seed err", e.message));
  const ob = new PostgresOutboxStore(c.db);
  await show(`PG   claim leaseMs=${lease}`, async () => (await ob.claimBatch({ tenantId: t }, { limit: 5, now: new Date(Date.now() + 1000), claimedBy: "w", leaseMs: lease })).length);
  const fo = new InMemoryOutboxStore([{ id: "j1", tenantId: t, kind: "extract", payload: {}, availableAt: now, attempts: 0, createdAt: now } as never]);
  await show(`Fake claim leaseMs=${lease}`, async () => (await fo.claimBatch({ tenantId: t }, { limit: 5, now: new Date(Date.now() + 1000), claimedBy: "w", leaseMs: lease })).length);
}
for (const v of [2 ** 62, 2 ** 63, 1e21]) {
  const ctx = { tenantId: "probe-big" };
  await show(`PG   events.list limit=${v}`, async () => (await new PostgresEventStore(c.db).list(ctx, { limit: v })).length);
  await show(`Fake events.list limit=${v}`, async () => (await new InMemoryEventStore(new InMemoryMemoryStore()).list(ctx, { limit: v })).length);
  await show(`PG   claim limit=${v}`, async () => (await new PostgresOutboxStore(c.db).claimBatch(ctx, { limit: v, now, claimedBy: "w", leaseMs: 1 })).length);
  await show(`Fake claim limit=${v}`, async () => (await new InMemoryOutboxStore([]).claimBatch(ctx, { limit: v, now, claimedBy: "w", leaseMs: 1 })).length);
  await show(`PG   lexical limit=${v}`, async () => (await new PostgresLexicalStore(c.db).search(ctx, "x", { limit: v, filter: { tenantId: ctx.tenantId } })).length);
  await show(`Fake lexical limit=${v}`, async () => (await new InMemoryLexicalStore(new InMemoryMemoryStore()).search(ctx, "x", { limit: v, filter: { tenantId: ctx.tenantId } })).length);
  await show(`PG   archive limit=${v}`, async () => (await new PostgresMemoryStore(c.db).archiveDecayed(ctx, { now, limit: v })).archived.length);
  await show(`Fake archive limit=${v}`, async () => (await new InMemoryMemoryStore().archiveDecayed(ctx, { now, limit: v })).archived.length);
}
await c.pool.end();
