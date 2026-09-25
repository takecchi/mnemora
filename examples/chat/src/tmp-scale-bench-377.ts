/**
 * ⚠ 使い捨て測定スクリプト。テストスイート外・CI に載せない（AGENTS.md 「⛔ 対象外」節、
 * ADR 0111「測定スクリプトをコミットしていない」と同じ扱い）。
 *
 * Issue #377（連想枠のアンカー窓 anchorCount=3 が規模に追随しない）の修正
 * （RecallAssociationQuery.anchorPool、ADR 0306）の前後を、1万件規模の合成 haystack で測る。
 *
 * 実行方法:
 *   DATABASE_URL=postgresql://worker@127.0.0.1:55437/mnemora_test \
 *   MNEMORA_EMBEDDING=local \
 *   MNEMORA_SCALE_BENCH_HAYSTACK=10000 \
 *   pnpm --filter @mnemora/example-chat exec tsx src/tmp-scale-bench-377.ts
 */
import type { Ctx, RecallAssociationQuery } from "@mnemora/core";
import {
  ASSOCIATION_PROBES,
  associationAnchorExternalId,
  associationDistractorExternalId,
  associationGoldExternalId,
} from "./association-probe-set.js";
import { drainEmbedTicks } from "./embed-drain.js";
import { warmupLocalEmbedding } from "./local-embedding-warmup.js";
import { createExampleRuntime } from "./runtime-factory.js";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL が無い");
  }
  return url;
}

/**
 * `./association-probe-set.js` の `ASSOCIATION_HAYSTACK`（62文）を巡回複製するのではなく、
 * 構成上ゼロ重複の filler を作る——Issue #377 の実測が前提にしていた
 * 「near-duplicate を構成上ゼロにした1万件」に、できる範囲で寄せるため。
 *
 * 語彙はプローブの anchor/gold/distractor/query と重ならないよう、日本語の内容語を避けて
 * 英数字のログ風テンプレートにした（`findAssociationBridgeViolations` が検査している
 * 「ブリッジ語の漏れ」を、そもそも起こりようがない形にする——プローブ側のテキストを
 * 変更していないので、この filler が漏れを作る余地がない）。
 */
function buildDistinctFiller(count: number): { externalId: string; text: string }[] {
  const out: { externalId: string; text: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      externalId: `scale-377-filler-${i}`,
      text: `log entry ${i}: node-${i % 997} reported status code ${i % 53} at tick ${i * 7 + 3}, batch ${Math.floor(i / 31)}, checksum ${(i * 2654435761) >>> 0}`,
    });
  }
  return out;
}

interface ArmResult {
  label: string;
  goldReturned: number;
  hit1: number;
  mrr: number;
  avgRecallMs: number;
  perProbe: {
    probeId: string;
    goldRank: number | null;
    goldRetrievedVia: string | null;
    recallMs: number;
  }[];
}

async function main(): Promise<void> {
  const haystackSize = Number(process.env.MNEMORA_SCALE_BENCH_HAYSTACK ?? "10000");
  const databaseUrl = requireDatabaseUrl();
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });

  try {
    console.log("warmup...");
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(warmup.detail);
      process.exitCode = 1;
      return;
    }
    console.log(warmup.detail);

    const tenantId = "scale-377";
    const ctx: Ctx = { tenantId };

    console.log(`ingest: 12 probe × 3 (anchor/gold/distractor) + filler ${haystackSize}...`);
    const t0 = Date.now();
    for (const probe of ASSOCIATION_PROBES) {
      await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: probe.anchor,
        externalId: associationAnchorExternalId(probe.id),
      });
      await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: probe.gold,
        externalId: associationGoldExternalId(probe.id),
      });
      await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: probe.distractor,
        externalId: associationDistractorExternalId(probe.id),
      });
    }
    const filler = buildDistinctFiller(haystackSize);
    let ingested = 0;
    for (const f of filler) {
      await handle.runtime.observe(ctx, { kind: "utterance", text: f.text, externalId: f.externalId });
      ingested += 1;
      if (ingested % 1000 === 0) {
        console.log(`  ingested ${ingested}/${filler.length} filler utterances (raw observe, embed 未実行)`);
      }
    }
    console.log(`observe() done in ${((Date.now() - t0) / 1000).toFixed(1)}s. draining embed ticks...`);

    const t1 = Date.now();
    const drain = await drainEmbedTicks(handle.runtime, ctx);
    console.log(
      `drain done in ${((Date.now() - t1) / 1000).toFixed(1)}s: ticks=${drain.ticks} processed=${drain.totalProcessed} failed=${drain.totalFailed}`,
    );

    console.log("ANALYZE memory_embeddings_*...");
    await handle.pool.query("ANALYZE");

    const explainRow = await handle.pool.query(
      `select count(*)::int as n from pg_stat_user_tables where relname like 'memory_embeddings_%'`,
    );
    console.log("memory_embeddings tables:", explainRow.rows);

    const arms: { label: string; association: RecallAssociationQuery | undefined }[] = [
      { label: "off", association: undefined },
      {
        label: "on default (maxCount=10, anchorCount=3既定, pool=withinLimit既定)",
        association: { maxCount: 10 },
      },
      {
        label: "on 旧回避策 (maxCount=10, anchorCount=40, limit=40, pool=withinLimit既定)",
        association: { maxCount: 10, anchorCount: 40 },
      },
      {
        label: "on 新修正 (maxCount=10, anchorCount=40, pool='passed', limitは既定10のまま)",
        association: { maxCount: 10, anchorCount: 40, anchorPool: "passed" },
      },
    ];

    const results: ArmResult[] = [];
    for (const arm of arms) {
      console.log(`\n=== arm: ${arm.label} ===`);
      let assoc = arm.association;
      let limitOverride: number | undefined;
      if (arm.label.startsWith("on 旧回避策")) {
        limitOverride = 40;
      }
      const r = await runArmWithLimit(handle.runtime, ctx, arm.label, assoc, limitOverride);
      results.push(r);
      console.log(
        `  goldReturned=${r.goldReturned}/${ASSOCIATION_PROBES.length} hit1=${r.hit1} MRR=${r.mrr.toFixed(3)} avgRecallMs=${r.avgRecallMs.toFixed(2)}`,
      );
    }

    console.log("\n\n| arm | goldReturned | hit@1 | MRR | avgRecallMs |");
    console.log("|---|---|---|---|---|");
    for (const r of results) {
      console.log(
        `| ${r.label} | ${r.goldReturned}/${ASSOCIATION_PROBES.length} | ${r.hit1}/${ASSOCIATION_PROBES.length} | ${r.mrr.toFixed(3)} | ${r.avgRecallMs.toFixed(2)} |`,
      );
    }

    console.log("\nper-probe detail (最終armのみ表示せず、全arm出力):");
    for (const r of results) {
      console.log(`\n-- ${r.label} --`);
      for (const p of r.perProbe) {
        console.log(
          `  ${p.probeId}: goldRank=${p.goldRank} via=${p.goldRetrievedVia} ms=${p.recallMs.toFixed(2)}`,
        );
      }
    }
  } finally {
    await handle.close();
  }
}

async function runArmWithLimit(
  runtime: Awaited<ReturnType<typeof createExampleRuntime>>["runtime"],
  ctx: Ctx,
  label: string,
  association: RecallAssociationQuery | undefined,
  limit: number | undefined,
): Promise<ArmResult> {
  const perProbe: ArmResult["perProbe"] = [];
  let goldReturned = 0;
  let hit1 = 0;
  let reciprocalSum = 0;
  let totalMs = 0;

  for (const probe of ASSOCIATION_PROBES) {
    const t0 = performance.now();
    const result = await runtime.recall(ctx, {
      text: probe.query,
      ...(limit !== undefined ? { limit } : {}),
      ...(association ? { association } : {}),
    });
    const ms = performance.now() - t0;
    totalMs += ms;

    let goldRank: number | null = null;
    let goldRetrievedVia: string | null = null;
    for (let i = 0; i < result.memories.length; i += 1) {
      if (result.memories[i]!.digest === probe.gold) {
        goldRank = i + 1;
        goldRetrievedVia = result.memories[i]!.retrievedVia;
        break;
      }
    }
    if (goldRank !== null) {
      goldReturned += 1;
      reciprocalSum += 1 / goldRank;
      if (goldRank === 1) hit1 += 1;
    }
    perProbe.push({ probeId: probe.id, goldRank, goldRetrievedVia, recallMs: ms });
  }

  return {
    label,
    goldReturned,
    hit1,
    mrr: reciprocalSum / ASSOCIATION_PROBES.length,
    avgRecallMs: totalMs / ASSOCIATION_PROBES.length,
    perProbe,
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
