# ADR 0435: claim key の索引の上限（SQLSTATE 54000）を型付きの例外に包む・直接のテストが無かった4つの関数に TSDoc の約束の歯を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探しの14巡目で見つかった2件を、1本の PR にまとめた。

  **(1) claim key の索引の上限が、Postgres だけ生の DB 例外で落ちる。**
  [ADR 0433](./0433-claim-key-length-space-error-reembed-limit.md) 決定1は `deriveClaimKeys`（LLM が返した鍵を作る経路）で長さを 256 コードポイントに絞ったが、store の口を**直接**呼ぶ経路（`MemoryStore.createMemory` などに長い `claimKey` を渡す）は変えていない。ADR 0433「測っていないこと」に「走らせて確かめていない」と書いて残していた。
  - 【現物】`@mnemora/postgres` の `memories` への INSERT は3か所にある（`createMemory`、`createMemoryWithOutbox` と `createMemoriesWithOutboxAndEvents` が共有する `insertMemoryWithOutboxRows`、`supersedeWithNewMemories`）。`claim_key_subject`・`claim_key_predicate` を含む索引は2つ（`idx_memories_claim_key`〔migration 0021、`(tenant_id, subject_id, claim_key_subject, claim_key_predicate)`〕と `idx_memories_claim_predicates`〔migration 0029、`(tenant_id, subject_id, claim_key_predicate, created_at)`〕）で、どちらも btree。
  - 【実測】（手元の Postgres 17、UTF8 `C.UTF-8`）圧縮が効かない hex の predicate 2600 字は通り、2700 字は `index row size 2728 exceeds btree version 4 maximum 2704 for index "idx_memories_claim_key"`（SQLSTATE 54000）。**1万字では message の形が変わり**、`index row requires 10024 bytes, maximum size is 8191`（同じ 54000）になる。**この形は索引の名前を含まない**（1行が 8191 バイトを超えると btree の検査より前に出る）。
  - 【実測】同じ「名前を含まない形」は、`claimKey` と無関係な入力でも出る: 1万字の `tags` の要素、1万字の `subjectId`（どちらも同じ文面の 54000）。`contentHash`・`extractorVersion`・`content`・`digest` の1万字は（索引の形の都合で）通った。名前を含む形の別の索引は、`tags` 2800 字の `idx_memories_tags`（GIN、上限 2712）、`subjectId` 5000 字の `idx_memories_by_subject`。
  - 【実測】返る例外は drizzle の `DrizzleQueryError`（`name: "Error"`、`kind` なし、message は `Failed query: INSERT …\nparams: …` で入力の値〔本文・長い鍵〕を含む）。`cause` が pg の生のエラー。`'a'` × 10万のような繰り返しは圧縮されて通る。
  - 【実測】書きかけ（直す前に確かめた）: `createMemory`・`createMemoryWithOutbox` はトランザクションごと戻る。`supersedeWithNewMemories` も戻り、旧い行は `active` のまま。`createMemoriesWithOutboxAndEvents` は候補ごとの SAVEPOINT で悪い候補だけを戻し、`dropped` に生の `DrizzleQueryError` として積む（全候補が落ちれば最初の例外を投げる）。
  - インメモリ実装（`@mnemora/testkit`）はどの長さも通す。`packages/core/src/ctx.ts` の冒頭がこの非対称を既に書いている（「長さは約束しない・索引の上限で落ちる・testkit は受け入れる」）。

  **(2) 直接のテストが0件の4つの関数。** `isContestedWithoutCompanion`（`interfaces/memory-store.ts`）・`findMalformedIdentifierPart`・`assertWellFormedFilter`（`identifier.ts`）・`isAbort`（`abort.ts`）。Postgres と testkit の store、`Runtime` の口を通して間接的には動いていたが、TSDoc が約束していることを直接縛るテストが無かった。

- **決めたこと**:

  1. **claim key の索引の上限を、型付きの例外 `ClaimKeyIndexLimitError` に包む。**
     - **クラス・kind・判定関数・置き場所は先例に揃えた**: `ClaimKeyIndexLimitError`、`kind: "claim_key_index_limit"`、判定関数 `isClaimKeyIndexLimitError`（[ADR 0418](./0418-store-error-kind-guards.md) の `matchesStoreErrorKind`。`kind` を見て、無ければ `name`）。置き場所は `@mnemora/core` の `interfaces/memory-store.ts`（[ADR 0433](./0433-claim-key-length-space-error-reembed-limit.md) の `EmbeddingSpaceNotRegisteredError` が `interfaces/vector-store.ts` にあるのと同じ。`MemoryStore` の口の例外なので `ContestedWithoutCompanionError` の隣）。`@mnemora/core` から export する。`method`（4つの口のどれか）と `kind` を持つ（[ADR 0423](./0423-identifier-well-formed-and-error-message-without-params.md) の `MalformedIdentifierError` が `field` を持つのと同じく、値ではなく場所を名乗る）。公開 API の差分は追加のみ（`scripts/__snapshots__/public-api/core.d.ts` に6行）。
     - **包む口**: 4つ（`createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories`）の `memories` への INSERT。`@mnemora/postgres` の `translateClaimKeyIndexLimit`（`packages/postgres/src/claim-key-index-limit.ts`）が、INSERT の文だけを包む。
     - **包む条件**は、`cause` の連鎖のどこかの pg のエラーが `code === "54000"` で、message が次の2つの形のどちらかのときに限る。
       - **(a) 索引の名前が入る形**（`index row size N exceeds btree version V maximum M for index "NAME"`）で、`NAME` が `idx_memories_claim_key` か `idx_memories_claim_predicates`。**索引の名前で決める**。
       - **(b) 索引の名前が入らない形**（`index row requires N bytes, maximum size is 8191`）は、message から索引を言えない。そこで入力から、**claim key 以外には原因になりえないときだけ**包む: 入力に `claimKey` があり、かつ `tenantId + subjectId`、`tenantId + extractorVersion + contentHash`、`tags` の各要素が、それぞれ UTF-8 で 2704 バイト以下（単独では 8191 バイトの壁に届かない）。圧縮は値を小さくするだけなので、この条件のもとで 8191 バイトを超えうる行は claim key を含む索引の行だけになる。**決められないときは包まず、今までの生の例外のまま出す**（安全側。誤って包むより、包まないほうが今の振る舞いに近い）。
     - **包まない**: ほかの索引の 54000（`idx_memories_by_subject`・`idx_memories_tags` など、名前付きの形）、名前の無い形で上の条件を満たさないもの（claim key が無い・小さいのに `tags` や `subjectId` が1万字など）、別の SQLSTATE（23514 など）。歯で縛った（4つの口それぞれ）。
     - **断る入力は今と1つも変えない。長さの上限を入口に置かない。** 256 でも 2704 でも入口に新しく置くと、今通っている入力（圧縮で通る長い文字列を含む）を新しく断ることになり、それはオーナーの専権である。この決定は**今 54000 で落ちる入力だけ**が、落ちる場所で型付きの例外になる。今通る入力（`'a'` × 10万・2600 字の hex）は、4つの口のどれでも今どおり通る（歯で縛った）。`@mnemora/testkit` のインメモリ実装は今のまま全長を通し、この例外を投げない。`ctx.ts` の冒頭の注記に「Postgres では型付きの例外で断る（ADR 0435）」を足した。
  2. **params（入力の値）を、message にも `cause` にも残さない。**
     - message は固定の文（`method` と「claim key が索引に対して大きすぎる」「`claimKey.subject`・`claimKey.predicate` を短く」）だけで、入力の値を含まない（ADR 0423 の作法）。
     - **`cause` に drizzle の例外を渡さない**（ADR 0433 が `EmbeddingSpaceNotRegisteredError` の `cause` に `params:` が残ることを負債にしたのと同じ轍を踏まない）。`cause` には、pg のエラーから `code`・`schema`・`table`・`constraint` の4欄だけと、上の2形に**一致した** message（数値と索引名だけ。入力の値は入らない形）を写した**新しい `Error`** を置く。pg の `detail`・`hint`・`where` などと、drizzle の `query`・`params` は写さない。新しい `Error` は `cause` を持たないので、連鎖は2段（型付きの例外 → 値を含まない `Error`）で終わる。
     - 歯で縛った: 例外の連鎖（`cause` をたどり、各段の自前の欄〔message・stack・名前・`method` など〕を文字列にしたもの）に、入力した鍵の先頭 40 文字・本文のマーカー・`params:`・`Failed query`・`INSERT INTO` が現れない。`cause` が `params`・`query` の欄を持たないことも見る。**直す前は drizzle の例外がそのまま出るので、`cause` に drizzle の例外を渡す変異で21件が赤になった**（下の「測ったこと」）。
  3. **書きかけの残り方は、例外を型付きにする前と変えていない。doc と歯に書いた。**
     - `createMemory`・`createMemoryWithOutbox`: トランザクションごと戻る（memory・outbox・`tags` の proposed ラベルが残らない）。
     - `supersedeWithNewMemories`: トランザクションごと戻る。`supersede` の対象だった旧い行は `active` のまま残り、新しい行・outbox・`created`/`superseded` イベントが残らない。
     - `createMemoriesWithOutboxAndEvents`: 候補ごとの SAVEPOINT の仕組みをそのまま使う。ほかの候補は書き、悪い候補は `dropped` に積む。全候補が落ちたときは最初の例外（型付きの例外）を投げ、何も書かない。
     - **`dropped[].error` は新しい型付きの例外になる**（今の生の `DrizzleQueryError` のままにしない）。【判断】根拠は3つ。(i) `dropped` の積み方（[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md)・[ADR 0410](./0410-extract-created-event-in-same-transaction.md)）は「store が投げた例外そのもの」を積むという約束で、store が投げる例外が型付きになれば、積まれる中身も型付きになるのが自然である。(ii) 同じ入力が `createMemoryWithOutbox` では型付きの例外で落ち、一括の `dropped` では生の例外で積まれる、という食い違いを作らない。(iii) 生の `DrizzleQueryError` は `params:`（候補の本文・長い鍵）を抱えたまま `dropped` の利用者（`buildCreatedEvent` など）へ渡るので、params を落とす作法に反する。`Runtime` の `describeDroppedCandidate`（`meta.droppedCandidates` の `code`・`message` を「最も内側の原因」から読む）は、新しい `cause` の `code: "54000"` と pg の文面をそのまま読めるので、`created` イベントの `meta` の中身は変わらない（歯で `code`・`message` の形を確かめた。Runtime を通した確認はしていない）。
  4. **直接のテストが無かった4つの関数に、TSDoc が約束していることの歯を足した**（`packages/core/src/__tests__/` の `is-contested-without-companion.test.ts`・`identifier-helpers.test.ts`・`is-abort.test.ts`）。**振る舞いは変えていない。** 縛った約束は各テストファイルの冒頭に書いた。TSDoc と実装の食い違いは見つからなかった（見つかれば、直さずに報告する約束だった）。

- **検討した代替案**:

  1. **入口で `claimKey` の長さに上限を置く（256 コードポイント、2704 バイトなど）。** 採らなかった。今通っている入力を新しく断る（圧縮で通る長い文字列を含む）ことになり、オーナーの専権である。また、索引の1行の大きさは圧縮後で決まり、`tenantId`・`subjectId` の長さにも左右されるので、`claimKey` の長さだけの上限は「落ちない」を保証しない。
  2. **54000 を索引の名前を見ずにすべて包む。** 採らなかった。`tags`・`subjectId` など claim key と無関係な 54000 まで「claim key が大きすぎる」と誤って名乗る。「名前の無い形」が実測で別の入力からも出るので、この形は入力から決められるときだけ包む。
  3. **名前の無い形は、`claimKey` があれば常に包む。** 採らなかった。`claimKey` が小さいのに `tags` が1万字、という入力で誤って包む（歯で縛った）。
  4. **失敗したあとで、別の問い合わせで原因の索引を確かめる。** 採らなかった。失敗したトランザクションは中断していて問い合わせできず、別の接続では同じトランザクションの未コミットの行が見えない。
  5. **`cause` に pg のエラーをそのまま入れる。** 採らなかった。pg の `DatabaseError` 自身は `params` を持たないが、`detail`・`hint`・`where`・内部の欄を持ち、今後の pg の版で値を含みうる。4欄だけを写した新しい `Error` のほうが、値を含まないことを自分で言える。drizzle の例外を入れる案は、ADR 0433 の負債そのものなので採らなかった。
  6. **`dropped` は今の生の `DrizzleQueryError` のままにする。** 採らなかった（決定3の根拠）。
  7. **Postgres 固有のクラスを `@mnemora/postgres` に置く。** 採らなかった（ADR 0433 代替案6と同じ）。「claim key の索引に入らない」は `MemoryStore` の契約にある概念で、他の adapter も投げうる。
  8. **`insertMemoryWithOutboxRows` などの口に private メソッドを足して包む。** 採らなかった（ADR 0433 代替案7と同じ。公開 API の snapshot が `private xxx;` の行で動く）。代わりに、INSERT の文だけを関数 `translateClaimKeyIndexLimit` で包み、3か所が共有する。共有の `insertMemoryWithOutboxRows` は、呼び出し側の口の名前を引数 `method` で受ける（private のシグネチャは snapshot に出ない）。

- **引き受けた負債**:

  - **名前の無い形の 54000 は、入力の条件で claim key のものと決められるときしか包まない。** `tenantId` + `subjectId` が合計 2704 バイトを超える入力（たとえば 5000 字ずつ）や、`tags` の要素が 2704 バイトを超える入力で、claim key も大きいときは、実際に claim key が原因でも包まず、生の例外のまま出る（偽陰性。今の振る舞い）。索引の名前が message に入る形（claim key の索引の名前）のときは、入力に関わらず包む。
  - **claim key 以外の欄の 54000 は、今も生の `DrizzleQueryError` のまま**（`tags`・`subjectId`・`tenantId` の長さ。params を含む）。この ADR は claim key の索引だけを扱う。
  - **`ClaimKeyIndexLimitError` を投げるのは `@mnemora/postgres` だけ。**他の adapter は、長い claim key で従来の落ち方（testkit は落ちない）のまま。適合テスト（`packages/testkit/src/*-conformance.ts`）には足していない。`isClaimKeyIndexLimitError` が `false` を返すことは、その入力が索引に収まることを意味しない。
  - **利用者は、この例外が出た入力を、長さで事前に判定できない。**索引の1行の大きさは圧縮後で決まり、文字数でもバイト数でも一意に言えない（`ctx.ts` の注記のとおり）。
  - **`cause` の message は pg の文面のままである。**値を含まない形（2形の正規表現に一致したものだけ）を写しているが、pg が将来文面を変えれば、包む条件が外れて生の例外に戻る（安全側に倒れる）。
  - 決定4で、`isContestedWithoutCompanion` の「対向が指す先のテナントを見ない」（Issue #854）など、TSDoc が「今の振る舞い」と書いた約束も縛った。約束を変えるときは歯も直すことになる。

- **これが覆るとしたら**:

  - オーナーが claim key の長さに入口の上限を置くと決めたとき（上限の値・数え方・断る例外の型は、その決定で改めて決まる）。この ADR の例外は、上限を超えないのに索引で落ちる入力（`tenantId`・`subjectId` が長いとき）の受け皿として残るか、置き換わる。
  - 名前の無い形の 54000 を、より確実に索引へ結び付けたいとき。たとえば、索引ごとの INSERT を分ける、pg の将来の版が名前を含む、など。
  - `tags`・`subjectId` など、ほかの欄の索引の上限も型付きにしたいとき。`translateClaimKeyIndexLimit` と同じ形の判定を、欄ごとに足す判断になる（新しい `kind` と公開 API の追加）。
  - 他の adapter にも同じ例外を投げさせたいとき。適合テストに足す判断になる。
  - `dropped[].error` を生の例外へ戻したい利用者が現れたとき。`cause` の連鎖に値を残さないという作法と両立しないので、作法の側を見直す判断になる。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を先に走らせて赤を見てから直した）:

  - 決定1〜3: `packages/postgres/src/__tests__/claim-key-index-limit-error.postgres.test.ts`（32本。4つの口 × 「今 54000 で落ちる5つの入力が型付きになり値が漏れない」「今通る3つの入力が通る」「ほかの 54000・別の SQLSTATE は包まない」に、書きかけの残り方4本）。
    - **直す前**（core に型と判定関数だけがあり、postgres の包みが無い状態）: 24本が赤（落ちる入力20件 + 書きかけの残り方4本）、8本が緑（今通る入力と、包まない入力は、直す前から期待どおり）。
    - **直した後**: 32本とも緑。既存の `claim-key-oversized-part.postgres.test.ts`（2本）も緑。
    - **変異**（`cp` で退避・復元）: (M1) 包む判定を潰す（`if (false && …)`）で24本が赤。(M2) 索引の名前を見ずに 54000 をすべて包む（`return true`）で4本が赤（ほかの索引の 54000 を包まない歯）。(M3) 名前の無い形を常に包む で4本が赤。(M4) `cause` に drizzle の例外を渡す で21本が赤（値が漏れない歯）。**(M5) SQLSTATE の検査を外す変異は赤にならなかった**（message が2形の正規表現に一致することが、実質的に同じ条件を課しているため。SQLSTATE の検査は冗長な二重の保険になっている）。戻したあと、32本が緑に戻ることを確かめた。
  - 決定4: 3つの新しいテストファイル（計 20 本）。変異（`isAbort` を `signal !== undefined` に、`isContestedWithoutCompanion` の `?? null` を外す、`findMalformedIdentifierPart` の対の検出を潰す、`assertWellFormedFilter` の `subjectId` の検査を潰す）で、それぞれ 2・1・4・2 本が赤になり、戻すと緑に戻った。`store-error-guards.test.ts` に判定関数の項目（`ClaimKeyIndexLimitError`）を足した。
  - 公開 API: `node scripts/check-public-api-surface.mjs` の差分は core への追加のみ（`ClaimKeyIndexLimitError`・`isClaimKeyIndexLimitError`）。`--write` で更新した。
  - **測っていないこと**: `tenantId`・`subjectId` の長さが絡む名前の無い形（偽陰性。上の負債）を歯で縛っていない（実測で 5000 字の `subjectId` は名前付きの `idx_memories_by_subject` で落ちることだけ確かめた）。`Runtime`（`observe`・`reflect`）を通した `dropped` の `meta.droppedCandidates` の実際の中身。SQL_ASCII の DB での挙動。`idx_memories_claim_predicates` の名前付きの形そのものを出す入力（`idx_memories_claim_key` が先に落ちるため、歯は `idx_memories_claim_key` だけで確かめた。`idx_memories_claim_predicates` は許可する名前の集合に入れたが、その名前の message を実測していない）。他の adapter。
