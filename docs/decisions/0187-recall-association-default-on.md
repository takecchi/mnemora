# ADR 0187: `packages/core` の `recall()` は連想枠を既定 on にする — `DEFAULT_RECALL_ASSOCIATION`、`null` を明示的な opt-out にする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0151 / 0166 / 0168 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた（`packages/core`/`packages/postgres`/`examples/chat` の typecheck・対象ファイル限定の vitest。DB・compare ベンチ・実 API は含まない——「確かめていないこと」参照）。
- **【伝】** — マネージャー経由の作業指示・オーナーの決定として伝達された。書き手はこの ADR の範囲では逐語を検証していない。
- **【受】** — 他の ADR・issue から引用し、再導出していない。出所を明記する。

---

## 結論（先に）

**`packages/core` の `recall()` が持つ連想枠（段3.5、ADR 0151）の既定を off から on に反転する。**

| 決めたこと                       | 内容                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 既定値                           | `RecallQuery.association` を**省略**すると `DEFAULT_RECALL_ASSOCIATION = { maxCount: 10 }` が適用される                                                                    |
| 型                               | `RecallQuery.association` の型を `RecallAssociationQuery` から **`RecallAssociationQuery \| null`** に広げる                                                               |
| 明示的な off                     | `RecallQuery.association: null` を渡すと、連想は一切走らない（ADR 0151 以前の挙動そのもの）                                                                                |
| `maxCount: 10` の性格            | **根拠のある確定値ではない。**いまの時点で最も根拠のある仮値（下記「`maxCount: 10` を仮に置いた理由」）                                                                    |
| `RecallUsage.byTier.association` | 存在条件が「`association` を渡したか」から「連想を実際に走らせたか（＝ `null` で止めていないか）」に変わる。既定の呼び出しでも欄が現れる                                   |
| `examples/chat`                  | `mnemora-path.ts` 独自の `DEFAULT_MNEMORA_PATH_ASSOCIATION`（ADR 0168）を廃止し、`packages/core` の既定をそのまま継ぐ（下記「なぜ `examples/chat` の独自既定を外したか」） |
| `estimateRecallFootprint`        | `RecallFootprintShape.associationCount` の既定は **`0` のまま据え置く**（下記「footprint の既定を動かさなかった理由」）                                                    |
| 破壊性                           | **破壊的変更である。**4点（下記「破壊的変更」）                                                                                                                            |
| マージ                           | **この PR は draft のまま止める。マージしない。**下記「Issue #337・roadmap.md §7.12 との関係」を必ず読むこと                                                               |

---

## 背景 — なぜいま既定 on を実装するか

**この決定はマネージャーの作業指示として着手した**【伝】。書き手が自分の判断でこの変更の是非（「既定 on にすべきか」自体）を発案したものではない——その判断は北極星の問い1・問い2の再検討を要する製品判断であり、`docs/autonomy.md` §3.1 の「どちらを選んでも技術的には成立するが、選び方が製品の性格を決める」に当たる。**この ADR が担うのは「決まった方向を、型と実装にどう落とすか」であり、「既定 on にするかどうか」ではない。**

---

## ADR 0151 が既定 off を選んだ理由と、この ADR の扱い方

[ADR 0151](./0151-recall-association-unprompted.md) は「北極星の問い1に当てた結果」節で、連想枠を通すために3条件を付けたと明記している【現物】:

> ①**既定 off**（明示しない呼び手の量は1バイトも増えない）②**予算の内側**（`usage` が嘘をつかない）③**予算で最初に落ちる**（クエリで引けたものを押し出さない）

「採らなかった案」の表も、逐語で「連想を既定 on にする」を落としている【現物】:

> **連想を既定 on にする** | **問い1・問い2** | 明示していない呼び手の焼く量が黙って増える。かつ「切っても成立する」が「切る口が無い」に変わる

**⟹ 本 ADR は、ADR 0151 が問い1・問い2で明示的に落とした案を、いま採る。**この衝突を無かったことにしない。

- **問い1（毎回渡す量を減らす方向に働くか）**: **この ADR は問い1を通っていない。**「明示しない呼び手の量が増える」という、ADR 0151 がまさに問題視した状態そのものを、この ADR は作る。北極星の問いに照らして正面から答えるなら、**この変更は問い1に反する。**それでも進める理由は、書き手の技術的判断ではなく、マネージャー経由の作業指示【伝】である——下記「Issue #337・roadmap.md §7.12 との関係」で、この指示の出所と、それでもなお残る緊張を明記する。
- **問い2（無効にしたとき Memory Framework として成立するか）**: **この ADR は問い2を守る形を保つ。**ADR 0151 は「既定 off」で問い2を担保していたが、この ADR は担保する**手段**を「`null` という明示の opt-out」に乗り換える——`association: null` を渡せば、連想は一切走らず、`VectorStore.getVectors` を実装しない adapter でも `recall()` は動く（この性質自体は変えていない）。**⟹ 「切っても成立するか」は保たれるが、「切る」がいまや既定ではなく呼び手の明示的な行為になる**——ADR 0151 自身が「採らなかった案」で書いた「『切っても成立する』が『切る口が無い』に変わる」の**後半（切る口が無い）は起きていない**（`null` という口は在る）が、**前半に近い緊張（既定の挙動として切れていない）は残る。**

---

## Issue #337・`docs/roadmap.md` §7.12 との関係（⛔ なかったことにしない）

**この節が本 ADR でいちばん重要な節である。**

`docs/roadmap.md` を読むと、次の記録がある【現物】(`git show origin/main:docs/roadmap.md` を実際に読んだ。以下は逐語の引用):

1. **[Issue #337](https://github.com/takecchi/mnemora/issues/337)** は「連想枠を既定 on にするかを10万行級で測ってから判断する」というオーナー決定の記録である。issue 本文の逐語:

   > 連想枠（association frame）を**既定 on にするかどうかは、10万行級の規模で測ってから判断する**。
   > 逐語: 「10万行級で測ってから既定 on をやるか判断してほしいです。」
   > したがって **v1.0 では既定 off のまま**（ADR 0151 の opt-in を維持）、採用側が明示して使う形で出す。

   本稿執筆時点で、この issue は **OPEN** のままである。

2. `docs/roadmap.md` §7.4「項目2 を『在る』と数えなかった理由」の3択の表は、**(い)（`packages/core` の既定を on にする）を「⛔ 塞がれている」と明記している**——根拠は Issue #337 そのもの。

3. `docs/roadmap.md` §7.12「v1.0.0 をどう切るか」は、オーナーが 2026-09-16 に**「(A) = 項目2は『半分』のまま v1.0.0 を出す」**を選んだと記録している（逐語「Aでお願いします。」）。同節は「項目2 が『半分』である理由は、そのまま生きている」とも明記し、その理由1番目に「出荷物の既定が反対を向いている」（＝ `packages/core` の既定が off のまま）を挙げている。

**⟹ 字義どおりに読めば、本 ADR が実装する変更（`packages/core` の既定を on にする）は、Issue #337 が名指しで「塞がっている」と書いた道そのものであり、roadmap.md §7.12 がオーナー決定として記録した v1.0.0 の姿（項目2は半分＝既定off のまま）とも正面から食い違う。**

**この食い違いを、書き手は次のように扱った**:

1. **マネージャーから、この実装に着手する指示を受け、その後の訂正指示で「オーナー（クローン）に確認を取って承認済みである」という趣旨の伝達を受けた**【伝】。書き手はこの承認の**逐語**を自分の手で確認していない——`gh issue view 337`/`docs/roadmap.md` を直接読んだのは書き手自身だが（【現物】、上記1〜3）、**Issue #337 側にこの承認を裏付ける新しい追記は無い**（本稿執筆時点、【現物】確認）。roadmap.md §7.12 にも新しい追記は無い。⟹ **この ADR の実装の正当性は、マネージャー経由の伝達にのみ依拠しており、Issue #337・roadmap.md 側の記録とは整合していない状態のまま進めている。**
2. **だからこそ、この PR は draft のまま止め、マージしない。** CI が緑になっても、マネージャーの合図を待つ。これは「6つの門」を満たしたら即マージしてよいという `docs/autonomy.md` §2 の既定の運用を、**この ADR に限り意図的に踏み外している**——理由はこの節に書いたとおり、Issue #337・roadmap.md §7.12 という2つの記録済みのオーナー決定と、実装の指示が字面のまま整合していないためである。
3. **この ADR は、Issue #337 を close しない。roadmap.md §7.12 の記述も書き換えない**（`AGENTS.md` の「正典と実装が食い違ったら、バグなのは実装のほう」「方向そのものを変えるときだけ書き換える。その変更はオーナーの判断である」に従う——ここで食い違っているのは実装と実装ではなく、**実装（この PR）と、記録済みの2つの決定**であり、決定側を実装に合わせて書き換える権限は書き手には無い）。
4. **Issue #337 が要求する「10万行級の測定」は、この ADR の範囲では行っていない。**`maxCount: 10` の根拠は、引き続き `association-probes` ベンチの `haystackSize = 62`（HNSW が使われない規模）の実測のままである（下記「`maxCount: 10` を仮に置いた理由」）。⟹ **この ADR は、Issue #337 が要求する測定を代替していない。**

**⟹ 本 ADR が主張するのは「実装として妥当な形を作った」ことまでである。「この実装を出荷してよい」の判断・「Issue #337 を解いた」の主張は、この ADR の範囲外であり、マネージャー・オーナー側の判断に委ねられている。**

---

## `maxCount: 10` を仮に置いた理由

**根拠のある選択ではない。**いまの時点で利用可能な実測のうち、最も条件が近いものを暫定的に採用した。

`examples/chat` の `association-probes` ベンチ（ADR 0158/0167 で器の非決定性を直した後の実測、Issue #291 の 2026-09-16 コメント。`haystackSize = 62`）【受】:

| arm              | 連想でしか届かない gold の到達 | `memoryChars` |
| ---------------- | ------------------------------ | ------------- |
| off              | 0/12                           | 基準          |
| on `maxCount=3`  | 9/12                           | +1.44%        |
| on `maxCount=5`  | 10/12                          | +2.22%        |
| on `maxCount=10` | **12/12**                      | **+4.32%**    |

**`maxCount=10` は、この実測で「12件中12件に届く」唯一の値である**（ADR 0168 の分析をそのまま引く【受】）。`maxCount=5` は 10/12 に留まり、**実測では 10 より劣ると分かっている値である。**

**⚠ この実測には、Issue #337 自身が指摘する重大な限界がある**【受、Issue #337 本文より逐語】:

> **このベンチの規模では HNSW 索引が一度も使われない。** … つまり上の表は「索引を使わない領域での費用対効果」であって、実運用で想定される領域（ADR 0111 が言う10万行級、HNSW が自然に選ばれる規模）の数字ではない。

**⟹ `maxCount: 10` は「小規模・索引未使用の領域で唯一 gold 全件に届いた値」以上の主張を持たない。**10万行級での再測定（Issue #337 が要求するもの）は、この ADR の範囲では行っていない。**いま2本の測定が独立に走っている**【伝、マネージャーからの伝達】——その結果でこの値が変わりうる。変えるときに直す箇所は下記「`maxCount` を変えるとき直す箇所」を参照。

---

## 決めたこと

### 1. `DEFAULT_RECALL_ASSOCIATION` を新設する

`packages/core/src/recall.ts` に次を追加した（`RecallAssociationQuery`/`RecallAssociationQuerySchema` の直後、`DEFAULT_ASSOCIATION_ANCHOR_COUNT`/`DEFAULT_ASSOCIATION_MIN_SIMILARITY` と同じ並び）:

```ts
export const DEFAULT_RECALL_ASSOCIATION: RecallAssociationQuery = {
  maxCount: 10,
};
```

**値がコード中に散らばらないよう、`anchorCount`/`minSimilarity` は上書きしない**——それぞれ既存の個別既定（`DEFAULT_ASSOCIATION_ANCHOR_COUNT` = 3、`DEFAULT_ASSOCIATION_MIN_SIMILARITY` = 0.5）に委ねる。`maxCount` を変える判断と、この2値を変える判断は独立であるべきで、1つの定数にまとめると独立性が失われる。

### 2. `RecallQuery.association` の型を広げ、`null` を明示的な opt-out にする

```ts
// 旧
association?: RecallAssociationQuery;
// 新
association?: RecallAssociationQuery | null;
```

zod 側も `RecallAssociationQuerySchema.optional()` から `RecallAssociationQuerySchema.nullable().optional()` へ広げた。**`null` と `undefined` は zod のパースを通っても区別される**——歯で固定した（`packages/core/src/__tests__/recall.test.ts`「`RecallQuerySchema` — association: null と undefined の区別」、`packages/core/src/__tests__/recall-association.test.ts` の実行時レベルの歯、下記「歯」参照）。

`recall-runtime.ts` の段3.5 は、実行時に次の形で解決する:

```ts
const associationQuery =
  validatedQuery.association === null
    ? undefined
    : (validatedQuery.association ?? DEFAULT_RECALL_ASSOCIATION);
```

**`undefined`（省略）と `null`（明示）を、実行時に異なる扱いにする——これが北極星の問い2を型で担保する部分である。**

### 3. `RecallUsage.byTier.association` の存在条件を、実際に走らせたかどうかへ揃える

**変えていないもの**: `byTier.association` の実装コード自体（`associationQuery !== undefined` の判定式）は1文字も変えていない。**変わったのは `associationQuery` の作られ方（決定2）であり、判定式が指す意味が変わった。**

- ADR 0151 時点: `associationQuery !== undefined` ⟺ 「呼び手が `association` を渡したか」
- 本 ADR 以降: `associationQuery !== undefined` ⟺ 「連想を実際に走らせたか（＝ `null` で明示的に止めていないか）」

⟹ **既定の呼び出し（`association` を省略）でも、`byTier.association` 欄が現れるようになる。**これが破壊的変更の1つである（下記）。

### 4. `examples/chat` の独自既定を廃止し、`packages/core` の既定を継がせる

`examples/chat/src/mnemora-path.ts` の `DEFAULT_MNEMORA_PATH_ASSOCIATION`（ADR 0168 が導入、`{ maxCount: 10 }`）を削除した。`queryRecall` は `opts.association` を `packages/core` へそのまま素通しする:

```ts
return runtime.recall(ctx, {
  text: conversation.query,
  ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  ...(opts.association !== undefined ? { association: opts.association } : {}),
});
```

**理由（マネージャーの訂正指示より）**【伝】: 「⭐門（`compare` ベンチ）は、`examples/chat` が独自の既定値を明示で渡していたせいで、『出荷される既定』を一度も測っていなかった。継がせれば⭐門はこれ以降ずっと出荷される既定を測る。」——`docs/roadmap.md`/[Issue #284](https://github.com/takecchi/mnemora/issues/284) の数え方の規律（本番から呼ぶ経路が無ければ「在る」と数えない）を、**門にも当てる**という考え方である。

`association: null` による opt-out 経路はそのまま残した——`compare`/`association-arm.ts` など、連想枠を明示的に止めて測りたい呼び手のための脱出口は生きている。

**値そのものは変わらない**（`packages/core` の既定も `examples/chat` の旧既定も、どちらも `maxCount: 10`）ため、**⟹ `examples/chat` の実際の挙動（`compare` の出力を含む）は、この決定単独では変わらないはずである。**下記「測ったこと」を参照。

### 5. `estimateRecallFootprint` の `associationCount` の既定は `0` のまま据え置く

`RecallFootprintShape.associationCount` の既定（省略時 `0`）は、ADR 0166 が定めたときのまま変えていない。

**検討した2案**:

**案A（採った）: `0` のまま据え置く。**

- **理由1（既存原則との整合）**: `recall-footprint.ts` の設計原則は「`packages/core` は呼び出し側にしか無い値を推定しない」である（`fullLogChars` と同じ扱い）。`associationCount`（実際に本体へ昇格する件数）は、ANN の近傍分布・`minSimilarity` の閾値に依存し、`maxCount` や `memoryCountInScope` だけからは決まらない——ADR 0166 が「これは `association.maxCount` ではない」と明記した理由そのものである【現物、`recall-footprint.ts` の doc】。**`maxCount`（＝ `DEFAULT_RECALL_ASSOCIATION.maxCount`）をそのまま `associationCount` の既定に流用すると、この原則を自ら破ることになる**——「試みる上限」を「実際に起きること」の代わりに使うのは、この関数がまさに避けようとしている種類の推測である。
- **理由2（過大評価より過小評価を選んだ）**: `associationCount` を渡さない呼び出しの見積もりは、`recall()` の既定が on になった今、**実態を過小評価する方向にのみ倒れる**（構造上の上限があるため過大評価にはならない。`packages/core/src/recall-footprint.ts` の該当 doc 参照）。過小評価は「mnemora のほうが軽い」という判定に有利に働く方向であり、**`compareWithFullLog` の判定を安全側に倒す**（実際より安く見えることはあっても、高く見えることはない）。過大評価（例えば `maxCount` をそのまま使う）を選んでいたら、逆に「実際には安いのに高く見える」ケースが生まれ、mnemora を不当に不利に見せる方向の誤りになっていた——**どちらの過誤も無いわけではないが、実測で裏付けられない値を新しく導入するより、既存の原則を守るほうを選んだ。**

**案B（却下）: 既定を `DEFAULT_RECALL_ASSOCIATION.maxCount` に合わせる。**

却下理由:

1. 上記「理由1」のとおり、ADR 0166 が明示的に避けた推測（`maxCount` を実際の昇格件数の代わりに使う）を、既定値の形で持ち込むことになる。
2. `association-probes` ベンチの実測（12件の probe、`maxCount=10`）でも、実際の昇格件数は 0〜10件で**単調でも一定でもない**（アンカーの近傍分布に依存する）——「`maxCount` を既定にすれば少なくとも実態に近づく」という主張自体が成立しない。
3. `RecallFootprintShape.associationCount` の doc は既に「これは `maxCount` ではない」と繰り返し警告している——既定値を `maxCount` に合わせると、この警告と既定値が矛盾した顔になる。

**⚠ 選ばなかった側の危険（案Bを選ばなかったことの代償）**: `associationCount` を省略した呼び出しの見積もりは、**`RecallQuery.association: null` で明示的に連想を止めた場合を除き、実際より小さく出る。**呼び出し側が `estimateRecallFootprint`/`compareWithFullLog` だけを見て「mnemora のほうが軽い」と判定し、実際に `recall()` を呼ぶと（連想が既定で走るため）それより高くつく、という食い違いが起きうる。**この危険は、doc コメントで明示する形で緩和した**（案Aを採ったこと自体は変えていない）。

### 6. 既定 on の影響で顕在化した歯を、対象外の効果を切り離す形で直した

**packages/core**: 既存の3つのテスト（`recall-channels.test.ts` 2件、`recall-pipeline.test.ts` 2件）が、既定 on によって連想枠がアンカー近傍の候補を拾うようになったため失敗した。いずれも「連想枠とは無関係な対象を検査するテスト」であり、`association: null` を明示して対象外の効果を切り離した。1件（JSON 全体一致の歯）は `byTier.association: 0` を期待値に追記した。

**packages/postgres**: `recall.postgres.test.ts` の9箇所に、同じ理由で `association: null` を追加した（DB が無くこの効果を実行時に確認できていない。下記「確かめていないこと」）。

**🔴 副次的に見つけた、この ADR の範囲外の事実**: `recall-pipeline.test.ts` の `score_not_comparable`（NaN 三分割）の歯が、既定 on にした結果、連想枠経由で NaN スコアの候補が `memories` に混入することで壊れた。**原因を追うと、連想枠の候補選定（`recall-runtime.ts` の段3.5）は、段2が持つ `score_not_comparable` の判定（比較不能な候補を弾く）を経由しない**——連想は生のコサイン類似度（`minSimilarity`）だけで候補を選び、`defaultScoringStrategy` の結果が `NaN` になりうる候補（例: `halfLifeHours: 0` かつ経過時間ちょうど0）でも素通しする。**既定が off だったときは、この経路を自分から選んだ呼び手しか踏まなかったため顕在化していなかった。**この ADR ではこの歯を `association: null` で対象外にしただけで、**この gap 自体は直していない**——`docs/autonomy.md`「ついでに直さない」規律に従い、別途 issue 化が必要な事実として「引き受けた負債」に記録する。

---

## 破壊的変更

**この ADR は `@mnemora/core` の公開 API を破壊的に変更する。**`docs/autonomy.md` §3 のとおり、オーナーが「公開 API の破壊的変更も、ADR を書けば実装してよい」と既に許可している（ADR 0156）が、**記録しないでよいという意味ではない**——[Issue #342](https://github.com/takecchi/mnemora/issues/342) が「破壊的変更が根拠 ADR に破壊性の記載が無いまま着地した」事例を2件見つけている。同じ穴をここで繰り返さない。

| #   | 変更                                                                                                                                                                       | 誰が影響を受けるか                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`RecallQuery.association` を省略した呼び出しの挙動が変わる。**これまでは「1バイトも変わらない」（ADR 0151）だったが、既定で連想枠が走るようになる。                      | `@mnemora/core` の `recall()`/`Runtime.recall()` を呼ぶ**全利用者**。載る文字数・費用が増える方向（下記「採用者に何が起きるか」の数字を参照）                                                                                                          |
| 2   | **`RecallQuery.association` の型が `RecallAssociationQuery` から `RecallAssociationQuery \| null` に広がった。**                                                           | 網羅的に型を扱っている利用者・`association` を独自に構築しているコード（TypeScript のコンパイルは通常は壊れない——広げた側なので、既存の非 `null` な値を渡すコードはそのまま通る。壊れうるのは `RecallQuery` を厳密な代入可能性でチェックしている場合） |
| 3   | **`RecallUsage.byTier.association` の存在条件が変わった。**以前は「`association` を渡したかどうか」、いまは「連想を実際に走らせたか（`null` で明示的に止めていないか）」。 | `byTier` の形を厳密に検査している利用者（キー集合の比較、網羅的な分岐など）                                                                                                                                                                            |
| 4   | **既定の呼び出しで、載る量と費用が増える。**`association-probes` ベンチの実測（`maxCount=10`、出所 ADR 0168）では `memoryChars` **+4.32%**。                               | `@mnemora/core` の `recall()` を明示せず呼ぶ全利用者。**「使う側が会話ログを全部積むのをやめられたか」という北極星の物差しに対して逆方向**に働く変更である——量を増やす                                                                                 |

**この4点は `CHANGELOG.md` の `[1.0.0] - 未リリース` 節の Breaking 表にもそのまま転記した**（重複ではなく、`AGENTS.md`「反重複規律」に対する意図的な例外——CHANGELOG は利用者が最初に見る場所であり、ADR への参照だけでは Issue #342 と同じ穴を繰り返す）。

**⚠ 誰が壊れうるかの実測**: `retrievedVia` の union 拡張（ADR 0151）のときと異なり、**今回は `switch`/`never` による網羅性チェックが直接壊れる形の変更ではない**（`association` は入力側の型であり、`RecallQuery` を厳密なリテラル型として扱っていない限りコンパイルは通る）。**実害が出るのは主に実行時**（上記1・3・4）であり、型エラーとしては現れにくい——**この非対称は、利用者が気づきにくいという意味で、通常の「型が壊れる」破壊的変更より危険度が高い可能性がある。**

---

## 検討して採らなかった案

| 案                                                                                                         | 却下理由                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`maxCount` の仮値を `5` にする**（当初のマネージャー指示）                                               | **撤回された**【伝】。ADR 0168 の実測で `maxCount=5` は 10/12 に留まり、`maxCount=10`（12/12）より明確に劣ると分かっている。根拠の無い値を置くなら、根拠が「相対的に強い」ほうを置くべきという判断——マネージャーが訂正した                                                                                                                                           |
| **`association` の opt-out を `null` ではなく専用のブール欄にする**（例: `associationDisabled?: boolean`） | 却下。`examples/chat/src/mnemora-path.ts` が既に `association: null` を opt-out の語彙として使っており（ADR 0168）、`packages/core` 側の語彙をそれに揃えるほうが一貫する。新しい欄を1つ増やすと `association` と `associationDisabled` の間に矛盾した組み合わせ（例: `association: {...}, associationDisabled: true`）が生まれ、防ぐための追加のバリデーションが要る |
| **`RecallFootprintShape.associationCount` の既定を `DEFAULT_RECALL_ASSOCIATION.maxCount` に合わせる**      | 却下（上記「決めたこと」5番で詳述）。ADR 0166 の「呼び出し側にしか無い値を推定しない」原則を破る                                                                                                                                                                                                                                                                     |
| **`examples/chat` の独自既定（`DEFAULT_MNEMORA_PATH_ASSOCIATION`）を残す**                                 | 却下（マネージャーの訂正指示）【伝】。⭐門が「出荷される既定」を一度も測っていない状態を放置することになる                                                                                                                                                                                                                                                           |
| **既定 on にせず、`examples/chat` だけが明示する現状（ADR 0168 の道1）を維持する**                         | この ADR の射程外——採るかどうかを決めたのはマネージャー経由の指示であり、この ADR はその決定を実装する側である。ADR 0151/Issue #337 が問い1・問い2で示した懸念は「背景」節・「Issue #337・roadmap.md §7.12 との関係」節にそのまま残した                                                                                                                              |
| **Issue #337 の10万行級測定を待ってから実装する**                                                          | 採らなかった——マネージャー指示は「いま実装し、draft のまま測定結果を待つ」という順序だった【伝】。実装を先に作っておくことで、測定結果が出た時点で `maxCount` を1箇所直すだけで追随できる（下記「`maxCount` を変えるとき直す箇所」）                                                                                                                                 |

---

## `maxCount` を変えるとき直す箇所

**機能上、変えるべき箇所は1つだけである**: `packages/core/src/recall.ts` の `DEFAULT_RECALL_ASSOCIATION` の定義（本稿執筆時点で1384行目、`maxCount: 10,`）。

**ただし、値を記述した doc コメント・文書・基準値ファイルは複数箇所に散らばっている**（`grep -rn "maxCount: 10\|maxCount=10"` で本稿執筆時点に実際に数えた。行番号は今後の編集で動きうる）:

### コード側（機能に影響しないが、値を明記した doc コメント）

| ファイル:行                              | 内容                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/core/src/recall.ts:1384`       | **`DEFAULT_RECALL_ASSOCIATION` の定義そのもの（機能上ここだけ直せばよい）**        |
| `packages/core/src/recall.ts:1369, 1371` | `DEFAULT_RECALL_ASSOCIATION` の doc コメント（仮値であることの説明・実測値の引用） |

### 文書側（値の記述。人間向けの説明であり、直さなくても壊れないが古くなる）

| ファイル:行                                 | 内容                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/README.md:82, 108, 118, 123` | 連想枠の使い方の説明・実測値                                                                                                                                                                                   |
| `docs/recall.md:826`                        | §9.5 予算の節、仮値であることの注記                                                                                                                                                                            |
| `docs/migration-v1.md:42, 48`               | v1.0.0 で予定されている変更の説明（本 ADR が新設した節）                                                                                                                                                       |
| `CHANGELOG.md:66, 69, 76, 145`              | `[1.0.0]` Breaking 表2件・`examples/chat` の Changed 項目・`[0.2.0]` の既存項目（**最後の145行目は `0.2.0` の historical な記述であり、書き換えないこと**——当時 `examples/chat` だけの既定だった事実の記録）   |
| `examples/chat/README.md:668, 671, 672`     | 本 ADR が追記した節（`635, 661` は ADR 0168 時点の historical な実測記録であり、書き換えないこと）                                                                                                             |
| `docs/decisions/0187-...`（この ADR 自身）  | 「`maxCount: 10` を仮に置いた理由」節、破壊的変更の表。**値が変わったら、この ADR 自体は書き換えない**——ADR 0168 が ADR 0187 に対して行ったのと同じ形で、新しい ADR（またはこの ADR への追記）が変更を記録する |

### 歯・基準値（実測に依存するため、値を変えたら実測し直す必要がある）

| ファイル                                                                                                | 内容                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples/chat/compare-baseline.json`                                                                   | **本 PR の項目6（マネージャー指示により保留中）。**`maxCount` を変えたら CI の `example-chat` ジョブを再実行し、artifact から基準値を作り直す（ADR 0121/0133 の作法。手で数値を書かない）                                                     |
| `examples/chat/src/__tests__/recall-footprint-baseline.test.ts`                                         | `compare-baseline.json` から `associationCount` を逆算する歯（ADR 0166 決定5）。`compare-baseline.json` が変われば連動して動く。手で直す箇所ではない                                                                                          |
| `packages/core/src/__tests__/recall-association.test.ts` / `packages/core/src/__tests__/recall.test.ts` | **本稿執筆時点では `maxCount` の具体値をハードコードしていない**（`byTier.association` の有無・`0`/非0 だけを検査する設計にした——値の変更に対して脆くならないよう意図して避けた）。⟹ **`maxCount` を変えても、この2ファイルは直す必要が無い** |

**⟹ 合計: 機能上1箇所（`recall.ts:1384`）。値を明記した doc コメント・文書が本稿執筆時点で概ね13箇所（上記の行数の合計）。基準値ファイル1本（`compare-baseline.json`、CI 実測で作り直す。手で数値を書く箇所ではない）。歯は意図して値に依存しない設計にしたため0箇所。**

---

## 採用者に何が起きるか（数字で）

**⚠ 「増えます」ではなく数字で書く。**

- **載る文字数・費用**: `association-probes` ベンチ（probe 12件、`haystackSize=62`、実 Postgres + pgvector、`MNEMORA_EMBEDDING=local`）の実測【受、ADR 0168・Issue #291 の 2026-09-16 コメントより引用】: `maxCount=10` で `memoryChars` **+4.32%**（対 off 基準）。同じ規模で `maxCount=3` は +1.44%、`maxCount=5` は +2.22%。
- **想起の質（gold 到達）**: 同じベンチで、連想でしか届かない gold 12件中「off: 0件 → `maxCount=10`: 12件」。**ただしこれは合成 probe（三角形構造）12件の結果であり、実運用の一般化は測っていない**（ADR 0168・Issue #337 が明記している限界をそのまま引き継ぐ）。
- **`compare` ベンチでの実測**（`examples/chat`。ADR 0168 が `mnemora-path.ts` を既定 on にしたときに測った数字、出所【受】）: 42〜162ターンの会話では `mnemoraShareOfNaiveChars` が**改善**（例: 42ターンで 61.7% → 55.6%）、322〜642ターンでは**悪化**（例: 322ターンで 53.0% → 56.0%）。**この ADR 単独では、`examples/chat` の実際の出力はこの数字から変わらないはずである**（決定4のとおり、値は同じ `maxCount=10` を継ぐため）——下記「測ったこと」で `mnemora-path.test.ts` の歯により素通しの配線を確認した。**`compare-baseline.json` を使った実測での再確認は、この PR では行っていない**（項目6として保留、マネージャー指示）。
- **`estimateRecallFootprint` の見積もり誤差**: 変更していない（既定は据え置き）。ただし `associationCount` を省略した呼び出しの見積もりは、既定 on の下では実態を**過小評価する方向**にのみ倒れる（構造上、過大評価にはならない）——上記「決めたこと」5番を参照。**この過小評価の実測値（何%ずれるか）は、この ADR の範囲では測っていない**。

---

## 引き受けた負債

1. 🔴 **`maxCount: 10` は根拠のある確定値ではない。**索引が使われない小規模ベンチ（`haystackSize=62`）での実測に基づく仮値であり、Issue #337 が要求する10万行級の実測はまだ無い。「いま2本の測定が独立に走っている」【伝】——その結果で変わる可能性が高い。

2. 🔴 **既定 on は、Issue #337・`docs/roadmap.md` §7.12 が記録したオーナー決定と、字面のまま整合していない。**この ADR はその食い違いを解消していない——「Issue #337・roadmap.md §7.12 との関係」節に書いたとおり、この状態のまま draft PR として止めている。マネージャー・オーナー側の追加判断が要る。

3. 🔴 ⭐ **既定 on は、`docs/north-star.md` の目指す姿の項目6（「知らないことを、知らないと言える」）を、別の経路で破りうる。**連想枠が `maxCount` で候補を切り捨てる箇所（`recall-runtime.ts` の `associationHits.slice(0, associationQuery.maxCount)`）は、切り捨てた件数を `omitted` に一切名乗っていない——既定 off のときはこの経路そのものが呼ばれない呼び手にとって無関係だったが、**既定 on になった瞬間、この経路は全利用者の既定挙動になる。**⟹ **この ADR は ADR 0188（連想枠の切り捨てを `omitted` に名乗らせる、別の担い手が着地させる予定）を前提とする。**ADR 0188 が着地しないまま本 ADR だけが出荷されると、項目2（聞かれていないことを自分から思い出す）を埋めると同時に、項目6を新しい経路で欠けさせることになる。**この PR の該当コード（`recall-runtime.ts` の1145〜1200行付近）には触れていない**——重複作業・衝突を避けるため、意図して手を出さなかった。

4. ⚠ **連想枠の候補選定は、段2の `score_not_comparable`（NaN 三分割）を経由しない。**既定 on によって、この gap が理論上は全利用者に開かれるようになった（決定6で述べた副次的発見）。この ADR の範囲では直していない——実際に本番データで `halfLifeHours: 0` かつ経過時間ちょうど0のような極端な状態が起きるかは未確認であり、影響の大きさも測っていない。

5. ⚠ **`RecallFootprintShape.associationCount` を省略した見積もりの過小評価幅は測っていない。**doc コメントで警告しているだけで、実測でどの程度ずれるかは示していない。

6. ⚠ **`packages/postgres` の recall テスト（`recall.postgres.test.ts` 以外に `recall-decay-cross-day.postgres.test.ts`）を、この作業環境（`DATABASE_URL` 無し）では実行できていない。**コードを読んで「影響が無いはず」と判断した箇所（各テストが単一の候補しか作らない、または `embeddingStatus: 'skipped'` で連想の対象になり得ない）はそのままにしたが、**実測での確認は CI に委ねている。**

7. ⚠ **`examples/chat/src/postgres/bench/scale-bench.ts` のレイテンシ測定は、既定 on の影響を受ける**（`runtime.recall()` を素の形で呼んでいる）が、この ADR では触れていない——性能ベンチの数字が変わりうることを記録するだけに留める。

8. ⚠ **`compare-baseline.json` の更新（項目6）は、この ADR の範囲外としてマネージャーが保留にした。**「決定4は値が同じなので `compare` の出力は変わらないはずである」という主張は、コードを読んだ推論であり、**CI での実測により裏を取る必要がある**（次の作業として、マネージャーから追って指示がある）。

---

## これが覆るとしたら

1. **Issue #337 の10万行級測定が完了し、`maxCount` の最適値が別の値だと分かったとき。**「`maxCount` を変えるとき直す箇所」節の手順で更新する。
2. **オーナーが、既定 on という方向そのものを差し戻したとき**（Issue #337・roadmap.md §7.12 との整合が取れないと判断されたとき）——この ADR は「状態」を「採用」から「差し戻し」に変え、`RecallQuery.association` の既定を off へ戻す作業が要る。**その場合、`examples/chat` 側に ADR 0168 相当の独自既定（`DEFAULT_MNEMORA_PATH_ASSOCIATION`）を復元する必要があるかもしれない**——決定4でそれを削除したため。
3. **ADR 0188（連想枠の切り捨てを `omitted` に名乗らせる）が着地したとき。**負債3が解消し、既定 on が項目6を破る経路が塞がる。本 ADR はその着地を前提として書かれている——着地しないまま出荷判断がされる場合は、この節の前提が崩れる。
4. **連想枠の候補選定に `score_not_comparable` 相当のフィルタが足されたとき。**負債4が解消する。

---

## 歯

**新設・変更した歯**（対象ファイル限定の vitest で確認。全体実行はしていない——`docs/autonomy.md`/オーナー方針）。

- `packages/core/src/__tests__/recall.test.ts`: `RecallQuerySchema` が `association: null` と `association` 省略を区別してパースすることを検査する4件を新設（「`RecallQuerySchema` — association: null と undefined の区別（ADR 0187、既定 on）」）。
- `packages/core/src/__tests__/recall-association.test.ts`: 「既定 on」を検査する2件（省略時に `DEFAULT_RECALL_ASSOCIATION` が効くこと、`byTier.association` が現れること）、「明示的な off」を検査する2件（`null` で連想が一切走らないこと、`byTier.association` 欄が無いこと、既定 on なら拾われるはずの候補が実際に拾われないこと）を新設・改稿。既存の explicit な `association: {...}` を渡す歯はそのまま維持した。
- `packages/core/src/__tests__/recall-channels.test.ts` / `recall-pipeline.test.ts`: 既定 on によって崩れた3件を、対象外の効果を `association: null` で切り離す形で修正。1件は `byTier.association: 0` を期待値に追記。
- `packages/postgres/src/__tests__/recall.postgres.test.ts`: 同じ理由で9箇所に `association: null` を追加（DB 側は未実行、CI に委ねる）。
- `examples/chat/src/__tests__/mnemora-path.test.ts`: `queryRecall` が `association` を素通しすること（省略時はキー自体を渡さない、`null` は `null` のまま渡す、明示値は上書きされる）を検査する3件を改稿。

### 変異試験

**`docs/autonomy.md`「変異を戻すのに `git checkout <file>` を使わない」を守り、退避コピー（`cp` で `/tmp/` 配下）を取ってから変異・実行・復元・再実行の順で確認した。**

1. **`recall-runtime.ts` の `associationQuery` の決定ロジックを `undefined` 固定に変異**（＝連想が常に off になる形）: `packages/core/src/__tests__/recall-association.test.ts` の新設2件（「省略すると DEFAULT_RECALL_ASSOCIATION が適用され…」「連想を有効にする候補が居ても…」の前者）が赤くなった（`byTier.association` が現れない・stage_skipped も出ないという期待に反する）。復元後、緑に戻った。
2. **`recall-runtime.ts` の `null` 判定を外し、常に `?? DEFAULT_RECALL_ASSOCIATION` を使う形に変異**（＝ `null` による opt-out が効かなくなる形）: 新設した「association: null を渡すと、連想は一切走らない」「association: null は、連想を有効にする候補が居ても一切拾わない」の2件が赤くなった。復元後、緑に戻った。
3. **`packages/core/src/recall.ts` の `RecallQuerySchema` から `.nullable()` を外す変異**: `packages/core/src/__tests__/recall.test.ts` の新設4件のうち、「association: null は、パース後も null のまま」が赤くなった（`null` が `RecallAssociationQuerySchema` の `ZodObject` にそのまま渡り、`safeParse` が失敗する）。復元後、緑に戻った。

**【実測】** 上記1〜3のいずれも、変異前に該当ファイルを `/tmp/mutation-backup-0187/` へ `cp` で退避し、変異・`npx vitest run <file>` 実行・退避コピーからの `cp` での復元・再実行の順で確認した。`git checkout` は使っていない。

---

## 測ったこと

**【実測】typecheck**（対象パッケージ）:

```
cd packages/core && npx tsc --noEmit -p .        # 緑
cd packages/postgres && npx tsc -p tsconfig.json # 緑
cd examples/chat && npx tsc --noEmit -p .        # 緑
```

**【実測】対象ファイル限定の vitest**:

- `packages/core`: `npx vitest run`（全体、対象パッケージ内で完結する858件超のうち今回追加・変更分を含む）→ 全件緑（860件）。
- `packages/core/src/__tests__/recall-footprint.test.ts` → 28件緑（doc コメントのみの変更であり、ロジックは変えていないことの裏付け）。
- `examples/chat/src/__tests__/mnemora-path.test.ts` → 7件緑。
- `examples/chat/src/__tests__/recall-footprint-baseline.test.ts` → 23件緑（`compare-baseline.json` に対する検算。DB 不要）。

**【実測】lint / format**:

```
pnpm run lint         # 緑
pnpm run format:check # 緑
```

**【実測】build**:

```
pnpm run build # 緑
```

**【実測】pack:check**: `rm -rf packages/*/dist && pnpm run build` 後に確認する予定（本 ADR 執筆時点では build のみ確認済み。PR 本文で追って報告する）。

**【実測】ルートの `pnpm run test`**（`DATABASE_URL` 無し）: 「DB テストは実行していません」と明示して緑。

## 確かめていないこと

- **`DATABASE_URL` を要する検査全て**——`packages/postgres` の `.postgres.test.ts`（`recall.postgres.test.ts`・`recall-decay-cross-day.postgres.test.ts`・`recall-association-gates.postgres.test.ts` を含む）・`examples/chat` の `test:db`。CI に委ねる。
- **`examples/chat/compare-baseline.json` に対する実測**（項目6、マネージャー指示により保留）。「決定4は `examples/chat` の出力を変えないはず」という主張は、コードを読んだ推論であり、CI 実測での裏付けをまだ取っていない。
- **10万行級での `maxCount` の妥当性**（Issue #337 が要求するもの）。
- **本物の OpenAI/Anthropic API を使った実測**。
- **`estimateRecallFootprint` の `associationCount` 省略時の過小評価幅**（数値としての実測）。
- **`packages/postgres/src/bench/scale-bench.ts` のレイテンシへの影響**。
- **Issue #337・`docs/roadmap.md` §7.12 の記録と、この PR の実装指示との整合について、オーナー本人の直接の裏書き**——書き手が確認したのはマネージャー経由の伝達のみである。

## 人から受け取った前提（出所付き）

- ADR 0151 / 0166 / 0168 の内容——`docs/decisions/` から直接読んだ【現物】。
- Issue #337 の本文——`gh issue view 337` で直接読んだ【現物】。
- `docs/roadmap.md` §7.4・§7.10・§7.12 の内容——直接読んだ【現物】。
- `association-probes` ベンチの実測値（off/on `maxCount=3,5,10` の表）——ADR 0168・Issue #291 の 2026-09-16 コメントからの引用【受】。この ADR の書き手は自分でこのベンチを再実行していない。
- マネージャーからの作業指示（既定 on を実装すること、`maxCount` の仮値を 10 にする訂正、`examples/chat` の独自既定を外す訂正、オーナーの承認が取れているという伝達、ADR 0188 が別の担い手により着地予定であること、`recall-runtime.ts` の一部範囲に触れないこと、項目6を保留すること）——委譲文として受け取った。逐語は確認していない。

---

## 追記 (2026-09-17): ADR 0188 が着地した — 負債3 は解消した

⛔ **上の「引き受けた負債」3番と「これが覆るとしたら」3番は書き換えていない。**当時そう書いたことは記録である。**この節は、その後に起きた事実だけを足す。**

**[ADR 0188](./0188-association-over-limit-omission.md)（連想枠の `maxCount` 切り捨てを `omitted` に名乗らせる — `over_limit` に `stage` を足す）が `main` に着地した** 【実測】`git log origin/main` の `2097a72`（PR #391、Issue #375）。本ブランチはこれを `625ace4` で取り込んでいる。

⟹ **負債3（既定 on が項目6 を別経路で破る）は解消した。**連想枠が切り捨てた件数は `omitted` に `over_limit`（`stage` 付き）として名乗る。**⟹ 本 ADR の既定 on は、項目2 を埋めると同時に項目6 を欠けさせる、という状態ではなくなった。**

---

## 追記 (2026-09-17): `far-past` probe の期待値を更新した — ⛔ 「実態に合わせた」のではない

**既定 on にしたことで、`examples/chat/src/__tests__/time-term.postgres.test.ts` の `far-past` probe が1件落ちた** 【実測】CI run 35118329330（head `fc426d8`）:

```
AssertionError: expected 'newer-ranked-higher' to be 'older-not-returned'
 ❯ src/__tests__/time-term.postgres.test.ts:130:31
 Test Files  1 failed | 55 passed (56)
      Tests  1 failed | 425 passed (426)
```

**この失敗は設計どおりであり、正典のどの項目にも触れていない:**

1. **段3.5（連想）は意図的に閾値の外に置かれている**——`recall-runtime.ts` の段3.5 冒頭が逐語で「段1に置くと必ず段2の `below_threshold` で落ちる。**スコアに関係なく候補へ足す経路**は既に段3 が持っており、**連想はその一般化である**」と書いている。⟹ **閾値で沈んだものが連想で戻るのは仕様である。**
2. **この probe の older は `recordedAt` が「いま」である**（`time-term-probe-set.ts` は `newerDaysAgo`/`olderDaysAgo` しか設定しない）⟹ 沈めているのは **`freshness`（出来事がいつのものか）**であって **`decay`（使われたか）**ではない。
3. **正典は「使われない記憶が、静かに遠ざかる」と書いている**（`docs/north-star.md`）⟹ **この記憶は使われていないのではなく、いま記録されたばかりで話題が古いだけである。**⟹ **正典は「古い出来事についての記憶が遠ざかる」とは約束していない。**

### ⛔ 「差し替え」ではなく「追加」である

⛔ **`older-not-returned` → `newer-ranked-higher` に書き換えるだけの更新はしていない。**それをすると「`freshness` が閾値を割って older を落とす」ことを測っていた証拠が消える——**段2 の挙動は何も変わっていないのに。**それは「CI を通すための更新」であり、門を弱める行為である。

**実際にしたこと**（probe は弱くならず、強くなっている）:

|              |                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **維持**     | `expect(farPast.omittedKinds).toContain("below_threshold")`——**段2 がいまも older を閾値で落としていること。**⭐ **この assert を `outcome` の assert より前へ移した**——元の順序では `outcome` が先に落ちて **`below_threshold` が一度も実行されていなかった**（上の CI 出力の `:130:31` がまさにそれで、131行目には到達していない） |
| **追加**     | `expect(farPast.older!.retrievedVia).toBe("association")`——**戻ってきたのが連想枠経由であることの実証。**併せて `associationOf` の存在と、`newer` が連想経由**でない**ことも assert する                                                                                                                                             |
| **更新**     | `outcome` の期待値のみ（`newer-ranked-higher`）                                                                                                                                                                                                                                                                                      |
| **器の拡張** | `PairMember` に `retrievedVia` / `associationOf` を足した（`time-term-arm.ts`）。**probe の計測項目を増やす方向であり、既存の判定を弱める変更ではない**                                                                                                                                                                              |

⟹ **更新の理由は「CI が赤いから」ではない。**正しい理由は——**`far-past` は段2 の性質を測る probe であり、段3.5 という別の経路が足されたので、どちらの経路で来たかまで測る形に精度を上げた**である。

### ⚠ 確かめていないこと

- **`older` が実際に `retrievedVia: "association"` で返るか**は、この追記を書いた時点では**コードの構造からの推定であり、実行結果で確かめていない**（この器に `DATABASE_URL` が無く、`*.postgres.test.ts` は手元で走らない）。**上の assert を足した CI の結果が、その実証になる。**⚠ **もし `association` 以外の経路で戻っていたら、上の理由付けの前提が崩れる。**
- **⭐門（`compare` 回帰判定）は、CI run 35118329330 では一度も判定に到達していない** 【実測】——test 段が落ちたため `compare.json` が生成されず、`compare-summary.mjs` が `ENOENT` で終わっている。⟹ **「⭐門の基準値が動いたか」は、緑でも赤でもなく「未判定」である。**
- **`examples/chat/time-term-baseline.json` の `far-past` 行は、この変更で動く**（`outcome: "older-not-returned"` / `older: null` を持っているため）。⚠ **この基準値ファイルは門ではない**——`scripts/time-term-summary.mjs` が逐語で「**基準値ファイルと相違しても exit 0 のままである。これは意図した設計**」と書いている 【現物】。⟹ **CI は赤くならず、要約に相違として現れる。**⛔ **この追記の時点では更新していない**——ADR 0121 の作法どおり **CI artifact から更新する**べきであり、手で数値を書かないためである。
