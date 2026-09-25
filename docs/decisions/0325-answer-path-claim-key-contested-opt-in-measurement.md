# ADR 0325: examples/chat の answer 経路に claimKey/detectContested を評価用 opt-in する — `[矛盾候補:]` が0件だった理由を実測する（Issue #691 続き）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

**⚠ この PR はクローンの委譲で動く担い手（サブエージェント）が書いた。投稿者
`takecchi` はオーナー本人ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
——投稿者名は担い手とオーナーを区別しない）。**この ADR に出てくる判断はすべて
「クローン miku の判断（オーナーではない）」である。**オーナーの確認・承認を得たものではない。

### 出所の凡例（ADR 0185/0315/0320/0324 以降の作法）

| 記号 | 意味 |
|---|---|
| 【実測】 | この作業者が、この器で実際に本物の Postgres + pgvector・`OPENAI_API_KEY` を叩いて得た |
| 【現物】 | この作業者が、リポジトリの現物（コード・文書）を読んで確かめた |
| 【受】 | 人・他のエージェントから受け取った前提。自分で検証していない |

---

## 文脈

Issue #691（回答プロンプトで記憶の由来・話者・主題・矛盾関係を保持する）の描画契約
（`examples/chat/src/mnemora-path.ts` の `buildMnemoraPrompt`）は、`companionOf` の
両側に `[矛盾候補:…]` を出す。だが実経路（`answer` のカセット `answer.json`/
`answer.order-legend.json`）では `[矛盾候補` は**一度も出たことが無い**——`claimKey`
（ADR 0320、Issue #371）自体が `answer` 経路では一度も opt-in されていなかったため、
`detectContested`（ADR 0324、Issue #372）が `contested` を書く機会自体がそもそも
無かった。

**この ADR が決めるのは**、`examples/chat` の `answer` 経路だけに評価用の opt-in を
足し、`[矛盾候補:]` が実際に届くかどうかを実測すること——**それだけである。**
`packages/core` の既定（`claimKey.enabled`/`detectContested` とも off のまま）は
1つも変えない。

---

## 決定

### 決定1: opt-in は env 1つ `MNEMORA_ANSWER_CLAIM_KEY=detect`。既定は今日のまま

`examples/chat/src/answer-claim-key-options.ts`（新設）の
`resolveAnswerClaimKeyOptions(env)`:

- 未設定・空文字 → `undefined`（`ingestConversation` は `runtime.observe()` へ
  `claimKey` キー自体を渡さない——`claimKey: undefined` を明示するのとは違う。
  ADR 0320/0324 の「渡さなかった」規約と同じ形）。
- `"detect"` → `{ enabled: true, detectContested: true }`。**`knownPredicates` は
  渡さない版を主とする**——`answer-case-set.dev.ts`/`.eval.ts` 向けの語彙一覧を
  作業者が手で作ると、その語彙選択自体が「どの主張が訂正対象か」を暗に漏らし
  かねないため（決定4参照）。
- それ以外の値 → 例外（`providers.ts` の `parseModeOverride` と同じ「未知の値は
  黙って倒れない」作法）。

`examples/chat/src/mnemora-path.ts` の `ingestConversation` にオプション引数
`IngestConversationOptions { claimKey?; onObserved?; }` を足し、
`answer-bench.ts` の `runAnswerCase`/`runAnswerBench` から素通しする。**すべて
末尾の任意引数**——既存の呼び出し（`cli.ts` の `recordAnswer`/`runAnswer`、
`record-answer-retention-mutation.ts`、`answer-retention-mutation.ts`）は1文字も
変更していない。

### 決定2: 記録は新しいカセット `answer.claim-key.json` に置く。既存4カセットは触らない

ADR 0315 決定4の指示どおり。`examples/chat/src/scripts/record-answer-claim-key.ts`
（新設、`record-answer-retention-mutation.ts` と同じ「専用スクリプト」の形）が、
`answer.order-legend.json` を**種カセット**（`MNEMORA_RECORD_SEED_CASSETTE`
相当、`SeededLLMProvider`/`SeededEmbeddingProvider`、ADR 0315 決定4・ADR 0309
§4.5.2 が推奨した経路）にして dev+eval 全14ケースを実 API で走らせ、
`examples/chat/cassettes/answer.claim-key.json` へ記録する。claimKey 派生の
プロンプトは既存の抽出プロンプトと**別の構造化呼び出し**（ADR 0315 決定2 の
separate 方式）であり、抽出そのものには触れないため、種のヒット率は高い
（実測: LLM 呼び出し102件中 種命中76件・実API26件、決定5参照）。

既存4カセット（`retrieval.json`/`compare.json`/`answer.order-legend.json`/
`answer-time-weighting*.json`）・凍結カセット（`answer.json`）は1バイトも
変更していない（`git diff --stat` で確認済み）。

### 決定3: `answer-trials-material.ts`/`answer-trials-render.ts` の order-legend 対応漏れを直す

ADR 0301（Issue #705）の `answer-trials` は、材料をカセットから静的復元する
（`loadAnswerTrialsMaterial(cassettePath)`、`cassettePath` は既に任意引数）——
「読めるようにする最小の変更」を先に探したところ、**引数自体は既にあったが、
実際には読めなかった**。原因は2つ、どちらも ADR 0309（`order-legend` 描画、
凡例行 `ORDER_LEGEND_LINE` を本文の先頭に足す）を作った時点で埋め込まれていた
未使用のバグである（`answer-trials-material.ts`/`.-render.ts` の default 材料は
今も凍結カセット `answer.json` であり、`answer.json` は凡例行を持たない
過渡期の記録形式のため、この経路は一度も実行されたことが無かった）:

1. `isMnemoraShapedContent`（候補選定）が `"- [由来:"` 始まり・`"(索引:"` 始まり
   の2条件しか見ておらず、`ORDER_LEGEND_LINE` 始まりの content を「記憶経路の
   プロンプトではない」として弾いていた。3条件目を足した。
2. `parseMnemoraPromptBody`（パース）が凡例行を記憶行として `parseMemoryLine`
   に渡し、例外を投げていた。凡例行を剥がしてから解析するよう直し、原文に
   凡例行があったかどうかを `CaseMaterial.hasOrderLegend` として保持する
   ——`recordedRenderer` はこの欄を見て凡例行の有無を**原文どおりに**再現する
   （`lines` から `recordedOrder` の有無を再導出すると、`answer.json`
   のように「`[記録順:N]` は持つが凡例行は持たない」過渡期の記録の再構成検査が
   壊れる。実際にこの PR の作業中に壊して気づいた）。

この2点を直さない限り、`answer.order-legend.json`（現行の基準カセット）も
`answer.claim-key.json`（本 PR の新カセット）も `answer-trials`/`recordedRenderer`
の材料として使えなかった——**この ADR が最初に踏んだ、`answer-trials` 側の
既存の欠陥**である。

### 決定4: `knownPredicates` は渡さない

ADR 0315/0320/0324 の実測はいずれも、既知 predicate 一覧を渡すほうが鍵の
一致率が上がることを示しているが、本 ADR は渡さない版を主とした。理由は
決定1の逐語のとおり——`answer` ケースの語彙を作業者が選ぶと、正解の漏洩に
近づく。加えて（決定5参照）、**渡しても (g) の穴（recall 側の companionOf
未設定）は直らないため、渡す効果が最終出力（`[矛盾候補:]` タグ）まで
届かない**——語彙ヒントを足す前に、recall 側の穴を先に塞ぐ必要がある。

---

## 測ったこと

【実測】2026-09-25、`gpt-4o-mini`、`examples/chat/src/answer-case-set.dev.ts`
（6件）+ `.eval.ts`（8件）の全14ケース、`initdb`（PostgreSQL 17、pgvector・
btree_gin・pgcrypto、専用ポート・作業ツリー外）で立てた専用インスタンス。

### 1. `[矛盾候補:]` タグは14ケース中0件

`onObserved` フック（`IngestConversationOptions`、診断用）と `memories`
テーブルの直読み（`claim_key_subject`/`claim_key_predicate`/`status`/
`contested_with_id`/`valid_from`/`valid_until`）で、落ちた段を特定した。

#### (c) claim key の predicate が `observe()` 呼び出しをまたぐと一致しない — 訂正系4ケース中3件

訂正・否定を含む4ケース（`schedule-change`/`negation` カテゴリ）の実測値:

| ケース | 集合 | 1回目の発言 → claim key | 訂正の発言 → claim key | 一致？ |
|---|---|---|---|---|
| schedule-change-meeting-day | dev | 「来週の定例会議は金曜日に…」→ `(user, meeting_schedule)` | 「定例会議が水曜日に移動した…」→ `(user, meeting_schedule_change)` | **✗ 不一致** |
| negation-moved-city | dev | 「以前は京都に住んでいました。」→ `(user, lived_in_location)` | 同一ターンから2候補: 「現在、神戸に住んでいる。」→ `(user, current_location)` / 「以前は京都に住んでいた。」(inferred) → `(user, previous_location)` | **✗ 3者とも不一致** |
| schedule-change-deadline | eval | 「報告書の提出期限は今月の20日である。」→ `(user, report_deadline)` | 同一ターンから2候補: 「提出期限を25日に延ばしてもらいたい」→ `(user, request_deadline_extension)` / 「20日は間に合いそうにない」→ `(user, unachievable_submission_date)` | **✗ 3者とも不一致** |
| negation-moved-job | eval | 「以前はエンジニアとして働いていました。」→ `(user, occupation)` | 「現在はデザイナーとして働いている」→ `(user, occupation)` | **✓ 一致** |

4件中3件で、claim key 派生（`deriveClaimKeys`、ADR 0320）が同じ主張の対に
違う predicate を割り当てた——同じ会話内でも**別の `observe()` 呼び出し
（別ターン）をまたぐと**、ADR 0315 §3.2 が示した「バッチ内では100%一致する」
という保証が及ばない。`knownPredicates` を渡していないため、ADR 0315/0320の
実測どおりの弱点がそのまま出た。

#### (d) 誤検出1件 — `other-period-city-this-year`（訂正ではない）

`work_location` で claim key が一致した（「今年は福岡で働いている。」/
「去年は札幌で働いていた。」）。`ingestConversation` は `validFrom`/
`validUntil` を一度も渡さないため、両方 `null`（無期限）のまま重なり判定に
掛かり、**時期が違うだけの正当な2つの事実が `contested` になった**
（ADR 0324 の `travel` 対と同じ構造の負債——あちらは有効期間を意図的に
仕込んで防いだが、`answer` 経路はまだ仕込んでいない）。

#### (g) `contested` になっても、対向が自然に withinLimit に入っていると `companionOf` が立たない — 真の訂正・誤検出のどちらでも発生

`other-period-city-this-year`（誤検出）・`negation-moved-job`（真の訂正）の
2件は claim key が一致し、`markContested` も成功して DB 上は両側とも
`status: 'contested'`・`contested_with_id` 相互参照だった。**それでも
`[矛盾候補:]` タグは出なかった。**

原因は `packages/core/src/recall-runtime.ts` の段3（矛盾の解決と必須の同伴
取得）——`contestedNeedingCompanion`（`withinLimit` の中で対向がまだ
`presentIds` に無いもの）だけが `getMany` で**強制**取得され、その結果だけが
`retrievedVia: 'mandatory_companion'`・`companionOf` を得る。**対向がすでに
`withinLimit`（通常の ANN/語彙候補）に自然に入っていた場合**は、単位組み立て
の「両側とも独立に withinLimit に含まれていたケース」の分岐（同ファイル、
`companion.retrievedVia === "mandatory_companion"` ではない側の `else if`）で
`Unit`（隣接表示）は組まれるが、**`companionOf` は一切設定されない**——
`mnemora-path.ts` の `contradictionCounterpartIds` は `companionOf`
（および逆向きの `other.companionOf === m.memoryId`）だけを見るため、
タグが描画されない。

⚠ **`RecalledMemory` は `status`/`contestedWithId` も公開しない**——
`packages/core/src/recall-runtime.ts`・`docs/recall.md` §8 を読む限り、
呼び出し側（`examples/chat` を含む）が `companionOf` 以外の経路で
「この記憶は誰かと `contested` だ」を知る手段は無い。**この穴は
`companionOf` の付け忘れという実装ミスではなく、「強制取得したときだけ
印を付ける」という段3の設計が、そもそも `contested` かどうかを
呼び出し側へ返す一般の手段を持っていないことの帰結である。**

**本テストの14会話は、いずれもテナントあたり2〜5件という小さい記憶集合で、
質問に直接関係する記憶は両側ともほぼ確実に自然圏内（`withinLimit`）に
入る。**この構造だと (g) がほぼ常に発生すると考えられる——ただし
**これは確かめていない**（大きい記憶集合・budget による切り詰めがある
場合に、対向が自然圏外へ落ちて `mandatory_companion` 経由になる頻度は
未測定）。

### 2. 誤検出は回答品質を悪化させていない（現時点では）

`other-period-city-this-year` は `[矛盾候補:]` が描画されない以上、
opt-in ありのプロンプトは opt-in なしと**バイト完全一致**（下記3）——
誤検出は DB の `status` を汚しているが、`answer` の出力には現時点で
一切影響していない。

### 3. A/B（opt-in あり・なし）の記憶集合は同一。answer-trials の差はサンプリングの揺れ

`loadAnswerTrialsMaterial(answer.claim-key.json)` と
`loadAnswerTrialsMaterial(answer.order-legend.json)` を比較し、dev 6件全ての
`rawContent`（mnemora プロンプト本体）が**バイト完全一致**・`fingerprint`
（`caseId`/`question`/`system`/`totalInScope`/`presented`/`lines` の sha256）
も6/6一致した——claimKey 派生・検出はどのケースでも最終描画に1バイトの
差も作らなかった（上記1の帰結そのもの）。基準Bは main の
`answer.order-legend.json`（いまの記録）をそのまま使用——A/B が構造的に
同一の記憶集合であることが確認できたため、同じ回に opt-in なしで
録り直す追加費用は不要と判断した。

`answer-trials`（`RunAnswerTrialsOptions.material` へ直接材料を渡す、
ADR 0301 が既に持つ口）で `recorded` 描画・n=5（dev 全6件）・n=15
（`schedule-change-meeting-day` のみ）を A/B とも実行:

| ケース | A(opt-in) n=5 pass/fail | B(基準) n=5 pass/fail |
|---|---|---|
| pref-tea-over-coffee | 5/0 | 5/0 |
| schedule-change-meeting-day | 5/0 | 4/1 |
| negation-moved-city | 5/0 | 5/0 |
| other-person-birthday | 5/0 | 5/0 |
| other-period-city-this-year（誤検出ケース） | 5/0 | 5/0 |
| unknown-blood-type | 5/0 | 5/0 |

| schedule-change-meeting-day | n=15 pass/fail |
|---|---|
| A(opt-in) | 12/3 |
| B(基準) | 14/1 |

プロンプトが A/B でバイト同一である以上、上の差は温度未指定の実 API
サンプリング揺れであり（ADR 0301 決定4と同じ限界——temperature はこの器
からは観測できない）、opt-in による質の変化ではない。

eval は `answer-trials` が受け付けない設計（ADR 0301 決定6）のため、
記録スクリプトの1回の実行結果だけを記録する: `eval-misattribution-order-swapped`
naive/mnemora とも pass、`eval-inferred-habit-not-attributed-to-user` も
pass（PR #698 追記時の初回実測と同じ）。`schedule-change-deadline` は
mnemora fail だが、PR #716 が「旧カセットでも同じ fail」と記録済みの
既知の非回帰（本 PR 由来の退行ではない）。

### 4. 呼び出し回数・費用

| 段 | 呼び出し | 費用 |
|---|---|---|
| 記録（`record-answer-claim-key.ts`、種カセット併用） | chat 26 / embedding 0（種命中 LLM 76・実API 26、embedding 46/0） | $0.001518 |
| answer-trials A/B dev全6件 n=5（各30回） | chat 60 | $0.002528 |
| answer-trials A/B schedule-change-meeting-day n=15（各15回） | chat 30 | $0.001496 |
| **合計** | **chat 116 / embedding 0** | **$0.005542**（費用上限 $0.50 の約1.1%） |

価格は `examples/chat/src/usage-meter.ts` の
`PRICING_USD_PER_MILLION_TOKENS["gpt-4o-mini"]` と同じ単価定数。

---

## 採らなかった案

### 案A: (g) を `packages/core` で直す（対向が自然に withinLimit に入っていても `companionOf` を立てる、または `RecalledMemory` に `contested`/`contestedWithId` を出す）

**採らない理由**: `recall()` の公開出力（`RecalledMemory`）の振る舞いを変える
変更であり、`packages/core` は npm に公開済み（ADR 0178 の基準）——
「新しい任意フィールドの追加」で済むかもしれないが、**「いつ `companionOf`
が立つか」という既存の意味論を広げる**（今日は「強制取得したときだけ」、
変えれば「対向が候補集合のどこかに在れば常に」）ため、recall の既存利用者
（他の呼び出し側・adapter・適合テスト）への影響範囲をこの PR の裁量では
判断できない。**この ADR はこの案を推奨するとも退けるとも決めない**——
オーナーの判断を仰ぐ材料として記録するに留める（下記「これが覆るとしたら」）。

### 案B: `knownPredicates` を store の既存 predicate 一覧から動的に渡す

**採らない理由**: 決定4参照。(g) が残る限り、predicate の一致率を上げても
`[矛盾候補:]` タグは届かない——**先に (g) の扱いが決まらないと、語彙ヒントの
効果を測る意味が無い**（タグが出ない以上、答えの質にも現れようがない）。
加えて、既存 predicate 一覧を動的に渡す実装は「どのテナント・どの時点の
一覧を使うか」という新しい設計判断を持ち込み、この PR の範囲（opt-in の
配線と実測）を超える。

### 案C: `ingestConversation` に `validFrom`/`validUntil` を渡すようにし、誤検出（決定5(d)）を塞ぐ

**採らない理由**: `answer-case-set.dev.ts`/`.eval.ts` のケース定義は会話文
だけで有効期間を持たない——`answer` ベンチの入力形式そのものを変える必要が
あり、この PR の範囲外。加えて、(g) により誤検出は現時点で無害（タグが
出ないため答えに影響しない）——実害の無い問題を先に塞ぐ優先度は低いと判断した。

---

## 引き受けた負債

### 負債1: (g) の頻度が「小さい記憶集合だから」なのか、一般的な構造なのかを確かめていない

上記「測ったこと」1節の末尾のとおり。大きい記憶集合・budget 切り詰めが
ある場合に (g) がどれだけ起きるかは未測定。

### 負債2: `knownPredicates` を渡した場合の predicate 一致率・(c) の解消率を測っていない

決定4のとおり、意図的に測らなかった。(g) が先に決着しない限り、測る
優先度が低い。

### 負債3: 誤検出（決定5(d)）の頻度が7話題・14ケースという小さい範囲に固有かは分からない

ADR 0324 負債6と同型の限定。

---

## 確かめていないこと

- ⛔ **(g) が大きい記憶集合でも同じ頻度で起きるか**（負債1）。
- ⛔ **`knownPredicates` を渡した場合の (c) の改善幅**（負債2）。
- ⛔ **誤検出率が7話題を超えても同じ頻度か**（負債3）。
- ⛔ **`unresolved_conflict`（3件以上が同じ鍵を持つケース）**——14ケース中0件
  （ADR 0324 と同じく real-fixture では発火せず）。
- ⛔ **`answer` 経路以外（`retrieval`/`compare`）で opt-in した場合の挙動**
  ——この PR は `answer` 経路にしか配線していない。

## これが覆るとしたら

- **オーナーが案A（(g) を `packages/core` で直す）を採る決定を下したとき**
  ——`RecalledMemory` の公開契約が変わり、`[矛盾候補:]` タグが実際に届く
  ケースが増える。そのとき初めて、決定4で保留した `knownPredicates`
  （案B）を測る意味が生まれる。
- **claim key predicate のクロスコール安定化（正規化・統合の後処理、または
  `knownPredicates`）が別途実装されたとき**——(c) の3/4という不一致率が
  下がり、(g) の影響範囲がより広く見えるようになる。
- **`ingestConversation` が `validFrom`/`validUntil` を渡すようになったとき**
  （案C・Issue #689 と同系統の変更）——誤検出（(d)）の実害を測り直す
  必要が生じる。

## 関連

- Issue #691（本 ADR の対象）、Issue #370/#371/#372（claimKey/detectContested
  本体）
- [ADR 0295](./0295-answer-prompt-provenance-rendering.md)（`buildMnemoraPrompt`
  の由来等描画）・[ADR 0309](./0309-answer-prompt-order-legend-and-cassette-migration.md)
  （order-legend 描画・カセット移行）
- [ADR 0301](./0301-answer-trials-same-memory-set.md)（`answer-trials`、同じ
  記憶集合での n 回試行）
- [ADR 0315](./0315-claim-key-does-not-touch-extraction-cassettes.md)（claimKey
  はカセットを壊さない、種カセットの推奨）・[ADR 0320](./0320-claim-key-field-implementation.md)
  （claimKey 実装）・[ADR 0324](./0324-claim-key-contested-detection.md)
  （detectContested 実装、real-fixture 実測30%誤検出の先行研究）
