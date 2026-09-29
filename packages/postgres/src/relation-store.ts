import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, Relation, RelationKind, RelationStore } from "@mnemora/core";
import type { Db } from "./client.js";
import { normalizeUuidCase, parsePgTimestamp } from "./mapping.js";

/** `memory_relations` の1行。`listRelated` の組み立てにだけ使う内部形。 */
interface MemoryRelationRow {
  from_memory_id: string;
  to_memory_id: string;
  kind: string;
  created_at: string;
}

/**
 * `RelationStore` の Postgres 実装（Issue #207/#933 PR2、ADR 0292 決定1、ADR 0381）。
 *
 * **群の作成・解消（`markContestedGroup?`/`resolveContestedGroup?`）はここではない**
 * ——`PostgresMemoryStore` が自分のトランザクションの中で `memory_relations` へ直接
 * SQL を発行する（`memory-store.ts` の doc コメント参照）。この class が持つのは
 * 単発の `link`/`unlink`（トランザクション外）と、読み取り専用の `listRelated` だけ。
 */
export class PostgresRelationStore implements RelationStore {
  constructor(private readonly db: Db) {}

  async link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    const from = normalizeUuidCase(fromId);
    const to = normalizeUuidCase(toId);
    await this.db.execute(sql`
      INSERT INTO memory_relations (id, tenant_id, from_memory_id, to_memory_id, kind)
      VALUES (gen_random_uuid(), ${ctx.tenantId}, ${from}, ${to}, ${kind})
      ON CONFLICT (tenant_id, from_memory_id, to_memory_id, kind) DO NOTHING
    `);
  }

  async unlink(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    const from = normalizeUuidCase(fromId);
    const to = normalizeUuidCase(toId);
    await this.db.execute(sql`
      DELETE FROM memory_relations
      WHERE tenant_id = ${ctx.tenantId}
        AND from_memory_id = ${from}
        AND to_memory_id = ${to}
        AND kind = ${kind}
    `);
  }

  async listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]> {
    const id = normalizeUuidCase(memoryId);
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
