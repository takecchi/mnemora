import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** 報告者が書く形の問い（自然文）として1件ずつ通す。識別子だけを渡す歯がすべて緑でも、自然文の形では1件も引けない欠陥を通してしまう。 */

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

    expect(ids).toContain(target.id);

    const hit = hits.find((h) => h.memoryId === target.id);
    expect(hit).toBeDefined();
    // 期待値は「0 より大きく 1 未満」の範囲でだけ主張する。「一致数 ÷ クエリ語彙数」を歯に書き写すと、実装のバグと自己整合してしまう。
    expect(hit!.coverage).toBeGreaterThan(0);
    expect(hit!.coverage).toBeLessThan(1);

    // ⚠ 偽陽性の点検: 識別子を含まない同種の自然文は0件のままである。
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
      "gurumi-chan-frontend release went smoothly.",
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
      "#proj-beta had a completely different rollout plan.",
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

    const hits = await lexicalStore.search(ctx, "田中さんについて何か言ってましたか", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    // ⚠ これは「直っていない」ことを主張する歯である。⛔ 直そうとしていない。
    // クエリ側は非 ASCII の連なりを空白に落とすので、全体が日本語のクエリは語彙が1つも残らず空の tsquery になり、何が本文に在っても一致しない。
    // この歯が赤くなったら ADR 0149 の前提が変わったことを意味する。歯とドキュメント（docs/recall.md・packages/postgres/README.md）を揃えて更新すること。消す・緩めるだけで済ませないこと。
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

    // `"..."` で語ごとに囲む設計が、OR で結んだ後も隣接要求（接頭辞と番号の取り違えを防ぐ）を保っていることの検査。
    const crossHits = await lexicalStore.search(ctx, "PROJ-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(crossHits).toEqual([]);

    const presentHits = await lexicalStore.search(ctx, "TASK-5678", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(presentHits.length).toBe(1);
  });

  it("8. ⚠ OR の副作用: ありふれた語だけを共有する記憶も候補に入る — 被覆率が下へ押すだけである（ADR 0084 §8 の負債は塞がっていない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const target = await createMemory(
      memoryStore,
      ctx,
      "hash-q8-target",
      "The gurumi-chan-backend deploy failed twice this week.",
    );
    // 識別子を1つも共有しない。共有するのは "deploy" という、ありふれた語1つだけ。
    const noise = await createMemory(
      memoryStore,
      ctx,
      "hash-q8-noise",
      "The nightly deploy pipeline was migrated to a new runner.",
    );

    const hits = await lexicalStore.search(
      ctx,
      "anything about gurumi-chan-backend deploy failures",
      {
        limit: 10,
        filter: { tenantId: TENANT },
      },
    );
    const ids = hits.map((h) => h.memoryId);

    // OR にしたので noise は候補に入る。設計どおりであり、隠さずここで主張する。
    expect(ids).toContain(target.id);
    expect(ids).toContain(noise.id);

    const targetHit = hits.find((h) => h.memoryId === target.id);
    const noiseHit = hits.find((h) => h.memoryId === noise.id);
    expect(targetHit).toBeDefined();
    expect(noiseHit).toBeDefined();

    expect(targetHit!.coverage).toBeGreaterThan(noiseHit!.coverage);
    expect(ids[0]).toBe(target.id);

    // ⚠ 「押し下げた」だけで、塞いでいない。ありふれた語1語だけのクエリを投げれば、その語を含む記憶が全件 coverage 1 で並ぶ。
    const lowSelectivity = await lexicalStore.search(ctx, "deploy", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    expect(lowSelectivity.length).toBe(2);
    expect(lowSelectivity.every((h) => h.coverage === 1)).toBe(true);
  });
});
