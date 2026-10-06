# ADR 0645: 09/29 にマージされた #1380・#1393・#1394・#1395・#1396・#1405・#1406・#1408・#1410・#1421・#1427・#1437・#1442・#1444・#1455 の確かめ直しで見つかった穴に歯を足す（保守操作の activityCounting の配線・注入した時計の失敗側・pool の警告の形・縮退の幅・テナントの柵・purge の派生物・Fake の deleteAcrossSpaces・scopeAggregate の skip の目次帯・eraseTenant の束ね方ほか）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

クローンのマネージャー（mgr-fc93a777・mgr-5d638824・mgr-0495eb46）の依頼で担い手が書いた。歯を書くと決めたのも、範囲を決めたのも、#1435・#1437・#1442・#1444 を先の確かめ直し（ADR 0600・0602・0603・0604）と重ならない約束に限って当てると決めたのもクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（ADR 0608・ADR 0613 と同じ）。
この PR は「PR A」で、PR B は ADR 0646（PR #1748）である。

## 経緯

2026-09-29（UTC）にマージされた PR のうち、`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit` に当たる15本を、約束ごとに足りない側とやりすぎ側の変異を入れて確かめ直し、どの歯にも捕まらない変異を拾った【実測】。結果は Issue #1733 に PR ごとにコメントとして残してある。

- #1380 の歯は、前の担当（mgr-fc93a777）のものが push されていなかったので、書き直して実測し直した（前任のすり抜け5つを、いまの枝で当て直した）。
- #1444・#1455 は、mgr-0495eb46 の担当が確かめ直した。#1455 を確かめ直した ADR は無かった。#1444 は ADR 0600・0604 が先に当てた約束には当てていない。
- #1437・#1442 は、別の担当が先に確かめ直した ADR 0603・ADR 0602 を前提にして当てた。
- 同じ枝の先頭の版で `pnpm run typecheck`（`packages/core`）が `fake-vector-store-delete-across-spaces.test.ts` の import（`EmbeddingSpaceId`・`MemoryId`）で落ちていたので、その試験ファイルの import 元だけを直した（別コミット）。

約束の出所は、各 PR 本文（`gh pr view`）・実装の TSDoc とコメント・その PR の ADR である【現物】。後の ADR で約束が変わっていないかは、各 PR の ADR 番号と関数名を `docs/decisions` から `grep` して、参照している後続の ADR の該当箇所を読んだ。すべての後続 ADR を通読したわけではない【判断】。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。歯は `__tests__` に置く。
2. 歯を足す（試験だけ）。出所と置き場は次のとおり。実測では、穴の変異で赤になり、戻して緑に戻ることまで見た。

### #1380（保守操作の内部 recall への `activityCounting`）

出所: PR 本文「設計の要点」と進捗「保守操作への配線」（`findCorrectionCandidates` の `activityCounting`、`consolidate`・`reflect` の `{ seedMemoryId, activityCounting }`）、migration 0024（`tenant_subject_activity`）。前任のすり抜け5つを、いまの枝で当て直した。

- `packages/core/src/__tests__/activity-counting-maintenance-wiring.test.ts`（新規）: `findCorrectionCandidates`・`consolidate`・`reflect`（`{ seedMemoryId }` 形と `{ query }` 形）で、`activityCounting: 'subject'` なら subject のカウンタだけが +1 で tenant は 0、省略なら tenant だけが +1 で subject は 0。知らない値を渡すと `recall()` が `ZodError` で断り、どのカウンタも進まない。`{ query }` 形は対照。
- `packages/postgres/src/__tests__/tenant-subject-activity-table-constraints.postgres.test.ts`（新規）: `activity_seq` が負の INSERT・UPDATE は 23514 で断り、0 は通り、UPDATE が断られても行は元の値のまま。

### #1393（保持期間の掃除の InMemory）

出所: 設計（`purgeExpiredEventsByRetention?` は保持期間の読みと削除を1つの原子的な操作にする。InMemory は `await` を挟まない同期区間）。置き場: `packages/testkit/src/__tests__/in-memory-retention-purge-sync-section.test.ts`。呼び出しを await する前に、削除と `events_purged` の追記まで終わっている。

### #1394（注入した時計の失敗側・積み直し側）

出所: 「何を変えたか」（`RuntimeDeps.clock` を outbox の `availableAt`・`createdAt`・`completedAt`・`failedAt` まで届かせる）。置き場: `packages/core/src/__tests__/tick-terminal-uses-injected-clock.test.ts`（新規、4件）。壁時計と違う 2041 年の時計を注入し、core の Fake の outbox で、handler が成功したジョブの `completedAt`・投げて失敗したジョブの `failedAt`・対応していない kind のジョブの `failedAt`・`reembed` が積み直した embed ジョブの `availableAt`/`createdAt` を見る。

### #1395（pool の error の既定の警告）

出所: 設計3・4（`onPoolError` を渡したらそれだけを呼ぶ。既定は `console.warn` で、固定の接頭辞と `error.message` を名乗り、`error` そのもの（`code` を含む）を第2引数で渡す）。置き場: `packages/postgres/src/__tests__/pool-error-default-warning-shape.test.ts`（新規、2件。DB には繋がず `pool.emit("error")` で起こす）。

### #1396（InMemory の取り直しの `availableAt`）

出所: 「何を直したか」（取り直しだけ `available_at` を `opts.now` へ書き直す。両実装）。置き場: `packages/testkit/src/__tests__/in-memory-claim-batch-reclaim-available-at-copy.test.ts`。claim したあとで呼び手が自分の `now` を書き換えても、保存した `availableAt` は動かない（Postgres は値を列へ書くので動かない）。

### #1406（lexical tsvector の縮退の幅）

出所: 概要と「実測: N=150,000 の根拠」（1MB を超える本文だけ、本文の先頭150,000文字で作り直す）。置き場: `packages/postgres/src/__tests__/lexical-tsvector-fallback-cutoff.postgres.test.ts`（新規、1件）。旧式は `too long for tsvector` で落ちる本文で、先頭150,000文字の内側の語は引け、外側の語は引けない。

### #1410（統計が無いときの主キー引きのテナントの柵）

出所: 「何を直すか」（統計が無ければ `memories` を主キーで引く。統計があれば素の `JOIN`。テナント境界 `m.tenant_id = e.tenant_id` は残す）。置き場: `packages/postgres/src/__tests__/search-stats-missing-tenant-fence.postgres.test.ts`（新規、4件）。`tenant_id = A` で `memory_id` が B の記憶を指す行を表へ直接書き、`searchMany`・`search` がテナント A で引いても B の記憶を返さないことを、統計が無い・ある両方で見る。

### #1427（purge が触れる派生物の範囲）

出所: 「変更の要約」（`tags`・`attributes`・claim key の消去、`memory_labels` の削除と `proposed` の `proposed_count` の減算、`recalls.index_band.digestBand` のトゥームストーン化）。3実装に同じ約束。置き場:

- `packages/postgres/src/__tests__/purge-memory-derived-scope.postgres.test.ts`（新規、3件）: 目次帯のエントリが `truncated: true` でも形は `{ memoryId, digest }` だけ。`registered` の label は紐付けだけが外れ `proposedCount`・`status` は動かない。`proposed` の `proposedCount` は 0 を下回らない。
- `packages/testkit/src/__tests__/in-memory-purge-memory-derived-scope.test.ts`（新規、2件）と `packages/core/src/__tests__/fake-purge-memory-derived-scope.test.ts`（新規、2件）: `registered` の label を減らさないことと、目次帯のエントリの `truncated` を残さないこと。

### #1437（`deleteAcrossSpaces` の綴りと Fake）

出所: 「何を変えた」（`deleteAcrossSpaces(ctx, memoryIds)` は `ctx.tenantId` の行を全 space から消す。3実装）。ADR 0521（id の綴りの大文字小文字を区別しない）は広がっただけ。置き場:

- `packages/testkit/src/__tests__/in-memory-vector-store-delete-across-spaces-spelling.test.ts`: 大文字の memoryId でも、全 space の同じ行が消え、渡していない記憶の行は残る。
- `packages/core/src/__tests__/fake-vector-store-delete-across-spaces.test.ts`（新規、2件）: 渡した id の行だけを全 space から消し、渡していない id の行・別テナントの行は残す。大文字で綴った id でも同じ行が消える。

### #1455（`scopeAggregate: "skip"`）

出所: 案A（SQL 文・返り値は変えない。部分索引 `idx_memories_digest_band`、migration 0028）と案C（`scopeAggregate` は `"exact" | "skip"` だけ、省略は `"exact"`、`"skip"` は件数集計を実際に止め、`taxonomyGroupCandidates` が同時でも taxonomy 群を数えず、`digestBand` は集計と別の経路で今日どおり出る）。置き場:

- `packages/postgres/src/__tests__/aggregate-scope-skip-digest-band.postgres.test.ts`（新規）: skip の目次帯が、同じ入力の `"exact"` の帯と一致することを、同点・上限が同点の塊の途中を通る・除外 id・subject・attributes・labels・期間・有効期間・contested・上限0で縛る。期待は JS で独立に組む。索引を使えない接続でも同じことを見る。skip + digestBand・skip + taxonomyGroupCandidates で `GROUP BY`・`count(` を含む SQL が0本、memories への問い合わせが1本であることも見る。
- `packages/postgres/src/__tests__/digest-band-index.postgres.test.ts`: `pg_get_indexdef` の3キーの並びを丸ごと見る歯を1本足した。
- `packages/core/src/__tests__/recall-scope-aggregate-values.test.ts`（新規）: 知らない文字列・文字列でない値は `ZodError` で `aggregateScope` まで届かず、`exact`・`skip` は通って渡り、省略は `exact` が渡る。
- `packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-skip-taxonomy.test.ts`（新規）: InMemory で skip + `taxonomyGroupCandidates` は `groups` 空・`totalInScope` 0・`unknown`。対照に exact の群。

### #1444（`eraseTenant`）

出所: core の `eraseTenant`（PR 本文と `erase-tenant.ts` の TSDoc）、`dryRun` は件数だけを返すこと、他テナントからの参照は外部キーの全経路を数え検査と削除の間の競合は数え直すこと（ADR 0383 決定8）、同じテナントの同時呼び出しは直列（ADR 0430 決定2。ADR 0383 の追記）、outbox は状態を問わず消すこと、埋め込み空間の表の列挙と `(memory_id)` 索引（ADR 0383 決定11・12）。後の ADR（0400・0426・0430・0436・0439・0575 ほか）は広げただけで、撤回・狭めはない。置き場:

- `packages/core/src/__tests__/erase-tenant-orchestration.test.ts`: 欠ける port を1つずつ名指しし、どの port にも触れない。最後の port の `reachedLimit`・`deleted` の写し。4 port それぞれの例外の素通し。ctx・limit・dryRun が4 port に届く。
- `packages/postgres/src/__tests__/erase-tenant-foreign-reference-paths.postgres.test.ts`（新規）: 外部キーの11経路を1本ずつ、経路の集合も別の問い合わせで数えて突き合わせる。
- `erase-tenant-fk-violation-recount.postgres.test.ts`（新規）: `BEFORE DELETE` トリガで止めて別接続で参照を足し、数え直して blocked になる。他テナント由来でない 23503 は元の例外。
- `erase-tenant-dry-run-matches-real.postgres.test.ts`（新規）: 4 port とも dryRun と本番の `{deleted, reachedLimit}` が一致する。
- `erase-tenant-outbox-all-states.postgres.test.ts`（新規）: 未処理・claim 中・完了・失敗のすべてを消す。
- `erase-tenant-same-tenant-lock.postgres.test.ts`（新規）: 先に lock を握り、port が終わらないこと・別テナントは待たないこと。
- `embedding-space-enumeration-decoys.postgres.test.ts`（新規）: 列挙の6条件を1つずつ満たさない decoy を除く。migration 0027 の索引が `memory_id` の単一列であること。

### 歯を足さなかった PR

#1405・#1408・#1421・#1442 は、すり抜けが無かった（#1421 の変異5は共有そのものを直接見る歯が無く、偶然噛んだ形だった。試しに書いて赤・緑は確かめたが、既に噛んでいるので足していない。足すかどうかはマネージャーの判断に任せた）。

3. ほかの ADR には追記しない。

## 実測【実測】

PostgreSQL 上で、対象ファイルを退避し、変異を1つずつ入れ、名指しのファイルを走らせ、戻して緑に戻ることまで見た。migration を書き換える変異は、変異ごとに新しい DB を作り直して migrate し直した（既存の DB は適用済みの台帳で見るため）。数は各コメントの見出しのとおり（等価を含む）。

| PR    | 走らせた変異 | すり抜けた       | 足した歯                                                             |
| ----- | ------------ | ---------------- | -------------------------------------------------------------------- |
| #1380 | 15           | 5                | 2ファイル（core 新規・postgres 新規）                                |
| #1393 | 6            | 1                | 1件                                                                  |
| #1394 | 14           | 4                | 4件                                                                  |
| #1395 | 4            | 2                | 2件                                                                  |
| #1396 | 6            | 1                | 1件                                                                  |
| #1405 | 3            | 0                | なし                                                                 |
| #1406 | 7            | 2                | 1件                                                                  |
| #1408 | 8            | 0                | なし                                                                 |
| #1410 | 3            | 2                | 4件                                                                  |
| #1421 | 5            | 0                | なし                                                                 |
| #1427 | 10           | 7                | 3ファイル（postgres 3件・testkit 2件・core の Fake 2件）             |
| #1437 | 11           | 4（うち1は等価） | 2ファイル（testkit 1件・core の Fake 2件）                           |
| #1442 | 7            | 0                | なし                                                                 |
| #1444 | 39           | 26               | 7ファイル（core 1・postgres 6）                                      |
| #1455 | 25           | 15               | 4か所（postgres 新規・既存の索引の歯に1本・core 新規・testkit 新規） |

#1380 の「噛んだ10個」は再走していない（前任の結果のまま）。#1394 の変異のうち 12・14 は postgres を走らせていない。#1455 の等価で除いたものは `filtered*` の各カウンタに付いた `!skipCounting` の外し（表の数には含めていない）。

## 外したもの【判断】

等価で歯にしなかったもの:

- #1437: core の Fake の `tenantId` の照合を外す。Fake の memoryId は全テナントで一意なので、同じ id で別テナントの行を作れない。
- #1444: `reachedLimit` の `remaining <= 0` 分岐（vector の同分岐も）。手前の段が使い切ったときに必ず true になるので、外しても結果が変わらない。
- #1427: InMemory・Fake の `proposed_count` の床。紐付けの数と `proposedCount` が食い違う状態を API からは作れない。
- #1405: `vector` が見つからないときに素の `CREATE EXTENSION` に倒す分岐。到達させる構成が作れない。
- #1406: `SQLERRM NOT LIKE '%too long for tsvector%'` の判定を外す変異。1MB 超以外の `54000` を起こす入力が作れない。
- #1395: `onPoolError` を `Pool` へ渡さないための分割代入。`pg` は未知の欄を黙って無視するので観測できない。

約束が撤回・広がったので当てなかったもの、約束でないので歯にしなかったもの:

- #1455 の InMemory が skip でも `excludedProvenanceIndexedCount: 0` を返す変異はすり抜けたが、ADR 0390 の約束（skip は欄を足さない）で #1455 の約束ではないので歯にしていない。#1390 側の担当が確かめ直すなら、そちらへ。
- #1380 の「決めたこと7」（作成・強化の起点を `ctx.subjectId` 基準で計算する）は ADR 0394 が記憶自身の subject 基準に変えたので当てていない。tick の自動 consolidate・reflect ジョブが `activityCounting` を渡さないことは PR 本文が範囲外としたので歯にしていない。主キーの列順は性能の記述で、振る舞いの歯にならない。
- #1455 の ADR 0384 決定2「実装しない adapter は `'exact'` を返し続ける」は、ADR 0384 自身の 2026-09-30 の追記が誤りとした。そちらには当てていない。
- #1410 の One-Time Filter で切り替えること・「往復は増えない」・`search()` を変えないことは、ADR 0374 が置き換えたので当てていない。速さの実測表は環境依存で歯にしない。
- #1421 の「統計が後で消えても確認し直さない」（引き受けた負債）・「テナントごとに持たない」は、当てていない。
- #1427 の `recalls.query` を書き換えないことは、「触らない」側の約束で、足す変異は PR の設計と逆向きの変更になるので当てていない。
- #1394 の `clock.ts` の TSDoc と `examples/chat` の `time-weighting-seed-drain-race` は当てていない。

## 約束の変わり方【判断】

どの約束がどの ADR でどう変わったか（1件1行）。

- #1410: ADR 0374 が One-Time Filter で切り替えること・「往復は増えない」を `StatsPresenceGate` に置き換えた（撤回。当てていない）。統計の有無で引き方を変えることとテナント境界は残っていて、当てた。
- #1380: 「決めたこと7」は ADR 0394 が記憶自身の subject 基準に変えた（当てていない）。
- #1455: ADR 0384 決定2「実装しない adapter は 'exact' を返し続ける」は ADR 0384 自身の 2026-09-30 の追記が誤りとした（当てていない）。
- #1455: PR 本文の「skip では ann_unreached が判定されない」は ADR 0390 が `annReachability: "unknown"` を足しただけで広がった。ADR 0415（consolidate・reflect の内部 recall の既定を `"skip"` にした）も広がっただけ。
- #1444: ADR 0383 の追記・0430 などで広がっただけ（約束は変わっていない）。

## 先の確かめ直しと重ならないように選んだもの【判断】

別の担当が先に確かめ直した ADR のどの約束と重ならないように選んだか（1件1行）。

- #1437: ADR 0603 は `deleteAcrossSpaces` が渡していない記憶の行を残すことを testkit の適合テストへ足した。ここでは InMemory の id の綴り（大文字）と、適合テストを通らない core の Fake の歯に当てた。
- #1442: ADR 0602 は解消での関係の削除範囲・段3が抜けたメンバーを越えない・`attributes` の絞り・合併と人数の境界・対の片割れを縛った。それとは重ならない約束（安全弁・`countKind`・切る順・`companionOf`・重なり判定・部分解消の検査）に7つの変異を当て、すり抜けは無かった。歯は足していない。
- #1444 と ADR 0600: core の port の束ね方（欠ける port・引数の写し・戻り値の写し・例外）は、0600 が `confirmTenantId` の完全一致と Fake の他テナントだけだったので重ならない。dryRun の件数の写しは、0600 が dryRun が自己参照を書き換えないことだけだったので重ならない。外部キー経路ごとの blocked・dryRun の blocked・数え直しは、0600 が `mine.tenant_id` の条件だけだったので重ならない。outbox の状態・lock・空間の列挙の decoy・DO ブロックの列は、0600 が「縛っていないもの」に lock を挙げ、他は触れていないので重ならない。
- #1444 と ADR 0604: 0604 は recall_usages の完全一致と Fake の `tenant_subject_activity` だけを縛った。ここの outbox の状態・lock・空間の列挙の decoy・DO ブロックの列とは重ならない。

## 直しが要りそうなもの（実装は変えていない）【判断】

- #1380: migration 0024 の冒頭コメントと一部の記述が「ADR 0352」と書いている（実際は 0353。PR 本文が改番したと書いている）。コメントだけの食い違いで、migration は適用済みの台帳で見るため書き換えていない。
- #1455: conformance の「skip は集計を発行しない」の歯（`countScopeAggregateQueries`）が digestBand なしでしか呼ばれない。適合テスト側の穴でもあるが、適合テストへの追加は求められていないので、Postgres 側の歯で埋めた。

## 縛っていないもの

- #1444 の migration 0027 の索引を部分索引に変える変異は当てていない。0027 のコメントは部分索引にしないと書くが、ADR 0400 の一般の歯は部分索引も「在る」と扱う。索引の形は振る舞いの約束ではないと判断した。
- #1444 の同じテナントの lock の歯は、競合を起こさず先に lock を握って待たせる形である。ADR 0460 の陽性対照が無い点は残る。
- #1394: core の `tick`・`reembed` の変異のうち、postgres 側を走らせていないものがある。
- #1408: 0.7 系以下の実物の pgvector は手元に無く、歯は `pg_settings` の行を模した入力で見ている。
- #1421 の変異5は、共有そのものを直接見る歯が無い（偶然噛んだ形）。
- 全テストは走らせていない。名指しのファイルだけである。DB の要る試験は、この仕上げの段では走らせていない。

試験名・コメントに「ADR X 決定N」と書かない決まりは試験の話で、この ADR 本文では ADR を参照してよい。

## これが覆るとしたら

`activityCounting` が保守操作の内部 recall へ届くこと、`clock` を失敗側・積み直し側まで届かせること、`scopeAggregate: "skip"` の目次帯が `"exact"` の帯と一致すること、`eraseTenant` の port の束ね方と外部キーの全経路の数え直し（ADR 0383）、同じテナントの直列化（ADR 0430）、`deleteAcrossSpaces` の綴りの扱い（ADR 0521）が変わるとき。
