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

/** `retrieval` の probe set に対応するカセット。 */
export const RETRIEVAL_CASSETTE_PATH = join(here, "..", "cassettes", "retrieval.json");

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
