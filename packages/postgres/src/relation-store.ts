import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, Relation, RelationKind, RelationStore } from "@mnemora/core";
import { assertWellFormedCtx } from "@mnemora/core";
import type { Db } from "./client.js";
import { isUuidLike, normalizeUuidCase, parsePgTimestamp } from "./mapping.js";

/** `memory_relations` の1行。`listRelated` の組み立てにだけ使う内部形。 */
interface MemoryRelationRow {
  from_memory_id: string;
  to_memory_id: string;
  kind: string;
  created_at: string;
}

/** 他の store（`PostgresMemoryStore` ほか）と同じ形の「そのテナントに無い」例外。 */
function memoryNotFound(id: string): Error {
  return new Error(`PostgresRelationStore: memory not found for tenant: ${id}`);
}

/**
 * `memory_relations.kind` に入れてよい値（`RelationKind` の全値。`0026_memory_relations.sql` の CHECK と同じ）。
 * `Record<RelationKind, true>` で持つので、union に値を足すと、ここに足し忘れた時点で型検査が落ちる。
 */
const KNOWN_RELATION_KINDS: Record<RelationKind, true> = { contradicts: true };

/**
 * 列挙の外の kind は、CHECK 制約違反（生の DB エラー）を利用者へ漏らさず、INSERT の前にこの例外で断る。
 */
function unknownRelationKind(kind: string): Error {
  return new Error(`PostgresRelationStore: unknown relation kind: ${String(kind)}`);
}

/**
 * `RelationStore` の Postgres 実装（Issue #207/#933 PR2、ADR 0292 決定1、ADR 0381）。
 *
 * **群の作成・解消（`markContestedGroup?`/`resolveContestedGroup?`）はここではない**
 * ——`PostgresMemoryStore` が自分のトランザクションの中で `memory_relations` へ直接
 * SQL を発行する（`memory-store.ts` の doc コメント参照）。この class が持つのは
 * 単発の `link`/`unlink`（トランザクション外）と、読み取り専用の `listRelated`・`listRelatedMany` だけ。
 */
export class PostgresRelationStore implements RelationStore {
  constructor(private readonly db: Db) {}

  /**
   * 両端の記憶が `ctx.tenantId` の `memories` に在ることを確かめてから書く（ADR 0398）。
   * 確かめと書き込みは**1文**（存在検査の CTE と INSERT を同じ文に載せる）——検査と書き込みの間に
   * 別の文が挟まる窓を作らない。uuid の形でない id は DB へ投げる前に弾く（`isUuidLike` の doc 参照）。
   * どちらの端も在らなければ、行を書かずに `memory not found for tenant` を投げる
   * （他の store の同種の例外と同じ形。DB 由来のエラーは利用者に見せない）。
   *
   * ⚠ 「行を書いたか」ではなく「両端が在ったか」を返り値の `ok` で見る——既に同じ行が在って
   * `ON CONFLICT DO NOTHING` が0行にした場合（冪等）と、検査で落ちた場合を、書き込みの行数では
   * 区別できないため。
   */
  async link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    if (!Object.hasOwn(KNOWN_RELATION_KINDS, kind)) {
      throw unknownRelationKind(kind);
    }
    const from = normalizeUuidCase(fromId);
    const to = normalizeUuidCase(toId);
    if (!isUuidLike(from)) {
      throw memoryNotFound(from);
    }
    if (!isUuidLike(to)) {
      throw memoryNotFound(to);
    }
    const result = await this.db.execute(sql`
      WITH ends AS (
        SELECT
          EXISTS (SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${from}) AS from_ok,
          EXISTS (SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${to}) AS to_ok
      ),
      ins AS (
        INSERT INTO memory_relations (id, tenant_id, from_memory_id, to_memory_id, kind)
        SELECT gen_random_uuid(), ${ctx.tenantId}, ${from}, ${to}, ${kind}
        FROM ends
        WHERE from_ok AND to_ok
        ON CONFLICT (tenant_id, from_memory_id, to_memory_id, kind) DO NOTHING
      )
      SELECT from_ok, to_ok FROM ends
    `);
    const ends = result.rows[0] as unknown as { from_ok: boolean; to_ok: boolean } | undefined;
    if (!ends?.from_ok) {
      throw memoryNotFound(from);
    }
    if (!ends.to_ok) {
      throw memoryNotFound(to);
    }
  }

  async unlink(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    const from = normalizeUuidCase(fromId);
    const to = normalizeUuidCase(toId);
    // uuid の形でない id は、存在しない id と同じ（張られている行は無い）ので何もしない。
    if (!isUuidLike(from) || !isUuidLike(to)) {
      return;
    }
    await this.db.execute(sql`
      DELETE FROM memory_relations
      WHERE tenant_id = ${ctx.tenantId}
        AND from_memory_id = ${from}
        AND to_memory_id = ${to}
        AND kind = ${kind}
    `);
  }

  /**
   * `listRelated` を複数の起点に対して1文（`from_memory_id = ANY(...)`）で行う（Issue #1449、ADR 0402。
   * 契約は `RelationStore.listRelatedMany` の doc）。`result[i]` は `memoryIds[i]` の相手側の一覧——
   * 起点ごとの分け方は uuid を小文字にそろえたキーで行うので、渡した id の綴りの揺れに依らない。
   * uuid の形でない id は DB へ投げず（型変換エラーでバッチ全体が落ちるため）、その位置は空配列にする。
   * 重複した id は1回だけ DB へ渡し、位置ごとに別々の配列を返す。
   */
  async listRelatedMany(
    ctx: Ctx,
    memoryIds: readonly MemoryId[],
    kind?: RelationKind,
  ): Promise<Relation[][]> {
    assertWellFormedCtx(ctx);
    const ids = memoryIds.map((id) => normalizeUuidCase(id));
    const queryable = [...new Set(ids.filter((id) => isUuidLike(id)))];
    const byFrom = new Map<string, Relation[]>();
    if (queryable.length > 0) {
      const result = kind
        ? await this.db.execute(sql`
            SELECT from_memory_id, to_memory_id, kind, created_at FROM memory_relations
            WHERE tenant_id = ${ctx.tenantId}
              AND from_memory_id = ANY(${sql.param(queryable)}::uuid[])
              AND kind = ${kind}
          `)
        : await this.db.execute(sql`
            SELECT from_memory_id, to_memory_id, kind, created_at FROM memory_relations
            WHERE tenant_id = ${ctx.tenantId}
              AND from_memory_id = ANY(${sql.param(queryable)}::uuid[])
          `);
      for (const row of result.rows) {
        const r = row as unknown as MemoryRelationRow;
        const list = byFrom.get(r.from_memory_id) ?? [];
        list.push({
          memoryId: r.to_memory_id as MemoryId,
          kind: r.kind as RelationKind,
          createdAt: parsePgTimestamp(r.created_at),
        });
        byFrom.set(r.from_memory_id, list);
      }
    }
    return ids.map((id) => (byFrom.get(id) ?? []).map((r) => ({ ...r })));
  }

  async listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]> {
    assertWellFormedCtx(ctx);
    const id = normalizeUuidCase(memoryId);
    // uuid の形でない id は、存在しない id と同じ（関係は無い）ので、DB へ投げず空を返す。
    if (!isUuidLike(id)) {
      return [];
    }
    const result = kind
      ? await this.db.execute(sql`
          SELECT from_memory_id, to_memory_id, kind, created_at FROM memory_relations
          WHERE tenant_id = ${ctx.tenantId} AND from_memory_id = ${id} AND kind = ${kind}
        `)
      : await this.db.execute(sql`
          SELECT from_memory_id, to_memory_id, kind, created_at FROM memory_relations
          WHERE tenant_id = ${ctx.tenantId} AND from_memory_id = ${id}
        `);
    return result.rows.map((row) => {
      const r = row as unknown as MemoryRelationRow;
      return {
        memoryId: r.to_memory_id as MemoryId,
        kind: r.kind as RelationKind,
        createdAt: parsePgTimestamp(r.created_at),
      };
    });
  }
}
