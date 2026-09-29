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
 * 1本目は、この機構が Issue #1237（ADR 0354）で**無くなった**ことを確かめる。
 * `available_at` は Postgres の `now()`（us 精度）ではなく、呼び出し側が渡す時刻
 * （省略時は JS の壁時計、ms 精度）で書かれる。⟹ 書いた行の `available_at` は ms の
 * 境界ちょうどであり、同じ瞬間を `now` に渡した `claimBatch` がそのジョブを取れる。
 * ⚠ 2026-09-29 までは、ここで「`floor(ms)` の `now` では0件」という旧い機構そのものを
 * 証明していた（us の端数が 0 の行を引くと前提が崩れる、Issue #1002）。その前提は
 * もう成り立たないので、裏返しの形に書き換えた。
 *
 * 2本目は、`seedTimeWeightingMemories` が足した歯（Issue #719「seed 件数ぶん処理
 * されなければ例外」のガード）を、`Date.now` を書き込み前の値に固定するモックで
 * 確実に発火させて確かめる。
 */
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
        // available_at を us 精度のまま（浮動小数点変換無し）で読み直す。JS Date に通すと
        // ms へ丸まってしまい、検査したい「ms の中の us」が消える。
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

      // (1) 時刻を渡すと、available_at はその値そのもの。同じ瞬間の now で取れる。
      const given = new Date(Date.now() - 60_000);
      const givenUs = await writeAndReadAvailableAtUs("seed-drain-race-given", given);
      expect(givenUs).toBe(given.getTime() * 1000);
      expect(await claimAt("seed-drain-race-given", given)).toHaveLength(1);

      // (2) 省略しても、available_at は ms の境界ちょうど（us の端数が無い）。floor(ms) の
      // now——旧い機構ではここが0件だった——で取れる。
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

      // Date.now を「insert の応答を受け取った直後もまだ同じ ms のまま」に固定する。
      // 現実には稀（この器で実測50回中0回）だが、Issue #719 は実際に CI でこれを
      // 踏んだ——ここでは運に頼らず、`Date.now` をピンポイントでモックして
      // 決定的に再現する。`clockPastRecentDbWrites` は `Date.now()` 経由でしか
      // 「いま」を読まないため、この1関数だけのモックで seed 全体の経路を確実に
      // 同じ ms へ固定できる（素の `new Date()`（引数無し）はモックしない——
      // V8 の内部実装への依存を避けるため）。
      //
      // ⚠ 2026-09-28: 固定する値は「いま」ではなく、書き込みより約60秒前にする。
      // `available_at` は Postgres の `now()`（書き込みのトランザクションの開始時刻）で書かれ、
      // claim の `now` は固定した値 +1ms（`clockPastRecentDbWrites`）になる。固定する値を
      // 読み取った瞬間の `Date.now()` にすると、このガードが発火するのは「読み取りから
      // トランザクションの開始までに約1ms以上かかったとき」だけになる——書き込みの経路の速さに
      // 依っていた。手元の実測では、プロセスの最初の書き込み（コードが冷えている）は約5.8ms
      // かかって発火するが、温まった経路では300回中142回が1ms未満で、ガードが発火しなかった。
      // CI でも1回、この形で赤くなった（run 36409314697 attempt 1、`promise resolved … instead of
      // rejecting`）。60秒前なら、経路の速さにも、同じホストの上の小さな時計のずれにも依らず、
      // claim の `now` が `available_at` に届かない。ms の境界そのものの機構は、上の「機構の証明」が
      // 別に縛っている。
      // ⚠ 2026-09-29（Issue #1237、ADR 0354）: `available_at` は今は `now()` ではなく、store の
      // 既定の JS の壁時計（`seed` は時刻を渡さない）で書かれる。60秒前に固定した claim の `now` が
      // 届かないことは変わらないので、このガードの検査はそのまま成り立つ。
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
