import type { Ctx, ReinforceOptions } from "@mnemora/core";
import type { PostgresMemoryStore } from "../memory-store.js";

/**
 * `same-ms-usage-bench.ts`（Issue #730 の手動ベンチ）の spy。ベンチ本体は読み込んだだけで
 * `main()` が走るスクリプトなので、測定器そのものをテストから当てられるよう、ここへ切り出した。
 */

/** 強化の呼び出し（`reinforce`／`reinforceMany`／`recordUsageAndReinforce`）の、Memory 1件ぶんの引数と、その呼び出しが返した行の状態を記録する1件。 */
export interface ReinforceCallLog {
  memoryId: string;
  at: Date;
  nowSeq: number | undefined;
  // その呼び出し「自身」が観測した返り値（並行実行では他の呼び出しに上書きされている
  // ことがあるため、最終判定には使わない——ここでは診断用にだけ残す）。
  observedLastReinforcedAt: Date | null;
  observedDecayBaseSeq: number | null;
}

/**
 * `store.reinforce` をインスタンス単位で**1回だけ**差し替え、呼ばれた引数と返り値を
 * 「そのとき差し込まれている」ログへ積む。クラス定義・プロトタイプは一切触らない
 * ——このインスタンスへの呼び出しだけを観測する。
 *
 * ⚠ **トライアルのたびに再度差し替えないこと。**`store.reinforce.bind(store)` を
 * 「元の実装」として毎回捕まえると、2回目以降の差し替えは「前回の差し替え後の関数」を
 * 元として包むことになり、呼び出しが前のトライアルのログにも積まれ続ける多重ラップに
 * なる——実際にこの実装で最初に踏んだ（集計がトライアル数と噛み合わなかった）。
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
  // Issue #730 のベンチが測る「強化の `at` の一致」は、`reinforce` 1件ずつの経路だけでなく、
  // runtime が実際に通る一括の経路でも起きる（同じ WHERE の比較を SQL の中で撃つ）。
  // `observe({kind:memory_usage})` は #917 以降 `reinforceMany`、PR #980 以降
  // `recordUsageAndReinforce` を通り、`reinforce` を呼ばない——ここを捕まえないと、使用報告の
  // シナリオの記録が空になり、「一致0件・母数0」を黙って出す（測定器の不具合）。
  // どちらも内部で private の `reinforceManyOn` を呼び、公開の `reinforce`/`reinforceMany`
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
      // 強化が掛かるのは実際に挿入された id だけ（`recordUsageAndReinforce` の契約）。
      // この口は強化後の行を返さないので、観測値は持たない（最終判定には元から使っていない）。
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
