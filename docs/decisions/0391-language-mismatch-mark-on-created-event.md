# ADR 0391: 抽出の言語の事後検査は「印を付けるだけ」にし、`created` イベントの `meta.languageMismatch` に出す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**

---

## 問い —— [Issue #1370](https://github.com/takecchi/mnemora/issues/1370)

日本語の観測から、記憶の本文（content）が英語で書かれることがある（Issue 本文の利用側の数字は 4,556件中25件）。
[ADR 0348](./0348-extraction-language-and-speaker-instruction-gated-on-subject-candidates.md) はプロンプトに言語の指示を足したが、
効果は統計的に示せていない。**プロンプトは確率的で、鍵が無い環境（CI）では効くかどうかを歯にできない。**
鍵なしで効く歯を、非破壊で足せないか。

## 決めたこと

### 決定1. 事後検査を足し、**印を付けるだけ**にする

抽出された候補の content を、観測の本文と照らして検査し、疑いがあれば印を付ける。
**再試行しない・全文フォールバックしない・Memory を書き換えない・弾かない。**
Memory の作り方も、公開の型の既存の欄も変えない。プロンプトの文面・入力も1バイトも変えない（録音の鍵が動かない）。

### 決定2. 印の出し先は、`created` イベントの `meta.languageMismatch`（任意のキー）

`appendCreatedEvent`（runtime.ts）が、疑いがあるときだけ `meta` にキーを足す。疑いが無いときの `meta` の形は変わらない
（歯: `language-mismatch-mark.test.ts`）。
`meta` は `MemoryEvent.meta` の自由形式であり、同じ作りで `droppedCandidates`（ADR 0347）・`failureKind` が既に載っている。
`appendCreatedEvent` は sync・deferred（`processExtractJob`）・`reextract` の**3経路すべてが通る**ので、1か所の変更で全経路に効く。

### 決定3. 判定規則（`packages/core/src/language-mismatch.ts` の `detectLanguageMismatch`）

次の**すべて**を満たすとき、疑いとする。

1. 観測の本文（`observationPayloadText`）に、かな・漢字（ひらがな・カタカナ・CJK統合漢字）が `LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS`（4）字以上あり、
   （かな・漢字）÷（かな・漢字 + ラテン文字）が `LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE`（0.3）以上。
2. content に、かな・漢字が**1文字も無い**。
3. content にコード片の印（バッククォート・`{}<>|\`・`&&`・`=>`・`--flag`・パス）が無い。
4. URL を除いた content のラテン文字が `LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS`（20）字以上。
5. content の文字（`\p{L}`）のうちラテン文字が `LANGUAGE_MISMATCH_MIN_LATIN_SHARE`（0.9）以上。
6. 小文字だけでできた語が `LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS`（3）語以上。

**偽陽性への備え**（歯は `language-mismatch.test.ts`。備えを1つずつ外す変異試験で、コード片・小文字語・かな漢字の有無・短さの各備えを外すと赤くなることを確かめた（固有名詞の短い例は、短さと小文字語の両方が弾くので、片方を外しただけでは赤くならない））:

| 偽陽性の側の例                                                                          | 備え                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 固有名詞だけ `Tokyo Disneyland`（15字）                                                 | 4（短すぎる）。長い羅列 `Tokyo Disneyland Resort Hotel MiraCosta …` は6（小文字語が無い） |
| コード片 `npm run build`（11字）、`npm run build && npm run test -- --coverage`（長い） | 4、3                                                                                      |
| URL だけの本文                                                                          | 4（URL を数える前に除く）                                                                 |
| 短すぎる本文・空                                                                        | 4                                                                                         |
| 英語の文に日本語の名前が1つ混じる観測                                                   | 1                                                                                         |
| 他の文字体系が混じる本文                                                                | 5                                                                                         |

閾値は推論で置いた（根拠は `language-mismatch.ts` の doc）。**実データで当てていない**（下の【確かめていないこと】）。

### 決定4. digest は対象にしない

対象は content だけ。理由: (a) Issue の実測（25件）は content の話である。(b) digest は短く、決定3の4（短さ）で
ほぼ落ちるので、判定しても大半は「判定できない」になる。(c) LLM が digest を返さないとき、digest は content の先頭の切り出し
（`digestSource`）であり、content の印で足りる。digest だけが英語になる経路が在るかは**確かめていない**。要るなら別の PR で、
同じ関数に digest を渡すだけで足せる。

## 検討した印の出し先

既存の診断の出し方を、次の場所で探した（`grep -n "rejectedSubjectIds\|extractionFailure\|claimKeyFailure\|droppedCandidates\|logger\|console\.\|diagnos" packages/core/src/runtime.ts`、`docs/decisions/0347*`・`0287*`、`packages/postgres/migrations/0018*`）。

| 候補                                                                         | 判断                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ObserveResult` の任意の欄（`rejectedSubjectIds`・`claimKeyFailure` の作り） | ⛔ **deferred は `observe()` が抽出前に返る**（`processExtractJob` は結果を持たない）。sync にしか効かない。`ReextractResult` にも別に足す必要が在る                                                                                                                                                       |
| `ExtractCandidatesResult` の任意の欄                                         | 抽出の結果としては自然だが、呼び出し側（runtime）が Memory・イベントへ運ばないと、どこにも残らない。deferred で消える                                                                                                                                                                                      |
| 診断イベント／ログ                                                           | core に logger も診断コールバックも**無い**（上の grep で当たらなかった。当たった範囲での結果であり断定ではない）。新設すると公開の面が増える                                                                                                                                                              |
| 新しい `MemoryEventKind` の値                                                | union に値を足すのは非破壊と数える（[migration-v1.md](../migration-v1.md)「数え方の規律への追記（2026-09-28）」）。だが Postgres は `memory_events.kind` の CHECK を持ち（`0018_memory_events_kind_unsuperseded.sql`）、値を足すには migration が要る。⛔ `packages/postgres` を変えずに済む設計を優先した |
| **`created` の `meta` の任意のキー**（採用）                                 | 3経路すべてが通る1か所。既存の作り（`droppedCandidates`・`failureKind`）と同じ。型・DB・公開の面を変えない。EventStore に残るので、後から数えられる                                                                                                                                                        |

## 非破壊である根拠

- 公開の型（`ObserveResult`・`ReextractResult`・`ExtractCandidatesResult`・`MemoryEventKind`）に何も足していない。
  新しいモジュール（`language-mismatch.ts`・`observation-text.ts`）は `index.ts` から export しない。
- `observationPayloadText` は `extraction.ts` から `observation-text.ts` へ**移しただけ**（本体は同じ）。`extraction.ts` から外へは元々出ていなかった。
- `meta` は自由形式の既存の列。疑いが無い呼び出しの `meta` は1バイトも変わらない。疑いが在るときに増えるのは1キーだけ。
- プロンプト・入力を変えていないので、録音（カセット）の鍵は動かない。

`docs/migration-v1.md` には足さない（破壊的変更ではない）。

## 【確かめていないこと】

- **実データでの偽陽性率・取りこぼし率は測っていない。**閾値は【推論】であり、実測で置いたものではない。
  [AGENTS.md](../../AGENTS.md)「偽陽性率に上限を置けない検査は門にしない」に従い、**門にしていない**（印を付けるだけ）。
- 取りこぼす側の例: 英語が大半だが日本語が1文字混じる本文、英語の本文が短い（20字未満）場合、大文字語の多い英文。
- 余計に拾う側の例（想定）: 意図して英語で書かせた本文（観測が日本語でも、呼び出し側が英語の記憶を望む場合）。
  この使い方を持つ利用者にとっては印は常に付く。印は疑いであり、Memory は変えないので害は無いが、数え方には注意が要る。
- 中国語の観測は、漢字が CJK なので「日本語」と区別しない。
- `created === false`（冪等な再送で既存の行に当たった）のときは `created` イベントを積まないので、印も積まれない。
- 実 API では走らせていない（鍵が無い）。歯は偽の LLM で、鍵なしで効く。

## 採らなかった案

- **再試行**（英語なら日本語で頼み直す）: LLM 呼び出しが増え、録音・費用・abort の扱いに波及する。決定済みの範囲外。
- **全文フォールバック**: 北極星の物差し（毎回渡す量を減らす）に反するゴミ記憶を増やす。
- **Memory の弾き・タグ付け**: 既存の記憶の作り方を変える。非破壊でなくなる。
- **言語判定ライブラリ**: core の実行時依存は zod だけ（`dependency-boundary.test.ts`）。

## 引き受けた負債

- 閾値が実データで当たっていない。印を読む側（人・後続の集計）は、疑いとして読むこと。
- 印を集計する道具は無い（`EventStore.list({ kind: "created" })` の `meta` を読む）。
- 規則を変えたら `rule` の名前を変えること（過去の印と区別するため）。

## これが覆るとしたら何が起きたときか

- 実データで偽陽性が多いと分かったとき: 閾値を変える（`rule` を改める）か、印を外す。
- 印を集計して使う場面が出たとき（例: `ObserveResult` で即座に見たい）: 任意の欄を足す別の ADR。
- プロンプト側の対処（ADR 0348）が効くと実測で示せたとき: 本検査は「効いていることを鍵なしで確かめる歯」として残るか、不要になる。
