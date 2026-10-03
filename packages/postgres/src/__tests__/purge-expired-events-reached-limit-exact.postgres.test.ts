import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `purgeExpiredEvents` の `reachedLimit` は「候補が `limit` より多い」ときだけ true。
 * 候補がちょうど `limit` 件のときは、取りこぼしが無いので false（クローンの判断。
 * 呼び出し側が `reachedLimit` で「もう一度回す」かを決めるので、`>=` にすると、全部消し終えたのに
 * 空振りの1周が増える）。InMemory と Postgres に同じ入力を流して見る。
 * 「ちょうど `limit` 件」と「`limit` より1件多い」の境目を、実消し・`dryRun` の両方で縛る
 * （Postgres は実消しと `dryRun` で `reachedLimit` を別の行で計算する）。
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const DAY_MS = 86_400_000;

interface Env {
  mem: MemoryStore;
  ev: EventStore;
}

function oldEvent(ctx: Ctx, at: Date): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId: null,
    kind: "created",
    at,
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  };
}

async function seed(env: Env, ctx: Ctx, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await env.ev.append(ctx, oldEvent(ctx, new Date(NOW.getTime() - 100 * DAY_MS + i * 1000)));
  }
}

const backends: Array<[string, () => Promise<Env>]> = [
  [
    "InMemory",
    async () => {
      const m = new InMemoryMemoryStore();
      return { mem: m, ev: new InMemoryEventStore(m, m.events) };
    },
  ],
  [
    "Postgres",
    async () => {
      const { db } = await getTestClient();
      return { mem: new PostgresMemoryStore(db), ev: new PostgresEventStore(db) };
    },
  ],
];

describe.each(backends)("purgeExpiredEvents の reachedLimit の境目（%s）", (_name, build) => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  for (const dryRun of [false, true]) {
    const label = dryRun ? "dryRun" : "実消し";

    it(`${label}: 候補がちょうど limit 件なら reachedLimit は false（purged は limit 件）`, async () => {
      const env = await build();
      const ctx: Ctx = { tenantId: `reached-limit-exact-${label}` };
      await seed(env, ctx, 3);
      const result = await env.mem.purgeExpiredEvents!(ctx, { olderThan: NOW, limit: 3, dryRun });
      expect(result.purged).toBe(3);
      expect(result.reachedLimit).toBe(false);
    });

    it(`${label}: 候補が limit より1件多いときだけ reachedLimit は true`, async () => {
      const env = await build();
      const ctx: Ctx = { tenantId: `reached-limit-over-${label}` };
      await seed(env, ctx, 4);
      const result = await env.mem.purgeExpiredEvents!(ctx, { olderThan: NOW, limit: 3, dryRun });
      expect(result.purged).toBe(3);
      expect(result.reachedLimit).toBe(true);
    });

    it(`${label}: 候補が limit より少なければ reachedLimit は false`, async () => {
      const env = await build();
      const ctx: Ctx = { tenantId: `reached-limit-under-${label}` };
      await seed(env, ctx, 2);
      const result = await env.mem.purgeExpiredEvents!(ctx, { olderThan: NOW, limit: 3, dryRun });
      expect(result.purged).toBe(2);
      expect(result.reachedLimit).toBe(false);
    });
  }
});
