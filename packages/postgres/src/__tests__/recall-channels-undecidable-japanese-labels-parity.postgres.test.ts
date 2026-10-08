import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  LexicalStore,
  MemoryStore,
  Omission,
  RecallQuery,
  RecallResult,
  Runtime,
  VectorStore,
} from "@mnemora/core";
import { ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE, createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  PostgresTrigramLexicalStore,
  TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
} from "../trigram-lexical-store.js";
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
 * 3実装（testkit の InMemory〔Fake〕、実 Postgres の tsvector・trigram）に同じ記憶・同じ問いを当てて突き合わせる。
 * 比べるのは、記憶を内容（content）で名指した順序つきの `retrievedVia`・`omitted` の kind と certainty。
 * 数値（score）は store ごとに尺度が違う（`lexicalMatch`）ので比べない。
 *
 * 1. `ann_truncated`: 語彙チャンネルが走り ANN の窓が埋まった run は `certainty: "undecidable"`。
 *    語彙チャンネルを使わない ANN だけの run は、undecidable にならない（やりすぎ側）。
 * 2. 日本語の語彙: tsvector は日本語を引けず、trigram は引ける。**Fake がどちらに合わせているか**を見る。
 * 3. `labels` と channels: 語彙チャンネルだけが当てる記憶も `labels` の絞りを破らない。
 */

const TENANT = "recall-channels-undecidable-ja-labels";
const ctx: Ctx = { tenantId: TENANT };
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

type KitName = "testkit" | "tsvector" | "trigram";
const KITS: readonly KitName[] = ["testkit", "tsvector", "trigram"];

let queryVector = [1, 0, 0];
const shared = {
  llmProvider: {
    complete: async () => ({ content: "" }),
    completeStructured: async () => {
      throw new Error("unused");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => queryVector),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => new Date(NOW) },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

/** trigram が使えない環境（SQL_ASCII の脚）では null。 */
async function buildKit(name: KitName): Promise<Kit | null> {
  if (name === "testkit") {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    return {
      memoryStore,
      vectorStore,
      runtime: createRuntime({
        ...shared,
        memoryStore,
        vectorStore,
        lexicalStore: new InMemoryLexicalStore(memoryStore),
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      }),
    };
  }
  await resetTestDatabase();
  const { db } = await getTestClient();
  let lexicalStore: LexicalStore;
  if (name === "tsvector") {
    lexicalStore = new PostgresLexicalStore(db);
  } else {
    try {
      lexicalStore = await PostgresTrigramLexicalStore.create(db);
    } catch (error) {
      expect(String((error as Error).message)).toContain(
        TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
      );
      return null;
    }
  }
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  return {
    memoryStore,
    vectorStore,
    runtime: createRuntime({
      ...shared,
      memoryStore,
      vectorStore,
      lexicalStore,
      outboxStore: new PostgresOutboxStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    }),
  };
}

interface Seed {
  content: string;
  vector: number[];
  tags?: string[];
}

/** 記憶を作り、`id → content` の写しを返す（実装ごとに id が違うので、内容で名指して比べる）。 */
async function seed(kit: Kit, seeds: readonly Seed[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [i, s] of seeds.entries()) {
    const memory = await kit.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: s.content,
        contentHash: `chan-${i}`,
        digest: s.content,
        tags: s.tags ?? [],
        halfLifeHours: 1e6,
        decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
        embeddingStatus: "ready",
      }),
    );
    names.set(memory.id, s.content);
    await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, s.vector);
  }
  return names;
}

interface Shape {
  /** 返った記憶（順序つき）: `content|retrievedVia` */
  returned: string[];
  /** `omitted` の kind（certainty があれば付ける）を並べ替えたもの */
  omitted: string[];
}

function shape(result: RecallResult, names: Map<string, string>): Shape {
  return {
    returned: result.memories.map((m) => `${names.get(m.memoryId)}|${m.retrievedVia}`),
    omitted: result.omitted.map(omissionKey).sort(),
  };
}

function omissionKey(o: Omission): string {
  if (o.kind === "ann_truncated") return `ann_truncated:${o.certainty}`;
  return o.kind;
}

async function runOnAll(
  seeds: readonly Seed[],
  query: RecallQuery,
  vector: number[] = [1, 0, 0],
): Promise<Map<KitName, { shape: Shape; result: RecallResult }>> {
  const out = new Map<KitName, { shape: Shape; result: RecallResult }>();
  queryVector = vector;
  for (const name of KITS) {
    const kit = await buildKit(name);
    if (kit === null) continue;
    const names = await seed(kit, seeds);
    const result = await kit.runtime.recall(ctx, query);
    out.set(name, { shape: shape(result, names), result });
  }
  return out;
}

/**
 * 3実装が同じか。同点の並びは実装ごとに違う（Fake は作成順、Postgres は不定）ので、返った記憶は集合で比べる。
 * `omittedOnly` は、top-1 が同点で割れうる問い（limit を絞った形）で `omitted` だけを比べる。
 */
function expectSame(
  table: Map<KitName, { shape: Shape }>,
  mode: "set" | "omittedOnly" = "set",
): void {
  const norm = (sh: Shape) =>
    mode === "set"
      ? { returned: [...sh.returned].sort(), omitted: sh.omitted }
      : { omitted: sh.omitted };
  const base = norm(table.get("testkit")!.shape);
  for (const [name, v] of table) {
    expect(norm(v.shape), `${name} が testkit（Fake）と違う`).toEqual(base);
  }
}

afterAll(async () => {
  await closeTestClient();
});

describe("ann_truncated と channels: Fake と実 Postgres が同じ判定を返す", () => {
  // 3件とも同じ語を含み、ベクトルも同じ向き。kPrime = limit × overFetchFactor。
  const SEEDS: Seed[] = [
    { content: "alphaproject report one", vector: [1, 0, 0] },
    { content: "alphaproject notes two", vector: [0.9, 0.1, 0] },
    { content: "alphaproject memo three", vector: [0.8, 0.2, 0] },
  ];
  const base = { text: "alphaproject report", association: null } as const;

  it("ann+lexical で ANN の窓が埋まる（kPrime=1）と、3実装とも undecidable（ADR 0084 §7）", async () => {
    const table = await runOnAll(SEEDS, {
      ...base,
      channels: ["ann", "lexical"],
      limit: 1,
      overFetchFactor: 1,
    });
    expect(table.size).toBeGreaterThanOrEqual(2);
    for (const [name, v] of table) {
      const found = v.result.omitted.find((o) => o.kind === "ann_truncated");
      if (found === undefined || found.kind !== "ann_truncated") {
        throw new Error(`${name}: ann_truncated が積まれていない`);
      }
      expect(found.certainty, name).toBe("undecidable");
      expect(found.undecidableReason, name).toBe(ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE);
    }
    expectSame(table);
  });

  it("やりすぎ側: ANN の窓が埋まらない（kPrime=40 > 3件）なら ann_truncated は出ない", async () => {
    const table = await runOnAll(SEEDS, {
      ...base,
      channels: ["ann", "lexical"],
      limit: 10,
      overFetchFactor: 4,
    });
    for (const [name, v] of table) {
      expect(
        v.result.omitted.some((o) => o.kind === "ann_truncated"),
        name,
      ).toBe(false);
    }
    expectSame(table);
  });

  it("やりすぎ側: channels: ['lexical']（ANN が走らない）なら ann_truncated は出ない", async () => {
    const table = await runOnAll(SEEDS, {
      ...base,
      channels: ["lexical"],
      limit: 1,
      overFetchFactor: 1,
    });
    for (const [name, v] of table) {
      expect(
        v.result.omitted.some((o) => o.kind === "ann_truncated"),
        name,
      ).toBe(false);
    }
    expectSame(table);
  });

  it("対照: channels: ['ann']（語彙が走らない）で窓が埋まると、undecidable にならず、3実装が同じ判定", async () => {
    const table = await runOnAll(SEEDS, {
      ...base,
      channels: ["ann"],
      limit: 1,
      overFetchFactor: 1,
    });
    for (const [name, v] of table) {
      const found = v.result.omitted.find((o) => o.kind === "ann_truncated");
      if (found !== undefined && found.kind === "ann_truncated") {
        expect(found.undecidableReason, name).not.toBe(ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE);
      }
    }
    expectSame(table);
  });
});

describe("日本語の語彙と channels: Fake と実 Postgres の突き合わせ", () => {
  const SEEDS: Seed[] = [
    { content: "来週の定例会議の議題を共有した", vector: [0, 0, 1] },
    { content: "東京タワーに家族で出かけた", vector: [0, 1, 0] },
    { content: "alphaproject report", vector: [1, 0, 0] },
  ];

  it("語彙だけが当てる日本語の記憶: trigram は当てる（Fake も同じ）、tsvector は当てない", async () => {
    const table = await runOnAll(
      SEEDS,
      {
        text: "定例会議",
        channels: ["lexical"],
        limit: 10,
        association: null,
      },
      [1, 0, 0],
    );
    const hit = "来週の定例会議の議題を共有した|lexical";
    if (table.has("trigram")) {
      expect(table.get("trigram")!.shape.returned).toEqual([hit]);
    }
    expect(table.get("tsvector")!.shape.returned).toEqual([]);
    // Fake（InMemoryLexicalStore）は tsvector 側に合わせてあり、trigram だけが日本語を引ける。Fake は trigram を写さない。
    expect(table.get("testkit")!.shape.returned).toEqual(table.get("tsvector")!.shape.returned);
  });

  it("ann+lexical の合流: 日本語の語彙だけの記憶が、ANN の窓の外から語彙経由で入る（trigram）", async () => {
    const table = await runOnAll(
      SEEDS,
      {
        text: "定例会議",
        channels: ["ann", "lexical"],
        limit: 10,
        overFetchFactor: 0.1, // kPrime = 1: ANN は alphaproject だけを返す
        association: null,
      },
      [1, 0, 0],
    );
    if (table.has("trigram")) {
      expect(table.get("trigram")!.shape.returned).toContain(
        "来週の定例会議の議題を共有した|lexical",
      );
    }
    expect(table.get("tsvector")!.shape.returned).not.toContain(
      "来週の定例会議の議題を共有した|lexical",
    );
    expect(table.get("testkit")!.shape.returned).not.toContain(
      "来週の定例会議の議題を共有した|lexical",
    );
  });

  it("日本語 + labels（trigram）: 語彙だけが当てる日本語の記憶も labels の絞りを破らない", async () => {
    const seeds: Seed[] = [
      { content: "来週の定例会議の議題を共有した", vector: [0, 0, 1], tags: ["x"] },
      { content: "定例会議の議事録を整理した", vector: [0, 1, 0], tags: ["y"] },
      { content: "alphaproject report", vector: [1, 0, 0], tags: ["x"] },
    ];
    const table = await runOnAll(seeds, {
      text: "定例会議",
      channels: ["ann", "lexical"],
      limit: 10,
      overFetchFactor: 0.1, // kPrime = 1: ANN は alphaproject だけ
      labels: ["x"],
      association: null,
    });
    const trigram = table.get("trigram");
    if (trigram === undefined) return;
    expect(trigram.shape.returned).toContain("来週の定例会議の議題を共有した|lexical");
    expect(trigram.shape.returned).not.toContain("定例会議の議事録を整理した|lexical");
  });
});

describe("labels と channels: 語彙チャンネルだけが当てる記憶も labels の絞りを破らない", () => {
  const SEEDS: Seed[] = [
    { content: "alphaproject report x", vector: [0, 0, 1], tags: ["x"] },
    { content: "alphaproject report y", vector: [0, 1, 0], tags: ["y"] },
    { content: "alphaproject report none", vector: [0, 1, 1] },
    // ANN の窓（kPrime = 5）を埋める、語を含まない記憶。tags は x（labels: ['x'] を通る）。
    ...[0, 1, 2, 3, 4].map((i): Seed => ({
      content: `unrelated ann hit ${i}`,
      vector: [1, 0.01 * i, 0],
      tags: ["x"],
    })),
  ];
  const q = {
    text: "alphaproject",
    channels: ["ann", "lexical"] as ("ann" | "lexical")[],
    limit: 10,
    overFetchFactor: 0.5, // kPrime = 5: ANN は unrelated の5件で窓が埋まる。alphaproject は語彙だけが当てる
    association: null,
  };

  it("labels: ['x']: 語彙だけが当てる y・無印は入らず、x は入る。3実装が同じ", async () => {
    const table = await runOnAll(SEEDS, { ...q, labels: ["x"] });
    for (const [name, v] of table) {
      expect(v.shape.returned, name).toContain("alphaproject report x|lexical");
      expect(v.shape.returned, name).not.toContain("alphaproject report y|lexical");
      expect(v.shape.returned, name).not.toContain("alphaproject report none|lexical");
    }
    expectSame(table);
  });

  it("対照: labels を渡さなければ y・無印も語彙経由で入る（絞りが効いていることの対）", async () => {
    const table = await runOnAll(SEEDS, q);
    for (const [name, v] of table) {
      expect(v.shape.returned, name).toContain("alphaproject report y|lexical");
      expect(v.shape.returned, name).toContain("alphaproject report none|lexical");
    }
    expectSame(table);
  });

  it("labels: ['x'] と ann_truncated: 絞った run でも undecidable は同じに出る", async () => {
    const table = await runOnAll(SEEDS, { ...q, labels: ["x"], limit: 1, overFetchFactor: 1 });
    for (const [name, v] of table) {
      const found = v.result.omitted.find((o) => o.kind === "ann_truncated");
      if (found === undefined || found.kind !== "ann_truncated") {
        throw new Error(`${name}: ann_truncated が積まれていない`);
      }
      expect(found.certainty, name).toBe("undecidable");
    }
    expectSame(table, "omittedOnly");
  });
});

describe("labels は大文字小文字を区別する: 名前の綴りが違う記憶は、どのチャンネルの窓も占めない", () => {
  // 窓（kPrime = 1）を埋める最有力は tags: ['X']（labels: ['x'] とは別の名前）。store が大文字小文字を無視して返すと、
  // core の後置フィルタが落とした後に窓が空になり、tags: ['x'] の記憶が消える（store 単独の変異を捕まえる入力）。
  // 名前は文字列の完全一致で比べる（RecallScope.labels の TSDoc「['project'] は tags: ['Project'] に当たらない」。packages/core/src/recall.ts）。
  const SEEDS: Seed[] = [
    { content: "alphaproject report", vector: [1, 0, 0], tags: ["X"] },
    { content: "alphaproject report notes extra words here", vector: [0.9, 0.1, 0], tags: ["x"] },
  ];
  const base = {
    text: "alphaproject report",
    association: null,
    limit: 1,
    overFetchFactor: 1,
  } as const;

  it.each([["ann"], ["lexical"]] as const)(
    "channels: ['%s']、labels: ['x']: tags: ['x'] の記憶が返り、tags: ['X'] の記憶は返らない。3実装が同じ",
    async (channel) => {
      const table = await runOnAll(SEEDS, { ...base, channels: [channel], labels: ["x"] });
      for (const [name, v] of table) {
        expect(v.shape.returned, name).toEqual([
          `alphaproject report notes extra words here|${channel === "ann" ? "ann" : "lexical"}`,
        ]);
      }
      expectSame(table);
    },
  );
});
