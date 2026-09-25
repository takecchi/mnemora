import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PostgresOutboxStore, sha256Hex } from "@mnemora/postgres";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  createTimeWeightingBenchRuntime,
  seedTimeWeightingMemories,
  type TimeWeightingBenchRuntimeHandle,
} from "../time-weighting-bench.js";
import { clockPastRecentDbWrites } from "../embed-drain.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #719 の決定的な回帰検査（本物の Postgres、鍵不要）。
 *
 * `time-weighting-recorded-replay.postgres.test.ts` が CI（run 36085560161 attempt1）で
 * 赤くなった実際の原因: `seedTimeWeightingMemories` が embed ジョブの `available_at`
 * （Postgres `now()`、マイクロ秒精度）と**同じ ms 内**で `clock` を進めてしまい、
 * `runtime.tick()` の claim クエリ（`available_at <= now`）が0件になったまま
 * `drainEmbedTicks` が「もう無い」と誤解して抜ける——埋め込みが欠けたまま
 * `recall()` が0件を返し、`RecordedLLMProvider: このプロンプトは記録に無い` 例外に
 * つながった。
 *
 * この検査は、**自然発生のタイミング競合に頼らない**（この器では50回中0回しか
 * 自然発生しなかった——`clockPastRecentDbWrites` の docstring・PR の報告参照）:
 *
 * 1本目は、実際に書いた行の `available_at`（us 精度で読み直す）の `floor(ms)` を
 * そのまま `claimBatch` に渡し、「0件になる」ことを直接・決定的に確かめる
 * （機構そのものの証明。+1ms すれば claim できることも合わせて確かめる）。
 *
 * 2本目は、`seedTimeWeightingMemories` が足した歯（Issue #719「seed 件数ぶん処理
 * されなければ例外」のガード）を、`Date.now` を書き込み前の値に固定するモックで
 * 確実に発火させて確かめる。
 */
describe("examples/chat: time-weighting seed 直後の embed drain が available_at と競合しない（Issue #719、決定的）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("機構の証明: available_at を floor(ms) した同じ瞬間を now に渡すと claim は0件、+1ms すると claim できる", async () => {
    await resetTestDatabase();
    const client = await getTestClient();
    const handle = await createTimeWeightingBenchRuntime(requireDatabaseUrl(), {});
    try {
      const ctx = { tenantId: "seed-drain-race-mechanism" };

      const { memory } = await handle.memoryStore.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: "本文",
          contentHash: sha256Hex(`${ctx.tenantId}:seed`),
          digest: "本文",
          tags: [],
          occurredAt: null,
          recordedAt: new Date(),
          validFrom: null,
          validUntil: null,
        }),
        ["embed"],
      );
      expect(memory.id).toBeDefined();

      // available_at を us 精度のまま(浮動小数点変換無し)で読み直す。JS Date に通すと
      // ms へ丸まってしまい、検査したい「ms の中の us」が消える。
      const result = await client.pool.query<{ available_at_us: string }>(
        `SELECT (EXTRACT(EPOCH FROM available_at) * 1000000)::numeric(20,0)::text AS available_at_us
         FROM outbox WHERE tenant_id = $1 AND kind = 'embed' ORDER BY created_at DESC LIMIT 1`,
        [ctx.tenantId],
      );
      const availableAtUs = Number(result.rows[0]!.available_at_us);
      const flooredMs = Math.floor(availableAtUs / 1000);

      const outboxStore = new PostgresOutboxStore(client.db);

      // claimBatch を直接、floor(ms) の now で呼ぶ — 実際に0件になることを確かめる。
      const claimedAtFloor = await outboxStore.claimBatch(ctx, {
        now: new Date(flooredMs),
        limit: 10,
        leaseMs: 30 * 60 * 1000,
        claimedBy: "test-mechanism-floor",
        kinds: ["embed"],
      });
      expect(claimedAtFloor).toHaveLength(0);

      // +1ms（`clockPastRecentDbWrites` と同じ式）なら claim できることも確かめる。
      const claimedAtFloorPlusOne = await outboxStore.claimBatch(ctx, {
        now: clockPastRecentDbWrites(flooredMs),
        limit: 10,
        leaseMs: 30 * 60 * 1000,
        claimedBy: "test-mechanism-plus-one",
        kinds: ["embed"],
      });
      expect(claimedAtFloorPlusOne).toHaveLength(1);
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

      // Date.now を「insert の応答を受け取った直後もまだ同じ ms のまま」に固定する。
      // 現実には稀（この器で実測50回中0回）だが、Issue #719 は実際に CI でこれを
      // 踏んだ——ここでは運に頼らず、`Date.now` をピンポイントでモックして
      // 決定的に再現する。`clockPastRecentDbWrites` は `Date.now()` 経由でしか
      // 「いま」を読まないため、この1関数だけのモックで seed 全体の経路を確実に
      // 同じ ms へ固定できる（素の `new Date()`（引数無し）はモックしない——
      // V8 の内部実装への依存を避けるため）。
      const frozenMs = Date.now();
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
