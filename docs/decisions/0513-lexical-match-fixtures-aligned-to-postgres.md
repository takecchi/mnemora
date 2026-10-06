# ADR 0513: 語彙検索の fixture を Postgres に揃える（core の Fake は部分一致をやめて語の一致に、testkit の InMemory は `PROJ-12` を空白区切りの 1 語として数える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**【現物】: [ADR 0509](./0509-fuzz-uncovered-fields-channels-hnsw-recall-record.md) が、recall の fuzz に `channels` を足して、Fake・testkit の語彙検索が Postgres と食い違う 2 つの割れを見つけ、固定の操作列で留めた。[ADR 0493](./0493-fake-and-inmemory-input-checks-aligned-to-postgres.md)・[0500](./0500-testkit-fixture-alignment-claimkey-labels-timestamptz-seq-llm-float4.md) の「fixture を Postgres に揃える」の線に載せて、その 2 つを直した。この PR は #1638（ADR 0509）の上に積んでいる。
- **依頼の記述と現物の食い違い**【実測】: 依頼と ADR 0509 は、Postgres が `PROJ-12` を「1 語と数える」と書いた。**正確には、coverage の分母の単位が空白区切りの語で 1 つ**ということで、tsvector の token が 1 つという意味ではない。`mnemora_lexical_tsvector('PROJ-12')` は `'-12':2 'proj':1`（`-12` は符号付きの整数の token）で、クエリ `PROJ-12` の tsquery は `'proj' <-> '-12'`（フレーズ）。このため「1 語の token に揃える」ことはできず、**「分母は空白区切りの語、中の token は隣接を要る」に揃えた**（下）。

## 決めたこと【判断】

1. **core の `FakeLexicalStore`**（`packages/core/src/__tests__/runtime-fakes.ts`。出荷物ではない）: `normalizedContent.includes(語)` の部分一致をやめ、testkit と同じ語（token）の一致にした。content は ASCII の連なりの前後に空白を入れ、小文字化し、`\p{L}\p{N}` 以外で割る。クエリは空白区切りの語ごとに同じ割り方で token の列（フレーズ）にし、content の token の列に隣接して現れたら一致と数える。
2. **testkit の `InMemoryLexicalStore`**（`packages/testkit/src/__fixtures__/in-memory-lexical-store.ts`）: クエリを英数字境界で割った語の集合にするのをやめ、**空白区切りの語を 1 単位（coverage の分母）**にし、語の中の token の隣接を要る。語の上限（32 語・1 語 64 文字・全体 600 文字）は、Postgres の `capLexicalQueryWords` と同じく**語**に当てる（以前は token に当てていた）。token が取れない語（`---`）は分母に数えない。同じ token 列の語は 1 つにまとめる（Postgres の `array_agg(DISTINCT tsquery)`）。`rank` は、一致した語のフレーズが content に現れた回数の和（Fake も同じ）。
3. **trigram の store**: 別の規則は ASCII 側には無い【現物】。`PostgresTrigramLexicalStore` の ASCII 側の coverage は `mnemora_lexical_query_tsqueries` を使う式で、tsvector の store と同じ。日本語側は `word_similarity` だが、fixture（InMemory・Fake）はどちらも非 ASCII の連なりをクエリから落とす（Postgres の tsvector 側と同じ）ので、日本語の trigram の一致は fixture に無い（ADR 0509 の負債 2 のまま）。混ぜていない。
4. **fuzz**: ADR 0509 の `CHANNEL_WORDS` から外していた `PROJ-12` を戻し、部分文字列になる語 `alp` を足した。ADR 0509 の「既知の割れ」の固定列 2 本は、期待を「食い違わない」に反転した（Fake・testkit とも）。
5. **公開 API は増えない**。conformance suite に it は足していない。本物の adapter（`@mnemora/postgres`）は変えていない（`memory-store.ts` に触れていない）。CHANGELOG の `[1.3.0]` の Changed と migration-v1 の 🟡 に載せた（testkit の fixture の変更。[ADR 0461](./0461-v1-2-0-release-prep-inspection.md)）。core の Fake は出荷物ではないので載せていない。

## 測ったこと【実測】

手元の PostgreSQL 17（`initdb`、UTF8 + C.UTF-8）で `mnemora_lexical_tsvector`・`mnemora_lexical_query_tsqueries`・`mnemora_lexical_coverage` を直接呼んだ。

| content × query | Postgres の coverage | 以前の Fake | 以前の testkit |
|---|---|---|---|
| `alpha` × `a` | 0 件 | 当たる | 0 件 |
| `PROJ-12` × `PROJ-12` | 1 | 1 | 1 |
| `gamma` × `gamma PROJ-12` | 0.5 | 0.5 | 1/3 |
| `proj x 12` × `PROJ-12` | 0 件（フレーズの隣接） | 0 件 | 当たる |
| `bar foo` × `foo_bar` | 0 件（`foo_bar` は `'foo' <-> 'bar'`） | 0 件 | 当たる |
| `foo bar` × `foo_bar` | 1 | 1 | 1 |
| `日本語text` × `text` | 1 | 1 | 1 |
| `a b` × `a ---` | 1（`---` は空の tsquery で分母に数えない） | 0.5 | 0.5 |

この表は、`fake-lexical-store-token-match.test.ts`（core）と `in-memory-lexical-store-token-match.test.ts`（testkit）の歯の表と同じ（18 行）。

## 赤→緑・変異【実測】

- **赤**（直す前の実装を戻した形）: Fake の部分一致に戻すと core の歯が 2 本赤（`alpha`×`a`・`alpha`×`alp`）、さらに固定列の「割れ 1」の反転版が赤。testkit を英数字境界の 2 語に戻すと testkit の歯が 3 本赤（`proj x 12`×`PROJ-12`・`gamma`×`gamma PROJ-12`・`bar foo`×`foo_bar`）、固定列の「割れ 2」の反転版が赤。直す前の最初の実測では、core の歯は 19 本中 4 本、testkit の歯は 19 本中 4 本が赤だった（`proj 12`×`PROJ-12` は下の「揃えていない」ので表から外した）。
- **緑**: 上の 2 ファイルと、既存の `fake-lexical-store-postgres-alignment`・`fake-lexical-store-query-cap`・`fake-store-postgres-parity`・`recall-channels`（core）、`in-memory-lexical-store-*`（testkit）、`in-memory-fixtures.conformance` の語彙の it（33 本）、`lexical-query-cap-values-match`（postgres）、fuzz の固定列 2 本と `channels` の差分（40 シード、Fake・testkit）。壊れた既存の歯は無かった。
- **変異**（前景で 1 本ずつ、`cp` で戻して `cmp` で確かめた）:

| 変異 | 種別 | 結果 |
|---|---|---|
| Fake の一致を、content の token を空白でつないだ文字列への `includes` に戻す | 足りない | core の歯 2 本赤、固定列の割れ 1 が赤 |
| testkit の語を token に割って別々の語にする（以前の形） | 足りない | testkit の歯 3 本赤、固定列の割れ 2 が赤 |
| testkit の `tokenize` が `_` を割らない | 足りない（アンダースコアで割らない） | testkit の歯 2 本赤（`foo_bar`×`bar`・`foo bar`×`foo_bar`） |
| Fake のクエリを空白に加えてハイフンでも割る | やりすぎ | core の歯 2 本赤（`proj x 12`×`PROJ-12`・`gamma`×`gamma PROJ-12`） |

- **日本語を割る変異は作れなかった**【未確認】。クエリの非 ASCII は落とすので、日本語は content 側にしか効かず、ASCII のクエリに対しては、日本語を 1 文字ずつ割っても結果が変わらない（ASCII の境界で既に割れる）。日本語の割り方を縛る歯は、fixture の側には持てない。

## 揃えていないこと（引き受けた負債）【実測】

Postgres の text search parser の細部は再現していない。次は fixture と Postgres が食い違う（fuzz の語彙には入れていない）:

- `-12`・`+12`・`-1.5` は符号付きの 1 token（`PROJ-12` は `proj`・`-12`）。content `proj 12` はクエリ `PROJ-12` に fixture は当たるが、Postgres は当たらない。クエリ `12` は content `PROJ-12` に fixture は当たるが、Postgres は当たらない。
- `a.b`・`user@example.com`・`x.com/a-b` は 1 token（クエリ `a` は content `a.b` に fixture は当たるが、Postgres は当たらない）。
- ハイフンで結んだ語（`hello-world`）は結合形と部品の両方が token になり、クエリ `hello-world` は content `hello, world` に fixture は当たるが、Postgres は当たらない（content に結合形が無い）。

| # | 負債 | 緊急度 | 覆る条件 |
|---|---|---|---|
| 1 | 上の parser の細部 | 低（識別子・数字をハイフンで結んだ語を検索する fixture の利用者に届く） | parser の分類（`word`／`numword`／`hword`／`int`／`host`／`email`）を再現するか、fixture を Postgres に当てる差分の表を持つとき |
| 2 | 日本語の trigram 側の相手が fixture に無い | 低 | ADR 0509 の負債 2 と同じ |

## 採らなかった案

1. **parser の細部（符号付きの数字、ホスト、メール、ハイフン結合語）まで再現する。** 採らなかった。分類が多く、再現の誤りが新しい食い違いを生む。依頼の 2 件（部分一致・分母）は、空白区切りの語＋隣接で足りる。
2. **testkit も Fake も、クエリの語を token に割らず、content を空白区切りの語と文字列で比べる。** 採らなかった。`foo_bar` は Postgres では `foo`・`bar` の 2 token で、content `foo bar` に当たる（実測の表）。
3. **Fake と testkit の共通の実装を 1 つにする。** 採らなかった。core の Fake は `@mnemora/testkit` を import できない（上限の定数も 3 箇所で手で揃えていて、値の一致は `lexical-query-cap-values-match` が見る）。実装は 2 つのまま、歯の表を同じにした。

## これが覆るとしたら

オーナーが「fixture は Postgres の parser の細部まで揃えるべき」と決めたとき（負債 1 を直す）。`mnemora_lexical_*` の関数（migration 0008・0009・0023・0025）が変わったとき（表を実測し直す）。

## 測っていないこと

CI の SQL_ASCII 脚での表の値（手元は UTF8 + C.UTF-8 だけ）。trigram の store の日本語側。`rank` の値（Postgres の `ts_rank_cd` とは尺度が違うので比べない。契約どおり）。fuzz の `channels` を 40 シードより多く回したときの割れ。

## 追記（Issue #1759。クローン miku の判断で見送り。オーナーの判断ではない）: ハイフンで結んだ語は、照合だけでなく coverage の数え方も割れる

上の「揃えていないこと」の3つ目（ハイフンで結んだ語）の差は、照合だけでなく、coverage（分母の数え方）にも出る。【実測】Postgres 17 + pgvector（`C.UTF-8`）、main `de41711c`。本文 `foo bar` と `uses foo-bar here` の2件に対する、`PostgresLexicalStore` と testkit の `InMemoryLexicalStore` の coverage:

| クエリ | Postgres（`foo bar`・`uses foo-bar here`） | fixture（同じ順） |
| --- | --- | --- |
| `foo-bar` | 当たらない・1 | 1・1 |
| `foo_bar foo-bar baz` | 0.33・0.67 | 0.5・0.5 |

Postgres は `foo-bar` を合成語（`foo-bar` と部品の `foo`・`bar`）として扱い、`foo_bar` とは別の tsquery にする（分母は3）。fixture は両方を同じ token 列 `foo bar` と見て1つにまとめる（分母は2）。

**揃えない。**クローン miku の判断（Issue #1759）。この ADR が「採らなかった案」1 で、parser の細部（ハイフン結合語）まで再現する案を採らなかったため。負債 1 に含める。振る舞いは変えていない。
