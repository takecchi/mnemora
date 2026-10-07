import type { Ctx, ReinforceOptions } from "@mnemora/core";
import type { PostgresMemoryStore } from "../memory-store.js";

/** `same-ms-usage-bench.ts` の spy。ベンチ本体は読み込んだだけで `main()` が走るので、測定器をテストから当てられるよう切り出してある。 */
/** 強化の呼び出し（`reinforce`／`reinforceMany`／`recordUsageAndReinforce`）の、Memory 1件ぶんの引数と、その呼び出しが返した行の状態を記録する1件。 */
export interface ReinforceCallLog {
  memoryId: string;
  at: Date;
  nowSeq: number | undefined;
  // その呼び出し自身が観測した返り値。並行実行では他の呼び出しに上書きされるので、最終判定には使わず診断用にだけ残す。
  observedLastReinforcedAt: Date | null;
  observedDecayBaseSeq: number | null;
}

/**
 * `store.reinforce` をインスタンス単位で1回だけ差し替え、呼ばれた引数と返り値を、そのとき差し込まれているログへ積む。
 * クラス定義・プロトタイプには触らない。
 *
 * トライアルのたびに再度差し替えないこと。毎回 `store.reinforce.bind(store)` を元の実装として捕まえると、
 * 前回の差し替え後の関数を包む多重ラップになり、呼び出しが前のトライアルのログにも積まれ続ける。
 * 差し替えは1回だけ行い、どのログへ積むかを `setLog` で切り替える。
 */
export function installReinforceSpy(store: PostgresMemoryStore): {
  setLog: (log: ReinforceCallLog[] | null) => void;
} {
  const original = store.reinforce.bind(store);
  let currentLog: ReinforceCallLog[] | null = null;
  store.reinforce = async (ctx: Ctx, id: string, at: Date, opts?: ReinforceOptions) => {
    const result = await original(ctx, id, at, opts);
    if (currentLog !== null) {
      currentLog.push({
        memoryId: id,
        at,
        nowSeq: opts?.nowSeq,
        observedLastReinforcedAt: result.lastReinforcedAt ?? null,
        observedDecayBaseSeq: result.decayBaseSeq ?? null,
      });
    }
    return result;
  };
  // 強化は `reinforce` 1件ずつの経路だけでなく、runtime が通る一括の経路（`reinforceMany`・`recordUsageAndReinforce`）でも起きる。
  // `observe({kind:memory_usage})` は後者を通り `reinforce` を呼ばない。ここを捕まえないと、使用報告のシナリオの記録が
  // 空になり、一致0件・母数0を黙って出す。どちらも内部の private `reinforceManyOn` を呼び、公開の `reinforce`/`reinforceMany`
  // を呼び直さないので、同じ強化を二重に記録しない。
  const originalMany = store.reinforceMany.bind(store);
  store.reinforceMany = async (ctx: Ctx, ids: string[], at: Date, opts?: ReinforceOptions) => {
    const results = await originalMany(ctx, ids, at, opts);
    if (currentLog !== null) {
      ids.forEach((id, i) => {
        currentLog!.push({
          memoryId: id,
          at,
          nowSeq: opts?.nowSeq,
          observedLastReinforcedAt: results[i]?.lastReinforcedAt ?? null,
          observedDecayBaseSeq: results[i]?.decayBaseSeq ?? null,
        });
      });
    }
    return results;
  };
  const originalRecordAndReinforce = store.recordUsageAndReinforce.bind(store);
  store.recordUsageAndReinforce = async (
    ctx: Ctx,
    recallId: string,
    memoryIds: string[],
    at: Date,
    opts?: ReinforceOptions,
  ) => {
    const result = await originalRecordAndReinforce(ctx, recallId, memoryIds, at, opts);
    if (currentLog !== null) {
      // 強化が掛かるのは実際に挿入された id だけ。この口は強化後の行を返さないので、観測値は持たない。
      for (const id of result.insertedMemoryIds) {
        currentLog.push({
          memoryId: id,
          at,
          nowSeq: opts?.nowSeq,
          observedLastReinforcedAt: null,
          observedDecayBaseSeq: null,
        });
      }
    }
    return result;
  };
  return {
    setLog: (log) => {
      currentLog = log;
    },
  };
}
