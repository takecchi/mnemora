import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * core は `EmbeddingProvider.embed()` を、つねに1件だけのバッチで呼ぶ。この歯が赤いとき、壊れているのは core の実装ではなく、すでに測ってある埋め込みの数字のほうである。
 * ADR 0095 決定5 は本物の埋め込みモデルのバッチ不変性を契約にしておらず、ADR 0110 の実測では同じ1文のベクトルがバッチの組み方で `1e-2` オーダー動いた。
 * `examples/chat` の probe が測る gold と distractor の差（`org-b` で `8.0e-5`）はそれより2桁小さいので、core が1件ずつ呼ぶのをやめると、順位の入れ替わりが想起の良し悪しなのかバッチの組み方なのか区別できなくなる。
 * バッチ化を禁じるのではない。バッチ化するなら ADR 0110 の測定を録り直し、`identifier-probes` の基準値を引き直す。
 * この歯は「バッチ不変性」を主張せず、「core の本番経路がバッチを組んでいない」ことだけを縛る。
 */

const SRC_DIR = join(__dirname, "..");

/** `embed(` を呼んでいる箇所すべて（コメント中の言及も拾うが、下で形も見るので害は無い）。 */
const ANY_EMBED_CALL = /embeddingProvider\.embed\s*\(/g;

/**
 * `embeddingProvider.embed(ctx, [ 単一の式 ])` の形。配列リテラルに `,` が無いことを見る。
 *
 * 件数を測りたいので、末尾の任意の第3引数（`opts?: AbortOptions`）は許す（`[^)]*` で1行分だけ緩く受ける）。
 * `runAbortable(...)` のような複数行のラップはこの正規表現の対象外だが、その場合は `ANY_EMBED_CALL` 側で件数が増えないので、この歯は機能する。
 */
const SINGLE_TEXT_EMBED_CALL =
  /embeddingProvider\.embed\s*\(\s*ctx\s*,\s*\[([^[\],]*)\](?:\s*,\s*[^)]*)?\s*\)/g;

function readSourceFiles(): { file: string; source: string }[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => ({
      file: entry.name,
      source: readFileSync(join(SRC_DIR, entry.name), "utf-8"),
    }));
}

describe("core の本番経路は EmbeddingProvider.embed() を1件ずつ呼ぶ（ADR 0110 §4 の前提）", () => {
  it("`embeddingProvider.embed(` の呼び出しは、すべて要素1つの配列リテラルを渡している", () => {
    const offenders: string[] = [];
    let callSiteCount = 0;

    for (const { file, source } of readSourceFiles()) {
      const anyCalls = source.match(ANY_EMBED_CALL)?.length ?? 0;
      const singleCalls = source.match(SINGLE_TEXT_EMBED_CALL)?.length ?? 0;
      callSiteCount += anyCalls;
      if (anyCalls !== singleCalls) {
        offenders.push(
          `${file}: 呼び出し ${anyCalls} 件のうち ${singleCalls} 件しか 1件バッチの形をしていない`,
        );
      }
    }

    expect(
      offenders,
      "core が EmbeddingProvider.embed() に2件以上を渡し始めている。" +
        "ADR 0095 決定5 の通りバッチ不変性は契約ではなく、ADR 0110 の実測では " +
        "@mnemora/local-embedding のベクトルはバッチの組み方で 1e-2 オーダー動いた。" +
        "examples/chat の probe が測っている gold/distractor の差はそれより2桁小さい " +
        "（org-b で 8.0e-5）ので、この変更は identifier-probes の測定値を無効にする。" +
        "⟹ バッチ化を採るなら、ADR 0110 の測定と identifier-probe-baseline.json を" +
        "同じ変更の中で引き直すこと。",
    ).toEqual([]);

    // 呼び出しが0件になったら、この歯は何も見ていない（陰性対照が空回りする形、ADR 0103）。
    expect(
      callSiteCount,
      "core に embeddingProvider.embed() の呼び出しが1件も無い",
    ).toBeGreaterThan(0);
  });
});
