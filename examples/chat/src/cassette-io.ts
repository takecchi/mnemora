import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cassette } from "@mnemora/testkit";
import { assertCassette } from "@mnemora/testkit";

/**
 * カセット（記録した実 API の応答）の読み書き（ADR 0051）。
 *
 * **置き場所は `examples/chat/cassettes/` である。**`packages/testkit` には置かない——
 * 記録の中身は probe set（`probe-set.ts`）に強く結び付いており、probe set が住んでいる
 * パッケージと同じ場所に無いと、片方だけが変わったときに気づけない。
 * 再生する仕組み（provider）は再利用可能なので testkit、記録そのものはここ、という分担。
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * カセットは**サブコマンドごとに別ファイル**にする（ADR 0052）。
 *
 * `retrieval`・`compare`・`answer` は入力の集合が別物（probe set / 合成会話 / 手書きの
 * 回答ケース集合）であり、費用も桁が違う（例: retrieval 74回 対 compare 657回の LLM
 * 呼び出し）。1つのファイルにまとめると、どれかを録り直すたびに他も録り直すか、
 * `recordedAt` が中身と食い違うかのどちらかになる。
 */
export const RETRIEVAL_CASSETTE_PATH = join(here, "..", "cassettes", "retrieval.json");
export const COMPARE_CASSETTE_PATH = join(here, "..", "cassettes", "compare.json");
/**
 * `answer` の**旧形式**カセット（記録済み・67件、`buildMnemoraPrompt` の #698 書式で
 * 記録した実 API の応答）。
 *
 * ⛔ **ADR 0305（Issue #691 続き）以降、`record`/`verify`/CLI の `answer` 再生には
 * もう使わない**——`buildMnemoraPrompt` が `order-legend` 描画に変わり、この記録に
 * 入っているプロンプトの形（記録順タグ無し・凡例無し）とはもう一致しないため
 * （`RecordedLLMProvider` は形が合わない入力を「記録に無い」として例外にする）。
 * **1バイトも書き換えない**——`examples/chat/src/answer-trials-material.ts` が
 * ADR 0301 の対照の基準として直接パスを指定して読み続ける（同じ記憶集合で描画だけを
 * 差し替えて比べるため。`cassettePathFor`/`CASSETTE_PATH_BY_TARGET` 経由ではなく
 * 自前でパスを組み立てているので、下の `answer` ターゲットの向き先を変えても影響しない）。
 * `record:answer-retention-mutation`（`scripts/record-answer-retention-mutation.ts`）が
 * この形式のまま追記対象にしていたのもこのファイルである——**そちらも同じ理由で
 * 無効化した**（スクリプト側の docstring 参照）。
 */
export const ANSWER_CASSETTE_PATH = join(here, "..", "cassettes", "answer.json");
/**
 * `answer` の**新形式**カセット（ADR 0305、`order-legend` 描画）。`record`/`verify`/CLI
 * の `answer` 再生は、ここからこのファイルを読む——`CASSETTE_PATH_BY_TARGET` 参照。
 *
 * ⚠ **段1（本 commit）ではこのパスを宣言するだけで、ファイル自体はまだ存在しない。**
 * `record:answer`（実 API 必須）を実行して初めて作られる——`recordAnswer`（`cli.ts`）は
 * `ANSWER_CASE_SET_DEV`/`ANSWER_CASE_SET_EVAL` の全ケース＋ Issue #498 完了条件4の
 * 陽性対照（変異、`recordRetentionMutationPositiveControl`）を1回の実行でまとめて
 * 記録するので、この新形式カセット用に別スクリプトは要らない
 * （`record-answer-retention-mutation.ts` の docstring 参照）。
 */
export const ANSWER_ORDER_LEGEND_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer.order-legend.json",
);
/**
 * `answer-time-weighting` ベンチ（Issue #690 / PR #697、`timeWeighting` を回答の正誤で
 * 比較する器）専用の**旧形式**カセット（`buildMnemoraPrompt` の #698 書式で記録済み）。
 * **`answer.json` とは別ファイルにする**——ADR 0052 と同じ理由（入力の集合が別物・
 * 費用が別勘定）に加え、こちらはケースごとに `recall()` を `legacy`/`eventAwareFreshness`
 * の2方針で呼ぶため、同じ質問でも記録の鍵（プロンプトのハッシュ）が `answer` ベンチとは
 * 異なる——1つのファイルにまとめる技術的な理由も無い。
 *
 * ⛔ **ADR 0305 以降、`record`/`verify`/CLI の `answer-time-weighting` 再生にはもう
 * 使わない**——理由は {@link ANSWER_CASSETTE_PATH} と同じ（`buildMnemoraPrompt` の形が
 * 変わったため）。1バイトも書き換えない。
 */
export const ANSWER_TIME_WEIGHTING_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer-time-weighting.json",
);
/**
 * `answer-time-weighting` の**新形式**カセット（ADR 0305、`order-legend` 描画）。
 * `record`/`verify`/CLI の `answer-time-weighting` 再生は、ここからこのファイルを読む。
 *
 * ⚠ **段1（本 commit）ではこのパスを宣言するだけで、ファイル自体はまだ存在しない。**
 * `record:answer-time-weighting`（実 API 必須）を実行して初めて作られる。
 */
export const ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer-time-weighting.order-legend.json",
);

/** `record` / `verify` / 再生が対象にできるカセット。 */
export type CassetteTarget = "retrieval" | "compare" | "answer" | "answer-time-weighting";

export const CASSETTE_TARGETS: readonly CassetteTarget[] = [
  "retrieval",
  "compare",
  "answer",
  "answer-time-weighting",
];

/**
 * **ADR 0305（Issue #691 続き）**: `answer`/`answer-time-weighting` は、`buildMnemoraPrompt`
 * が `order-legend` 描画に変わったことを受けて、新形式カセット（`*.order-legend.json`）へ
 * 向け直した。旧形式（`ANSWER_CASSETTE_PATH`/`ANSWER_TIME_WEIGHTING_CASSETTE_PATH`）は
 * 1バイトも書き換えず、`answer-trials-material.ts`（ADR 0301 の対照の基準）だけが
 * 別経路（このマップを経由しない直接のパス指定）で読み続ける。
 */
const CASSETTE_PATH_BY_TARGET: Record<CassetteTarget, string> = {
  retrieval: RETRIEVAL_CASSETTE_PATH,
  compare: COMPARE_CASSETTE_PATH,
  answer: ANSWER_ORDER_LEGEND_CASSETTE_PATH,
  "answer-time-weighting": ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH,
};

export function cassettePathFor(target: CassetteTarget): string {
  return CASSETTE_PATH_BY_TARGET[target];
}

/**
 * 引数の文字列を対象として解釈する。**既定値を持たせない**——`record` を対象なしで
 * 叩いたときに、黙ってどれか1つを録り始めることをしない（費用が桁で違うため、
 * 取り違えは実害になる）。
 */
export function parseCassetteTarget(value: string | undefined): CassetteTarget {
  if (
    value === "retrieval" ||
    value === "compare" ||
    value === "answer" ||
    value === "answer-time-weighting"
  ) {
    return value;
  }
  throw new Error(
    `対象を明示すること: ${CASSETTE_TARGETS.join(" | ")}（実際: ${JSON.stringify(value ?? null)}）。` +
      "既定値は用意していない——retrieval・compare・answer では実 API の費用が桁で違う（ADR 0052）。",
  );
}

export function cassetteExists(path: string = RETRIEVAL_CASSETTE_PATH): boolean {
  return existsSync(path);
}

/**
 * カセットを読む。**形式検査に通らなければ落とす**——壊れた記録で測った数字を
 * 「本物で測った」と読める場所へ出さない。
 */
export function loadCassette(path: string = RETRIEVAL_CASSETTE_PATH): Cassette {
  if (!existsSync(path)) {
    throw new Error(
      `カセットが無い: ${path}\n` +
        "OPENAI_API_KEY を設定して `pnpm --filter @mnemora/example-chat run record` を" +
        "先に実行すること（ADR 0051）。",
    );
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  assertCassette(raw, path);
  return raw;
}

export function saveCassette(cassette: Cassette, path: string = RETRIEVAL_CASSETTE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  // 末尾の改行まで含めて prettier/git の扱いを普通のテキストファイルに揃える。
  writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`, "utf-8");
}

/** カセットの中身を1行で説明する（`record`/`retrieval` の画面表示用）。 */
export function describeCassette(cassette: Cassette): string {
  const { space } = cassette.embedding;
  return (
    `記録日時=${cassette.recordedAt} ` +
    `LLM=${cassette.llm.model}(${Object.keys(cassette.llm.entries).length}件) ` +
    `埋め込み=${space.model}/${space.dimensions}次元` +
    `(${Object.keys(cassette.embedding.entries).length}件)`
  );
}
