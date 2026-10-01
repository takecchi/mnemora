# ADR 0446: applyCorrection は勝者の検査を書き込みの前に通す・大文字小文字だけ違う correctedId を store に従って候補にする・buildCorrectionReason の winner を大文字小文字だけ違う id でも実際の勝者に合わせる

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー）の委譲先が書いた。直し方はクローンが決めた（「約束に実装を戻す直し・落ちる入力を減らす直し・前例のある同種の穴」は決めてよい線）。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探し21巡目。面は訂正の経路（`applyCorrection`・`buildCorrectionReason`・`findCorrectionCandidates` と、それを受ける `markContested`・`resolveContested` の Postgres 実装・testkit の fixture）。14〜20巡目（ADR 0434〜0443・0445）が見た面とは重ねていない。

  **(1) 例外で終わったのに対が残る。**【現物】`applyCorrection` は `markContested` を呼び、そのあとで `resolveContested` を呼ぶ。`resolveContested` の入口は、`supersede` の `winnerId` が `firstId`・`secondId` のどちらでもなければ（大文字小文字だけの違いを store が同じ記憶と言った場合を除いて）`RangeError` を投げる。この検査が `markContested` の**後**に走るので、`winnerId` を取り違えた呼び出しは `RangeError` で終わるのに、`markContested` の書き込み（両側 `contested`・`updated` イベント2件）は残る。
  【実測】（手元の Postgres 17 と testkit の fixture の両方）`applyCorrection({ correctedId: a, correctingId: b, resolution: { kind: "supersede", winnerId: "nope" } })` は `RangeError: Runtime.resolveContested: resolution.winnerId must be firstId or secondId` を投げ、`a`・`b` はともに `contested`、`a` のイベントは1件だった。`winnerId: undefined`（型を外した呼び出し）も、`null` の `resolution` も同じ（`TypeError` のあと対が残る）。呼び出し側は例外を受けて「何も起きていない」と読むのが自然なので、対が残ったまま気づかない。`markContested`・`resolveContested` を直接呼ぶ口は、検査を書き込みの前に済ませている（`firstId === secondId`、`markContestedPair` の事前検証）。`applyCorrection` だけが、2つの口を繋ぐ位置で順序を崩していた。

  **(2) `correctedId` の大文字小文字。**【現物】`applyCorrection` は `discovery.candidates.find((c) => c.memoryId === correctedId)` の完全一致で候補を探す。`findCorrectionCandidates` が返す `memoryId` は store の綴り（`@mnemora/postgres` は小文字）。【実測】Postgres で、候補の id を大文字にして `correctedId` に渡すと `{ kind: "not_a_candidate" }` で何も書かれない。同じ大文字の id を `markContested` に直接渡すと対になる（`uppercase-uuid-contested-runtime.postgres.test.ts` が測っている、#1324・#1327 の系列）。`resolveContested` の `winnerId` は、同じ種類の食い違いを「store が同じ記憶と言えば勝者として扱う」で直してある。`applyCorrection` の候補の照合にだけ、その扱いが無かった。

  **(3) `buildCorrectionReason` の `winner`。**【現物】`supersede` のとき `winnerId === correctingId` の完全一致なら `"correcting"`、そうでなければ `"corrected"`。【実測】`winnerId` が `correctingId` の大文字（`@mnemora/postgres` の `resolveContested` が勝者として受け付ける綴り）だと `winner=corrected` になる。実際に勝ったのは訂正する側なので、`meta.note` に書かれる監査の記録が実際と逆になる。`correctingId` が大文字で `winnerId` が小文字のときも同じ。

  **探して問題が無かった点**（下の「当てた形」に一覧）:
  `reason` の中身（NUL・孤立サロゲートは両実装とも拒む。ほかは通る）、状態（forgotten・purged・contested・archived）、別テナント、同じ記憶への訂正の同時実行、書き込みと `memory_events` が同じトランザクションに入っていること。

- **決めたこと**:

  1. **`applyCorrection` は、`supersede` の `winnerId` の検査を `markContested` を呼ぶ前に通す。** `resolveContested` の入口にあった勝者の決定を `resolveWinnerSideId` に切り出し、`resolveContested` と `applyCorrection`（`markContested` の前）の両方から呼ぶ。例外の型と文言は変えない（`RangeError: Runtime.resolveContested: resolution.winnerId must be firstId or secondId`）。**今も例外になる入力が、書き込まずに例外になるだけである**——新しく断る入力は増えない。大文字小文字だけ違う `winnerId` を store が同じ記憶と言うときは、今までどおり通る（このとき store を読む回数が1回増える）。
  2. **`correctedId` が候補の id と文字列では一致しないとき、大文字小文字を無視してちょうど1件の候補に一致し、かつ store の `get` が両者を同じ記憶と言えば、その候補として扱う。** 言わなければ（存在しない・別の記憶・大文字小文字を区別する store）今どおり `not_a_candidate`。無視して一致する候補が2件以上のときも今どおり。`resolveContested` の `winnerId` と同じ形（ADR 0446 以前の #1324・#1327 の系列）。**候補外にしていた入力を減らす直し**であり、断る入力は増えない。
  3. **`buildCorrectionReason` は、`winnerId` がどちらの id とも文字列では一致しないとき、大文字小文字を無視して `correctingId` だけに一致するなら `winner=correcting` と書く。** 完全一致を先に採る。どちらとも合わない・両方に合う（両側が大文字小文字だけ違う id）ときは今までどおり `corrected`。**これから書く `meta.note` だけが変わる**。保存済みの `note` は書き換えない（遡らない）。形式（`key=value / …` の4要素）は変えていない。
  4. **契約の歯（`runtime-return-contract.ts` の `checkApplyCorrectionContract`）を、決定2に合わせて広げる。** 完全一致の候補が無くても、大文字小文字を無視してちょうど1件に一致する候補があるときは、`not_a_candidate` も `contested`/`resolved` も許す（後者は、その候補の `recallRank` を運ぶこと）。store の答えは歯からは見えないため。
  5. **TSDoc**（`Runtime.applyCorrection` の手順2・3と `buildCorrectionReason` の `winner`）に、上の3点を書いた。

- **検討した代替案**:

  1. **決定1で、`markContested` の後に `resolveContested` が投げたら `markContested` を巻き戻す。** 採らなかった。2つの口は別々のトランザクションで、巻き戻しは「戻す書き込み」になる（`contested` を `active` に戻すイベントを積むことになる）。書く前に落とすほうが単純で、記録も増えない。
  2. **決定2で、`correctedId` を小文字にそろえて照合する。** 採らなかった。大文字小文字を区別する store（testkit の fixture など）で、別の記憶を指す id を同じとみなしうる。store の `get` に聞く形なら、store の規則に従うだけで済む。
  3. **決定2で、`not_a_candidate` のままにして文書に書く。** 採らなかった。`markContested`・`resolveContested` が受け付ける綴りを `applyCorrection` だけが断る理由が、文書の側にも無い（`resolveContested` の `winnerId` は同じ食い違いを直している）。
  4. **決定3で、`buildCorrectionReason` に store を渡して同じ記憶かを聞く。** 採らなかった。純関数で、store を持たない（`Runtime` を通らずに呼ぶ呼び出し側がいる）。文字列だけで決まる範囲（どちらか一方にだけ合う）に限り、決まらなければ今までの値に倒す。
  5. **決定1で、`resolution.kind` が未知の値のときも断る。** 採らなかった（下の「見つけたが直していない点」）。新しい種類の入力を断る方針で、オーナーの領分。

- **引き受けた負債**:

  - **未知の `resolution.kind`（型を外した呼び出し）は、`resolveContested` が `supersede` の分岐へ倒れる。** 【実測】`resolution: { kind: "weird" }` で `applyCorrection` は `resolved` を返し、**両側とも `superseded`** になった（勝者が無い）。この直しでは触っていない。断る入力を増やす直しであり、オーナーの領分（新しい種類の入力を断る方針）。
  - **`reason` に NUL・孤立サロゲートを含めると、Postgres は `DrizzleQueryError`、fixture は `memory_events.meta must not contain NUL (U+0000) or a lone surrogate code unit` を投げる**（型が違う。どちらも何も書かれない——【実測】例外のあと両側 `active`・イベント0件）。拒むこと自体は fixture が Postgres を写している（`fixtures.ts` の冒頭）。`reason` から取り除いて通す直しは、監査の文を書き換えることになり、落とす値を決める方針なので扱っていない。
  - **決定2は store を2回読む（`get` ×2）。** 完全一致で見つかる通常の経路には影響しない。
  - **`applyCorrection` が `resolved` を返しても、解決が成功したとは限らない**（TSDoc どおり。変えていない）。`correctedId` が候補に居ても `markContested` が `ineligible` を返したとき、`resolveContested` を続けて呼ぶ（既に `contested` の対を2段で解決する使い方のため）。

- **これが覆るとしたら**:

  - 決定1: `applyCorrection` が `markContested` の後の `resolveContested` の失敗を、書き込み済みの対ごと巻き戻す約束にしたいとき（上の代替案1）。
  - 決定2: 大文字小文字を区別する store でも `applyCorrection` が綴りの違いを同じとみなしたいとき。
  - 決定3: `buildCorrectionReason` が `winner` を、`correctedId`・`correctingId` の綴りに依らず store の id で決めたいとき（`CorrectionReasonInput` に store の id を足す公開の型の変更になる）。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を先に走らせて赤を見てから直した）:

  - 歯: `packages/postgres/src/__tests__/apply-correction-case-and-no-partial-write.postgres.test.ts`（11本。2実装 × 3本 + `buildCorrectionReason` の5本）。直す前は5本が赤（`winnerId` を取り違えると対が残る ×2実装、大文字の `correctedId`（Postgres）、`winner=correcting` が2本）。直したあと全部緑。
  - 同時実行（歯にしていない。ADR の特記）: 7つの `applyCorrection`/`forget` を同じ3件の記憶に重ねて撃つ試験（40回、使い捨て）。今の実装では、例外 0 件・`contested` で対が壊れた状態 0 件。陽性対照として `markContestedPair` の `ORDER BY id ASC` を `DESC` に変異させると、同じ試験で生の Postgres 例外（`Failed query: SELECT id, status FROM memories …`）が3件出た。戻したあとは 0 件に戻った。結果は `conflict` として運ばれ、`resolved/conflict/ineligible` などの組が出る。同時実行の穴は conformance の歯にしにくい（既知）ので、歯にせず、再現の記録だけを残した。
  - **測っていないこと**（未測定）: 複数プロセス・複数接続プールの大きさを変えたときの同時実行。`outbox` に関わる経路（`applyCorrection` は outbox ジョブを積まない——現物を読んだだけで、積むかどうかの実測は取っていない）。

- **当てた形**（探して問題が無かった点。Postgres と testkit の fixture の両方。使い捨ての試験）:

  | 面 | 入力 | 結果 |
  |---|---|---|
  | reason | `""`・`"a / b=c"`・`"日本語😀"`・200万字の `"x"` | 両側 `contested`（`resolution` ありなら `active` に解決）、`meta.note` の長さが入力と一致 |
  | reason | `"a\u0000b"`・`"x\ud800y"`・100万字 + NUL | 両実装とも例外、両側 `active`・イベント0件（同じトランザクションで巻き戻る） |
  | 状態 | A が forgotten・A が purged・B が purged・対が既に `contested`・A/B が別の相手と `contested`・A/B が archived | `markResult` は `ineligible`、`resolveResult` は `ineligible`（既に対のときだけ `resolved`）。書き込みなし |
  | テナント | correcting が別テナント・correctedId が別テナント（ctx が別） | `markResult` は `ineligible`（`not_found`） |
  | id | `correctedId === correctingId` | `RangeError: Runtime.markContested: firstId and secondId must differ`（両実装） |
  | id | correcting が NUL・空文字・`zzz`・100万字 | `not_found`（`ineligible`）。例外なし |
  | 同時実行 | 同じ対への3並列（`supersede` 双方向・`both_active`） | 1つだけ成功、残りは `conflict` または `ineligible`。最終状態は一貫 |
  | 同時実行 | 3件の記憶に重なる対 ×7並列 ×40回 | 例外0・壊れた対0（陽性対照は上） |
  | 既存の歯で足りていたもの | 別 subject の対・ロック順 | `resolve-contested-pair-scope-and-concurrency.postgres.test.ts`・`contested-pair-lock-order-concurrency.postgres.test.ts` が既に測っている（読んだだけで、今回は走らせていない） |
