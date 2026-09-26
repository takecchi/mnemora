// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #816（NUL 側のみ。孤立サロゲート側は本 PR の対象外——別途の製品判断が要ると
// Issue 本文が明記している）: `InMemoryMemoryStore.createMemory` に NUL 文字
// （`\u0000`）を含む `content` を渡すと、例外を投げず静かに受け入れていた。
// `PostgresMemoryStore.createMemory` は Postgres の `text` 型が NUL バイトを構造的に
// 拒む（C 文字列表現に由来する制約）ため、`invalid byte sequence for encoding "UTF8":
// 0x00` で例外を投げる（実測: 本物の Postgres 17 + pgvector を手元に立てて確認した）。
//
// 範囲の切り方: Issue #816 本文は `content`・`tenantId`・`subjectId`・`tags` の要素に
// 同じ制約が及ぶことを示唆している。実測すると `tenantId`（`ctx` 経由）・`subjectId`・
// `tags`・`digest` のいずれに NUL を含めても Postgres は同じ理由で例外を投げることを
// 確認したが、この PR では `content` だけを塞ぐ——`tenantId` は `ctx` を通じてほぼ
// 全メソッドが共有する横断的な値であり、`createMemory` だけを直しても他のメソッド
// （`get`/`reinforce` 等）では素通りのままで一貫しない。`subjectId`/`tags`/`digest` を
// 含めるかどうかは Issue 本文が「設計判断が要る」と明記しており、ここでは最も典型的な
// 入力面（LLM の抽出結果がそのまま入りうる本文）である `content` に絞る。
//
// 孤立サロゲート（`\uD800` 等）は対象外——Issue #816 が指摘するとおり、Postgres 側の
// 挙動（node-postgres が U+FFFD へ静かに置換する）は `packages/postgres` のコードでは
// 変えられず、Fake 側をどちらに寄せるかは製品判断が要る。
//
// このテストは Fake を直接呼ぶだけで、`*-conformance.ts` には一切触れていない
// （Issue #809 と同じ理由。PR #811/#812 の作法を踏襲）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.createMemory: content に NUL 文字を含むと Postgres と同じく例外を投げる", () => {
  it("content の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h1",
          content: "abc\u0000def",
        }),
      ),
    ).rejects.toThrow(/must not contain NUL/);
    const all = store.listByTenant(ctx);
    expect(all).toHaveLength(0);
  });

  it("NUL を含まない content は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h2", content: "abcdef" }),
    );
    expect(memory.content).toBe("abcdef");
  });
});
