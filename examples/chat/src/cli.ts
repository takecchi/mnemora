#!/usr/bin/env node
import { heuristicTokenCounter } from "@mnemora/core";
import { CassetteRecorder } from "@mnemora/testkit";
import {
  RETRIEVAL_CASSETTE_PATH,
  cassetteExists,
  describeCassette,
  loadCassette,
  saveCassette,
} from "./cassette-io.js";
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
/**
 * arm の定義（ADR 0050 で `source` を足した）。
 *
 * `source` は「本物の API を叩くか、記録した応答を再生するか」だけを切り替える。
 * **arm の意味（どちらが擬似で、どちらが本物由来か）は変えていない**——arm B は
 * 「擬似LLM＋本物由来の埋め込み」のままである。記録は本物の応答そのものなので、
 * ラベルの意味は保たれる。
 */
function buildArmSpecs(source: "openai" | "recorded"): {
  armLabel: string;
  tenantId: string;
  llmOverride: ProviderMode;
  embeddingOverride: ProviderMode;
}[] {
  return [
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
      embeddingOverride: source,
    },
    {
      armLabel: "C: 本物LLM+本物の埋め込み",
      tenantId: "retrieval-quality-arm-c",
      llmOverride: source,
      embeddingOverride: source,
    },
  ];
}

async function runRetrieval(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();

  // **キーがあれば本物、無ければ記録の再生。どちらで走ったかは必ず画面に出す**
  // （黙って別のものへ倒れない、という既存の規律の適用。ADR 0050）。
  const useReal = Boolean(process.env.OPENAI_API_KEY);
  if (!useReal && !cassetteExists()) {
    throw new Error(
      "retrieval は arm B・C で本物の OpenAI(embedding、C はさらに LLM も)を使う。" +
        "OPENAI_API_KEY を設定するか、先に `record` サブコマンドでカセットを作ること（ADR 0050）。",
    );
  }
  const cassette = useReal ? undefined : loadCassette();
  if (cassette) {
    console.log(`[cassette] 記録した応答を再生する: ${describeCassette(cassette)}`);
    console.log(
      "  ⚠ これは記録した時点の API の姿である。実 API との乖離は `verify` で確かめること（ADR 0050）。",
    );
  }

  const armSpecs = buildArmSpecs(useReal ? "openai" : "recorded");

  const reports = [];
  for (const arm of armSpecs) {
    console.log(`\n########## arm ${arm.armLabel} ##########`);
    const handle = await createExampleRuntime(
      databaseUrl,
      {
        ...process.env,
        MNEMORA_LLM: arm.llmOverride,
        MNEMORA_EMBEDDING: arm.embeddingOverride,
      },
      cassette ? { cassette } : {},
    );
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

/**
 * 実 API の応答を記録してカセットに書き出す（ADR 0050）。
 *
 * **再生する当のもの（`retrieval` の arm B・C）をそのまま走らせて録る。**
 * probe set を読んで「必要そうな入力」を列挙する形は採らない——列挙が漏れると、
 * 再生時に「記録に無い」で落ちる。実行経路そのものが唯一の正しい入力一覧である。
 *
 * **arm B と C の両方を録る必要がある。**arm B は擬似 LLM が作った digest を、
 * arm C は本物の LLM が書き換えた digest を埋め込む——**埋め込みへの入力が arm 間で違う**。
 * arm A は API を一切叩かないため、記録の対象にならない。
 */
async function runRecord(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "record は本物の OpenAI を叩いて記録する。OPENAI_API_KEY を設定してから実行すること。",
    );
  }

  const recorder = new CassetteRecorder();
  // arm A（API を叩かない）は録らない。
  const armSpecs = buildArmSpecs("openai").filter((a) => a.tenantId !== "retrieval-quality-arm-a");

  // ⚠ **記録は必ず新しいテナントで走らせる。**`observe()` は `externalId` で
  // 重複排除するため、既に取り込み済みのテナントで走らせると抽出も埋め込みも呼ばれず、
  // 「1件も記録されていない」カセットができる（実際にこれで一度落ちた）。
  // 記録に必要なのはプロンプトと入力テキストの対応だけであり、それは probe set から
  // 決まってテナントに依らない——だから再生側の tenantId と揃える必要は無い。
  const recordRunId = Date.now();

  for (const arm of armSpecs) {
    console.log(`\n########## 記録中: arm ${arm.armLabel} ##########`);
    const handle = await createExampleRuntime(
      databaseUrl,
      { ...process.env, MNEMORA_LLM: arm.llmOverride, MNEMORA_EMBEDDING: arm.embeddingOverride },
      { recorder },
    );
    printProviderMode(handle.llmMode, handle.embeddingMode);
    try {
      await runRetrievalQualityArm({
        armLabel: arm.armLabel,
        tenantId: `${arm.tenantId}-record-${recordRunId}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        ...(handle.usageMeter !== undefined ? { usageMeter: handle.usageMeter } : {}),
      });
    } finally {
      await handle.close();
    }
  }

  const cassette = recorder.toCassette();
  saveCassette(cassette);
  console.log(`\n書き出した: ${RETRIEVAL_CASSETTE_PATH}`);
  console.log(`  ${describeCassette(cassette)}`);
  console.log(
    "  ⚠ これはこの時点の API の姿の記録である。モデルが更新されても記録は変わらない——" +
      "乖離は `verify` で確かめること（ADR 0050 の「引き受ける負債」）。",
  );
}

/** コサイン類似度。`verify` が記録と実 API のベクトルを比べるためだけに使う。 */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 記録が実 API から乖離していないかを測る（ADR 0050 の「覆る条件」を、測れる形にしたもの）。
 *
 * **埋め込みだけを照合する。**`gpt-4o-mini` の応答は同じ入力でも揺れるため、差が出ても
 * 「モデルが変わった」とは言えない——**照合できないものを照合したふりをしない**ので、
 * LLM 側は件数の確認だけに留める。
 *
 * ⚠ **埋め込みも、ビット単位では再現しない（本 PR の実測）。**同じ日・同じモデル
 * （`text-embedding-3-small` / 256次元）に同じ152件を投げ直したところ、
 * **20件が記録と完全一致しなかった**。最小コサイン類似度は **0.998647**。
 * 当初「埋め込みは決定的だから差が出たらモデルが変わった証拠」として `1e-6` を
 * 閾値に置いていたが、それは**この実測で否定された**——実 API 側に揺らぎがある。
 *
 * そこで閾値は `DRIFT_COSINE_THRESHOLD` に置き、**「完全一致したか」と「乖離したか」を
 * 別々に数える。**前者はほぼ常に一部が外れる（それが普通）。後者だけが記録し直す理由になる。
 */
/**
 * これを下回ったら「記録し直すべき乖離」とみなす境。
 *
 * **根拠**: 上記の実測で、同一モデルの揺らぎは最小 0.998647 に収まった（152件、1日、1回）。
 * モデルそのものが替われば、同じ文のベクトルはこれよりはるかに大きく動くと考えられる。
 * **ただし「モデルが替わったときにどこまで下がるか」は測っていない**——この 0.99 は
 * 揺らぎの実測の下に置いた線であって、モデル交代を実際に検出できると確かめた値ではない。
 */
const DRIFT_COSINE_THRESHOLD = 0.99;
async function runVerify(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("verify は実 API と記録を突き合わせる。OPENAI_API_KEY を設定すること。");
  }
  const cassette = loadCassette();
  console.log(`照合するカセット: ${describeCassette(cassette)}`);

  const { createProviders } = await import("./providers.js");
  const { embeddingProvider, usageMeter } = createProviders({
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "openai",
  });

  const entries = Object.values(cassette.embedding.entries);
  const texts = entries.map((e) => e.text);
  const fresh = await embeddingProvider.embed({ tenantId: "cassette-verify" }, texts);

  let worst = { similarity: 1, text: "" };
  let exact = 0;
  let drifted = 0;
  entries.forEach((entry, i) => {
    const similarity = cosine(entry.vector, fresh[i] ?? []);
    // 「完全一致したか」と「乖離したか」は別の問い。前者が欠けるのは普通のこと
    // （実 API 側の揺らぎ）であり、後者だけが記録し直す理由になる。
    if (similarity >= 1 - Number.EPSILON) {
      exact += 1;
    }
    if (similarity < DRIFT_COSINE_THRESHOLD) {
      drifted += 1;
    }
    if (similarity < worst.similarity) {
      worst = { similarity, text: entry.text };
    }
  });

  console.log(`\n埋め込み ${entries.length} 件を実 API と照合した。`);
  console.log(`  完全一致: ${exact} 件（一致しない分は実 API 側の揺らぎ。異常ではない）`);
  console.log(`  最小コサイン類似度: ${worst.similarity.toFixed(9)}`);
  console.log(`  最も離れた入力: ${JSON.stringify(worst.text)}`);
  console.log(`  閾値 ${DRIFT_COSINE_THRESHOLD} を割った件数: ${drifted}`);
  if (drifted > 0) {
    console.log("  🔴 記録が実 API から乖離している。記録し直すこと（ADR 0050）。");
    process.exitCode = 1;
  } else {
    console.log("  ✅ 揺らぎの範囲内。記録は実 API と整合している。");
  }
  console.log(
    `\nLLM（${cassette.llm.model}）の記録 ${Object.keys(cassette.llm.entries).length} 件は照合していない` +
      "——同じ入力でも応答が揺れるため、差が出ても「モデルが変わった」とは言えない。",
  );
  if (usageMeter) {
    console.log(usageMeter.formatReport());
  }
}

function printHelp(): void {
  console.log(
    [
      "使い方:",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run chat       # observe/recall の往復・omitted/usage/budget を実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run compare    # 会話の長さを変えて経路A/経路Bの量を実測",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run scope      # tenantId/subjectId のスコープを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run backfill   # observe() の occurredAt が period の絞りに効くことを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run retrieval # 意味的関連性の probe set を3 arm(擬似/埋め込みのみ本物/フル本物)で比較",
      "                                                                      #   OPENAI_API_KEY があれば実 API、無ければ記録の再生(ADR 0050)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record",
      "                                                                      # 実 API の応答を記録してカセットに書き出す(ADR 0050)",
      "  OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify   # 記録と実 API の乖離を測る(ADR 0050)",
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
  } else if (command === "record") {
    await runRecord();
  } else if (command === "verify") {
    await runVerify();
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
