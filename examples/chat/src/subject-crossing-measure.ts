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
 * `runtime.consolidate(ctx, { target: { seedMemoryId }, dryRun: true })` を実際に呼んで `eligible` を数える。別の類似度判定を自分で書かない（測っているものが `consolidate()` の実装とずれる）。
 * 判定ではない: どの数字が出ても exit code は変えず、CI の必須チェックには配線しない。生の JSON は大きいので commit しない。
 * `MNEMORA_EMBEDDING=deterministic` は近さに意味が無く頻度の測定には使えないので、対照としてだけ読む。
 */

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

async function seedCorpus(
  handle: ExampleRuntimeHandle,
  ctx: Ctx,
  utterances: { subjectId: string; text: string }[],
): Promise<{ id: string; subjectId: string }[]> {
  const ids: { id: string; subjectId: string }[] = [];
  // 既定の `recordedAt`（固定日付）は decay gate に落ちるので、常に「いま」を明示する。
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
