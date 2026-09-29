import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #207/#933 PR2（ADR 0327、ADR 0378、ADR 0381、段階B。2026-09-30 のさらなる直し
 * ——オーナー側クローンの判断で opt-in のフラグ〔`ClaimKeyOptions.formContestedGroups`〕を
 * 廃止した）: `detectClaimKeyContested` の `contested_group` 分岐——群を作る条件は
 * 「`detectContested` が on で、かつ `RuntimeDeps.relationStore` が配線されていること」
 * （`deps.memoryStore.markContestedGroup` が有るだけでは群を作らない）。
 *
 * **`relationStore` を配線しない呼び出しは Issue #933 PR1（ADR 0378）の挙動を1ビットも
 * 変えない**——`claim-key-single-contested-match.test.ts`/`claim-key.test.ts` 等の PR1 の
 * 歯は、`relationStore` を一度も配線していないため、この PR では1文字も変更していない。
 */

const ctx: Ctx = { tenantId: "tenant-207-group-detect" };

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? new Date("2026-06-01T00:00:00.000Z");
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-207-group-detect",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "既存の記憶",
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

const ADDRESS_CLAIM_KEY = { subject: "user", predicate: "address" };

/** 抽出には発話をそのまま1件返し、claim key の導出にはいつも同じ鍵を返す偽の LLM。 */
function sameKeyLlm(contents: string[]): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        const content = contents[next++]!;
        return req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] });
      }
      return req.schema.parse({ claims: [ADDRESS_CLAIM_KEY] });
    },
  };
}

function buildRuntimeWithStores(contents: string[], opts: { withRelationStore?: boolean } = {}) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: sameKeyLlm(contents),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    relationStore: opts.withRelationStore === false ? undefined : stores.relationStore,
  });
  return { runtime, stores };
}

describe("claim key の検出: relationStore が配線されていなければ PR1 のまま（既定を変えない）", () => {
  it("relationStore を配線しない呼び出しは unresolved_conflict のまま（3件が競合しても群を作らない）", async () => {
    const { runtime, stores } = buildRuntimeWithStores(
      ["住所は東京", "住所は大阪", "住所は名古屋"],
      { withRelationStore: false },
    );

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は東京",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2025-01-01T00:00:00Z"),
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は大阪",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-06-01T00:00:00Z"),
      validUntil: new Date("2025-06-01T00:00:00Z"),
    });
    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は名古屋",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-09-01T00:00:00Z"),
      validUntil: new Date("2025-09-01T00:00:00Z"),
    });

    expect(third.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 2,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);
    const stored = await stores.memoryStore.get(ctx, third.memoryIds[0]!);
    expect(stored?.status).toBe("active");
    expect(first.memoryIds).toHaveLength(1);
    expect(second.memoryIds).toHaveLength(1);
  });
});

describe("claim key の検出: relationStore 配線時の新規3件衝突", () => {
  it("互いに重なる3件が一度に競合し、markContestedGroup が呼ばれて全員 contested になる", async () => {
    const { runtime, stores } = buildRuntimeWithStores(
      ["住所は東京", "住所は大阪", "住所は名古屋"],
      { withRelationStore: true },
    );

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は東京",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2025-01-01T00:00:00Z"),
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は大阪",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-06-01T00:00:00Z"),
      validUntil: new Date("2025-06-01T00:00:00Z"),
    });
    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は名古屋",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-09-01T00:00:00Z"),
      validUntil: new Date("2025-09-01T00:00:00Z"),
    });

    expect(third.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 2,
        result: expect.objectContaining({ kind: "contested_group" }),
      }),
    ]);
    for (const memoryIds of [first.memoryIds, second.memoryIds, third.memoryIds]) {
      const stored = await stores.memoryStore.get(ctx, memoryIds[0]!);
      expect(stored?.status).toBe("contested");
      expect(stored?.contestedWithId ?? null).toBeNull();
    }
  });
});

describe("claim key の検出: relationStore 配線時の穴A（既存の2者間の対の吸収）", () => {
  it("先に対になった1件目・2件目に、3件目が片方とだけ重なって届くと、対の相方も群に吸収される", async () => {
    // claim-key-single-contested-match.test.ts（PR1）と同じ再現の形——直す前に
    // unresolved_conflict になっていたシナリオを、relationStore 配線時には群として
    // 実際に吸収できることを見る。
    const { runtime, stores } = buildRuntimeWithStores(
      ["住所は東京", "住所は大阪", "住所は名古屋"],
      { withRelationStore: true },
    );

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は東京",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2025-01-01T00:00:00Z"),
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は大阪",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2019-01-01T00:00:00Z"),
      validUntil: new Date("2021-01-01T00:00:00Z"),
    });
    // 1件目・2件目は重なる（2020-2021）ので対になる——前提の確認。
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested", withMemoryId: first.memoryIds[0] }),
      }),
    ]);

    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は名古屋",
      claimKey: { enabled: true, detectContested: true },
      // 1件目（2020-2025）とだけ重なり、2件目（2019-2021）とは重ならない。
      validFrom: new Date("2024-01-01T00:00:00Z"),
      validUntil: new Date("2026-01-01T00:00:00Z"),
    });

    expect(third.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({
          kind: "contested_group",
          memberIds: expect.arrayContaining([
            first.memoryIds[0],
            second.memoryIds[0],
            third.memoryIds[0],
          ]),
        }),
      }),
    ]);

    // 1件目・2件目・3件目の全員が同じ群として contested になる——2件目（3件目とは
    // 直接重ならない）も、1件目経由の穴A吸収で群に入る。
    for (const memoryIds of [first.memoryIds, second.memoryIds, third.memoryIds]) {
      const stored = await stores.memoryStore.get(ctx, memoryIds[0]!);
      expect(stored?.status).toBe("contested");
      expect(stored?.contestedWithId ?? null).toBeNull();
    }
  });
});

describe("claim key の検出: relationStore 配線時の合併（既存の2つの群が1つに統合される）", () => {
  it("新しい記憶が2つの既存群それぞれのメンバーと直接重なると、両方の群の全メンバーが1つの群へ合流する", async () => {
    const { runtime, stores } = buildRuntimeWithStores(["新しい記憶"], {
      withRelationStore: true,
    });

    // 群1: g1a が広い窓（2019-2026）で g1b・g1c それぞれと重なる。g1b・g1c 同士、
    // および g1b・g1c と新しい記憶（2025 付近）は重ならない——BFS を経由しないと
    // 発見できないメンバーにする。
    const g1a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g1a",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2019-01-01T00:00:00Z"),
        validUntil: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    const g1b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g1b",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2019-01-01T00:00:00Z"),
        validUntil: new Date("2019-06-01T00:00:00Z"),
      }),
    );
    const g1c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g1c",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2023-01-01T00:00:00Z"),
        validUntil: new Date("2023-06-01T00:00:00Z"),
      }),
    );
    await runtime.markContestedGroup!(ctx, [g1a.id, g1b.id, g1c.id]);

    // 群2: 同じ形で g2a が g2b・g2c と重なる。
    const g2a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g2a",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2024-06-01T00:00:00Z"),
        validUntil: new Date("2028-01-01T00:00:00Z"),
      }),
    );
    const g2b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g2b",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2024-06-01T00:00:00Z"),
        validUntil: new Date("2024-07-01T00:00:00Z"),
      }),
    );
    const g2c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g2c",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2027-01-01T00:00:00Z"),
        validUntil: new Date("2027-06-01T00:00:00Z"),
      }),
    );
    await runtime.markContestedGroup!(ctx, [g2a.id, g2b.id, g2c.id]);

    // 新しい記憶は g1a・g2a の両方とだけ直接重なる（2025-01 〜 2025-02）。
    const triggering = await runtime.observe(ctx, {
      kind: "utterance",
      text: "新しい記憶",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2025-01-01T00:00:00Z"),
      validUntil: new Date("2025-02-01T00:00:00Z"),
    });

    expect(triggering.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 2,
        result: expect.objectContaining({ kind: "contested_group" }),
      }),
    ]);
    const detection = triggering.contestedDetection![0]!;
    if (detection.result.kind === "contested_group") {
      // 直接重なった g1a・g2a だけでなく、BFS で発見した g1b・g1c・g2b・g2c も
      // 同じ1つの群へ合流している。
      expect(detection.result.memberIds.sort()).toEqual(
        [triggering.memoryIds[0]!, g1a.id, g1b.id, g1c.id, g2a.id, g2b.id, g2c.id].sort(),
      );
    }
    for (const id of [triggering.memoryIds[0]!, g1a.id, g1b.id, g1c.id, g2a.id, g2b.id, g2c.id]) {
      const stored = await stores.memoryStore.get(ctx, id);
      expect(stored?.status).toBe("contested");
    }
  });
});

describe("claim key の検出: relationStore が配線されていなければ、群が3件未満にしか広がらない", () => {
  it("relationStore が配線されていなければ、穴A吸収だけでは3件に届かない構図は unresolved_conflict のままフォールバックする", async () => {
    // 既存群（3件以上、contestedWithId===null）のメンバー1件だけが新しい記憶と重なり、
    // relationStore が無いので残りのメンバーを辿れない——素朴に memberIdSet に
    // { triggering, matched1 } の2件しか集まらず、3件未満なので markContestedGroup を
    // 呼ばずに evidence-only へフォールバックする。
    const { runtime, stores } = buildRuntimeWithStores(["新しい記憶"], {
      withRelationStore: false,
    });
    const g1a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g1a",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2019-01-01T00:00:00Z"),
        validUntil: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    const g1b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g1b",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2019-01-01T00:00:00Z"),
        validUntil: new Date("2019-06-01T00:00:00Z"),
      }),
    );
    const g1c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "g1c",
        claimKey: ADDRESS_CLAIM_KEY,
        validFrom: new Date("2023-01-01T00:00:00Z"),
        validUntil: new Date("2023-06-01T00:00:00Z"),
      }),
    );
    // relationStore を配線していない runtime からでも markContestedGroup 自体は呼べる
    // （store 側は relationStore に依存しない）。
    await runtime.markContestedGroup!(ctx, [g1a.id, g1b.id, g1c.id]);

    const triggering = await runtime.observe(ctx, {
      kind: "utterance",
      text: "新しい記憶",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2020-02-01T00:00:00Z"),
    });

    expect(triggering.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);
    const stored = await stores.memoryStore.get(ctx, triggering.memoryIds[0]!);
    expect(stored?.status).toBe("active");
  });
});
