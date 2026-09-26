import { performance } from "node:perf_hooks";
import type { MemoryId, VectorHit, VectorStore } from "@mnemora/core";

/**
 * `association-scale-*.ts` のベンチが共有する VectorStore の spy（時間つき）。
 * packages/core・packages/postgres は変更しない。ベンチ本体は読み込んだだけで `main()` が
 * 走るスクリプトなので、測定器そのものをテストから当てられるよう、ここへ切り出した。
 */

export interface SpyCall {
  /**
   * `searchMany` は1回の束（段3.5 の全アンカー）を1件として記録する。**時間・往復は束の単位で、
   * アンカーごとに按分しない**（按分は作り物の数字になる。Issue #1012）。
   */
  kind: "search" | "searchMany" | "getVectors";
  /** その1回の呼び出し（`searchMany` なら束全体）の時間。 */
  ms: number;
  /** search のときだけ。 */
  hits?: VectorHit[];
  /** searchMany のときだけ。束に入っていたクエリ（アンカー）の数。 */
  queryCount?: number;
  /** searchMany のときだけ。束の結果（クエリの key → hits）。 */
  hitsByKey?: Map<string, VectorHit[]>;
  /** getVectors のときだけ。 */
  memoryIds?: MemoryId[];
}

export interface VectorStoreSpy {
  calls: SpyCall[];
  reset(): void;
}

/**
 * 🔴 Issue #1012: **内側の store が持つ任意の口は、包みも同じように持つこと。**
 * 包みが `searchMany?`（PR #932）を落とすと、runtime の段3.5 は「`searchMany` が無い
 * adapter」とみなしてアンカーごとに `search()` を撃ち、本番（`PostgresVectorStore` は
 * `searchMany` を持つ）と違う経路の往復・時間を測る。内側が持たないときは包みも持たない
 * （「口が無い adapter」の意味を変えない）。
 */
export function wrapVectorStoreWithSpy(inner: VectorStore, spy: VectorStoreSpy): VectorStore {
  const innerSearchMany = inner.searchMany;
  return {
    ...(innerSearchMany !== undefined
      ? {
          searchMany: async (ctx, space, queries, opts) => {
            const t0 = performance.now();
            const result = await innerSearchMany.call(inner, ctx, space, queries, opts);
            spy.calls.push({
              kind: "searchMany",
              ms: performance.now() - t0,
              queryCount: queries.length,
              hitsByKey: result,
            });
            return result;
          },
        }
      : {}),
    upsert: (ctx, space, memoryId, vector) => inner.upsert(ctx, space, memoryId, vector),
    delete: (ctx, space, memoryId) => inner.delete(ctx, space, memoryId),
    search: async (ctx, space, query, opts) => {
      const t0 = performance.now();
      const hits = await inner.search(ctx, space, query, opts);
      spy.calls.push({ kind: "search", ms: performance.now() - t0, hits });
      return hits;
    },
    getVectors: async (ctx, space, memoryIds) => {
      const t0 = performance.now();
      const result = await inner.getVectors!(ctx, space, memoryIds);
      spy.calls.push({ kind: "getVectors", ms: performance.now() - t0, memoryIds: [...memoryIds] });
      return result;
    },
  };
}

/**
 * 段3.5 由来と見なす DB 呼び出しの ms 合計(1回目の search() = 段1、それ以降は段3.5)。
 * `searchMany` の束は段3.5 の呼び出しなので、そのまま1件として合計に入る（Issue #1012）。
 */
export function stage3_5DbMs(spy: VectorStoreSpy): number {
  const searchCalls = spy.calls.filter((c) => c.kind === "search");
  const afterFirstSearch = spy.calls.filter(
    (c) =>
      c.kind === "getVectors" ||
      c.kind === "searchMany" ||
      (c.kind === "search" && c !== searchCalls[0]),
  );
  return afterFirstSearch.reduce((sum, c) => sum + c.ms, 0);
}
