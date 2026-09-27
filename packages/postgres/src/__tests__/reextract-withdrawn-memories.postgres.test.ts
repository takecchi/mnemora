import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryId, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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

/**
 * 利用者の意思で退けた記憶（forget・purge・訂正）の元の Observation に `reextract` を呼んだときの、今の振る舞いを
 * 縛る（Issue #1079・#1149。`Runtime.reextract` の doc の 2026-09-28 追記）。振る舞いは変えていない。
 * Postgres と testkit の fixture で同じ。
 *
 * - 退けた記憶そのものは動かない（`skipped` に `status_not_active` と出る）。
 * - LLM が前回と同じ本文を返せば、冪等の鍵で既存の行に当たり、新しい行は作られない。
 * - LLM が前回と違う言い方で返せば、その事実は新しい `active` な Memory として作られる（訂正の対にも入らない）。
 * - 置き換えた側（統合先）を forget しても、`restoreSuperseded` はその群を `active` に戻す（#1079 のコメント）。
 */

/** 抽出の LLM。`next.content` を1件の候補として返し、統合では `next.content` を本文にする。 */
function makeLlm(next: { content: string }): LLMProvider {
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) => {
      const extracted = req.schema.safeParse({
        memories: [{ content: next.content, provenanceKind: "stated" }],
      });
      return extracted.success ? extracted.data : req.schema.parse({ content: next.content });
    },
  };
}

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
}

function shared(next: { content: string }) {
  return {
    llmProvider: makeLlm(next),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  };
}

const KITS: Array<[string, (next: { content: string }) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (next) => {
      const memoryStore = new InMemoryMemoryStore();
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared(next),
          memoryStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async (next) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      return {
        memoryStore,
        runtime: createRuntime({
          ...shared(next),
          memoryStore,
          eventStore: new PostgresEventStore(db),
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "reextract-withdrawn" };
const ORIGINAL = "猫は3匹";
const REPHRASED = "猫を3匹飼っている";

type Withdraw = "forget" | "purge" | "contested" | "resolved";

/** 観測1から X を作り、`withdraw` で退けたあと、LLM に `second` を返させて観測1を reextract する。 */
async function reextractAfter(
  makeKit: (next: { content: string }) => Promise<Kit>,
  withdraw: Withdraw,
  second: string,
) {
  const next = { content: ORIGINAL };
  const kit = await makeKit(next);
  const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
  const x = first.memoryIds[0]!;
  let y: MemoryId | undefined;
  if (withdraw === "forget" || withdraw === "purge") {
    await kit.runtime.forget(ctx, { memoryId: x });
    if (withdraw === "purge") {
      expect((await kit.runtime.purge(ctx, { memoryId: x })).outcomes[0]?.kind).toBe("purged");
    }
  } else {
    next.content = "猫は2匹";
    y = (await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は2匹だった" }))
      .memoryIds[0]!;
    await kit.runtime.markContested(ctx, x, y);
    if (withdraw === "resolved") {
      await kit.runtime.resolveContested(ctx, x, y, { kind: "supersede", winnerId: y });
    }
  }
  next.content = second;
  const result = await kit.runtime.reextract(ctx, first.observationId);
  const created = [];
  for (const id of result.memoryIds) {
    const m = await kit.memoryStore.get(ctx, id);
    if (id !== x && id !== y) created.push({ content: m!.content, status: m!.status });
  }
  return {
    result,
    xStatus: (await kit.memoryStore.get(ctx, x))!.status,
    yStatus: y === undefined ? undefined : (await kit.memoryStore.get(ctx, y))!.status,
    created,
  };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 退けた記憶の Observation に reextract を呼ぶ（今の振る舞い）`, () => {
    for (const [withdraw, xStatus, yStatus] of [
      ["forget", "forgotten", undefined],
      ["purge", "forgotten", undefined],
      ["contested", "contested", "contested"],
      ["resolved", "superseded", "active"],
    ] as const) {
      it(`${withdraw}: 同じ本文なら新しい行は無く、言い換えなら新しい active な Memory が作られる`, async () => {
        const same = await reextractAfter(makeKit, withdraw, ORIGINAL);
        expect(same.result.extraction).toBe("ok");
        expect(same.created).toEqual([]);
        expect(same.xStatus).toBe(xStatus);
        expect(same.yStatus).toBe(yStatus);

        const rephrased = await reextractAfter(makeKit, withdraw, REPHRASED);
        expect(rephrased.result.extraction).toBe("ok");
        expect(rephrased.created).toEqual([{ content: REPHRASED, status: "active" }]);
        expect(rephrased.xStatus).toBe(xStatus);
        expect(rephrased.yStatus).toBe(yStatus);
        expect(rephrased.result.skipped).toContainEqual(
          expect.objectContaining({ kind: "status_not_active", status: xStatus }),
        );
      });
    }

    it("統合先を forget しても、restoreSuperseded はその群を active に戻す", async () => {
      const next = { content: "事実D" };
      const kit = await makeKit(next);
      const d = (await kit.runtime.observe(ctx, { kind: "utterance", text: "D" })).memoryIds[0]!;
      next.content = "事実E";
      const e = (await kit.runtime.observe(ctx, { kind: "utterance", text: "E" })).memoryIds[0]!;
      next.content = "統合した本文";
      const f = (await kit.runtime.consolidate(ctx, { target: { memoryIds: [d, e] } }))
        .consolidatedMemoryId!;
      await kit.runtime.forget(ctx, { memoryId: f });
      const restored = await kit.runtime.restoreSuperseded(ctx, { supersededById: f });
      expect(restored.outcomes.map((o) => o.kind)).toEqual(["restored", "restored"]);
      expect((await kit.memoryStore.get(ctx, d))!.status).toBe("active");
      expect((await kit.memoryStore.get(ctx, e))!.status).toBe("active");
      expect((await kit.memoryStore.get(ctx, f))!.status).toBe("forgotten");
    });
  });
}
