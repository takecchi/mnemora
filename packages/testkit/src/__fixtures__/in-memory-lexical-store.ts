import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";

/**
 * `'simple'` dictionary の代わりに使う、素朴な語彙正規化。
 *
 * postgres 実装（Issue #106、[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)）は
 * `to_tsvector('simple', regexp_replace(text, '([[:ascii:]]+)', ' \1 ', 'g'))` の上に
 * `websearch_to_tsquery` を重ねる。**ここではそれを自前で再発明しない**——
 * `'simple'` dictionary は語幹処理（stemming）をしない、というその1点だけを借りて、
 * 「小文字化してから Unicode の英数字境界で分割し、トークンの完全一致を見る」という
 * 最小の実装にしてある（`'simple'` が語幹処理をしないからこそ、完全一致がその近似になる。
 * `'english'` 等の語幹処理をする config だったら、この近似は成り立たない）。
 *
 * **⚠ 正直に書く: 何が同じで何が違うか。**
 *
 * 同じだと確認したこと（このファイルの意図として揃えた点）:
 * - 語幹処理をしない（完全一致）。
 * - 大文字・小文字を区別しない。
 * - クエリの語のいずれか1つでも含むか（OR）で絞り、一致した語の割合（`coverage`）を返す
 *   （[ADR 0092](../../../../docs/decisions/0092-lexical-or-coverage.md)。
 *   postgres 実装の `mnemora_lexical_query_or` / `mnemora_lexical_coverage` と同じ向き）。
 *
 * **違う・確認していないこと**:
 * - `websearch_to_tsquery` の `"..."`（フレーズ）/ `OR` / `-`（NOT）はここでは一切解釈しない。
 *   空白区切りの語の集合としてしか読まない（各語を独立に OR で見る）。
 *   **⚠ ADR 0092 で postgres 側も各語を `"..."` で囲むようになり、生クエリ中の
 *   websearch 演算子を解釈しなくなった**——この差はむしろ縮む方向である
 *   （ADR 0092「採った副作用」）。
 * - CJK（分かち書きの無い日本語・中国語等）の扱いは確認していない。
 *   postgres 側の `regexp_replace(text, '([[:ascii:]]+)', ' \1 ', 'g')` は ascii の連続の前後に
 *   空白を挟むことで、CJK に埋め込まれた ascii の語（例: 日本語文中の英単語）を
 *   `to_tsvector` が別トークンとして切れるようにする一手だが、**CJK 自体を分かち書きする
 *   ものではない**（`'simple'` dictionary・既定の text search parser に形態素解析は無い）。
 *   ここでの実装（Unicode の「文字」境界で分割）が同じ挙動になるかは**確認していない**。
 * - `String.prototype.toLowerCase()` と postgres の `lower()` が全ロケール・全文字で
 *   一致する保証は無い（確認していない）。
 * - 数字・ハイフン・アポストロフィ等の細かいトークン化規則（postgres の text search parser の
 *   `word`/`numword`/`hword` 等の分類）は再現していない——ここでは
 *   Unicode の letter/number をひとまとめのトークンとして扱う、より粗い規則を使う。
 *
 * **適合テスト（`lexical-store-conformance.ts`）が両方の実装に対して通ることだけが、
 * 「同じである」の唯一の根拠である。**このコメントの主張ではない。
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * クエリ全体の文字数・異なる語数・語ごとの文字数の上限（Issue #878、2026-09-26、
 * クローン miku の判断）。
 *
 * `packages/postgres` の `LEXICAL_QUERY_MAX_TOTAL_CHARS`/`LEXICAL_QUERY_MAX_DISTINCT_WORDS`
 * （`packages/postgres/src/lexical-query-cap.ts`）、`packages/core` の
 * `FakeLexicalStore` が持つ同名の定数（`packages/core/src/__tests__/runtime-fakes.ts`）と
 * **同じ値**（3箇所とも手で揃える——`InMemoryLexicalStore`/`FakeLexicalStore` は
 * `@mnemora/core` の外・`@mnemora/postgres` の外に居るため、import で共有できない。
 * 値がずれていないことは `packages/postgres` 側の歯
 * `lexical-query-cap-values-match.test.ts` が、3ファイルのソースを読んで突き合わせる）。
 *
 * **`tokenize()` は非文字・非数字の連なりをすでに区切り文字として分割する**
 * （`\p{L}\p{N}` の否定クラス）ため、postgres 側と同じ理由がそのまま当てはまる
 * わけではない。**それでも語ごとの文字数・クエリ全体の文字数の上限を同じ形で
 * 入れる**のは、3実装の挙動をできるだけ揃えるためである。
 */
// ⚠ export しない——`packages/testkit` には2つ公開入口があり（`index.ts` と
// `fixtures.ts`）、`fixtures.ts` は `export { InMemoryLexicalStore } from "..."` という
// 名前指定の再 export だが、`pnpm api:check` はこのファイルの `dist/*.d.ts` を丸ごと
// 読むため、ここで export すると名前指定の再 export の対象でなくても公開面に漏れる
// （実測: 一度 export してみたところ `pnpm api:check` の `@mnemora/testkit` 差分に
// `dist/__fixtures__/in-memory-lexical-store.d.ts` 経由で現れた）。⟹ 値を参照したい
// テスト（`in-memory-lexical-store-query-word-cap.test.ts`/
// `in-memory-lexical-store-query-char-cap.test.ts`）は、値を書き写す（コメントで
// この定義を指す）。値が `packages/postgres`/`packages/core` の定数とずれていないかは
// `packages/postgres` 側の歯 `lexical-query-cap-values-match.test.ts` が、
// このファイルのソースを読んで検査する。
const LEXICAL_QUERY_MAX_DISTINCT_WORDS = 32;
const LEXICAL_QUERY_MAX_WORD_CHARS = 64;
// `packages/postgres` の LEXICAL_QUERY_MAX_TOTAL_CHARS と同じ値・同じ理由
// （lexical-query-cap.ts の doc 参照——語数・1語の文字数を両方とも上限まで使った
// 入力は、この2つの上限だけでは十分に小さくならない場合があるため、クエリ全体の
// 文字数にも独立した上限を置く）。
const LEXICAL_QUERY_MAX_TOTAL_CHARS = 600;

/**
 * `query` が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超える場合、先頭からその文字数に
 * 切り詰める。超えなければ `query` をそのまま返す（1バイトも変えない）。他のどの上限
 * （語数・1語の文字数）よりも先に適用する（`packages/postgres` の
 * `capLexicalQueryTotalChars` と同じ位置づけ）。
 */
function capQueryTotalChars(query: string): string {
  return query.length > LEXICAL_QUERY_MAX_TOTAL_CHARS
    ? query.slice(0, LEXICAL_QUERY_MAX_TOTAL_CHARS)
    : query;
}

/**
 * `tokenize(query)` の結果から、1語が {@link LEXICAL_QUERY_MAX_WORD_CHARS} を超える
 * 場合は先頭からその文字数に切り詰め、そのうえで異なる語を先頭からの出現順に
 * {@link LEXICAL_QUERY_MAX_DISTINCT_WORDS} 個まで残した `Set` を返す。
 * どちらの上限にも触れない限り、全ての語を含む `Set` をそのまま返す
 * （1件も切り捨てない）。**呼び出し側が、`tokenize` に渡す前の `query` に
 * {@link capQueryTotalChars} をあらかじめ通しておくこと**（`search` 参照）。
 */
function capQueryTerms(tokens: string[]): Set<string> {
  const truncatedTokens = tokens.map((token) =>
    token.length > LEXICAL_QUERY_MAX_WORD_CHARS
      ? token.slice(0, LEXICAL_QUERY_MAX_WORD_CHARS)
      : token,
  );
  const distinctInFirstSeenOrder: string[] = [];
  const seen = new Set<string>();
  for (const token of truncatedTokens) {
    if (!seen.has(token)) {
      seen.add(token);
      distinctInFirstSeenOrder.push(token);
    }
  }
  if (distinctInFirstSeenOrder.length <= LEXICAL_QUERY_MAX_DISTINCT_WORDS) {
    return seen;
  }
  return new Set(distinctInFirstSeenOrder.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS));
}

/**
 * クエリ語の集合に対する `content` の一致度を、頻度の和として素朴に数える。
 *
 * **🔴 `ts_rank_cd` の近似ではない。**`LexicalHit.rank` の契約
 * （`interfaces/lexical-store.ts`）が明記する通り、`rank` の尺度は adapter ごとに違ってよく
 * 比較可能なのは同一 adapter の結果同士だけ——ここでの式（頻度の和）は、
 * 「頻度が高いほど大きい値になる」という向きだけを postgres 実装と共有する、
 * この in-memory 実装だけのローカルな規則である。
 */
function computeRank(contentTokens: string[], queryTerms: Set<string>): number {
  let rank = 0;
  for (const token of contentTokens) {
    if (queryTerms.has(token)) {
      rank += 1;
    }
  }
  return rank;
}

/**
 * `LexicalStore` のインメモリ・プレースホルダ実装（[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)、
 * [ADR 0092](../../../../docs/decisions/0092-lexical-or-coverage.md)、Issue #106）。
 * 索引・pg の text search 機構を模さない最小実装であり、
 * `packages/testkit` の適合テストを実行できることを示すためだけのもの。
 *
 * **`memoryStore` を必須のコンストラクタ引数にしている（省略不可）。** `LexicalStore` は
 * `upsert`/`delete` を持たない（`interfaces/lexical-store.ts` のクラス doc）——postgres 実装は
 * `memories.content` そのものの上に式索引を張るので、索引は本体の書き込みに自動で追随し、
 * 同期の口が要らない。この in-memory 実装も同じ非対称を再現する: 自前の Map を持たず、
 * `memoryStore.listByTenant` を通じて `InMemoryMemoryStore` が保持する Memory を直接読む
 * （`InMemoryVectorStore` が `status`/`subjectId`/`decayFloorAt` のためだけに `memoryStore` を
 * 参照するのとは違い、こちらは `content` 自体の読み取りにも `memoryStore` を使う）。
 *
 * **省略可能にしなかった理由（ADR 0034 と同じ規律）**: 省略できると「filter/content を
 * 実際に検査できる adapter」と「検査できない adapter」が同じ緑色の出力になる。
 * `InMemoryVectorStore` のクラス doc が引いている ADR 0011/0025/0027/0028 の族の失敗を、
 * ここでも繰り返さない。
 *
 * **🔴 `search` が返す `LexicalHit` は毎回新しく組み立てる（`{ memoryId, coverage, rank }` の
 * オブジェクトリテラル）。**いずれもプリミティブなので Map の行を
 * そのまま返しても書き換えの経路自体は無いが、**内部表現（`Memory` 行やトークン配列）を
 * 返り値に混ぜないことを明示するためにここへ書いておく**——この repo では
 * 「Map の行の参照をそのまま返し、呼び出し側の書き換えが store の中身まで変えてしまい、
 * 歯が無力化された」前例があるため（`in-memory-vector-store.ts` の `cosineDistance` の doc、
 * ADR 0040 の周辺で踏まれた同族の穴）。
 */
export class InMemoryLexicalStore implements LexicalStore {
  constructor(private readonly memoryStore: InMemoryMemoryStore) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    // `PostgresLexicalStore.search`（`buildLexicalSearchSelect`）は `opts.limit` を
    // 生 SQL の `LIMIT` にそのまま渡すため、負数を渡すと Postgres 自身が
    // `LIMIT must not be negative` で例外を投げる（実測済み。in-memory-vector-store.ts の
    // 同種の注記参照）。ここで検査せず `hits.slice(0, opts.limit)` へ渡すと、
    // `Array.prototype.slice` の負数引数は「末尾から数えた除外」という別の意味になり、
    // ほぼ全件を静かに返してしまう——クエリを投げる前に弾く Postgres 側に揃える。
    //
    // ⚠ 負数だけでは足りない——`LIMIT` の SQL パラメータは bigint 型であり、`NaN`/
    // `Infinity`/非整数を渡すと Postgres は `invalid input syntax for type bigint: "NaN"`
    // の形で例外を投げる（実測済み。in-memory-vector-store.ts の同種の注記参照）。
    // 既存の「負数」ガード（上の段落）とは別の例外メッセージにして、PR #811 が固定した
    // 「負数は例外」の回帰テストの文言を変えずに済ませる。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    // Issue #878: クエリ全体の文字数・異なる語数・1語の文字数に上限を置く
    // （capQueryTotalChars/capQueryTerms の doc 参照）。全体の文字数を最初に適用する。
    const queryTerms = capQueryTerms(tokenize(capQueryTotalChars(query)));
    if (queryTerms.size === 0) {
      // 契約: 語彙が1つも取れないクエリは0件（`lexical-store-conformance.ts` の歯）。
      return [];
    }

    // テナント分離は `opts.filter.tenantId` の一致だけで行う——`InMemoryVectorStore.search`
    // と同じ理由（docs/architecture.md §5.2: filter は索引で表現できる形に限る。
    // `ctx.tenantId` で二重に絞ると「filter.tenantId を無視しても壊れない」誤ったプレースホルダになる）。
    const memories = this.memoryStore.listByTenant({ tenantId: opts.filter.tenantId });

    const hits: (LexicalHit & { recordedAt: Date })[] = [];
    for (const memory of memories) {
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      // Issue #608 項目③(b) / ADR 0286: `includeSubjectless: true` のときだけ、
      // `subject_id IS NULL`（主題なし）も通す（`InMemoryVectorStore` と同じ意味論）。
      const subjectMatches =
        opts.filter.subjectId === undefined ||
        memory.subjectId === opts.filter.subjectId ||
        (opts.filter.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // Issue #152/#153（ADR 0312）: AND 等値の絞り込み（`InMemoryVectorStore` と同じ意味論）。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const attributesMatch = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!attributesMatch) {
          continue;
        }
      }
      // Issue #201 PR-B（ADR 0323）: OR の集合絞り込み（`InMemoryVectorStore` と同じ意味論）。
      if (opts.filter.labels !== undefined) {
        const labels = opts.filter.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          continue;
        }
      }
      // ADR 0056: 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // ADR 0039: period（両端とも包含、`>=`/`<=`）。比較対象は `occurredAt ?? recordedAt`。
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }
      // Issue #280（Issue #202 第2弾）: `validAt` ゲート。`in-memory-vector-store.ts` と
      // 同じ述語・同じ境界。
      if (opts.filter.validAt !== undefined) {
        if (memory.validFrom != null && memory.validFrom > opts.filter.validAt) {
          continue;
        }
        if (memory.validUntil != null && memory.validUntil <= opts.filter.validAt) {
          continue;
        }
      }

      const contentTokens = tokenize(memory.content);
      // OR 意味論（ADR 0092）: クエリの語のうち、content に含まれるものを数える。
      // 1つも一致しなければ返さない——`matched === 0` は「一致した候補」ではない。
      const contentTokenSet = new Set(contentTokens);
      let matched = 0;
      for (const term of queryTerms) {
        if (contentTokenSet.has(term)) {
          matched += 1;
        }
      }
      if (matched === 0) {
        continue;
      }

      const coverage = matched / queryTerms.size;
      hits.push({
        memoryId: memory.id,
        coverage,
        rank: computeRank(contentTokens, queryTerms),
        recordedAt: memory.recordedAt,
      });
    }

    // `PostgresLexicalStore.search`（`interfaces/lexical-store.ts` の `LexicalStore.search`
    // doc、Issue #345 / ADR 0175）と同じ4段 tie-break: coverage → rank → recordedAt DESC →
    // memoryId 昇順。以前は coverage/rank の2段止まりで、同点の中身が
    // `Array.prototype.sort` の安定性により挿入順（通常の呼び出し順では recordedAt が
    // 古いほうが先）に落ちており、Postgres の「新しい方が先」と逆向きだった
    // （`in-memory-lexical-store-tiebreak.test.ts` が歯）。
    hits.sort(
      (a, b) =>
        b.coverage - a.coverage ||
        b.rank - a.rank ||
        b.recordedAt.getTime() - a.recordedAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    return hits
      .slice(0, opts.limit)
      .map(({ memoryId, coverage, rank }) => ({ memoryId, coverage, rank }));
  }
}
