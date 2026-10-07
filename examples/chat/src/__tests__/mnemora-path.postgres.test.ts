import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import type { Conversation, ConversationTurn } from "../scenario.js";
import { buildConversation } from "../scenario.js";
import { ingestConversation, queryRecall } from "../mnemora-path.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// scenario.ts は変えない（他の測定の再現性の要）。発話は scenario.ts のどの文字列とも一致させない。
function appendTailUserTurn(conversation: Conversation, text: string): Conversation {
  const lastIndex = conversation.turns[conversation.turns.length - 1]?.index ?? -1;
  const tailTurn: ConversationTurn = { index: lastIndex + 1, role: "user", text };
  return {
    turns: [...conversation.turns, tailTurn],
    userUtterances: [...conversation.userUtterances, tailTurn],
    query: conversation.query,
  };
}

// 40字以下にする。DeterministicLLMProvider が40字超の digest を切り詰め、完全一致で照合できなくなる。
const UNIQUE_TAIL_UTTERANCE = "私が飼っている猫の名前はナナです。";

describe("examples/chat: observe → recall の往復（本物の Postgres）", () => {
  it("ingestConversation → queryRecall(budget 無し) は memories/omitted/usage/index を返す", async () => {
    await resetTestDatabase();
    await getTestClient(); // マイグレーション・埋め込み空間登録を先に済ませておく
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");
      const ctx: Ctx = { tenantId: "example-chat-roundtrip" };
      const conversation = buildConversation(3);

      await ingestConversation(handle.runtime, ctx, conversation);
      const result = await queryRecall(handle.runtime, ctx, conversation);

      expect(result.memories.length).toBeGreaterThan(0);
      expect(Array.isArray(result.omitted)).toBe(true);
      expect(result.usage.chars).toBeGreaterThan(0);
      expect(result.usage.counter).toBe("heuristic");
      expect(result.index.totalInScope).toBe(conversation.userUtterances.length);
      expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("ingestConversation → queryRecall(budget 有り) は実際に候補を切り詰め、budget_dropped を報告する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-roundtrip-budget" };
      const conversation = buildConversation(10);

      await ingestConversation(handle.runtime, ctx, conversation);
      const withoutBudget = await queryRecall(handle.runtime, ctx, conversation);
      const withBudget = await queryRecall(handle.runtime, ctx, conversation, {
        budget: { maxMemoryChars: 40 },
      });

      const dropped = withBudget.omitted.find((o) => o.kind === "budget_dropped");
      expect(dropped).toBeDefined();
      expect(dropped && dropped.kind === "budget_dropped" && dropped.count).toBeGreaterThan(0);
      expect(withBudget.memories.length).toBeLessThan(withoutBudget.memories.length);
    } finally {
      await handle.close();
    }
  });

  it("会話が長くなって大幅に絞り込まれても、冒頭で表明された事実は返り値に残る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-fact-survives" };
      const conversation = buildConversation(80);
      await ingestConversation(handle.runtime, ctx, conversation);
      const result = await queryRecall(handle.runtime, ctx, conversation);

      expect(result.index.totalInScope).toBe(conversation.userUtterances.length);
      expect(result.memories.length).toBeLessThan(result.index.totalInScope / 4);

      const digests = result.memories.map((m) => m.digest);
      expect(digests.some((d) => d.includes("青"))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  // (b) は turn-0 が先着50件に必ず入るので、tick() 1回への退行では赤くならない。退行の検知は (a) だけが担う。
  it("50件を超える量を ingest しても干上がるまで embed され、pending のまま取り残される記憶が無い", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-drain-past-tick-limit" };
      const conversation = buildConversation(60);
      await ingestConversation(handle.runtime, ctx, conversation);
      const result = await queryRecall(handle.runtime, ctx, conversation);

      expect(conversation.userUtterances.length).toBeGreaterThan(50);
      expect(result.index.totalInScope).toBe(conversation.userUtterances.length);

      const pendingOmission = result.omitted.find(
        (o) => o.kind === "not_indexed" && o.reason === "pending",
      );
      expect(pendingOmission).toBeUndefined();

      const digests = result.memories.map((m) => m.digest);
      expect(digests.some((d) => d.includes("青"))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  // 末尾に置く: 先着50件の外に確実に出る位置だから。
  it("50件超で置き去りにされていた末尾の発話が、修正後は recall() で実際に拾えるようになる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-tail-recallable" };
      const base = buildConversation(60); // fact 1 + filler 60 = user発話61件
      const conversation = appendTailUserTurn(base, UNIQUE_TAIL_UTTERANCE); // 62件目

      expect(conversation.userUtterances.length).toBe(62);
      expect(conversation.userUtterances[61]?.text).toBe(UNIQUE_TAIL_UTTERANCE);
      expect(conversation.userUtterances.length).toBeGreaterThan(50);

      await ingestConversation(handle.runtime, ctx, conversation);
      // queryRecall() ではなく runtime.recall() を末尾の発話そのものの文字列で直接撃つ。
      const result = await handle.runtime.recall(ctx, { text: UNIQUE_TAIL_UTTERANCE });

      const tailMemory = result.memories.find((m) => m.digest === UNIQUE_TAIL_UTTERANCE);
      expect(tailMemory).toBeDefined();
      expect(result.memories[0]?.digest).toBe(UNIQUE_TAIL_UTTERANCE);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
