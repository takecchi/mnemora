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
 * 利用者の意思で退けた記憶を持つ Observation に `reextract` を呼んだときの振る舞いを縛る（Issue #1079・#1149。
 * `Runtime.reextract` の doc）。Postgres と testkit の fixture で同じ。
 *
 * - 同じ Observation（同じ `extractorVersion`）の記憶に、`forgotten`（purge を含む）・`contested`・訂正の解決で
 *   負けた `superseded`（最新の `superseded` イベントの `meta.reason` が `contested_resolved`）が1件でも在れば、
 *   抽出をやり直さない。LLM も呼ばず、何も書かない（`extraction: "skipped"`・`atomicity: "not_attempted"`、
 *   退けた記憶ごとに `skipped` に `status_not_active`）。
 * - やりすぎないこと: 退けた記憶が無い Observation と、機構（reextract・consolidate）で置き換えただけの
 *   `superseded`、理由の読めない `superseded`（イベントが無い）しか持たない Observation は、今どおりやり直す。
 * - 置き換えた側（統合先）を forget しても、`restoreSuperseded` はその群を `active` に戻す（#1079 のコメント。
 *   変えていない）。
 */

/** 抽出の LLM。`next.content` を1件の候補として返し、統合では `next.content` を本文にする。呼ばれた回数を数える。 */
function makeLlm(next: { content: string; calls: number }): LLMProvider {
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) => {
      next.calls += 1;
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

type Next = { content: string; calls: number };

function shared(next: Next) {
  return {
    llmProvider: makeLlm(next),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  };
}

const KITS: Array<[string, (next: Next) => Promise<Kit>]> = [
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

type Withdraw =
  | "forget"
  | "purge"
  | "contested"
  | "resolved"
  | "none"
  | "reextract_superseded"
  | "consolidated"
  | "superseded_without_event";

/** 観測1から X を作り、`withdraw` の状態にしたあと、LLM に言い換えを返させて観測1を reextract する。 */
async function reextractAfter(makeKit: (next: Next) => Promise<Kit>, withdraw: Withdraw) {
  const next: Next = { content: ORIGINAL, calls: 0 };
  const kit = await makeKit(next);
  const first = await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
  const x = first.memoryIds[0]!;
  let y: MemoryId | undefined;
  switch (withdraw) {
    case "forget":
    case "purge":
      await kit.runtime.forget(ctx, { memoryId: x });
      if (withdraw === "purge") {
        expect((await kit.runtime.purge(ctx, { memoryId: x })).outcomes[0]?.kind).toBe("purged");
      }
      break;
    case "contested":
    case "resolved":
      next.content = "猫は2匹";
      y = (await kit.runtime.observe(ctx, { kind: "utterance", text: "猫は2匹だった" }))
        .memoryIds[0]!;
      await kit.runtime.markContested(ctx, x, y);
      if (withdraw === "resolved") {
        await kit.runtime.resolveContested(ctx, x, y, { kind: "supersede", winnerId: y });
      }
      break;
    case "reextract_superseded":
      // 1回目の reextract（言い換え）で X が機構により置き換えられる。
      next.content = "猫が3匹いる";
      expect((await kit.runtime.reextract(ctx, first.observationId)).supersededMemoryIds).toEqual([
        x,
      ]);
      break;
    case "consolidated": {
      next.content = "犬は1匹";
      const other = (await kit.runtime.observe(ctx, { kind: "utterance", text: "犬は1匹" }))
        .memoryIds[0]!;
      next.content = "猫は3匹、犬は1匹";
      await kit.runtime.consolidate(ctx, { target: { memoryIds: [x, other] } });
      break;
    }
    case "superseded_without_event": {
      // 理由を読むイベントの無い superseded（保持期間の掃除で消えた場合と同じ顔）。
      next.content = "別の記憶";
      const winner = (await kit.runtime.observe(ctx, { kind: "utterance", text: "別" }))
        .memoryIds[0]!;
      await kit.memoryStore.updateStatus(ctx, x, "superseded", { supersededById: winner });
      break;
    }
    case "none":
      break;
  }
  next.content = REPHRASED;
  const callsBefore = next.calls;
  const result = await kit.runtime.reextract(ctx, first.observationId);
  const created = [];
  for (const id of result.memoryIds) {
    const m = await kit.memoryStore.get(ctx, id);
    if (m!.content === REPHRASED) created.push({ content: m!.content, status: m!.status });
  }
  return {
    result,
    llmCalls: next.calls - callsBefore,
    xStatus: (await kit.memoryStore.get(ctx, x))!.status,
    yStatus: y === undefined ? undefined : (await kit.memoryStore.get(ctx, y))!.status,
    created,
  };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 退けた記憶の Observation に reextract を呼ぶ`, () => {
    for (const [withdraw, xStatus, yStatus] of [
      ["forget", "forgotten", undefined],
      ["purge", "forgotten", undefined],
      ["contested", "contested", "contested"],
      ["resolved", "superseded", "active"],
    ] as const) {
      it(`${withdraw}: やり直さない（LLM を呼ばず、何も書かず、skipped で名乗る）`, async () => {
        const got = await reextractAfter(makeKit, withdraw);
        expect(got.llmCalls).toBe(0);
        expect(got.result).toMatchObject({
          memoryIds: [],
          supersededMemoryIds: [],
          atomicity: "not_attempted",
          extraction: "skipped",
          extractionFailure: null,
        });
        expect(got.result.skipped).toContainEqual(
          expect.objectContaining({ kind: "status_not_active", status: xStatus }),
        );
        expect(got.created).toEqual([]);
        expect(got.xStatus).toBe(xStatus);
        expect(got.yStatus).toBe(yStatus);
      });
    }

    for (const withdraw of [
      "none",
      "reextract_superseded",
      "consolidated",
      "superseded_without_event",
    ] as const) {
      it(`${withdraw}: 退けた記憶ではないので、今どおりやり直す（言い換えが active で作られる）`, async () => {
        const got = await reextractAfter(makeKit, withdraw);
        expect(got.llmCalls).toBe(1);
        expect(got.result.extraction).toBe("ok");
        expect(got.created).toEqual([{ content: REPHRASED, status: "active" }]);
      });
    }

    it("統合先を forget しても、restoreSuperseded はその群を active に戻す", async () => {
      const next: Next = { content: "事実D", calls: 0 };
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
