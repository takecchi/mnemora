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
export const ANSWER_CASSETTE_PATH = join(here, "..", "cassettes", "answer.json");
/**
 * `answer-time-weighting` ベンチ（Issue #690 / PR #697、`timeWeighting` を回答の正誤で
 * 比較する器）専用のカセット。**`answer.json` とは別ファイルにする**——ADR 0052 と同じ
 * 理由（入力の集合が別物・費用が別勘定）に加え、こちらはケースごとに `recall()` を
 * `legacy`/`eventAwareFreshness` の2方針で呼ぶため、同じ質問でも記録の鍵（プロンプトの
 * ハッシュ）が `answer` ベンチとは異なる——1つのファイルにまとめる技術的な理由も無い。
 *
 * ⚠ 段1（本 commit）ではこのパスを**宣言するだけ**で、ファイル自体はまだ存在しない。
 * `record:answer-time-weighting`（実 API 必須）を実行して初めて作られる——
 * `answer.json` 等の既存カセットと同じく、手編集は禁止（`describeCassette` 等が
 * 前提にする形式検査 `assertCassette` を満たす保証が無くなる）。
 */
export const ANSWER_TIME_WEIGHTING_CASSETTE_PATH = join(
  here,
  "..",
  "cassettes",
  "answer-time-weighting.json",
);

/** `record` / `verify` / 再生が対象にできるカセット。 */
export type CassetteTarget = "retrieval" | "compare" | "answer" | "answer-time-weighting";

export const CASSETTE_TARGETS: readonly CassetteTarget[] = [
  "retrieval",
  "compare",
  "answer",
  "answer-time-weighting",
];

const CASSETTE_PATH_BY_TARGET: Record<CassetteTarget, string> = {
  retrieval: RETRIEVAL_CASSETTE_PATH,
  compare: COMPARE_CASSETTE_PATH,
  answer: ANSWER_CASSETTE_PATH,
  "answer-time-weighting": ANSWER_TIME_WEIGHTING_CASSETTE_PATH,
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
