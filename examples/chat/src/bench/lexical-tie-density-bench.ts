#!/usr/bin/env node
/**
 * `lexical-tie-density` ベンチ。語彙チャンネルが返す候補のタイ密度（同点の母集団が `limit` を超える割合）を数える。
 *
 * 測定であり判定ではない。どの数字が出ても exit code は変えない。
 *
 * `buildLexicalSearchSelect` を、そのまま呼ぶ。正規表現・SQL をここへ書き写さない（`lexical-store.ts` が禁じている理由と同じ）。
 * `limit` も `packages/core` の既定値から計算し、数値を書き写さない。
 *
 * corpus は `probe-set.ts` の発話を `memories.content` へ直接 INSERT する。実際の `retrieval` ベンチは LLM 抽出を
 * 経由して `content` が fact になるが、抽出結果を録るには実 API 鍵が要るため、これはプロクシである。
 * 抽出後の `content` でも同じタイ密度になるかは、この bench では測れない。
 *
 * 実コーパスにはタイが起きる例が1つも無く、「タイが0件」が「この道具はタイを検出できる」を意味しなくなる。
 * そのため別テナントに重複コンテンツ（`CONTROL_PHRASE`）を仕込み、検出できることを先に確かめる（陽性対照）。
 */

import type { Db, PostgresClient } from "@mnemora/postgres";
import { DEFAULT_OVER_FETCH_FACTOR, DEFAULT_RECALL_LIMIT } from "@mnemora/core";
import {
  buildLexicalSearchSelect,
  closePostgresClient,
  createPostgresClient,
  runMigrations,
} from "@mnemora/postgres";
import { buildProbeSetConversation, PROBES } from "../probe-set.js";
import type { LexicalCandidateRow, TieDensityMeasurement } from "../lexical-tie-density-lib.js";
import { measureTieDensityFromRows, renderTieDensityReport } from "../lexical-tie-density-lib.js";

const TENANT_REAL = "lexical-tie-density-bench-real";
const TENANT_CONTROL = "lexical-tie-density-bench-control";

/** 母集団を切り詰めないための、実コーパスの行数より十分大きい値。 */
const UNCAPPED_LIMIT = 10_000;

const PRODUCTION_LIMIT = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));

const CONTROL_PHRASE = (i: number): string =>
  `quartz lantern echoes near meridian gate marker ${i}`;
const CONTROL_QUERY = "quartz lantern";
const CONTROL_ROW_COUNT = 5;
const CONTROL_LIMIT = 3;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。lexical-tie-density-bench は本物の Postgres + " +
        "pgvector を要求する（擬似物では代替しない）。AGENTS.md の手元 Postgres の立て方を参照。",
    );
  }
  return url;
}

async function resetTenant(pool: PostgresClient["pool"], tenantId: string): Promise<void> {
  await pool.query("DELETE FROM memories WHERE tenant_id = $1", [tenantId]);
}

/**
 * `utterances` を `memories.content` へ直接 INSERT する（LLM 抽出は経由しない）。
 * `recorded_at` は `ORDER BY` の3段目でしか使われず、`coverage`/`rank` には影響しない。
 */
async function seedContentRows(
  pool: PostgresClient["pool"],
  tenantId: string,
  contents: readonly string[],
): Promise<void> {
  const total = contents.length;
  for (let i = 0; i < total; i += 1) {
    await pool.query(
      `
      INSERT INTO memories (
        id, tenant_id, subject_id, content, content_hash, digest, digest_source,
        provenance_kind, provenance, status, tags, occurred_at, recorded_at,
        last_reinforced_at, strength, half_life_hours, decay_floor_at,
        embedding_status, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, NULL, $2, $3, $4, 'llm',
        'imported', '{"kind":"imported","batchId":"lexical-tie-density-bench"}'::jsonb,
        'active', '{}', NULL, now() - ($5 || ' seconds')::interval,
        NULL, 1.0, 720, now() + interval '30 days',
        'ready', now() - ($5 || ' seconds')::interval, now() - ($5 || ' seconds')::interval
      )
      `,
      [
        tenantId,
        contents[i],
        `lexical-tie-density-bench-hash-${tenantId}-${i}`,
        `lexical-tie-density-bench-digest-${i}`,
        total - i,
      ],
    );
  }
}

async function runLexicalSearch(
  db: Db,
  tenantId: string,
  query: string,
): Promise<LexicalCandidateRow[]> {
  const select = buildLexicalSearchSelect(query, {
    limit: UNCAPPED_LIMIT,
    filter: { tenantId, status: ["active", "contested"] },
  });
  const result = await db.execute(select);
  return result.rows.map((row) => {
    const r = row as unknown as { memory_id: string; coverage: number; rank: number };
    return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };
  });
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const client = createPostgresClient(databaseUrl);
  const { pool, db } = client;

  try {
    await runMigrations(pool);

    // --- 実コーパス ---
    await resetTenant(pool, TENANT_REAL);
    const conversation = buildProbeSetConversation();
    await seedContentRows(
      pool,
      TENANT_REAL,
      conversation.map((u) => u.text),
    );
    console.log(
      `[lexical-tie-density-bench] 実コーパス投入完了: ${conversation.length}行 ` +
        `(tenant=${TENANT_REAL})`,
    );

    const realMeasurements: TieDensityMeasurement[] = [];
    for (const probe of PROBES) {
      const rows = await runLexicalSearch(db, TENANT_REAL, probe.query);
      realMeasurements.push(
        measureTieDensityFromRows(`probe:${probe.id}`, probe.query, PRODUCTION_LIMIT, rows),
      );
    }
    for (const [label, query] of [
      ["ascii:TypeScript", "TypeScript"],
      ["ascii:Rust", "Rust"],
      ["ascii:Go", "Go"],
      ["ascii:combined", "TypeScript Rust Go"],
    ] as const) {
      const rows = await runLexicalSearch(db, TENANT_REAL, query);
      realMeasurements.push(measureTieDensityFromRows(label, query, PRODUCTION_LIMIT, rows));
    }

    // --- 陽性対照（別テナント）---
    await resetTenant(pool, TENANT_CONTROL);
    const controlContents = Array.from({ length: CONTROL_ROW_COUNT }, (_, i) =>
      CONTROL_PHRASE(i + 1),
    );
    await seedContentRows(pool, TENANT_CONTROL, controlContents);
    console.log(
      `[lexical-tie-density-bench] 陽性対照投入完了: ${controlContents.length}行 ` +
        `(tenant=${TENANT_CONTROL})`,
    );
    const controlRows = await runLexicalSearch(db, TENANT_CONTROL, CONTROL_QUERY);
    const controlMeasurement = measureTieDensityFromRows(
      "control:quartz-lantern",
      CONTROL_QUERY,
      CONTROL_LIMIT,
      controlRows,
    );

    console.log("");
    console.log("# lexical-tie-density-bench（結果。⛔ 判定ではない。測っただけ）");
    console.log("");
    console.log(
      `measured at: ${new Date().toISOString()} / PRODUCTION_LIMIT(kPrime, 既定値から算出)=${PRODUCTION_LIMIT} / ` +
        `CONTROL_LIMIT=${CONTROL_LIMIT}`,
    );
    console.log("");
    console.log("## 陽性対照（先に見ること — 道具が実際にタイを検出できるかの確認）");
    console.log("");
    console.log(renderTieDensityReport([controlMeasurement]));
    console.log("");
    if (controlMeasurement.tieGroups.some((g) => g.count > 1)) {
      console.log(
        "✅ 陽性対照は実際にタイ集団を検出した——道具は生きている。以下の「実コーパス」の" +
          "結果は、道具が死んでいるからではない。",
      );
    } else {
      console.log(
        "🔴 陽性対照でタイが検出できなかった——道具そのものが壊れている可能性がある。" +
          "以下の「実コーパス」の結果は、この理由だけでは信頼できない。",
      );
    }
    console.log("");
    console.log("## 実コーパス（retrieval ベンチの語彙構成。ADR 0148。probe 7件 + ASCII 語彙4件）");
    console.log("");
    console.log(renderTieDensityReport(realMeasurements));
    console.log("");
    const probeCandidateTotal = realMeasurements
      .filter((m) => m.queryLabel.startsWith("probe:"))
      .reduce((sum, m) => sum + m.totalCandidates, 0);
    console.log(
      `probe 7件の総候補数（合計）: ${probeCandidateTotal}` +
        (probeCandidateTotal === 0
          ? "（ADR 0148 の静的な記述——日本語のみのクエリは非ASCII除去で空の tsquery になる——と一致する）"
          : ""),
    );
  } finally {
    await closePostgresClient(client);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
