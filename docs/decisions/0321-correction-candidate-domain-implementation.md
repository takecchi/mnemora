# ADR 0321: ADR 0291 §7 残件1〜4 を実装する — 訂正候補探索に30件のセルを追加し、margin/intrusionMargin を足し、CI ジョブを配線する

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

**⚠ この PR はクローンの委譲で動く担い手（サブエージェント）が書いた。投稿者
`takecchi` はオーナー本人ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
——投稿者名は担い手とオーナーを区別しない）。**この ADR に出てくる判断はすべて
「クローン miku の判断（オーナーではない）」である。**オーナーの確認・承認を得たものではない。

**⚠ 各主張の出所を分ける**（[ADR 0291](./0291-primary-probe-coverage-map-correction-candidate-domain.md)/[ADR 0313](./0313-numeral-token-probes-ci-wiring-and-baseline-verification.md) の体裁を踏む）。

- **【実測】** — この ADR の担当者が、この手元の器（`docs/autonomy.md` の `initdb` 手順で
  自分専用に立てた PostgreSQL 17 + pgvector + `@mnemora/local-embedding` +
  `DeterministicLLMProvider`）に対して実際に走らせた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — マネージャー（上位の担い手）からの指示として受け取り、自分では再導出していない。

---

## 0. 引き継ぎの経緯

[ADR 0291](./0291-primary-probe-coverage-map-correction-candidate-domain.md)（状態:
提案。**本 ADR はその本文・状態欄を1文字も書き換えない**）§7「引き受けた負債・残件」の
1〜4を実装する:

1. `correction-case-set.eval.ts` への30件の追加（§5.4 の行列: A群6件・B群24件）。
2. `correction-candidate-arm.ts` への `margin`/`intrusionMargin` の追加。
3. CI ジョブの新設（`identifier-probes` と同じ形、非 required）。
4. README「想起の質をどう測っているか」表への追記。

**ADR 0291 §7-5 が残した順序の選択**——数詞インデックスのセルを ADR 0135
（`numeral-token-probe-set.ts`）の実装が先に着地してから作るか (a)、後回しにするか
(b)——について、**マネージャーの判断（オーナーではない）で (a) を採った**【受】。
ADR 0135 は既に実装済み（[ADR 0313](./0313-numeral-token-probes-ci-wiring-and-baseline-verification.md)
が CI 配線まで着地させている）ため、数詞インデックスのセルはその語彙の作り方
（算用数字1桁＋短い助数詞、共有前置ほぼ0文字。同ファイルの `arabic-short`/`arabic-medium`
セルに相当するスタイル）を借りた。

**採らなかった点の確認（実装前の grep）**——§6 に詳細。要点だけ先に書く: 機械的な
水増しは ADR 0092/ADR 0135 の前例で明示的に却下されており、この PR は「索引型×2
インスタンス」「索引型×kind×2インスタンス」という**行列を先に決め、件数を後から
導いた**（ADR 0291 §5.4 の形をそのまま踏襲）。`probe-set.ts` には触れていない。
`correction-case-set.eval.ts`（held-out）に**見て調整する前に**書いた30件を足す形は、
`docs/autonomy.md` §2.2 決定1・決定5 の規律（根拠は仕様に置き、実装の出力だけから
正解を作らない／見て調整したら development 側へ移す）にそのまま従う——**この PR は
一度も `findCorrectionCandidates` の出力を見てから `grounds` を書き直していない。**

---

## 1. 【現物】既存23件のケース集合の分け方の規律を確認した

`correction-case-set.eval.ts`/`correction-case.ts` の doc コメントを読み、次を確認した:

> ⛔ このファイルのケースを見て実装や閾値を調整しない。見て調整したら、そのケースは
> 以後 development として扱い、`correction-case-set.dev.ts` へ移すこと
> （`docs/autonomy.md` §2.2 決定5）。

**⟹ 新規30件も `correction-case-set.eval.ts`（held-out）に置く**——ADR 0291 §5.4
決定文自身が「追加は eval 側」と明示しているのと整合する。**この PR は、30件の
`gold`/`distractor`/`correction`/`utterance`/`grounds` を、実装（`findCorrectionCandidates`・
`correction-candidate-arm.ts` の `recall()` 呼び出し）を1回も実行しない状態で先に書き、
その後で初めて測定した。**測定結果を見てから `grounds` の文言や判定（A群/B群のどちらに
入れるか）を書き直した箇所は無い。

---

## 2. 30件それぞれの根拠（A群6件・B群24件）

**書き方**: 「何の事実が、何によって覆る/覆らないか」を1ケース1行で書く。「曖昧」欄は、
この担当者が実装前に再検討し、判定を保つか・入れ替えたかを明記する。

### 2.1 A群（訂正すべき相手が実在する。索引型3 × 2インスタンス = 6件）

| id | 索引型 | 訂正すべき理由（何が覆るか） | 曖昧さの検討 |
|---|---|---|---|
| `ascii-a` | ASCII識別子 | 訂正文が識別子 `PROJ-6801` と旧値「来月10日」を両方名指ししている。`PROJ-6802`（distractor）は同一の識別子を含まないため、訂正文の識別子一致だけで gold と distractor が構造的に分離できる。 | 無し——識別子は書式が同じでも文字列として完全に異なる。 |
| `ascii-b` | ASCII識別子 | 訂正文が `TICKET-77410` を名指ししている。`TICKET-77411` は別の識別子であり、訂正文に一度も現れない。 | 無し。 |
| `jpname-a` | 日本語固有名詞 | 訂正文が主語「橘啓太」と旧値「営業部」を両方名指ししている。distractor の主語「橘拓也」は同じ姓だが異なる名であり、訂正文の逐語一致（フルネーム）で区別できる。 | **検討した**: 姓だけを見れば区別できないため、姓のみに短縮した言い方（例:「橘さん」）が来たら曖昧になる。**今回はフルネームを訂正文に含めており、曖昧ではない**——ただし今後この形式（姓のみでの訂正）を足すなら、B群の`vague`寄りの扱いを検討すべきと記す。 |
| `jpname-b` | 日本語固有名詞 | 訂正文が組織名「白鷺製作所の品質管理一課」と旧値「出荷前検査」を両方名指ししている。「品質管理二課」は同一会社の別部署で、訂正文に一度も現れない。 | 無し。 |
| `numeral-a` | 数詞インデックス | 訂正文が対象「5号倉庫」と旧値「季節商品」を両方名指ししている。「6号倉庫」は同じ書式・別の索引であり、訂正文に一度も現れない。 | 無し——ADR 0135/0110 が実測した「単独の数詞トークンは希釈されやすい」危険はあるが、それは*embedding が実際に区別できるか*という別の問い（測定対象）であり、*どちらが正解か*という判定の曖昧さではない。 |
| `numeral-b` | 数詞インデックス | 訂正文が対象「7番会議室」と旧値「定例会議」を両方名指ししている。「8番会議室」は同じ書式・別の索引。 | 無し。同上の理由で、embedding の脆さは判定の曖昧さと別物。 |

### 2.2 B群（⛔ 訂正してはいけない。索引型3 × kind4 × 2インスタンス = 24件）

**kind の意味**（`docs/autonomy.md` §2.2 決定1 の4分類、既存8件と同じ）:
`negation`=特定日/週の不履行の報告（習慣は否定していない）、`vague`=対象を特定できない発言、
`other_person`=訂正の主語が本人以外、`other_period`=訂正が別の時期についての言明。

| id | 索引型 | kind | ⛔ 訂正してはいけない理由（何が覆らないか） | 曖昧さの検討 |
|---|---|---|---|---|
| `neg-ticket-1` | ASCII | negation | 「今日対応しなかった」は当日の行動報告であり、`TICKET-90210`のステータス自体（調査中）を否定する言明ではない。ステータスの記憶は成立し続ける。 | 無し——既存`neg-jog`と同型。 |
| `neg-proj-1` | ASCII | negation | 「今週報告しなかった」は特定週の行動報告であり、`PROJ-4410`の週次報告という習慣自体を否定していない。 | 無し。 |
| `vague-ascii-1` | ASCII | vague | 「さっきの案件番号」がどの識別子を指すか発話から決まらない。対象を特定できない以上、どの記憶を選んでも根拠が発話に無い。 | 無し——既存`vague-maybe`と同型。 |
| `vague-ascii-2` | ASCII | vague | 「チケットの件」は特定のチケット番号を含まない。 | 無し。 |
| `person-ticket-1` | ASCII | other_person | 訂正の主語は「同僚」であり、同僚の担当チケットについての記憶は一度も観測されていない。⟹ 失効させてよい相手が存在せず、本人の`TICKET-33210`の記憶は成立し続ける。 | 無し——既存`person-origin`と同型。 |
| `person-proj-1` | ASCII | other_person | 訂正の主語は「後輩」であり、後輩の担当案件についての記憶は一度も観測されていない。 | 無し。 |
| `period-ticket-1` | ASCII | other_period | 訂正しているのは「先月」の対応チケットについての言明であり、現在対応中の`TICKET-61010`の記憶には掛からない。 | 無し——既存`period-team`と同型。 |
| `period-proj-1` | ASCII | other_period | 訂正しているのは「去年」の参加案件についての言明であり、現在の`PROJ-7010`参加の記憶には掛からない。 | 無し。 |
| `neg-jpname-1` | 日本語固有名詞 | negation | 「今週しなかった」は特定週の報告であり、橘啓太との1on1という習慣自体を否定していない。 | 無し。 |
| `neg-jpname-2` | 日本語固有名詞 | negation | 「今朝は無かった」は特定日の報告であり、朝礼という習慣自体を否定していない。 | 無し。 |
| `vague-jpname-1` | 日本語固有名詞 | vague | 「さっきの名前の話」が誰を指すか発話から決まらない。 | 無し。 |
| `vague-jpname-2` | 日本語固有名詞 | vague | 「部署の名前」は特定の部署名を含まない。 | 無し。 |
| `person-jpname-1` | 日本語固有名詞 | other_person | 訂正の主語は「同期」であり、同期の上司についての記憶は一度も観測されていない。本人の上司（橘啓太）の記憶は成立し続ける。 | 無し。 |
| `person-jpname-2` | 日本語固有名詞 | other_person | 訂正の主語は「先輩」であり、先輩の所属についての記憶は一度も観測されていない。 | 無し。 |
| `period-jpname-1` | 日本語固有名詞 | other_period | 訂正しているのは「3年前」の上司についての言明であり、現在の上司（橘啓太）の記憶には掛からない。 | 無し。 |
| `period-jpname-2` | 日本語固有名詞 | other_period | 訂正しているのは「入社時」の所属についての言明であり、現在の所属の記憶には掛からない。 | 無し。 |
| `neg-numeral-1` | 数詞インデックス | negation | 「今週しなかった」は特定週の報告であり、5号倉庫の棚卸しという習慣自体を否定していない。 | 無し。 |
| `neg-numeral-2` | 数詞インデックス | negation | 「今朝しなかった」は特定日の報告であり、7番会議室の清掃という習慣自体を否定していない。 | 無し。 |
| `vague-numeral-1` | 数詞インデックス | vague | 「さっきの倉庫番号」がどの倉庫を指すか発話から決まらない。 | 無し。 |
| `vague-numeral-2` | 数詞インデックス | vague | 「会議室の番号」は特定の番号を含まない。 | 無し。 |
| `person-numeral-1` | 数詞インデックス | other_person | 訂正の主語は「後任」であり、後任の管理倉庫についての記憶は一度も観測されていない。本人の管理倉庫（5号倉庫）の記憶は成立し続ける。 | 無し。 |
| `person-numeral-2` | 数詞インデックス | other_person | 訂正の主語は「隣の課」であり、隣の課の利用会議室についての記憶は一度も観測されていない。 | 無し。 |
| `period-numeral-1` | 数詞インデックス | other_period | 訂正しているのは「去年」の管理倉庫についての言明であり、現在の管理倉庫（5号倉庫）の記憶には掛からない。 | 無し。 |
| `period-numeral-2` | 数詞インデックス | other_period | 訂正しているのは「異動前」の利用会議室についての言明であり、現在の利用会議室の記憶には掛からない。 | 無し。 |

**⟹ この担当者が実装前に見直した結果、判定を入れ替えたケースは0件だった。**
`jpname-a` のみ、姓の短縮形が来た場合の将来の拡張点として注記した（判定そのものは
変えていない）。**⚠ この「0件だった」という結果自体は、担当者1名の見直しであり、
別の担当者による独立レビューは行っていない**（§8「確かめていないこと」）。

---

## 3. 【実測】既存23件の分類が壊れていないことを示した（変異試験・回帰確認）

### 3.1 基準線（30件追加前）

**測定条件**: `commit 90268ec` + 本 PR の未コミット差分のうち `margin`/`intrusionMargin`
追加のみ（30件の追加は含まない）。`env -u OPENAI_API_KEY DATABASE_URL=... pnpm --filter
@mnemora/example-chat run correction-candidates`。

**A群（n=15）**: hit@1〜10 = 15/15、MRR=1.0000、distractor逆転=0/15、
gold スコア範囲 0.87559〜0.94198。**B群（n=8）**: 棄権=0/8、深い誤爆=6/8(75.0%)、
浅い誤爆=2/8(25.0%)、1位スコア範囲 0.80998〜0.90815。

**⟹ ADR 0232 の実測値（hit@1=15/15、MRR=1.0、深い誤爆75.0%、棄権0.0%）と完全に一致した。**
2回連続実行してもビット一致した(`measuredAt`を除く)。

### 3.2 30件追加後、既存23件だけを抽出して再集計した

**測定条件**: 上と同じ器・同じコマンド。ただし `correction-case-set.eval.ts` は
30件追加後のもの（53件全部を1つの会話へ ingest → 53件それぞれで `recall()`）。

**測定結果(53件全体)**: A群(n=21) hit@1=20/21(95.2%)・hit@3〜10=21/21・MRR=0.9762・
distractor逆転=0/21。B群(n=32) 棄権=0/32・深い誤爆=20/32(62.5%)・浅い誤爆=12/32(37.5%)。

**53件の実測結果から、既存23件のID（A群15+B群8）だけを抽出して再集計**（`node`で
実測 JSON を読み、`caseId` でフィルタしてから `summarizeCorrectionCandidateReport`
と同じ計算式で再計算した——コードは変えていない、計算式だけを再現した):

```
BEFORE: hitCount=15 hitAtK={1:15,3:15,5:15,10:15} mrr=1 distractorBeatsGoldCount=0
        abstainCount=8 protectedAtTopCount=6 shallowMisfireCount=2 abstainedCount=0
AFTER (53件中の既存23件だけを抽出): 完全に同じ値
```

**⟹ 30件を追加しても、既存23件の分類レベルの指標（hit@k所属・distractor逆転・
深い誤爆・浅い誤爆・棄権）は1件も変わらなかった。**

**連続値（スコア・margin）には、次の2種類の変化があった**（分類には影響しない）:

1. **6桁目程度のわずかな揺れ**（例: `move`のgoldScore `0.9406007466336815` →
   `0.9406006545724357`）。ADR 0232/0313 が既に記録している壁時計由来の decay/freshness
   の下位桁の揺れと同型であり、53件版を2回実行しても同じ大きさの揺れが再現した
   （追加そのものが原因ではない）。
2. **2件で、より大きな変化がある**——**追加した30件が同じテナントの会話に同居する
   ことで実際に起きた、意図した副作用**:
   - `meeting`（A群）: `distractorRank` が `2` → `5` に移動した。新しく追加した記憶が
     distractor と gold の間に割り込んだためである。**`distractorBeatsGold` は
     `false` のまま**（distractor は元々2位で gold(1位)を超えていない。5位に
     さらに離れても、この判定は変わらない）。
   - `vague-dunno`（B群）: `topScore` が `0.8139...` から `0.8177...` へ変化した
     （約+0.0037、上の1と桁が違う）。新しく追加した記憶のどれかが1位を奪ったためである。
     53件版を2回実行しても同じ値で再現し（決定的）、`vague-dunno` の `protectedFacts`
     は空配列（曖昧ケースは守るべき相手が記憶に無い）なので `protectedAtTop` は
     `false` のまま——**分類は変わらない。**

**⟹ 「既存23件の report が壊れていないこと」は、分類レベルでは完全一致、連続値
レベルでは「壁時計由来の微小な揺れ」と「新規メモリの介入という理解できる副作用」の
2種類の変化のみであることを、実測で確認した。**

### 3.3 陽性対照 — 4つの変異が実際に噛むことを示した

| # | 変異 | 対象 | 赤くなった歯 | 戻して緑を確認 |
|---|---|---|---|---|
| 1 | `computeCorrectionMargin` の減算を加算に変える（margin の符号を逆にする） | `correction-candidate-arm.ts` | `correction-candidate-arm-margin.test.ts` の`computeCorrectionMargin`系2件 | ✅（`cp`で退避・復元） |
| 2 | `computeIntrusionMargin` の `!protectedAtTop` ガードを外す（誤爆(浅)でも値を返す＝intrusionMarginをmarginと同じ「常に定義される値」に寄せる） | 同上 | `computeIntrusionMargin`系1件（「誤爆(浅)のときはnull」） | ✅ |
| 3 | 既存23件の report の出力形式を変える（`hit@${k} = ...`を`HIT@${k} => ...`に変更） | `formatCorrectionCandidateReport` | 手元の baseline テキストとの `diff`（vitest ではなく CLI 出力の比較）で検出 | ✅ |
| 4 | B群をA群として数える（`summarizeCorrectionCandidateReport`の`abstainCount`を`report.hits.length`にする） | 同上 | `correction-candidate-arm-margin.test.ts`の「A群/B群の取り違え検出」系1件 | ✅ |

**すべて `cp` で退避・復元した（`git checkout` は使っていない）。戻した後、同じ歯が
緑に戻ることまで確認した**（`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」）。

---

## 4. `margin`/`intrusionMargin` の実装で自分が決めたこと（ADR 0291 §5.5 が実装に委ねた部分）

ADR 0291 §5.5 は式だけを決めており（`margin = goldScore − distractorScore`、
`intrusionMargin`は「深い誤爆のとき: topScore − protectedFactScore」）、
`protectedFactScore` が具体的に何を指すかは実装判断として残されていた
（`protectedFacts` は配列であり、複数件のケースがありうる）。

**決めたこと**: `protectedFactScore` は、`protectedFacts` のうち `recall()` が返した
候補の中に実際に現れたものの `ScoreBreakdown.total` の**最小値**（＝最も順位が低い、
最も危うい保護対象）とした。`intrusionMargin` は `protectedAtTop === true`（深い誤爆）の
ときだけ定義し、それ以外（誤爆(浅)・棄権）は `null` とした——ADR 0291 §5.5 の逐語
「誤爆していない/棄権のときは null」にそのまま従う。

**⚠ この決定には副作用がある**——**今日の32件のB群ケースは `protectedFacts` が
0〜1件しか無いため、深い誤爆のとき `topScore` と `protectedFactScore` は必ず同一の
記憶を指し、`intrusionMargin` は常に `0` になる**（実測 §3.1〜3.2 の
`intrusionMarginStats` が `mean=0, stdDev=0, min=0` であることに現れている）。
**これは実装の欠陥ではなく、定義どおりの挙動である**（1位そのものが保護対象で
ある以上、自明な結果）。この値が非自明になるのは `protectedFacts` が複数件の
ケースが増えたときに限る——**この PR はそのようなケースを1件も追加していない**
（既存8件・新規24件とも `protectedFacts` は0または1件）。

**この決定はマネージャーに確認していない。**§5 の「これが覆るとしたら」に記す。

**副産物としての観測**【実測】: `protectedFactScore` は `protectedAtTop === false`
（誤爆(浅)）のときも、保護対象が返った候補の中に(1位以外で)現れていれば値を持つ
（`null` にならない）。例えば `person-jpname-1` は `protectedAtTop=false` だが
`topScore=0.9123`・`protectedFactScore=0.9062`——保護対象がわずかに1位を逃した
ことが分かる。**ただし `intrusionMargin` は定義上ここでは `null` になる**
（深い誤爆ではないため）。この情報は失われていない（`protectedFactScore` 欄に残る）が、
**`intrusionMargin` という一級の値としては読めない**——これは意図した設計であり、
「誤爆(浅)の深刻さ」を測る値が欲しくなったら、別の値として追加すべきという課題として
§7 に残す。

---

## 5. これが覆るとしたら

- **`protectedFacts` が複数件のケースが将来追加され、`intrusionMargin` が実際に
  非自明な値を取るようになったとき。**§4 の決定（最小値を使う）が妥当かどうかを、
  そのときの具体例で再検討する必要がある。
- **`jpname-a` の姓短縮形のような、判定が実は曖昧だったケースが実際に問題を起こしたとき。**
  §2.1 の「曖昧さの検討」で先送りにした点を、そのとき本格的に設計し直す。
- **B群の索引型による深い誤爆率の違い**（ASCII識別子の`other_person`は深い誤爆だったが、
  日本語固有名詞・数詞インデックスの`other_person`は浅い誤爆だった、§6）**が、母数を
  増やしても再現したとき。**索引型ごとに危険度が異なるという仮説が支持されたことになり、
  優先すべき緩和策の設計材料になる。

---

## 6. 【実測】測定結果（全体）

**測定条件**: `docs/autonomy.md` の `initdb` 手順で立てた自分専用の PostgreSQL 17 +
pgvector（ポート55432、非本番）。`@mnemora/local-embedding`
（`sirasagi62/ruri-v3-30m-ONNX`、dtype=q8、256次元、`ruri-v3-30m/sym`）。
`DeterministicLLMProvider`。実 API は一度も叩いていない（`OPENAI_API_KEY` 不使用）。
2回実行し、`measuredAt`以外はビット一致した。

**A群（n=21、既存15+新規6）**: hit@1=20/21(95.2%)・hit@3,5,10=21/21(100%)・
MRR=0.9762・distractor逆転=0/21(0.0%)・gold スコア範囲 0.87558〜0.95877・
margin: n=20 mean=+5.307e-2 stdDev=2.072e-2 min=+1.689e-2
（1件は distractor が上位10圏外で margin 測れず＝`null`）。

**B群（n=32、既存8+新規24）**: 棄権=0/32(0.0%)・🔴 深い誤爆=20/32(62.5%)・
浅い誤爆=12/32(37.5%)・1位スコア範囲 0.80998〜0.93510・
intrusionMargin: n=20 mean=0 stdDev=0 min=0（§4で説明済み）。

**ADR 0232 の実測（深い誤爆75.0%、棄権0.0%）と比べると、深い誤爆率は62.5%へ下がった
——ただし分母が8→32に変わっており、「危険が減った」という意味ではない**（新セルの
一部が浅い誤爆や、より低い深い誤爆率のkindを含んでいるため、全体の比率が動いた）。
**⚠ 棄権率は0.0%のまま変わらない**——「相手が実在しないときに手を止められない」という
ADR 0232 の核心的な指摘は、母数を増やしても再現している。

**索引型別の内訳**（B群、`other_person`のみ）: ASCII識別子の2件は両方とも深い誤爆
だったが、日本語固有名詞・数詞インデックスの`other_person`は4件とも浅い誤爆
だった。⚠ **この差を統計的には主張しない**（各セル2件しかない）——§5に「これが
覆るとしたら」として残す。

**基準値ファイル**: [`examples/chat/correction-candidate-probe-baseline.json`](../../examples/chat/correction-candidate-probe-baseline.json)
に実測記録そのものをコミットした（`provenance`に測定条件・上の解釈を記録）。

---

## 7. CI ジョブの新設（ADR 0291 §7-3）

`.github/workflows/ci.yml` に `correction-candidate-probes` ジョブを追加した——
`identifier-probes`/`numeral-token-probes` ジョブと**同じ形**
（`@mnemora/local-embedding`、鍵不要、毎PR、Job Summary に実測値を残す、基準値ファイルとの
差分を出す、⛔ 門にしない、🔴 重み取得失敗時はジョブ自体を失敗させる）。**既存2ジョブには
1文字も触れていない。**

`scripts/correction-candidate-probe-summary.mjs`/`-lib.mjs` を新設した——
`scripts/numeral-token-probe-summary.mjs`/`-lib.mjs` と同じ分担（純関数/CLIラッパー）・
同じ規律。群は1つだけ（A群/B群という別の軸は `summary` オブジェクトのフィールドとして
表現し、`identifier-probes`のsparse/dense/japanese...のような複数groupにはしない
——このarmは haystack 条件を1つしか持たないため）。

**⚠ このジョブは required ではない**——`.github/required-status-checks.json`
（branch protection の写し、ADR 0279）に `correction-candidate-probes` という文字列は
存在しない。この PR は同ファイルを1バイトも変更していない。`identifier-probes`/
`numeral-token-probes` も同ファイルに載っていないことを確認した——同じ立場である。

**OpenAI 実埋め込みの追加arm（Issue #109後半、ADR 0316の6群）は、この PR では作って
いない。** ADR 0291/0316 のどちらもこの新セルにOpenAI armを要求しておらず、範囲外とした
（§9「確かめていないこと」）。

---

## 8. 検討して採らなかった案

- ⛔ **既存23件・既存の識別子/日本語固有名詞/数詞probeを機械的に水増しする。** 却下。
  出所は ADR 0291 §6 がすでに引いている3つ（ADR 0092、Issue #109 2026-09-15コメント、
  PR #191→ADR 0110の実績）と同じ——**この PR も同じ理由で従う**。件数は行列
  （索引型×kind）を先に決めた結果であり、母数を大きく見せる作為ではない。
- ⛔ **正面から新しい probe 集合ファイルを作る（ADR 0135/0313 と同じ形）。** 検討したが
  採らない——ADR 0291 §5.0 がすでに「同じ arm・同じ目的の拡張だから既存集合を
  拡張する」と決めており、この PR はその決定に従っただけである（自分で再検討して
  いない。ADR 0291 の決定をそのまま実装した）。
- ⛔ **`correction-case-set.dev.ts` に先に置き、動作確認してから `eval.ts` へ昇格する。**
  検討したが採らない——`docs/autonomy.md` §2.2 決定5 は「見て調整したケースは
  development として扱う」であり、逆に「未実行のケースを development に先に置く」
  ことを要求してはいない。§1 のとおり、実装を1回も実行せずに `grounds` を書いた
  ため、最初から `eval.ts`（held-out）に置ける（ADR 0232 の既存23件と同じ手順）。
- ⛔ **`intrusionMargin` を誤爆(浅)にも定義域を広げる。** 検討したが、ADR 0291 §5.5
  の逐語「誤爆していない/棄権のときは null」に反する。§4 で「浅い誤爆の深刻さを測る
  別の値」を将来課題として残すに留めた。
- ⛔ **OpenAI 実埋め込みの追加arm（Issue #109後半と同型の6群）をこのセルにも作る。**
  ADR 0291/0316 のどちらもこれを要求しておらず、時間予算に見合わないと判断した
  （§7）。

---

## 9. 引き受けた負債・確かめていないこと

1. **`jpname-a` の姓短縮形のような曖昧さの検討は、担当者1名によるものであり、
   独立レビューは受けていない。**
2. **`intrusionMargin` の「最小値」という設計判断（§4）は、`protectedFacts` が
   複数件のケースで実際にどう振る舞うかを実測していない**——今日の母集合には
   そのようなケースが無い。
3. **索引型によるB群の深い誤爆率の違い（§6）は、各セル2件という小さい標本からの
   観察であり、統計的には主張しない。**
4. **本番（Postgres + pgvector / HNSW）での実測は行っていない**——ADR 0232/0291と
   同じ制約（自分専用の単一ノード Postgres であり、本番のテナント規模ではない）。
5. **OpenAI 実埋め込みでの実測は行っていない**（§7・§8）。
6. **CI ジョブの配線を検査する機械の歯（`ci-yml-*-wiring.test.mjs`相当）は新設して
   いない**——ADR 0313 §4 が同じ判断をした先例に倣い、時間予算に対して見合わないと
   判断した。手作業でYAMLの構造を確認した（`js-yaml`でparseし、jobsに存在すること、
   ステップ名の並びを確認）。
7. **README の `correction-candidates` 節に書いた「実測結果」の考察（索引型別の
   誤爆率の違い等）にfreshness歯は無い**——ADR 0313 §4と同じ判断（数値そのものは
   焼き込まず、基準値ファイルを指すだけにしてある）。

---

## 10. 確かめたこと / 確かめていないこと

**確かめた【実測】**（詳細は上の各節）

- 30件追加前の測定が ADR 0232 の実測値と完全一致すること。
- 30件追加後、既存23件だけを抽出した分類レベルの指標が完全一致すること。
- 4つの変異（margin符号反転・intrusionMarginガード除去・出力形式変更・A群B群取り違え）
  が実際に検出され、戻すと緑に戻ること。
- `correction-candidate-probe-summary.mjs`/`-lib.mjs` が weights_unavailable・一致・
  相違の3経路すべてで exit 0 を返すこと（子プロセスで実際に起動して確認）。
- `.github/workflows/ci.yml` が `js-yaml` でパースできる有効な YAML のままであること、
  新設ジョブが `jobs` に存在すること。
- `.github/required-status-checks.json` に新設ジョブ名が含まれていないこと。

**確かめていないこと**（§9と重複しない範囲）

- **`identifier-arm.ts` への変更（`formatMarginStats`のexport化）が、既存の
  `identifier-probes`/`numeral-token-probes` の出力・基準値を変えていないこと**は、
  既存の `identifier-arm-margin.test.ts`・`identifier-json.test.ts`・
  `identifier-probe-set.test.ts`（計27件）が全件緑のままであることで確認した——
  ただし `identifier-probes`/`numeral-token-probes` サブコマンド自体を再実行しての
  確認は行っていない（型シグネチャ・戻り値を1つも変えていないコメント追加+export
  キーワード追加のみであるため、実行結果への影響は無いと判断した。この判断は
  クローンの判断であり、CI 側の当該2ジョブの再実行で最終確認されることになる）。
- **数詞インデックスの語彙（5号倉庫/7番会議室）が、ADR 0135/0313 が測った
  `numeral-token-probe-set.ts` の語彙と同じ脆さを持つかは測っていない**——文字種・
  共有前置長の系統的な行列は組んでおらず、単なる語彙の借用である。

---

Refs #109, #369, ADR 0232, ADR 0291

> **追記（2026-09-25、Issue #109）**: §4の「`intrusionMargin`は常に0」について、
`protectionMargin`（別名新設）案を実測で比較した——
[ADR 0333](./0333-identifier-verdict-and-intrusion-margin-candidates.md)（状態:提案。
`intrusionMargin`/`correction-candidate-arm.ts`はこの追記でも書き換えていない）。
