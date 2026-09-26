// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// `InMemoryVectorStore.search` の tie-break は Issue #339 / ADR 0170 で
// `in-memory-vector-store-tiebreak.test.ts` により直っているが、`InMemoryLexicalStore.search`
// には同じ形の不一致が残っていた。
//
// `packages/core/src/interfaces/lexical-store.ts` の `LexicalStore.search` doc は
// 「`coverage`/`rank` の両方が完全に一致する行が複数あるときの順序も、adapter の責務である」
// と明記し（Issue #345 / ADR 0175）、`PostgresLexicalStore` は
// `coverage → rank → recorded_at DESC → id` の4段で tie-break すると名指しし、
// 「adapter を新しく書くときは、coverage/rank だけでなく完全なタイブレークまで含めて
// 決定的な順序を返すこと」と要求している。
//
// `InMemoryLexicalStore.search` は `hits.sort((a, b) => b.coverage - a.coverage ||
// b.rank - a.rank)` の2段止まりで、同点の中身は `Array.prototype.sort` の安定性により
// **挿入順**（＝通常の呼び出し順では `recordedAt` が古いほうが先）に落ちる——
// `recorded_at` DESC（新しい方が先）とは**逆向き**になる。
//
// 実測: 本物の Postgres 17 + pgvector を手元に立て、`PostgresLexicalStore.search` に
// 完全に同じ `content` を持つ2件（`recordedAt` だけが異なる）を渡すと、新しい方
// （`recordedAt` が新しい行）が常に先に返ることを確認した（使い捨てスクリプトで確認、
// このコミットには含めない）。`PostgresTrigramLexicalStore` は自分の doc コメントで
// 「`search` の `ORDER BY` は `PostgresLexicalStore` と同じ4段」と明記しており、
// ソースの `ORDER BY` 句も文字どおり同じ（`packages/postgres/src/trigram-lexical-store.ts`
// 505行目）——**ただしこちらは実行環境の locale 制約（日本語 trigram 未対応）により、
// このコミットの作業では直接実行できていない**（読んだだけ）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT = "lexical-search-tiebreak-tenant";
const CONTENT = "同じ内容のテスト用本文";

describe("InMemoryLexicalStore.search — coverage/rank が完全一致したときの tie-break（LexicalStore.search doc / ADR 0175）", () => {
  it("recorded_at が新しい方を先に返す（PostgresLexicalStore.search と同じ契約）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    const older = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-older",
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const newer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-newer",
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );

    const hits = await lexicalStore.search(ctx, CONTENT, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);
    expect(hits[0]!.memoryId).toBe(newer.id);
    expect(hits[1]!.memoryId).toBe(older.id);
  });

  it("recorded_at まで完全一致したら memory_id 昇順にフォールバックする（欠落・重複が無い）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    const sameRecordedAt = new Date("2026-01-01T00:00:00.000Z");

    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-a",
        recordedAt: sameRecordedAt,
      }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: CONTENT,
        contentHash: "lexical-tie-b",
        recordedAt: sameRecordedAt,
      }),
    );

    const hits = await lexicalStore.search(ctx, CONTENT, {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.memoryId))).toEqual(new Set([a.id, b.id]));
    const [smaller, larger] = [a.id, b.id].sort();
    expect(hits[0]!.memoryId).toBe(smaller);
    expect(hits[1]!.memoryId).toBe(larger);
  });
});
