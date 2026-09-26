import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "@mnemora/core";
import { DEFAULT_CONSOLIDATE_MIN_AFFINITY } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { tryGitRevParseHead } from "./git-info.js";
import { warmupLocalEmbedding } from "./local-embedding-warmup.js";
import { newRunToken } from "./retrieval-quality.js";
import type { ExampleRuntimeHandle } from "./runtime-factory.js";
import { createExampleRuntime } from "./runtime-factory.js";

/**
 * `subject-crossing-cost` ベンチ（`pnpm --filter @mnemora/example-chat run subject-crossing-cost`）。
 *
 * ## これは何を測るか
 *
 * [Issue #579](https://github.com/takecchi/mnemora/issues/579) の「残り」——
 * `runtime.consolidate` の対象が subject をまたぐと、統合後の `Memory.subjectId` が
 * `null` に畳まれる（`packages/core/src/strategies/consolidate.ts`
 * `buildConsolidatedMemory`）——について、**案B（subjectId を集合にする。migration 要）を
 * やるかどうかの判断材料**として、「subject をまたぐ統合がどれくらいの頻度で起きるか」を
 * 測る。ADR 0310 が、この測定を踏まえて案B着手の判断を記録する（このファイル自身は
 * 判断を持たない——測定だけ）。
 *
 * **測る経路は、呼び出し側が `{ memoryIds }` を自分で選ぶ形ではない。** 混在は呼び出し側の
 * 選び方次第になり頻度を問えないため。問えるのは mnemora 自身が近傍を集める
 * **`{ seedMemoryId }` 形**（`runtime.ts` の ADR 0152。`runtime.consolidate` 内で
 * `recall(ctx, { text: seed.digest })` を1回呼び、`computeAffinity(score) >= minAffinity`
 * （既定 {@link DEFAULT_CONSOLIDATE_MIN_AFFINITY} = 0.8）の近傍を候補に足す）と、
 * それを使う自動経路（`autoQueueConsolidateReflectOnExtract` → `processConsolidateJob`）
 * である。`runtime.consolidate(ctx, { target: { seedMemoryId }, dryRun: true })` を
 * 実際に呼び、`dryRun` が返す `sources`（`kind: "eligible"`）を数える——**別の類似度判定を
 * 自分で書かない**（本ファイルが検算目的で新しい「似ている」を発明すると、測っているものが
 * `consolidate()` の実装とずれる）。
 *
 * 実測で、`dryRun: true` の `eligible` 集合は、同じ target で `dryRun` 無しで呼んだときの
 * `superseded` 集合と完全に一致することを別途確認している（1件、手動の対照実行。この
 * ベンチのコードには残していない——`dryRun` の契約自体は `packages/core` 側の歯
 * （`consolidate.test.ts`）が持つべきものであり、ここで固定するものではない）。
 *
 * ## ⛔ これは判定ではない。CI には載せない
 *
 * `lexical-tie-density-bench.ts`/`embedding-fingerprint.ts` と同じ規律——**どの数字が
 * 出ても exit code は変えない**。混在率に「正しい値」は無く、実際の使われ方（主題あたりの
 * 記憶数・話題が主題間で被るか）に依存する。Issue #579 の「案Bをやるか」には**何も
 * 答えない**——それはこの測定結果を見た上でのオーナー/マネージャーの判断である。
 * ⟹ **CI の必須チェックには配線しない。** 実行結果は `examples/chat/bench-results/
 * subject-crossing-local.md`（`subject-crossing-summary.ts` が生成）に手動でコミットする、
 * 一回性の記録として扱う。
 *
 * ## 使う provider 層 —— LLM は一切呼ばない
 *
 * `consolidate(..., { dryRun: true })` は LLM を呼ばない（`packages/core/src/runtime.ts`
 * の `consolidate` 実装、dryRun はいちばん早い段で打ち切る）。`observe()`（抽出 LLM
 * 経由の取り込み）も使わない——`buildNewMemoryFixture`（`@mnemora/testkit`）で
 * `NewMemory` を直接組み、`MemoryStore.createMemoryWithOutbox(ctx, input, ["embed"])` +
 * `runtime.tick({ kinds: ["embed"] })` で埋め込みだけ処理する
 * （`time-weighting-bench.ts` の `seedTimeWeightingMemories` と同じ配線）。
 *
 * 埋め込みは既定で **`local`**（`@mnemora/local-embedding`、外部サービスに繋がない実 ONNX
 * 推論、`identifier-probes`/`consolidation-cost`/`archive-sweep-cost` と同じ層）。
 * `MNEMORA_EMBEDDING=deterministic` を渡すと対照群として `deterministic` 埋め込みでも
 * 走るが、**近さに意味を持たないため頻度の測定には使えない**（AGENTS.md「`deterministic`
 * で測った想起の質は性能について何も言っていない」）——対照としてだけ読むこと。
 * `MNEMORA_LLM` は明示していない限り `deterministic` を使う（LLM は呼ばれないので
 * どちらでも実害は無いが、鍵が無い環境でも既定で動くことを明示するため固定する。
 * `consolidation-cost` と同じ理由・同じ組み合わせ、ADR 0094）。
 *
 * ## ⚠ 踏んだ穴 —— `buildNewMemoryFixture` の既定 `recordedAt` は decay gate を通さない
 *
 * `buildNewMemoryFixture` の既定 `recordedAt` は固定日付（2026-01-01）である。既定
 * `halfLifeHours`（720h = 30日）と組むと、実行時点の壁時計からは既に decay floor を
 * 過ぎており、`recall()` の decay gate（ANN 候補生成の前段）が**候補を1件も返さない**
 * （`recall().explain.stages.candidate_generation.hits: 0`——埋め込みは `ready` で正常に
 * 存在するのに、である）。**このベンチでは常に `recordedAt`/`occurredAt` に「いま」を
 * 明示して回避している**（`seedCorpus` 参照）。`time-weighting-bench.ts` は元々明示の
 * `recordedAt` を渡す設計なので踏んでいないが、`buildNewMemoryFixture` を素のまま
 * 直接書きに使う今後のベンチは同じ穴を踏む可能性がある——fixture 自身は変更していない
 * （このファイルの対処だけ）。
 *
 * ## 実行方法
 *
 * ```bash
 * DATABASE_URL=postgresql://... pnpm --filter @mnemora/example-chat run subject-crossing-cost
 * ```
 *
 * 環境変数（すべて省略可能。既定は Issue #579 の測定で使った値と同じ）:
 * - `MEASURE_S`: subject 数のリスト（既定 `"2,5,10"`）
 * - `MEASURE_N`: subject あたり記憶数のリスト（既定 `"1,2,5,10,20,50,100"`）
 * - `MEASURE_MINAFFINITY`: `minAffinity` のリスト（既定 `String(DEFAULT_CONSOLIDATE_MIN_AFFINITY)`、
 *   すなわち `"0.8"`）
 * - `MEASURE_SEED_CAP`: 1コーパスあたりの種の上限（既定 `150`。`S・N` がこれを超える
 *   コーパスは決定的サンプリングで間引く——`mulberry32` の擬似乱数を `S`/`N`/`pole` から
 *   固定 seed するので、再実行しても同じ標本になる）
 * - `MEASURE_OUT_DIR`: raw JSON の書き出し先（既定 `./bench-results`）
 * - `MNEMORA_EMBEDDING`: `"local"`（既定）| `"deterministic"`（対照群、上記の警告参照）
 *
 * 生データ（raw JSON）はサイズが大きく（S・N の全域では数MB〜十数MB）、
 * commit しない。集計表（`subject-crossing-summary.ts` が生成する Markdown）だけを
 * `examples/chat/bench-results/subject-crossing-local.md` に commit する。
 */

// ---------------------------------------------------------------------------
// 話題ドメイン(コーパス生成)
// ---------------------------------------------------------------------------

interface Domain {
  name: string;
  templates: string[]; // "{F}" を filler で置換
  fillers: string[];
}

const DOMAINS: Domain[] = [
  {
    name: "cooking",
    templates: [
      "今週は{F}を作った。",
      "最近{F}にハマっている。",
      "{F}のレシピを教わった。",
      "{F}を食べすぎて反省した。",
    ],
    fillers: [
      "カレー",
      "餃子",
      "麻婆豆腐",
      "肉じゃが",
      "パスタ",
      "グラタン",
      "炊き込みご飯",
      "味噌汁",
      "唐揚げ",
      "オムライス",
      "チャーハン",
      "煮込みハンバーグ",
      "ロールキャベツ",
      "茶碗蒸し",
      "筑前煮",
      "ビーフシチュー",
      "春巻き",
      "天ぷら",
      "お好み焼き",
      "親子丼",
      "ポトフ",
      "きんぴらごぼう",
      "焼きそば",
      "ミネストローネ",
      "豚の角煮",
    ],
  },
  {
    name: "work",
    templates: [
      "{F}の締め切りが近くて焦っている。",
      "{F}の会議が長引いた。",
      "上司に{F}の件で相談した。",
      "{F}のプロジェクトが一段落した。",
    ],
    fillers: [
      "資料作成",
      "予算案",
      "新規案件",
      "システム移行",
      "採用面接",
      "四半期報告",
      "顧客対応",
      "契約更新",
      "研修",
      "監査対応",
      "新製品発表",
      "人事評価",
      "稟議書",
      "部署異動",
      "業務委託",
      "出張報告",
      "取引先訪問",
      "在庫管理",
      "品質会議",
      "営業目標",
      "決算資料",
      "社内研修の講師",
      "障害対応",
      "見積書",
      "引き継ぎ",
    ],
  },
  {
    name: "travel",
    templates: [
      "{F}へ旅行に行った。",
      "{F}の観光地が良かった。",
      "次は{F}に行きたいと話した。",
      "{F}で道に迷った。",
    ],
    fillers: [
      "京都",
      "沖縄",
      "北海道",
      "台湾",
      "パリ",
      "ローマ",
      "バンコク",
      "金沢",
      "軽井沢",
      "屋久島",
      "ソウル",
      "シンガポール",
      "函館",
      "長崎",
      "別府",
      "ハワイ",
      "バルセロナ",
      "ウィーン",
      "ハノイ",
      "松本",
      "白川郷",
      "宮古島",
      "台北の夜市",
      "プラハ",
      "小樽",
    ],
  },
  {
    name: "health",
    templates: [
      "最近{F}を始めた。",
      "{F}で軽く汗をかいた。",
      "{F}のせいで筋肉痛になった。",
      "健康診断で{F}を指摘された。",
    ],
    fillers: [
      "ジョギング",
      "ヨガ",
      "水泳",
      "筋トレ",
      "ウォーキング",
      "自転車通勤",
      "ストレッチ",
      "階段の上り下り",
      "睡眠不足",
      "血圧",
      "体重増加",
      "食生活の乱れ",
      "ピラティス",
      "エアロビクス",
      "縄跳び",
      "ダンベル体操",
      "ラジオ体操",
      "腹筋運動",
      "ボルダリング",
      "登山",
      "悪玉コレステロール",
      "血糖値",
      "肩こり",
      "腰痛",
      "ホットヨガ",
    ],
  },
  {
    name: "family",
    templates: [
      "{F}が最近元気そうだった。",
      "{F}と週末に出かけた。",
      "{F}の誕生日を祝った。",
      "{F}から連絡があった。",
    ],
    fillers: [
      "母",
      "父",
      "妹",
      "弟",
      "祖母",
      "祖父",
      "いとこ",
      "おじ",
      "おば",
      "息子",
      "娘",
      "配偶者",
      "叔父",
      "叔母",
      "甥",
      "姪",
      "義母",
      "義父",
      "孫",
      "兄",
      "姉",
      "従姉妹",
      "曾祖母",
      "義理の兄",
      "はとこ",
    ],
  },
  {
    name: "music",
    templates: [
      "{F}のライブに行った。",
      "{F}を最近よく聴いている。",
      "{F}の新曲が出た。",
      "{F}のアルバムを買った。",
    ],
    fillers: [
      "ジャズ",
      "邦ロック",
      "クラシック",
      "ヒップホップ",
      "アイドルグループ",
      "シンガーソングライター",
      "アニメソング",
      "オーケストラ",
      "弾き語り",
      "アコースティック",
      "レゲエ",
      "K-POP",
      "ブルース",
      "パンク",
      "演歌",
      "ボサノバ",
      "メタル",
      "電子音楽",
      "吹奏楽",
      "合唱団",
      "フォーク",
      "ゴスペル",
      "ファンク",
      "ビジュアル系バンド",
      "ピアノ協奏曲",
    ],
  },
  {
    name: "reading",
    templates: [
      "{F}という本を読んだ。",
      "{F}のジャンルにはまっている。",
      "図書館で{F}を借りた。",
      "{F}の続きが気になっている。",
    ],
    fillers: [
      "推理小説",
      "歴史小説",
      "エッセイ",
      "自己啓発書",
      "漫画",
      "SF",
      "ノンフィクション",
      "詩集",
      "図鑑",
      "ビジネス書",
      "紀行文",
      "短編集",
      "ライトノベル",
      "時代小説",
      "ホラー小説",
      "恋愛小説",
      "哲学書",
      "絵本",
      "評論集",
      "翻訳文学",
      "児童文学",
      "俳句集",
      "伝記",
      "ファンタジー小説",
      "古典文学",
    ],
  },
  {
    name: "pets",
    templates: [
      "{F}を飼い始めた。",
      "{F}が最近よく寝ている。",
      "{F}を病院に連れて行った。",
      "{F}にごはんをあげ忘れた。",
    ],
    fillers: [
      "猫",
      "柴犬",
      "ハムスター",
      "インコ",
      "金魚",
      "うさぎ",
      "カメ",
      "熱帯魚",
      "フェレット",
      "文鳥",
      "モルモット",
      "トカゲ",
      "チワワ",
      "トイプードル",
      "ミニチュアダックス",
      "メダカ",
      "ザリガニ",
      "オカメインコ",
      "ヤモリ",
      "ハリネズミ",
      "チンチラ",
      "リクガメ",
      "ベタ",
      "セキセイインコ",
      "シマリス",
    ],
  },
  {
    name: "crafts",
    templates: [
      "{F}を作ってみた。",
      "{F}の材料を買いに行った。",
      "{F}が思ったより難しかった。",
      "{F}を人にあげた。",
    ],
    fillers: [
      "編み物",
      "陶芸",
      "木工",
      "刺繍",
      "アクセサリー作り",
      "キャンドル",
      "革細工",
      "ガーデニング",
      "プラモデル",
      "写真の現像",
      "パン作り",
      "ドライフラワー",
      "レジン細工",
      "折り紙",
      "切り絵",
      "パッチワーク",
      "ビーズ手芸",
      "羊毛フェルト",
      "水引細工",
      "籐かご編み",
      "ステンドグラス",
      "彫金",
      "藍染め",
      "紙すき",
      "モザイクタイル",
    ],
  },
  {
    name: "money",
    templates: [
      "{F}のために節約を始めた。",
      "{F}を衝動買いしてしまった。",
      "{F}の値上がりに驚いた。",
      "{F}をフリマで売った。",
    ],
    fillers: [
      "旅行資金",
      "家電",
      "洋服",
      "本",
      "ガソリン代",
      "電気代",
      "サブスク",
      "保険の見直し",
      "投資信託",
      "家具",
      "自転車",
      "靴",
      "家賃",
      "携帯料金",
      "ポイント還元",
      "株主優待",
      "積立預金",
      "ふるさと納税",
      "医療費控除",
      "クレジットカードの年会費",
      "固定資産税",
      "住宅ローン",
      "ボーナス",
      "個人年金",
      "外貨預金",
    ],
  },
];

const PARTICLES = ["", "ちなみに、", "そういえば、", "実は、", "この前、", "先週、"];

function domainUtterance(domainIdx: number, seq: number, subjectIdx: number): string {
  const d = DOMAINS[domainIdx % DOMAINS.length]!;
  const t = d.templates[seq % d.templates.length]!;
  const f = d.fillers[Math.floor(seq / d.templates.length) % d.fillers.length]!;
  const particle = PARTICLES[subjectIdx % PARTICLES.length]!;
  return `${particle}${t.replace("{F}", f)}`;
}

export type CorpusPole = "disjoint" | "shared";

export interface CorpusSpec {
  s: number; // subject 数
  n: number; // subject あたり記憶数
  pole: CorpusPole;
}

/**
 * コーパスの2極（マネージャー指示）:
 * - "disjoint": 主題ごとに話題ドメインが排他的（重ならない）。実運用の下限側の近似。
 * - "shared": 話題ドメインの並びを全 subject で共有する（同じ話題を複数の相手と話す）。
 *   実運用の上限側の近似。
 * 実運用はこの間にあるはずだが、それがどちらに近いかは測っていない
 * （オーナーが「主題あたりの記憶数 N は不明」と答えた不明点と同じ種類の不明点）。
 */
export function buildUtterances(spec: CorpusSpec): { subjectId: string; text: string }[] {
  const out: { subjectId: string; text: string }[] = [];
  for (let k = 0; k < spec.s; k++) {
    const subjectId = `subject-${k}`;
    for (let i = 0; i < spec.n; i++) {
      const domainIdx = spec.pole === "disjoint" ? k % DOMAINS.length : i % DOMAINS.length;
      const seq = spec.pole === "disjoint" ? i : Math.floor(i / DOMAINS.length);
      out.push({ subjectId, text: domainUtterance(domainIdx, seq, k) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 記憶を直接書く(抽出 LLM を通さない、`time-weighting-bench.ts` と同じ配線)
// ---------------------------------------------------------------------------

async function seedCorpus(
  handle: ExampleRuntimeHandle,
  ctx: Ctx,
  utterances: { subjectId: string; text: string }[],
): Promise<{ id: string; subjectId: string }[]> {
  const ids: { id: string; subjectId: string }[] = [];
  // ⚠ 上の docstring「踏んだ穴」参照——`buildNewMemoryFixture` の既定 `recordedAt`
  // (2026-01-01)は既定 `halfLifeHours` と組むと decay gate に落ちるため、常に「いま」を
  // 明示する。
  const now = new Date();
  let i = 0;
  for (const u of utterances) {
    const newMemory = buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      subjectId: u.subjectId,
      content: u.text,
      contentHash: `${ctx.tenantId}:${u.subjectId}:${i}:${u.text}`,
      digest: u.text,
      recordedAt: now,
      occurredAt: now,
    });
    const { memory } = await handle.memoryStore.createMemoryWithOutbox(ctx, newMemory, ["embed"]);
    ids.push({ id: memory.id, subjectId: u.subjectId });
    i += 1;
  }
  for (;;) {
    const result = await handle.runtime.tick(ctx, {
      kinds: ["embed"],
      leaseMs: 30 * 60 * 1000,
      limit: 500,
    });
    if (result.processed === 0) break;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 測定本体
// ---------------------------------------------------------------------------

export type CtxSubjectVariant = "none" | "own" | "mismatched";

export interface TrialResult {
  s: number;
  n: number;
  pole: CorpusPole;
  minAffinity: number;
  ctxVariant: CtxSubjectVariant;
  seedId: string;
  seedSubjectId: string;
  eligibleCount: number; // eligible 全体(種含む)
  eligibleSubjectCount: number; // eligible の distinct subjectId 数
  mixed: boolean; // eligibleCount >= 2 && eligibleSubjectCount >= 2
}

/**
 * ctx.subjectId の3変種。
 * - "none": ctx に subjectId を付けない(テナント全体から近傍を探す——`tick()` を
 *   subject 指定せず呼ぶ、実運用でありそうな形)。
 * - "own": ctx.subjectId = seed 自身の subjectId(呼び出し側が正しく絞った想定)。
 * - "mismatched": ctx.subjectId = seed とは別の subjectId。Issue #579 のコメントが
 *   指摘する「`ClaimOutboxJobsOptions` に `subjectId` が無いため、`tick()` の claim が
 *   種を主題で絞れない——ctx.subjectId を付けても、種が別主題のジョブを引ける」場面の近似。
 */
export function pickCtx(
  tenantId: string,
  variant: CtxSubjectVariant,
  seedSubjectId: string,
  allSubjectIds: string[],
): Ctx {
  if (variant === "none") return { tenantId };
  if (variant === "own") return { tenantId, subjectId: seedSubjectId };
  const idx = allSubjectIds.indexOf(seedSubjectId);
  const other = allSubjectIds[(idx + 1) % allSubjectIds.length]!;
  return { tenantId, subjectId: other };
}

/** 決定的な疑似乱数(mulberry32)——実行ごとに同じサンプルを選ぶ。 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleSeeds<T>(items: T[], cap: number, rng: () => number): T[] {
  if (items.length <= cap) return items;
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, cap);
}

async function runTrialsForCorpus(
  handle: ExampleRuntimeHandle,
  spec: CorpusSpec,
  minAffinities: number[],
  seedCap: number,
): Promise<TrialResult[]> {
  const tenantId = `subject-crossing-${spec.pole}-s${spec.s}-n${spec.n}-${newRunToken()}`;
  const ctxBuild: Ctx = { tenantId };
  const utterances = buildUtterances(spec);
  const memories = await seedCorpus(handle, ctxBuild, utterances);
  const allSubjectIds = Array.from(new Set(memories.map((m) => m.subjectId)));

  const rng = mulberry32(spec.s * 100003 + spec.n * 17 + (spec.pole === "disjoint" ? 1 : 2));
  const seeds = sampleSeeds(memories, seedCap, rng);

  const results: TrialResult[] = [];
  const variants: CtxSubjectVariant[] = ["none", "own", "mismatched"];

  for (const seed of seeds) {
    for (const variant of variants) {
      const ctx = pickCtx(tenantId, variant, seed.subjectId, allSubjectIds);
      for (const minAffinity of minAffinities) {
        const result = await handle.runtime.consolidate(ctx, {
          target: { seedMemoryId: seed.id, minAffinity },
          dryRun: true,
        });
        const eligibleIds = result.sources
          .filter((s): s is { memoryId: string; kind: "eligible" } => s.kind === "eligible")
          .map((s) => s.memoryId);
        let eligibleSubjectCount = 0;
        const eligibleCount = eligibleIds.length;
        if (eligibleIds.length > 0) {
          const eligibleMemories = await handle.memoryStore.getMany(ctxBuild, eligibleIds);
          const subjSet = new Set(eligibleMemories.map((m) => m.subjectId ?? "null"));
          eligibleSubjectCount = subjSet.size;
        }
        results.push({
          s: spec.s,
          n: spec.n,
          pole: spec.pole,
          minAffinity,
          ctxVariant: variant,
          seedId: seed.id,
          seedSubjectId: seed.subjectId,
          eligibleCount,
          eligibleSubjectCount,
          mixed: eligibleCount >= 2 && eligibleSubjectCount >= 2,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

function parseNumberList(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined) return fallback;
  return value.split(",").map(Number);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL が設定されていません。subject-crossing-cost は本物の Postgres + " +
        "pgvector を要求する（examples/chat/README.md の手順でローカル DB を用意すること）。",
    );
  }

  const sValues = parseNumberList(process.env.MEASURE_S, [2, 5, 10]);
  const nValues = parseNumberList(process.env.MEASURE_N, [1, 2, 5, 10, 20, 50, 100]);
  const minAffinities = parseNumberList(process.env.MEASURE_MINAFFINITY, [
    DEFAULT_CONSOLIDATE_MIN_AFFINITY,
  ]);
  const seedCap = process.env.MEASURE_SEED_CAP ? Number(process.env.MEASURE_SEED_CAP) : 150;
  const srcDir = fileURLToPath(new URL(".", import.meta.url));
  const outDir = process.env.MEASURE_OUT_DIR ?? path.join(srcDir, "..", "bench-results");
  const poles: CorpusPole[] = ["disjoint", "shared"];

  mkdirSync(outDir, { recursive: true });

  // `consolidation-cost` と同じ組み合わせ・同じ理由(ADR 0094): 主測定は dryRun のため
  // LLM を一度も呼ばない——`MNEMORA_LLM` は明示していない限り `deterministic` に固定する。
  // `MNEMORA_EMBEDDING` は既定 `local`(このベンチの主目的)。上の docstring の警告どおり、
  // `deterministic` へ上書きしたら対照群としてだけ読むこと。
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: process.env.MNEMORA_LLM ?? "deterministic",
    MNEMORA_EMBEDDING: process.env.MNEMORA_EMBEDDING ?? "local",
  });

  console.log(`[subject-crossing-cost] LLM       : ${handle.llmMode}`);
  console.log(`[subject-crossing-cost] Embedding : ${handle.embeddingMode}`);
  if (handle.embeddingMode === "deterministic") {
    console.log(
      "  ⚠ 擬似 embedding は意味的な類似度を表現しないため、このモードでの混在率は" +
        "対照群としてだけ読むこと(頻度の実測ではない)。",
    );
  }

  try {
    console.log("[subject-crossing-cost] warmup() でモデルの読み込みを先に済ませる…");
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`\n🔴 ${warmup.detail}`);
      console.error("  測定は1件も行っていない(前回の値・既定値へは倒さない)。");
      process.exitCode = 1;
      return;
    }
    console.log(`  ${warmup.detail}`);

    console.log(
      `[subject-crossing-cost] S=${sValues.join(",")} N=${nValues.join(",")} ` +
        `poles=${poles.join(",")} minAffinities=${minAffinities.join(",")} seedCap=${seedCap}`,
    );

    const allResults: TrialResult[] = [];
    let combo = 0;
    const totalCombos = sValues.length * nValues.length * poles.length;
    const commit = tryGitRevParseHead(process.cwd());
    const measuredAt = new Date().toISOString();

    for (const pole of poles) {
      for (const s of sValues) {
        for (const n of nValues) {
          combo += 1;
          const t0 = Date.now();
          const results = await runTrialsForCorpus(handle, { s, n, pole }, minAffinities, seedCap);
          allResults.push(...results);
          const ms = Date.now() - t0;
          console.log(
            `[subject-crossing-cost] (${combo}/${totalCombos}) pole=${pole} S=${s} N=${n} ` +
              `memories=${s * n} trials=${results.length} took=${ms}ms`,
          );
          // 区切りごとに書き出す(長時間実行が中断しても、そこまでの結果を失わない)。
          const outPath = path.join(outDir, `subject-crossing-${handle.embeddingMode}.json`);
          writeFileSync(
            outPath,
            JSON.stringify({ commit, measuredAt, results: allResults }, null, 2),
          );
        }
      }
    }

    console.log(`[subject-crossing-cost] done. total trials=${allResults.length}`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
