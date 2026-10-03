# ADR 0543: 孤立サロゲートは、InMemory・Fake も Postgres と同じく U+FFFD に置き換えて保存する（ADR 0423 決定5 の「インメモリは保持」・ADR 0458 の B3 の歯を置き換える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

担い手（マネージャー mgr-4a11055c の指示による）が書いた。**決めたのはオーナーである**（オーナーの決定の逐語の要約: 「孤立サロゲートの置換（Postgres）／保持（インメモリ）をどう揃えるか（0456 M1・0458 B3）。いま: Postgres は U+FFFD に置換、インメモリは保持（B3 の歯が固定）。選択肢: (a)揃えない (b)インメモリを寄せる (c)断る。推奨: (b)。領分: ADR 0423 決定5 を覆す」、採用は (b)）。担い手が決めたのは、(b) を**どの欄・どの口まで**当てるかの範囲だけで、その判断は下に【判断】と付けて分けた（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 置き換えるもの（何を何に置き換えるか）

| 古い ADR の決定 | その内容 | この ADR での扱い |
|---|---|---|
| [ADR 0423](./0423-identifier-well-formed-and-error-message-without-params.md) 決定5（「対象にしないもの」の前半） | 本文（`text`・`content`・…・`digest`）の孤立サロゲートを U+FFFD に置き換える今の扱いは変えない。**その「今の扱い」には、インメモリが置き換えずに保持する、が含まれていた**（文脈 (1) の「インメモリ実装は…区別する」は識別子の話で、決定1 が既に断る形にした。本文の側の保持は決定5 の下で残っていた） | **本文・`tags`・claim key・ラベル名など `text` 列の欄について、インメモリ（`InMemoryMemoryStore` ほか）と Fake の保持を、U+FFFD への置き換えに置き換える。** 決定5 の他の部分（`jsonb` 列が断る今の扱い、`subjectCandidates` を対象にしない）は覆さない |
| [ADR 0458](./0458-round31-memory-store-promise-teeth-outside-conformance.md) の B3 の歯（と決定4、材料4） | 「孤立サロゲートを本文の欄へ渡したときは、PG は U+FFFD に置換・IM はそのまま保持／jsonb の欄は PG だけが例外」を、フラグ `loneSurrogateText`（`"replace"`/`"keep"`）で**実装ごとに違う形のまま**縛る。決定4 は「揃えると決まったら、フラグごと書き換える」と予告していた | **B3 の歯を書き換えた**: `text` 列の欄は全実装が U+FFFD（フラグ `loneSurrogateText` を削除）。`jsonb` の欄の差（PG だけが例外）は残るので、フラグ `jsonbRejectsLoneSurrogate` はそのまま縛る |
| [ADR 0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md) の M1 | 本文・`tags`・claim key・ラベル名の孤立サロゲートは断られず U+FFFD になる。**断るか・揃えるかはオーナーの領分**として直さず残した | M1 の「揃える」側を採った（(c) 断る は採らない）。M1 が挙げた欄（`content`・`tags`・claim key・ラベル名）はすべて含む。「断る」と決めたとき H1・H2 の「落とす」を決め直す、という M1 の予告（「これが覆るとしたら」）は、この ADR が (c) を採らないので発動しない |

古い ADR の本文は書き換えていない。この ADR を指す追記も、ADR 0423・0456・0458 には付けていない（`docs/decisions/README.md` は「訂正が要るなら、その場に追記する」と書くが、状態行や「後続」リンクの追記を必須とは書いておらず、それを検査する歯も見当たらなかった【現物: README.md と `scripts/generate-adr-index*.mjs` を読んだ範囲】。要るとオーナーが判断するなら、後から足せる）。代わりに、現行の指し先である `MemoryStore` の TSDoc（`createObservation`・`createMemory`・`registerLabel`）と、`packages/testkit/src/fixtures.ts` の「揃えていないもの」の段落に、この ADR へのリンクを足した。

## 文脈

**(1) 食い違いの現状【実測】**: `@mnemora/postgres` は、`text` 列（と `text[]`・`text` の引数）に入る文字列を node-postgres が UTF-8 に変換するときに、孤立サロゲートを 1 単位ずつ U+FFFD に置き換える。`@mnemora/testkit/fixtures` の `InMemory*` と core のテスト用 `FakeMemoryStore` は、JS の文字列のまま保持していた。同じ入力で、書いて読み返した値が実装ごとに違った（利用者がテストで InMemory を本番の代わりに使うと、テストが本番を保証しなくなる。ADR 0423 の検討した代替案3 と同じ理由）。

**(2) 三つの ADR の食い違い【現物】**: 同じ話を指す三つの ADR が、**対象の欄の範囲を別々に書いている**。

| 候補（置き換える欄の範囲） | 出所 | 含む欄 | 含まない欄 |
|---|---|---|---|
| A. B3 の歯の範囲 | ADR 0458 B3 | `content`・`digest`・`tags`（と、jsonb の `attributes`・`provenance` の例外） | claim key・ラベル名・`kind`・`contentHash`・`extractorVersion`・イベントの `digestSnapshot`・outbox の `kind`/`claimedBy`・墓石 |
| B. M1 の範囲 | ADR 0456 M1 | `content`・`tags`・claim key（主語）・ラベル名 | `digest`・`contentHash`・`extractorVersion`・`kind`・`digestSnapshot`・outbox・墓石・読み取りの引数 |
| C. Postgres が実際に置き換える範囲 | 【実測】（下） | A と B の和に加え、`contentHash`・`extractorVersion`・claim key の主語と述語・Observation の `kind`・`memory_events.digest_snapshot`・outbox の `kind`・`claimed_by`・`purgeMemory` の墓石の `content`/`digest`・読み取りの引数（`claimKey`・`extractorVersion`・`labels`・`kinds`・`claimedBy`・`taxonomyGroupCandidates`） | `jsonb` 列の欄（`payload`・`attributes`・`provenance`・イベントの `actor`/`meta`。Postgres は**置き換えず断る**。InMemory・Fake は `payload`・`attributes`・`provenance` を保持して通し、`actor`・`meta` は 3 実装とも断る〔Issue #1211〕）、識別子（ADR 0423 決定1 が入口で断る） |

**選んだもの: C。**【判断】理由: オーナーの決定は「Postgres に揃える」であり、揃える先の振る舞いは、ADR の文面（A・B はそれぞれ一部しか書いていない）ではなく、Postgres の現物が決める。A や B で止めると、揃えたはずなのに `contentHash` を置き換えた/置き換えない、の食い違いが InMemory と Postgres の間に新しく残る（冪等の鍵が `contentHash` なので、保存側だけ置き換えて鍵は置き換えない、などの差が値の衝突に出る）。A・B は C の部分集合なので、どちらの文面も破らない。

## 決定

1. **インメモリ（`InMemoryMemoryStore`・`InMemoryOutboxStore`・`InMemoryEventStore`〔`buildStoredMemoryEvent`〕・`InMemoryVectorStore`・`InMemoryLexicalStore`）と `FakeMemoryStore` ほか（core の `runtime-fakes.ts`）は、`text` 列に入る欄の孤立サロゲートを U+FFFD に置き換えて保存する。** 1 単位ずつ置き換える（対をなす絵文字・U+FFFD そのもの・空文字は変えない）。node-postgres と同じ結果で、`String.prototype.toWellFormed` と同じ。入力のオブジェクトは書き換えない。
2. **対象の欄は、Postgres で実際に置き換わると【実測】したものに揃える**（候補 C）:
   - `createMemory` 系（`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の新しい行を含む）: `content`・`digest`・`contentHash`・`tags` の各要素・`extractorVersion`・`claimKey.subject`・`claimKey.predicate`。**冪等の鍵（`contentHash`・`extractorVersion`）も置き換えた後の値で比べる**（Postgres の一意制約が置き換え後の値に当たるため）。
   - `createObservation` 系: `kind`（`subjectId`・`externalId` は識別子なので ADR 0423 のまま断る）。
   - `registerLabel` の `name`。`purgeMemory` の墓石の `content`・`digest`。イベントの `digestSnapshot`。outbox の `kind`（`jobKinds` の要素）・`claimed_by`。
   - **読み取りの引数も同じ規則で置き換える**: `findActiveByClaimKey`・`findContestedByClaimKey` の `claimKey`・`contentHash`（`contentHash` は下の「追記【実測】」の S4 で足した）、`listBySourceObservation` の `extractorVersion`、`aggregateScope` の `labels`・`taxonomyGroupCandidates`、`VectorStore`/`LexicalStore` の `filter.labels`、`OutboxStore.claimBatch` の `kinds`・`claimedBy`。保存側が置き換わるので、引数側を置き換えないと、同じ入力で書いて引いても当たらなくなる（Postgres は当たる）。
3. **置き換えないもの（この ADR の対象外）**: `jsonb` 列の欄。
   - `payload`・`attributes`・`provenance`: Postgres は**断る**（`invalid input syntax for type json`）が、InMemory/Fake は今も保持して通す。
   - イベントの `actor`・`meta`: **3 実装とも断る**（Postgres・InMemory・Fake とも、書く前の検査 `memory_events.actor/meta must not contain NUL (U+0000) or a lone surrogate code unit`。Issue #1211）。差は無い。

   「置き換え」と「断る」は別の差で、オーナーの決定の (b) は前者の話である。この差は残る（下の「引き受けた負債」）。識別子は ADR 0423 のまま（入口で断る）。
4. **共有の道具は testkit の内部に置き、core の公開 API に足さない。** `packages/testkit/src/__fixtures__/well-formed-text.ts`（`replaceLoneSurrogates` ほか、`index.ts`・`fixtures.ts` から export しない）。core の `runtime-fakes.ts` は testkit を import できない（`dependency-boundary.test.ts`）ので、同じ規則の小さな写し（`wf`）を持つ。**公開の型・関数・例外の種類は足していない**（公開 API の snapshot は変えていない）。
5. **B3 の歯を書き換え、3 実装の突き合わせを足した。** 突き合わせの本体は `packages/testkit/src/__tests__/lone-surrogate-fffd-teeth.ts` で、同じ本文を `PostgresMemoryStore`（`packages/postgres/src/__tests__/lone-surrogate-fffd.postgres.test.ts`）・`InMemoryMemoryStore`（`lone-surrogate-fffd.test.ts`）・`FakeMemoryStore`（`lone-surrogate-fffd-fake.test.ts`）に流す。期待値は 3 実装とも同じ。**conformance suite（`*-conformance.ts`）には足していない**（ADR 0434 決定5: suite に約束を足すのはオーナーの領分）。

## 直す前の赤【実測】（2026-10-02）

実装（上の 6 ファイル）を `origin/main` の状態に戻し、歯だけを残して走らせた:

- `lone-surrogate-fffd.test.ts`（InMemory）・`lone-surrogate-fffd-fake.test.ts`（Fake）・`memory-store-round31.test.ts`（B3 を新しい形に書き換えたもの）: **103 本が赤**（InMemory 51・Fake 51・B3 の 1）。赤の理由はどれも「置き換わるはずが、孤立サロゲートのまま返った」（`expected 'a�b' ... Received 'a<孤立サロゲート>b'`）。緑のまま残ったのは対照の歯（対をなすサロゲート・普通の文字列・U+FFFD・空文字が変わらないこと、入力のオブジェクトを書き換えないこと）。
- 同じ歯を `PostgresMemoryStore` に当てると、**直す前から全部緑**（57 本）。Postgres が実際に置き換える欄を、この歯が決めている（候補 C の根拠）。最初に書いた歯のうち Postgres で緑になったものだけを残した（`createMemoriesWithOutboxAndEvents`・`outbox.last_error` など、Postgres の側で確かめていない口は歯にしていない）。

## 直した後の緑【実測】

同じ歯: InMemory 57 本・Fake 57 本・Postgres 57 本、すべて緑。`memory-store-round31`（IM 35 緑 1 skip、PG の B3 緑）。既存の名指しのテスト（`in-memory-fixtures.conformance`・`in-memory-fixtures-nul-content`・`in-memory-fixtures-observation-nul`・`in-memory-input-checks-adr0493`・`fake-input-checks-round2`・`fake-recall-and-subject-input-checks`・`recall-pipeline` ほか）も緑。

## 変異試験【実測】

実装に変異を入れ、狙った歯だけが赤になることを見て、戻して緑を確かめた（`cp` で退避・復元）:

| # | 変異 | 結果 |
|---|---|---|
| M1 | InMemory の `createMemoryIdempotent` の置き換えを外す | 21 本赤（`createMemory`・`contentHash`・outbox 経由・tags の潰れ・読み取り引数） |
| M2 | 一部だけ（`content` だけ置き換える） | M1 と同じ 21 本赤 |
| M3 | イベントの `digestSnapshot` の置き換えを外す | 10 本赤 |
| M4 / M11 | outbox の `kind` / `claimedBy` の置き換えを外す | 各 5 本赤 |
| M5 / M6 | `claimKey` / `extractorVersion` の読み取り引数の置き換えを外す | 各 5 本赤 |
| M8 / M9 / M10 | `registerLabel` / 墓石 / Observation の `kind` | 各 5 本赤 |
| M12 | `aggregateScope` の `labels` | 5 本赤 |
| M17 / M18 | `claimBatch` の `kinds` / `claimedBy` | 各 5 本赤 |
| M7 | 過剰置き換え（対をなすサロゲートも壊す: 正規表現を `[\uD800-\uDFFF]` に） | 対照の 2 本が赤（絵文字が変わる） |
| M13〜M16・M19 | Fake に同様の変異（`content`・`digestSnapshot`・`extractorVersion` の引数・過剰置き換え・`claimBatch` の `kinds`） | 各 5〜10 本赤（過剰置き換えは対照の 2 本） |

Postgres の側には変異を入れていない（置き換えは node-postgres というドライバの振る舞いで、リポジトリの実装の行ではない。Postgres の歯は「置き換えの出所」を実測で固定する役）。

**追記【実測】（2026-10-02、別の担い手が確かめ直したとき）**:

- **生き残った変異**: 上の表に無い口を1か所ずつ外すと、歯が緑のままだった。`InMemoryMemoryStore`・`FakeMemoryStore` の `findContestedByClaimKey` の `claimKey`、`aggregateScope` の `taxonomyGroupCandidates`、`InMemoryVectorStore`・`InMemoryLexicalStore`・`FakeVectorStore`・`FakeLexicalStore` の `filter.labels`。決定2 はこれらの引数も置き換えると書いていたが、歯が当たっていなかった。
- **塞ぐために足した歯**（コミット `0fd908c3`、`lone-surrogate-fffd-teeth.ts`）: (1) `findContestedByClaimKey` と `taxonomyGroupCandidates` を、孤立サロゲートの入力と置き換え後の入力の両方で引く歯。(2) Vector・Lexical の `filter.labels` を同じく両方で引く歯。そのために `LoneSurrogateKit` に任意の口 `searchByLabels` を足し、3つのテストファイル（InMemory・Fake・Postgres）が実装を持つ。(3) 対照の歯: `jsonb` 列の欄（`attributes`・`provenance`）は置き換えない（Postgres は断り、InMemory・Fake はそのまま保持する。U+FFFD にはならない）。旧 B3 は断ったかどうかしか見ておらず、InMemory が `attributes` を置き換える過剰な変異は生き残っていた。
- **足した後**: 歯は InMemory 68・Fake 68・Postgres 68 本、すべて緑（Postgres が `taxonomyGroupCandidates`・`findContestedByClaimKey`・Vector/Lexical の `filter.labels` も置き換えることを実測で確かめた）。上の生き残った変異は、InMemory・Fake とも各 5 本赤になり、戻すと緑に戻った。`attributes` を置き換える変異は 1 本赤（戻して緑）。
- **表の本数との食い違い**: M1・M2 の「21 本赤」は、確かめ直した取り方では再現しなかった。InMemory の `createMemoryIdempotent` 呼び出し（`replaceLoneSurrogatesInNewMemory`）を丸ごと外すと 22 本赤（InMemory の歯と B3 の合計）、`tags` だけ外すと 17 本、`digest` だけ 11 本、`contentHash` だけ 5 本、claimKey の述語だけ 10 本だった。どの変異も赤になる点は表と同じで、本数だけが合わない（数え方・変異の入れ方の違いによる。どちらの取り方だったかは確かめていない）。

**追記【実測】（採用前の初稿への追記。S4・S2・S3）**:

- **S4（`findActiveByClaimKey`・`findContestedByClaimKey` の `contentHash` 引数）**: InMemory・Fake は引数の `contentHash` を置き換えずに `m.contentHash === query.contentHash` で比べていた（保存値は置き換え済み）。Postgres は `content_hash <> ${query.contentHash}` で、引数を driver が U+FFFD にしてから比べる。【実測】保存値 `h-a\uD800b`（→ `h-a�b`）の記憶に対して、引数を「置き換え前」「U+FFFD 済み」「別の値」で引いた結果（「当たる」= 除外されず返る。find 2種とも同じ）:

  | 実装 | 置き換え前の引数 | U+FFFD 済みの引数 | 別の値 |
  |---|---|---|---|
  | Postgres | 当たらない（除外される） | 当たらない | 当たる |
  | InMemory（直す前） | **当たる**（食い違い） | 当たらない | 当たる |
  | Fake（直す前） | **当たる**（食い違い） | 当たらない | 当たる |

  直し: InMemory・Fake の2つの find とも、比べる前に引数の `contentHash` を置き換える（`replaceLoneSurrogates` / `wf`）。歯は `lone-surrogate-fffd-teeth.ts` の「読み取りの引数 contentHash」（5 型 × 3 実装）。直す前は InMemory・Fake が各 5 本赤、Postgres は緑。直すと全部緑。直しを戻す変異（InMemory・Fake それぞれ、active・contested それぞれ）は各 5 本赤、戻すと緑。
- **S2（Observation の `payload`）**: 【実測】Postgres は `invalid input syntax for type json`（`22P02`）で断る（キーに孤立サロゲートが在っても同じ）。ADR の記述（jsonb は置き換えず断る）と合っている。InMemory・Fake は断らずそのまま保持する。歯: 「対照（対象外・S2）」（`createObservation`・`createObservationWithOutbox`）。`LoneSurrogateKit` に `jsonbRejectsLoneSurrogate` を足し、Postgres は「断る」、InMemory・Fake は「保持して読み戻しても U+FFFD にならない」を縛る。`payload` を置き換える過剰な変異は InMemory・Fake・Postgres それぞれ 1 本赤（戻して緑）。
- **S3（イベントの `actor`）**: 【実測】Postgres は書く前の検査（`memory_events.actor must not contain NUL (U+0000) or a lone surrogate code unit`）で断る。**InMemory・Fake も同じく断る**（`memory-event-check.ts`・`runtime-fakes.ts`。Issue #1211）。上の決定3 の「InMemory/Fake は今も保持して通す」は `payload`・`attributes`・`provenance` の話で、`actor`・`meta` には当たらない（3実装とも断る）。歯: 「対照（対象外・S3）」（断る・イベントも状態も書かない）。`actor` を置き換えて通してしまう過剰な変異は InMemory・Fake 各 1 本赤（戻して緑）。

## 検討した代替案

1. **(a) 揃えない。** オーナーが採らなかった。
2. **(c) 孤立サロゲートを断る（Postgres・InMemory とも `MalformedIdentifierError` 相当）。** オーナーが採らなかった。ADR 0456 M1 が書くとおり、LLM が返した tag `"絵\ud83d"` のように今通っている入力が新しく例外になる。
3. **候補 A（B3 の範囲）か B（M1 の範囲）だけを揃える。** 上の「選んだもの」のとおり採らなかった。
4. **core に公開の `replaceLoneSurrogates` を足し、Postgres 側のコードでも使う。** 採らなかった。Postgres の置き換えは driver に任せていてコードに無い。公開 API（ADR 0178 の snapshot）を増やす理由が、testkit の内部の道具には無い。core の `runtime.ts` 内に同じ正規表現の私的な写しが既に在る（`text-truncation` の文脈）。
5. **Fake を testkit の fixture に作り替えて 1 つにする。** この PR の範囲を超える（core は testkit に依存できない）。写しを 1 つ持つ。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | **`jsonb` 列の欄（`payload`・`attributes`・`provenance`）の差は残る。** Postgres は孤立サロゲートで例外、InMemory/Fake は保持して通す。`runtime.observe` の `text`・`content` などは全部 `payload`（`jsonb`）に入るので、`observe` が孤立サロゲートを含む本文を InMemory では通し Postgres では断る、という差が今も在る。B3 のフラグ `jsonbRejectsLoneSurrogate` が縛っている。これを揃える（InMemory も断る）かはオーナーの判断で、この ADR は決めていない | 中 |
| 2 | **Fake は testkit の道具の写しを持つ。** `wf` と `replaceLoneSurrogates` が別々に在り、片方を直し忘れうる。3 実装の突き合わせの歯（同じ本文）が、ずれを検出する | 低 |
| 3 | **置き換えの対象の網羅は、実測した口に限る。** 歯にしたのは上の口。ほかに `text` 列を持つ口（`outbox.last_error` は port から読めず歯にできない、`tenant_settings` の列挙値は CHECK が先に断る）は、置き換えも確かめていない | 低 |
| 4 | **全文検索の問い（`LexicalStore.search` の `query`）の孤立サロゲートは揃えていない**【未確認】。語の分割が U+FFFD と孤立サロゲートで同じに振る舞うかは、Postgres・InMemory の両方で測っていない | 低 |
| 5 | **すでに保存された値は直さない。** 利用者のテストが InMemory の保持に頼っていた（孤立サロゲートの入った本文を書いて同じ値を読み返す）なら、値が変わって落ちる | 低 |

## これが覆るとしたら

- Postgres が孤立サロゲートを区別して保存する（`bytea` 列など）ように変わったとき、または driver の置き換えがなくなるとき: 置き換えの根拠が無くなる。B3 の歯と突き合わせの歯は、Postgres の現物を実測で固定しているので、先にそこが赤くなる。
- オーナーが (c)（断る）に倒すとき: 3 実装の突き合わせの歯の期待値を「例外」に書き換える。
- `jsonb` の欄を揃えると決まったとき: フラグ `jsonbRejectsLoneSurrogate` を消し、InMemory/Fake に拒否を足す。

## 公開の型に種類を足す必要があるか

**無い**。例外の種類・型・関数は足していない。もし将来 `jsonb` の欄を InMemory も断る形に揃えるなら、断る例外の種類（`MalformedIdentifierError` の `field` の語彙〔識別子の欄名〕では足りず、`reason: "lone_surrogate"` の新しい `field`、または別の種類）が要る。これは材料として残す。

## 確かめていないこと

- 本物の `@mnemora/postgres` を InMemory の代わりに差し替える利用者のテストが、孤立サロゲートの保持に頼っているか。
- `outbox.last_error` が Postgres で置き換わるか（port の読み口が無い）。
- `LexicalStore.search` の `query` の孤立サロゲート（負債 4）。
- SQL_ASCII の DB（CI の第二の脚）での Postgres の振る舞い。この ADR の実測は UTF8（`--locale=C.UTF-8`）の 1 つの regime だけ。CI の結果は PR 側で見る。
