import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ⚠ 引数なしの `.rejects.toThrow()` は使わない。「何か失敗した」では型不一致やドライバの別のエラーでも満たされてしまい、
 * 外部キー制約が実際に効いていることの証明にならない。SQLSTATE `23503`（`foreign_key_violation`）そのものを検査する。
 * フィクスチャは非対称にする。実在しない recallId では失敗し、実在する recallId では成功することを同じ検査の中で見る。
 * そうしないと「recordUsage が常に失敗する」実装が通ってしまう。
 */
/**
 * 例外の連鎖から PostgreSQL の SQLSTATE を取り出す。
 *
 * ⚠ `PostgresMemoryStore` は drizzle の `db.execute()` を使っており、drizzle が `Error: Failed query: ...` で包むので、SQLSTATE は `cause` の側に入る。
 * `code` を直接読むと `undefined` になる。連鎖を辿って探し、見つからなければ `undefined` を返して呼び出し側の assertion を落とす。上限の 8 は余裕。
 */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("PostgresMemoryStore.recordUsage — 外部キー違反（ADR 0047 の決め手）", () => {
  it("実在しない recallId に対しては失敗し（外部キーも今も効いている）、実在する recallId では成功する", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-fk-decisive" };

    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));

    const missingRecallId = randomUUID();
    // store の口は外部キーに当たる前に「ctx のテナントの recall か」を同じ SQL 文の中で確かめるので、store 越しには `recall not found for tenant` で拒まれる（生の 23503 は利用者に見えない）。
    await expect(store.recordUsage(ctx, missingRecallId, [memory.id])).rejects.toThrow(
      /PostgresMemoryStore: recall not found for tenant: /,
    );
    // 外部キー制約そのものは今も効いている。生 SQL で同じ行を書くと SQLSTATE 23503 になる。
    let caught: unknown;
    await pool
      .query("INSERT INTO recall_usages (tenant_id, recall_id, memory_id) VALUES ($1, $2, $3)", [
        ctx.tenantId,
        missingRecallId,
        memory.id,
      ])
      .catch((error: unknown) => {
        caught = error;
      });
    expect(caught).toBeDefined();
    expect(sqlStateOf(caught)).toBe("23503");

    const recallId = await store.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
    });
    const result = await store.recordUsage(ctx, recallId, [memory.id]);
    expect(result.insertedMemoryIds).toEqual([memory.id]);
  });
});

afterAll(async () => {
  await closeTestClient();
});
