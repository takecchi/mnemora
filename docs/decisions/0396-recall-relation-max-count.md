# ADR 0396: 段3（多者間の同伴取得）の群ごとの上限を、`RecallQuery.relationMaxCount` で呼び出し側から変えられるようにする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30
- **PR**: Draft（Issue #1449 項目8。`Refs`、閉じない）

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> ADR 0381 §5.3・§6 の決定を下したのは「オーナー側クローン」であり、今回それを覆すと決めたのも同じクローン
> （オーナー本人ではない）。オーナー本人の確認は取っていない。

---

## 問い —— [Issue #1449](https://github.com/takecchi/mnemora/issues/1449) 項目8

recall 段3（`contradiction_resolution`）は、多者間の `contested` 群を `RelationStore.listRelated` で辿り、
**群ごとに10件まで**同伴として載せる。超えた分は `over_limit { stage: "relation" }` に積まれる。
この10は `DEFAULT_RECALL_ASSOCIATION.maxCount` の流用で、**呼び出し側からは動かせない**
（`RecallQuery.association.maxCount` は連想枠だけ。`RuntimeConfig` にも無い）。
[ADR 0381](./0381-contested-group-write-path-implementation.md) §7 負債4・5 は、これを負債として記録した。
**この上限を、呼び出し側から変えられるようにするか。**

## 決めたこと

### 決定1. 任意の欄 `RecallQuery.relationMaxCount?: number` を足す

- 群ごとの同伴の上限件数。省略すると従来の10。**省略した呼び出しの `recall()` の結果は1バイトも変わらない**
  （明示で `10` を渡した呼び出しとも同一——歯は `recall-relation-max-count.test.ts`）。
- 名前は `relationMaxCount`。既存の命名（`RecallAssociationQuery.maxCount`・`digestBandLimit`・`limit`）のうち、
  `omitted` の `stage: "relation"` と対応が付き、`association.maxCount` と取り違えにくいものを選んだ。
  `RecallQuery` の直下に置く1つの数であり、`relations?: { maxCount }` のような束ねた欄にはしない（決定4）。
- 数える対象・切る順（`validFrom` の新しい順→`id` の順）・owner を数えない規約は変えない。

### 決定2. 検証は「正の整数、1〜1000」

`z.number().int().positive().max(1000).optional()`。0 や負は「同伴を一切載せない」を意味しうるが、
それは `contested` を並べて出す約束（[docs/recall.md](../recall.md) §8）を破る使い方であり、この欄で許さない。
小数・`NaN` は件数として意味を持たない。
**上限1000の理由**: 決定3のとおり安全弁を欄の10倍に連動させるので、上限が無いと安全弁が実質無いのと同じになる
（`listRelated` を呼ぶ回数の上限が消える）。1000なら安全弁は1万件で頭打ちになる。
1000は測って置いた値ではなく【推論】であり、足りなければ別の ADR で上げる（下の【確かめていないこと】）。
`RecallAssociationQuery.maxCount` に上限が無いこと（`positive()` のみ）とは揃えなかった——段3は `listRelated` を
実際に呼んで辿るため、安全弁に連動する欄には頭打ちが要る、と判断した。

### 決定3. 探索の安全弁は、欄の10倍に連動させる

従来は `DEFAULT_RECALL_ASSOCIATION.maxCount * 10`（100件）で固定だった。次の3案を比べた。

| 案 | 判断 |
|---|---|
| **欄に連動（採用）** `relationMaxCount * 10` | 省略時は10×10=100で従来と同一。**指定した値が実際に効く**（下の【実測】: 群150件・`relationMaxCount: 20` で `exact`、安全弁は200） |
| 据え置き（100固定） | `relationMaxCount` が100を超えると、群の探索が100件で止まり、指定した値がどう頑張っても効かない（常に `lower_bound`）。欄の意味が壊れる |
| 別の欄（`relationVisitLimit`） | 欄が増える。北極星の問い2（無効にしても成立）・欄を増やさない方向に反する。10倍という倍率を呼び出し側が動かしたい根拠は今のところ無い |

副作用: `relationMaxCount` を下げると安全弁も下がる（3なら30件）。群がそれより大きいと `countKind: "lower_bound"` になる。
これは従来の「上限を超える巨大な群は下限しか言えない」と同じ性質で、**正直に言う側に倒れている**（黙って嘘をつかない）。

### 決定4. ADR 0381 §5.3・§6 の「専用のクエリ欄は作らない」を覆す

ADR 0381 は「`RecallQuery.relations?`（専用のクエリ欄）は作らない」と決め、§7 負債4・5 で上限を変えられないことを負債とした。
**今回覆す。理由:**

1. 北極星は「**どれだけ載せるかを、使う側が決められる**」を目指す姿の一つに挙げている。
   段3の10件は、連想枠の `maxCount`（呼び出し側が決められる）とは違い、決められない載せ方が1つ残っていた。
2. 問い1（「毎回渡す量を減らす方向に働くか。増やすなら、その分だけ想起が良くなると言えるか」）との兼ね合い。
   欄を足すこと自体は量を増やさない（**既定は10のまま**）。増やすかどうかは呼び出し側の選択であり、
   増やした側が引き受ける。逆に**下げる**（3など）ことも同じ欄でできる——量を減らす向きにも使える。
   「増やせば想起が良くなる」とは**言えない**（質の側は測れていない。下の【確かめていないこと】）ので、
   既定は動かさない。
3. 群が大きい状況で、対処が `resolveContestedGroup?` で群そのものを縮めることしか無いのは、recall の呼び出し側にとって
   手が遠すぎる（recall の量の話を、書き込み側の解消の話でしか直せない）。
4. **覆す範囲は狭い**: ADR 0381 が退けたのは `RecallQuery.relations?` という**独立したチャンネル**と、
   `RecallRelationQuery.maxCount` 相当の**束ねた欄**だった。今回足すのは、段3の既存の必須取得に対する**1つの数**だけで、
   段3を opt-in にする欄ではない（`relationStore` を配線して群が在れば、欄を渡さなくても従来どおり動く）。

`docs/recall.md` §8 と `omitted` の表・`over_limit(stage: 'relation')` の次の一手の「今日は無い」記述は、この ADR に合わせて直した。ADR 0381 の本文は書き換えず、末尾に本 ADR を指す追記を足した。

## 【実測】1-B の量の側（2026-09-30）

**測ったもの**: 群を含む recall の `usage.chars`・`estimatedTokens` と、`over_limit(relation)` の件数・`countKind` を、
群の大きさ × `relationMaxCount` で数えた。**鍵も DB も要らない**（core のテスト用 Fake ストアと決定的な埋め込み、
`recall-runtime` を実際に通す）。門ではない。

**再現**:

```bash
pnpm install --frozen-lockfile
MNEMORA_MEASURE_RELATION_MAX_COUNT=1 pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall-relation-max-count-measure.test.ts
```

道具は `packages/core/src/__tests__/recall-relation-max-count-measure.test.ts`。環境変数を付けなければ表は出ず、
**式**（同伴の数 = min(上限, 群-1)、切った数、`exact`/`lower_bound` の別）の検査だけが走る。`usage.chars` の値は
digest の長さで動くので、検査にも道具にも焼き込んでいない。`compare-baseline.json` など既存の基準値には触れていない。

**条件**: 群は全員が互いに重なる（`validFrom` だけ違う）記憶。digest は日本語20字前後の固定文。
`limit`・`budget` は既定。tenant にはその群の記憶しか無い。owner を ANN で1件拾う。
「同伴」は `retrievedVia: "mandatory_companion"` の件数（owner を含まない）。

以下は上のコマンドの出力を写したもの。

| 群の大きさ | relationMaxCount | 同伴 | over_limit(relation) | countKind | usage.chars | estimatedTokens |
|---:|---|---:|---:|---|---:|---:|
| 3 | 省略(=10) | 2 | 0 | - | 239 | 86 |
| 3 | 3 | 2 | 0 | - | 239 | 86 |
| 3 | 20 | 2 | 0 | - | 239 | 86 |
| 3 | 50 | 2 | 0 | - | 239 | 86 |
| 5 | 省略(=10) | 4 | 0 | - | 271 | 111 |
| 5 | 3 | 3 | 1 | exact | 304 | 119 |
| 5 | 20 | 4 | 0 | - | 271 | 111 |
| 5 | 50 | 4 | 0 | - | 271 | 111 |
| 10 | 省略(=10) | 9 | 0 | - | 353 | 175 |
| 10 | 3 | 3 | 6 | exact | 556 | 225 |
| 10 | 20 | 9 | 0 | - | 353 | 175 |
| 10 | 50 | 9 | 0 | - | 353 | 175 |
| 20 | 省略(=10) | 10 | 9 | exact | 827 | 379 |
| 20 | 3 | 3 | 16 | exact | 1074 | 439 |
| 20 | 20 | 19 | 0 | - | 513 | 302 |
| 20 | 50 | 19 | 0 | - | 513 | 302 |
| 50 | 省略(=10) | 10 | 39 | exact | 2359 | 1015 |
| 50 | 3 | 3 | 26 | lower_bound | 2604 | 1075 |
| 50 | 20 | 20 | 29 | exact | 2009 | 930 |
| 50 | 50 | 49 | 0 | - | 993 | 683 |
| 150 | 省略(=10) | 10 | 89 | lower_bound | 2999 | 1268 |
| 150 | 3 | 3 | 26 | lower_bound | 2887 | 1179 |
| 150 | 20 | 20 | 129 | exact | 3159 | 1395 |
| 150 | 50 | 50 | 99 | exact | 3638 | 1776 |

**読み取れること（【実測】の範囲）**:

- 省略の行は、`relationMaxCount: 10` の挙動と同じ式に従う（群10件まで切れない、20件で `over_limit` 9、150件は安全弁100で `lower_bound`）。
- 上限を上げると `over_limit` は減り、群が上限以下なら 0 になる（群20・上限20、群50・上限50）。
  下げると増える（群20・上限3で16）。安全弁は上限の10倍なので、群50・上限3は30件で止まり `lower_bound`、群150・上限20は尽きるまで辿って `exact`。
- **`usage.chars` は上限に対して単調ではない。**群20では上限3が1074、省略(10)が827、20が513と、上限を上げると `chars` が**減る**。
  この測定の tenant にはその群の記憶しか無く、同伴として載らなかった記憶は目次帯（`index`、`digestBand`）に digest だけで載る。
  同伴として載ると、目次帯側から外れる。同伴（digest に加えて score 等の欄を持つ）と目次帯（digest だけ）のどちらで載るかで1件あたりの文字数が違い、
  **合計は上限に単調に従わない**。実運用の tenant には群以外の記憶が多くあり、目次帯は件数上限で頭打ちになるため、同じ形にはならない。
  ⟹ **この表から「上限を上げれば文字数が増える／減る」とは言えない。**言えるのは、群を丸ごと載せた場合と切った場合とで、
  この条件では上の値だったことだけである。

## 【確かめていないこと】

- **質の側（上限を上げると想起が良くなるか）は測っていない。**測るには鍵（実 API の埋め込みと、答えを判定する LLM）が要り、この環境には無い。
  ⟹ 問い1の「増やすなら、その分だけ想起が良くなると言えるか」に、**この ADR は答えていない**。既定を動かさなかった理由の一つ。
- 上限1000は【推論】。実際の群の大きさの分布は見ていない。
- Postgres の実物では走らせていない。`recalls.query` は jsonb に `JSON.stringify` で書かれる既存の作りで（`packages/postgres/src/memory-store.ts` の `createRecall`）、
  新しい欄も数値1つがそのまま入る。core 側の歯（Fake ストア）は記録された `query` に指定値が残ることを見ているが、Postgres での書き込み・読み戻しの歯は足していない。
- 測定の tenant は群だけの合成データで、実運用の分布ではない。
- 別の Draft PR #1467（枝 `fix/1449-companion-order-and-group-winner-case`）が同じ `recall-runtime.ts` の段3（BFS の並べ替え）と ADR 0381 の末尾を触っている。
  本 PR は main から切り、安全弁の定義行・`slice` の行・コメントだけを触った。**マージの順で衝突しうる**（解くときは merge で、rebase しない）。

## 非破壊である根拠

[docs/migration-v1.md](../migration-v1.md) の数え方の規律に照らす。

- 型としては**任意の欄1つの追加のみ**。公開面の snapshot（`scripts/__snapshots__/public-api/core.d.ts`）の差分は追加2行
  （`RecallQuery` の `relationMaxCount?: number` と `RecallQuerySchema` の `relationMaxCount: z.ZodOptional<z.ZodNumber>`）で、削除行は0。
  `git diff origin/main -- CHANGELOG.md docs/migration-v1.md` の削除行も0（`docs/migration-v1.md` は触っていない）。
- 省略時の挙動は1バイトも変わらない（明示 `10` との同一を、群の大きさ3〜120件で歯に固定した。既存の段3の歯 `recall-relation-group-companion.test.ts` は無変更で緑）。
- 直近の先例と同じ形: `RecallQuery.scopeAggregate?`（[ADR 0384](./0384-digest-band-index-and-scope-aggregate-skip.md)、migration-v1.md が「新しい任意の欄1つの追加のみ」と書いている）。
- DB マイグレーションは伴わない。
- 新しい欄を**受ける側が変わる**ことに注意: 旧版の `RecallQuerySchema` は `.strict()` ではないので未知の欄を黙って捨てる。
  `relationMaxCount` を渡した呼び出しを旧版の `@mnemora/core` で走らせると、欄が無視されて10のまま動く（エラーにはならない）。

## 採らなかった案

- **`RecallQuery.relations?: { maxCount }`（束ねた欄、ADR 0292 決定2-b の形）**: 段3を opt-in のチャンネルとして扱う含みが出る。
  今回は段3の既存の必須取得の1つの数を動かすだけ。
- **`RuntimeConfig` の欄**: 呼び出しごとに変えられない。連想枠の `maxCount` も recall ごとの欄であり、揃えた。
- **`association.maxCount` を段3にも効かせる**: 連想枠と段3は別の枠で（`omitted` の `stage` も別）、片方を動かすともう片方が動くのは驚きになる。
- **上限なし（無制限を許す）**: 安全弁が実質消える。決定2。
- **既定を10から動かす**: 質の側が測れていない。

## 引き受けた負債

- 上限1000・安全弁10倍の倍率は【推論】の値。
- 質の側が未測定。この欄で上限を上げた呼び出しが、想起を良くするかは分からない。
- 安全弁が欄に連動するため、`relationMaxCount` を下げると `lower_bound` になりやすくなる。
- `RecallQuery.relationMaxCount` を持つ recall が `recalls.query` に残る。読み戻しの側（`reflect` など `recalls.query` を読む道具）がこの欄を知らなくても、未知の欄なので害は無い想定だが、読む道具を全部は確かめていない。

## これが覆るとしたら何が起きたときか

- 実運用で1000では足りない群が見つかったとき: 上限を上げる（安全弁の倍率の見直しとセット）。
- 質の側の実測で、上限を上げると想起が悪くなると分かったとき: 既定を下げる、または上限を下げる。
- 安全弁の倍率（10倍）を呼び出し側が動かしたい根拠が出たとき: 別の欄を検討する（決定3の「別の欄」）。
