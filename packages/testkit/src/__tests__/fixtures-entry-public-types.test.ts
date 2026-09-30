import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, InMemoryRelationStore } from "../fixtures.js";
import type { StoredRelation } from "../fixtures.js";

/**
 * `@mnemora/testkit/fixtures`（`src/fixtures.ts`）の公開シグネチャに出る型は、その入口から
 * 名指せなければならない。`InMemoryRelationStore` のコンストラクタの第2引数は
 * `StoredRelation[]` なのに、以前は入口が型を export しておらず、利用者は
 * `InMemoryMemoryStore["relations"]` のような迂回でしか書けなかった。
 *
 * この歯の本体は上の `import type` である——入口から export されていなければ
 * `pnpm run typecheck`（`tsc -p tsconfig.json`）が TS2459 で赤くなる。vitest は型を検査しないため、
 * 実行時の it は「型の import が消えても値の組み立てが通ること」を見るだけの添えものである。
 */
describe("testkit/fixtures 入口の公開型", () => {
  it("StoredRelation[] を明示して InMemoryRelationStore に渡せる", () => {
    const memoryStore = new InMemoryMemoryStore();
    const relations: StoredRelation[] = [];
    const relationStore = new InMemoryRelationStore(memoryStore, relations);
    expect(relationStore).toBeInstanceOf(InMemoryRelationStore);
    // 共有した配列は memoryStore.relations と同じ型である
    const shared: StoredRelation[] = memoryStore.relations;
    expect(shared).toEqual([]);
  });
});
