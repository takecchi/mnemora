-- 0023_lexical_query_inner_quote_as_space.sql
--
-- 語彙チャンネルのクエリで、語の途中の `"` を空白として扱う（本文と同じ規則で語に分ける）。
--
-- `mnemora_lexical_query_tsqueries`（`0009_memories_lexical_or_coverage.sql`）は、クエリを語に割り、
-- 各語を `"…"` で囲んで `websearch_to_tsquery` へ渡す（語ごとの隣接要求を保ち、`-`・`or` などの
-- 記法を効かせないため）。囲みを壊さないよう、語の中の `"` を取り除いていたが、**空白ではなく
-- 詰めて**取り除いていた——`x"y` は1語 `xy` になり、本文側（`to_tsvector('simple', …)` は `x"y` を
-- `x` と `y` に分ける）と噛み合わず、本文と同じ文字列で探しても0件だった。
-- 【実測 2026-09-27】testkit の `InMemoryLexicalStore` は一致する。語の端の `"`（`"PROJ-1234"`）は
-- 詰めても影響が無い。
--
-- ⟹ `"` を空白に置き換える。`"x y"` はフレーズ（`'x' <-> 'y'`）になり、本文の `x"y` に当たる。
-- **関数の本体は `replace(t, '"', '')` を `replace(t, '"', ' ')` にした1か所だけを変えた**
-- （引数・戻り値・`IMMUTABLE PARALLEL SAFE`・ほかの式は 0009 と一字も変えていない）。
-- 0008・0009 の本文は変えていない（出荷済みの migration は書き換えない）。
--
-- この関数を使う `mnemora_lexical_query_or`・`mnemora_lexical_coverage` と、trigram の語彙検索
-- （`PostgresTrigramLexicalStore` の ASCII 側）も、同じく直る。索引の式（本文側の
-- `mnemora_lexical_normalize`）は変えていない——`idx_memories_lexical` は作り直さない。

CREATE OR REPLACE FUNCTION mnemora_lexical_query_tsqueries(text) RETURNS tsquery[] AS $$
  SELECT coalesce(array_agg(DISTINCT q), ARRAY[]::tsquery[])
  FROM (
    SELECT websearch_to_tsquery('simple', '"' || replace(t, '"', ' ') || '"') AS q
    FROM unnest(regexp_split_to_array(btrim(mnemora_lexical_query_terms($1)), '\s+')) AS t
    WHERE t <> ''
  ) s
  WHERE q::text <> '';
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
