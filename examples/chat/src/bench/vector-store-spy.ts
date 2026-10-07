import { performance } from "node:perf_hooks";
import type { MemoryId, VectorHit, VectorStore } from "@mnemora/core";

/**
 * `association-scale-*.ts` のベンチが共有する VectorStore の spy（時間つき）。
 * ベンチ本体は読み込むだけで `main()` が走るため、測定器をテストから当てられるようここへ切り出した。
 */

export interface SpyCall {
  /**
   * `searchMany` は1回の束を1件として記録する。時間・往復は束の単位で、アンカーごとに按分しない。
   * 按分は作り物の数字になる。
   */
  kind: "search" | "searchMany" | "getVectors";
  ms: number;
  hits?: VectorHit[];
  queryCount?: number;
  hitsByKey?: Map<string, VectorHit[]>;
  memoryIds?: MemoryId[];
}

export interface VectorStoreSpy {
  calls: SpyCall[];
  reset(): void;
}

/**
 * 内側の store が持つ任意の口は、包みも同じように持つこと。
 * 包みが `searchMany?` を落とすと、runtime は「`searchMany` が無い adapter」とみなして
 * アンカーごとに `search()` を撃ち、本番と違う経路の往復・時間を測ってしまう。
 * 内側が持たないときは包みも持たない。
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
    deleteAcrossSpaces: (ctx, memoryIds) => inner.deleteAcrossSpaces(ctx, memoryIds),
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
