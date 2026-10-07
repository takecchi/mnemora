import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, InMemoryRelationStore } from "../fixtures.js";
import type { StoredRelation } from "../fixtures.js";

/** この歯の本体は上の `import type`。入口から export されていないと typecheck が TS2459 で落ちる（vitest は型を検査しない）。 */
describe("testkit/fixtures 入口の公開型", () => {
  it("StoredRelation[] を明示して InMemoryRelationStore に渡せる", () => {
    const memoryStore = new InMemoryMemoryStore();
    const relations: StoredRelation[] = [];
    const relationStore = new InMemoryRelationStore(memoryStore, relations);
    expect(relationStore).toBeInstanceOf(InMemoryRelationStore);
    const shared: StoredRelation[] = memoryStore.relations;
    expect(shared).toEqual([]);
  });
});
