import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import type { Memory, NewMemory } from "../memory.js";
import type { Omission } from "../recall.js";
import { OmissionSchema } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `Omission.kind` の全値それぞれに「本番コードが実際に生成する」歯を置く。
 *
 * `expect` の左辺は必ず本番の生成経路（`Runtime.recall` → `runRecall`）の戻り値で、テスト側は期待値を組み立てない。
 * `OmissionSchema.safeParse({ kind: "over_limit", … })` のように手で組み立てた値を通すだけでは、schema がその形を
 * 受け付けることしか言えず、その kind を積む本番コードが在るかを言えない。静的な grep（`unreachable-union-values.test.ts`）でも、
 * `omitted.push({ kind: "x", … })` の行が在ることしか分からず、その行に到達する条件が実在するかは言えない。
 *
 * kind が増減したら必ずどこかが赤くなる二重の歯:
 * 1. 型: `OMISSION_PROBES` は `Record<Omission["kind"], OmissionProbe>`。kind を足して probe を書かなければキー不足、
 *    減らせば余剰キーで型エラーになる。
 * 2. 実行時: レジストリのキー集合と `OmissionSchema` の判別子の集合を突き合わせる。1. の重複ではない:
 *    `OmissionSchema` は `Omission` 型に `satisfies` で束ねられていない（束ねているのは各枝の `…OmissionSchema` だけ）ので、
 *    TS の union と zod の union がずれても型検査だけでは気づかない。
 *
 * 限界:
 * - 各 kind について駆動する状況は1つだけ。主張するのは「kind ごとに生成経路が少なくとも1本在る」まで。
 * - 「鳴ってはいけない側」は全 kind について測らない（既存ファイル側に在る）。ここで重ねているのは `unit_assembly_dropped` の1つだけ。
 * - Fake の store / provider を使うので、本物の Postgres + pgvector で同じ条件で出るとは言っていない。
 * - `examples/chat` 側の歯（`compare.ts` の検査）は、ソース文字列の一致でしか見ていない（`unreachable-union-values.test.ts` と同じ限界）。
 */

// 足場。既存のテストファイルから import しない: `runtime-fakes.ts` は共有するが、各テストの `buildRuntime` は
// そのテストが要る配線を持つローカルな足場であり、ここで他から引くと向こうの都合（lexicalStore を外す等）が
// こちらの合否に効いてしまう。

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10; // 長い half-life。テスト内で減衰させない。
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

/**
 * `ann_unreached` の probe のためだけの `VectorStore` の薄いラッパー。`FakeVectorStore` は
 * 「scope にもっと候補があるのに ANN がそれより少ない件数しか返さない」状況を作れない（`limit` まで律儀に返す）ので、
 * 返り件数を後から切り詰める。
 */
class CappedVectorStore implements VectorStore {
  constructor(
    private readonly inner: VectorStore,
    private readonly cap: number,
  ) {}

  upsert(...args: Parameters<VectorStore["upsert"]>): ReturnType<VectorStore["upsert"]> {
    return this.inner.upsert(...args);
  }

  async search(...args: Parameters<VectorStore["search"]>): ReturnType<VectorStore["search"]> {
    const hits = await this.inner.search(...args);
    return hits.slice(0, this.cap);
  }

  delete(...args: Parameters<VectorStore["delete"]>): ReturnType<VectorStore["delete"]> {
    return this.inner.delete(...args);
  }

  deleteAcrossSpaces(
    ...args: Parameters<VectorStore["deleteAcrossSpaces"]>
  ): ReturnType<VectorStore["deleteAcrossSpaces"]> {
    return this.inner.deleteAcrossSpaces(...args);
  }
}

/**
 * `lexicalStore` は常に配線する。既定の `channels` は ANN 1本（`DEFAULT_RECALL_CHANNELS`）なので、
 * `channels: ["lexical"]` を明示しない probe の挙動は配線しない場合と変わらない（`recall-runtime.ts` は
 * `wantsLexical` が false のとき `lexicalStore` に一切触らない）。probe ごとに配線を変えずに済む。
 */
function buildRuntime(options: { annCap?: number } = {}) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore:
      options.annCap === undefined
        ? stores.vectorStore
        : new CappedVectorStore(stores.vectorStore, options.annCap),
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  // `stores.vectorStore` は cap されていない素の参照のまま返す（upsert は cap の対象外）。
  return { runtime, stores };
}

/** 埋め込み済みの Memory を1件用意する（vectorStore への upsert も行う）。 */
async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

type OmissionProbe = {
  /**
   * どこまでを本番コードとして駆動しているか。`"recall()"` は `Runtime.recall()` を呼んで `runRecall` の全段を通す。
   * `"recall-runtime.ts の下位関数"` は下位の公開関数を直接駆動している。
   * `recall()` 全体からは踏めない種が現れたら、この欄を書き換えて踏めないことを明示する（歯を消したり `it.skip` にしたりしない）。
   */
  drivenThrough: "recall()" | "recall-runtime.ts の下位関数";
  /** その kind を積む本番コードの位置。**合否には関わらない**（人が辿るための道しるべ）。 */
  producedAt: string;
  /** 何をするとその kind が出るか。テスト名に出る。 */
  situation: string;
  /**
   * 種を植えるのに `Runtime` の公開操作だけでは足りなかった場合、その理由。省略は「`Runtime` だけで作れた」の意味。
   * 埋まっている probe は、「本番コードが生成する」ことは言えるが、「`Runtime` の操作だけでこの状況に至れる」ことは言っていない。
   */
  seedingCaveat?: string;
  /** 本番の生成経路を実際に走らせ、その戻り値の `omitted` を**そのまま**返す。 */
  run: () => Promise<readonly Omission[]>;
};

/**
 * `Omission.kind` の全値 → 「その kind を本番コードに実際に生成させる手順」。
 * `Partial<>` や index signature にしないこと: した瞬間に「kind を足したのに probe を書かなかった」が型検査を素通りする。
 */
const OMISSION_PROBES: Record<Omission["kind"], OmissionProbe> = {
  stage_skipped: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts `pushEmptyQuerySkipOnce`（段1）",
    situation: "text も vector も無いクエリ（段1の候補生成そのものが走らない）",
    run: async () => {
      const { runtime } = buildRuntime();
      const result = await runtime.recall(ctx, {});
      return result.omitted;
    },
  },

  filtered: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（段5 `aggregate.filteredArchived` → omitted）",
    situation: "scope 内に status='archived' の Memory が在る",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0], { status: "active" });
      await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
      const result = await runtime.recall(ctx, { vector: [1, 0] });
      return result.omitted;
    },
  },

  below_threshold: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（段2 `partitionByThreshold` の `belowThreshold`）",
    situation: "クエリベクトルと直交する候補（cosine 類似度 0 ⟹ total が閾値未満）",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [0, 1]);
      const result = await runtime.recall(ctx, { vector: [1, 0] });
      return result.omitted;
    },
  },

  over_limit: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（段2 `passed.slice(limit)`）",
    situation:
      "閾値を超えた候補が limit より多い（候補2件・limit 1）。連想（既定 on、ADR 0337）は" +
      " `association: null` で明示的に切る——このフィクスチャ（2件目が limit を超えつつ" +
      " 1件目に酷似）は、連想が既定 on のままだと段3.5 のアンカーから2件目を拾い直し、" +
      " over_limit(stage:'rescore') を正しく取り下げてしまう（Issue #925、" +
      " `recall-over-limit-association-promotion.test.ts` の(a)がこの経路自体を固定する）。" +
      " この probe が確かめたいのは「over_limit という kind の生成経路が在る」ことであり、" +
      " 連想を含む既定構成での挙動まではこの probe の射程ではない。",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0]);
      await createEmbeddedMemory(stores, [1, 0.001]);
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 1,
        overFetchFactor: 10,
        association: null,
      });
      return result.omitted;
    },
  },

  budget_dropped: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（段4 `droppedCount > 0`）",
    situation: "digest 20字の候補2件に maxMemoryChars: 10 の予算（1件も載らない）",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0], { digest: "A".repeat(20) });
      await createEmbeddedMemory(stores, [1, 0.001], { digest: "B".repeat(20) });
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 10,
        budget: { maxMemoryChars: 10 },
      });
      return result.omitted;
    },
  },

  not_indexed: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（段5 `NOT_INDEXED_REASONS` の繰り返し）",
    situation: "scope 内に embeddingStatus='pending' の Memory が在る",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await stores.memoryStore.createMemory(ctx, newMemory({ embeddingStatus: "pending" }));
      const result = await runtime.recall(ctx, {});
      return result.omitted;
    },
  },

  ann_truncated: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（`annWindowFilled` → `decideAnnTruncation`）",
    situation:
      "k'=1 の窓が埋まり、かつどの候補も持たないタグをクエリに足して上界を上げる（ADR 0069: 損失が起こりえた）",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0]);
      await createEmbeddedMemory(stores, [1, 0.001]);
      // タグを足さないと `provably_safe` になり、設計どおり沈黙する（窓が埋まったこと自体は損失を意味しない）。
      // ここで踏みたいのは「鳴る側」。
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 1,
        overFetchFactor: 1,
        tags: ["どの候補も持っていないタグ"],
      });
      return result.omitted;
    },
  },

  ann_unreached: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（`annHits.length < eligible`）",
    situation: "eligible 5件に対し ANN が2件しか返さない（近似索引が scope に届かなかった）",
    run: async () => {
      const { runtime, stores } = buildRuntime({ annCap: 2 });
      for (let i = 0; i < 5; i += 1) {
        await createEmbeddedMemory(stores, [1, 0]);
      }
      const result = await runtime.recall(ctx, { vector: [1, 0] });
      return result.omitted;
    },
  },

  lexical_truncated: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（`lexicalExecuted && lexicalHits.length >= kPrime`）",
    situation: "channels: ['lexical'] で k'=1 の窓を語彙ヒット1件が埋める（ADR 0084 §7）",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await stores.memoryStore.createMemory(
        ctx,
        newMemory({ content: "PROJ-1234 の記録その1", digest: "1" }),
      );
      const result = await runtime.recall(ctx, {
        text: "PROJ-1234",
        channels: ["lexical"],
        limit: 1,
        overFetchFactor: 1,
      });
      return result.omitted;
    },
  },

  score_not_comparable: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（段2 `partitionByThreshold` の `notComparable`）",
    situation: "ゼロベクトルの Memory が混ざる（cosine 距離が NaN ⟹ 三分割の3つ目、ADR 0040/0044）",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [0, 0], { digest: "ゼロベクトル" });
      await createEmbeddedMemory(stores, [1, 0], { digest: "正常1" });
      await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "正常2" });
      const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, scoreThreshold: 0 });
      return result.omitted;
    },
  },

  unit_assembly_dropped: {
    drivenThrough: "recall()",
    producedAt: "recall-runtime.ts（段3 `unitAssemblyShortfall(units, allCandidates.length) > 0`）",
    situation: "対向を指し返さない片側だけの contested（`contestedWithId: null`）が候補に入る",
    /**
     * ここだけ、状況を作るのに `Runtime` の公開操作では足りない。この kind だけが `contestedWithId` の一対一の破れという
     * データの状態に依存し、`Runtime.markContested` は両側 `status='active'` の CAS を課したうえで相互参照を1トランザクションで
     * 書くので、`Runtime` 経由で作られた contested ペアが一対一を破ることは無い。破れた状態は `MemoryStore`（公開 interface）を
     * 直接叩いて、`createMemory` で模して作る。
     *
     * 言えるのは、`omitted` にこの kind を積んでいるのが `recall()` の本番コードであること（テスト側は
     * `{ kind: "unit_assembly_dropped", … }` を組み立てていない）まで。`Runtime` の公開操作だけでこの状況に至れるとは言っていない。
     */
    seedingCaveat:
      "一対一の破れは Runtime.markContested の CAS では作れないため、MemoryStore を直接叩いて種を植えている（recall() 側は本番経路のまま）",
    run: async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0], {
        status: "contested",
        contestedWithId: null,
        digest: "lone-contested",
      });
      const result = await runtime.recall(ctx, { vector: [1, 0] });
      return result.omitted;
    },
  },
};

// ---------------------------------------------------------------------------
// 歯①: 11値それぞれが、本番の生成経路から実際に `omitted` に出る
// ---------------------------------------------------------------------------

describe("Issue #304: Omission.kind の全値に、本番コードからの生成経路が在る", () => {
  for (const [kind, probe] of Object.entries(OMISSION_PROBES)) {
    it(`${kind} — ${probe.situation}`, async () => {
      const omitted = await probe.run();

      const produced = omitted.filter((o) => o.kind === kind);
      // ⚠ メッセージを添える。落ちたときに読む人が要るのは「false だった」ではなく
      //    「どこが積むはずだったか」である。
      expect(
        produced.length,
        `${kind} が omitted に現れなかった。積むはずの本番コード: ${probe.producedAt}`,
      ).toBeGreaterThan(0);

      // 本番コードが作った値が、公開されている schema を実際に通ること。テスト側は期待値を組み立てず、比べる相手は zod schema だけにする。
      for (const omission of produced) {
        const parsed = OmissionSchema.safeParse(omission);
        expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    });
  }

  it("全 probe が `recall()` 全体を通している（踏めない種が現れたら、この歯がそれを名乗らせる）", () => {
    // 固定するのは「踏めない種が出てきたら `drivenThrough` を書き換えさせる」こと。黙って `it.skip` に逃げる道を塞ぐのが目的。
    const notViaRecall = Object.entries(OMISSION_PROBES)
      .filter(([, probe]) => probe.drivenThrough !== "recall()")
      .map(([kind, probe]) => `${kind}: ${probe.drivenThrough}`);
    expect(notViaRecall).toEqual([]);
  });

  it("⚠ 鳴ってはいけない側: markContested が正しく張った contested ペアでは unit_assembly_dropped は出ない", async () => {
    // `unit_assembly_dropped` の probe だけは「壊れたデータ」を種にしているので、その probe が「いつでも鳴る」わけではないことを、
    // 種を `Runtime.markContested` だけで作って対照する（一対一が保たれている限り、この kind は出ない）。
    const { runtime, stores } = buildRuntime();
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "B" });

    const marked = await runtime.markContested(ctx, a.id, b.id);
    expect(marked.supported).toBe(true);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(result.memories.map((m) => m.memoryId)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 歯②: 網羅性（レジストリのキー集合 == zod の判別子の集合）
// ---------------------------------------------------------------------------

describe("Issue #304: レジストリが Omission.kind を過不足なく覆う", () => {
  /**
   * `z.discriminatedUnion("kind", [...])` が実際に持っている判別子を、宣言を書き写さずに schema 自身から引く。
   * `options` は zod v4 が公開している枝の配列で、各枝の `shape.kind` は `z.literal(...)` なので `.value` がその判別子である。
   */
  const schemaKinds = OmissionSchema.options.map((option) => option.shape.kind.value);

  it("zod schema の判別子は11個あり、重複していない", () => {
    expect(new Set(schemaKinds).size).toBe(schemaKinds.length);
    expect(schemaKinds).toHaveLength(11);
  });

  it("🔴 レジストリのキー集合 == zod schema の判別子の集合（型検査に頼らない二重の歯）", () => {
    const registryKinds = Object.keys(OMISSION_PROBES);
    // 順序は意味を持たない（レジストリは宣言順、schema は定義順）。集合として比べる。
    expect([...registryKinds].sort()).toEqual([...schemaKinds].sort());
  });
});

// 歯③: `examples/chat/src/compare.ts` の網羅性の歯が残っていること
//
// `packages/core` 側に置く理由: `examples/chat` の検査スクリプトは `test:db` で、ルートの `pnpm run test` からは呼ばれない。
// 走るのは本物の Postgres を要求する CI の `example-chat` ジョブだけなので、あちら側に置くと「DB が立っているときだけ噛む歯」になる。
// DB の有無に依存しない歯にするため、`pnpm run test` が DB 無しで走るこちらへ置く。
//
// 限界: ソース文字列の一致でしか見ていない。`const exhaustive: never = o;` が在ることは分かるが、到達可能な位置に在るか、
// コンパイラが実際にその型検査を行ったかは言えない（それは `pnpm typecheck` の仕事）。

const REPO_ROOT = join(__dirname, "../../../../");
const COMPARE_TS = join(REPO_ROOT, "examples/chat/src/compare.ts");
/** 網羅性の歯そのもの（`examples/chat/src/compare.ts` の `formatOmittedSummary` の default 節）。 */
const EXHAUSTIVE_GUARD = "const exhaustive: never = o;";

describe("Issue #304: examples/chat の compare.ts の formatOmittedSummary は、never への代入による網羅性検査を持ち、全 kind を case で受けている", () => {
  const source = readFileSync(COMPARE_TS, "utf-8");

  /**
   * `formatOmittedSummary` の本体だけを切り出す。ファイル全体を見ると、将来
   * 別の関数が `const exhaustive: never = o;` を持ったときに、**この関数から歯が
   * 消えたのに緑のまま**になりうる。
   */
  function formatOmittedSummaryBody(): string {
    const start = source.indexOf("function formatOmittedSummary(");
    expect(start, `formatOmittedSummary が ${COMPARE_TS} に見つからない`).toBeGreaterThanOrEqual(0);
    // 次の**行頭の** `}` までを本体とする（この repo の整形は prettier 固定なので、
    // トップレベル関数の閉じ括弧は必ず行頭に来る）。
    const end = source.indexOf("\n}", start);
    expect(end, "formatOmittedSummary の閉じ括弧が見つからない").toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("🔴 formatOmittedSummary の switch に `const exhaustive: never = o;` が在る", () => {
    const body = formatOmittedSummaryBody();
    expect(body).toContain("switch (o.kind)");
    expect(body).toContain(EXHAUSTIVE_GUARD);
  });

  it("switch が11値すべてを名前で受けている（レジストリのキーから引く。ここでも数え直さない）", () => {
    const body = formatOmittedSummaryBody();
    const missing = Object.keys(OMISSION_PROBES).filter(
      (kind) => !body.includes(`case "${kind}":`),
    );
    expect(
      missing,
      `compare.ts の formatOmittedSummary が受けていない kind がある: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
