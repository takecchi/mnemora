#!/usr/bin/env node
/**
 * `lexical-tie-density` ベンチ（`pnpm --filter @mnemora/example-chat run lexical-tie-density-bench`）。
 *
 * ## これは何を測るか
 *
 * [Issue #394](https://github.com/takecchi/mnemora/issues/394) 本文「次に測るべきこと」
 * 1番の実装:
 *
 * > `retrieval` ベンチの語彙チャンネル構成で、返ってきた候補のタイ密度を数える。
 * > （同点の母集団が `limit` を超える割合）⟹ 実データ寄りのコーパスで起きるのかどうかが、
 * > これで分かる。
 *
 * ⛔ **これは測定であり、判定ではない。** どの数字が出ても exit code は変えない
 * （`embedding-fingerprint.ts`／`packages/postgres/src/bench/scale-bench.ts` と同じ規律）。
 * Issue #394 の「取り扱い（v1.0 を止めるか・案1〜4のどれを採るか）」には**何も答えない**。
 *
 * ## 何を「retrieval ベンチの語彙チャンネル構成」とするか
 *
 * [ADR 0148](../../../docs/decisions/0148-bench-lexical-channel-selectable-default-unchanged.md)
 * が実際に配線した経路（`MNEMORA_BENCH_CHANNELS=ann,lexical` で選べる語彙チャンネル）が
 * 打つ SQL は `PostgresLexicalStore.search` → `buildLexicalSearchSelect`
 * （`@mnemora/postgres`）である。**この関数を、そのまま**呼ぶ（正規表現・SQL を
 * このファイルに書き写さない——`lexical-store.ts` の docstring が禁じている理由と同じ）。
 *
 * `limit` は `packages/core` の既定値から導く（`recall-runtime.ts` の
 * `kPrime = round(limit * overFetchFactor)`。既定は `10 * 4 = 40`）——
 * ここも数値を書き写さず `DEFAULT_RECALL_LIMIT`/`DEFAULT_OVER_FETCH_FACTOR` を import
 * して計算する（AGENTS.md「数を、道具と生成物に焼き込まない」の適用。`main` が既定値を
 * 動かせば、この計算も自動的に追随する）。
 *
 * ## corpus について — ⚠ 実際の抽出（LLM）は経由していない
 *
 * `examples/chat/src/probe-set.ts` の `buildProbeSetConversation()` が組む発話
 * （gold 7件・distractor 7件・haystack 60件、計74件）を**そのまま `memories.content` に
 * 直接 INSERT する**（`buildLexicalSearchSelect` と同じ形の生 SQL、
 * `packages/postgres/src/__tests__/lexical-store-index.test.ts` の `seedManyMemories`・
 * `packages/postgres/src/bench/scale-bench.ts` の `seedMemories` と同じ作法）。
 *
 * **実際の `retrieval` ベンチは `observe()`→LLM 抽出→`tick()` を経由し、`memories.content`
 * は発話そのものではなく LLM が抽出した fact になる**（記録済みカセット
 * `examples/chat/cassettes/retrieval.json` の再生、鍵は要らない）。この bench はその
 * 抽出ステップを経由していない——**プロクシである**。プロクシにした理由:
 * (a) 抽出結果は非決定ではない領域があり、`content` の厳密な文字列は保証されない
 *     （fact の言い回しは LLM 依存）。(b) この bench が測りたいのは
 *     「`buildLexicalSearchSelect` という SQL が、この語彙構成の**発話**に対して
 *     どういう分解能を持つか」であり、発話それ自体は `probe-set.ts` が決定的に生成する
 *     （`buildHaystackUtterance` は乱数を使わない）。
 * ⟹ **確かめていないこと**: LLM 抽出後の実際の `content`（fact）に対しても同じタイ密度に
 * なるかは、この bench では測れない。抽出結果を録るには実 API 鍵が要る
 * （ADR 0148「引き受けた負債」1と同じ制約）。
 *
 * ## 陽性対照（AGENTS.md「『出なかった』を、事象が無いことの証明にしない」）
 *
 * 実コーパス（上記74件）は**ASCII の連なりが `TypeScript`/`Rust`/`Go` の3語しか無く、
 * どの2文書の間でも重複しない**（`buildHaystackUtterance` の語彙はすべて日本語）。
 * ⟹ 実コーパスの中には「タイが実際に起きる」を示す例が1つも無い。**「タイが0件」が
 * 「この道具はタイを検出できる」を意味しない**ことになってしまうため、別テナントに
 * 意図的に5行の重複コンテンツ（`CONTROL_PHRASE`）を仕込み、この道具が実際にタイを
 * 検出できることを先に確かめる（陽性対照）。
 *
 * ## 実行方法
 *
 * ```
 * DATABASE_URL=postgresql://... pnpm --filter @mnemora/example-chat run lexical-tie-density-bench
 * ```
 *
 * `DATABASE_URL`（本物の Postgres + pgvector）が要る。LLM/埋め込み API は一切呼ばない
 * （`observe()`/`tick()` を経由しないため、embedding provider を構築する必要すら無い）。
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

/** 母集団を切り詰めないための、実コーパスの行数(74)より十分大きい値。 */
const UNCAPPED_LIMIT = 10_000;

/** `recall-runtime.ts` の `kPrime` と同じ式（`packages/core` から import、書き写さない）。 */
const PRODUCTION_LIMIT = Math.max(1, Math.round(DEFAULT_RECALL_LIMIT * DEFAULT_OVER_FETCH_FACTOR));

/** 陽性対照: 意図的に重複させるコンテンツ。実コーパス（日本語オンリー）とは別テナント。 */
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
 * `utterances` を `memories.content` へ直接 INSERT する（LLM 抽出を経由しない。
 * ファイル冒頭の「corpus について」参照）。`recorded_at` は挿入順に古い→新しいへ
 * 単調増加させる（実会話の時系列を模す。`coverage`/`rank` には影響しない——
 * `buildLexicalSearchSelect` の `ORDER BY` の3段目でしか使われない列である）。
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

    // --- 実コーパス（ADR 0148 の retrieval ベンチが組む発話。LLM 抽出は経由しない） ---
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

    // --- 陽性対照（別テナント。実コーパスには重複 ASCII 語彙が無いため、道具の生死を
    //     ここで別途確かめる。AGENTS.md「先に陽性対照を示す」）---
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
