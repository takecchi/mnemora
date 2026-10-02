# ADR 0537: ADR 索引の生成器は、番号で始まるのに ADR のファイル名の形から外れた `.md` を、無視せず例外で落とす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・文書の直し・前例のある同種の穴）の内側で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 見つけた穴【実測】

ADR 0534 を書いたとき、ファイル名を `0534-changelog-1.3.0-reconcile-….md`（slug にドット）にしたら、`node scripts/generate-adr-index.mjs` は「最新です」と出し、索引に載せず、警告も出さなかった（ADR の本数が1本少ないまま）。原因は【現物】`scripts/generate-adr-index-lib.mjs` の `ADR_FILENAME_RE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/` に当たらないファイルを、`buildAdrEntries` が黙って捨てること（ADR 0128 が「`TEMPLATE.md` のような非 ADR ファイルで歯が赤くならないように、ADR らしい名前だけを拾う」と決めた判断の副作用）。

直す前の実測（`docs/decisions/` に一時ファイル2本を置いて走らせ、後で消した）:

| 一時ファイル | 結果 |
|---|---|
| `9999-tmp-dotted-1.3.0-check.md`（ドット入り） | `generate-adr-index.mjs --check` は exit 0・「最新です（ADR 499 本）」。索引に載らない |
| `0001-tmp-dup.v2.md`（`0001` を名乗るドット入り） | 同上。**番号の重複の検査（Issue #315、`adr-duplicate-number.test.mjs`）からも漏れた** |
| 歯 | `GITHUB_REF=refs/heads/main` で `adr-index-freshness`・`adr-duplicate-number`・`generate-adr-index-lib` の3ファイルを走らせて 32 本とも緑 |

つまり、名前の形を間違えた ADR は、索引にも重複検査にも現れないまま、生成器も歯も緑で通る。

## 決定

**(b) 名前の形が外れていると、はっきり失敗させる**を採った。`buildAdrEntries`（生成器・freshness・duplicate-number の歯がすべて通る）が、**4桁の数字で始まる `.md`**（`/^\d{4}.*\.md$/i`）で `ADR_FILENAME_RE` に当たらないものを集め、あれば、ファイル名を並べた例外を投げる。

- **(a) ドットを許して数える、にしなかった理由**【判断】:
  1. 命名規約は ADR 0128 の `^\d{4}-[a-z0-9-]+\.md$`（4桁の番号 + 小文字英数字とハイフンの slug）で、`adr-renumber-lib.mjs` の `FILENAME_RE` も同じ形を使う。(a) にすると、生成器と renumber の2つの正規表現を揃えて広げ、リンクの書き方・`adr-citation` などの周辺も確かめる必要がある。規約を広げる積極的な理由が無い（ドットが要る slug は、版の番号を入れたいときくらいで、`-` に替えれば足りる。実際 ADR 0534 は `…-v1-2-0-tag.md` に改名して解決した）。
  2. 規約を広げるより、規約からの外れを検出するほうが小さく、既存のファイル名に影響しない。
- **誤って落とさない範囲**【判断・実測】: 番号で始まらない名前（`README.md`・`TEMPLATE.md`・`notes.txt`）と、番号で始まっても `.md` でないもの（`0002-x.txt`）は、今までどおり無視する（ADR 0128 の判断を残す）。`docs/decisions/` の全ファイルを新しい規則に通した【実測】: `node scripts/generate-adr-index.mjs --check` が exit 0（「最新です」）、番号で始まるのに形が外れているファイルは 0 件、`README.md` 以外の非 ADR ファイルも無い。
- **README の手引き**: `docs/decisions/README.md` の「一覧」の直前に、ファイル名の形（slug は小文字の英数字とハイフンだけ。ドット・大文字・アンダースコア不可）と、外れると例外で落ちることを1段落足した（文書の直し。規約自体は変えていない）。
- `adr-renumber.mjs` は `isAdrFilename` で絞る形のままで、形の外れたファイルを黙って対象外にする。ここは変えていない（renumber は PR で追加された ADR を番号替えする道具で、形の外れたファイルは生成器の側で先に落ちる）。【未確認】renumber が形の外れたファイルを見たときの挙動。

## 歯と変異試験

- `scripts/__tests__/generate-adr-index-lib.test.mjs` に4本（ドット入りで落ちる、重複を名乗るドット入りで落ちる、大文字・アンダースコア・ハイフン無しで落ちる、`README.md`・`TEMPLATE.md`・`notes.txt`・`0002-x.txt` は無視される＝陰性対照）。直す前の `buildAdrEntries` は3本のドット入り等の入力を黙って通した。
- 変異: `if (malformed.length > 0)` を無効にすると、3本が赤、陰性対照は緑のまま。戻した後は 30 本とも緑。
- 実ファイルの配線: `docs/decisions/` に一時ファイル（ドット入り）を置いて生成器を走らせると exit 1、`adr-duplicate-number`・`adr-index-freshness` の歯も赤になる（消して緑に戻ることを確かめた）。

## 検討した代替案

1. **(a) ドットを許す**。上のとおり採らなかった。
2. **生成器だけでなく `isAdrFilename` 自体を変える**。採らなかった。`isAdrFilename` は「形が正しいか」の純関数で、renumber も使う。外れの検出は一覧を見る `buildAdrEntries` に置いた。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | `adr-renumber.mjs` が形の外れたファイルを黙って対象外にする | 低 |
| 2 | `/^\d{4}.*\.md$/i` は「番号で始まる」だけを見る。番号で始まらない形の誤り（`adr-0538-x.md`）は検出しない | 低 |

## これが覆るとしたら

ADR のファイル名にドット等を許すと決めたとき（`ADR_FILENAME_RE`・`adr-renumber-lib.mjs` の `FILENAME_RE`・この検出を揃えて変える）。
