import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, PromptSpec, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { llmCassetteKey } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const ctx: Ctx = { tenantId: "observe-data-title-1185-opt-in" };
const hashContent = (content: string) => `sha256(${content})`;
const embeddingProvider = {
  space: TEST_EMBEDDING_SPACE,
  embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
};

/** 呼ばれたプロンプト（構造化した `PromptSpec`）を記録し、`fail` なら投げる偽の LLM。 */
function recordingLlm(mode: "ok" | "fail") {
  const prompts: PromptSpec[] = [];
  const llm: LLMProvider = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async (_ctx, req) => {
      prompts.push(req.prompt);
      if (mode === "fail") throw new Error("llm down");
      return req.schema.parse({
        memories: [{ content: "抽出した本文", provenanceKind: "stated" }],
      });
    },
  };
  return { llm, prompts };
}

/** `mode` を呼び出しの合間に切り替えられる偽の LLM（reextract のように、同じ runtime を
 * 失敗モード→成功モードの順で使い分けたいテストのため）。 */
function switchableLlm(initialMode: "ok" | "fail") {
  let mode = initialMode;
  const prompts: PromptSpec[] = [];
  const llm: LLMProvider = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async (_ctx, req) => {
      prompts.push(req.prompt);
      if (mode === "fail") throw new Error("llm down");
      return req.schema.parse({
        memories: [{ content: "抽出した本文", provenanceKind: "stated" }],
      });
    },
  };
  return { llm, prompts, setMode: (next: "ok" | "fail") => (mode = next) };
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

const KITS: Array<[string, (llm: LLMProvider) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (llmProvider) => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          llmProvider,
          embeddingProvider,
          hashContent,
          memoryStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async (llmProvider) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      return {
        memoryStore,
        runtime: createRuntime({
          llmProvider,
          embeddingProvider,
          hashContent,
          memoryStore,
          vectorStore: new PostgresVectorStore(db),
          eventStore: new PostgresEventStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)(
  "event.extractData / document.extractTitle（Issue #1185）: %s",
  (_name, build) => {
    it("a. extractData: true を渡すと、抽出のプロンプトに name\\n\\nJSON(data) が入る（完全一致）", async () => {
      const dataMarker = `data-の目印-${randomUUID()}`;
      const { llm, prompts } = recordingLlm("ok");
      const { runtime } = await build(llm);
      await runtime.observe(ctx, {
        kind: "event",
        name: "ログインした",
        data: { note: dataMarker },
        extractData: true,
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.messages).toHaveLength(1);
      expect(prompts[0]!.messages[0]!.content).toBe(
        `ログインした\n\n${JSON.stringify({ note: dataMarker })}`,
      );
    });

    it("a. extractTitle: true を渡すと、抽出のプロンプトに title\\n\\ncontent が入る（完全一致）", async () => {
      const titleMarker = `title-の目印-${randomUUID()}`;
      const { llm, prompts } = recordingLlm("ok");
      const { runtime } = await build(llm);
      await runtime.observe(ctx, {
        kind: "document",
        title: titleMarker,
        content: "文書の本文",
        extractTitle: true,
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.messages[0]!.content).toBe(`${titleMarker}\n\n文書の本文`);
    });

    it("b. extractData: true のとき、LLM 失敗時の全文フォールバックの本文にも同じ文字列が入る", async () => {
      const dataMarker = `data-の目印-${randomUUID()}`;
      const { llm } = recordingLlm("fail");
      const { runtime, memoryStore } = await build(llm);
      const result = await runtime.observe(ctx, {
        kind: "event",
        name: "ログインした",
        data: { note: dataMarker },
        extractData: true,
      });
      expect(result.extraction).toBe("llm_failed_whole_observation");
      const memory = await memoryStore.get(ctx, result.memoryIds[0]!);
      expect(memory?.content).toBe(`ログインした\n\n${JSON.stringify({ note: dataMarker })}`);
    });

    it("b. extractTitle: true のとき、LLM 失敗時の全文フォールバックの本文にも同じ文字列が入る", async () => {
      const titleMarker = `title-の目印-${randomUUID()}`;
      const { llm } = recordingLlm("fail");
      const { runtime, memoryStore } = await build(llm);
      const result = await runtime.observe(ctx, {
        kind: "document",
        title: titleMarker,
        content: "文書の本文",
        extractTitle: true,
      });
      expect(result.extraction).toBe("llm_failed_whole_observation");
      const memory = await memoryStore.get(ctx, result.memoryIds[0]!);
      expect(memory?.content).toBe(`${titleMarker}\n\n文書の本文`);
    });

    it("c. 指定しないとき、payload・プロンプト・フォールバック本文はバイト単位で今と同じ（カセット鍵も固定値のまま）", async () => {
      const { llm, prompts } = recordingLlm("ok");
      const { runtime, memoryStore } = await build(llm);

      const eventResult = await runtime.observe(ctx, {
        kind: "event",
        name: "ログインした",
        data: { note: "無視されるはずの値" },
      });
      const documentResult = await runtime.observe(ctx, {
        kind: "document",
        title: "無視されるはずのタイトル",
        content: "本文",
      });

      const eventObservation = await memoryStore.getObservation(ctx, eventResult.observationId);
      expect(eventObservation?.payload).toEqual({
        name: "ログインした",
        data: { note: "無視されるはずの値" },
      });
      const documentObservation = await memoryStore.getObservation(
        ctx,
        documentResult.observationId,
      );
      expect(documentObservation?.payload).toEqual({
        title: "無視されるはずのタイトル",
        content: "本文",
      });

      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.messages[0]!.content).toBe("ログインした");
      expect(prompts[1]!.messages[0]!.content).toBe("本文");

      // カセットの鍵（`llmCassetteKey`）は動いていない（`origin/main` で同じ入力から計算した固定値と比較する）。
      expect(llmCassetteKey(prompts[0]!)).toBe(
        "d0b41afac664e1ff6ddf9bc464269bcee92f9e51ed18c138938d02bc075a2f29",
      );
      expect(llmCassetteKey(prompts[1]!)).toBe(
        "b1cfd6c084ba45b8c367667ddd6b3c74ebf65081ba28c923d6da448edf9b4050",
      );
    });

    it("c. false を明示しても、指定しないときと同じ（payload に extractData/extractTitle のキーが増えず、プロンプトにも入らない）", async () => {
      const { llm, prompts } = recordingLlm("ok");
      const { runtime, memoryStore } = await build(llm);

      const eventResult = await runtime.observe(ctx, {
        kind: "event",
        name: "ログインした",
        data: { note: "無視されるはずの値" },
        extractData: false,
      });
      const documentResult = await runtime.observe(ctx, {
        kind: "document",
        title: "無視されるはずのタイトル",
        content: "本文",
        extractTitle: false,
      });

      const eventObservation = await memoryStore.getObservation(ctx, eventResult.observationId);
      expect(eventObservation?.payload).toEqual({
        name: "ログインした",
        data: { note: "無視されるはずの値" },
      });
      const documentObservation = await memoryStore.getObservation(
        ctx,
        documentResult.observationId,
      );
      expect(documentObservation?.payload).toEqual({
        title: "無視されるはずのタイトル",
        content: "本文",
      });
      expect(prompts[0]!.messages[0]!.content).toBe("ログインした");
      expect(prompts[1]!.messages[0]!.content).toBe("本文");
    });

    it("d. extract: 'deferred' と同時に指定しても例外にならず、tick() の処理後のプロンプトに入る", async () => {
      const dataMarker = `data-の目印-${randomUUID()}`;
      const titleMarker = `title-の目印-${randomUUID()}`;
      const { llm, prompts } = recordingLlm("ok");
      const { runtime } = await build(llm);

      await runtime.observe(ctx, {
        kind: "event",
        name: "送信した",
        data: { note: dataMarker },
        extractData: true,
        extract: "deferred",
      });
      await runtime.observe(ctx, {
        kind: "document",
        title: titleMarker,
        content: "文書の本文2",
        extractTitle: true,
        extract: "deferred",
      });
      expect(prompts).toHaveLength(0);

      await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000, limit: 10 });

      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.messages[0]!.content).toBe(
        `送信した\n\n${JSON.stringify({ note: dataMarker })}`,
      );
      expect(prompts[1]!.messages[0]!.content).toBe(`${titleMarker}\n\n文書の本文2`);
    });

    it("e. reextract で、保存済み observation から opt-in が再現される", async () => {
      const dataMarker = `data-の目印-${randomUUID()}`;
      const { llm, prompts, setMode } = switchableLlm("fail");
      const { runtime } = await build(llm);

      const result = await runtime.observe(ctx, {
        kind: "event",
        name: "ログインした",
        data: { note: dataMarker },
        extractData: true,
      });
      expect(result.extraction).toBe("llm_failed_whole_observation");

      setMode("ok");
      prompts.length = 0;
      await runtime.reextract(ctx, result.observationId);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.messages[0]!.content).toBe(
        `ログインした\n\n${JSON.stringify({ note: dataMarker })}`,
      );
    });

    it("f. extractTitle: true かつ content が空文字なら title だけを本文にする（title も空なら既定どおり）", async () => {
      const { llm, prompts } = recordingLlm("ok");
      const { runtime, memoryStore } = await build(llm);

      const withTitle = await memoryStore.createObservation(ctx, {
        tenantId: ctx.tenantId,
        kind: "document",
        payload: { title: "タイトルのみ", content: "", extractTitle: true },
      });
      await runtime.reextract(ctx, withTitle.id);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.messages[0]!.content).toBe("タイトルのみ");

      const withoutTitle = await memoryStore.createObservation(ctx, {
        tenantId: ctx.tenantId,
        kind: "document",
        payload: { title: "", content: "", extractTitle: true },
      });
      await runtime.reextract(ctx, withoutTitle.id);
      expect(prompts).toHaveLength(2);
      // title も空なら、印なしの既定の振る舞い（`JSON.stringify(payload)` フォールバック）と同じ経路を通る。フィールド順は adapter によって違いうる（jsonb はキー順を保証しない）ので、パースした形で比較する。
      expect(JSON.parse(prompts[1]!.messages[0]!.content)).toEqual({
        title: "",
        content: "",
        extractTitle: true,
      });
    });

    it("g. extractData: true でも data を渡さない・空オブジェクトなら name だけになる（既定と同じ）", async () => {
      const { llm, prompts } = recordingLlm("ok");
      const { runtime } = await build(llm);

      await runtime.observe(ctx, { kind: "event", name: "名前だけ1", extractData: true });
      await runtime.observe(ctx, {
        kind: "event",
        name: "名前だけ2",
        data: {},
        extractData: true,
      });

      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.messages[0]!.content).toBe("名前だけ1");
      expect(prompts[1]!.messages[0]!.content).toBe("名前だけ2");
    });
  },
);
