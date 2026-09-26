# ADR 0151: 「聞かれていないことを、自分から思い出す」を recall の連想枠として実装する — mnemora の側から話しかける形は採らない（Issue #200）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-16

**⚠ 各主張の出所を分ける**（[ADR 0084](./0084-lexical-recall-channel.md) / [ADR 0144](./0144-drop-unreachable-classification-3-union-values.md) の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、**この ADR の書き手が自分の手で**読んで確かめた。
- **【現物・委】** — 委譲先の作業者が読んで報告し、**書き手は要点だけ自分で引き直した。**引き直した箇所はその場で名指しする。
- **【受】** — 報告として受け取り、再導出していない。
- **【伝】** — オーナーの決定として、クローン経由で書き手へ伝達された。逐語を引く。

---

## 結論

**`docs/north-star.md`「目指す姿」7項目のうち、唯一まるごと空いていた
「聞かれていないことを、自分から思い出す」を、`recall()` の拡張として埋めた。**

| 決めたこと | 決めた内容 |
|---|---|
| **Issue #200 の分岐** | **「呼び出し側が*問い合わせなくても候補が手元に在る*こと」を採る。**「mnemora が*話しかける*こと」は採らない |
| `Sensor` / `SpeechPolicy` | **実装しない。**`docs/architecture.md` §5.13 の仮置きのまま据え置く |
| 動詞の数 | **5つのまま**（observe / recall / reflect / consolidate / forget）。増やさない |
| 形 | **`recall()` に「連想枠」を足す。**クエリで引けた記憶（アンカー）の近傍を同じ埋め込み空間の二段目として引き、**クエリに直接は当たらなかった候補**を別の札（`retrievedVia: "association"`）で返す |
| 既定 | **off。**`RecallQuery.association` を明示しない呼び出しの挙動は**1バイトも変わらない** |
| 依存 | **`VectorStore.getVectors?` は任意メソッド。**無ければ連想は走らず、走らなかったことを `omitted` に名乗る |

**⚠ 「実装した」と「効いた」は別である。**本 ADR は前者までしか主張しない。
後者については下の「引き受けた負債」に、**現在の器では便益を測れない**ことを書いた。

---

## 分岐を誰が決めたか（出所の連鎖）

**Issue #200 は本文で「まずオーナーに決めてほしいこと」として2案を挙げている。**
⟹ **この ADR が採った後者は、オーナーの逐語ではない。**出所を分けて書く。

1. **オーナー本人の逐語 【伝】**（2026-09-16、クローン経由）:
   > 「目指す姿」7項目をちゃんと満たす形にしてください。
   > v1.0を切れる状態に持って行くのがあなたの仕事です。

   および、破壊的変更について:
   > ほとんど使われていない(v0.X.X)の段階なので破壊的変更であっても構わず実装してください

   **⟹ オーナーが指示したのは「7項目を満たせ」までであり、2案のどちらかではない。**

2. **クローンの判断 【伝】**: 2案のうち**後者を採る**と決めた。根拠は
   `docs/north-star.md`「迷ったときの問い」の**問い2**（これを無効にしたとき、Memory Framework
   として成立するか）であり、**前者は `Sensor` が必須になる方向へ引っ張るのでこの問いで落ちる**、
   というもの。**クローンはこの判断をオーナーの承認待ちへ積んでいる。**

   **⚠ 2026-09-16 追記（承認済み）**: オーナーが回答した（承認 id `bdcb196d-02cf-4c88-8af0-0c97fd1e23e4`、
   2026-09-15T20:09:44Z 回答。逐語）:

   > 後者でいいです

   ⟹ **この分岐はオーナーの承認により後者で確定した。**「承認待ち」だった状態は解消している。
   下の「これが覆るとしたら」1番も同時に更新した。

3. **書き手（マネージャー）の判断**: 後者を**どの API のどういう形にするか**——
   すなわち下の「決定」1〜7 と、「採らなかった案」の落とし方。

**⟹ 1 はオーナーの決定、2 はクローンの可逆な判断、3 は設計側の判断である。**
**この ADR は、2 が覆ったときに読むための文書である。**覆り方は末尾の「これが覆るとしたら」に書いた。

---

## 問い

Issue #200 が挙げた3つ。

1. 「自分から思い出す」は、mnemora が**話しかける**ことか、呼び出し側が**問い合わせなくても
   候補が手元に在る**ことか。
2. 前者を採る場合、それを無効にしても Memory Framework として成立するか。
3. 何をもって「効いた」とするか。

---

## 現物で確認した

**【現物】書き手が `origin/main`（`14b428c`）に対して自分の手で引いた。**

1. **`Sensor` / `SpeechPolicy` は、リポジトリ全体で `docs/architecture.md` §5.13 の
   3行にしか存在しない。**コードには1バイトも無い:

   ```
   $ git grep -n "Sensor\|SpeechPolicy" origin/main -- '*.md' '*.ts' '*.mjs'
   origin/main:docs/architecture.md:806:### 5.13 Sensor / SpeechPolicy — Phase 3、形のみ
   origin/main:docs/architecture.md:809:interface Sensor {
   origin/main:docs/architecture.md:813:interface SpeechPolicy {
   ```

   同節が自ら「**現時点では interface の形すら仮置きに過ぎない**」「動詞5つとの関係、
   `Ctx` との関係も未検討」と書いている。

2. **`RecalledMemory.retrievedVia` は3値である。**

   ```
   $ git show origin/main:packages/core/src/recall.ts | grep -n 'retrievedVia'
   762:  retrievedVia: "ann" | "lexical" | "mandatory_companion";
   787:  retrievedVia: z.enum(["ann", "lexical", "mandatory_companion"]),
   ```

   ⟹ **`"mandatory_companion"` という「クエリのスコアと無関係に足される候補」の札が、
   既に在る。**本 ADR の連想枠は、この先例の一般化であって発明ではない。

3. **候補生成チャンネルは2本で、既定は1本である。**

   ```
   911:export const RECALL_CHANNELS = ["ann", "lexical"] as const;
   920:export const DEFAULT_RECALL_CHANNELS: readonly RecallChannel[] = ["ann"];
   ```

4. **`VectorStore` に「`memoryId` からベクトルを引く」口は無い**
   （`upsert` / `search` / `delete` の3つだけ。`packages/core/src/interfaces/vector-store.ts`）。
   ⟹ 二段目を引くには**新しいメソッドが要る。**

5. **[ADR 0144](./0144-drop-unreachable-classification-3-union-values.md)（2026-09-16、本 ADR と同日）が
   `retrievedVia` から `"recency"` / `"tag_match"` を落としており、その実装を
   オーナー判断に留保している。**同 ADR「これが覆るとしたら」より逐語:

   > **オーナーが `"tag_match"`/`"recency"`(タグ一致・直近取得チャンネル)を実装すると決めたとき**
   > ——ADR 0084 が語彙チャンネルに対して行ったのと同じ水準の独立した ADR・実測が要る。
   > 同じ文字列を復活させるか別名にするかは、その ADR が決める。

   ⟹ **本 ADR は `"recency"` / `"tag_match"` を復活させない。**理由は「決定」7番。

**【現物・委】作業者が読んで報告し、書き手は 2〜4 を上記のとおり自分で引き直した。
以下は引き直していない:**

6. **`RecallQuery.text` と `vector` は、どちらも任意である**——両方省略しても `recall()` は
   例外にならず、`stage_skipped{reason: "empty_query_content"}` を積んで候補生成をスキップし、
   目次帯と `omitted` だけを返す。⟹ **「クエリ無しで呼ぶ」入口は既に在るが、
   `memories` は必ず空になる。**
7. **`compare` ベンチの⭐門**（`scripts/compare-summary-lib.mjs` の `computeRegressions`、
   [ADR 0133](./0133-compare-baseline-and-gate.md)）は、`mnemoraShareOfNaiveChars` の悪化と
   `factStatementSurvived` の `true`→`false` 退行を検知して exit 1 する。
8. **`compare-baseline.json` の全12行で `factStatementSurvived` は既に `true` である。**
   ⟹ この指標には**伸びる余地が無い。**（本 ADR の「引き受けた負債」2番の根拠。）

---

## なぜ「チャンネルを1本足す」形にしなかったか（構造で落ちた案）

**最初に検討したのは `RECALL_CHANNELS` に `"association"` を足す形である。これは
北極星の問いではなく、パイプラインの構造そのもので落ちた。**

`docs/recall.md` §2 のとおり、候補生成（段1）で拾われたものは**段2で再スコアされる。**
再スコアはクエリに対する類似度・タグ一致・鮮度・強度を掛け合わせる。
⟹ **連想の候補は定義上クエリに当たらないのだから、段2で必ず `below_threshold` に落ちる。**

**⟹ 「クエリに当たらないものを返す」機構は、候補生成の段には置けない。**
既存の `mandatory_companion`（段3で、スコアに関係なく相方を足す）と**同じ層**に置くしかない。
これが「段3.5」という位置の理由である。

---

## 決定

1. **Issue #200 の分岐は後者を採る。**「問い合わせなくても候補が手元に在る」形にする。
   `Sensor` / `SpeechPolicy` は実装せず、`docs/architecture.md` §5.13 の仮置きを据え置く。

2. **`recall()` に「連想枠」を足す。**段3（矛盾解決・同伴取得）の後、段4（予算切り詰め）の前に、
   次を行う段を置く:
   - 段3までに残った `memories` の上位 `anchorCount` 件を**アンカー**とする。
   - アンカーのベクトルを `VectorStore.getVectors` で引き、**そのベクトルで**
     `VectorStore.search` を**段0と同じ scope の filter で**呼ぶ。
   - 既に返る集合・アンカー自身・`minSimilarity` 未満を除き、`maxCount` 件まで採る。
   - `retrievedVia: "association"` と `associationOf: <アンカーの memoryId>` を立てる。

3. **既定は off。**`RecallQuery.association` を渡さない呼び出しでは、この段は**何もしない**
   ——`omitted` にも1件も積まない。**問われていないことは「無い」ではない。**

4. **`VectorStore.getVectors?` は任意メソッドにする。**
   （`purgeMemory?` / `purgeExpiredEvents?` / `archiveDecayed?` の先例に倣う。）
   実装していない adapter では連想は走らず、
   `stage_skipped{stage: "association", reason: "vector_store_lacks_get_vectors"}` を積む。
   ⟹ **北極星の問い2が、型の上で担保される。**

5. **連想の候補は予算（段4）の内側に置き、予算で削るときは最初に落とす。**
   落ちた分は既存の `budget_dropped` に乗る。
   ⚠ **`docs/recall.md` §6 の「目次帯は予算の対象外」という先例を、ここへ適用しない。**
   目次帯が対象外でよいのは**件数だけの帯だから**であり、連想枠は digest 本文を持つ
   ——**実トークンを焼く。**

6. **`retrievedVia` の union を `"association"` で広げる。これは破壊的変更である。**
   網羅 `switch` を書いている利用者は壊れる（ADR 0144 が union を**狭める**ときに議論したのと
   同じ性質の変更で、向きが逆）。**オーナーが「v0.X.X の段階なので破壊的変更であっても構わず
   実装してください」と明示している 【伝】ため進めるが、記録しなくてよいという意味ではない
   ——だからここに書く。**

7. **`"recency"` / `"tag_match"` を復活させない。**
   ADR 0144 がこの2値の実装を**オーナー判断に留保している**（上の「現物で確認した」5番）。
   本 ADR の連想枠は**別のもの**である——クエリで引けたアンカーを起点にするので、
   「問われていないときに何を出すか」を決めていない。
   ⟹ **留保を踏まずに「自分から思い出す」を埋められる。**

8. **`tick()` / `reflect()` / `consolidate()` には配線しない**（[Issue #204](https://github.com/takecchi/mnemora/issues/204) の範囲。下の「Issue #204 との分界」）。

---

## 誰が壊れうるか

**`retrievedVia` の union 拡張（決定6）で壊れるのは、網羅 `switch` を書いている利用者である。**
[ADR 0144](./0144-drop-unreachable-classification-3-union-values.md) が union を**狭める**ときに
議論したのと同じ性質の変更であり、**向きが逆である。**

**本リポジトリ内で実際に数えた 【現物・委】**——`retrievedVia` を参照する12ファイルを確認し、
**`switch` で分岐している箇所は0件だった。**
`examples/chat/src/format.ts` はテンプレート文字列へ埋め込むだけ（`` `[${m.retrievedVia}]` ``）であり、
新しい値をそのまま表示できる。⟹ **本リポジトリ内では、追加の互換対応が要らなかった。**
（`pnpm run typecheck` が `examples/chat` を含めて緑であることで裏を取っている。）

**⚠ 外部の利用実態は確認できない。**これは ADR 0144 が同じ節で書いた断りと同じである
——**「本リポジトリ内で数えた件数」と「外部の利用者が壊れるか」は別の主張である。**
`0.x` のあいだは semver 上許されるが、**許されることと誰も壊れないことは別である。**

**⟹ 型を広げる側の緩和策**: `association` を渡さない呼び出しでは
`retrievedVia: "association"` は**一度も返らない**（既定 off。決定3）。
⟹ **実行時に新しい値を受け取るのは、自分でこの機能を有効にした呼び手だけである。**
型の上では壊れるが、**挙動の上で不意に壊れる経路は無い。**
⚠ ただしこれは TypeScript の型検査が通らないことを解消しない——**型は広がっている。**

---

## 採らなかった案

**北極星の「迷ったときの問い」は、実際に案を落とすためにある**（`docs/north-star.md`）。
**実際に落ちたものを書く。**

| 採らなかった案 | 落とした根拠 | なぜ落ちるか |
|---|---|---|
| **mnemora の側から話しかける**（`Sensor` / `SpeechPolicy` を設計する） | **問い2** | `Sensor` が「これが無いと動かない」になる方向へ引っ張る。`docs/roadmap.md` §1.1 の「Background Cognition を必須にしない」と正面から摩擦する。**⟹ クローンの判断 【伝】。書き手はこの判断を検算していない** |
| **連想を候補生成チャンネル（`RECALL_CHANNELS`）として足す** | **構造**（問いではない） | 段2で再スコアされ、クエリに当たらないのだから必ず `below_threshold` に落ちる（上の節） |
| **クエリ無しの周辺想起**（`recall({ maxCandidates })` だけで対象を自分で見つける） | **`docs/autonomy.md` §3.1** | 「問われていないときに何を出すか」は**製品の性格を決める判断**であり、`docs/roadmap.md` §5.7（Issue #135）と同族である。**設計側では決めない。**下の「Issue #135 / §5.7 との関係」 |
| **直近取得（`recency`）チャンネルを足す** | **ADR 0144 の留保** | 同 ADR がオーナー判断に留保している。加えて同 ADR が「直近のものを優先する機構は既にスコアリング側に在る」（`decay`/`freshness`）と指摘している |
| **連想を既定 on にする** | **問い1・問い2** | 明示していない呼び手の焼く量が黙って増える。かつ「切っても成立する」が「切る口が無い」に変わる |
| **連想枠を予算の外に置く**（目次帯と同じ扱いにする） | **問い1** | digest 本文を持つので実トークンを焼く。予算の外に出すと `usage` が嘘をつく |
| **会話ログ全部を連想枠に添える** | **問い1** | 「念のため全部載せる」そのもの。北極星が名指しで落としている形 |
| **LLM に「他に何を思い出すべきか」を問う** | **問い5** | 列と索引（既存の ANN 索引）で解ける |
| **アンカーの `content` を `EmbeddingProvider` で再埋め込みして二段目を引く**（`VectorStore` に手を入れずに済む） | **問い5** | 索引に既に在るベクトルを、モデルに問い直して作り直すことになる。**⚠ この案は技術的には動く**——`observe()` 時に埋め込んだ入力は `memory.content` であり（`runtime.ts`）、記録済みカセットにその入力が在るので `recorded` でも例外にならない。**落としたのは動かないからではなく、問い5に反するからである** |
| **アンカーとの類似度を `ScoreBreakdown.semanticSimilarity` に入れる** | **問い3・問い4** | クエリとの類似度の顔で別の量を出すことになる。**説明できない賢さは採らない** |
| **`omitted` に「連想を走らせなかった」を常に積む**（既定 off のときも） | **問い1**（の精神）と `docs/recall.md` の原則 | 問われていないことを「無い」として報告すると、`omitted` が「取りこぼしの一覧」でなくなる |

---

## 北極星の問いに当てた結果

**問い1（毎回渡す量を減らす方向に働くか）** — **通る。ただし条件付きで通った。**
連想枠は**量を増やす**方向の機能である。素朴に入れれば問い1で落ちる。
通したのは次の3つの条件を付けたからである: ①**既定 off**（明示しない呼び手の量は1バイトも増えない）
②**予算の内側**（`usage` が嘘をつかない）③**予算で最初に落ちる**（クエリで引けたものを押し出さない）。
そのうえで「増やすなら、その分だけ想起が良くなると言えるか」に対しては——
**言えることが、まだ測れていない。**下の「引き受けた負債」2番。
⚠ **これは問い1を通り抜けたのではなく、「条件を付けて形を変えた」ものである**
（`docs/north-star.md` が問い3について「問いは案を落とすだけでなく、案の形を変えることもある」と
書いているのと同じ効き方をした）。

**問い2（無効にしたとき Memory Framework として成立するか）** — **通る。**
①既定 off なので、渡さなければ存在しないのと同じ挙動である。
②`VectorStore.getVectors?` が**任意メソッド**なので、実装しない adapter でも `recall()` は動く。
③この機能は `recall()` の中の1段であり、新しい動詞・新しい必須依存・新しい常駐プロセスを1つも作らない。
**⟹ 「これが無いと動かない」を増やしていない。**

**問い3（選ばれた理由を後から説明できるか）** — **通る。**
連想の候補は `retrievedVia: "association"` と `associationOf: <アンカー>` を持つ
——**「どの記憶がこれを連れてきたか」が返り値に刻まれる。**
「聞かれていないことを返す」機能は、**聞かれて返す機能よりも説明責任が重い**
（呼び手が理由を推測できないため）。だから既存の `companionOf` と同じ形を必須で持たせた。
⚠ `associationOf` は**アンカーを1つしか指さない**（負債4番）。

**問い4（AI の推論とユーザーが言った事実を区別しているか）** — **通る（既存の機構をそのまま引き継ぐ）。**
`RecalledMemory.provenanceKind` は必須欄であり（[ADR 0035](./0035-recalled-memory-provenance-kind.md)）、
連想で浮上した候補にも同じく付く。**新しい混同の経路を作っていない。**
⚠ ただし `ScoreBreakdown` の扱いには注意が要った——アンカーとの類似度をクエリとの類似度の顔で
出すことは、この問いの「混ぜた瞬間に、記憶は信用を失う」に当たる。だから上の表で落とした。

**問い5（LLM を呼ばずに済ませられないか）** — **通る。**
連想は**既存の ANN 索引の読み取りだけ**で解く。LLM を呼ばない。埋め込みモデルも呼ばない
（`getVectors` は索引に既に在るベクトルを読むだけ）。
**この問いが、上の表の2案（再埋め込み・LLM に問う）を実際に落とした。**

---

## Issue #135 / `docs/roadmap.md` §5.7 との関係

**重なる部分と重ならない部分を分けて書く。**

§5.7（Issue #135）が保留しているのは
「`consolidate()` に**まとめる対象を自分で見つける**呼び方を持たせるか」であり、
**その核心は「『似ている』が何かを製品側が定義することになる」点である**
（§5.7 逐語: 「そのとき**『似ている』が何かを製品側が定義することになり、それは想起の質
（北極星の物差し）に直接効く。**」）。

**重ならない — だから本 ADR は #135 を待たない。**

- **本 ADR は新しい「似ている」の定義を作らない。**使うのは
  **ANN が既に使っているコサイン類似度そのもの**であり、起点がクエリからアンカーに変わるだけである。
- **本 ADR は記憶を作らない・畳まない・消さない。**`recall()` の返り値を増やすだけであり、
  可逆である。§5.7 が製品判断である理由（まとめてしまうと後から戻せない性格が付く）が当たらない。

**重なる — だからそこは本 ADR では決めない。**

- 「採らなかった案」の**クエリ無しの周辺想起**は、**§5.7 と同族の判断である。**
  「問われていないときに何を出すか」は、まさしく製品の性格を決める。
  ⟹ `docs/autonomy.md` §3.1 の見分け方に当たるので、**設計側では決めない。**
- ⚠ **本 ADR は §5.7 を解かない。**§5.7 は依然としてオーナー判断待ちであり、
  **§5.7 を前提にしている [Issue #204](https://github.com/takecchi/mnemora/issues/204) も依然として着手できない。**
  **⟹ 「待っている」ことを、ここに明記して残す。**本 ADR が #204 を前進させたわけではない。

---

## Issue #204 との分界

**Issue #204 が自らの本文で住所を書いている 【現物】:**

> **「目指す姿」の「聞かれていないことを、自分から思い出す。」**の、**自分で作る**ほうの半分。

⟹ **#204 は「自分で作る」ほう、本 ADR（#200）は「自分から差し出す」ほうである。**
2つは同じ1行の別々の半分であり、どちらも他方を前提にしない。

**だから本 ADR は `tick()` に何も配線しない。**連想は `recall()` の中でだけ起き、
呼び手が `recall()` を呼んだときにだけ走る。

---

## 引き受けた負債 / 開いている穴

1. **既定 off である限り、北極星の物差しは動かない。**
   呼び手が `association` を明示しなければ、焼く量も想起の質も1バイトも変わらない。
   ⟹ **この ADR は「使う側が会話ログを全部積むのをやめられた」を、まだ一歩も進めていない。**
   進めるには、**既定 on にするか、`examples/chat` が使うか**のどちらかが要る。
   **どちらも本 ADR の範囲外である。**

2. **⭐ 現在の器では、連想枠の「便益」を測れない。**
   `compare` ベンチの想起側の指標は `factStatementSurvived` だが、
   **`compare-baseline.json` の全12行で既に `true` である 【現物・委】**——**伸びる余地が無い。**
   ⟹ **連想が想起を良くするかは `compare` では出ない。**出るのは**費用側だけ**である。
   測るべき器は `retrieval` ベンチ（`hit@k` / MRR）だが、**それは⭐門ではない**
   （門は `compare` 1本だけ。ADR 0133）。
   ⟹ **「連想枠を `retrieval` ベンチで測る」を別 issue に割る。**
   ⚠ `docs/autonomy.md` §1.2 は「動かなかったらどうするか」を着手前に書けと要求している。
   **答え: 測って動かなければ落とす**（下の「これが覆るとしたら」3番）。

3. **アンカーの選び方が素朴である。**上位 `anchorCount` 件を取るだけで、
   アンカー同士が互いに似ている場合（＝同じ領域を何度も掘る）を避ける機構が無い。
   多様性（MMR 等）を入れるかは測ってから決める話であり、本 ADR では決めない。

4. **`associationOf` はアンカーを1つしか指さない。**
   複数のアンカーから同じ記憶が浮上したとき、最初に当たったアンカーだけが記録される。
   ⟹ **「複数の記憶が同時にこれを連れてきた」という情報は落ちる。**
   問い3に対しては「1つは必ず説明できる」までしか保証していない。

5. **`getVectors?` を実装しない adapter では、この姿は現れない。**
   任意メソッドにしたことの裏返しである（問い2を通すために引き受けた）。

---

## これが覆るとしたら

1. **オーナーが「Issue #200 の分岐は前者（mnemora が話しかける形）を意図していた」と言ったとき**
   ——**本 ADR は分岐ごと覆る。**`Sensor` / `SpeechPolicy` の設計（Phase 3）へ移り、
   そこでは**問い2（無効にしても成立するか）に答えることが最初の仕事になる。**
   ⚠ **この可能性は現に開いている**——上の「分岐を誰が決めたか」2番のとおり、
   後者を採ったのはクローンの判断であり、**オーナーの承認待ちである 【伝】。**
   なお、連想枠そのものは前者を採った場合にも「差し出す側の下地」として残せるが、
   **残すべきかどうかはその ADR が決めることであり、本 ADR は主張しない。**

   **⚠ 2026-09-16 追記（承認済み）**: オーナーが「後者でいいです」と回答した
   （承認 id `bdcb196d-02cf-4c88-8af0-0c97fd1e23e4`、2026-09-15T20:09:44Z 回答。
   上の「分岐を誰が決めたか」2番に逐語）。⟹ **「前者を意図していた」という理由でこの ADR が
   分岐ごと覆る可能性は閉じた。**この1番は「当時この可能性が開いていた」という記録として残す
   ——閉じた経緯は追記で示すが、元の記述自体は書き換えない。
2. **オーナーが `"recency"` / `"tag_match"` を実装すると決めたとき**（ADR 0144 の留保が解けたとき）
   ——連想枠との関係を決め直す必要がある。「直近のもの」と「連想で浮上したもの」が
   同じ枠を争うのか、別の枠なのかは、そのとき決める。
3. **`retrieval` ベンチで、連想枠が想起の質を動かさないと実測されたとき**
   ——**落とす。**`docs/autonomy.md` §1.2 の3番（動かなかったらどうするか）への答えである。
   ⚠ 既定 off なので「落とす」の費用は小さい（呼んでいる利用者が居ないため）。
4. **既定 on にしたいという要求が来たとき**——**問い1をもう一度当て直す。**
   既定 on は「明示していない呼び手の焼く量が黙って増える」ことであり、
   本 ADR が問い1で落とした形そのものである。
5. **`retrievedVia` の union を広げたことで、外部の利用者が実際に壊れたと報告してきたとき**
   ——移行ガイドの追記が要る。⚠ **外部の利用実態は確認できていない**（ADR 0144 と同じ断り）。

---

## 測ったこと

**⚠ この節は、実装 PR の本文に測った数字が入った後に、そこから引く。**
ADR の段階で書けるのは次の2つだけである。

- **`origin/main`（`14b428c`）に対する「現物で確認した」1〜5 は、書き手が自分の手で引いた。**
  コマンドと出力は同節に貼ってある。
- **6〜8 は委譲先の報告であり、書き手は引き直していない 【現物・委】/【受】。**

## 確かめていないこと

- **`compare` ベンチを、書き手は一度も自分の手で走らせていない。**
  この作業環境に `DATABASE_URL` が無く、`docker` も `psql` も無い
  ——**本物の Postgres + pgvector を用意できない** 【現物】。
  ⟹ `docs/autonomy.md` §1.1 のとおり、**この環境では「空」ではなく「判定不能」である。**
  数字は CI の `example-chat` ジョブで見届ける。
  （**先例が在る**——[ADR 0133](./0133-compare-baseline-and-gate.md) の `provenance.how` 自身が
  「この bench をこの PR の作業者は一度も自分の手で実行していない」と書いている。）
- **`retrieval` ベンチで連想枠が想起の質を動かすかは、測っていない。**上の負債2番。
- **実 API（`openai` 層）での挙動は測っていない。**CI は `recorded` で走る。
- **外部の利用者が `retrievedVia` の union 拡張で壊れるかは、確認できていない。**
- **クローンが「後者を採る」と判断した根拠（問い2による前者の落ち）を、書き手は検算していない。**
  受け取った判断として扱っている 【伝】。

---

## 追記（2026-09-26、Issue #377 — `VectorStore.searchMany?` の追加）

> 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。`VectorStore` に
> `searchMany?` を任意メソッドとして追加してよいという決定は、2026-09-26 にクローン
> miku が行った——オーナーではない。

### 背景

[Issue #377](https://github.com/takecchi/mnemora/issues/377) が、連想枠（段3.5）の
アンカーごとの ANN 検索が、アンカー数（`anchorCount`）に比例して往復数を増やす
ことを実測している——`recall-runtime.ts` の段3.5は、アンカーごとに
`vectorStore.search()` を1回ずつ呼ぶループを持ち、`PostgresVectorStore.search()` は
呼ばれるたびに独立した `db.transaction()`（`begin`/`SET LOCAL hnsw.iterative_scan`/
`SELECT`/`commit` の4文、ADR 0284）を開く。この作業の依頼は「既定の `anchorCount` は
変えない。往復数の削減だけを当てる」というものだった。

### 決定: `searchMany?` を任意メソッドとして追加する

`search()` は単一のクエリベクトルを受け取る口であり、この形のままでは複数アンカーを
1回の往復に束ねられない——新しい口が要る。[ADR 0151 決定4](#決定)（`VectorStore.
getVectors?` を任意メソッドにした判断）と同じ形で、`packages/core/src/interfaces/
vector-store.ts` の `VectorStore` に次を追加した:

```ts
searchMany?(
  ctx: Ctx, space: EmbeddingSpaceId,
  queries: { key: string; vector: number[] }[],
  opts: { limit: number; filter: VectorFilter },
): Promise<Map<string, VectorHit[]>>;
```

**理由**:

1. **非破壊。** `pnpm api:check` の差分は「`VectorStore.searchMany?` の追加」と
   「`PostgresVectorStore` への `searchMany` 実装の追加」だけであり、既存の型・既存の
   呼び出しは1つも変わっていない（`search()` と共有する `WHERE` 組み立ては、クラスの
   private メンバーではなくモジュール内のトップレベル関数 `buildFilterConditions` として
   切り出してあり、公開型には現れない——下記「実装」参照）。
2. **未実装の adapter でも `recall()` は成立する。** `recall-runtime.ts` の段3.5は
   `deps.vectorStore.searchMany` が無ければ、従来どおりアンカーごとに `search()` を
   呼ぶ経路へ戻る——結果（集合・順序）は束ねた場合と変わらず、往復数だけが
   アンカー数に比例したままになる。北極星の問い2（無効にしても成立するか）を
   型で担保する、決定4と同じ形。
3. **`search()` のシグネチャそのものを複数ベクトル対応に変える案は採らなかった。**
   段1（ANN 検索）を含む既存の全呼び出しに影響する変更になり、
   「往復数の削減だけを当てる」という依頼の範囲を超える。
4. **`recall-runtime.ts` 側で `Promise.all` によるアンカーごとの並列 `search()` 呼び出しに
   留める案も採らなかった。** 並列に呼んでも DB への往復（トランザクション・SQL 文の数）
   自体は減らない——Issue #377 が問題にしているのは並列度ではなく往復数である。

### 実装

`PostgresVectorStore.searchMany`（`packages/postgres/src/vector-store.ts`）は、
`VALUES (key, vector), ...` と `CROSS JOIN LATERAL` で束ねる。`search()` が組み立てる
`WHERE` 条件は `buildFilterConditions`（モジュール内のトップレベル関数、`search()`/
`searchMany()` が共有。公開 API の差分を「`searchMany?`/`searchMany` の追加」だけに
保つため、クラスの private メンバーではなくモジュール関数にした——マネージャーが
枝へ直接足した追い作業）へ切り出し、2箇所で食い違う経路を作らないようにした。
`ORDER BY` は `search()` と同じ3段 tie-break（距離 → `recorded_at` DESC →
`memory_id`、Issue #339 / ADR 0170）を `LATERAL` の中にそのまま書く。
`hnsw.iterative_scan = relaxed_order`（ADR 0284）の `SET LOCAL` も同様に共通ヘルパー
（`withRelaxedOrderScan`）へ切り出した——`search()`/`searchMany()` がそれぞれ独立に
`SET LOCAL` を発行すると、`hnsw-ef-search-window-ceiling.test.ts` 検査2（ADR 0284が
「本番経路で SET している箇所は1つだけ」と固定している歯）が赤くなるため。詳細・
採らなかった案（歯の期待値を変える案）は ADR 0284 の追記（2026-09-26）を参照。
`SET LOCAL` は1トランザクションに1回だけ発行する——`LATERAL` は同じ SELECT 文の中で
アンカーの数だけ繰り返し実行されるが、`SET LOCAL` はトランザクション単位のセッション
変数なので、繰り返しごとに再設定する必要はない。

`recall-runtime.ts` 側は、アンカーごとに同一の `filter`（`scope`/`validatedQuery` 由来で
`anchorId` に依存しない）を1箇所（`associationFilter`）にまとめ、`searchMany` の
有無で経路を分岐する。後段（`seen`/`excludeIds` によるアンカー間重複排除、
`associationOf` が最初に当たったアンカーだけを記録する規約——ADR 0151 負債4）は
一切変えていない——変わるのは「アンカーごとの ANN 検索を何回の往復で行うか」だけである。

### 実測

- **往復数**: `packages/postgres/src/__tests__/recall-roundtrip-count.postgres.test.ts`
  歯4に、`anchorCount` を 1/3/10 と振っても往復数が変わらないことを固定する歯を足した。
  実装前は歯4が実際に赤くなる（アンカー数に比例して増える）ことを確認済み——
  具体的な実測値は本追記のもとになった PR 本文に控えてある（`main` が動くと変わりうる
  数なので、ここには焼き込まない）。
- **EXPLAIN**: `packages/postgres/src/__tests__/vector-store-search-many.postgres.test.ts`
  歯4が、`searchMany` が実際に発行する SQL を捕捉して `EXPLAIN` し、`LATERAL` の内側
  でも HNSW 索引（`idx_memory_embeddings_hnsw_*`）が使われ、`Seq Scan` に落ちないことを
  実測している（1テナント3000行、`vector-search-hnsw.test.ts` と同じ規模・同じ手法）。
- **一致性**: 同ファイル歯1・歯2が、`searchMany` の結果が同じクエリを1本ずつ `search()`
  した場合と集合・順序ともに完全一致することを、距離の同点（`recorded_at` DESC・
  `memory_id` フォールバックの両方を含む）と、`subjectId`/`attributes` フィルタが
  効いた状態の両方で実測している。

### 既定 `anchorCount` は変えていない

この追記は往復数の削減だけを扱う。**「規模に見合う `anchorCount` がいくつか」という
Issue #377 本題は、依然として未解決のまま残る**——`anchorCount` を上げる提案が
出たときの費用（往復数）は、この追記により定数化されたので以前より軽くなったが、
「いくつが規模に見合うか」自体は依然として測ってから決める話であり、この追記では
判断しない。

### 確かめていないこと

- **レイテンシ（ms）としての改善効果は測っていない。** 往復の**数**だけを実測した。
- **100万件級・複数 tenant 混在・`attributes`/`labels` 絞り込みが同時に効いた状態での
  HNSW 選択は未検証。** 実測は1テナント3000行、フィルタ1種類ずつの検証に留まる。
- **`packages/testkit`/`packages/core` の in-memory 実装（`FakeVectorStore` 等）には
  `searchMany` を実装していない。** 任意メソッドなので必須ではなく、これらの adapter を
  使う既存のテストは引き続き「searchMany 無し」の逐次 `search()` 経路を通る——
  対称性のために実装するかどうかは、この追記の範囲外の判断として残す。

### これが覆るとしたら

- **`searchMany` の一致性が将来の変更で崩れたとき**——`pnpm api:check` は型のシグネチャ
  だけを見るため、実装の中身が `search()` の挙動から乖離してもこの歯では検出できない。
  `vector-store-search-many.postgres.test.ts` が唯一の歯であり、`search()`/`searchMany()`
  のどちらかだけを直して両者が食い違う変更を入れたときは、この歯が赤くなることを
  期待している。
- **`anchorCount` の既定を上げる提案が別途出たとき**——往復数の費用はこの追記で
  定数化されているため、その提案の判断材料からは外れる（費用ではなく「規模に見合う値か」
  だけが残った論点になる）。

---

## その後（2026-09-27）——段3.5が拾った contested が対向なしの単独で返っていた穴を塞いだ（Issue #959）

### 何が起きていたか

段3.5（連想枠）の検索フィルタは `status: ["active", "contested"]` を渡しており、
`contested` の Memory も連想の候補になり得た。しかし段3（必須の同伴取得、ADR 0043/0136）の
対向取得は `withinLimit`（段2で `limit` の内側に入った候補）にしか掛かっておらず、
段3.5が独自に拾った `contested` にはその規則が及んでいなかった。結果として、
`limit` の外に落ちた `contested` が連想枠の候補として浮上すると、対向を伴わない単独の
まま `memories` に返り、`omitted` にも何も出ない状態が起きていた（Issue #959 本文の
最小再現）。これは `docs/architecture.md` §0 原則1（争われている主張は、それを争う
相手と必ず同時に提示する）・`packages/core/src/interfaces/memory-store.ts` の
`MemoryStore` の契約（`contested` を単独で返してはならない）と食い違っていた。

一方で ADR 0335（`RecalledMemory.contestedWith`）は、この状態を「相手が budget
切り詰め後の最終的な結果集合に含まれないとき（連想枠経由で単独候補になった場合など）は
`contestedWith` が付かない」として観測し、文書にも残していた——起きうるものとして
観測されてはいたが、原則1・`MemoryStore` の契約とは照らされていなかった。

### 採った案 (B)

Issue #959 が挙げていた2案のうち、(B)（段3.5で選んだ contested にも段3と同じ同伴取得を
かけ、対になれば1 Unit、なれなければ Unit ごと落とす）を採った。(A)（段3.5で
`status === "contested"` を落とす）は不採用——対で拾えたはずの組まで連想枠から
消えてしまい、(B) より狭い結果しか返せなくなるためである。

具体的には、段3の必須同伴取得（`getMany` + `survivesAttributesFilter` + 対向の
`status === "contested"` チェック。段3自身の振る舞いは1バイトも変えていない）を
`fetchMandatoryCompanions`（`packages/core/src/recall-runtime.ts` 冒頭）として括り出し、
段3・段3.5の両方から呼ぶ形にした。段3.5側は、`selectedCandidates`（連想枠が席
（`maxCount`）を埋め終えた後の候補集合）のうち `status === "contested"` なものについて:

1. 対向が既に段3の結果（`units`）に含まれていれば、追加の取得はしない（多層防御。
   下の「確かめていないこと」参照）。
2. 対向が連想枠自身の `selectedCandidates` の中に別のアンカー経由で独立に見つかっていれば、
   2件を1つの Unit にまとめる（`retrievedVia` はどちらも書き換えない——段3の
   「両側とも独立に withinLimit に含まれていた」分岐と同じ形）。
3. どちらでもなければ `fetchMandatoryCompanions` で対向を取得する。取得できれば
   `retrievedVia: "mandatory_companion"` + `companionOf` を段3と同じ形で付け、
   1つの Unit にする。
4. 取得できなければ（forget 済み・存在しない・片側だけの `contested`（`contestedWithId`
   が無い）・`attributes` の絞り込みで外れた、等）、その候補ごと Unit を組まず落とす。

### 席（`maxCount`）の数え方 — 段3の `limit` の扱いに揃えた

**連想枠の席は「Unit の数」で数え、必須の同伴は席を食わない。** 段3の現物
（`packages/core/src/recall-runtime.ts`）を読むと、`withinLimit = passed.slice(0, limit)`
（段2の直後、修理前後で行番号は動くが式は変えていない）が確定した*後*に、
`allCandidates = [...withinLimit, ...companions]` という形で必須の同伴（`companions`）を
別枠で連結している——`limit` は同伴を1件も数えない。段3.5もこれに揃え、
`selectedCandidates = rankedCandidates.slice(0, associationQuery.maxCount)` で
`maxCount` 件の席を確定させた*後*に、`fetchMandatoryCompanions` で取得した同伴を
追加する（席の確定に一切関与させない）。⟹ **必須の同伴取得によって連想枠が返す
`RecalledMemory` の総数が `maxCount` を超えることがある**が、これは段3が `limit` を
超えて `companionsAdded` 分を返すのと同じ、意図した非対称である。

### 印の付け方 — 段3の既存の印付けをそのまま流用した

現物（`retrievedVia`/`companionOf`/`associationOf`/`contestedWith` の4つ）を確認し、
新しい印は1つも作らなかった:

- 段3.5が本来見つけていた側（連想で見つかった候補そのもの）は `retrievedVia:
  "association"` + `associationOf` のまま——同伴取得を経由したことにはならない。
- `fetchMandatoryCompanions` が取得した同伴側は、段3の同伴と同じ
  `retrievedVia: "mandatory_companion"` + `companionOf: <相手の memoryId>`。
- 両側とも連想枠自身の検索で独立に見つかった場合は、どちらの `retrievedVia` も
  書き換えない（段3の「両側とも独立に withinLimit に含まれていた」分岐、
  `companion.retrievedVia !== "mandatory_companion"` の場合の扱いと同じ）。
- `contestedWith` は ADR 0335 の既存の機構（budget 切り詰め後の `keptMemoryIds` を見て
  対称に付ける）がそのまま働く——この修理のために `contestedWith` の判定ロジック自体は
  1行も変えていない。対向が同じ Unit に入るようになったことで、「対向が
  `keptMemoryIds` に居ない」状態自体が構造的に起きなくなり、結果として ADR 0335が
  観測していた「連想枠経由で単独候補になり `contestedWith` が付かない」状態が
  解消された（ADR 0335 の 2026-09-27 追記を参照）。

### 重複防止（#823/#925 の排他性を壊さないこと）

連想枠自身の検索は `excludeIds`（`withinLimit` + 段3の `companions` + アンカー自身）で
既に段3の結果と重複しないようにしている——このため「対向が段3の結果に既に居る」
（上の1番）の経路は、通常の一対一の `contested` 不変条件のもとでは**到達しないはずだと
判断している**（`markContested` が両側 `status='active'` の CAS で相互参照を書くため、
一対一が壊れるのは `MemoryStore` を `Runtime` を経由せず直接操作した場合に限る——
ADR 0136 と同じ限界）。多層防御として残したが、この経路を直接踏む fixture は
作れなかった（下の「確かめていないこと」参照）。

「対向が連想枠自身の中に居る」（上の2番）は、`selectedCandidates` 内の重複を
`associationConsumed`（`recall-runtime.ts`）という消費済み集合で追跡し、後から
処理された側が同じ対向を二重に取得・二重に Unit へ入れないようにしている。

### 歯

`packages/core/src/__tests__/recall-association-contested-companion.test.ts`
（Fake）・`packages/postgres/src/__tests__/recall-association-contested-companion.
postgres.test.ts`（本物の Postgres + pgvector）に、不変条件（`result.memories` に
`status: "contested"` の記憶が、その `contestedWithId` の記憶を伴わずに含まれていたら
赤）と、Issue #959 の最小再現・対向が取れず Unit ごと落ちる経路・連想枠自身が両側を
選んだときに重複しないこと、3組以上・`channels: ["ann","lexical"]` 併用の各歯を置いた。
修理前のコードに対してこれらの歯が実際に赤くなること、修理後に緑へ戻ることを実測した
（PR 本文参照）。

既存の `recall-pipeline.test.ts` の「contested だが相手が最終的な結果集合に居ない
（連想枠経由で単独候補になり、対向は recall にそもそも掛からない）場合は
contestedWith が付かない」歯は、この修理により前提が成立しなくなった（対向が
forgotten で取得できない場合、いまは `contestedAlone` 自体が単独で返らず Unit ごと
落ちる）ため、新しい挙動を検算する形に書き換えた——歯が検査していた「forget 済みの
対向は同伴として使わない」という規則自体（ADR 0087 決定6）は変えていない。

### 確かめていないこと

- **「対向が段3の結果に既に居る」経路（上の重複防止1番）を直接踏む fixture は
  作れなかった。** 一対一の `contested` 不変条件が保たれている限り構造的に到達しない
  はずだと判断しているが、`MemoryStore` を直接操作して壊れた一対一を作った場合に
  この分岐が正しく振る舞うことは、コードを読んで確認した以上には検査していない。
- **4組以上・`subjectId`/`labels` 併用など、歯で当てた組み合わせ以外の絞り込みの
  組み合わせ**（例: `labels` 絞り込みで対向だけが外れる場合）は、`attributes` 絞り込みの
  歯と同じ経路（`fetchMandatoryCompanions` が `survivesAttributesFilter` だけを見る）を
  通るはずだが、`labels`/`subjectId` それぞれについて専用の歯は置いていない。
- **`over_limit(stage:"association")` / `associationUnitAssemblyShortfall` が同時に
  多数発生する規模での性能**は測っていない——`fetchMandatoryCompanions` は
  `getMany` を1回にまとめるが、その1回の呼び出しが返す件数が多いときの費用は未計測。
- **ベンチのベースライン（`compare-baseline.json` 等）への影響**は、手元では
  contested を含む合成コーパスを使っていないため差分が出るかどうかを実測していない
  （PR 本文参照）。

### これが覆るとしたら

- **一対一の `contested` 不変条件が破れる新しい経路が見つかったとき**——上の
  「対向が段3の結果に既に居る」多層防御が実際に到達するようになり、その振る舞いを
  fixture で固定する必要が生じる。
- **連想枠の席の数え方（Unit の数、必須の同伴は席を食わない）を見直す提案が出たとき**
  ——本追記が揃えた「段3の `limit` と同じ扱い」という前提が変わる。
