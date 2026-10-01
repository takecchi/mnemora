# ADR 0458: 31巡目——MemoryStore の port の約束のうち、conformance suite にも既存の歯にも見当たらなかったものに、同じ本文の歯を2実装へ足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-3a4ae979）の委譲先が書いた。クローン miku が決めた線の中で書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。
**この ADR は src を1行も変えない**（歯を足しただけ。testkit の fixture も `@mnemora/postgres` も変えていない）。

- **文脈**:

  31巡目は「store の適合テスト（`packages/testkit/src/memory-store-conformance.ts`）が `MemoryStore` の port の約束を実際に縛っているか」。第1段（grep と読み）で、port（`packages/core/src/interfaces/memory-store.ts`）の TSDoc を256行の約束に割り、suite の `it`（413行）・testkit の `__tests__`・`packages/postgres/src/__tests__` の歯と突き合わせた。直接の歯が見当たらない約束（候補）は、重複をまとめて**候補A 23件・候補B 17件**だった（約束の表の全文は担い手の作業用ファイルにあり、この ADR の「縛られていない約束」の節に結果を写す）。
  第2段（この PR）は、その候補に歯を足し、**足した歯が実際に赤くなるか**を、Postgres とインメモリの両方に約束を破る変異を入れて確かめた。

  外したもの: provider（PR #1565 の面）、reextract に固有の口（`listBySourceObservation`・`listBySourceObservationAllVersions`）。**`supersedeWithNewMemories` の `abortIfSuperseded`・`abortIfAllConflicted`・冪等衝突の `supersededByIndex`・`abortIfForgotten` を無視することは store の側の約束なので当てた**（クローンの回答）。PR #1564（reextract の anchor。runtime だけを直し、store には触れない）は、この作業を始めた時点（main は 5dbd11c6）でまだ OPEN で main に入っていなかった。store の口は重ならない。

- **決めたこと**:

  1. **足した歯は suite の外に置く**（[ADR 0434](./0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md) 決定5: conformance suite に約束を足すのはオーナーの領分）。`packages/testkit/src/*-conformance.ts` には触れていない。
     - 本文は1つ: `packages/testkit/src/__tests__/memory-store-round31-teeth.ts`（`describeRound31Teeth(name, makeKit, flags)`）。
     - インメモリに当てる: `packages/testkit/src/__tests__/memory-store-round31.test.ts`。Postgres に当てる: `packages/postgres/src/__tests__/memory-store-round31.postgres.test.ts`（本文は相対 import で共有。同じ歯が2実装に走る）。
     - 実装ごとに違う部分は `flags` で名乗らせる（`implementsAbortIfForgotten`・`loneSurrogateText`・`jsonbRejectsLoneSurrogate`・`claimKeyIndexLimit`）。**フラグは TSDoc が「違う」と書いている差だけ**で、差が出たものを黙らせるために足してはいない。
  2. **歯は今の2実装のどちらでも緑**（【実測】2026-10-01、PostgreSQL 17）。直す実装は無く、**インメモリを Postgres に揃える ADR 0434 型の直しも要らなかった**（A23 の `eraseTenant` も、インメモリは events・labels・relations・activity を消していた）。
  3. 歯が縛る約束（足した `it` の名前は先頭の ID）:

     | ID | 約束 |
     |---|---|
     | A1 | ADR 0439 のテナント検査は、冪等の衝突で既存の行を返す `createMemory`/`createMemoryWithOutbox` にも当たる |
     | A2 | `abortIfSuperseded`（`createMemoryWithOutbox`・`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`）: `SourceMemoryStatusChangedError`（`method`・`changed`）・何も書かない・空配列/省略は今日どおり。`abortIfForgotten` の見直しが先（PG のみ） |
     | A3 | `abortIfAllConflicted`: 全件 CAS 弾きなら news ごと巻き戻し、1件でも通れば部分成功、省略・false は今日どおり |
     | A4 | `getMany` の `ids` の重複は結果に1回だけ（PG に直接の歯が無かった） |
     | A5 | `updateStatus`/`updateStatusWithEvent` の判定順（対象の id → `supersededById` → `expectedStatus`）。`resolveContestedPair`/`resolveContestedGroup` は CAS の判定のあとにテナント検査が当たる |
     | A6 | `reinforce` は status を見ない（active/contested/archived/superseded/forgotten のどれでも書く。Issue #840） |
     | A7 | `reinforceMany` は ids[i] 順・同長・重複 id は同じ行・古い `at` は no-op |
     | A9 | `purgeExpiredEvents` は対象0件なら削除も `events_purged` の追記もせず、oldest/newest は null |
     | A10 | `purgeExpiredEventsByRetention` の `unset`/`unlimited`/`executed`（dryRun・他テナントの設定を読まない） |
     | A11 | `purgeExpiredRecalls` は監査行を積まない |
     | A12 | `archiveDecayed` の `usesSubjectActivityCounters`（`S_x` を足して比べる／既定 false は足さない） |
     | A13 | `purgeMemory`/`scrubPurged` は registered の label を触らない（`proposedCount` 1 の registered で見る） |
     | A14 | `scrubPurged` は `memory_events` を積まない |
     | A15 | `RangeError` のメッセージ: `markContestedGroup`/`resolveContestedGroup` の4種は TSDoc どおり。**`markContestedPair`/`resolveContestedPair` は `: first.id and second.id must differ` で終わることだけを縛る**（下の材料1） |
     | A16 | `resolveContestedGroup` の3件未満・重複 id は `RangeError`（何も書かない） |
     | A17 | `resolveContestedGroup` の到達集合は status で判定（forget で群から抜けた分は欠けに数えない。ADR 0381 決定10） |
     | A18 | `markContestedGroup` は既存の関係の行を重複させない |
     | A19 | `markContestedGroup`/`resolveContestedGroup` は存在しない id で「memory not found」・何も書かない |
     | A20 | `markContestedGroup`/`resolveContestedGroup` は別テナントの記憶に触れない |
     | A21 | `restoreSupersededBy` は `updatedAt` を進め content/digest は書き換えない |
     | A22 | `proposedCount` は「新規作成された回数」: 冪等な再送では増えない |
     | A23 | `eraseTenant` は memory_events・labels・memory_relations・tenant_activity も消す |
     | B1 | `createObservation` の `input.tenantId` が ctx と違っても ctx のテナントで書く |
     | B2 | `jobKinds` の各要素につき1件のジョブ（Observation・Memory） |
     | B3 | 孤立サロゲートを本文の欄へ渡したときの今の振る舞い（PG は U+FFFD に置換、IM は保持、jsonb の欄は PG だけが例外。`createMemory` の TSDoc の記録） |
     | B4 | 索引の上限を持たない adapter（IM）は、長い claimKey を受け入れて投げない |
     | B5 | `setEmbeddingStatus` は ready→failed だけを禁じる（ready→pending・skipped は書く） |
     | B7 | `recordUsage` は `memoryIds` が空なら無効な recallId でも空の結果 |
     | B9 | `supersedeWithNewMemories` の `news[i]` が冪等で既存行に衝突しても、`supersededByIndex` はその既存行を指し、ジョブを積まない |
     | B10 | abortIfForgotten を実装しない adapter（IM）は、supersede でも無視して今日どおり書く |
     | B11 | `createMemoriesWithOutboxAndEvents` の `opts.now` が outbox の availableAt/createdAt に届く |
     | B13 | `resolveOrphanedContested` は別テナント・形式不正な id を「memory not found」にする |

  4. **変異の結果**（約束を破る形の変異を、実装のソースに1つずつ入れ、狙った `it` だけを `-t` で撃った。【実測】。元のファイルは `cp` で退避して `cp` で戻し、`git status` が歯の3ファイルだけ（未追跡）になることと、戻した後に歯が緑に戻ることを確かめた。`git checkout` は使っていない）:

     赤=その歯が赤くなった。表にない列は未変異（理由を後ろに書く）。

     | 約束 | IM | PG | 変異の形（要旨） |
     |---|---|---|---|
     | A1 | 赤 | 赤 | 参照の検査を冪等の判定の後ろへ（IM）／`WHERE` と throw から外す（PG。冪等の経路だけの変異は作れず、PG は参照検査全体を外した変異） |
     | A2 | 赤（3口） | 赤（3口）、順序 赤 | 見直しの `changed.length > 0` を `> 99`／forgotten の見直しを superseded 指定時に飛ばす |
     | A3 | 赤 | 赤 | `conflicted.length === supersede.length` を `=== -1` |
     | A4 | 赤 | 赤 | 重複を飛ばす `seen` を外す／`unnest` と JOIN に変える |
     | A5 | 赤（updateStatus・WithEvent・pair・group 各々） | 赤（updateStatus 系・pair・group） | 検査の順を入れ替える |
     | A6 | 赤 | 赤 | forgotten を書かない |
     | A7 | 赤 | 赤 | 重複を畳む／単調性の条件を外す |
     | A9 | 赤 | 赤 | `purged === 0` の早期 return を外す |
     | A10 | 赤（unset・unlimited 各々） | 赤（同） | `unset`→`unlimited`／`unlimited` の分岐を外す |
     | A11 | 赤 | 赤 | `events_purged` を積む |
     | A12 | 赤 | 赤 | `usesSubjectActivityCounters` を無視 |
     | A13 | 赤（purgeMemory・scrubPurged） | 赤（同） | proposed でなくても減らす／条件を外す |
     | A14 | 赤 | 赤（SQL で event を足した変異） | scrubPurged に event を足す |
     | A15 | 赤（4種＋pair） | 赤（4種＋pair） | メッセージを変える |
     | A16 | 赤（<3・重複） | 赤（<3・重複） | resolve 側の検査を外す |
     | A17 | 赤 | 赤 | 到達集合の `status = 'contested'` を外す |
     | A18 | 赤 | 赤（`ON CONFLICT` を外すと一意制約違反） | 重複を許す |
     | A19 | 赤（mark・resolve） | 赤（同） | not found の throw を外す |
     | A20 | 赤 | **単段の変異は緑、全段を外すと赤** | テナント条件を外す。PG の存在検査だけを外しても、後ろの UPDATE のテナント条件が守る（`tenant-boundary-teeth` が「3段」と書く多重防御）。存在検査と UPDATE の両方を外した変異で赤 |
     | A21 | 赤 | 赤 | `updated_at` を書かない |
     | A22 | 赤 | 赤 | 冪等の経路で label を数える（IM の最初の変異は Observation 側の同名の分岐に当たって緑だった。Memory 側の `createMemoryIdempotent` に当て直して赤） |
     | A23 | 赤（events・relations・labels・activity 各々） | 赤（events・relations・labels 各々） | 消す手順の1つを外す。`recall_usages`・`memory_labels`・`tenant_activity`（PG）は port の読み口で観測できず、変異していない |
     | B1 | 赤 | 赤 | `input.tenantId` で書く |
     | B2 | 赤（Observation・Memory） | 赤（同） | 先頭1件だけ積む |
     | B3 | 赤 | 赤 | IM に置換を足す／PG に拒否を足す |
     | B4 | 赤 | （PG は対象外） | IM に長さの拒否を足す |
     | B5 | 赤 | 赤 | ready からは何も書かない |
     | B7 | 赤 | 赤 | 空配列の早期 return を外す |
     | B9 | 赤 | 赤 | `created:false` のとき対象自身を指す |
     | B10 | 赤 | （PG は実装があり対象外） | IM に abortIfForgotten を実装する |
     | B11 | 赤 | 赤 | `opts.now` を無視 |
     | B13 | 赤 | 赤 | テナントの条件を外す／別テナントを見る |

     変異のうち「緑のまま」だったのは A20 の PG の単段だけ（多重防御のため。約束が守られている）。A8（IM の `scopeAggregate:"skip"` が集計しない）は変異していない（下）。

  5. **陽性対照**（既に縛られているはずの約束で、同じ手順の変異が赤になること。探り棒が生きていることの確認）:

     | # | 約束 | IM | PG |
     |---|---|---|---|
     | PC1 | reinforce の起点は狭義 `<` | 赤 | 赤 |
     | PC2 | ready→failed の no-op | 赤 | 赤 |
     | PC3 | updateStatus の CAS | 赤 | 赤 |
     | PC4 | archiveDecayed の `<=` | 赤 | 赤 |
     | PC5 | purgeExpiredEvents の `at < olderThan` | 赤 | 赤 |
     | PC6 | find の半開区間 | 赤（round3 の歯。suite の `it` だけでは緑——`<` を `<=` にしても、suite は接するだけの区間を縛っていない） | 赤（同） |
     | PC7 | markContestedGroup の重なり判定 | 赤 | 赤 |
     | PC8 | supersede の created の並び | 赤 | 赤 |
     | PC9 | setEmbeddingStatus のテナント | 赤 | 赤 |
     | PC10 | recordUsage の ADR 0439 検査（IM は参照側と recall 側の2変異） | 赤 | （変異していない） |
     | PC11 | purge の CAS | 赤 | 赤 |
     | PC12 | restoreSupersededBy の `status='superseded'` | 赤 | 赤（最初の変異は Invalid Date の分岐に当たり緑だった。本線に当て直して赤） |
     | PC13 | listLabels の順序（suite 外の歯） | 赤 | 赤 |

     PC10 の PG は、`cross-tenant-reference-check.postgres.test.ts` と suite が縛っており、今回の巡では撃っていない。PC6 は「suite だけでは緑」が分かった（suite が弱い箇所の1つ。suite 外の round3 の歯が縛っている）。

- **縛られていない約束**（この PR の後も、足した歯・既存の歯のどちらにも見当たらないもの。「見当たらない」は grep と読みの範囲で、断定ではない）:

  - **A8**: インメモリの `aggregateScope` の `scopeAggregate:"skip"` が件数集計を**実際にしない**こと。インメモリには「集計の費用」を測る手段が無い（suite が `countScopeAggregateQueries` を渡さない adapter に「⚠ 未検査」の it を1本だけ置く）。**歯を足さない**（`skip` でも `digestBand` のためにループは回る。測るものが無い）。PG は suite の歯が縛る。
  - **A9 の PE8**: `purgeExpiredEvents` が `superseded` のイベントも保持期間を過ぎれば消すこと（Issue #821 の追記）。固定すると約束を増やす形なので足していない（材料3）。
  - **B16**: `findActiveByClaimKey` は `sourceObservationId` で絞らない（兄弟 Memory を返す。ADR 0377）。同上。
  - **候補Bの残り**（軽い付随条項。足していない）: B12（`events_purged` の meta は4欄のみ・`purgeExpiredEventsByRetention` が `purgeExpiredEvents` と同じ判断・IM の削除と追記の原子性）、B14（`markContestedGroup` の「3件未満・重複で何も書かれない」・CAS 違反の `expectedStatus='active'` の欄）、B15（IM の `resolveContestedGroup` が既存 `superseded_by_id` を消さない）、B17（IM の `eraseTenant` は記録を残さない）。
  - **A23 の一部**: `recall_usages`・`memory_labels`・`tenant_activity`（PG）は、`eraseTenant` が消したかを port の読み口から観測できない。PG は `erase-tenant-all-tenant-tables` が表を列挙して縛る。
  - **A5 の「resolveContestedPair 以外の CAS の後」**: `resolveOrphanedContested` の `supersededById` は無い。

- **材料**（オーナーの領分・クローンが決めること。この PR は決めていない）:

  1. **TSDoc と実装のメッセージのずれ（A15）**: port は `markContestedPair`/`resolveContestedPair` の `RangeError` のメッセージを「`markContestedPair: first.id and second.id must differ`」「`resolveContestedPair: first.id and second.id must differ`」と書くが、2実装とも接頭辞は実装のクラス名（`InMemoryMemoryStore: …`・`PostgresMemoryStore: …`）。`markContestedGroup`/`resolveContestedGroup` の4種は TSDoc どおり。直すなら TSDoc を実装に合わせる（コメントだけ）か、実装のメッセージを TSDoc に合わせる（挙動が変わる）。この PR は歯を「`: first.id and second.id must differ` で終わる」に留めた。
     - **追記（2026-10-01）: クローン（miku）の判断で、TSDoc を実装に合わせた**（コメントだけの直し。実装のメッセージは変えていない）。port の2か所は、メッセージを「`<実装のクラス名>: first.id and second.id must differ`」（例: `PostgresMemoryStore: …`・`InMemoryMemoryStore: …`）と書く。
  2. **suite に入れるべきと見るもの**: A2・A3（`abortIfSuperseded`・`abortIfAllConflicted` は suite に語が0件）、A10（`purgeExpiredEventsByRetention` は suite に語が0件）、A8（インメモリが計測フックを名乗らない）、PC6 の「接するだけの区間は重ならない」（suite の `findActiveByClaimKey` は離れた区間しか縛っていない）。suite への追加はオーナーの領分で、この PR は suite を変えていない。
  3. **新しい約束を足す形になるもの**: PE8、B16。
  4. **歯が実装の違いをそのまま縛っているもの**: B3（PG が U+FFFD に置換・jsonb は例外、IM は保持）と B4（IM は長い claimKey を投げない）は、TSDoc が「今の振る舞いの記録であり、揃えるかは決めていない」と書く差を、それぞれの実装が書いた通りであることとして縛った。揃えると決まったら、フラグごと書き換える。

- **引き受けた負債**:
  - 「縛られている」の判定は it の名前と一部の本文で、408本すべての本文は読んでいない。第1段の表は作業用で、リポジトリには置かない（件数を焼き込まない。AGENTS.md「数を、道具と生成物に焼き込まない」）。
  - 変異は1約束につき1〜数個で、網羅ではない（A1 の PG は冪等の経路だけの変異を作れなかった。A14 の PG の「赤」は SQL で event を足した変異による）。
  - 歯は `describeRound31Teeth` 1本に集めたので、1本の it が複数の口を縛るもの（A2・A5・A15/A16・A23）がある。変異で「どの口が赤くしたか」は、口ごとに変異して見分けた（上の表の括弧）。
  - Postgres の変異は手元の PostgreSQL 17（`C.UTF-8`、`initdb`、ポート 56257）で撃った。CI の別の脚（`SQL_ASCII`）では撃っていない。

- **これが覆るとしたら**: A20 の PG の多重防御のうち後ろの段が外れたとき（その段の歯は `tenant-boundary-teeth` が持つ）、材料1のずれをどちらかに揃えたとき（A15 の歯を TSDoc どおりの完全一致に強める）、B3/B4 の差を揃えると決めたとき。
