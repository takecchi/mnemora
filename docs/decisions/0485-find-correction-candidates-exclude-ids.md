# ADR 0485: 穴探し56巡目 — 訂正の候補を探す `findCorrectionCandidates`。`excludeMemoryIds` は大文字の uuid を除外せず、反復できない値では recall の記録を書いた後に落ちていた

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-3a4ae979 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し）の中だけを直し、新しく断る入力に当たるものは「材料」に回した。`applyCorrection` の経路（ADR 0446）は対象外。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: `findCorrectionCandidates` は `recall(ctx, { text, activityCounting })` を1回呼び、`excludeMemoryIds` と `limit` で後処理するだけの口で、実装は core の `runtime.ts` に1つ。Postgres・InMemory・Fake の差は `recall()` の側に出る。

- **見つけたこと**:
  1. 【実測】`excludeMemoryIds` に大文字にした id を渡すと除外されない（`excludedCount` が 0、1位がそのまま残る）。`@mnemora/postgres` は UUID を小文字で返すので、`observe` した訂正の発話の id を大文字で持つ呼び出し側の自己除外が黙って効かない。core のテスト用の戻り値の検査（`runtime-return-contract.ts` の `checkFindCorrectionCandidatesContract`）は大文字小文字を無視して突き合わせており、約束と実装が食い違っていた（検査を通したときだけ赤になる）。
  2. 【実測】`excludeMemoryIds` が反復できない値（`5`・`{}`）だと、`recall()` を呼んだ後の `new Set(...)` で `TypeError` になる。`recall()` は recall の記録を1件書く（Issue #1244）ので、落ちたのに記録だけが残る。TSDoc は `limit` の `RangeError` を「書き込みも `recall()` も試みる前に落とす」としている。

- **決めたこと**【判断】:
  1. 除外の集合を `recall()` の前に作る。反復できない値は今までどおり `TypeError` だが、recall を呼ぶ前になる。新しく断る入力は無い。
  2. 突き合わせは小文字にそろえて行う（`forget` などと同じ）。文字列でない要素は触らない（`[null]` は今までどおり通る）。TSDoc の `excludeMemoryIds` に書いた。
  3. CHANGELOG の `[1.2.0]` の Fixed に1行。新しく落ちる入力は増えないので migration-v1 の 🔴 は足さない。

- **歯と変異試験**【実測】: `packages/core/src/__tests__/correction-candidates-exclude-edges.test.ts`（3 `it`）。直す前の `runtime.ts`（cp で退避したもの）に戻すと3件とも赤、直した版で緑に戻る。既存の `correction-candidates.test.ts`・`correction-candidates-recall-query.test.ts`・`apply-correction.test.ts` は緑。

- **当てた形（探して割れなかったもの）**【実測】（core の Fake、検査の配線を外した設定で）: `excludeMemoryIds: null` と `[null]` は通る（除外0）。`limit: 1e300`・`1000` は通る（切るだけ）。`limit: null`・`"2"`・`0`・`-1`・`1.5` は `RangeError`（recall 前、embed 回数が増えない）。`text: ""`・`5` と不正な `activityCounting` は `recall()` の ZodError。12件ある状態で `limit: 1000` は12件返る。1位を除外すると残りの `recallRank` は2から始まる。陽性対照: 上の大文字の除外と非反復値は、同じ探り棒で「出た」。**探した範囲は core の Fake の `recall()` 経由だけ**で、Postgres・testkit の InMemory に当てて結果を揃えたわけではない【未確認】（実装の分岐は `recall()` の外に無いので、差が出るなら `recall()` の側）。

- **材料（直していない。決めるのはクローンまたはオーナー）**:
  - `excludeMemoryIds` に id 1つを裸の文字列で渡す（JS・`as`）と、`new Set("uuid...")` が1文字ずつの集合になり、何も除外されず、例外にもならない（【実測】`excluded=0`、自己が候補に残る）。直すなら配列でない値を断る新しい `TypeError`（前例の無い新しい断り）。
  - `text` が `undefined`（JS・`as`）だと `recall()` は text 無しの問い合わせとして通り、埋め込みも呼ばずに `no_candidates` を返す【実測】。TSDoc の「「探していない」という第3の状態は無い」と食い違う。直すなら `text` を断る新しい例外で、新しい断りに当たる。
  - 同じ id を別の綴りで複数渡すのは問題ない（集合）。`omitted` には `excludeMemoryIds` で落とした分は載らない（`excludedCount` だけ）。TSDoc は「recall から運ぶだけ」と書いており食い違いではないが、読み違えやすい【判断】。
