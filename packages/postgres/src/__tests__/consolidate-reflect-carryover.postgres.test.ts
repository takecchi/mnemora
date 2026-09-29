import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, LLMProvider, Memory, StructuredRequest } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 「記憶を作り替える操作の後の付随データの引き継ぎ」バグ探し（consolidate/reflect、
 * 新しい記憶を作る系）を、擬似物ではなく本物の Postgres に対して端から端で検査する。
 *
 * **このファイルが埋める穴**: `packages/postgres/src/__tests__` には
 * `runtime.consolidate`/`runtime.reflect` を実際に Postgres に対して走らせる歯が
 * 1本も無かった（探索時点の実測）——`packages/core` の歯は `runtime-fakes.ts` の Fake
 * だけを対象にしており、Postgres 側は `memory-store-conformance.ts` 経由で
 * `supersedeWithNewMemories` 単体の契約しか見ていない。
 *
 * 検査する不変条件（`strategies/consolidate.ts`/`strategies/reflect.ts` の doc コメント、
 * `docs/memory-model.md` §11 行12・13、ADR 0089/0312/0318 が出典）:
 * - `subjectId`: eligible 全件が一致すればその値、割れていれば `null`。
 * - `tags`: LLM が返さなければ eligible の和集合。
 * - `attributes`: eligible 全件の積集合（ADR 0312 決定4）。
 * - `occurredAt`: eligible のうち最新。
 * - `provenance`: `{ kind, sources: <eligible の memoryId> }`。
 * - `embeddingStatus: 'pending'` → outbox に `embed` ジョブ → `tick()` で `'ready'` →
 *   ANN で引ける。
 * - `labels`（`memory_labels`/`labels`、ADR 0318）: 新しい行の `tags` から `proposed`
 *   ラベルが実際に作られる。
 * - 統合元は `status: 'superseded'`、`supersededById` が統合先を指す。反映は元に一切
 *   書き込まない。
 * - atomic 経路（`supersedeWithNewMemories` あり）とフォールバック経路（`createMemoryWithOutbox`
 *   + ループ）で、書き込まれる中身が同じであること（ADR 0100）。
 */

const TENANT = "carryover-tenant";

// `occurredAt` は recall() の freshness/decay 計算にそのまま使われる——固定した過去の
// 暦日（例: 2026-01-01）にすると、実行時の実時刻との差が半減期（既定 halfLifeHours=720h
// =30日）の何倍にもなり、below_threshold に落ちて ANN 到達性の歯が意味を失う
// （`recall.postgres.test.ts` の `buildTestRuntime` の doc コメントと同じ実測）。
// ⟹ 実時刻からの相対値にする。
const OCCURRED_AT_A = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2時間前
const OCCURRED_AT_B = new Date(Date.now() - 60 * 60 * 1000); // 1時間前（A より新しい）

function llmReturning<T>(result: T): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
      req.schema.parse(result) as U,
  };
}

async function buildRuntime(memoryStore: PostgresMemoryStore, llmProvider: LLMProvider) {
  const { db } = await getTestClient();
  return createRuntime({
    memoryStore,
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    // 🔴 `clock` は実時刻より 1 秒だけ未来を返す。outbox の `available_at` は DB 側の `now()`（マイクロ秒）で
    // 書かれるが、既定の `systemClock` は JavaScript の `Date`（ミリ秒で切り捨て）なので、書いた直後の
    // `tick()` が同じミリ秒に入ると、積んだばかりの行が `available_at <= now` を満たさず claim できない
    // （Issue #719・#1002・PR #834 と同じ穴。runtime の時計を数 ms 遅らせると、この it は確実に赤になる）。
    // 1 秒は `leaseMs` よりずっと小さいので、claim 済みの行がリース切れとして取り直されることはない。
    clock: { now: () => new Date(Date.now() + 1_000) },
    // ⚠ `clock` を固定しない——`tick()` は `outboxStore.claimBatch` に `clock.now()` を渡し、
    // `outbox.available_at`（`createMemoryWithOutbox`/`supersedeWithNewMemories` が SQL の
    // `now()` で書く実時刻）と比較する。ここを過去に固定すると
    // `available_at <= now` が常に偽になり、`tick()` が1件も claim できない
    // （実測。recall.postgres.test.ts が固定しているのは decay 計算のためで、あちらは
    // tick() を呼ばないので問題にならない）。
  });
}

async function seedTwoActiveMemories(memoryStore: PostgresMemoryStore, ctx: Ctx) {
  const a = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "carryover-a",
      content: "本文A",
      subjectId: "subject-shared",
      tags: ["tag-a", "tag-shared"],
      attributes: { visibility: "internal", region: "jp" },
      occurredAt: OCCURRED_AT_A,
    }),
  );
  const b = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "carryover-b",
      content: "本文B",
      subjectId: "subject-shared",
      tags: ["tag-b", "tag-shared"],
      attributes: { visibility: "internal", region: "us" },
      occurredAt: OCCURRED_AT_B,
    }),
  );
  return { a, b };
}

async function labelsFor(memoryStore: PostgresMemoryStore, ctx: Ctx) {
  const labels = (await memoryStore.listLabels?.(ctx)) ?? [];
  return new Map(labels.map((l) => [l.name, l]));
}

describe("runtime.consolidate/reflect — 付随データの引き継ぎ（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("consolidate（atomic 経路）: subjectId・tags 和集合・attributes 積集合・occurredAt 最新・provenance・labels・embed ジョブ・元の supersede が約束どおり", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { a, b } = await seedTwoActiveMemories(memoryStore, ctx);

    const runtime = await buildRuntime(
      memoryStore,
      llmReturning({ content: "統合後の本文" }), // digest/tags 省略 → フォールバック経路
    );

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.outcome).toBe("consolidated");
    expect(result.atomicity).toBe("store_supported");
    const newId = result.consolidatedMemoryId!;

    const created = await memoryStore.get(ctx, newId);
    expect(created).not.toBeNull();
    // subjectId: 両方一致 → その値。
    expect(created!.subjectId).toBe("subject-shared");
    // tags: LLM が返さない → eligible の和集合。
    expect(new Set(created!.tags)).toEqual(new Set(["tag-a", "tag-shared", "tag-b"]));
    // attributes: 積集合（region は割れているので落ちる。visibility は一致するので残る）。
    expect(created!.attributes).toEqual({ visibility: "internal" });
    // occurredAt: 最新（b の 2026-06-01）。
    expect(created!.occurredAt?.toISOString()).toBe(OCCURRED_AT_B.toISOString());
    // provenance: consolidated、sources は eligible の memoryId。
    expect(created!.provenance).toEqual({ kind: "consolidated", sources: [a.id, b.id] });
    // sourceObservationId/extractorVersion は常に null。
    expect(created!.sourceObservationId).toBeNull();
    expect(created!.extractorVersion).toBeNull();
    // embeddingStatus は pending で始まる。
    expect(created!.embeddingStatus).toBe("pending");
    // strength/halfLifeHours
    expect(created!.strength).toBe(1);

    // validFrom/validUntil: eligible の区間の積（Issue #1188 残り、ADR 0368）。a・b は
    // どちらも持たない（`seedTwoActiveMemories` は付けていない）ので、積も両方 null——
    // 下の専用の it が実際に非 null な区間を持つケースを検査する。
    // claimKey: buildConsolidatedMemory は約束していない
    // （strategies/consolidate.ts に doc コメントが無い、docs/memory-model.md 負債3）。
    // 実際の挙動を記録するだけ——落ちて null になる。
    expect(created!.validFrom).toBeNull();
    expect(created!.validUntil).toBeNull();
    expect(created!.claimKey).toBeNull();

    // 元は superseded、supersededById が統合先を指す。中身は書き換わらない。
    const aAfter = await memoryStore.get(ctx, a.id);
    const bAfter = await memoryStore.get(ctx, b.id);
    expect(aAfter!.status).toBe("superseded");
    expect(aAfter!.supersededById).toBe(newId);
    expect(aAfter!.content).toBe("本文A");
    expect(bAfter!.status).toBe("superseded");
    expect(bAfter!.supersededById).toBe(newId);

    // labels: 新しい行の tags から proposed ラベルが作られている（ADR 0318）。
    const labels = await labelsFor(memoryStore, ctx);
    // a・b の作成時にも tag-a/tag-shared/tag-b/tag-shared が既に proposedCount を進めている
    // ので、consolidate 後は「a作成 + b作成 + consolidate作成」の重ね合わせになる。
    // ここで検査したいのは「consolidate が作った行の分もちゃんと積まれているか」——
    // tag-shared は a(1) + b(1) + new(1) = 3。tag-a/tag-b は a/b(1) + new(1) = 2。
    expect(labels.get("tag-shared")?.proposedCount).toBe(3);
    expect(labels.get("tag-a")?.proposedCount).toBe(2);
    expect(labels.get("tag-b")?.proposedCount).toBe(2);

    // embed ジョブが outbox に積まれている。
    const outboxRows = await db.execute(sql`
      SELECT * FROM outbox WHERE tenant_id = ${TENANT} AND kind = 'embed' AND completed_at IS NULL
    `);
    expect(outboxRows.rows).toHaveLength(1);

    // tick() で処理すると ready になり、ANN で引ける。
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });
    const readyMemory = await memoryStore.get(ctx, newId);
    expect(readyMemory!.embeddingStatus).toBe("ready");

    const table = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    const embeddingRows = await db.execute(sql`
      SELECT * FROM ${sql.identifier(table)} WHERE tenant_id = ${TENANT} AND memory_id = ${newId}
    `);
    expect(embeddingRows.rows).toHaveLength(1);

    const recallResult = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 10 });
    const recalledIds = recallResult.memories.map((m) => m.memoryId);
    expect(recalledIds).toContain(newId);
    // superseded になった元は active/contested ではないので recall には出てこない。
    expect(recalledIds).not.toContain(a.id);
    expect(recalledIds).not.toContain(b.id);
  });

  it("consolidate（atomic 経路 vs フォールバック経路）: 結果が同値になる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const ctx: Ctx = { tenantId: TENANT };

    // --- atomic 経路 ---
    const atomicStore = new PostgresMemoryStore(db);
    const { a: a1, b: b1 } = await seedTwoActiveMemories(atomicStore, ctx);
    const atomicRuntime = await buildRuntime(
      atomicStore,
      llmReturning({ content: "統合後の本文" }),
    );
    const atomicResult = await atomicRuntime.consolidate(ctx, {
      target: { memoryIds: [a1.id, b1.id] },
    });
    expect(atomicResult.atomicity).toBe("store_supported");
    const atomicNew = await atomicStore.get(ctx, atomicResult.consolidatedMemoryId!);
    // ⚠ 次の `resetTestDatabase()` がこのテナントの行を消すため、比較に使う値は
    // ここで（消える前に）読み切っておく。
    const aAfter1 = await atomicStore.get(ctx, a1.id);
    const labels1 = await labelsFor(atomicStore, ctx);

    // --- フォールバック経路（口を外した Postgres store） ---
    await resetTestDatabase();
    const fallbackStore = new PostgresMemoryStore(db);
    (fallbackStore as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories = undefined;
    const { a: a2, b: b2 } = await seedTwoActiveMemories(fallbackStore, ctx);
    const fallbackRuntime = await buildRuntime(
      fallbackStore,
      llmReturning({ content: "統合後の本文" }),
    );
    const fallbackResult = await fallbackRuntime.consolidate(ctx, {
      target: { memoryIds: [a2.id, b2.id] },
    });
    expect(fallbackResult.atomicity).toBe("store_unsupported");
    const fallbackNew = await fallbackStore.get(ctx, fallbackResult.consolidatedMemoryId!);

    // 同じ入力・同じ LLM 結果なら、id/timestamps を除いた中身が一致するはず。
    // `recordedAt`/`decayFloorAt` は `now`（呼び出し時点の実時刻）由来なので、2回の
    // 呼び出しの間で実際に数ミリ秒ずれる——両方とも比較から外す(意味のある不一致ではない)。
    function normalize(m: Memory) {
      const { id, createdAt, updatedAt, recordedAt, decayFloorAt, provenance, ...rest } = m;
      return {
        ...rest,
        // provenance.sources は元 memory の id を含むため、2セットの id は違う——
        // sources の"数"と kind だけ揃える。
        provenanceKind: (provenance as { kind: string }).kind,
      };
    }
    expect(normalize(atomicNew!)).toEqual(normalize(fallbackNew!));

    const aAfter2 = await fallbackStore.get(ctx, a2.id);
    expect(aAfter1!.status).toBe(aAfter2!.status);
    expect(aAfter1!.supersededById).toBe(atomicResult.consolidatedMemoryId);
    expect(aAfter2!.supersededById).toBe(fallbackResult.consolidatedMemoryId);

    // labels の付随結果も同じ（両方とも同じ tags の新しい行を1件作っている）。
    const labels2 = await labelsFor(fallbackStore, ctx);
    expect([...labels1.entries()].sort()).toEqual([...labels2.entries()].sort());
  });

  it("reflect: provenance.kind='reflected' で sources が埋まり、既存の行へは一切書き込まない。attributes は積集合", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { a, b } = await seedTwoActiveMemories(memoryStore, ctx);

    const runtime = await buildRuntime(
      memoryStore,
      llmReturning({ outcome: "reflected", content: "反映結果の本文" }),
    );

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(result.outcome).toBe("reflected");
    const newId = result.reflectedMemoryId!;

    const created = await memoryStore.get(ctx, newId);
    expect(created!.provenance).toEqual({ kind: "reflected", sources: [a.id, b.id] });
    expect(created!.subjectId).toBe("subject-shared");
    expect(created!.attributes).toEqual({ visibility: "internal" });
    expect(new Set(created!.tags)).toEqual(new Set(["tag-a", "tag-shared", "tag-b"]));
    expect(created!.strength).toBe(1);
    expect(created!.embeddingStatus).toBe("pending");
    // validFrom/validUntil: eligible の区間の積（Issue #1188 残り、ADR 0368）。a・b は
    // どちらも持たないので、積も両方 null——下の専用の it が非 null な区間を検査する。
    expect(created!.validFrom).toBeNull();
    expect(created!.validUntil).toBeNull();
    expect(created!.claimKey).toBeNull();

    // 既存の行は一切書き換わらない——status も content も元のまま。
    const aAfter = await memoryStore.get(ctx, a.id);
    const bAfter = await memoryStore.get(ctx, b.id);
    expect(aAfter!.status).toBe("active");
    expect(aAfter!.supersededById).toBeNull();
    expect(bAfter!.status).toBe("active");
    expect(bAfter!.supersededById).toBeNull();

    // labels: reflect が作った行の tags からも proposed ラベルが作られる。
    const labels = await labelsFor(memoryStore, ctx);
    expect(labels.get("tag-shared")?.proposedCount).toBe(3);

    // embed ジョブ → tick → ready → ANN で引ける。superseded ではないので a/b も引ける。
    const outboxRows = await db.execute(sql`
      SELECT * FROM outbox WHERE tenant_id = ${TENANT} AND kind = 'embed' AND completed_at IS NULL
    `);
    expect(outboxRows.rows).toHaveLength(1);
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult.processed).toBe(1);
    const readyMemory = await memoryStore.get(ctx, newId);
    expect(readyMemory!.embeddingStatus).toBe("ready");
  });

  /**
   * Issue #1188 残り（ADR 0368）: `validFrom`/`validUntil` は eligible の区間の積で、
   * `Date`（timestamptz）として本物の Postgres を実際に往復する——`buildNewMemoryFixture`
   * で書き込み、`PostgresMemoryStore.get` で読み戻した値が、JS の `Date` として一致する
   * ことを確かめる（マイクロ秒側の丸めで ms がずれないこと）。
   */
  it("consolidate/reflect: validFrom/validUntil は eligible の区間の積として Postgres を往復する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    // `buildRuntime` の clock は実時刻+1秒（上のコメント参照）なので、eligible 判定
    // （`classifyValidity`）を通すには実時刻からの相対値にする必要がある
    // （`OCCURRED_AT_A`/`OCCURRED_AT_B` と同じ理由）。
    const validFromE = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2時間前
    const validUntilE = new Date(Date.now() + 100 * 60 * 60 * 1000); // 100時間後
    const validFromF = new Date(Date.now() - 30 * 60 * 1000); // 30分前（E より後 ⟹ 積の validFrom）
    const validUntilF = new Date(Date.now() + 50 * 60 * 60 * 1000); // 50時間後（E より前 ⟹ 積の validUntil）

    async function seedEAndF(store: PostgresMemoryStore) {
      const e = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `carryover-validity-e-${Math.random()}`,
          content: "本文E",
          validFrom: validFromE,
          validUntil: validUntilE,
        }),
      );
      const f = await store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `carryover-validity-f-${Math.random()}`,
          content: "本文F",
          validFrom: validFromF,
          validUntil: validUntilF,
        }),
      );
      return { e, f };
    }

    const { e: e1, f: f1 } = await seedEAndF(memoryStore);
    const consolidateRuntime = await buildRuntime(
      memoryStore,
      llmReturning({ content: "統合後の本文" }),
    );
    const consolidateResult = await consolidateRuntime.consolidate(ctx, {
      target: { memoryIds: [e1.id, f1.id] },
    });
    expect(consolidateResult.outcome).toBe("consolidated");
    const consolidated = await memoryStore.get(ctx, consolidateResult.consolidatedMemoryId!);
    // validFrom は最大値（F 側）、validUntil は最小値（F 側）。
    expect(consolidated!.validFrom?.toISOString()).toBe(validFromF.toISOString());
    expect(consolidated!.validUntil?.toISOString()).toBe(validUntilF.toISOString());

    const { e: e2, f: f2 } = await seedEAndF(memoryStore);
    const reflectRuntime = await buildRuntime(
      memoryStore,
      llmReturning({ outcome: "reflected", content: "反映結果の本文" }),
    );
    const reflectResult = await reflectRuntime.reflect(ctx, {
      target: { memoryIds: [e2.id, f2.id] },
    });
    expect(reflectResult.outcome).toBe("reflected");
    const reflected = await memoryStore.get(ctx, reflectResult.reflectedMemoryId!);
    expect(reflected!.validFrom?.toISOString()).toBe(validFromF.toISOString());
    expect(reflected!.validUntil?.toISOString()).toBe(validUntilF.toISOString());
  });

  it("consolidate: subjectId が割れていれば null になる（eligible の主題が一致しない）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "split-a", subjectId: "s1" }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "split-b", subjectId: "s2" }),
    );
    const runtime = await buildRuntime(memoryStore, llmReturning({ content: "統合後" }));
    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const created = await memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created!.subjectId).toBeNull();
  });

  it("consolidate: 新しい行の content は lexical（trigram）チャンネルで直接引ける。元（superseded）は引けない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      // ADR 0103: この環境では前提（UTF8 等）が満たせない——`trigram-lexical-store.postgres.test.ts`
      // が別途この否定を検査済みであり、ここでは重ねて検査しない。
      return;
    }
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const { a, b } = await seedTwoActiveMemories(memoryStore, ctx);
    const runtime = await buildRuntime(
      memoryStore,
      llmReturning({ content: "統合結果のトライグラム照合用本文" }),
    );
    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    const newId = result.consolidatedMemoryId!;

    // `docs/memory-model.md`/AGENTS.md: Postgres は `memories.content` を trigram で
    // 直接引く——embed ジョブの完了を待たずに引けるはず（embeddingStatus とは無関係な経路）。
    const lexicalStore = await PostgresTrigramLexicalStore.create(db);
    const hits = await lexicalStore.search(ctx, "トライグラム照合用本文", {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });
    const hitIds = hits.map((h) => h.memoryId);
    expect(hitIds).toContain(newId);
    expect(hitIds).not.toContain(a.id);
    expect(hitIds).not.toContain(b.id);
  });
});
