# ADR 0490: 穴探し59巡目 — 言語の事後検査（ADR 0391）が「ラテン文字」にローマ数字を数えていた。文字だけを数える直しと、`created` の印を実 adapter で縛る歯

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-3a4ae979 の指示による）が書いた。直す線（約束に実装を戻す・文書の直し・前例のある同種の穴）の中だけを直し、オーナーの領分（前例の無い新しい断り・既定値の変更・公開 API・suite への約束・遡ってのデータの書き換え）は材料として残した。PR は [#1597](https://github.com/takecchi/mnemora/pull/1597)。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 59巡目は、抽出の言語の事後検査（`packages/core/src/language-mismatch.ts` の `detectLanguageMismatch`、`created` イベントの `meta.languageMismatch`。[ADR 0391](./0391-language-mismatch-mark-on-created-event.md)）を当てた。判定の仕方（文字の数え方）、印が付く経路、印の形が adapter で揃うか、文書と実装の食い違いの4面。

## 見つけた穴

### 穴1. 「ラテン文字」の数に、文字でないものが入る【実測】

`LATIN = /\p{Script=Latin}/gu` は、ローマ数字（U+2160〜2188、一般カテゴリ Nl）のような**文字（`\p{L}`）でないもの**も数える。割合の分母は `\p{L}` なので、分子が分母を超える。

| 本文（観測は日本語） | 返った印 | 何がおかしいか |
|---|---|---|
| `ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ` を2回 + ` the user works hard` | `contentLatinLetters: 40`、`contentLatinShare: 2.5` | 「割合」が1を超える（TSDoc は「文字のうちラテン文字が占める割合」） |
| `Chapter Ⅳ and Chapter Ⅶ: the user works hard at the bakery` | `contentLatinShare: 1.05` | 同上。`contentLatinLetters` は実際の文字の数より2多い |
| `the user works ` + ローマ数字12字 | 印が付く | 実際の文字は13字で、下限（20字）に届かない。数字が下限をすり抜けさせた |
| 観測 `第一章の概要` + ローマ数字24字、本文は英語 | 印が付かない | 観測側も同じ数え方で、日本語の割合（0.3 以上）が薄まって落ちる |

陽性対照: 同じ探り棒に、ローマ数字を含まない `EN_CONTENT` を渡すと `{ contentLatinLetters: 62, contentLatinShare: 1 }`。文字だけの入力では数がずれない。

**直した**【判断。線: 約束に実装を戻す直し】: `LATIN` を `/(?=\p{L})\p{Script=Latin}/gu`（文字であって、かつラテン文字）にした。観測側と本文側で同じ定数を使う。

- 閾値（20字・0.9・小文字語3・観測の4字と0.3）は変えていない。数え方を TSDoc の言葉（「ラテン文字の数」「割合」）に戻しただけ。
- 結果が変わるのは、ローマ数字（Nl）を含む入力だけ（上の表）。ふつうの文章（ASCII・アクセント付きラテン文字・全角英数・かな・漢字・ハングル・キリル）では、数は変わらない【実測】（直す前後で、40の探り棒のうちローマ数字を含まない38件の結果が同じ。探り棒は commit していない）。
- ⚠ [ADR 0391](./0391-language-mismatch-mark-on-created-event.md) は「規則を変えたら `rule` の名前を変えること」と書く。【判断】これは規則（6つの条件とその閾値）の変更ではなく、条件にある「ラテン文字」の数え方を言葉の意味に直した修正であり、`rule` は変えなかった。過去の印（保存済みの `meta`）は書き換えていない。この判断が違うなら、`rule` を改める別の ADR にする（クローンまたはオーナーが決める）。

歯: `packages/core/src/__tests__/language-mismatch.test.ts` に3件（本文の割合が1を超えない・ラテン文字の数が実際の文字数と一致する／ローマ数字で下限をすり抜けない／観測のローマ数字が日本語の割合を薄めない）。直す前の実装で3件とも赤、直して緑【実測】。

### 穴2（文書）. `created` の `meta` の鍵の一覧に `languageMismatch` が無い【現物】

`docs/memory-model.md` §11（イベント）は、`created` の `meta` の `droppedCandidates`・`droppedFields` を説明しているが、`languageMismatch` が無かった（`grep -rn languageMismatch docs/*.md` は ADR・CHANGELOG のみ）。**足した**（`docs/memory-model.md` の `droppedFields` の項の直後）。検査するのが抽出の経路（sync・deferred・`reextract`）だけで、統合・内省の `created` には付かないことも明記した。

### 穴3（文書）. `findCorrectionCandidates` の「探していない」の TSDoc【実測】

依頼のとおり、[PR #1594](https://github.com/takecchi/mnemora/pull/1594) の面には触れず、TSDoc だけを今の振る舞いに合わせた。`text` が `undefined`（型を外したとき）だと、`recall()` は例外にならず、埋め込みを呼ばずに `no_candidates` を返す。

| 入力 | 結果【実測。Fake の store】 |
|---|---|
| `{}`・`{ text: undefined }` | `outcome: "no_candidates"`、埋め込み 0 回、`omitted` に `{ kind: "stage_skipped", stage: "candidate_generation", reason: "empty_query_content" }` |
| `{ text: "" }` | zod の `too_small`（`text` は1文字以上）で reject |
| `{ text: "x" }`（陽性対照） | 埋め込み 1 回、`candidate_generation` の skip は無い |

TSDoc の「**「探していない」という第3の状態は無い**」は、`outcome` の値の話としては正しいが、「探索そのものをスキップする経路は無い」は食い違っていた（候補の生成の段は飛ぶ）。書き直した: 「探していない」は `outcome` ではなく `omitted` に出る。場所は `FindCorrectionCandidatesResult.outcome`（`correction-candidates.ts`）と `Runtime.findCorrectionCandidates`（`runtime.ts`）。挙動は変えていない。歯: `packages/core/src/__tests__/correction-candidates-text-undefined.test.ts`（3件。陽性対照つき）。

### 穴4（歯）. `meta.languageMismatch` が実 adapter を通って読み戻るかを見る歯が無かった【現物】

core の `language-mismatch-mark.test.ts` は Fake の store だけで走る。抽出の `created` は `MemoryStore.createMemoriesWithOutboxAndEvents`（記憶と同じトランザクションで store が INSERT。[ADR 0410](./0410-extract-created-event-in-same-transaction.md)）を通る経路があり、Postgres の jsonb の往復は見ていなかった。

**穴は無かった**【実測】: `packages/postgres/src/__tests__/language-mismatch-mark.postgres.test.ts` を足し、testkit の InMemory と Postgres の両方で、sync・deferred・`reextract`（`reextracted: true` と同居）・日本語の本文（キーが無い。`null` も入らない）を縛った。値は両者で `{ rule, contentLatinLetters: 62, contentLatinShare: 1 }` に一致し、数のまま戻る。変異試験: `runtime.ts` の印の組み立てで `contentLatinShare` を文字列にすると、8件のうち6件（両 adapter の sync・deferred・reextract）が赤、戻して 8 件緑【実測】。

## 当てた形と結果（穴が無かったものを含む）

純関数 `detectLanguageMismatch(観測, 本文)` に、40の入力を当てた（探り棒は commit していない）。**陽性対照**: 日本語の観測 + 英語の文は印が付く。「出なかった」を根拠にするものは、この対照が生きている状態で当てた。

| 当てた形 | 結果 |
|---|---|
| 本文が空 / 観測が空 | 陰性 |
| 観測が漢字だけ・カタカナだけ・`々` だけ・CJK 拡張B | 陽性（英語の本文なら） |
| 観測が中国語（かな無し） | 陽性（ADR 0391 の【確かめていないこと】どおり。日本語と区別しない） |
| 観測がハングルだけ | 陰性 |
| 観測が全角英数 + かな | 陰性（かな・漢字が足りない） |
| 本文がキリル / 全角英数のラテン / 絵文字だけ / 数字だけ / 半角カタカナ入り | 陰性 |
| 本文がアクセント付きラテン（スペイン語）・メールアドレス入り・結合文字入り | 陽性（ラテン文字の本文は言語を区別しない。規則名どおり） |
| 本文に ASCII の英文 + ハングルが少し | 陽性（割合 0.96） |
| 本文に URL だけ / URL にかな・漢字 / 20字未満 | 陰性 |
| 本文のかな・漢字が `々`・`ー`・`〆`・`・`・`〜`・`「」` | `々`（Han）だけ陰性。`ー`・`〆`（Common）・`・`・`〜`・`「」` は「かな・漢字」に数えないので陽性のまま（「かな・漢字が1文字でもあれば」に当たらない） |
| 本文が NBSP・全角空白・改行区切りの英文 | 陽性 |
| 本文がコード片の印（`>`・`--`・` /x`）を含む英文 | 陰性（意図した偽陽性への備え。英文でも落ちる） |
| 本文の小文字語が `(the)`・`well-known`・`isn’t`（曲がった `’`）・全角小文字ばかり | 陰性（取りこぼし。`LOWERCASE_WORD` は ASCII の語だけ。ADR 0391 の「取りこぼしは承知」） |
| 本文が `a/b`・`24/7`・`and/or` | 陽性（空白の前に `/` が無いのでパスに見えない） |
| 33万字の観測（日本語、約1MB） | 62 ms（呼び出し1回）。667万字（約20MB）で 1073 ms |
| 経路: sync・deferred・`reextract`（Fake・InMemory・Postgres） | 印が付く。全文フォールバックの本文は付かない（core の既存の歯が縛る） |

## 材料（直していない。決めるのはクローンまたはオーナー）

1. **統合・内省は検査しない**【現物】: `consolidate`・`reflect` の `created`（`runtime.ts` の `buildCreatedEvent`・`buildReflectedCreatedEvent`）は `languageMismatch` を付けない。日本語の記憶を統合して英語の本文が出ても印は無い。ADR 0391 は「抽出」の検査と書いていて約束の違反ではない。足すなら、新しい印の出し先・比べる相手（統合元の本文）の決め方が要るので、新しい仕様として別の ADR（オーナーの領分: 前例の無い新しい検査）。今回は文書に「付かない」と明記しただけ。
2. **観測の数え直しが候補ごと**【実測】: `buildCreatedEventFor` は候補ごとに `observationPayloadText` と `count` を呼ぶ。333,000字の観測で1候補あたり 62 ms、候補が100件なら約6秒の CPU（同期）。ふつうの大きさ（数千字）では無視できる。観測ごとに1回に畳む直しは挙動を変えないが、`buildCreatedEventFor` の引数を増やす内部の整理であり、大きな文書を抽出する利用者が現れたときに決める。
3. **`LOWERCASE_WORD` が ASCII の `'` だけを見る**: 曲がった `’`（`isn’t`）や括弧・引用符で囲まれた語を数えない。英文でも印が付かない側（取りこぼし）。語の数え方を広げると判定の基準が変わる（既定値の変更に当たりうる）ので材料。
4. **`ー`（U+30FC）・`〆`・`・` は Common**: かな・漢字として数えない。日本語の本文が `ー` と英語だけで書かれることは無いので実害は想定しない【推論】。
5. **未測定**: 実データでの偽陽性率・取りこぼし率は、ADR 0391 のとおり測っていない。今回も測っていない【未確認】。

## 引き受けた負債

- 穴1の直しで、ローマ数字を含む本文・観測の判定が変わる。保存済みの印は書き換えていない。変わるのは今後の抽出だけ。
- `rule` を変えない判断（上）が、ADR 0391 の「規則を変えたら `rule` を変える」と読み違えられる余地。

## これが覆るとしたら何が起きたときか

- ローマ数字を「ラテン文字」に数える意図があった（ADR 0391 の議論に痕跡がある）と分かったとき: この直しを戻す。ただし割合が1を超える点は直す必要がある。
- 数え方の変更を `rule` の改名に値すると、オーナーが判断したとき: `rule` を改める別の ADR。
