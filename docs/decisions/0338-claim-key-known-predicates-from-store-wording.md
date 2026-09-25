# ADR 0338: `knownPredicatesFromStore` の語彙ヒントに別の文言・別の見出しを使う — 実測するとトレードオフだった（Issue #835）

- **状態**: 提案 (2026-09-26)
- **日付**: 2026-09-26

**⚠ この PR はクローンの委譲で動く担い手が書いた。投稿者はオーナー本人ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。**この
ADR に出てくる判断はすべて「委譲された担い手の判断（オーナーではない）」である。**オーナーの
確認・承認を得たものではない。

### 出所の凡例（ADR 0185/0315/0320/0324/0326/0329 以降の作法）

| 記号 | 意味 |
|---|---|
| 【実測】 | この作業者が、この器で実際に本物の Postgres + pgvector・`OPENAI_API_KEY` を叩いて得た |
| 【現物】 | この作業者が、リポジトリの現物（コード・文書）を読んで確かめた |
| 【受】 | 人・他のエージェントから受け取った前提。自分で検証していない |

---

## 文脈（[Issue #835](https://github.com/takecchi/mnemora/issues/835)）

[ADR 0329](./0329-claim-key-known-predicates-from-store.md)（`ClaimKeyOptions.
knownPredicatesFromStore`、opt-in）は、store の既存 claim key predicate 一覧を語彙ヒントとして
動的に渡すことで、訂正4件の predicate 一致・`contested` 成立を 0/4 → 4/4 に改善した。
だがその負債1として「無関係な filler 発話どうしが、語彙ヒントに含まれる predicate へ
誤って統合され、`contested` になる」誤検出（`unknown-favorite-number`/
`other-period-city-this-year`）を実測している。

[#832](https://github.com/takecchi/mnemora/pull/832)（[ADR 0335](./0335-recalled-memory-contested-with.md)、
`RecalledMemory.contestedWith`）以降は、`contested` が成立した対には、両方が recall に
返れば必ず `[矛盾候補:]` タグが付く——訂正・誤検出を区別しない（ADR 0335 負債2）。
[#833](https://github.com/takecchi/mnemora/pull/833) の実測（issuecomment-5840380455）は、
`contestedWith` 導入後、誤検出2件（`unknown-favorite-number`/`other-period-city-this-year`）
にも訂正4件と同じ割合（今回は 2/2、3回とも同一）でタグが届くことを確認した——これが
**本 Issue #835 の対象**である。

⛔ **正規化の強化・類義の統合**（[ADR 0320](./0320-claim-key-field-implementation.md) 案B相当）・
**埋め込み類似度による predicate 統合**（[ADR 0134](./0134-mark-contested-explicit-operation.md)
案A(b)・[ADR 0185](./0185-contradiction-detection-path.md) (D) 相当）・**`enabled` からの
自動有効化**（[ADR 0329](./0329-claim-key-known-predicates-from-store.md) 案A相当）・
**`knownSubjectsFromStore`**（[ADR 0334](./0334-claim-key-known-subjects-hint.md) 決定3が
店の自己蓄積した曖昧な値の汚染を理由に却下）は、いずれも既に別の ADR で却下済みであり、
本 ADR では実装しない。

### ⚠ 本 ADR には前例がある——ADR 0329 追記（2026-09-25）は、ほぼ同じ介入を既に試し、否定的結果を得ている

**着手前に見落としていた。** ADR 0329 は「引き受けた負債1」の追記
（2026-09-25、同じくクローンの委譲で動く担い手が書いたもの）で、**まさに本 Issue が求める
介入**——「`knownPredicatesFromStore` を実際に経由した呼び出しだけ新しい文言を使う」——を
4変種（v1〜v4）実測している。結果は否定的だった: **どの変種も、旧文言の run 間の揺れの幅を
明確に超えて誤検出を下げつつ、predicate 一致・`contested` 成立を4/4に保つことはできなかった**
（v1 は predicate 一致を3回に1回落とした——`negation-moved-job`、否定を伴う訂正の取りこぼし）。

本 ADR のマネージャー指示の第一候補文言（「同じ主題・同じ属性について述べている場合にだけ
そのまま使う。話題が違う・迷う場合は新しい predicate を作る」）は、ADR 0329 追記の v1
（「ある記憶が、一覧のいずれかと同じ主体の同じ属性について述べていると確信できる場合に限り、
その predicate をそのまま使ってください...」）と**意味的にほぼ同じ**である。⟹ **本 ADR は
実質的に v1 を、`contestedWith`（#832）導入後の main・別の6ケース部分集合・別の見出し構造
（下記決定1）で再実測したものである。**

**この前例は、実 API を叩く前ではなく、実装・単体テストを終えた後で見つけた**——
`docs/decisions/0329-*.md` を読み返した際に気づいた。⟹ **「探した場所を列挙する」
（`AGENTS.md`）**: この前例は `docs/decisions/0329-claim-key-known-predicates-from-store.md`
の「引き受けた負債」節の追記（2026-09-25）に在り、grep（`buildKnownPredicateInstruction`・
`否定的結果`）で辿った。他の ADR に同種の前例が無いかは、`docs/decisions/` 全体を
網羅的に grep していない——当たった範囲での結果であり、断定ではない。

---

## 決定

### 決定1: store 由来の語彙だけ、別の文言・別の見出しで system プロンプトへ足す

`packages/core/src/claim-key.ts` に `buildKnownPredicateFromStoreInstruction` を新設した。
`buildKnownPredicateInstruction`（呼び出し側が明示的に渡す `knownPredicates` 用、既存のまま
1バイトも変えていない）とは別の関数であり、次の性質を持つ:

- **見出しを分ける**: 「既知の predicate 候補一覧」ではなく「過去の記憶から集めた predicate
  候補一覧」。
- **文言を弱める**: 「この一覧に当てはまる場合は必ずそのまま使い」（旧・強い指示）ではなく、
  「この一覧の項目は、今回の記憶が同じ主題・同じ属性について述べている場合にだけそのまま
  使ってください。話題が違う場合や、当てはまるか迷う場合は、新しい predicate を作って
  ください」（新・弱めた再利用条件）。

`buildClaimKeyPrompt`/`deriveClaimKeys`（`packages/core/src/claim-key.ts`）に、いずれも
**末尾に追加した任意引数** `knownPredicatesFromStore?: readonly string[]` を新設した——
既存の3引数（`contents`/`knownPredicates`/`knownSubjects`）は1つも変えていない。

`packages/core/src/runtime.ts` の `resolveKnownPredicates` は、利用者が明示的に渡した
`knownPredicates` と、店から集めた分（`ClaimKeyOptions.knownPredicatesFromStore`）を、
**もう1本の配列へ合成しない**よう変更した——以前はここで1本の配列（利用者分を先に、店分を
重複除去して後ろに連結）へ合成し、`buildKnownPredicateInstruction` へ渡していたが、いまは
`{ knownPredicates, knownPredicatesFromStore }` の2本を別々に返し、`deriveClaimKeys` の
別々の引数へ渡す。**利用者分・店分それぞれの重複除去、「利用者分を先に」の優先順位（店分は
利用者分と重複する predicate を除いて渡す）は変えていない。**

**両方渡したときの並び順**: `既知の predicate 候補一覧`（利用者分）→ `過去の記憶から
集めた predicate 候補一覧`（店分）→ `既知の subject 候補一覧`（`knownSubjects`）。

**この設計を選んだ理由**（マネージャー指示「別の見出しで示す」案との統合）:
マネージャー指示の第一候補（「store 由来の語彙があるときだけ、ヒントの文言を弱める」）と、
比較対象として挙げられた別案（「store 由来の語彙を別の見出しで示す」）は、**両立できる**
——見出しを分けることで、「利用者が渡した分」と「店が集めた分」に別々の文言をそれぞれ
そのまま適用でき、「両方あるときに文言をどう分けるか」（マネージャー指示が検討を求めた点）
に自然に答えが出る: **利用者分は常に旧文言のまま。店分だけ新文言。**

### 決定2: 公開型は追加のみ

`buildClaimKeyPrompt`/`deriveClaimKeys` の追加引数はいずれも4番目・末尾かつ任意
（`scripts/__snapshots__/public-api/core.d.ts` を更新済み。関数シグネチャの再フォーマットの
みで、削除・必須化・型の狭小化は無い）。`ClaimKeyOptions`（公開 interface）自体は変更して
いない——`knownPredicatesFromStore` は ADR 0329 で既に足された既存欄であり、本 ADR は
その内部での扱い（配線の分岐）だけを変えた。

### 決定3: 対象は 6 ケース（訂正4件 + 誤検出2件）に絞った実測

予算（gpt-4o-mini、合計150回まで）に収めるため、`examples/chat/src/answer-case-set.dev.ts`/
`.eval.ts` の14ケース全部ではなく、次の6ケースだけを対象に、新しい測定スクリプト
`examples/chat/src/scripts/measure-claim-key-835.ts` を書いた:

- 訂正4件: `schedule-change-meeting-day`・`negation-moved-city`・`schedule-change-deadline`・
  `negation-moved-job`（ADR 0329「測ったこと」1節と同じ4件）
- 誤検出2件: `unknown-favorite-number`・`other-period-city-this-year`（Issue #835 本文・
  ADR 0329「測ったこと」3節と同じ2件）

**`record-answer-claim-key.ts`（ADR 0329・#833）との違い**: `runAnswerCase`
（回答生成・judge を含む）ではなく `ingestConversation` だけを呼ぶ——マネージャー指示
「claimKey の派生と contested の成立までを見れば十分（回答生成と採点は不要）」に従った。
これにより、1回のフル実行（6ケース・全ターン）が実 API 呼び出し20回で済む
（内訳: 抽出は種カセット `answer.order-legend.json` に100%一致し実 API 0回、claim key
派生だけが常に実 API に落ちる——種カセットには claim key 呼び出しが1件も無いため）。

種カセットは常に `answer.order-legend.json` だけ（ADR 0329 決定6と同じ理由）。**既存カセット
は1バイトも変更していない**——新しく作ったのは `answer.claim-key.contested-with-835-{1,2,3}.json`
の3ファイルだけ（`git status --porcelain` で確認済み、下記「測ったこと」参照）。

---

## 測ったこと

### 単体テスト（決定的、実 API 不要）

`packages/core/src/__tests__/claim-key.test.ts`・`runtime.test.ts` に次を追加した:

- (a) opt-in でない（何も渡さない）呼び出し・`knownPredicates` だけの呼び出しは、
  `CLAIM_KEY_PROMPT_SYSTEM` および既存の `buildKnownPredicateInstruction` の組み立てと
  1バイトも変わらないことを固定する歯（`buildClaimKeyPrompt`/`deriveClaimKeys` 双方）。
- (b) `knownPredicatesFromStore` を渡すと、既存の「既知の predicate 候補一覧」とは別の
  見出し・別の（弱めた）文言（「必ずそのまま使い」を含まない）で足されることを固定する歯。
- 利用者分・店分の両方を渡したときの並び順（predicate → 店分 → subject）を固定する歯。
- `runtime.ts` 側は、利用者が渡した `knownPredicates` と店から集めた分が、別の見出し・
  別の文言で system へ足される（重複は店側から除く）ことを固定する歯——既存の「利用者の
  knownPredicates を先に、店から集めた一覧を後ろに、重複を除いて連結する」歯を、この新しい
  挙動に合わせて書き換えた（旧: 1本の配列への連結を検査。新: 2本の別々の文言・見出しを検査）。

**赤→緑・変異試験【実測】**:

1. `buildKnownPredicateFromStoreInstruction` の文言を旧文言（「必ずそのまま使い」）に
   戻す変異 → (b) の歯が red（`not.toContain("必ずそのまま使い")` が失敗）。元に戻すと
   green に戻ることを確認した。
2. `runtime.ts` の `resolveKnownPredicates` を「1本の配列へ合成する」旧実装に戻す変異
   → `runtime.test.ts` の「利用者の knownPredicates と、店から集めた分は、別の見出し・
   別の文言で system へ足される」歯が red（旧文言「既知の predicate 候補一覧:
   user_chosen_hint, favorite_food, favorite_color。」がそのまま出て、新しい期待と食い違う）。
   元に戻すと green に戻ることを確認した。

（変異はいずれも `cp` で退避 → 変異を入れて red を確認 → `cp` で戻す → green に戻ることを
確認、という手順——`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」に従った。）

**既存のカセット再生テストへの影響**: `examples/chat/src` を
`grep -rn "ANSWER_CLAIM_KEY_CASSETTE_PATH\|answer\.claim-key\|contested-with"` で検索した
範囲では、`answer.claim-key*`/`*.contested-with-*` のいずれのカセットも読み直す
`.test.ts` は1本も無い（`ANSWER_CLAIM_KEY_CASSETTE_PATH` の参照は `cassette-io.ts`
（パス定義）と `record-answer-claim-key.ts`（書き出すだけ）の2箇所のみ）——これらは
純粋な実測記録（`AGENTS.md`「実測して repo にコミットした基準値」の対象外）であり、
既定の経路のカセット再生検査（`cassette-coverage.test.ts` 等、`ANSWER_CASSETTE_PATH`/
`COMPARE_CASSETTE_PATH`/`RETRIEVAL_CASSETTE_PATH` 等別のカセットを見るもの）はいずれも
本 PR の変更と無関係——`vitest run` をファイル指定で実行し green のままであることを
確認した（`answer-claim-key-options.test.ts`・`cassette-coverage.test.ts`・
`schema-type-equals-parity.test.ts`）。

### 実 API（gpt-4o-mini、n=3、現在の main + 本 PR の変更）

【実測】2026-09-26、`initdb`（PostgreSQL 17、pgvector・btree_gin・pgcrypto、専用ポート・
作業ツリー外）で立てた専用インスタンス。6ケース・n=3、`measure-claim-key-835.ts`。

呼び出し回数: 3 run とも chat 20回・embedding 0回、**合計 chat 60回**（150回の予算内）。

**旧文言（本 PR 前、既存カセット `examples/chat/cassettes/answer.claim-key.
known-predicates-{1,2,3}.json`、ADR 0329・#833 実測を参照）**: 訂正4件の predicate 一致
4/4・`contested` 成立 4/4（3回とも）。誤検出2件は2件とも成立（2/2、3回とも同一
——issuecomment-5840380455）。

**新文言（本 PR、今回実測）**:

| run | 訂正4件 predicate一致 | 訂正4件 contested成立 | 誤検出2件成立 | 誤検出の内訳 |
|---|---|---|---|---|
| 1 | 3/4（`negation-moved-job` 不一致: `previous_occupation`/`current_occupation`） | 3/4 | 1/2 | `other-period-city-this-year` のみ |
| 2 | 3/4（`negation-moved-job` 不一致: `previous_occupation`/`current_occupation`） | 3/4 | 1/2 | `unknown-favorite-number` のみ |
| 3 | 4/4（`negation-moved-job` も `occupation` で一致） | 4/4 | 2/2 | 両方 |

### 判定: 明確な改善ではなくトレードオフ

**マネージャー指示の採否基準（「訂正4件の到達を落とさず、誤検出を減らせるか」）を満たさない。**
3回中2回、`negation-moved-job`（否定を伴う訂正）の predicate 一致・`contested` 成立が
落ちた——これは ADR 0329 追記の v1 が実測した失敗モード（「predicate 一致を3回に1回
落とした——`negation-moved-job`、否定を伴う訂正の取りこぼし」）と**同じケース・同じ方向**
で再現している。誤検出側は run2・run3では改善するが run3では旧文言と同じ2/2のまま——
**run 間の揺れが大きく、「減った」と言い切れる範囲を超えていない。**

**推測される機構**: `negation-moved-job` の2つの claim key 呼び出し（「以前はエンジニア
として働いていました。」と「現在はデザイナーとして働いている」）は**別々の `observe()`
呼び出し・別々のバッチ**であり、後者の呼び出し時点で店には前者の predicate（例:
`former_profession`）が既に存在する。**旧文言（「必ずそのまま使い」）はこの状況でほぼ
確実に再利用させていた**（ADR 0329 実測: 3回とも4/4）。**新文言（「同じ主題・同じ属性の
ときに限り再利用」）は、"以前の職業" という属性のヒントに対して "いまの職業" という発話を
同じ属性と判断するかどうかを LLM の判断に委ねてしまい、否定・更新を伴う言い換えで時々
「同じ属性ではない」と判断されて新しい predicate を作ってしまう——ADR 0329 追記の v1が
同じケースで観測した機構と一致する。

---

## 案の比較

| 案 | 内容 | 帰結 |
|---|---|---|
| **A（採用・本 ADR）** | store 由来の語彙だけ、別の見出し・弱めた文言 | 実装は追加のみで安全。real 効果はトレードオフ（上記）——ADR 0329 追記 v1 と同型の限界を持つ |
| B | 店由来の語彙も、利用者由来の語彙と同じ強い文言のまま（現状維持・本 PR 差し戻し） | Issue #835 の誤検出は直らないまま。ADR 0329 の負債1として据え置き |
| C | 店由来の語彙を出さない（`knownPredicatesFromStore` 自体を使わない） | 誤検出は0に戻るが、ADR 0329 が改善した訂正4件の predicate 一致（0/4→4/4）も失う——ADR 0326・0329 の成果を丸ごと捨てる。今回は検討したが実装しない（Issue #835 の範囲外——`knownPredicatesFromStore` 自体を止めるかどうかはオーナー判断） |

**案Aを実装し、PR は draft のまま・ADR の状態は「提案」に留めた**理由: 実測がトレードオフを
示した以上、「これで直った」と主張できない。実装・単体テスト・real 実測の記録そのものは
（ADR 0329 追記が「コードへ反映しない」という判断をしたのとは違う形で）**残す価値がある**
——(1) 公開型・既定経路は1バイトも変わらないので安全に取り込める、(2) 将来 (g) を直す
判断（ADR 0329「これが覆るとしたら」参照）と合わせて、この語彙ヒント文言の設計判断も
再検討が必要になる可能性が高く、その時の材料として今回の実測（ADR 0329 v1 との一致を
含む）を残しておく方が、次に同じ実験を繰り返すよりも安価だと判断した。**最終的にこの案を
採用するか、案B（差し戻し）にするかは、オーナー（またはオーナーから委譲された次の担い手）の
判断に委ねる。**

---

## 引き受けた負債・未解決の点

### 未解決1（既定経路の問題、本 PR の対象外）: `other-period-city-this-year` は既定の `detect` 経路でも起こりうる構造的な誤検出

「去年は札幌で働いていた。今年は福岡で働いている。」は**1回の `observe()` 呼び出し**
（1バッチ）で両方の候補が抽出される。`CLAIM_KEY_PROMPT_SYSTEM` 本体（既定の `detect` 経路
でも使われる、opt-in でない部分）が「同じ主題・属性について複数回言及されている記憶には
...同じ subject と predicate を返してください（言い換えを統合すること）」と指示している
ため、**`knownPredicatesFromStore` の有無に関わらず**、同じバッチ内の「今年」「去年」の
2つの期間についての記述が同じ predicate（例: `work_location`）に統合されやすい。
`validFrom`/`validUntil` を渡していないため、統合された2件は有効期間が重なり、
`detectContested` が `contested` を成立させる（ADR 0326 (d) と同一の構造的原因）。

**本 PR はこれを直さない**——マネージャー指示「既定の detect の経路...は1バイトも変えない
こと」に従い、`CLAIM_KEY_PROMPT_SYSTEM` 本体（既定経路が使う部分）には一切触れていない。
この問題を直すには `validFrom`/`validUntil` を claim key 派生か抽出のどちらかへ渡す設計
（ADR 0326「採らなかった案C」）か、`CLAIM_KEY_PROMPT_SYSTEM` 本体の「言い換えを統合する」
指示自体の見直しが要る——どちらも本 Issue #835（opt-in 経路限定）の範囲を超える。

### 負債1: 本 PR の文言変更は、訂正4件の到達を安定して保てない（`negation-moved-job`）

上記「実 API」節参照。3回中2回、`negation-moved-job` の predicate 一致・`contested` 成立が
落ちた。**この失敗モードは ADR 0329 追記の v1 と同一**——本 ADR の変更をそのまま有効化する
運用は、ADR 0329 が実測した「0/4→4/4」の改善を部分的に後退させるリスクを持つ。

### 負債2: n=3・6ケースという小さい範囲でしか測っていない

14ケース全部・n=3を超える反復（ADR 0329 追記が「次の手がかり」として未測定と書いていた
n=10 等）では、揺れの幅・傾向が変わる可能性がある——本 ADR は測っていない。

### 負債3: ADR 0329 の負債2（(g) が残る限り predicate 一致の改善は `[矛盾候補:]` タグに
届かない）は解消されていない

本 ADR は claim key 派生の文言だけを扱っており、`recall-runtime.ts` の段3
（`companionOf` の付与）には一切触れていない。#832（`contestedWith`）で「自然に候補に
入った対」は届くようになったが、それ以外の経路（片方が予算で落ちる等）は ADR 0326
「採らなかった案A」のまま未着手。

---

## 確かめていないこと

- ⛔ **14ケース全部・n=3を超える反復での傾向**（負債2）。
- ⛔ **`negation-moved-job` の失敗モードが、この特定の言い回し（「以前は...」「いまは...
  ではなく」という否定を伴う更新）に固有か、他の否定を伴う訂正一般に起きるか。**
- ⛔ **本 ADR の文言（決定1）以外の変種**（例: ADR 0329 追記の v2〜v4 に相当する店由来
  専用の変種、確信度を別途返させる設計、user message 側へ移す設計）は、予算の都合上
  本 ADR では試していない——ADR 0329 追記が既に v1〜v4 を実測して否定的結果を得ている
  ことを踏まえると、追加の文言変種を試す前に、負債3（(g) 自体を直すかどうか）の方向性を
  オーナーが決める方が優先度が高いと考えるが、これはこの PR の裁量を超える判断である。
- ⛔ **誤検出2件にタグが実際に届く割合が、`contestedWith`（#832）導入後もなお run ごとに
  揺れるか**——本 ADR は `ingestConversation` までしか測っておらず、recall・
  `[矛盾候補:]` タグの描画までは測っていない（マネージャー指示どおり範囲外としたため）。

## これが覆るとしたら

- **オーナーが案B（差し戻し）を選んだとき**——本 ADR の実装は追加のみ・可逆であり、
  `packages/core/src/claim-key.ts`/`runtime.ts` の該当箇所と、対応する単体テストを
  戻すだけで良い。
- **オーナーが ADR 0326「採らなかった案A」（(g) を `packages/core` で直す）を先に採る
  決定を下したとき**——その時点で、この語彙ヒント文言の設計判断も合わせて再検討が
  必要になる（負債3参照）。
- **`negation-moved-job` 型の失敗モードを避けつつ誤検出を減らす、別の設計**
  （案の比較・確かめていないこと参照）が見つかったとき。

## 関連

- [Issue #835](https://github.com/takecchi/mnemora/issues/835)（本 ADR の対象）
- [ADR 0329](./0329-claim-key-known-predicates-from-store.md)（`knownPredicatesFromStore`
  本体、負債1・追記の否定的結果——本 ADR の前例）
- [ADR 0335](./0335-recalled-memory-contested-with.md)（`contestedWith`、誤検出にもタグが
  届くようになった原因）
- [ADR 0324](./0324-claim-key-contested-detection.md)（`detectContested`・
  `findActiveByClaimKey?`）・[ADR 0334](./0334-claim-key-known-subjects-hint.md)
  （`knownSubjects`・store 版を却下した先例）
- [ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)（(a)〜(g) の
  切り分け、(d)（未解決1）・「採らなかった案A」（負債3）の出所）
