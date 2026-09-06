import { heuristicTokenCounter } from "@mnemora/core";
import type { Ctx, Omission, Runtime } from "@mnemora/core";
import { buildConversation } from "./scenario.js";
import { measureNaive } from "./naive-path.js";
import { runMnemoraPath } from "./mnemora-path.js";

/**
 * 冒頭の事実表明（`FACT_STATEMENT` = 「私の好きな色は青です。誕生日は4月3日です。」）に
 * しか出現しない部分文字列。`scenario.ts` の `FILLER_USER_LINES`/`FILLER_ASSISTANT_LINES`
 * には「青」は出てこない（目視で確認済み。この前提が崩れると偽陽性になる）。
 */
const FACT_MARKER = "青";

/**
 * `recall().memories` の中に、冒頭の事実表明が残っているかを判定する。
 *
 * **⚠ この判定方法の限界（このシナリオと擬似 provider に固有であり、一般の判定ではない）**:
 * `@mnemora/testkit` の決定的な擬似 LLM は Observation を要約せず、digest が発話の
 * 本文そのものになる。そのため「digest に FACT_MARKER が含まれるか」で
 * 「元の Observation が FACT_STATEMENT だったか」を判定できる
 * （`src/__tests__/mnemora-path.postgres.test.ts` が使っている `digest.includes("青")`
 * と同じ判定法に倣った）。
 *
 * **本物の LLM（`OPENAI_API_KEY` 有り）を使うと、digest は要約・言い換えされるため、
 * この文字列一致はもう成立しない**——「青」という語を使わずに要約されれば偽陰性になるし、
 * 逆に無関係な記憶の要約が「青」という語を含めば偽陽性になる。つまりこの関数は
 * 「一般に記憶が保持されたかを判定する方法」ではなく、**`buildConversation` が作る
 * この決定的な会話 × 擬似 provider の組み合わせに限って成立する近似**である。
 * 本物の provider で同じことを言うには、`FACT_STATEMENT` から実際に生成された Memory の
 * `sourceObservationId` を辿る必要がある（`retrieval-quality.ts` の `resolveExternalId`
 * と同じ発想。ここでは compare.ts の既存の依存関係（MemoryStore を受け取らない）を
 * 変えないために、その経路までは実装していない）。
 */
function factStatementSurvived(memories: { digest: string }[]): boolean {
  return memories.some((m) => m.digest.includes(FACT_MARKER));
}

/** `omitted` のうち `not_indexed`（reason 問わず）の `count` を合算する。 */
function notIndexedCount(omitted: Omission[]): number {
  return omitted
    .filter((o): o is Extract<Omission, { kind: "not_indexed" }> => o.kind === "not_indexed")
    .reduce((sum, o) => sum + o.count, 0);
}

export interface ComparisonRow {
  fillerPairs: number;
  turnCount: number;
  naiveChars: number;
  naiveTokens: number;
  mnemoraChars: number;
  mnemoraTokens: number;
  mnemoraShareOfNaiveChars: number;
  /** そのテナントのスコープ内総数（`recall().index.totalInScope`）。テナント分離の検査に使う。 */
  totalInScope: number;
  /**
   * `recall().omitted` をそのまま持つ（要約しない）。
   *
   * 以前はここを `omittedKinds: string[]`（`kind` だけ）にしていたが、それでは
   * `reason`・`count`・`countKind` が消え、「スコープ内321件のうち271件が埋め込まれて
   * いない」のような、北極星の物差しに答えるために要る情報が失われる。ADR 0008 の芯は
   * 「推定値を実測値の顔で出さない」ことであり、`countKind`（`exact`/`lower_bound`/
   * `unknown`）を捨てるとその区別自体が消えるため、`Omission` を丸ごと保持する。
   */
  omitted: Omission[];
  /** 実際に返った件数（`recall().memories.length`）。 */
  returnedCount: number;
  /**
   * スコープ内（`totalInScope`）のうち、実際に ANN の候補になれた件数
   * （= totalInScope − `omitted` の `not_indexed`（reason 問わず）の合計）。
   *
   * これが「321件と競ったのか、50件と競ったのか」（PR 本文の核心の問い）に直接答える列。
   * ADR 0021 で `ingestConversation` が `tick()` を回し切るようになった後は、
   * この値が `totalInScope` と一致し（`not_indexed(pending)` が `omitted` に現れず）
   * なるはず——ただし本 PR ではそれを実測していない（README・報告参照）。
   *
   * ⚠ `not_indexed` の `countKind` が `exact` でない場合（Phase 1 の実装では常に
   * `exact`）でも、この引き算は常に count をそのまま差し引く。`countKind` は
   * `omitted` 列にそのまま残るので、不確かさの有無はそちらで確認できる。
   */
  annCandidateCount: number;
  /**
   * 冒頭の事実表明（`FACT_STATEMENT`）が `recall().memories` に残っているか。
   * 判定方法とその限界は `factStatementSurvived` のコメントを見ること——
   * **このシナリオと擬似 provider に固有の近似判定であり、一般的な判定ではない。**
   */
  factStatementSurvived: boolean;
}

export interface CompareOptions {
  /** 会話の長さ（filler 往復数）を変えた数点。北極星の物差しに答えるための核心。 */
  fillerPairsSequence: number[];
  /** テナントIDの接頭辞。テスト側から重複を避けるために差し替えられるようにしてある。 */
  tenantPrefix?: string;
}

/**
 * 会話の長さを変えて、経路A（naive）・経路B（mnemora）が実際に焼く量を測る
 * （PR 本文「量の比較」。docs/roadmap.md §4「計測と抑止を混同しない」を踏まえ、
 * ここでは budget を渡さない——「切り詰めずに、そのままだと何文字になるか」を見る）。
 *
 * `fillerPairsSequence` の要素ごとに新しい tenantId を使う。recall() のスコープは
 * テナント単位（docs/recall.md 段0）であり、同じテナントに会話を積み増していくと、
 * 後の計測が前の会話の記憶を引きずってしまい「その長さの会話単体で何文字になるか」
 * を独立に測れなくなる。
 */
export async function runComparison(
  runtime: Runtime,
  options: CompareOptions,
): Promise<ComparisonRow[]> {
  const tenantPrefix = options.tenantPrefix ?? "example-compare";
  const rows: ComparisonRow[] = [];
  for (const fillerPairs of options.fillerPairsSequence) {
    const ctx: Ctx = { tenantId: `${tenantPrefix}-${fillerPairs}` };
    const conversation = buildConversation(fillerPairs);
    const naive = measureNaive(conversation, heuristicTokenCounter);
    const { recall } = await runMnemoraPath(runtime, ctx, conversation);
    rows.push({
      fillerPairs,
      turnCount: conversation.turns.length,
      naiveChars: naive.chars,
      naiveTokens: naive.estimatedTokens,
      mnemoraChars: recall.usage.chars,
      mnemoraTokens: recall.usage.estimatedTokens,
      mnemoraShareOfNaiveChars: recall.usage.chars / naive.chars,
      totalInScope: recall.index.totalInScope,
      omitted: recall.omitted,
      returnedCount: recall.memories.length,
      annCandidateCount: recall.index.totalInScope - notIndexedCount(recall.omitted),
      factStatementSurvived: factStatementSurvived(recall.memories),
    });
  }
  return rows;
}

export function formatComparisonTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | naive chars | naive tokens(概算) | mnemora chars | mnemora tokens(概算) | mnemora/naive (chars) |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const ratio = `${(r.mnemoraShareOfNaiveChars * 100).toFixed(1)}%`;
    return `| ${r.turnCount} | ${r.naiveChars} | ${r.naiveTokens} | ${r.mnemoraChars} | ${r.mnemoraTokens} | ${ratio} |`;
  });
  return [header, sep, ...body].join("\n");
}

/** `omitted` を `kind(detail):count` の形にまとめた1行にする（件数を落とさない）。 */
function formatOmittedSummary(omitted: Omission[]): string {
  if (omitted.length === 0) {
    return "(無し)";
  }
  return omitted
    .map((o) => {
      switch (o.kind) {
        case "not_indexed":
          return `not_indexed(${o.reason}):${o.count}`;
        case "filtered":
          return `filtered(${o.condition}):${o.count}`;
        case "below_threshold":
          return `below_threshold:${o.count}`;
        case "over_limit":
          return `over_limit:${o.count}`;
        case "budget_dropped":
          return `budget_dropped:${o.count}`;
        case "stage_skipped":
          return `stage_skipped(${o.stage}/${o.reason})`;
        case "ann_truncated":
          return "ann_truncated";
        case "ann_unreached":
          return "ann_unreached";
        case "score_not_comparable":
          return `score_not_comparable:${o.count}`;
        default: {
          // 網羅性の歯: Omission に新しい kind が増えたらここが型エラーになる。
          const exhaustive: never = o;
          return String(exhaustive);
        }
      }
    })
    .join(", ");
}

/**
 * 北極星の物差し（「会話ログを全部プロンプトへ積むのをやめられたか」）に直接答える表。
 *
 * `formatComparisonTable`（量だけの表）と違い、こちらは「削っても目的の記憶が
 * 落ちていないか」——README「⭐ 削減率だけでは意味を持たない」節の表に対応する。
 * 「返った件数」だけでなく「実際に ANN の候補になれた件数」を並べることで、
 * 「スコープ内 totalInScope 件と競ったのか、それより少ない候補としか競っていないのか」
 * を1行で読めるようにしてある（ADR 0021 が直した欠陥の再発を、この表だけで検知できる
 * ——`annCandidateCount` が `totalInScope` を下回れば、`omitted` 列の
 * `not_indexed(pending):N` がその内訳を示す）。
 */
export function formatRecallQualityTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | スコープ内の Memory | ANN の候補になれた件数 | 返った件数 | 冒頭の事実が残っているか | `omitted` の内訳 |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const survived = r.factStatementSurvived ? "✅" : "❌";
    return `| ${r.turnCount} | ${r.totalInScope} | ${r.annCandidateCount} | ${r.returnedCount} | ${survived} | ${formatOmittedSummary(r.omitted)} |`;
  });
  return [header, sep, ...body].join("\n");
}
