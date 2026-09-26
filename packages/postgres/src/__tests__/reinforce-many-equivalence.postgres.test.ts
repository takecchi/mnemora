import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Memory, MemoryStatus, NewMemory } from "@mnemora/core";
import { defaultActivityDecayStrategy } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * [Issue #874](https://github.com/takecchi/mnemora/issues/874) / ADR 0303 追記節
 * （2026-09-26、クローン miku）: `PostgresMemoryStore.reinforceMany` が
 * `PostgresMemoryStore.reinforce` を `ids` の各要素について呼んだのと**同じ結果**に
 * なることを、本物の Postgres で検査する等価性の歯。
 *
 * ## 何を比べるか
 *
 * 同じ初期状態を持つ2つのテナント（A・B）を用意し、
 * - テナント A には `reinforce` を1件ずつ呼ぶ（従来の `handleMemoryUsage` のループと
 *   同じ呼び方）
 * - テナント B には `reinforceMany` を1回呼ぶ
 *
 * を適用し、結果を**行ごとに**比較する。カバーする組み合わせ（歯1本で全部を1回に
 * まとめて検査する——`describe.each`/`it.each` にしないのは、失敗したときに
 * どの組み合わせが壊れたかを1つのエラーメッセージから読めるようにするため）:
 *
 * - 壁時計のみ（`halfLifeRecalls: null`）/ 活動時計あり（`halfLifeRecalls` 設定）の混在
 * - `lastReinforcedAt`: 未強化（`null`）・古い・等しい（`at` と同じ）・新しい、の4状態
 * - `status`: `active`/`contested`/`archived`/`superseded`/`forgotten` の混在
 *   （`reinforce`/`reinforceMany` はどちらも status を見ない契約——ADR 0303 追記節・
 *   Issue #840——なので、全 status で同じ結果になるはずである）
 *
 * ## 比べ方についての注意（確かめていないこと）
 *
 * **`updatedAt`/`createdAt` の値そのものは比較しない。**Postgres の `now()` は
 * 実行した SQL 文の時刻であり、テナント A（N回の文）とテナント B（1回の文）は
 * 実際に異なる壁時計の瞬間に実行される——**この歯は「行が書き込まれたかどうか
 * （`updatedAt` が初期値から動いたかどうか）」という boolean だけを比較し、
 * 動いた場合の実際の時刻の一致は求めない。** それ以外の列（`status`・`strength`・
 * `halfLifeHours`・`recordedAt`・`lastReinforcedAt`・`decayFloorAt`・`decayBaseSeq`・
 * `decayFloorSeq`・`halfLifeRecalls`）は、`reinforce`/`reinforceMany` のどちらも
 * 動かさないはずの列を含めて厳密に比較する。
 */

const RECORDED_AT = new Date("2026-01-01T00:00:00.000Z");
const AT = new Date("2026-06-01T00:00:00.000Z");
const OLDER_THAN_AT = new Date(AT.getTime() - 60 * 60 * 1000);
const NEWER_THAN_AT = new Date(AT.getTime() + 60 * 60 * 1000);
const NOW_SEQ = 42;
const INITIAL_BASE_SEQ = 10;
const HALF_LIFE_RECALLS = 5;
const STRENGTH = 1;
const HALF_LIFE_HOURS = 720;

const STATUSES: MemoryStatus[] = ["active", "contested", "archived", "superseded", "forgotten"];
const AT_STATES: { label: string; value: Date | null }[] = [
  { label: "unreinforced", value: null },
  { label: "older", value: OLDER_THAN_AT },
  { label: "equal", value: AT },
  { label: "newer", value: NEWER_THAN_AT },
];

interface Scenario {
  label: string;
  status: MemoryStatus;
  lastReinforcedAt: Date | null;
  halfLifeRecalls: number | null;
}

function buildScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const status of STATUSES) {
    for (const atState of AT_STATES) {
      scenarios.push({
        label: `${status}/${atState.label}/wall`,
        status,
        lastReinforcedAt: atState.value,
        halfLifeRecalls: null,
      });
      scenarios.push({
        label: `${status}/${atState.label}/activity`,
        status,
        lastReinforcedAt: atState.value,
        halfLifeRecalls: HALF_LIFE_RECALLS,
      });
    }
  }
  return scenarios;
}

function buildScenarioMemory(
  scenario: Scenario,
  index: number,
  contestedWithId: string,
): NewMemory {
  return buildNewMemoryFixture({
    tenantId: "placeholder", // seedTenant が上書きする
    contentHash: `reinforce-many-equivalence-${index}`,
    recordedAt: RECORDED_AT,
    lastReinforcedAt: scenario.lastReinforcedAt,
    strength: STRENGTH,
    halfLifeHours: HALF_LIFE_HOURS,
    // `decayFloorAt` はどうせ `reinforce`/`reinforceMany` が書き換えうる値なので、
    // 初期値そのものは何でもよい——両テナントで同じ計算をするので初期状態は揃う。
    decayFloorAt: RECORDED_AT,
    halfLifeRecalls: scenario.halfLifeRecalls,
    decayBaseSeq: scenario.halfLifeRecalls != null ? INITIAL_BASE_SEQ : null,
    decayFloorSeq:
      scenario.halfLifeRecalls != null
        ? defaultActivityDecayStrategy.floorAt({
            baseSeq: INITIAL_BASE_SEQ,
            strength: STRENGTH,
            halfLifeRecalls: scenario.halfLifeRecalls,
          })
        : null,
    status: scenario.status,
    // ADR 0140: `status: 'contested'` は non-null な `contestedWithId` を要求する。
    // ⚠ interface 側の doc コメント（Issue #854）は「テナント一致は検査しない」と
    // 書いているが、**実在そのものは `memories.memories_contested_with_id_fkey`
    // （外部キー）で強制される**——存在しない id を渡すと INSERT 自体が失敗する
    // （【実測】このテストを書く過程で確認した）。そのため実在する companion 行
    // （`seedTenant` が先に作る、対象外の `active` な1行）を指す。
    contestedWithId: scenario.status === "contested" ? contestedWithId : null,
  });
}

async function seedTenant(
  store: PostgresMemoryStore,
  tenantId: string,
  scenarios: Scenario[],
): Promise<Memory[]> {
  // `contested` シナリオの対向として使う、シナリオ本体とは別の1行。
  const companion = await store.createMemory(
    { tenantId },
    buildNewMemoryFixture({ tenantId, contentHash: "reinforce-many-equivalence-companion" }),
  );

  const results: Memory[] = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const memory = await store.createMemory(
      { tenantId },
      { ...buildScenarioMemory(scenarios[i]!, i, companion.id), tenantId },
    );
    results.push(memory);
  }
  return results;
}

/** 比較対象の列だけを取り出す。`id`/`tenantId`/`createdAt`/`updatedAt` は比較しない。 */
function comparableFields(memory: Memory) {
  return {
    status: memory.status,
    strength: memory.strength,
    halfLifeHours: memory.halfLifeHours,
    recordedAt: memory.recordedAt.getTime(),
    lastReinforcedAt: memory.lastReinforcedAt ? memory.lastReinforcedAt.getTime() : null,
    decayFloorAt: memory.decayFloorAt.getTime(),
    decayBaseSeq: memory.decayBaseSeq ?? null,
    decayFloorSeq: memory.decayFloorSeq ?? null,
    halfLifeRecalls: memory.halfLifeRecalls ?? null,
  };
}

describe("PostgresMemoryStore.reinforceMany と reinforce の1件ずつループの等価性（Issue #874）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("同じ初期状態に対して、reinforce を1件ずつ呼んだ結果と reinforceMany を1回呼んだ結果が全シナリオで一致する", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const scenarios = buildScenarios();

    const tenantLoop = `tenant-rme-loop-${randomUUID()}`;
    const tenantBatch = `tenant-rme-batch-${randomUUID()}`;

    const beforeLoop = await seedTenant(store, tenantLoop, scenarios);
    const beforeBatch = await seedTenant(store, tenantBatch, scenarios);

    // 検算: 2つのテナントの初期状態が実際に一致していること（比較の前提）。
    expect(beforeBatch.map(comparableFields)).toEqual(beforeLoop.map(comparableFields));

    const opts = { nowSeq: NOW_SEQ };

    // テナント A: 従来の `handleMemoryUsage` と同じ、1件ずつのループ。
    for (const memory of beforeLoop) {
      await store.reinforce({ tenantId: tenantLoop }, memory.id, AT, opts);
    }

    // テナント B: 一括版を1回だけ。
    await store.reinforceMany({ tenantId: tenantBatch }, beforeBatch.map((m) => m.id), AT, opts);

    const afterLoop = await Promise.all(
      beforeLoop.map((m) => store.get({ tenantId: tenantLoop }, m.id)),
    );
    const afterBatch = await Promise.all(
      beforeBatch.map((m) => store.get({ tenantId: tenantBatch }, m.id)),
    );

    const report = scenarios.map((scenario, i) => {
      const loopBefore = beforeLoop[i]!;
      const loopAfter = afterLoop[i]!;
      const batchBefore = beforeBatch[i]!;
      const batchAfter = afterBatch[i]!;
      expect(loopAfter, `テナント A（1件ずつ）: ${scenario.label}`).not.toBeNull();
      expect(batchAfter, `テナント B（一括）: ${scenario.label}`).not.toBeNull();
      return {
        label: scenario.label,
        loop: {
          ...comparableFields(loopAfter),
          moved: loopAfter.updatedAt.getTime() !== loopBefore.updatedAt.getTime(),
        },
        batch: {
          ...comparableFields(batchAfter),
          moved: batchAfter.updatedAt.getTime() !== batchBefore.updatedAt.getTime(),
        },
      };
    });

    for (const { label, loop, batch } of report) {
      expect(batch, `シナリオ不一致: ${label}`).toEqual(loop);
    }

    // 検算: 少なくとも一部のシナリオは実際に書き込まれ（no-op ではなく）、
    // 一部は no-op のままである——無意味な等号にしない。
    expect(report.some((r) => r.loop.moved)).toBe(true);
    expect(report.some((r) => !r.loop.moved)).toBe(true);

    // memory_events は増えない（reinforce/reinforceMany はどちらも書かない契約）。
    const events = await db.execute(sql`
      SELECT count(*)::int AS n FROM memory_events
      WHERE tenant_id = ANY(${sql.param([tenantLoop, tenantBatch])}::text[])
    `);
    expect((events.rows[0] as unknown as { n: number }).n).toBe(0);
  });
});
