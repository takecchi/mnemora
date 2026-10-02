import type { Ctx, MemoryId, Relation, RelationKind, RelationStore } from "@mnemora/core";
import { assertWellFormedCtx } from "@mnemora/core";
import type { InMemoryMemoryStore, StoredRelation } from "./in-memory-memory-store.js";
import { nextId } from "./id.js";

/**
 * `memory_relations.kind` に入れてよい値（`RelationKind` の全値）。`Record<RelationKind, true>` で持つので、
 * union に値を足すと、ここに足し忘れた時点で型検査が落ちる。
 */
const KNOWN_RELATION_KINDS: Record<RelationKind, true> = { contradicts: true };

function assertKnownRelationKind(store: string, kind: string): void {
  if (!Object.hasOwn(KNOWN_RELATION_KINDS, kind)) {
    throw new Error(`${store}: unknown relation kind: ${String(kind)}`);
  }
}

/**
 * `RelationStore` の in-memory 実装（Issue #207/#933 PR2、ADR 0381）。
 *
 * **群の作成・解消（`markContestedGroup`/`resolveContestedGroup`）はここではない**——
 * `InMemoryMemoryStore` が自分の `relations` 配列へ直接書く（`PostgresMemoryStore` が
 * `memory_relations` へ直接 SQL を発行するのと同じ作法。`in-memory-memory-store.ts`
 * の `StoredRelation` の doc コメント参照）。この class が持つのは単発の `link`/`unlink`
 * と、読み取り専用の `listRelated`・`listRelatedMany` だけ——`InMemoryEventStore`/`InMemoryOutboxStore` と
 * 同じ「共有した配列を読み書きする薄いラッパー」の形。
 */
export class InMemoryRelationStore implements RelationStore {
  constructor(
    private readonly memoryStore: InMemoryMemoryStore,
    private readonly relations: StoredRelation[] = [],
  ) {}

  /**
   * 両端の記憶が `ctx.tenantId` の記憶であることを、渡された `InMemoryMemoryStore` で確かめてから書く
   * （ADR 0398。`PostgresRelationStore.link` と同じ振る舞い）。無ければ `memory not found for tenant`。
   */
  async link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    // 列挙の外の kind は、Postgres の CHECK（`0026_memory_relations.sql`）の違反を漏らさず、INSERT の前に断る。
    assertKnownRelationKind("InMemoryRelationStore", kind);
    // ADR 0521: 大文字の id も同じ記憶として受け、小文字（この fixture の id の綴り）で持つ。
    fromId = fromId.toLowerCase() as MemoryId;
    toId = toId.toLowerCase() as MemoryId;
    for (const id of [fromId, toId]) {
      if ((await this.memoryStore.get(ctx, id)) === null) {
        throw new Error(`InMemoryRelationStore: memory not found for tenant: ${id}`);
      }
    }
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
    assertWellFormedCtx(ctx);
    fromId = fromId.toLowerCase() as MemoryId;
    toId = toId.toLowerCase() as MemoryId;
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
    assertWellFormedCtx(ctx);
    return this.relatedOf(ctx, memoryId, kind);
  }

  /** `listRelated` を起点ごとに行い、起点と同じ位置に並べる（Issue #1449、ADR 0402）。 */
  async listRelatedMany(
    ctx: Ctx,
    memoryIds: readonly MemoryId[],
    kind?: RelationKind,
  ): Promise<Relation[][]> {
    assertWellFormedCtx(ctx);
    return memoryIds.map((id) => this.relatedOf(ctx, id, kind));
  }

  private relatedOf(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Relation[] {
    memoryId = memoryId.toLowerCase() as MemoryId;
    // ADR 0488: `PostgresRelationStore` と同じく、`kind` が偽の値（`undefined`・`""`・`null`・`0`）なら絞り込まない。
    return (
      this.relations
        .filter(
          (r) =>
            r.tenantId === ctx.tenantId &&
            r.fromMemoryId === memoryId &&
            (!kind || r.kind === kind),
        )
        // Issue #1108: 保存している Date をそのまま返さない（呼び手が書き換えても行は変わらない）。
        .map((r) => ({ memoryId: r.toMemoryId, kind: r.kind, createdAt: new Date(r.createdAt) }))
    );
  }
}
