import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import { assertWellFormedCtx, assertWellFormedFilter } from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";
import { replaceLoneSurrogates } from "./well-formed-text.js";
import {
  assertQueryLabelsWithoutNul,
  assertQueryDate,
  assertQueryJsonWithoutNul,
  assertQueryTextWithoutNul,
} from "./query-check.js";

/**
 * `'simple'` dictionary の代わりに使う、素朴な語彙正規化。postgres 実装の `to_tsvector('simple', …)` と `websearch_to_tsquery` を
 * 再発明せず、「語幹処理をしない完全一致」だけを借りる。
 *
 * 揃えた点: 語幹処理をしない・大文字小文字を区別しない・クエリの語のいずれか1つでも含むか（OR）で絞り、一致した語の割合（`coverage`）を返す（ADR 0092）。
 * 本文側は、ASCII の連なりの前後に空白を入れてから小文字化する。順序を逆にすると、小文字化で ASCII 化する非 ASCII 文字（ケルビン記号 U+212A → `k`）が
 * 隣の ASCII と癒着し、Postgres と結果が割れる。クエリ側は、非 ASCII の連なりを空白に落としてから分割する（非 ASCII だけのクエリは語彙が0個で0件。Postgres も同じ）。
 * クエリの単位は空白区切りの語で、語の中の token は隣接して並ぶことを要る（`PROJ-12` は1語、`'proj' <-> '-12'` のフレーズ。ADR 0513）。
 *
 * 揃えていない点:
 * - `websearch_to_tsquery` の `OR` / `-`（NOT）は解釈しない。
 * - Postgres の text search parser は `-12`・`a.b`・`user@example.com` を1 token にし、`abc-def` を結合形と部品の両方にする。ここは英数字境界で割るだけ。
 * - CJK の分かち書きはしない（`\p{L}\p{N}` の連なりを1 token にする粗い規則）。
 * - `toLowerCase()` と Postgres の `lower()` が全ロケール・全文字で一致する保証は無い。
 *
 * 「同じである」の根拠は、適合テスト（`lexical-store-conformance.ts`）が両方の実装に通ることだけ。
 */
function tokenize(text: string): string[] {
  return text
    .replace(ASCII_RUN_PATTERN, " $1 ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** `mnemora_lexical_normalize` が使う POSIX の `[[:ascii:]]`（0x00–0x7F。制御文字を含む）を、JS の正規表現で再現したもの。 */
// eslint-disable-next-line no-control-regex
const ASCII_RUN_PATTERN = /([\x00-\x7f]+)/g;

/** `mnemora_lexical_query_terms` と同じ向きで、クエリ側の非 ASCII の連なりを空白1つに落とす。`tokenize()`（本文側）へ渡す前に呼ぶ（本文側は非 ASCII を残すので意味が違う）。 */
function dropNonAsciiRuns(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x00-\x7f]+/g, " ");
}

/**
 * クエリ全体の文字数・異なる語数・語ごとの文字数の上限。`packages/postgres` の `lexical-query-cap.ts` と `packages/core` の `FakeLexicalStore` の同名の定数と同じ値。
 * import で共有できないので手で揃え、ずれていないことは `lexical-query-cap-values-match.test.ts` がソースを読んで突き合わせる。
 * export しない: `pnpm api:check` が `dist/*.d.ts` を丸ごと読むので、export すると公開面に漏れる。
 */
const LEXICAL_QUERY_MAX_DISTINCT_WORDS = 32;
const LEXICAL_QUERY_MAX_WORD_CHARS = 64;
const LEXICAL_QUERY_MAX_TOTAL_CHARS = 600;

/** `query` が {@link LEXICAL_QUERY_MAX_TOTAL_CHARS} を超えるとき、先頭からその文字数以下に、書記素を割らずに切り詰める。他のどの上限よりも先に適用する。 */
function capQueryTotalChars(query: string): string {
  return query.length > LEXICAL_QUERY_MAX_TOTAL_CHARS
    ? sliceAtGraphemeBoundary(query, LEXICAL_QUERY_MAX_TOTAL_CHARS)
    : query;
}

/**
 * クエリを空白区切りの語に割り、語ごとに `tokenize()` した token の列（その語のフレーズ）の配列を返す。
 * 上限は語に当たる（token ではない）。token が取れない語は捨て（分母に数えない）、同じ token 列の語は1つにまとめる（Postgres の `DISTINCT`）。
 * 呼び出し側が `dropNonAsciiRuns(capQueryTotalChars(query))` を渡すこと。
 */
function queryPhrases(asciiOnlyQuery: string): string[][] {
  const rawWords = asciiOnlyQuery.split(/\s+/).filter((w) => w.length > 0);
  const seenLowercased = new Set<string>();
  const words: string[] = [];
  for (const raw of rawWords) {
    const word =
      raw.length > LEXICAL_QUERY_MAX_WORD_CHARS ? raw.slice(0, LEXICAL_QUERY_MAX_WORD_CHARS) : raw;
    const key = word.toLowerCase();
    if (!seenLowercased.has(key)) {
      seenLowercased.add(key);
      words.push(word);
    }
  }
  const seenPhrases = new Set<string>();
  const phrases: string[][] = [];
  for (const word of words.slice(0, LEXICAL_QUERY_MAX_DISTINCT_WORDS)) {
    const phrase = tokenize(word);
    if (phrase.length === 0) continue;
    const key = phrase.join(" ");
    if (!seenPhrases.has(key)) {
      seenPhrases.add(key);
      phrases.push(phrase);
    }
  }
  return phrases;
}

/** `phrase` が `tokens` の中に隣接してこの順で現れる回数（`<->` のフレーズ一致）。 */
function countPhrase(tokens: string[], phrase: string[]): number {
  let count = 0;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((p, j) => tokens[i + j] === p)) count += 1;
  }
  return count;
}

/** クエリ語の集合に対する `content` の一致度を、頻度の和として素朴に数える。`ts_rank_cd` の近似ではない（`rank` の尺度は adapter ごとに違ってよい）。 */
function computeRank(contentTokens: string[], phrases: string[][]): number {
  let rank = 0;
  for (const phrase of phrases) {
    rank += countPhrase(contentTokens, phrase);
  }
  return rank;
}

/**
 * `LexicalStore` のインメモリ・プレースホルダ実装。索引・pg の text search 機構を模さない最小実装。
 *
 * `memoryStore` は必須: `LexicalStore` は `upsert`/`delete` を持たず（Postgres は `memories.content` の上に式索引を張る）、
 * この実装も自前の Map を持たず `memoryStore.listByTenant` で Memory を直接読む。省略できると、filter/content を検査できる adapter と
 * 検査できない adapter が同じ緑の出力になる（ADR 0034）。
 *
 * `search` が返す `LexicalHit` は毎回新しく組み立てる: 内部表現（`Memory` 行やトークン配列）を返り値に混ぜない。
 *
 * `coverage` は、空白で区切ったクエリの語（重複は1語）のうち本文にフレーズとして現れた数 ÷ 語の総数。
 * 1/n 刻みで、`PostgresLexicalStore`（tsvector）と同じ式。`PostgresTrigramLexicalStore` の日本語側（閾値で 0/1 の二値）とは違う（ADR 0553）。
 */
export class InMemoryLexicalStore implements LexicalStore {
  constructor(private readonly memoryStore: InMemoryMemoryStore) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    // 検索語の NUL は Postgres の `text` に渡せない。
    assertQueryTextWithoutNul("InMemoryLexicalStore.search", "query", query);
    // 読みの口の日時は下限（4714-11-24 BC）より前でも断らず、そのまま比べる（Postgres は下限へ寄せるが答えは同じ）。Invalid Date だけ断る。
    assertQueryDate("search", "filter.occurredAfter", opts.filter.occurredAfter);
    assertQueryDate("search", "filter.occurredBefore", opts.filter.occurredBefore);
    assertQueryDate("search", "filter.validAt", opts.filter.validAt);
    // `labels`・`attributes` の NUL は、Postgres ではクエリの時点で拒まれる。
    assertQueryLabelsWithoutNul("search", "filter.labels", opts.filter.labels);
    // `filter.labels` の孤立サロゲートは、Postgres では U+FFFD に置き換わって比べられる。
    opts = {
      ...opts,
      filter: {
        ...opts.filter,
        ...(opts.filter.labels === undefined
          ? {}
          : { labels: opts.filter.labels.map((label) => replaceLoneSurrogates(label)) }),
      },
    };
    assertQueryJsonWithoutNul("search", "filter.attributes", opts.filter.attributes);
    // 整数でない・負の `limit` は先に断る: `slice` は `NaN`→空、`Infinity`→全件、負数→「末尾から数えた除外」と黙って別の値に丸め、limit が効かない結果を返す。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値も Postgres は拒む。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`search: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // 文字数の上限は全体を最初に適用する。非 ASCII の連なりは空白に落としてから分割する（`tokenize()` 参照）。
    const phrases = queryPhrases(dropNonAsciiRuns(capQueryTotalChars(query)));
    if (phrases.length === 0) {
      // 語彙が1つも取れないクエリは0件。
      return [];
    }

    // テナント分離は `opts.filter.tenantId` と `ctx.tenantId` の両方の一致で行う（AND）。食い違えば0件（例外は投げない）。
    const memories =
      ctx.tenantId === opts.filter.tenantId
        ? this.memoryStore.listByTenant({ tenantId: opts.filter.tenantId })
        : [];

    const hits: (LexicalHit & { recordedAt: Date })[] = [];
    for (const memory of memories) {
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      // `includeSubjectless: true` のときだけ、`subject_id IS NULL`（主題なし）も通す。
      const subjectMatches =
        opts.filter.subjectId === undefined ||
        memory.subjectId === opts.filter.subjectId ||
        (opts.filter.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // AND 等値の絞り込み。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const attributesMatch = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!attributesMatch) {
          continue;
        }
      }
      // OR の集合絞り込み。
      if (opts.filter.labels !== undefined) {
        const labels = opts.filter.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          continue;
        }
      }
      // 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // period（両端とも包含）。比較対象は `occurredAt ?? recordedAt`。
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
      // `validAt` ゲート。
      if (opts.filter.validAt !== undefined) {
        if (memory.validFrom != null && memory.validFrom > opts.filter.validAt) {
          continue;
        }
        if (memory.validUntil != null && memory.validUntil <= opts.filter.validAt) {
          continue;
        }
      }

      const contentTokens = tokenize(memory.content);
      // OR 意味論: 1つも一致しなければ返さない。
      let matched = 0;
      for (const phrase of phrases) {
        if (countPhrase(contentTokens, phrase) > 0) {
          matched += 1;
        }
      }
      if (matched === 0) {
        continue;
      }

      const coverage = matched / phrases.length;
      hits.push({
        memoryId: memory.id,
        coverage,
        rank: computeRank(contentTokens, phrases),
        recordedAt: memory.recordedAt,
      });
    }

    // coverage → rank → recordedAt DESC → memoryId 昇順の4段 tie-break（`PostgresLexicalStore` と同じ）。同点が挿入順になると、Postgres の「新しい方が先」と逆になる。
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

/**
 * `@mnemora/core` の `sliceAtGraphemeBoundary`（`packages/core/src/text-truncation.ts`）の写し。`@mnemora/postgres` の `lexical-query-cap.ts` にも同じ写しがある。
 * core から import しないのは、core の内部関数で公開していないため（公開すると公開 API の snapshot が増える）。
 * export しないのは、このパッケージの公開面に出さないため。切り詰めの規則を変えるときは3つとも見ること。
 */
function sliceAtGraphemeBoundary(text: string, maxLength: number): string {
  const limit = Math.max(0, maxLength);
  if (text.length <= limit) {
    return text;
  }
  let end = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const next = index + segment.length;
    if (next > limit) {
      break;
    }
    end = next;
  }
  return text.slice(0, end);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
