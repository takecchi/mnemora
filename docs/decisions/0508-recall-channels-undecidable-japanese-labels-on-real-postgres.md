# ADR 0508: `recall` の `channels` の合流のうち、`ann_truncated`（undecidable）・日本語の語彙・`labels` との組を、Fake と実 Postgres に同じ問いを当てて縛る（割れは見つからなかった。日本語だけ既知の非対称を歯にした）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（ADR 0220）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0484 は、`channels` の合流（和集合・`retrievedVia`・`score`・並び・trace）を実 Postgres の2つの語彙 store で縛り、`ann_truncated`（undecidable）・日本語の語彙・`labels` 等との組を「当てていない形」として core の歯⑦、trigram の既存の歯、`recall-filter-combination-parity.postgres.test.ts` に委ねた。この ADR は、その委ねた先が実際に何を縛っているかを読み、縛っていない組に歯を足す。**実装は変えていない（歯だけ）。**

## 1. 既存の歯が縛っている範囲【現物】

| 歯 | 縛っているもの | 縛っていないもの |
|---|---|---|
| core `recall-channels.test.ts` 歯⑦ | 語彙が走り ANN の窓が埋まると `undecidable`（Fake の1形だけ） | 実 Postgres、窓が埋まらないとき・ANN だけのときの「出ない」「undecidable にならない」側 |
| `recall-channel-merge.postgres.test.ts`（ADR 0484） | 合流（重複・`retrievedVia`・`score` の欄・trace・`lexical_truncated`）、2つの語彙 store | `ann_truncated`、日本語、`labels` |
| `recall-filter-combination-parity.postgres.test.ts` | ランダムな filter × channels を Fake と Postgres で突き合わせ。`omitted` も比べる | 語彙 store は tsvector だけ（trigram なし）。記憶の本文は ASCII だけ（日本語なし）。`lexical_truncated` が立った問いは比べない。ランダムなので「`ann_truncated` の窓が埋まる／埋まらない」境を狙って当てない |
| `trigram-lexical-store*.postgres.test.ts` | trigram store 単体（`search` の絞り・日本語・labels・閾値） | `recall` の合流を通した形 |
| `recall.postgres.test.ts` | `over_limit` と `ann_truncated`（`loss_possible` 側）が同時に出る | 語彙チャンネルとの組 |

## 2. 足した歯【実測】

`packages/postgres/src/__tests__/recall-channels-undecidable-japanese-labels-parity.postgres.test.ts`。**同じ記憶・同じ問いを、testkit の InMemory（Fake）、実 Postgres + tsvector、実 Postgres + trigram に当て**、記憶を内容で名指して返った集合・`omitted` の kind と `ann_truncated` の certainty を比べる（同点の並びは実装ごとに違う〔ADR 0170〕ので集合で比べる。top-1 が同点で割れうる問い〔`limit` を絞った形〕では `omitted` だけを比べる）。trigram が使えない環境（SQL_ASCII の脚）では、skip ではなく使えないことを主張して終える（ADR 0103・0319）。

1. **`ann_truncated`**:
   - `ann+lexical`・窓が埋まる（`kPrime = 1`）→ 3実装とも `certainty: "undecidable"`、`undecidableReason` が `ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE`。
   - やりすぎ側: 窓が埋まらない（`kPrime` が候補数より大きい）→ 出ない。`channels: ["lexical"]`（ANN が走らない）→ 出ない。
   - 対照: `channels: ["ann"]` で窓が埋まる → 語彙の理由では undecidable にならず、3実装が同じ判定。
2. **日本語の語彙**: 語彙だけが当てる日本語の記憶（「来週の定例会議の議題を共有した」を「定例会議」で引く）。
   - trigram は当てる。**tsvector は当てない。Fake も当てない**（Fake は tsvector 側に合わせてあり、CJK を語単位に割らない。fixture の doc）。`ann+lexical` の合流でも同じ。
   - 日本語 + `labels`（trigram）: `kPrime = 1` で、語彙だけが当てる記憶のうち `labels` に合う側が窓から押し出されない（絞りが語彙 store へ降りていること）。
3. **`labels` と channels**: 語彙だけが当てる記憶のうち、`labels: ["x"]` に合わないもの（別ラベル・ラベル無し）は入らず、合うものは入る。3実装が同じ。`labels` を渡さない対照では全部入る。`labels` を渡した `ann_truncated` の run でも undecidable が同じに出て、`omitted` が3実装で一致する。

## 3. 割れの有無【実測】

手元の PostgreSQL 17（`initdb`、UTF8 + C.UTF-8）+ pgvector。

- **約束との食い違いは見つからなかった。** Fake と実 Postgres の食い違いも、日本語を除いて見つからなかった。
- **日本語だけ、Fake と trigram が割れる**（Fake は空、trigram は当てる）。これは ADR 0084 §3.2・0319 の既知の非対称（trigram は opt-in で、Fake は tsvector 側を写す）であり、約束の食い違いではない。**歯は「この非対称が今も同じ向きであること」を縛る**（Fake が trigram 側へ動けば、または tsvector が日本語を引けるようになれば赤になる）。直すかは決めていない（Fake に trigram を写すのは testkit の設計の判断）。
- 歯を書く途中で赤くなったのは、**歯の側の作りの誤り**だった（同点の並びを順序つきで比べていた、`kPrime = 1` の語彙窓で `labels` に合わない記憶が窓を占めていた）。実装の割れではない。

## 4. 陽性対照（変異）【実測】

いずれも `packages/core/src/recall-runtime.ts` を `cp` で退避して変異し、新しいファイルだけを走らせ、`cp` で戻して緑を確かめた。

| 変異 | 赤になった歯 |
|---|---|
| `annWindowFilled && lexicalExecuted` の判定から `lexicalExecuted` を外す（語彙が走っても undecidable にしない） | undecidable の2本（`ann+lexical` の窓が埋まる形、`labels` を渡した形） |
| 同じ条件を `lexicalExecuted` だけにする（窓が埋まらなくても、ANN が走らなくても undecidable にする） | やりすぎ側の2本（窓が埋まらない形、`channels: ["lexical"]` の形） |
| 語彙チャンネルへ渡す `labels` の絞り（`LexicalFilter.labels`）だけを落とす | 日本語 + `labels`（trigram）、`labels` を渡した `ann_truncated` の `omitted` の一致 |
| 上に加え、runtime の後置の `survivesLabelsFilter` も常に真にする | 日本語 + `labels`（trigram）、`labels: ["x"]` の3実装一致 |

**3本目は注意に値する**: `LexicalFilter.labels` の降ろしを落としただけでは、`kPrime` に余裕のある問い（`labels: ["x"]` の3実装一致）は後置の `survivesLabelsFilter` が拾って緑のままだった。**`kPrime` が窓を絞る形では、後置だけでは足りず（窓が絞りに合わない記憶で埋まる）、降ろしが効く**。歯はこの形も持つ。

## 採らなかった案

1. **日本語の「語彙だけの記憶」を ASCII に置き換えて3実装の挙動を揃える。** 採らなかった。揃わないことが既知の非対称そのものなので、歯がそれを縛るほうが価値がある。
2. **ランダムな filter × channels の直積に trigram と日本語を足す。** 採らなかった。`ann_truncated` の「窓が埋まる／埋まらない」の境は、ランダムに当てると狙えない。決定的な問いのほうが、赤の理由が読める。
3. **Fake に trigram 相当の日本語の引き当てを足す。** 採らなかった。testkit の設計（Fake が何を写すか）の判断であり、歯だけの PR の外。

## 引き受けた負債

- 比べているのは返った集合と `omitted` の種類・certainty で、`score` の値ではない（`lexicalMatch` の尺度は store ごとに違う。ADR 0092・0319・0484 の負債1）。
- 日本語の語は1本の文面・1本の問いだけ。分かち書きの切れ目の違い（ADR 0084 の §3.2 以降）の網羅ではない。
- 実測は PostgreSQL 17、UTF8 の DB 1つ。SQL_ASCII の脚では trigram の歯は「使えないこと」を主張して終わる（走らせていない）。

## これが覆るとしたら

Fake の語彙の引き当てが trigram 側へ寄ったとき、または tsvector が日本語を引けるようになったとき（日本語の歯が赤くなる。歯の期待を直すこと）。語彙チャンネルが走った run の `ann_truncated` の扱いを変えると決まったとき（ADR 0084 §7・0069 の見直し）。

## 測っていないこと

SQL_ASCII の DB、大きなデータでの `kPrime` の効き方、実際の埋め込み provider での値、CI での走り。
