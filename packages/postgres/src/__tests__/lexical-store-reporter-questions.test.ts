import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #106 の報告者が実際に挙げた5種類（人名・チャンネル名・社内システム名・案件コード・
 * チケット番号）を、**報告者が書く形の問い**として1件ずつ通す歯（[ADR 0092](../../../docs/decisions/0092-lexical-or-coverage.md)）。
 *
 * **なぜこの歯がいる**か——PR #115（ADR 0084）でいちばん価値があった発見はこうだった:
 * 「当初の実装は、Issue #106 の報告者が書いた問いの形そのもので1件も引けなかった。
 * 識別子だけを渡す歯はすべて緑だったので、歯では見つからなかった。」
 * `lexical-store-identifier.test.ts` の歯は識別子単体（`"PROJ-1234"`）を渡す形が
 * 中心であり、**報告者が実際に書いた自然文の形**（特に英語の自然文）は
 * まだ1本も検査されていない。この歯はその穴を塞ぐ。
 *
 * ADR 0084 §2.1.1 の非対称（クエリ側は非 ASCII を落とす）により、日本語の文に
 * 埋もれた ASCII の識別子は、クエリ側でも日本語部分が落ちて実質「識別子1語」の
 * クエリになる。**英語の自然文だけが、複数語のクエリという意味で新しい経路を通る**
 * ——ADR 0084 はここを AND で結んでいたため「全語を含む記憶しか返らない」という
 * 負債を抱えていた（§8）。ADR 0092 はこれを OR + 被覆率に変える。
 */

const TENANT = "lexical-reporter-questions-tenant";

async function createMemory(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  contentHash: string,
  content: string,
) {
  return memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: TENANT, contentHash, content }),
  );
}

describe("PostgresLexicalStore.search — Issue #106 の報告者が挙げた5種類を、報告者が書く形の問いで引ける（ADR 0092）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("1. 日本語の文に埋まった案件コード（報告者の逐語: 「PROJ-1234について前に何か言ってたはず」）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await createMemory(
      memoryStore,
      ctx,
      "hash-q1-target",
      "先週のミーティングでPROJ-1234の予算超過が話題になりました",
    );
    const distractor = await createMemory(
      memoryStore,
      ctx,
      "hash-q1-distractor",
      "サブシステムの担当はPROJ-5678の方です",
    );

    const hits = await lexicalStore.search(ctx, "PROJ-1234について前に何か言ってたはず", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(target.id);
    expect(ids).not.toContain(distractor.id);
  });

  it("2. 英語の自然文（本体: `what did we say about PROJ-1234`）— OR + 被覆率でなければ0件だった経路", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await createMemory(
      memoryStore,
      ctx,
      "hash-q2-target",
      "Budget for PROJ-1234 was discussed in yesterday's sync.",
    );

    const hits = await lexicalStore.search(ctx, "what did we say about PROJ-1234", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const ids = hits.map((h) => h.memoryId);

    // 🔴 AND 意味論（ADR 0084 の旧契約）なら、content に "what"/"did"/"we"/"say"/"about" の
    // いずれも現れないため必ず0件だった。OR + 被覆率だからこそ、PROJ-1234 の一致だけで
    // この記憶が返る。
    expect(ids).toContain(target.id);

    const hit = hits.find((h) => h.memoryId === target.id);
    expect(hit).toBeDefined();
    // クエリ語彙は what/did/we/say/about/proj-1234 の6語。一致するのは proj-1234 の1語だけ
    // ——coverage は 1/6 になるはずだが、「一致数 ÷ クエリ語彙数」を歯に書き写すと
    // 実装のバグと自己整合してしまうため、期待値は「0 より大きく 1 未満」という
    // 逐語の範囲でだけ主張する。
    expect(hit!.coverage).toBeGreaterThan(0);
    expect(hit!.coverage).toBeLessThan(1);

    // ⚠ 偽陽性の点検: 識別子を含まない同種の自然文は0件のままである
    // （「OR にしたら何でも返るようになった」わけではないことの確認）。
    const noIdentifierHits = await lexicalStore.search(
      ctx,
      "what did we say about nonexistent topic",
      { limit: 10, filter: { tenantId: TENANT } },
    );
    expect(noIdentifierHits.map((h) => h.memoryId)).not.toContain(target.id);
  });

  it("3. チケット番号を含む英語の自然文（TASK-5678）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await createMemory(
      memoryStore,
      ctx,
      "hash-q3-target",
      "TASK-5678 was closed after the last sprint review.",
    );
    const distractor = await createMemory(
      memoryStore,
      ctx,
      "hash-q3-distractor",
      "TASK-1234 is still blocked on design review.",
    );

    const hits = await lexicalStore.search(
      ctx,
      "can you remind me what happened with TASK-5678 last sprint",
      { limit: 10, filter: { tenantId: TENANT } },
    );
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(target.id);
    expect(ids).not.toContain(distractor.id);
  });

  it("4. 社内システム名（ASCII 識別子 gurumi-chan-backend）を含む自然文", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await createMemory(
      memoryStore,
      ctx,
      "hash-q4-target",
      "The gurumi-chan-backend deploy failed twice this week.",
    );
    const distractor = await createMemory(
      memoryStore,
      ctx,
      "hash-q4-distractor",
      "The gurumi-chan-frontend release went smoothly.",
    );

    const hits = await lexicalStore.search(
      ctx,
      "is there anything about gurumi-chan-backend in the notes",
      { limit: 10, filter: { tenantId: TENANT } },
    );
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(target.id);
    expect(ids).not.toContain(distractor.id);
  });

  it("5. チャンネル名（ASCII 識別子 #proj-alpha）を含む自然文", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await createMemory(
      memoryStore,
      ctx,
      "hash-q5-target",
      "#proj-alpha had a long discussion about the rollout plan.",
    );
    const distractor = await createMemory(
      memoryStore,
      ctx,
      "hash-q5-distractor",
      "#proj-beta discussed a completely different rollout.",
    );

    const hits = await lexicalStore.search(
      ctx,
      "anything discussed in #proj-alpha channel recently",
      { limit: 10, filter: { tenantId: TENANT } },
    );
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(target.id);
    expect(ids).not.toContain(distractor.id);
  });

  it("6. 🔴 人名（日本語）は今も引けない（ADR 0084 §2/§8 の負債。この PR の範囲外）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await createMemory(
      memoryStore,
      ctx,
      "hash-q6-target",
      "田中さんが来週から新しいプロジェクトに参加します",
    );

    // 報告者が書きそうな自然な日本語の問い（人名を含む）。
    const hits = await lexicalStore.search(ctx, "田中さんについて何か言ってましたか", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    // 🔴 これは「直っていない」ことを主張する歯である。⛔ 直そうとしていない。
    // ADR 0084 §2.1.1: クエリ側は非 ASCII の連なりを空白に落とす
    // （`mnemora_lexical_query_terms`）。このクエリは全体が日本語（非 ASCII）なので、
    // クエリ側の語彙は1つも残らず、`mnemora_lexical_query_or` は空の tsquery を返し、
    // 何が本文に在っても一致しない。日本語の語（人名を含む）を語彙チャンネルで
    // 引けないのは ADR 0084 §2/§8 が引き受けた負債であり、ADR 0092（この PR）は
    // クエリ語彙を OR で結ぶ・被覆率を計算するという変更だけを行っており、
    // この負債を塞いでいない。
    expect(hits.map((h) => h.memoryId)).not.toContain(target.id);
    expect(hits).toEqual([]);
  });

  it("7. 🔴 誤爆しないこと: 本文に PROJ-1234 と TASK-5678 が在るとき、PROJ-5678 のクエリは一致しない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await createMemory(
      memoryStore,
      ctx,
      "hash-q7-both",
      "Cross-team sync: PROJ-1234 and TASK-5678 were both reviewed today.",
    );

    // `"..."` で語ごとに囲む設計（migrations/0009_*.sql）が、OR で結んだ後も
    // 隣接要求（接頭辞と番号の取り違えを防ぐ）を保っていることの検査。
    const crossHits = await lexicalStore.search(ctx, "PROJ-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(crossHits).toEqual([]);

    // 対照: 本文に実在する組み合わせは、同じ経路でちゃんと引ける。
    const presentHits = await lexicalStore.search(ctx, "TASK-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(presentHits.length).toBe(1);
  });
});
