# ADR 0295: 回答プロンプトに由来・話者・主題・矛盾関係を描画する形式を決める（Issue #691、`examples/chat` 限定・非破壊）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 / ADR 0289 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `vitest` / `tsc` / `node` / `tsx` を走らせて確かめた。
- **【受】** — Issue 本文・レビュー指摘として受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は本 PR の分岐元 `4e24b0b`（`main`）の木で、2026-09-25 に行った。
**DB（Postgres）は本作業の環境に無い**——DB を要する検証（実際の `answer` 12ケースを
`recall()` に通した新書式の実測、`answer-cli.postgres.test.ts` の実行そのもの）は行っていない。
該当箇所はその都度「未実測」と明記する。

---

## 1. 文脈

[Issue #691](https://github.com/takecchi/mnemora/issues/691)（確認対象 `cd76220`、
このセッションのレビュー指摘3）: `examples/chat/src/mnemora-path.ts` の
`buildMnemoraPrompt` は `recall.memories[].digest` だけを箇条書きにし、`packages/core`
が `RecalledMemory` に持つ `provenanceKind`（由来）・`speaker`（話者、Issue #579 案D・
ADR 0289）・`subjectId`（主題、同）・`companionOf`/`retrievedVia`（矛盾関係、
`docs/recall.md` §8）を回答生成モデルへ一切伝えていなかった。

完了条件（Issue 本文、逐語）:

- recalled memory の由来、話者、主題、矛盾関係をプロンプトで表現する。欠落値を推測しない。
- stated/inferred/reflected/consolidated と対向記憶、同文で別話者のケースを実装前に定義する。
- 実際に渡す文字数・トークン量に追加メタデータを含め、既存の量比較との違いを明示する。
- 純粋な描画契約のテストと、誤帰属・推論の断定を検知する回答評価を区別する。
- 表示を落とす変異で赤、復元で緑。録音変更の必要性・結果を記録して PR を作る。

**本 PR の範囲は `examples/chat` に閉じる。** `packages/core` の型・runtime は変更しない
（ADR 0289 が既に必須欄として値を保証している）。

## 2. 決めたこと

### 決定1: タグ付き1行描画。欄の順序は 由来 → 話者 → 主題 → 矛盾候補 → digest 本文

```
- [由来:stated] [話者:太郎] [主題:user-1] 好きな色は青
```

理由: 元の `- ${digest}` という1行1件の形をなるべく壊さず、digest 本文を最後に
残すことで既存の「箇条書きの読みやすさ」を保つ。タグは `[key:value]` という
機械可読な形にし、自然文で埋め込まない（自然文にすると、回答モデルが
タグの中身とdigest本文を混同しやすくなる——北極星の問い4「AIの推論とユーザーが
言った事実を区別する」への配慮）。

### 決定2: 由来（`provenanceKind`）は生の値をそのまま出す。日本語訳の対応表は作らない

`ProvenanceKindSchema`（`packages/core/src/provenance.ts`）は5値の閉じたユニオンの
綴りを1箇所に集約する設計になっている（同ファイルの docstring）。ここに日本語訳の
対応表（例: `stated → "本人の発言"`）を新設すると、**綴りの正本が2箇所になり**、
6値目が core に増えたときにこちらが追随を忘れる経路が生まれる。`verdictGlyph`
（`answer-format.ts`）のように exhaustive switch で防御する手もあるが、
「英語の kind 値をそのまま出す」ほうが単純であり、回答生成モデルは日本語の指示文の
中に混じった英単語の意味（`stated`=言明・`inferred`=推論）を読めるという前提を置く
——読めない場合は system prompt 側で kind の意味を注記する余地を残す（本 PR ではしない）。

### 決定3: 話者欄は `provenanceKind === "stated"` のときだけ出す。他の kind では欄自体を消す

`RecalledMemory.speaker` の docstring（ADR 0289）が明言するとおり、`stated` 以外の
kind は「話者を頼んだが分からなかった」のではなく「話者という概念がその kind には
無い」。ここで `stated` の `speaker: null`（頼んだが無かった）と同じ「不明」表示に
倒すと、**推論・統合・内省・インポートされた記憶にも「話者不明」という札が付き、
あたかも人が言ったが記録が不完全なだけ、という誤読を招く**——北極星の問い4
「AI の推論とユーザーが言った事実を区別する」に反する。⟹ **kind による欄の有無**と
**値の有無（null）**を、別の表現で区別する。

### 決定4: 欠落値は「不明」/「なし」で明示し、他の値で埋めない

`speaker: null`（stated だが話者不詳）→ `[話者:不明]`。
`subjectId: null`（どの kind でも起こりうる。統合が subject をまたいだ場合を含む、
ADR 0289）→ `[主題:なし]`。**"user" のような既定値や、他の memory の主題を
代表値として書かない**——Issue #691 完了条件1「欠落値を推測しない」の直接の実装。

### 決定5: 主題欄は全 kind で常に出す

`subjectId` は kind に依存せず Memory 自身の値をそのまま引き継ぐ欄（ADR 0289）
なので、由来欄と違って「持ちようが無い kind」が無い。⟹ 話者欄と違い、
**常に出す**（値が無ければ決定4の「なし」）。

### 決定6: 矛盾関係は `recall.memories` 全体を見て対称に描画し、中身は相手の digest 本文を埋める

`RecalledMemory` 単体では矛盾関係が非対称にしか表現できない——`companionOf` を
持つのは同伴取得された側（`retrievedVia: "mandatory_companion"`）だけで、
争いの起点になった通常スコアの側にはそれを指す欄が無い（`docs/recall.md` §8）。
回答生成モデルにとって重要なのは「どちらが起点か」ではなく「これら2件は対立して
いるので両方を独立した事実として扱わない」ことなので、`buildMnemoraPrompt` は
`recall.memories` 配列全体を1度スキャンし、`companionOf` の向き先・向かれ元の
**両方**に矛盾の印を対称に出す。

印の中身は相手の `memoryId` ではなく**相手の digest 本文**を埋め込む
（`[矛盾候補:「<相手の digest>」]`）。理由: 回答生成モデルは `memoryId` と
箇条書きの対応表を持たない——digest 本文を並べた1本のプロンプト文字列しか渡され
ないため、`memoryId` を出しても「どの行と対立するか」をモデルが解決できない。
本文を直接埋め込めば、その場で対立が読める。

### 決定7: 相手が見つからない想定外入力では、本文を捏造せず `memoryId` + 「本文未取得」を出す

`companionOf` が指す先が `recall.memories` の中に無い場合（budget 切り詰めの
実装が壊れて片方だけ残った、等の想定外の状態）、決定6の「本文を埋め込む」を
維持できない。ここで本文を空文字や別の値で埋めると Issue #691 完了条件1に反する
ため、**`memoryId=<id>（本文未取得）`という、値を持たないことを名乗る印**を出す。

### 決定8（変異試験で発見・訂正）: 矛盾関係の相手特定は `companionOf` の値で行い、配列上の位置に依存させない

実装時の変異試験で、「`companionOf` を無視して常に先頭要素を相手だと取り違える」
という壊れた実装が、当初のケース定義（起点記憶がたまたま `memories[0]`）だけでは
見逃されることを実測した（`companion-counterpart-missing` だけが赤になり、
`contradiction-pair` は緑のまま通過した）。⟹ 起点記憶を `memories[1]` に配置した
`contradiction-pair-owner-not-first` ケースを追加し、この変異が確実に赤になる
ことを確認した上でケース集合を確定した。**ケース定義は実装前に固定した後も、
変異試験で発見した抜け穴を理由に補強してよい**——完了条件が求める「変異で赤」を
実際に満たすかどうかが、ケース集合そのものの正しさの検証だからである。

## 3. 量への影響——`compare` の `mnemoraChars` との関係

`docs/recall.md` §6「正直に書くべき限界: mnemora はプロンプトを組み立てない」が
既に明記しているとおり、`compare.ts` の `mnemoraChars`（`compare.ts:188`）は
`recall.usage.chars` を直接使っており、**`recall()` 自身が返した量**である。
一方 `buildMnemoraPrompt` は `examples/chat` 側（呼び出し側の役）がその `recall`
結果を元に**独自に**プロンプト文字列を組み立てる関数であり、両者は元から
一致しない（`indexLine` の1行を `buildMnemoraPrompt` だけが足していた、本 PR 以前
からの既知の差）。

**本 PR は、この既知の差をさらに広げる。** `buildMnemoraPrompt` の出力が
digest 本文に加えて由来・話者・主題・矛盾候補のタグを足すため、`mnemoraChars`
（＝ `usage.chars`）はこの増分を一切反映しない。⟹ **`compare` の量比較を見て
「mnemora 経路がこれだけの文字数で済んでいる」と読む場合、その数字は
`buildMnemoraPrompt` が実際にモデルへ渡す量より必ず小さい**（本 PR 以前からそうで
あったが、乖離の絶対値が広がる）。

### 実測（フィクスチャベース、DB不要）

`examples/chat/src/__tests__/provenance-prompt-cases.ts` の10ケースで、
旧 `buildMnemoraPrompt`（digest のみ）と新実装を比較【実測 2026-09-25、
`tsx` で直接実行】:

| 指標 | 旧（合計） | 新（合計） | 比 |
|---|---|---|---|
| 文字数 | 384 | 896 | **2.33倍** |
| トークン概算（`heuristicTokenCounter`） | 256 | 483 | **1.89倍** |

矛盾関係が無い単発ケース（stated/inferred/reflected/consolidated/imported、
1件ずつ）だけで見ると、増分は1件あたり23〜32文字（由来+主題のタグ、話者ありなら
+speakerの文字数分）。矛盾ペアを含むケースは、相手の digest 本文を丸ごと
埋め込むため増分が大きい（+64〜+128文字/ペア）。

### 実 `answer` 12ケースでの実測——旧側のみ（DB不要、カセットから直接抽出）

`examples/chat/cassettes/answer.json`（2026-09-17 録画）に記録された、実際に
`answer` の12ケース（dev 6・eval 6）で mnemora 経路が生成した**旧形式**の
プロンプト（`buildMnemoraPrompt` の出力部分、質問文を除く）を直接読み出した
【実測 2026-09-25、cassette の JSON を直接読み、`"索引:"` を含む
`answer` プロンプト12件を特定】:

- 合計文字数: **1010文字**（12ケース、`totalInScope`/`shown` はケースごとに
  1〜5件、合計 memories 数36件）
- ケースごとの範囲: 38〜123文字

**新形式でのこの12ケースの実測値は無い**——`recall()` を実際に実行する必要があり、
本作業の環境に DB（Postgres）が無いため実行できない。フィクスチャの比率
（1.9〜2.3倍）から類推すること自体は可能だが、**実測値の顔で書かない**
（本 repo の原則、`docs/recall.md` 各所）——推定は推定であり、実行環境（DB）が
揃ったとき（CI、またはオーナー・別担当者の手元）に `queryRecall` +
`buildMnemoraPrompt` を12ケース分回して実測することを推奨する。この実測は
**`complete()`（回答生成）を呼ばずに `recall()` の結果だけを見れば済む**ため、
下記§4のカセット不整合とは無関係に実行できる（抽出・埋め込みの記録は
本 PR で変更していないため、`recorded` モードのままで再現できる）。

## 4. カセットへの影響——`answer` の recorded 再生は壊れる

`packages/testkit/src/__fixtures__/cassette.ts` の `llmCassetteKey` は
`PromptSpec`（`system` + `messages`）を正準化した JSON の SHA-256 を鍵にする。
`buildMnemoraPrompt` の出力を変えたことで、mnemora 経路の回答生成プロンプト
（`answer-bench.ts` の `mnemoraPromptSpec`）の内容が変わり、鍵も変わる。

**【実測 2026-09-25】** DB を使わずに次を確認した: `examples/chat/cassettes/answer.json`
の67エントリのうち、`"索引:"` を含む12件（mnemora 経路の回答生成プロンプト、
dev 6・eval 6 の全ケース）それぞれについて、実際の recall() が**最低限**必ず
追加するタグ（`provenanceKind`・`subjectId` は必須欄なので、少なくとも
`[由来:...] [主題:...]` 相当の文字列が各 digest 行の先頭に挿入される）を
模した最小限の変異を録画済みプロンプト文字列へ機械的に適用し、
`llmCassetteKey` で鍵を引き直したところ、**12件全てで鍵が変わり、カセットに
記録が見つからなくなった**（`mutatedFound: false` × 12）。

⟹ **`answer-cli.postgres.test.ts`（`MNEMORA_PROVIDER_SOURCE=recorded` を明示し、
実 `runAnswerBench` を子プロセスで走らせる歯、Issue #547）は、この変更を含む
PR が CI（`example-chat` ジョブ、DB あり）で走ると、12ケース全てで
`RecordedLLMProvider`「記録に無い」の例外により失敗する見込みが高い。**
（`answer-bench.postgres.test.ts` は `env: {}` で `deterministic` を強制しており
`RecordedLLMProvider` を経由しないため、この歯は影響を受けない——本文の判定の
とおり。）

**録り直すには実 OpenAI API 呼び出しと課金が必要であり、鍵も本作業の環境には
無い。これはオーナーの判断領域である**（PR 作成時の絶対の線、および
`provenance-trace.test.ts` が Issue #498 完了条件4で既に同じ理由を記録している
先例）。本 PR はカセットを録り直さない。マージ判断・録り直しのタイミングは
オーナーに委ねる。

## 5. 回答評価（誤帰属・推論の断定の検知）は本 PR の範囲外のまま残す

Issue #691 完了条件は「純粋な描画契約のテストと、誤帰属・推論の断定を検知する
回答評価を区別する」ことを求める。本 PR が実装・検証したのは前者
（`provenance-prompt-contract.test.ts`、DB もLLMも呼ばない純関数の契約テスト）
だけである。

後者（回答生成モデルが実際に「由来を無視して断定する」「推論を事実として話す」
といった誤りを犯すかどうかを検知する評価）は:

- 実行するには回答生成モデルの応答が要り、`recorded` モードは§4の理由で
  この変更後は使えない（実 API が要る＝オーナー領分）。
- 評価器（`gradeAnswer`/`judgeAnswer`）自体の設計・ケース（何をもって
  「由来を無視した」と判定するか）は、Issue #498/#693 が扱っている回答評価の
  領分そのものであり、本 Issue が新たに設計をやり直す対象ではない。

⟹ **本 PR では、誤帰属検知の回答評価ケースを定義しない。** Issue #693
（「回答品質を保った入力量削減を検証し、出典到達だけの成功と区別する」）が
`answer` の回帰検査・運用接続を扱う子作業として既に存在するため、由来・話者・
主題・矛盾関係を無視した誤答を検知する評価ケースの設計は、#693（または
その後続）に委ねる。本 PR のプロンプト変更が完了したことで、#693 が
参照できる「由来等を実際に含むプロンプト」が初めて存在するようになった
——**前提が揃った**ことを記録するに留め、評価そのものは未着手・未評価として残す。

## 6. 引き受けた負債

1. **`provenanceKind` の日本語訳を作らなかった**（決定2）ため、回答生成モデルが
   英語の kind 値の意味を誤解するリスクは検証していない——これは回答評価
   （§5、範囲外）の領分である。
2. **実 `answer` 12ケースでの新形式の実測値が無い**（§3）——DB 環境が無いための
   制約であり、内容上の判断の不備ではない。
3. **`answer-cli.postgres.test.ts` の recorded 再生が壊れる**ことを実測したが、
   直していない（§4）——録り直しには実 API・課金・鍵が要り、オーナー領分。
4. **矛盾候補のタグが同一 digest を持つ相手を複数回埋め込む可能性**
   （同じペアが budget 上複数回 recall に現れるような、通常は起きないはずの
   状態）は考慮していない——`docs/recall.md` §8「隣接性の不変条件」により
   ペアは分割されない前提に乗っており、この前提が崩れた場合の描画は未検証。

## 関連

- Issue #691（本 ADR の対象）
- Issue #579 / ADR 0289（`speaker`/`subjectId` を `RecalledMemory` に追加、本 PR の前提）
- Issue #498 / #693（回答評価そのものの設計・実装、本 PR の範囲外）
- `docs/recall.md` §6（`usage.chars` の限界）・§8（矛盾の同伴取得）
- ADR 0051（recorded カセットの設計、`llmCassetteKey` の鍵の作り方）
- ADR 0236（同種の「録り直しはオーナー領分」の先例）

---

## 追記（2026-09-25、Issue #691 の子・Issue #702、ADR 0298 との接続）

> **⚠ 本追記も自動化された担い手（マネージャーから委譲された作業者）が書いた。**
> **⛔ オーナー本人の判定ではない。** 上記の断り書きと同じ規律に従う。

[PR #703](https://github.com/takecchi/mnemora/pull/703)（ADR 0298、`RecalledMemory` に
`recordedAt`（取り込んだ壁時計の時刻、常に値）・`occurredAt`（出来事自身の時刻、
`Date | null | undefined`）を追加）が main にマージされたことを受け、この2欄を
`buildMnemoraPrompt` へどう描画するかを、この追記の作業で決めた。

### 7. `recordedAt` は生の ISO ではなく「記録順」の番号で出す【実測】

Postgres（`postgres://postgres@localhost:55432/...`）と `OPENAI_API_KEY`
（作業環境のログインシェルにのみ存在）が使える環境で、実 API（`gpt-4o-mini`、
既定 temperature）による dev 対照を行った——**この対照は `answer-case-set.dev.ts`
（development）だけで行い、`answer-case-set.eval.ts`（held-out）は一度も見ていない**
（絶対の線）。

手順: `ANSWER_CASE_SET_DEV` の6件を、`recorded`（`examples/chat/cassettes/answer.json`
の抽出・埋め込みの記録を再生、費用ゼロ）で `ingestConversation`/`queryRecall` に通し、
得られた同じ `recall.memories` から4通りの回答プロンプトを組み立てて、
`ANSWER_SYSTEM_PROMPT` + 質問という同じ形で実 OpenAI に5回ずつ答えさせ、
`gradeAnswer`（一次判定、文字列包含）の pass 数だけを数えた（回答文面そのものは
読んでいない・保存していない）。対照した4通り:

| 描画 | 内容 |
| --- | --- |
| 旧（digest-only） | Issue #691 以前の描画（由来等のタグを一切付けない、参照用） |
| A（生ISO・採らなかった） | 本 PR が前のコミットまで実装していた形。各行に `[記録時刻:2026-...Z]` を付ける |
| B（記録順・採用） | `recall.memories` を `recordedAt` 昇順に並べ替えた順位を `[記録順:N]` として付ける（行の並び自体は変えない） |
| C（並べ替え+注記・採らなかった） | 行を `recordedAt` 昇順に並べ替え、冒頭に「記録した順に並べてある」旨の1行を足す（時刻タグは付けない） |

結果（pass/5）:

| ケース | 旧 | A（生ISO） | B（記録順） | C（並べ替え+注記） |
| --- | --- | --- | --- | --- |
| pref-tea-over-coffee | 5 | 5 | 5 | 5 |
| **schedule-change-meeting-day** | **5** | **1** | **5** | **1** |
| negation-moved-city | 5 | 5 | 5 | 5 |
| other-person-birthday | 5 | 5 | 5 | 5 |
| other-period-city-this-year | 5 | 5 | 5 | 5 |
| unknown-blood-type | 5 | 5 | 5 | 5 |

`schedule-change-meeting-day`（「来週の定例会議は金曜日」→「やはり水曜日に移してください、
金曜日は都合が悪くなりました」という訂正が後続するケース）だけが割れた。**候補A（本 PR が
それまで実装していた生ISOタグ）と候補C（並べ替え+注記）はどちらも 1/5 まで落ち、候補B
（記録順の番号）だけが旧描画と同じ 5/5 を保った**——生の ISO 8601 どうしの日時比較や
「並べ替えた」という宣言文よりも、小さい整数の順位のほうが「どちらが後の発言か」を
モデルに読み取らせやすいと考えられる（推測であり、検証していない）。

⟹ **決定: `recordedAt` は `[記録順:N]`（`recall.memories` を `recordedAt` 昇順に
並べ替えた順位。行そのものの並びは変えない。同一ミリ秒は元の配列順で安定的に
タイブレーク）として描画する。** §2 で決めた「由来・話者・主題・矛盾候補」の並びの
直後、`occurredAt`（下記8）の直前に置く。`recordedAt` が `undefined`（そもそも
欄を渡さなかった呼び出し側）の要素は順位付けの対象から外し、欄そのものを出さない
（§2 決定1「欠落値を推測しない」と同じ規律の適用）。

⚠ **採らなかった理由の記録**: 候補A（生ISO）は本 PR が最初に実装し、契約テスト
（`__tests__/provenance-prompt-cases.ts` の `temporal-*`）も一度緑にした状態だったが、
上記の dev 対照でこの退行が見つかったため、ケース・実装ともに `[記録順:N]` へ書き直した
（該当コミットの履歴に「赤→緑」がそのまま残っている）。

### 8. `occurredAt` の描画は変えない（未評価のまま残す）【現物】

`occurredAt` は上記の対照でも ISO 8601 のまま描画した（`null` を `recordedAt` で
埋めない・`undefined` なら欄を出さない、という規律は§7と同じ）。**この対照は
`occurredAt` が常に `null`（`ingestConversation` が `occurredAt` を渡さないため、
Issue #702 のマネージャー実測どおり）の下でしか行っていない**——`occurredAt` に
実際の値が入ったときに同じ退行が起きるかどうかは未評価のまま残る。

### 9. dev 対照の実 API 呼び出し・費用【実測】

`chat.completions.create`: 120回（6ケース×4描画×5回）。`prompt_tokens=25270`・
`completion_tokens=812`。`usage-meter.ts` の公開価格表（2026-09時点、OpenAI の
請求 API から取得した実額ではない）による概算費用: 入力 $0.003791・出力 $0.000487・
合計 **$0.004278**。embedding 呼び出しは0回（`recorded` で再生したため）。

### 10. 引き受けた負債（追記分）

1. **`occurredAt` に値がある場合の描画は未評価**（§8）。
2. **候補は3つに絞った**（「多くて3つ」という制約）——生ISO・記録順・並べ替え+注記
   以外の描画（例: 相対時間の自然文「3ターン前」等）は試していない。
3. **dev 対照は `gpt-4o-mini`・既定 temperature・5回のみ**——モデルを変えた場合や
   温度を変えた場合の頑健性は未検証。
4. **`schedule-change-meeting-day` 以外の dev 5件は、そもそも由来タグ等の影響を
   受けていなかった**（§2 の対照時点で判明済み、Issue #691 の子作業の対象外）ため、
   本追記の対照でも退行が「無い」ことの確認に留まる——なぜ影響を受けないかの
   構造的な理由は分析していない。
