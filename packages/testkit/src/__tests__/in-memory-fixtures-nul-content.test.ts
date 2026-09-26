// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #816（NUL 側。孤立サロゲート側はここでは扱わない——別途の製品判断が要ると
// Issue 本文が明記している）: `InMemoryMemoryStore.createMemory` に NUL 文字
// （`\u0000`）を含む `content`/`subjectId`/`tags`/`digest` を渡すと、例外を投げず
// 静かに受け入れていた。`PostgresMemoryStore.createMemory` は Postgres の `text` 型が
// NUL バイトを構造的に拒む（C 文字列表現に由来する制約）ため、`invalid byte sequence
// for encoding "UTF8": 0x00` で例外を投げる（実測: 本物の Postgres 17 + pgvector を
// 手元に立て、`content`・`subjectId`・`tags`・`digest` の4欄それぞれに NUL を含めて
// 確認した。4欄とも同じメッセージで例外になる）。
//
// PR #923 の時点ではこのファイルは `content` だけを塞いでいた（同 PR の comment
// 「本 PR では content だけに絞る」）。本 PR（Issue #816 の残り）でその文言どおり
// `subjectId`・`tags`（各要素）・`digest` にも同じ検査を広げた——実測すると、この
// 4欄はどれも Postgres が同じ理由（`text` 型の NUL 拒否）で例外にする、対称な入力面
// だったため。
//
// `tenantId` は対象外のまま——`ctx` を通じてほぼ全メソッドが共有する横断的な値であり、
// `createMemory` の入口だけを直しても `get`/`reinforce` 等の他のメソッドでは `ctx.tenantId`
// を直接読んでいて素通りのままで一貫しない（`InMemoryMemoryStore`/`FakeMemoryStore`
// のどちらも `ctx` を受ける共通の入口を持たない）。`tenantId` を含めるには全メソッドへの
// 横展開が要り、本 PR の範囲を超えるためここでは扱わない。
//
// 孤立サロゲート（`\uD800` 等）は対象外——Issue #816 が指摘するとおり、Postgres 側の
// 挙動（node-postgres が U+FFFD へ静かに置換する）は `packages/postgres` のコードでは
// 変えられず、Fake 側をどちらに寄せるかは製品判断が要る。今の挙動（Postgres は
// 静かに U+FFFD へ置換、Fake はそのまま保持——どちらも例外にはならない）は契約として
// `InMemoryMemoryStore.createMemory` の doc コメントに記録した。
//
// このテストは Fake を直接呼ぶだけで、`*-conformance.ts` には一切触れていない
// （Issue #809 と同じ理由。PR #811/#812/#923 の作法を踏襲）。

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

describe("InMemoryMemoryStore.createMemory: subjectId に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("subjectId の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h-subject-nul",
          subjectId: "abc\u0000def",
        }),
      ),
    ).rejects.toThrow(/subjectId must not contain NUL/);
    expect(store.listByTenant(ctx)).toHaveLength(0);
  });

  it("subjectId が null は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-subject-ok",
        subjectId: null,
      }),
    );
    expect(memory.subjectId).toBeNull();
  });
});

describe("InMemoryMemoryStore.createMemory: tags の要素に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("tags[0] の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h-tags-nul",
          tags: ["ok-tag", "abc\u0000def"],
        }),
      ),
    ).rejects.toThrow(/tags must not contain NUL/);
    expect(store.listByTenant(ctx)).toHaveLength(0);
  });

  it("NUL を含まない tags は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-tags-ok", tags: ["a", "b"] }),
    );
    expect(memory.tags).toEqual(["a", "b"]);
  });
});

describe("InMemoryMemoryStore.createMemory: digest に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り）", () => {
  it("digest の途中に NUL を含むと例外を投げ、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "h-digest-nul",
          digest: "abc\u0000def",
        }),
      ),
    ).rejects.toThrow(/digest must not contain NUL/);
    expect(store.listByTenant(ctx)).toHaveLength(0);
  });

  it("NUL を含まない digest は引き続き成功する（回帰確認）", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "h-digest-ok", digest: "ok" }),
    );
    expect(memory.digest).toBe("ok");
  });
});
