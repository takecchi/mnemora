import type { Ctx, MemoryId, Relation, RelationKind, RelationStore } from "@mnemora/core";
import type { InMemoryMemoryStore, StoredRelation } from "./in-memory-memory-store.js";
import { nextId } from "./id.js";

/**
 * `RelationStore` の in-memory 実装（Issue #207/#933 PR2、ADR 0381）。
 *
 * **群の作成・解消（`markContestedGroup`/`resolveContestedGroup`）はここではない**——
 * `InMemoryMemoryStore` が自分の `relations` 配列へ直接書く（`PostgresMemoryStore` が
 * `memory_relations` へ直接 SQL を発行するのと同じ作法。`in-memory-memory-store.ts`
 * の `StoredRelation` の doc コメント参照）。この class が持つのは単発の `link`/`unlink`
 * と、読み取り専用の `listRelated` だけ——`InMemoryEventStore`/`InMemoryOutboxStore` と
 * 同じ「共有した配列を読み書きする薄いラッパー」の形。
 */
export class InMemoryRelationStore implements RelationStore {
  constructor(
    _memoryStore: InMemoryMemoryStore,
    private readonly relations: StoredRelation[] = [],
  ) {}

  async link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    const exists = this.relations.some(
      (r) =>
        r.tenantId === ctx.tenantId &&
        r.fromMemoryId === fromId &&
        r.toMemoryId === toId &&
        r.kind === kind,
    );
    if (exists) return;
    this.relations.push({
      id: nextId("rel"),
      tenantId: ctx.tenantId,
      fromMemoryId: fromId,
      toMemoryId: toId,
      kind,
      createdAt: new Date(),
    });
  }

  async unlink(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    for (let i = this.relations.length - 1; i >= 0; i--) {
      const r = this.relations[i]!;
      if (
        r.tenantId === ctx.tenantId &&
        r.fromMemoryId === fromId &&
        r.toMemoryId === toId &&
        r.kind === kind
      ) {
        this.relations.splice(i, 1);
      }
    }
  }

  async listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]> {
    return this.relations
      .filter(
        (r) =>
          r.tenantId === ctx.tenantId &&
          r.fromMemoryId === memoryId &&
          (kind === undefined || r.kind === kind),
      )
      .map((r) => ({ memoryId: r.toMemoryId, kind: r.kind, createdAt: r.createdAt }));
  }
}
