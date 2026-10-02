# ADR 0544: LLM を待つ間に元の記憶が contested（と訂正で負けた superseded）になったら、reextract・consolidate・reflect の3経路は書かずに打ち切る（ADR 0406 の負債1・ADR 0420 の部分成功・ADR 0454 の負債1・5 を置き換える。往復は変えない）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

マネージャー（mgr-4a11055c）から、オーナーの決定の逐語の要約として渡された内容を、担い手が実装した。**この担い手は決定の原文（オーナーの発言そのもの）を確かめていない**——渡された要約の範囲で動いた。要約は「18. LLM の待ちの間の状態変化（0454-1・5・6）」で、選択肢は (a) 維持 (b) contested 等も見て skipped (c) reextract のみ、往復は (d) 維持 (e) X を戻す、採用は「(b) を3経路まとめて、往復は (d) 維持」。「3経路」「contested 等」「skipped」の読みは担い手が現物から決めた（下の「読みの割れ」）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定。

- **文脈**:

  LLM を呼ぶ処理は、LLM が返った後に元の記憶の状態を読み直して、書くかどうかを決める。

  | 経路 | LLM の前の門【現物】 | LLM の後の読み直し（この ADR の前）【現物】 |
  | --- | --- | --- |
  | `reextract` | 「退けた記憶」（`forgotten`〔purge 済み含む〕・`contested`・訂正の解決で負けた `superseded`）が1件でも在れば LLM を呼ばず `status_not_active` で打ち切る（Issue #1079・#1149、ADR 0380）。`archived`・機構で置き換えた `superseded` は通す（ADR 0432 AL-5） | `forgotten` だけ（ADR 0406） |
  | `consolidate` | 統合元は `active` だけ。ほかは `status_not_active` | `forgotten` と `superseded`（ADR 0375 決定7・ADR 0420）。`contested`・`archived` は、一部なら部分成功、全部なら打ち切り（ADR 0420） |
  | `reflect` | 材料は `active` だけ | `forgotten` と `superseded`（ADR 0375 決定7・ADR 0420）。`contested`・`archived` は材料のまま内省に入る |

  LLM の前の門が退ける状態に、待つ間に変わった記憶があっても、後の読み直しは見ない。その結果、**待つ間に `contested` になった（訂正された）記憶の本文から作った記憶が `active` で書かれる**。`reextract` では、言い換えが `active` で書かれ、ほかの `active` な記憶が置き換えられる（ADR 0454 負債1。「訂正した事実が言い換えられて active に戻る」害の窓）。`consolidate`・`reflect` では、訂正された記憶の本文が統合先・内省に混ざる（ADR 0454 負債5と、ADR 0420 の部分成功）。ADR 0406 は負債1と「これが覆るとしたら」で、この範囲を広げる判断を、`consolidate`・`reflect` と一緒に待つと書いていた。

  【実測】直す前の main（`eb614e16`）で、testkit の InMemory と Postgres の各2経路（`supersedeWithNewMemories` の口の有無）と core の `FakeMemoryStore` の2経路に同じ入力を当てた。待つ間に `markContested` すると、`reextract` は言い換えを書いて `extraction: "ok"`、`consolidate` は `consolidated`、`reflect` は `reflected` で終わった。

- **決めたこと**:

  1. **LLM の後の読み直しは、LLM の前の門と同じ門を、もう一度当てる。** 待つ前なら門が退けた状態に、待つ間に変わっていたら、通ったことにしない。
     - **`reextract`**: 読み直した記憶（LLM の前に読んだ、その Observation の全版・全 status の記憶）に、LLM の前と同じ `listWithdrawnAmong` を当てる。`forgotten`（purge 済み含む）・`contested`・訂正の解決で負けた `superseded`（最新の `superseded` イベントの `meta.reason` が `contested_resolved`）が1件でも在れば、何も書かずに打ち切る。`archived`・機構で置き換えた `superseded` は、LLM の前の門が通す状態なので、待つ間にそうなっても止めない。
     - **`consolidate`・`reflect`**: 読み直しで、`superseded` に加えて `contested` も、1件でもあれば打ち切る。`forgotten`・`superseded` は従来どおり。`archived` は変えない（ADR 0420 の部分成功のまま。決定3）。
  2. **打ち切ったときの戻り値は、各経路の既存の語彙をそのまま使う——公開の型を増やさない。**
     - `reextract`: ADR 0406 決定4 の形。`memoryIds: []`・`supersededMemoryIds: []`・`extraction: "skipped"`・`atomicity: "not_attempted"`・`extractionFailure: null`・`skipped` に、止めた記憶ごとの `status_not_active`（`status` は読み直した実際の値——`forgotten`・`contested`・`superseded`）。例外は投げない。
     - `consolidate`: `outcome: "aborted_source_status_changed"`（ADR 0420）。`sources` は変わった記憶が `status_changed_concurrently`（`observedStatus: "contested"`）、ほかは `not_attempted`。
     - `reflect`: `outcome: "aborted_source_status_changed"`。`basis` は変わった記憶が `status_changed_before_write`（`observedStatus: "contested"`）、ほかは `eligible`。
  3. **`consolidate`・`reflect` で `archived` を止めない。** ADR 0420 が「部分成功が残るのは `contested`・`archived` など」と約束して歯（`consolidate-reflect-superseded-race.postgres.test.ts`、`runtime-branch-teeth.test.ts`）に縛っており、`archived` は利用者が訂正した事実ではなく、減衰の掃除の結果でもありうる。`contested` は、利用者の訂正（または claimKey の自動検出）で「この本文は怪しい」と印が付いた状態で、ADR 0406 が追ってきた害（Issue #1149）の本体である。`archived` を止めるかは別の判断（下の「読みの割れ」の表の行4）。
  4. **世代の往復（`X → Y → X`）は変えない（ADR 0454 負債6・代替案2は据え置き）。** X を `active` に戻すような遷移はしない。遷移表（`lifecycle-transition-table.ts`）には触れていない。
  5. **読み直しの窓は、store 側には足さない。** `abortIfForgotten`・`abortIfSuperseded` に当たる、`contested` を見る任意の引数を `MemoryStore.supersedeWithNewMemories?`・`createMemoryWithOutbox` に足せば、`@mnemora/postgres` が書き込みと同じトランザクションの `SELECT … FOR UPDATE` で `contested` も見直せる。だが公開の型（任意の引数と例外）が増えるので足さない。いまの保護は runtime の読み直しだけで、読み直しと書き込みの間の窓は、`contested` については全 adapter に残る（負債1）。

- **読みの割れ（依頼の言葉と現物の食い違い）**:

  | # | 論点 | 候補 | 選んだもの | 理由 |
  | --- | --- | --- | --- | --- |
  | 1 | 「3経路」 | (A) `reextract`・`consolidate`・`reflect`。(B) `reextract` の書き込みの3経路〔口あり・名乗らない adapter の別の `created` 追記・口なし。ADR 0422〕。(C) ADR 0454 の負債 1・5・6 の3項目 | (A) | ADR 0406 の「これが覆るとしたら」が「`consolidate`・`reflect` と一緒に」と書く。ADR 0454 の負債1が `reextract`、負債5が `reflect`。`consolidate` は 0454 の「当てた形」の表（C3）で、`contested` の部分成功が「TSDoc の約束どおり」と書かれた行にあたる。(C) の6は往復で、依頼が別に (d) と書く。(B) は書き込みの経路であって、LLM を待つ間の判定は1か所なので「一括」の対象にならない。**(A) が原文の意図かどうかは確かめていない** |
  | 2 | 「contested 等」の集合 | (i) `contested` だけ。(ii) ADR 0454 負債1の列挙〔`contested`・訂正で負けた `superseded`・機構で置き換えた `superseded`・`archived`〕。(iii) LLM の前の門が退ける状態 | (iii)。`reextract` は `forgotten`・`contested`・`contested_resolved` の `superseded`。`consolidate`/`reflect` は `contested`（`superseded`・`forgotten` は既に打ち切る） | (ii) の `archived`・機構で置き換えた `superseded` は、LLM の前の門が通す状態（ADR 0432 AL-5・ADR 0380）。待つ間にそうなったものだけ止めると、待つ前の同じ状態と結果が食い違う。「待つ前と同じ門を、待った後にもう一度当てる」が、説明できる線 |
  | 3 | 「skipped」 | `ReextractResult.skipped`〔`status_not_active`〕、`ConsolidationResult`/`ReflectionResult` の `outcome: "aborted_source_status_changed"`〔`skipped` 欄は無い〕 | 各経路の既存の語彙 | 公開の型を増やさない（ADR 0406 決定4・ADR 0454 代替案1）。表せない経路は無かった |
  | 4 | `archived`（`consolidate`/`reflect`） | 止める／止めない | 止めない | 決定3。ADR 0454 負債5は `archived` も挙げるが、ADR 0420 の約束と歯がある。止めるなら ADR 0420 も置き換える別の判断で、`runtime-branch-teeth.test.ts` ほか3本を書き換える |

- **検討した代替案**:

  1. **(a) 維持。** 採らなかった（オーナーの決定）。
  2. **(c) `reextract` だけ。** 採らなかった（オーナーの決定は3経路）。`consolidate`/`reflect` は同じ害を持つ。
  3. **(e) X を `active` に戻す（往復）。** 採らなかった（オーナーの決定は (d)）。`superseded` を戻すのは `restoreSuperseded`（利用者の明示的な呼び出し）の仕事で、遷移表に触れる（ADR 0454 代替案2）。
  4. **`ReextractResult` に `outcome` を足す／`ReextractSkip` に新しい種類を足す。** 採らなかった。既存の `status_not_active` に `contested`・`superseded` が載るので足りる。公開の型は増えていない。
  5. **store に `contested` を見る引数を足す。** 決定5。足さなかった。公開の型の材料として下に残す。

- **引き受けた負債**:

  1. **読み直しと書き込みの間の窓（`contested` について）。** `@mnemora/postgres` の `SELECT … FOR UPDATE` は `forgotten`（`abortIfForgotten`）と `superseded`（`abortIfSuperseded`）しか見ない。読み直しの後・書き込みの前に `contested` になると、全 adapter で書かれる。窓は読み直しと書き込みの間（数ミリ秒）で、LLM の待ちの時間ではない。【未確認】この窓に割り込ませる歯は書いていない。
  2. **`consolidate` の口なしの経路は、統合先を書いた後で CAS する。** ADR 0420 の負債と同じで、読み直しより後に `contested` になった分は打ち切れない。
  3. **`archived`・機構で置き換えた `superseded`（`reextract`）、`archived`（`consolidate`/`reflect`）は、待つ間に変わっても止めない。** 読みの割れ 2・4。
  4. **既存の呼び出し側の観測が変わる。** 待つ間に `contested` になった呼び出しは、以前は成功（`extraction: "ok"`・`consolidated`・`reflected`）だったのが、`skipped` 付きの打ち切り・`aborted_source_status_changed` で終わる。`reextract` の `skipped` に `status_not_active`（`status: "contested"`）を見る分岐は、LLM の前に打ち切ったときと区別なく扱える。

- **これが覆るとしたら**:

  - `archived` も止めると決めたとき（読みの割れ 4）。ADR 0420 の部分成功の歯を書き換える。
  - store に `contested` を見る引数を足す（公開の型の変更）と決めたとき。決定5と負債1が変わる。
  - `ReextractResult` に `outcome` を足す（ADR 0406 の「覆るとしたら」）と別の理由で決めたとき。打ち切りをその語彙へ移すか検討する。

- **公開の型の材料**（足していない。決まれば別の判断）:

  - `MemoryStore.supersedeWithNewMemories?`・`createMemoryWithOutbox` の `opts` に、`abortIfContested` に当たる任意の引数と、それに対応する例外（`SourceMemoryForgottenError` に並ぶもの）。`@mnemora/postgres` の `SELECT … FOR UPDATE` で窓（負債1）を閉じられる。conformance の歯と、`InMemoryMemoryStore`・`FakeMemoryStore` の実装も要る。
  - `ReextractSkip` に新しい種類は要らなかった。

- **確かめたこと（赤の証拠・変異試験）**:

  歯は2本。`packages/postgres/src/__tests__/wait-state-change-skipped.postgres.test.ts`（testkit の InMemory と Postgres を、口の有無の2経路ずつ計4通り。11本×4=44本）と、`packages/core/src/__tests__/wait-state-change-skipped.test.ts`（core の `FakeMemoryStore` を口の有無の2経路。5本×2=10本）。LLM の provider stub が Promise を保留し、その間に `markContested`（と `resolveContested`）する。対照の歯は、待つ間に何も変わらなければ従来どおり書かれること、`archived` は `reextract` が従来どおり書き、`consolidate` は従来どおり部分成功、`reflect` は従来どおり内省すること。
  歯だけを先に置いて、直す前の main の実装（`eb614e16`）で走らせた: Postgres 側 44本中20本が赤（目的の歯のすべて）、対照の24本は緑。core 側 10本中8本が赤、対照の2本は緑。直して 44本・10本とも緑。
  変異試験（`runtime.ts` を1か所ずつ変え、歯の両ファイルを走らせ、`cp` で戻して緑を確かめた）: (M1) `reextract` の読み直しを `forgotten` だけに戻す → Postgres 側 12本・core 側 4本が赤。(M2) `consolidate` から `contested` を外す → 4本・2本が赤。(M3) `reflect` から `contested` を外す → 4本・2本が赤。(M4) `reextract` が `archived` も止める → 対照の `archived` の歯だけ 4本・2本が赤。(M5) `listWithdrawnAmong` が `contested_resolved` を見ない → 訂正で負けた `superseded` の歯だけ 4本・2本が赤。
  既存の歯（ADR 0406・0420・0454 の歯、`reextract.test.ts`・`consolidate.test.ts`・`reflect.test.ts`・`runtime.test.ts` ほか）は、書き換えず緑のまま。

- **確かめていないこと**:

  - オーナーの決定の原文。「3経路」「contested 等」「skipped」の読み（読みの割れの表）。
  - 負債1の窓に割り込ませた実測。
  - 実 API（本物の LLM）での挙動。provider は stub。
