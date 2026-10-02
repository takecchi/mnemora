# ADR 0546: conformance suite に約束を足す——ADR 0458 の A2・A3・A10・PC6 と、`embed` の重複件数（オーナーの判断が出る前に用意した Draft）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（マネージャー mgr-021b84d7。前任 mgr-0e8b0cfd の引き継ぎ）が書いた。**オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。オーナーへの問い 374f6f88 の問1「conformance に約束を足すか」に対し、**オーナーの判断が出る前に、推奨（「足す」5件）どおりの形を先に Draft として用意した**。オーナーが止めたら、この PR は閉じるか、止めた番号の分を外す。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  [ADR 0434](./0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md) 決定5は、歯を suite の外に置き、「`*-conformance.ts` には手を入れていない（適合テストを足すのはオーナーの判断）」とした。[ADR 0452](./0452-testkit-provider-fakes-align-with-contract.md) も「conformance suite への約束の追加（オーナー判断）」を対象外にした。[ADR 0458](./0458-round31-memory-store-promise-teeth-outside-conformance.md) は 31巡目で、suite に直接の歯が無かった約束に歯を足したが、同じ理由で `packages/testkit/src/__tests__/memory-store-round31-teeth.ts` に置いた。ADR 0458 の材料2は「suite に入れるべきと見るもの」として A2・A3・A10・A8・PC6 を挙げ、「suite への追加はオーナーの領分」と残した。
  問い 374f6f88 の問1が、それを聞いている。**この ADR は、その推奨の側を実装した Draft である。**

  ⚠ **「重複件数」の出所について**: 問いの全文の資料は失われていて、**出所は要約版の一語「重複件数」だけである**。ADR 0434 には「重複」という語が0件だった。ADR 0452 の「引き受けた負債」に「conformance suite に約束を足す話（`number[]` の要件・重複入力の件数）もオーナーの判断のまま」（L72）とあるので、**それを `EmbeddingProvider.embed` に重複したテキストを渡したときの件数のことと読んだ**——【判断】であって、問いの原文で確かめたものではない。別の意味（たとえば `getMany` の重複 id。これは ADR 0458 の A4 で既に歯がある）だったなら、この ADR の該当の1本は的外れになる。

  ⚠ **名前の注意**: 「0458 の A2」「0458 の A10」は、ADR 0458 の表の名前である。マージ済みの PR #1417 に出てくる「A8・A10」は Issue #1412 での名前で、**別物**である。この ADR と PR 本文では、必ず「0458 の A10」のように書く。

- **決めたこと**:

  1. **ADR 0434 決定5を置き換える。** 「`*-conformance.ts` には手を入れない（適合テストを足すのはオーナーの判断）」を、次に置き換える。
     - **conformance suite に約束を足す提案は、担い手が推奨つきの Draft PR として出してよい。足すかどうかの決定はオーナーに残る**（Draft のまま、オーナーの止める番号を待つ）。
     - **足した約束は、外せない**（外すのも破壊的変更）。したがって足す PR は、CHANGELOG の `### Breaking` と移行ガイドの 🔴 に書く（決定4）。
     - ADR 0434・0452・0458 の本文は書き換えない。この決定は、それらの該当の一文だけに掛かる。
  2. **足した約束（5件）。** 本文は ADR 0458 の歯（`memory-store-round31-teeth.ts` の A2・A3・A10、`in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts` の半開区間）を手本に、**suite の公開の口（adapter が渡す `createStore` と `listEventsForMemory` などのフック）だけで**書き直した。

     | 約束 | 置き場 | フラグ | `it` |
     |---|---|---|---|
     | 0458 の A2 `abortIfSuperseded` | `memory-store-conformance.ts` | 新設 `supportsAbortIfSuperseded?` | `createMemoryWithOutbox`（投げて何も書かない）／同（active だけ・空配列・省略は今日どおり）／`supersedeWithNewMemories`（`supportsSupersedeWithNewMemories` のとき）／`createMemoriesWithOutboxAndEvents`（`supportsCreateMemoriesWithOutboxAndEvents` のとき） |
     | 0458 の A3 `abortIfAllConflicted` | 同 | 新設 `supportsAbortIfAllConflicted?` | 全件 CAS で弾かれたら news・outbox ごと巻き戻す／1件でも通れば部分成功／省略・`false` は今日どおり |
     | 0458 の A10 `purgeExpiredEventsByRetention` | 同 | 新設 `supportsPurgeExpiredEventsByRetention?` と、保持期間を設定するフック `setEventRetention?` | `unset`／`unlimited`／日数（`executed`・`dryRun`・保持期間の内側では消さない）／他テナントの設定を読まない |
     | PC6 | 同（既存の `supportsFindActiveByClaimKey === true` の枝） | 新設なし | 半開区間——接するだけの区間（両方の向き）は重ならず、1ms 食い込めば重なる |
     | 重複件数 | `embedding-provider-conformance.ts` | **フラグなし（無条件）** | 同じテキストを重複して渡しても、入力と同じ件数を返す |

  3. **新しい3つのフラグは、`supportsAbortIfForgotten` と同じ作りにした。** `boolean | undefined` の3状態。`true` は歯を走らせる。`false` は、手本が `false` で assert していたこと（option を渡しても無視されて今日どおり書く／メソッドが無い）を、それぞれの口に合わせて assert する。省略は「⚠ 未検査: <フラグ名> が指定されていない — adapter "<name>" に対して …」の named it を1本登録する（`it.skip` にしない。`conformance-omitted-flags-named-it.test.ts` の一覧にも足した）。
     - `supportsAbortIfAllConflicted: true` で `supportsSupersedeWithNewMemories` が `true` でない adapter には、検査する口が無いので、口が無いことだけを assert する。
     - **`setEventRetention?` を新設した**【判断】。`purgeExpiredEventsByRetention` の歯は、テナントの保持期間を設定しないと書けないが、`MemoryStore` にその口は無い（`TenantSettingsStore` の側にある）。`listEventsForMemory` と同じ「adapter が渡すフック」にした。`supportsPurgeExpiredEventsByRetention: true` で渡さなければ、各 `it` が説明つきの例外で赤くなる。型は `(ctx, retention: EventRetentionSetting) => Promise<void> | void`、省略可。
     - リポジトリ内の呼び出し（testkit の in-memory の設定 `in-memory-conformance-options.ts`・`packages/postgres` の `conformance.postgres.test.ts`）には、3つとも `true` と `setEventRetention` を渡した。`core` の Fake は suite を走らせていないので対象外。
  4. **破壊的変更として数える。** 内訳は次のとおりで、**数え方が揃っていない点があるので、そのまま書く**。
     - **新しい3つのフラグ**: 任意で、省略すれば「未検査」の it が1本増えるだけ。**この点は、ADR 0458 より前の判定（CHANGELOG `[1.2.0]` の 2026-10-01 の数え直し。「フラグの内側に足した `it` は、フラグを持たない adapter に新しい約束を課さないので非破壊」）に従えば非破壊である**。公開 API（`MemoryStoreConformanceOptions` の欄）の追加としては載る。
     - **PC6**: 既存の `supportsFindActiveByClaimKey: true` の枝への追加。**`true` を渡している外部の adapter が、新しく赤になりうる**（境界が `<=` の実装）。
     - **重複件数**: **無条件**。外部の `EmbeddingProvider` が、重複を畳む実装なら新しく赤になる（下の「調べたこと」）。
     - 依頼は、これらをまとめて `[1.3.0]` の `### Breaking` と移行ガイドの 🔴 に書くことだった。そのとおりにした（PC6 と重複件数が破壊的と数える根拠。新しい3つのフラグは、その中で「公開 API の追加であり、省略すれば影響しない」と書き分けた）。**足した約束は外せない**——外すのも破壊的変更である。
  5. **足さなかったもの。** 次は足していない。
     - 推奨が「足さない」: **0458 の A8**（インメモリの `scopeAggregate: "skip"` が集計を実際にしないこと。インメモリには費用を測る手段が無く、歯を足しても測るものが無い）。**`ClaimKeyIndexLimitError`**（0458 の B4。PG が長い claimKey を断り、IM は断らない差。TSDoc が「今の振る舞いの記録で、揃えるかは決めていない」と書く）。**NUL の文面**（0458 の B3 の系と読んだ【判断】。孤立サロゲートについて PG が U+FFFD に置換し・jsonb は例外にする、IM は保持する差。TSDoc が同じ理由で「今の振る舞いの記録」と書く。依頼の「NUL 文面」が B3 のことか、ADR 0434 の NUL の断りの文面のことかは、原文で確かめていない）。
     - 推奨なし（問いの推奨に挙がっていない。0458 の「縛られていない約束」・「材料3」にあるもの）: `purgeExpiredEvents` が `superseded` のイベントも消すこと（PE8）、`findActiveByClaimKey` が `sourceObservationId` で絞らないこと（B16）、`findContestedByClaimKey` の半開区間（PC6 は `findActiveByClaimKey` だけ。`findContestedByClaimKey` は同じ式だが、依頼に無い）、0458 の候補Bの残り（B12・B14・B15・B17）、A23 の一部。
     - `EmbeddingProvider` の `number[]` の要件（ADR 0452 L72 の括弧の前半）。重複件数と同じ行に書かれていたが、問いの要約に「重複件数」しか無いので足していない。
     - 0458 の A2 の「`abortIfForgotten` の見直しが先」（`implementsAbortIfForgotten` の枝。PG のみ）。依頼の範囲に無い。

- **調べたこと（重複件数）**:

  - **足した `it` は、フラグなしで無条件に走る**【現物】。`describeEmbeddingProviderConformance` の `deterministic` の `maybeIt` にも、`overLimitText` の `maybeOverLimitIt` にも入れていない（フラグを持たない `it`）。
  - **外部の実装を新しく赤にしうるか: しうる。ただし契約の側は重複を許していない。** 契約（`packages/core/src/interfaces/embedding-provider.ts`）は「`embed` は `texts` と同じ件数・同じ順序でベクトルを返す」とだけ書き、**重複を例外として扱う文も、畳んでよいという文も無い**【現物】。したがって、重複を畳んで件数を減らす実装は、今の契約にも既に反している。この `it` はそれを suite が初めて検査するだけで、契約を強めてはいない——が、**外部の adapter から見れば、これまで通っていたものが赤くなる**ので、破壊的と数える。件数だけを問い、重複した位置のベクトルが一致することは問わない（決定性に依存する別の話になる）。
  - **リポジトリ内の実装は緑**【実測】。suite に掛けているものすべてで、`it` が走って緑だった（下の表）。実 API・実モデルは走らせていない（live の2ファイルは opt-in で skip）。

    | 呼び出し | 緑か | 備考 |
    |---|---|---|
    | `DeterministicEmbeddingProvider`・`RecordedEmbeddingProvider`（`embedding-provider-fixtures.conformance.test.ts`） | 緑 | |
    | 同、包み型（`wrapper-providers.conformance.test.ts`。testkit の `SeededEmbeddingProvider`・`RecordingEmbeddingProvider`、`examples/chat` の `CachingEmbeddingProvider`） | 緑 | `RecordingEmbeddingProvider` は下層への問い合わせでは重複を `Set` で畳むが、返す件数は入力と同じ |
    | `OpenAIEmbeddingProvider`（`packages/openai` の `embedding-provider.conformance.test.ts`。応答は記録の再生） | 緑 | 実 API ではない |
    | `LocalEmbeddingProvider`（`packages/local-embedding` の `local-embedding-provider.conformance.test.ts`。pipeline は記録の再生） | 緑 | 実モデルではない |
    | `live.openai.test.ts`・`live.local-embedding.test.ts` | 走らせていない（opt-in で skip） | **実 API・実モデルが重複を畳まないかは確かめていない** |

    リポジトリ内で、返す件数を変える重複排除は見当たらなかった（grep。`cassette-recorder.ts` の `Set` は下層へ問い合わせる分の整理で、返す件数は変えない。上の表のとおり緑）。

- **変異試験**【実測】2026-10-03、PostgreSQL 17 + pgvector（`initdb`、`C.UTF-8`、自分専用のポート）。**足した `it` ごとに、実装を壊して赤になること、戻して緑に戻ることを確かめた。**

  実装は testkit の `InMemoryMemoryStore`（`in-memory-memory-store.ts`）と `PostgresMemoryStore`（`memory-store.ts`）の両方、embedding は testkit の fake。赤の列は、その変異で赤になった `it`（名前の頭）。

  | # | 約束 | 変異 | IM | PG |
  |---|---|---|---|---|
  | 1 | A2 `createMemoryWithOutbox` | `abortIfSuperseded` を無視 | 赤（投げる it） | 赤（同） |
  | 2 | A2 `supersedeWithNewMemories` | 無視 | 赤 | 赤 |
  | 3 | A2 `createMemoriesWithOutboxAndEvents` | 無視 | 赤 | 赤 |
  | 4 | A2 今日どおり（active だけ） | superseded でなく active の id まで断る（status の判定を `!== "forgotten"`） | 赤（2本: 投げる it と「active だけなら書く」it） | 赤（同） |
  | 5 | A3 | 1件でも弾かれたら断る（`> 0`） | 赤（2本: 全件弾き・部分成功） | 赤（同） |
  | 6 | A3 | `abortIfAllConflicted` を無視 | 赤 | 赤 |
  | 7 | A3 | 省略・`false` でも断る | 赤（省略・false の it） | 赤（同） |
  | 8 | A3 news の巻き戻し | 例外は投げるが news を巻き戻さない（commit のあとで投げる） | （変異していない。IM は判定を書き込みの前に置く） | 赤（全件弾きの it） |
  | 9 | 0458 の A10 | `unset` を `unlimited` で返す | 赤（2本: unset・他テナント） | 赤（同） |
  | 10 | 同 | `unlimited` の分岐を消す | 赤 | 赤 |
  | 11 | 同 | `dryRun` を無視して消す | 赤（日数の it） | 赤（同） |
  | 12 | 同 | 他テナントの設定を読む | 赤（他テナントの it） | 赤（同） |
  | 13 | 同 | 日数の cutoff を反転 | 赤（日数の it） | 赤（同） |
  | 14 | PC6 | `targetFrom < otherUntil`（PG は `${validFrom} < valid_until`）を `<=` に | 赤 | 赤 |
  | 15 | PC6 | `otherFrom < targetUntil`（PG は `valid_from < ${validUntil}`）を `<=` に | 赤 | 赤 |
  | 16 | 重複件数 | `DeterministicEmbeddingProvider.embed` が重複を畳む（`new Set`） | 赤（Deterministic の suite だけ） | — |
  | 17 | 重複件数 | `RecordedEmbeddingProvider.embed` が重複を畳む | 赤（Recorded の suite だけ） | — |

  - **戻したあと、同じ `it` が緑に戻ることを、変異ごとに確かめた**（`cp` で退避・復元。`git status` は変異のあと空）。
  - **`false`・省略の枝**も、`InMemoryMemoryStore` を包んで確かめた（一時の試験で、コミットしていない）: 実装している store に `false` を渡すと、`false` の枝の4本が赤（`abortIfSuperseded` の2本・`abortIfAllConflicted` の1本・`purgeExpiredEventsByRetention` の「実装していない」の1本）。実装しない（無視する）store に `false` を渡すと緑。実装しない store に `true` を渡すと、`true` の枝の7本が赤。省略の named it は `conformance-omitted-flags-named-it.test.ts` が縛る。
  - **ADR 0458 の PC6 は「suite の `it` だけでは緑」と書いた**（0458 の表の PC6）。この PR の `it` を足すと、`<` を `<=` にした変異が、suite だけで赤になる（#14・#15）。
  - ⚠ **ADR 0458 の A3 の歯の弱さを1つ見つけた**【実測】。0458 の A3 は、news に抽出キー（`sourceObservationId`・`extractorVersion`）を持たせていなかった。そのため「例外は投げるが news を巻き戻さない」変異（上の #8）を入れても、再送が新規の行を作るだけで、`created: true` のまま緑になる。この PR の `it` は news に抽出キーを持たせ、`listBySourceObservation` と outbox が空であることを見るようにして、#8 で赤になることを確かめた。**0458 の歯（`memory-store-round31-teeth.ts`）は直していない**（古い ADR・既存の歯に触れない方針）。

- **採らなかった案**:

  - **フラグなしで足す**（`abortIfSuperseded` などを無条件で検査する）。採らなかった。ADR 0237 の教訓（必須にすると、既存の呼び出し側の `describeMemoryStoreConformance(...)` がコンパイルできなくなる）と、`supportsAbortIfForgotten` の前例に従った。
  - **重複件数にフラグを付ける**。採らなかった。依頼が無条件と指定し、契約が重複を許していない（上）。
  - **A8・`ClaimKeyIndexLimitError`・NUL の文面を足す**。推奨が「足さない」。
  - **0458 の歯を suite の側へ移して、suite の外の歯を消す**。採らなかった。0458 の歯は IM と PG に同じ本文を走らせる別の形で、他の約束（A1・A4〜A7・A9・A11〜A23）も持つ。この PR が足す5件の分は、suite と重なる（二重に縛る）。

- **引き受けた負債**:

  - 足した約束は外せない（外すのも破壊的変更）。
  - 外部の adapter は、PC6 と重複件数で新しく赤になりうる。PC6 は `findActiveByClaimKey` の境界が `<=` の実装、重複件数は重複を畳む `EmbeddingProvider`。**外部の実装が実際に赤くなるかは測っていない**（外部の実装を持っていない）。
  - **実 API・実モデルが重複で件数を保つかは確かめていない**（live は opt-in で、走らせていない）。
  - 0458 の歯と、この PR の `it` が重なる（同じ約束を2か所で縛る）。0458 の歯は A3 の弱さ（上）を持ったまま。
  - `setEventRetention?` は新しい公開のフックである。名前・型はオーナーが止めるかもしれない。
  - 数え方の食い違い（決定4）。新しい3つのフラグを破壊的と数えるか（`[1.2.0]` の数え直しの判定どおりなら非破壊）は、この PR では決めていない。
  - 「問いの全文を読めていない」。重複件数が上の読みで合っているかは、オーナーに確かめるのが筋である。

- **これが覆るとしたら**:

  - オーナーが、問い 374f6f88 の問1に「足さない」と答えたとき（この PR は閉じる）。または個別の番号を止めたとき（その `it`・フラグを外す。外せば、上の変更は取り消せるが、**マージ済みなら、外すのも破壊的変更**）。
  - 「重複件数」が、`embed` の重複入力ではなく別の件だったと分かったとき。
  - 外部の adapter の事情で、`embed` が重複を畳むことを許すと決めたとき（契約の文面を変える話になる）。
- **測っていないこと**: 実 API・実モデル（上）。CI の `SQL_ASCII` の脚。外部の adapter。`findContestedByClaimKey` の半開区間（足していない）。
