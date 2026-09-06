#!/usr/bin/env node
import { heuristicTokenCounter } from "@mnemora/core";
import { formatComparisonTable, formatRecallQualityTable, runComparison } from "./compare.js";
import { formatRecall } from "./format.js";
import { buildMnemoraPrompt, ingestConversation, queryRecall } from "./mnemora-path.js";
import { measureNaive, naivePrompt } from "./naive-path.js";
import type { ProviderMode } from "./providers.js";
import {
  formatArmDetail,
  formatArmSummaryTable,
  formatProbeComparisonTable,
  runRetrievalQualityArm,
} from "./retrieval-quality.js";
import { createExampleRuntime } from "./runtime-factory.js";
import { buildConversation } from "./scenario.js";
import { formatBackfillDemo, runBackfillDemo } from "./backfill.js";
import { formatScopeDemo, runScopeDemo } from "./scope.js";
import { formatNoApiCallsNotice } from "./usage-meter.js";

/** `chat` サブコマンドで使う会話の長さ(filler 往復数)。サンプルアプリの裁量値。 */
const DEFAULT_CHAT_FILLER_PAIRS = 8;
/** budget が実際に切り詰めることを見せるための、意図的に小さい文字数予算。 */
const TINY_BUDGET_CHARS = 60;
/** `compare` サブコマンドで測る会話の長さ(filler 往復数)の既定の列。 */
const DEFAULT_COMPARE_SEQUENCE = [0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320];

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。mnemora は Postgres + pgvector を要求する " +
        "（docs/roadmap.md 段階2）。examples/chat/README.md の手順でローカル DB を用意し、" +
        "DATABASE_URL を設定してから実行すること。",
    );
  }
  return url;
}

function describeMode(mode: ProviderMode): string {
  return mode === "openai" ? "本物の OpenAI" : "@mnemora/testkit の決定的な擬似 provider";
}

/**
 * どの組み合わせで動いているかを必ず画面に出す(黙って擬似物にフォールバックしない、
 * という原則の適用)。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` で LLM と embedding を別々に
 * 上書きできるようになったため、`mode` 1個ではなく `llmMode`/`embeddingMode` を
 * それぞれ表示する。
 */
function printProviderMode(llmMode: ProviderMode, embeddingMode: ProviderMode): void {
  console.log(`[provider] LLM       : ${describeMode(llmMode)}`);
  console.log(`[provider] Embedding : ${describeMode(embeddingMode)}`);
  if (embeddingMode === "deterministic") {
    console.log(
      "  ⚠ 擬似 embedding は意味的な類似度を表現しないため、このモードでは recall の" +
        "関連度そのものは評価できない（examples/chat/README.md「正直に書くべき限界」参照）。",
    );
  }
}

async function runChat(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    const ctx = { tenantId: `example-chat-${Date.now()}` };
    const conversation = buildConversation(DEFAULT_CHAT_FILLER_PAIRS);

    console.log("\n=== 会話（全ターン） ===");
    for (const turn of conversation.turns) {
      console.log(`${turn.role}: ${turn.text}`);
    }
    console.log(`user(質問): ${conversation.query}`);

    console.log("\n=== 経路A（naive）: 会話ログを全部プロンプトへ積む ===");
    console.log(naivePrompt(conversation));
    const naive = measureNaive(conversation, heuristicTokenCounter);
    console.log(
      `naive usage: chars=${naive.chars} estimatedTokens=${naive.estimatedTokens} (counter=${naive.counter})`,
    );

    console.log("\n=== 経路B（mnemora）: observe() → tick() ===");
    await ingestConversation(handle.runtime, ctx, conversation);
    console.log(
      `${conversation.userUtterances.length} 件の user 発話を observe() し、tick() で embed を処理した。`,
    );

    console.log("\n=== recall()（budget 無し） ===");
    const withoutBudget = await queryRecall(handle.runtime, ctx, conversation);
    console.log(formatRecall(withoutBudget, "budget 無し"));
    console.log("呼び出し側がプロンプトへ積む文字列（recall() の返り値だけから組み立てる例）:");
    console.log(buildMnemoraPrompt(withoutBudget));

    console.log(
      `\n=== budget を渡すと実際に切り詰められる（maxMemoryChars=${TINY_BUDGET_CHARS}） ===`,
    );
    const withBudget = await queryRecall(handle.runtime, ctx, conversation, {
      budget: { maxMemoryChars: TINY_BUDGET_CHARS },
    });
    console.log(formatRecall(withBudget, `budget maxMemoryChars=${TINY_BUDGET_CHARS}`));

    console.log("\n=== まとめ ===");
    console.log(`naive chars                  : ${naive.chars}`);
    console.log(`mnemora chars (budget 無し)      : ${withoutBudget.usage.chars}`);
    console.log(`mnemora chars (budget あり)      : ${withBudget.usage.chars}`);
    console.log(
      "budget_dropped omission (budget あり):",
      withBudget.omitted.find((o) => o.kind === "budget_dropped") ?? "(発生しなかった)",
    );

    console.log("");
    console.log(handle.usageMeter ? handle.usageMeter.formatReport() : formatNoApiCallsNotice());
  } finally {
    await handle.close();
  }
}

/**
 * `tenantId`/`subjectId` のスコープを「動く例」で見せるデモ(`src/scope.ts`)。
 * 北極星の主測定(`compare`/`retrieval`)には触れない、独立したデモ実行——
 * `runScopeDemo`/`formatScopeDemo` は `compare.ts`/`retrieval-quality.ts` を import しない。
 */
async function runScope(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    const tenantId = `example-chat-scope-${Date.now()}`;
    const otherTenantId = `${tenantId}-other`;
    console.log(
      "\n同じテナントの中に alice/bob という2つの subject を作り、別テナントも1つ用意して、" +
        "recall() のスコープの違いを実演する。\n",
    );
    const result = await runScopeDemo(handle.runtime, tenantId, otherTenantId);
    console.log(formatScopeDemo(result));
  } finally {
    await handle.close();
  }
}

/**
 * `observe()` の `occurredAt` を「動く例」で見せるデモ(`src/backfill.ts`、ADR 0037)。
 * 同じ2発話・同じ問い合わせを、`occurredAt` を渡す側と渡さない側の2テナントで走らせ、
 * **同じ問い合わせが取り込み方だけで別の答えを返す**ことを並べて見せる。
 * 北極星の主測定(`compare`/`retrieval`)には触れない、独立したデモ実行。
 */
async function runBackfill(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    const base = `example-chat-backfill-${Date.now()}`;
    console.log(
      "\n生の会話ログを後から取り込む(backfill)と、recordedAt は取り込んだ今日になる。" +
        "occurredAt を渡すかどうかで、同じ recall() が別の答えを返すことを実演する。\n",
    );
    const result = await runBackfillDemo(handle.runtime, {
      withOccurredAt: `${base}-with`,
      withoutOccurredAt: `${base}-without`,
    });
    console.log(formatBackfillDemo(result));
  } finally {
    await handle.close();
  }
}

async function runCompare(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle.llmMode, handle.embeddingMode);
  try {
    console.log(
      "\n会話の長さを変えて、経路A（naive）と経路B（mnemora, budget 無し）の焼かれる量を測る。\n",
    );
    const rows = await runComparison(handle.runtime, {
      fillerPairsSequence: DEFAULT_COMPARE_SEQUENCE,
    });
    console.log(formatComparisonTable(rows));
    console.log(
      "\n(注) mnemora chars は recall() の budget 無し usage.chars。切り詰めていない、そのままの量。",
    );

    console.log(
      "\n量を削っただけでは北極星の物差しに答えられない——" +
        "「削っても冒頭の事実が残っているか」「実際に何件と競って絞ったか」を測る:\n",
    );
    console.log(formatRecallQualityTable(rows));
    console.log(
      "\n(注) 「ANN の候補になれた件数」が「スコープ内の Memory」を下回っていたら、" +
        "そのぶんは `omitted` の `not_indexed` に理由付きで出ている" +
        "（docs/decisions/0021-drain-embed-ticks-in-ingest.md）。",
    );
    console.log("");
    console.log(handle.usageMeter ? handle.usageMeter.formatReport() : formatNoApiCallsNotice());
  } finally {
    await handle.close();
  }
}

/**
 * PR 本文 (D)。arm A(擬似LLM+擬似embedding)・B(擬似LLM+本物embedding)・
 * C(本物LLM+本物embedding)の3通りを順に走らせ、probe set の順位を比較する。
 *
 * **arm ごとに別のテナントを使う**(PR 本文「実行時の規律」)——`runRetrievalQualityArm`
 * 自体は tenantId を受け取るだけで固定しないため、ここで3つの固定 tenantId を渡す。
 *
 * B・C は本物の OpenAI(embedding、C はさらに LLM も)を叩く。**CI には載せていない**——
 * `.github/**` は変更していない。本物の API を叩く実行はこのコマンドを手動で叩いたときだけ。
 */
async function runRetrieval(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "retrieval は arm B・C で本物の OpenAI(embedding、C はさらに LLM も)を使う。" +
        "OPENAI_API_KEY を設定してから実行すること（本物の API を叩く実行は手動のみ——CI には載せていない）。",
    );
  }

  const armSpecs: {
    armLabel: string;
    tenantId: string;
    llmOverride: ProviderMode;
    embeddingOverride: ProviderMode;
  }[] = [
    {
      armLabel: "A: 擬似LLM+擬似埋め込み",
      tenantId: "retrieval-quality-arm-a",
      llmOverride: "deterministic",
      embeddingOverride: "deterministic",
    },
    {
      armLabel: "B: 擬似LLM+本物の埋め込み",
      tenantId: "retrieval-quality-arm-b",
      llmOverride: "deterministic",
      embeddingOverride: "openai",
    },
    {
      armLabel: "C: 本物LLM+本物の埋め込み",
      tenantId: "retrieval-quality-arm-c",
      llmOverride: "openai",
      embeddingOverride: "openai",
    },
  ];

  const reports = [];
  for (const arm of armSpecs) {
    console.log(`\n########## arm ${arm.armLabel} ##########`);
    const handle = await createExampleRuntime(databaseUrl, {
      ...process.env,
      MNEMORA_LLM: arm.llmOverride,
      MNEMORA_EMBEDDING: arm.embeddingOverride,
    });
    printProviderMode(handle.llmMode, handle.embeddingMode);
    try {
      const report = await runRetrievalQualityArm({
        armLabel: arm.armLabel,
        tenantId: arm.tenantId,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        ...(handle.usageMeter !== undefined ? { usageMeter: handle.usageMeter } : {}),
      });
      reports.push(report);
      console.log(formatArmDetail(report));
    } finally {
      await handle.close();
    }
  }

  console.log("\n\n=== probe ごとの比較(3 arm を並べる) ===");
  console.log(formatProbeComparisonTable(reports));
  console.log("\n=== arm ごとのまとめ ===");
  console.log(formatArmSummaryTable(reports));
}

function printHelp(): void {
  console.log(
    [
      "使い方:",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run chat       # observe/recall の往復・omitted/usage/budget を実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run compare    # 会話の長さを変えて経路A/経路Bの量を実測",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run scope      # tenantId/subjectId のスコープを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run backfill   # observe() の occurredAt が period の絞りに効くことを実演",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run retrieval",
      "                                                                      # 意味的関連性の probe set を3 arm(擬似/埋め込みのみ本物/フル本物)で比較",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "chat") {
    await runChat();
  } else if (command === "compare") {
    await runCompare();
  } else if (command === "scope") {
    await runScope();
  } else if (command === "backfill") {
    await runBackfill();
  } else if (command === "retrieval") {
    await runRetrieval();
  } else {
    printHelp();
    if (command !== undefined) {
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
