# ADR 0454: observe・consolidate・reextract の「操作 × 状態」の行列を当て、reextract の置き換えた側が active でない行になる穴を直した（穴探し30巡目）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先の委譲先が書いた。直し方の線（約束に実装を戻す直しだけを直す）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**:

  穴探し30巡目。面は、23巡目（[ADR 0447](./0447-lifecycle-operation-state-matrix-round23.md)）・26巡目（[ADR 0450](./0450-contested-group-operation-state-matrix-round26.md)）・27巡目（[ADR 0453](./0453-embed-job-and-reinforce-state-matrix-round27.md)）が外していた、
  **`observe`・`consolidate`・`reextract` の「操作 × 状態」の行列**（依頼主の内部の呼び名は「S16」。repo のどこにも記号としては無い）。
  ADR 0447 の13操作に `observe`・`reextract` は入っておらず、`consolidate` は単独の統合元 × 6状態だけが `lifecycle-transition-table.ts` の行に在った。

  除外（当て直さない）: `tick` の embed ジョブと reinforce・`observe({kind:'memory_usage'})`（ADR 0453）、contested の群の書き込み・解決（ADR 0450。群は `claimKey` の検出が読む**相手の status** としてだけ扱い、`markContestedGroup` の中身は見ない）、
  restoreArchived と sweepArchive の窓（ADR 0432）、applyCorrection（ADR 0446）、抽出の暦日（ADR 0440）、保存できない候補（ADR 0347・0443）、`eraseTenant`（ADR 0383。追記2が「書き込みを止めてから呼ぶ」と書いている）。

  【実測】手元の Postgres 17（UTF8、`C.UTF-8`）と testkit のインメモリ実装の**両方**に、使い捨ての探り棒（vitest 4ファイル。commit していない）で同じ行列を当てた。LLM は `RuntimeDeps.llmProvider` の fake（`next` を差し替えて世代を動かし、待ちは Promise で止める）、埋め込みは固定ベクトル。実 API は使っていない。
  各セルで、返り値（`kind`/`outcome`/`skipped`/`atomicity`/`llm` の呼び出し回数）、操作の前後の各記憶の `status`・`supersededById`・`contestedWithId`・`purgedAt`、`memory_events` の `kind:meta.reason`、outbox の `kind:claimedBy:attempts:状態` を取った。
  `supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents` を隠した store（口なしの2段の経路）も、reextract・consolidate・reflect の該当セルで当てた。
  id と時刻を伏せた diff は **173セル × 2実装で、違いは2点だけ**だった: (a) 同点の近傍の並び（`recall` の同点の順。並びを伏せると一致）、(b) NUL を含む本文で `observe` が投げる例外の型（Postgres は `DrizzleQueryError`、インメモリは `Error`。どちらも投げ、書き込みは0件）。

  **結論: 穴が1件（Postgres・インメモリの両方、口あり・口なしの両経路で同じ）。直した。** ただし約束は明文ではなく、次の文からの読みで「約束に実装を戻す直し」と判断して直した（下の「判断の根拠」）。あわせて、文書と実装が食い違う所が2つあり、1つは文書を実装に合わせ（C）、1つは実装を文書に合わせた（D2）。ほかは負債（下の表）。

  ### 穴（直した）: `reextract` の「置き換えた側」が `active` でない行になり、循環・active 0件ができる

  `supersededById`（置き換えた側）は、runtime が「候補列の先頭（`memoryIds[0]`）」を位置で選んでいた。ところが抽出の冪等キー `uq_memories_extraction (tenant, source_observation_id, extractor_version, content_hash)` は **status を問わない**ので、
  候補が同じ Observation・同じ版の `superseded`／`archived` な既存行にぶつかると、store はその行を `created: false` で返す。先頭の候補がそうなると、その非 active の行が置き換えた側になる。【実測・直す前】

  | 入力 | 直す前の結果（両実装・口あり／なし） |
  | --- | --- |
  | 世代の往復 `X → Y → X`（LLM の出力が X、Y、X と変わる。`reextract` を2回） | 2回目で Y が X に置き換えられ、X は Y に置き換えられたまま。**循環。active が0件**。`supersededMemoryIds: [Y]`・`skipped` は X の `status_not_active` |
  | 世代の往復 `X → Y → Z → X` | X → Y、Y → Z、Z → X の**3者の循環**。active が0件 |
  | 子 `[X, Z]` で X が `archived`、出力 `[X, W]` | Z は **`archived` な X** に置き換えられる。同じ呼び出しで作られた新しい active な W は誰も置き換えない |
  | 同、X が `consolidate` で置き換えられた `superseded`（`supersededById` は統合先 C） | Z は X に置き換えられる（Z → X → C の鎖）。出力が `[X]` だけでも同じ |
  | 対照: 出力 `[W, X]`（先頭が W）、X が active のままの `[X, W]` | 今までどおり（Z は先頭の W／X に置き換えられる） |

  セルの数は 13（`reextract` の行列の R1 の1、R2 の8、R3 の4。各2実装）。`classifyReextractTargets`（純関数）は「候補の hash が active に在るか」しか見ず、非 active の既存行への衝突を見ていなかった。

  **約束の有無**（探した場所: `packages/core/src/memory.ts`・`runtime.ts`・`interfaces/memory-store.ts`、`docs/memory-model.md`・`docs/recall.md`、ADR 0027・0028・0029・0100・0230・0447）。**「active が少なくとも1件残る」「循環しない」と明文で書いた文は見つからなかった。** 次の文が、置き換えた側が生きた行であることを前提にしている【判断】:
  - `packages/core/src/memory.ts:11`「`superseded`: 別の Memory に置き換えられた（`supersededById`）」。
  - `docs/recall.md:523`「`condition: 'superseded'` なら `superseded_by_id` を辿って置き換え先を探す一手がある」。循環は辿った先が無い。
  - `docs/decisions/0028-reextract-superseded-cleanup.md:60-61`「`superseded` は機構の都合（より良い抽出に置き換えられた）。`superseded_by_id` が指す先を持てる」と、同 `:96`「そもそも supersede 先の Memory が1件も作られないので `superseded_by_id` の指す先が無い」（候補が0件なら何も supersede しない、の理由）。
  - `docs/memory-model.md:1886`（行5）「旧行の `status`/`superseded_by_id` 更新と**新 Memory の作成**は1トランザクションで完結させる」。
  - `docs/decisions/0447-lifecycle-operation-state-matrix-round23.md:45`（負債4）が、「T と P が互いに superseded の循環」を「`MemoryStore` を直接呼んだときだけ起きる壊れた状態。Runtime は勝者を検査して渡す」と書いている。**Runtime の口がこの状態を作らない、が既存の前提である。**
  逆向きの文もある（直す案を縛るものではない）: `interfaces/memory-store.ts:1387`「`supersededByIndex` が指すのは `news[i]` に対応する Memory であって、今回作られたか既に在ったかは問わない」、`runtime.ts:1676-1679`・ADR 0230 訂正4「`reextract` のアンカーも冪等な `ON CONFLICT` 経由で前から在る Memory に解決されうる」。
  どちらも「前から在る Memory」としか言わず、status には触れていない。**【判断】約束はあると読む（直す線の内）。** この読みが弱いと見るなら、下の「これが覆るとしたら」1を見ること。

  ### 判断の根拠（A の直しを残す理由）

  **明記された約束ではない。** 上の引用はどれも「置き換えた側が active である」「循環しない」とは書いていない。**次の文から、約束に実装を戻す直しと読める。判断で直した。覆すなら、材料に戻す**（歯12本を循環を許す期待に書き換え、`anchorIndex` を外す。「これが覆るとしたら」1）。
  - 前提にしていると読む文: ADR 0447:45（循環は store を直接呼んだときだけの壊れた状態で、Runtime は作らない）、`memory.ts:11`（「別の Memory に置き換えられた」は、置き換え先が生きていることを前提にする）、`docs/recall.md:523`（置き換え先を辿る）、ADR 0028:60-61・:96、`docs/memory-model.md:1886`（行5。新 Memory の作成と一体）。
  - **逆向きの文**: `interfaces/memory-store.ts:1387`（`supersededByIndex` は今回作られたか既に在ったかを問わない）、ADR 0230 訂正4（reextract の anchor は前から在る Memory に解決されうる）。**どちらも status には触れていない**（「既に在った行」を許すだけで、非 active の行が anchor でよいとは言っていない）。
  - 直す側に倒した理由: active が0件になる（循環）のはデータ損失に近い壊れ方で、LLM の出力が往復するだけで起きる。直しは断る入力を増やさず、例外も増やさない（呼び出しは今までどおり成功する）。store と公開の型は変えない。
  - **返り値が変わる入力は2つだけ**（ADR 0454 の決定2。【実測】両実装）:
    1. **全部の候補がぶつかる**入力。例: 子 `[X, Z]` で X が archived、出力が `[X]`。`supersededMemoryIds` が `[Z]` から `[]` になり、Z は active のまま残る（往復 `X → Y → X` の2回目は `[Y]` から `[]`）。
    2. **先頭の候補だけがぶつかる**入力。例: 子 `[X, Z]` で X が archived（または consolidate 済み）、出力が `[X, W]`。`supersededById` が先頭の X から、後ろの新しい行 W に変わる（`supersededMemoryIds` の件数は同じ）。

- **決めたこと**:

  1. **置き換えた側は、今回の抽出で `active` になる行にする。** `reextract` は、`existingBefore`（LLM の後に読んだ、この版の全 status の行）のうち非 `active` の行の `contentHash` を集め、候補列のうちそれにぶつからない**先頭**をアンカーにする（`supersededByIndex` に、その索引を渡す。口なしの経路も同じ候補の id）。ぶつからない候補が無ければ（候補が全部、非 active の既存行にぶつかる）、何も supersede しない。ぶつかった行は、既存の `classifyReextractTargets` が `skipped` に `status_not_active` として載せている（新しい `ReextractSkip` の種類は足さない）。ぶつかる候補が無いとき（今までの通常の場合）は、アンカーは今までどおり先頭で、**何も変わらない**。変更は `packages/core/src/runtime.ts` の `reextract` の数行だけで、store には手を入れていない（Postgres・testkit の実装は同じ口を同じように呼ぶ）。
  2. **直した後で、今成功している呼び出しの返り値が変わるのは、直す前の結果が壊れていた（または置き換えた側が非 active だった）入力だけ**（【実測】両実装）:
     - 全候補が非 active の行にぶつかる入力（往復の `[X]`、`[X]` で X が archived／consolidate 済み）は、`supersededMemoryIds` が `[Z]`（または `[Y]`）から `[]` になり、置き換えられるはずだった active な記憶（Z・Y）は active のまま残る。`memoryIds`・`skipped`・`extraction`・`atomicity` は変わらない。
     - 先頭がぶつかり、後ろの候補が新しい（または active な）行になる入力（`[X, W]` で X が archived／consolidate 済み）は、`supersededById` が先頭の非 active な行から W に変わる。`memoryIds`・`supersededMemoryIds` の件数・`skipped` は変わらない。
     - 上のどちらでもない入力（R の行列の残り53セル）は、返り値も書かれる行も変わらない（直す前後の diff で確かめた）。**断る入力・落とす入力は増えていない**（例外は増えていない。呼び出しは今までどおり成功する）。
  3. **`Runtime.observe` の TSDoc の「claim もされていないまま残る」を直した**（文書だけ）。ADR 0407 以降、`extract: 'sync'` の observe が積む extract ジョブは、observe が claim 済み（`claimed_by: "runtime.observe:sync"`・`attempts: 1`）で作られ、abort（と抽出中の例外）の後もその claim のまま残る。`leaseMs` の内側の `tick` は拾わず（`processed: 0`）、切れた後の `tick` が取り直す（`attempts: 2`）。【実測】両実装。その間の同じ `externalId` の再送は `skipped`（#897 と同じ分岐）。TSDoc に、この3点を書いた。
  4. **冪等な再送の戻り値にも、渡していれば `rejectedSubjectIds: []`・`claimKeyFailure: null`・`contestedDetection: []` を付ける**（実装を TSDoc に合わせた）。`created: false` の分岐は、抽出も検出も走らせずに返す（`extractMode` を見る前）ため、以前は渡していても3欄が無く、3欄の TSDoc の「渡したら常に値／配列」と食い違っていた。【実測】両実装。
     **自然な値が決まると判断した理由**: 3欄の既存の TSDoc が値の意味を決めている。`rejectedSubjectIds` は「弾いた候補が無ければ `[]`」、`claimKeyFailure` は「成功なら `null`」（失敗の理由を持つ欄で、`null` は失敗なし）、`contestedDetection` は「付いた鍵の数だけ要素がある。0件なら `[]`」（欄の有無が区別するのは、`detectContested` を**渡したか**）。再送は新しい記憶を作らず、候補も鍵も無いので、3つとも既存の型・意味の範囲の値（`[]`・`null`・`[]`）になる。型は変えていない（既存の任意欄に値を入れるだけ）。断る入力は増えない。渡していない再送には、今までどおり3欄は付かない（歯で対照にした）。
     **返り値が変わる入力**: `subjectCandidates`（空でない）か `claimKey`（`enabled: true`・`detectContested: true`）を渡した、冪等な再送だけ。欄が増えるだけで、既存の欄の値・書き込みは変わらない。再送を `contestedDetection === undefined` で見分けていた呼び出し側がいれば影響を受ける（再送の印は `extraction: "skipped"` と `memoryIds: []`）。
     最初の実装は、`checkObserveContract`（全 Runtime の呼び出しに掛かる出力の契約の検査。再送に `claimKey` を渡す呼び出しを「契約違反」として赤にしていた。探り棒がこの赤で見つけた）を「再送のときは見ない」に緩めて、TSDoc を「再送では無い」に書き換えていた。**黙って歯を弱めるので戻した**（`runtime-return-contract.ts` は main と同じ）。
  5. **ほかの探り棒は歯にしない**（ADR 0447・0453 と同じ。測った振る舞いは既存の歯と重なる）。歯として足したのは、直した穴（決定1）と、決定3・4 の2点だけ:
     - `packages/postgres/src/__tests__/reextract-anchor-must-be-active.postgres.test.ts`（20本 = 5本 × 2実装 × 口あり／なし。直す前の実装で**12本が赤、対照の8本が緑**。赤の出力は下の「測ったこと」）。
     - `packages/postgres/src/__tests__/observe-abort-extract-job-and-resend.postgres.test.ts`（4本 = 2本 × 2実装。決定3と、決定4の再送の3欄）。

- **検討した代替案**:

  1. **`ReextractSkip` に新しい種類（「置き換える先が active でなかった」）を足す。** 採らなかった。公開の型が増え、`ReextractSkip` に対する exhaustive switch を持つ第三者を壊しうる（`runtime.ts` の supersede の経路のコメント・ADR 0100 が「新しい kind を足さない」と書いている）。置き換えられなかった active な記憶は、ぶつかった行の `status_not_active` が同じ `skipped` に載っているので、全く見えないわけではない。**ただし**、置き換えられなかった記憶そのもの（Z・Y）は `skipped` に載らない。見えにくい点は引き受ける（下の負債2）。
  2. **ぶつかった非 active の行を active に戻して anchor にする（X → Y → X なら X を戻し、Y を置き換える）。** 採らなかった。`reextract` は `archived` を戻さない（ADR 0432 AL-5。TSDoc で約束済み）し、`superseded` を戻すのは `restoreSuperseded` の仕事（利用者の明示的な呼び出し）。遡ったデータの書き換えにもなる。
  3. **store 側（`supersedeWithNewMemories`）で、anchor が非 active なら拒む。** 採らなかった。口は第三者の adapter が実装しうる任意メソッドで（ADR 0100）、新しい例外・新しい引数が公開面に増える。`supersededByIndex` の doc は「既に在った行でもよい」と書いており、store の契約を狭めることになる。runtime の選び方だけで足りた。
  4. **非 active の行にぶつかる候補は、冪等キーを外して新しい行として作る。** 採らなかった。一意索引が拒む。キーを変える直しは migration と ADR 0013 の冪等性の約束に触れる。
  5. **`unchanged`（今回の候補と同じ内容）を、置き換えられなかった active な記憶に流用して名乗る。** 採らなかった。意味が違う（嘘になる）。
  6. **探り棒を conformance の歯として足す。** 採らなかった（決定5）。

- **引き受けた負債**（【実測】は両実装。B は口あり・口なしの両方）:

  | # | 再現 | 結果 | 緊急度 | 覆る条件 |
  | --- | --- | --- | --- | --- |
  | 1 | **B**: `reextract` の LLM を待つ間に、その Observation の子 X を `markContested`（または `resolveContested` で負けさせる、`consolidate` で置き換える、store の口で archived にする）。LLM が返った後に書く | 新しい版 Y2 が **active で書かれ**、他の active な Z は置き換えられる。X は contested／superseded／archived のまま。待つ間に起きた `forget`・`purge` だけは打ち切られる（ADR 0406）。Postgres の `SELECT … FOR UPDATE` も `forgotten` しか見ない（対照: `forget` を割り込ませると、InMemory は読み直しが、Postgres は `FOR UPDATE` が止める。読み直しを外す変異で InMemory だけが赤になった） | **中**。#1149 が塞ごうとした害（訂正した事実が言い換えられて active に戻る）の窓。LLM の待ちの時間に比例する。**既知**（ADR 0406 負債1。この巡で実測した） | `abortIfForgotten` の範囲を contested などへ広げる判断（`consolidate`・`reflect` と一緒に。ADR 0406 の「これが覆るとしたら」）。広げると、待つ間に contest された呼び出しが今は成功しているのに `skipped` で終わる |
  | 2 | 決定1の後、候補が全部非 active の行にぶつかる入力で、置き換えられなかった active な記憶（Z・Y）は `skipped` に載らない | Z は active のまま残り、新しい抽出の結果とは食い違ったまま。ぶつかった行（X）が `status_not_active` で載るので、呼び出し側は「何かにぶつかった」ことは分かる | 低 | `ReextractSkip` に新しい種類を足す判断（公開の型の変更。代替案1） |
  | 3 | 決定1の判定は `existingBefore`（LLM の後・書く前）の読みに基づく。読んだ後・書く前に、anchor にした行が active でなくなる | anchor が非 active になりうる。窓は読みと同じ呼び出しの中の数ミリ秒（store の口の1回の呼び出しの前）。【未確認】窓を実際に割り込ませてはいない | 低 | store の口に anchor の CAS を足す判断（代替案3） |
  | 4 | **D**: `extract: 'sync'` の observe が abort（や例外）で終わった後、リースが切れる前に同じ `externalId` で再送する | `{ memoryIds: [], extraction: 'skipped' }`。実際は未抽出（ジョブが tick を待っている）。「正常な再送」と区別がつかない。ADR 0407 の「採らなかった案」が「再送すると結果が永久に失われる」と書いた形のうち、abort の後の再送を実測した | 低〜中。再送側が `memoryIds: []` を「抽出済みで0件」と読むと、リースが切れるまで（tick が回るまで）記憶が出ない。tick が回れば復旧する | `ObserveResult` に再送の内訳を持たせる（公開の型の変更。`Runtime.observe` の TSDoc が「見送った」と書いている）。今回は TSDoc に書いただけ |
  | 5 | **G の続き**: `reflect` の LLM を待つ間に、土台の1件を `markContested`・`archived` にする | 土台は `used` のまま内省に入る（`sources` に載る）。`forget`／`superseded` は打ち切られる（ADR 0375・0420）。`reflect` は既存の行を書き換えないので、害は「contested・archived な記憶の本文が内省に混ざる」だけ | 低 | `reflect` の見直しの範囲を広げる判断（`abortIfForgotten`／`abortIfSuperseded` の拡張） |
  | 6 | 世代の往復（`X → Y → X`）で、直した後は X が戻らない | 往復した出力は、X の行（superseded）に吸収され、Y が active のまま残る。LLM の最新の出力は X だが、active な記憶は Y。直す前は循環で active が0件だった | 低（直す前よりはよい）。**往復を「X に戻す」意味にする直しは、`superseded` を戻すので採らない** | 代替案2 |

  ほかに、約束どおりで確かめただけのもの（新規ではない）: 下の「当てた形」の表。

- **これが覆るとしたら**:

  1. 「置き換えた側は active な行」を約束とは読まない、と決めたとき（上の約束の引用はどれも明文でなく、`interfaces/memory-store.ts:1387` と ADR 0230 は「既に在った行でもよい」と書いている）。そのときは決定1を戻す（`runtime.ts` の `anchorIndex` を外し、歯 `reextract-anchor-must-be-active.postgres.test.ts` の12本を、循環を許す期待に書き換える）。
  2. `ReextractSkip` に新しい種類を足すと決めたとき（負債2）。決定1の「何も supersede しない」枝で、置き換えられなかった記憶を名指しできる。
  3. 冪等な再送に3欄を付けるのをやめ、「無いこと」を約束にすると決めたとき（決定4。そのときは `checkObserveContract` が再送を見分ける形にする）。`ObserveResult` の型に再送の内訳を足す案（負債4）と一緒に決めるのがよい。

- **測ったこと**（【実測】2026-10-01、Postgres 17、UTF8（`C.UTF-8`）、testkit のインメモリ実装、vitest 1ファイルずつ指名）:

  **セルの数（各2実装）**: `reextract` 66（R1 32、R2 30、R3 4）＋ B 12、`observe` 31（O1 16、O2 5、O3 10）、`consolidate` 36（C1 8、C2 8、C3 20）、`reflect` 28（C1r 8、C3r 20）＝ **173**。穴: **1**（直した。13セル）。文書と実装の食い違い: **2**（C は文書を、D2 は実装を直した）。負債: 6（上の表）。

  **変異試験**（`cp` で退避→変異→探り棒が変わることを確認→戻す。`git status --short` は戻した後に変更が無いことを確認）:

  | # | 変異 | 結果 |
  | --- | --- | --- |
  | M1 | `classifyReextractTargets` の `status !== "active"` に `&& !== "superseded"` を足す（superseded を active と見なす） | R1 の superseded 4セルが両実装で変わった（`sup_cons`／`sup_rx` × 同じ・違う出力、v1） |
  | M2 | `listWithdrawnAmong` から `contested` を外す | R1 の contested 4セル（同じ・違う出力 × v1・v2）が両実装で全部変わった |
  | M3 | reextract の LLM 後の `forgotten` の読み直しを外す | B の `forget` 2セル（InMemory の口あり・なし）が変わった。Postgres は `FOR UPDATE` が守って変わらない（ADR 0406 の変異試験と同じ形） |
  | M4 | `observe` の `!created` 分岐を外す | O1 の16セル中、sync の再送 8セルが両実装で変わった（再送が LLM を呼ぶ） |
  | M5 | `consolidate` の `isWithdrawnSeed` を外す | C2 の `seed-forgotten`・`seed-purged` の2セルが両実装で変わった |
  | M6 | `consolidate` の `abortIfAllConflicted: true` を `false` | 探り棒（待ちの最中の割り込み）は**変わらなかった**（runtime の読み直しが先に止める）。既存の歯 `consolidate-reflect-superseded-race.postgres.test.ts` の「store 側の窓」2本が赤。戻して28本緑 |
  | M7 | Postgres `findActiveByClaimKey` の `status = 'active'` に `archived` を足す | O3 の `other-archived` が変わった（`unresolved_conflict/1` になり、新しい記憶に `claim_key_conflict_unresolved` が積まれた） |
  | M8 | 決定1の直しを入れる前の実装（歯だけの commit） | 歯 20本中12本が赤、対照8本が緑。赤の出力: `X → Y → X`、`[X, W]`（archived な X）、`[X]`（archived な X）の3つが、4通り（InMemory・Postgres × 口あり・口なし）で `AssertionError: expected { …(2) } to deeply equal { …(2) }`（循環の `Y: { status: "superseded", by: "X" }` と期待の `Y: { status: "active", by: null }`、Z の `by: "X"` と期待の `by: "W"`／`active`）。直した後は 113本（reextract 系9ファイル）・core 266本が緑 |
  | M10 | 決定4の直す前の実装（歯だけの commit） | `observe-abort-extract-job-and-resend` の新しい1本が両実装で赤（`toMatchObject` が `rejectedSubjectIds: []` などを満たさない）。Postgres 側は出力の契約の検査も5件で赤（「`claimKey.enabled=true と claimKeyFailure の有無が食い違う`」など。赤の出力は `.hunt-r30/d2-red.txt`）。直した後は4本緑 |
  | M9 | 決定3の歯: `createObservationWithOutbox` の `claimedBy` を渡さない | `observe-abort-extract-job-and-resend` の1本が両実装で赤（ジョブが未 claim で積まれる）。戻して緑 |

  **走らせたテスト（ファイル名指し）**: `packages/postgres/src/__tests__/` の `reextract-anchor-must-be-active`・`observe-abort-extract-job-and-resend`・`reextract-archived-memory`・`reextract-carryover`・`reextract-concurrent-extract`・`reextract-forget-race`・`reextract-source-forgotten-for-update-race`・`reextract-withdrawn-memories`・`runtime-reextract-created-at-and-meta`・`reflect-reextract-inheritance`・`consolidate-reflect-superseded-race`・`observe-aux-field-drop`・`store-boundary-diff`・`testkit-fixtures-nul-numeric-purged-at-alignment`（各 `.postgres.test.ts`）。決定4の後に、`checkObserveContract` を使う影響範囲（再送と claimKey・subjectCandidates を扱うテスト）として、core の `extraction`・`observation`・`runtime`、testkit の `in-memory-return-snapshots`・`in-memory-nul-numeric-purged-at-postgres-alignment` も名指しで走らせた。`packages/core/src/__tests__/` の `reextract`・`runtime`・`restore-superseded`・`superseded-operation-grouping`・`lifecycle-transition-table`・`superseded-reason-writer-consistency`・`reextract-usage-observation`・`fake-memory-store-supersede-with-new-memories`（各 `.test.ts`）。全テストは走らせていない。

  - **測っていないこと**（未測定。次の巡の入口）:
    - `tick` の `consolidate`・`reflect` ジョブの再配達（`autoQueueConsolidateReflectOnExtract: true` の自動経路。memory-model.md が「reflect は再配達で2件になる」と書いている点の実測）。
    - `eraseTenant` と3操作の割り込み（ADR 0383 追記2が「書き込みを止めてから呼ぶ」と書いている。この巡は文書の確認だけ）。
    - 負債3（anchor が読みと書きの間に非 active になる窓）の割り込み。
    - `extractorVersion` が3世代以上跨ぐ `reextract`、版を跨いだ往復（`v1 → v2 → v1`）。
    - 複数プロセス・複数接続プール、SQL_ASCII の DB、実モデル・実 LLM。
    - `reflect` の種（`seedMemoryId`）が各状態のときの行列（この巡は consolidate の種と、reflect の `{memoryIds}` の混在・割り込みだけ）。
    - `claimKey` の検出で、群が結ばれる後の経路（`markContestedGroup` の中身は26巡目の面。この巡は「相手の status」までで、`relationStore` を配線していない）。

- **当てた形**（探して問題が無かった点、または既に約束済みの形。Postgres と testkit のインメモリ実装の両方で一致。`reextract` の R3・R2 の A に当たるセルは「穴」の節）:

  | 面 | 入力 | 結果 |
  | --- | --- | --- |
  | reextract × 子の状態 × 出力 × 版（R1。32セル） | 子 X が active／contested／superseded（consolidate 由来・contested_resolved 由来・reextract 由来）／archived／forgotten／purged × 出力 {同じ, 違う} × {v1, v2（版を上げた runtime）} | **退けた記憶**（contested・forgotten・purged・contested_resolved の superseded）は、v1・v2 とも LLM を呼ばず `status_not_active`・`extraction: "skipped"`・`atomicity: "not_attempted"`・書き込み0件（16セル）。active は同じ出力なら `unchanged`、違えば supersede（v1）／新しい版が並ぶ（v2。#873 の約束どおり）。archived・superseded（consolidate・reextract 由来）は、同じ出力なら何も起きず（`memoryIds` は既存の行）、違えば新しい行が active で作られ、古い行は動かない（v1）。v2 は新しい行が並ぶ |
  | reextract × 割り込み（B。12セル） | LLM の待ちの間に X を forget／purge／contest／contest して負けさせる／archived／consolidate で置き換え × 口あり・なし | forget・purge は打ち切り（ADR 0406）。ほかは負債1 |
  | reextract × 退けた記憶が混在（R2 の contested・forgotten・resolved） | 子 `[X, Z]` で X が退けた状態 | 出力・経路によらず全体を打ち切り、Z は active のまま、書き込み0件（18セル） |
  | observe の再送 × 子の状態 × {sync, deferred}（O1。16セル） | 子が active／contested／superseded 3種／archived／forgotten／purged の Observation に、同じ `externalId` で違う出力の再送 | 全セルで `skipped`・`memoryIds: []`・同じ `observationId`・LLM 0回・記憶の状態は不変・ジョブは増えない（#897 の総則どおり） |
  | observe の抽出ジョブ（O2。5セル） | deferred → 再送 → tick／sync が abort・保存できない本文で終わる → tick（長いリース・短いリース）→ 再送／失敗したジョブ → reextract／reextract → 残った extract ジョブの tick | ジョブは observe の claim のまま残り、リースの内側の tick は拾わず、切れた後の tick が取り直して処理する（決定3）。`failed` なジョブは `reextract` が回復する（`reextract` が新しい記憶を作り、後の tick は embed ジョブだけを処理する）。reextract が先に書いた後の tick は、LLM を呼ばずに終わる（ADR 0347 の判定） |
  | observe の claimKey 検出 × 相手の状態（O3。10セル） | 既存の記憶 A（claimKey あり）が active／contested／superseded 3種／archived／forgotten／purged、続いて同じ鍵の B を `detectContested: true` で | A が active → `contested`（対）。A が contested → `unresolved_conflict`、B に `claim_key_conflict_unresolved`。superseded・archived・forgotten・purged は相手にならず `no_conflict`。active が2件 → `unresolved_conflict`（`relationStore` を配線しない構成）。再送は検出しない |
  | consolidate × 混在した統合元（C1。8セル） | `[A, B, X]` で X が各状態 | X が active 以外なら `status_not_active`（purged も forgotten と同じ）で、A・B だけが統合される。両実装・口あり・`atomicity: store_supported` |
  | consolidate × 種（C2。8セル） | `seedMemoryId` = X が各状態、近傍 A・B は active（embed 済み） | forgotten・purged の種は近傍を集めず、対象は種1件で `status_not_active`。**archived・contested・superseded の種は近傍を集め**（TSDoc 3893 付近の #1136 の文と整合。archived の種は文に書かれていない【負債にはしない。害は見えない】）、A・B が統合される |
  | consolidate × 割り込み（C3。20セル） | 待ちの間に A を forget／purge／contest／archive／contest して負けさせる × {A だけ, 全員} × 口あり・なし | forget・purge は `aborted_source_forgotten`。**負けて superseded は `aborted_source_status_changed`**。contest・archive は A だけなら**部分成功**（A が `status_changed_concurrently`、ほかが統合される。TSDoc の約束どおり）、全員なら `aborted_source_status_changed`。両実装・両経路で同じ |
  | reflect × 混在・割り込み（C1r・C3r。28セル） | consolidate と同じ形 | `status_not_active`／forget・superseded は打ち切り／contest・archive は土台が `used` のまま内省される（負債5） |
