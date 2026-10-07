import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PostgresOutboxStore, sha256Hex } from "@mnemora/postgres";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  createTimeWeightingBenchRuntime,
  seedTimeWeightingMemories,
  type TimeWeightingBenchRuntimeHandle,
} from "../time-weighting-bench.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 自然発生のタイミング競合には頼らない（自然には50回中0回しか起きなかった）。Date.now をモックして決定的に再現する（Issue #719）。
describe("examples/chat: time-weighting seed 直後の embed drain が available_at と競合しない（Issue #719、決定的）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("機構が無くなったことの証明: available_at は渡した時刻（省略時は JS の壁時計）の ms ちょうどで、同じ瞬間の now で claim できる", async () => {
    await resetTestDatabase();
    const client = await getTestClient();
    const handle = await createTimeWeightingBenchRuntime(requireDatabaseUrl(), {});
    try {
      const outboxStore = new PostgresOutboxStore(client.db);
      const writeAndReadAvailableAtUs = async (tenantId: string, now?: Date) => {
        const ctx = { tenantId };
        await handle.memoryStore.createMemoryWithOutbox(
          ctx,
          buildNewMemoryFixture({
            tenantId,
            content: "本文",
            contentHash: sha256Hex(`${tenantId}:seed`),
            digest: "本文",
            tags: [],
            occurredAt: null,
            recordedAt: new Date(),
            validFrom: null,
            validUntil: null,
          }),
          ["embed"],
          ...(now === undefined ? [] : [{ now }]),
        );
        // available_at は us 精度のまま読む。JS Date に通すと ms へ丸まり、検査したい ms の中の us が消える。
        const result = await client.pool.query<{ available_at_us: string }>(
          `SELECT (EXTRACT(EPOCH FROM available_at) * 1000000)::numeric(20,0)::text AS available_at_us
           FROM outbox WHERE tenant_id = $1 AND kind = 'embed' ORDER BY created_at DESC LIMIT 1`,
          [tenantId],
        );
        return Number(result.rows[0]!.available_at_us);
      };
      const claimAt = (tenantId: string, now: Date) =>
        outboxStore.claimBatch(
          { tenantId },
          {
            now,
            limit: 10,
            leaseMs: 30 * 60 * 1000,
            claimedBy: "test-mechanism-gone",
            kinds: ["embed"],
          },
        );

      const given = new Date(Date.now() - 60_000);
      const givenUs = await writeAndReadAvailableAtUs("seed-drain-race-given", given);
      expect(givenUs).toBe(given.getTime() * 1000);
      expect(await claimAt("seed-drain-race-given", given)).toHaveLength(1);

      const omittedUs = await writeAndReadAvailableAtUs("seed-drain-race-omitted");
      expect(omittedUs % 1000).toBe(0);
      expect(
        await claimAt("seed-drain-race-omitted", new Date(Math.floor(omittedUs / 1000))),
      ).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it("ガードの検査: Date.now が書き込み前の値に固定されていても、seedTimeWeightingMemories は黙って0件のまま進まず例外を投げる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle: TimeWeightingBenchRuntimeHandle = await createTimeWeightingBenchRuntime(
      requireDatabaseUrl(),
      {},
    );
    try {
      const ctx = { tenantId: "seed-drain-race-guard" };

      // Date.now だけをモックして seed 内の時刻を同じ ms に固定する（素の new Date() はモックしない。V8 の内部実装に依らないため）。
      // 固定値は書き込みの約60秒前にする。「いま」にすると、読み取りからトランザクション開始までに1ms以上かかったときしかガードが発火せず、書き込み経路の速さに依ってしまう。
      const frozenMs = Date.now() - 60_000;
      vi.spyOn(Date, "now").mockReturnValue(frozenMs);

      await expect(
        seedTimeWeightingMemories(handle.memoryStore, handle.runtime, handle.clock, ctx, [
          {
            localId: "will-not-embed-in-time",
            content: "この内容は claim できないまま残るはず。",
            recordedAt: new Date(frozenMs),
          },
        ]),
      ).rejects.toThrow(/embed ジョブが 1 件処理されるはずが/);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
