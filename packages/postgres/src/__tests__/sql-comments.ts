/**
 * SQL テキストから、実行に効かない comment だけを取り除く、歯専用のユーティリティ。
 *
 * ## なぜ要るか
 *
 * `migrate-default-path-unchanged.test.ts` は「既定経路（`schema` 未指定）が発行する SQL 列に `SET LOCAL search_path` という実行される文が現れないこと」を守りたい。
 * だが `../migrate.ts` は `migrations/*.sql` の生テキストを comment ごと `client.query()` へ渡す。それ自体は正しい
 * （PostgreSQL 自身が comment を無視して実行するので、comment を残したまま送っても実行結果は変わらない。だから `migrate.ts` 側は変えない）。
 *
 * 生テキストへ素朴な正規表現 `/SET LOCAL search_path/` をかけると、説明 comment の中の字面にも反応する。
 * この関数は、歯が検査する前に comment を取り除くことで、歯の検査を「実行される文に現れるか」に近づける。
 *
 * ## 剥がし方
 *
 * comment の剥がし方を自前で書くと、そこが新しいバグの置き場になる。`--` 行 comment・`/` `*` ブロック comment・文字列リテラルの中に現れる `--` を区別できないと、
 * 実際のコード（文字列の中身）を壊して検査するか、逆に comment を見逃す。
 *
 * そのため「いま文字列の中にいるか」を状態に持つ、簡易の字句解析（state machine）にしてある。次のいずれかの中にいる間は、`--` も `/` `*` も一切特別扱いしない:
 *
 * - `'...'`（単一引用符の文字列。`''` は引用符自身のエスケープ）
 * - `"..."`（二重引用符の識別子。`""` はその中の引用符自身のエスケープ）
 * - `$tag$...$tag$` / `$$...$$`（dollar-quoting。`migrations/*.sql` が実際に使う）
 *
 * これらのどれでもないときだけ、`--`（行末までを除去、改行そのものは残す）と `/` `*` `*` `/`
 * （PostgreSQL は入れ子を許すため、深さを数えて対応する閉じまで除去し、除去した跡には token が隣接して繋がらないよう空白を1つ残す）を取り除く。
 *
 * ⚠ 裏取りは {@link ./sql-comments.test.ts} が持つ。このファイル単体を「たぶん合っている」で信じないこと。
 * 3つのケース（行 comment・ブロック comment・文字列内の `--`）を含め、`migrations/*.sql` の実物すべてに対しても回して壊れないことを歯にしてある。
 *
 * ⚠ 対象外:
 * - `E'...'`（バックスラッシュエスケープ文字列）は単一引用符の文字列と同じ規則（`''` エスケープのみ）で扱う。バックスラッシュ escape は解釈しない。
 * - 違うタグ同士が入れ子になった dollar-quoting（例: `$a$ ... $b$ ... $b$ ... $a$`）。
 * - dollar-quoted 文字列（関数本体）の中身は、opaque な文字列として丸ごとコピーするだけで、中の comment を剥がさない。
 *   PostgreSQL の最外層のパーサ自身が dollar-quoted を1個の文字列リテラルとしてしか見ないことに合わせてある。
 *   dollar-quoted 本体が `SET LOCAL search_path` という字面を含むようになったら、この関数の対象外であることを踏まえて拡張すること。
 */
export function stripSqlComments(sql: string): string {
  type State =
    | { kind: "normal" }
    | { kind: "line-comment" }
    | { kind: "block-comment"; depth: number }
    | { kind: "single-quoted" }
    | { kind: "double-quoted" }
    | { kind: "dollar-quoted"; tag: string };

  const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

  let out = "";
  let state: State = { kind: "normal" };
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const two = sql.slice(i, i + 2);

    switch (state.kind) {
      case "normal": {
        if (two === "--") {
          state = { kind: "line-comment" };
          i += 2;
          continue;
        }
        if (two === "/*") {
          state = { kind: "block-comment", depth: 1 };
          i += 2;
          continue;
        }
        if (ch === "'") {
          state = { kind: "single-quoted" };
          out += ch;
          i += 1;
          continue;
        }
        if (ch === '"') {
          state = { kind: "double-quoted" };
          out += ch;
          i += 1;
          continue;
        }
        if (ch === "$") {
          const match = DOLLAR_TAG_RE.exec(sql.slice(i));
          if (match) {
            const tag = match[0];
            state = { kind: "dollar-quoted", tag };
            out += tag;
            i += tag.length;
            continue;
          }
        }
        out += ch;
        i += 1;
        continue;
      }

      case "line-comment": {
        if (ch === "\n") {
          out += ch;
          state = { kind: "normal" };
        }
        i += 1;
        continue;
      }

      case "block-comment": {
        if (two === "/*") {
          state = { kind: "block-comment", depth: state.depth + 1 };
          i += 2;
          continue;
        }
        if (two === "*/") {
          const depth: number = state.depth - 1;
          i += 2;
          if (depth === 0) {
            out += " ";
            state = { kind: "normal" };
          } else {
            state = { kind: "block-comment", depth };
          }
          continue;
        }
        i += 1;
        continue;
      }

      case "single-quoted": {
        out += ch;
        if (ch === "'") {
          if (sql[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          state = { kind: "normal" };
        }
        i += 1;
        continue;
      }

      case "double-quoted": {
        out += ch;
        if (ch === '"') {
          if (sql[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          state = { kind: "normal" };
        }
        i += 1;
        continue;
      }

      case "dollar-quoted": {
        if (sql.startsWith(state.tag, i)) {
          out += state.tag;
          i += state.tag.length;
          state = { kind: "normal" };
          continue;
        }
        out += ch;
        i += 1;
        continue;
      }
    }
  }

  return out;
}
