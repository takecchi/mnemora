import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cassette } from "@mnemora/testkit";
import { assertCassette } from "@mnemora/testkit";

/**
 * カセット（記録した実 API の応答）の読み書き。
 *
 * 置き場所は `examples/chat/cassettes/`。`packages/testkit` には置かない。記録の中身は probe set に強く結び付いており、
 * 同じ場所に無いと片方だけが変わったときに気づけないため。再生する仕組み（provider）だけが testkit にある。
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * カセットはサブコマンドごとに別ファイルにする。入力の集合も費用の桁も別物なので、1ファイルにまとめると、
 * どれかを録り直すたびに他も録り直すか、`recordedAt` が中身と食い違うかのどちらかになる。
 */
export const RETRIEVAL_CASSETTE_PATH = join(here, "..", "cassettes", "retrieval.json");
export const COMPARE_CASSETTE_PATH = join(here, "..", "cassettes", "compare.json");
/**
 * `answer` の旧形式カセット。`record`/`verify`/CLI の `answer` 再生にはもう使わない。
 * `buildMnemoraPrompt` が `order-legend` 描画に変わり、記録されたプロンプトの形と一致しなくなったため。
 *
 * 1バイトも書き換えない。`answer-trials-material.ts` が対照の基準として、このマップを経由せず
 * 直接パスを指定して読み続ける。
 */
export const ANSWER_CASSETTE_PATH = join(here, "..", "cassettes", "answer.json");
/**
 * `answer` の新形式カセット（`order-legend` 描画）。`record`/`verify`/CLI の `answer` 再生はこれを読む。
 * パスを宣言するだけで、ファイルは `record:answer`（実 API 必須）を実行して初めて作られる。
 */
export const ANSWER_ORDER_LEGEND_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer.order-legend.json",
);
/**
 * `answer-time-weighting` ベンチ専用の旧形式カセット。`answer.json` とは別ファイルにする。
 * 同じ質問でも `recall()` の方針が違い、記録の鍵（プロンプトのハッシュ）が `answer` ベンチと異なるため。
 *
 * `record`/`verify`/CLI の再生にはもう使わない（理由は {@link ANSWER_CASSETTE_PATH} と同じ）。1バイトも書き換えない。
 */
export const ANSWER_TIME_WEIGHTING_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer-time-weighting.json",
);
/**
 * `answer-time-weighting` の新形式カセット（`order-legend` 描画）。
 * パスを宣言するだけで、ファイルは `record:answer-time-weighting`（実 API 必須）を実行して初めて作られる。
 */
export const ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer-time-weighting.order-legend.json",
);

/**
 * `answer`（`MNEMORA_ANSWER_CLAIM_KEY=detect` opt-in）専用カセット。
 *
 * `CassetteTarget`/`CASSETTE_PATH_BY_TARGET` には加えない。`record`/`verify` の対象一覧に混ぜると、
 * 現役の対照の基準（`answer.order-legend.json`）が向く先と紛れる。専用スクリプト
 * `src/scripts/record-answer-claim-key.ts` が、このパスへ直接書く。
 */
export const ANSWER_CLAIM_KEY_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer.claim-key.json",
);

export type CassetteTarget = "retrieval" | "compare" | "answer" | "answer-time-weighting";

export const CASSETTE_TARGETS: readonly CassetteTarget[] = [
  "retrieval",
  "compare",
  "answer",
  "answer-time-weighting",
];

/**
 * `answer`/`answer-time-weighting` は新形式カセット（`*.order-legend.json`）へ向ける。
 * 旧形式は書き換えず、`answer-trials-material.ts` だけがこのマップを経由せず直接読み続ける。
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
 * 引数の文字列を対象として解釈する。既定値を持たせない。`record` を対象なしで叩いたときに、
 * 黙ってどれか1つを録り始めないため（費用が桁で違い、取り違えは実害になる）。
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
 * カセットを読む。形式検査に通らなければ落とす。壊れた記録で測った数字を「本物で測った」と読める場所へ出さない。
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
  writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`, "utf-8");
}

export function describeCassette(cassette: Cassette): string {
  const { space } = cassette.embedding;
  return (
    `記録日時=${cassette.recordedAt} ` +
    `LLM=${cassette.llm.model}(${Object.keys(cassette.llm.entries).length}件) ` +
    `埋め込み=${space.model}/${space.dimensions}次元` +
    `(${Object.keys(cassette.embedding.entries).length}件)`
  );
}
