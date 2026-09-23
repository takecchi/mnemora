# ADR 0237: `restoreSuperseded` に下見（`dryRun`）を足す — 方向3「戻す前に何が戻るかを返す」を実装する（Issue #515）

- **状態**: 採用 (2026-09)

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0183 / 0192 / 0228 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`psql`/`git`/`gh` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 🔴 訂正の追記（2026-09-18）—— 「破壊的変更かどうか」節の**結論行が誤っている**。これは **v1.0.0 の破壊的変更として数える**

⛔ **下の本文は1バイトも書き換えていない**（`docs/decisions/README.md` の規約「採用済み ADR の本文は書き換えない。訂正が要るなら、その場に追記する」と、[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定1 の自己適用）。

### 何が誤っているか

**下の「## 破壊的変更かどうか（ADR 0156 / ADR 0178 の要求）」節の、見出し直下の結論行**（逐語）:

> **追加のみで、破壊的変更ではない。**

🔴 **これは誤りである。**

### ⭐ 同じ節の4番目の箇条書きは、元から正しかった

⛔ **矛盾していたのは結論行のほうである。**下の箇条書きは逐語でこう書いており、**訂正の対象ではない**（逐語を引くためにここに再掲するが、**本文側は消さないこと**）:

> `MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy: boolean` は必須フィールドとして足した…**これは `@mnemora/testkit` を使ってこの適合テストを呼び出す側（この repo 内の2箇所のみ、他に利用者は確認していない）に対しては破壊的**

⟹ ⭐ **開示は在った。打ち消していたのは結論行である。**⟹ **節の見出しだけを見て「破壊的変更なし」と読むと、必ず誤る。**

### 🔴 なぜ「数えない」が成り立たないか —— 【実測 2026-09-18、`main` = `242ce7f`】

| 確かめたこと | 結果 |
|---|---|
| `packages/testkit/package.json` の `private` | **未設定（＝非 private）**。version `0.1.1` |
| `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` | **6本。`@mnemora/testkit` はその1つ**（`@mnemora/core` の次） |

⟹ 🔴 **`@mnemora/testkit` は出荷される公開契約である。**⛔ **「repo 内の2箇所のみ」は、repo の外を見ていないという申告であって、外に利用者が居ないことの根拠ではない。**⟹ **publish 済みのパッケージについて、外に利用者が居ないことは確かめられない。**

⟹ ⭐ **必須フィールドの追加は、その型を使う既存の呼び出しをコンパイルエラーにする。**⟹ **v1.0.0 の破壊的変更として数える。**

🔴 ⛔ **ここに「何件目」とは書かない。**総数は`scripts/release-candidates.mjs` で**リリース直前に数え直して初めて決まる**（[ADR 0214](./0214-release-candidates-lists-not-judges.md) が「数字も tag も repo 名も焼き込まない」と決めた形。焼き込めば腐る）。
⟹ ⭐ **代わりに書くのはこれである**: **リリース直前の数え直しで、この commit（`c5d022e`、[PR #524](https://github.com/takecchi/mnemora/pull/524)）を名指しで確認すること。**

⚠ **下の節が挙げた緩和（「adapter 実装者向けの検査道具である」「`docs/architecture.md` の想定利用者もそちら」）は、⭐ 壊れる人が少ないことの根拠であって、壊れないことの根拠ではない。**⟹ **この追記はその緩和を否定しない。数え方だけを直す。**

### ⭕ ⛔ ただし、**必須のままにする**（optional へ変えない）

**下の本文が、必須にした理由を既に書いている**（逐語）:

> `supportsRestoreSupersededBy` 等、既存の同種フラグと同じ判断（**省略可にすると「検査していないのに緑」を許してしまう**）

⭐ **そして既存の同種フラグは全部必須である**【実測 2026-09-18、`packages/testkit/src/memory-store-conformance.ts`】——`supportsSupersedeWithNewMemories` / `supportsPurgeExpiredEvents` / `supportsArchiveDecayed` / `supportsPurgeMemory` / `supportsMarkContestedPair` / `supportsResolveContestedPair` / `supportsRestoreSupersededBy` の**7本とも `: boolean`（`?:` は1つも無い）**。

⟹ ⭐ **黙って通る歯を作るくらいなら、破壊的変更を1つ増やすほうがよい。**⟹ **承知のうえで破壊的変更を選んだ**、と読めるようにここに残す。

### ⚠ この訂正が本当に塞いでいるもの —— **道具ではなく、読む人のほうである**

**[`scripts/release-candidates.mjs`](../../scripts/release-candidates.mjs) は、この変更をちゃんと拾う**【実測 2026-09-18】:

```
c5d022e  feat(core,postgres)  PR=#524  signals=[body-breaking,public-api,src]
```

⛔ **だから道具は直していない。**同じ道具が自分の出力に逐語でこう書いている:

> ・**余計に拾う側（安い）**: `e1c0793` は本文が逐語で「破壊的変更ではない。」と書いているのに body-breaking が立つ——**語を見ているだけで、否定文を読み分けない。**

🔴 ⟹ **危険はここである。**当日この候補を読む人が、**下の節の結論行（「破壊的変更ではない。」）を見て `e1c0793` と同型の偽陽性だと判断すると、棄却してしまう。**⟹ **しかも棄却した人は「ADR を読んで確かめた」と思う。**

⟹ ⭐ **道具を直しても、この経路は消えない。**拾うのは道具、棄却するのは人であり、**棄却の材料が誤っていたからである。**⟹ **だから直したのは結論行のほうである。**

---

## 文脈

[ADR 0230](./0230-restore-superseded-recovery-path.md) 冒頭の訂正（2026-09-17）が、`restoreSuperseded` の対象（`superseded_by_id` が指す群）は「1回の統合操作」と一致しないことがあると訂正した——`resolveContested` の勝者は新規作成された Memory ではなく前から在る Memory であるため、同じ `superseded_by_id` の下に別々の操作の敗者が積み上がりうる（【実測、ADR 0230 に記録済み】インメモリと本物の Postgres の両方で再現している）。

その訂正は実装を変えず、[Issue #515](https://github.com/takecchi/mnemora/issues/515) へ「考えられる方向」を4つ並べて回した。issue のコメント（クローンによる判定、オーナー本人の判定ではないと本文が明示している）が、次のとおり決着させた:

> ✅ 判定: 方向3（戻す前に何が戻るかを返す）を v1.0.0 に入れる。⛔ 方向2・4 は採らない

**本 ADR はその判定に従って実装する。方向を選び直さない。**

---

## 問い

`Runtime.restoreSuperseded` の呼び出し側は、実際に呼ぶ**前**に「この群には何が戻るか」を知る手段を持たない。これをどう埋めるか。

## 決定 — **方向3（下見の口を足す）を実装する**

`RestoreSupersededOptions` に `dryRun?: boolean` を足す。`true` のとき、`Runtime.restoreSuperseded` は一切の書き込み（`memories` の `UPDATE`・`memory_events` への `INSERT`・`reinforce`）を行わず、`MemoryStore.previewRestoreSupersededBy?`（本 ADR が足す新しい任意メソッド）が選んだ候補を `RestoreSupersededOutcome` の新しい `"would_restore"` として返す。

**既定（省略・`false`）は1バイトも変えない**——この PR 以前の `restoreSuperseded` は、今日どおり実際に戻す。

### なぜ「別のメソッド」ではなく「既存メソッドへの `dryRun` オプション」か

issue の判定は「`previewRestoreSuperseded` でも `restoreSuperseded(ctx, { ..., dryRun: true })` でもよい」としていた。本 ADR は後者を選ぶ——この repo に**既にある前例と同じ形にするため**である。`Runtime.purge`（[ADR 0124](./0124-purge-physical-delete.md)）の `PurgeOptions.dryRun` が、`opts.dryRun: true` のとき書き込みを一切せず `"would_purge"` を返す、まったく同じ形をこの repo に既に持ち込んでいる。同じ操作圏（`Runtime` の書き込み系メソッド）に2つの異なる「下見」の呼び方（別メソッド／同メソッドへのオプション）を持ち込むと、利用者が覚える形が増える。⟹ **既存の `purge` の形に揃える。**

ただし **`purge` とは前提が違う一点がある**: `purge` の `dryRun` は対象 id が既知（呼び出し側が `PurgeTarget` で直接 id を渡す）で、書き込み分岐を省くだけでよい。`restoreSuperseded` の対象は「群」であり、`dryRun: true` 自身が**範囲走査**（「どの id が対象か」を決める `SELECT`）を新しく必要とする——これが store 側に新しい任意メソッド `previewRestoreSupersededBy?` を要求する理由である（`restoreSupersededBy?` が `UPDATE ... RETURNING` の中で対象選定と書き込みを1文にまとめているため、書き込みだけを省く分岐が無い。SQL の話は「実装」節）。

### `MemoryStore` 側は独立した2つの任意メソッドにする

`restoreSupersededBy?` と `previewRestoreSupersededBy?` は独立した任意メソッドであり、片方だけを実装する adapter があり得る。これは issue の決めておくこと1「`restoreSuperseded` の既存の振る舞いを変えない。別の口として足す」を、store の契約レベルまで一貫させたものである——**`restoreSupersededBy?` の doc コメント・実装は本 PR で1行も変えていない**（後述「確認したこと」参照）。

`Runtime.restoreSuperseded` の `RestoreSupersededResult.supported` は、`opts.dryRun` の有無でどちらのメソッドを見ているかが変わる。`dryRun: true` かつ `previewRestoreSupersededBy?` 未実装なら、`restoreSupersededBy?` が実装済みでも `supported: false` になる——2つが独立である以上、免除しない。

---

## 決めておくこと2への回答 — 由来（「なぜその群に入っているか」）は**取れる**

issue の判定は「戻る対象の `memoryId` 一覧に加えて、由来が分かるとよい。ただし `memory_events` に鍵が無くて取れないかもしれない。取れないなら『取れない』と書くこと」と留保していた。

**【現物・実測で裏取り】結論: 取れる。** 理由:

1. `memory_events` には既に `idx_memory_events_by_memory (tenant_id, memory_id, at)` という部分索引ではない通常索引が張られている（`packages/postgres/migrations/0001_init.sql`）。`memory_id` を絞る問い合わせは、この索引でそのまま担える——**新しい索引は不要だった**。
2. `Runtime` が `status: 'superseded'` へ遷移させる3つの書き手（`reextract`・`consolidate`・`resolveContested`）は、いずれも `superseded` イベントの `meta.reason` に固定文字列を積んでいる——`reextract` は `"reextract_superseded"`、`consolidate` は `"consolidated"`、`resolveContested` は `"contested_resolved"`（【現物】`packages/core/src/runtime.ts` の `buildSupersedeEventFor`/`buildConsolidateSupersedeEvent`/`buildMeta`。**アトミック経路（`supersedeWithNewMemories?`/`resolveContestedPair?` が在る場合）と非アトミック経路（無い場合）の両方で、同じ `meta.reason` を積む同じ関数を使っている**——adapter によって監査ログの中身が変わらない設計は ADR 0100 の時点で既に決まっていた）。
3. ⟹ `previewRestoreSupersededBy?` は、対象ごとに直近（`at` 最大）の `kind = 'superseded'` イベントの `meta.reason` を `supersededReason` として運べば、上記3種の由来をそのまま読み取れる。

**実装した SQL**（`packages/postgres/src/memory-store.ts`）は、`restoreSupersededBy?` の `target` CTE と1文字も違わない `WHERE`（`tenant_id` + `superseded_by_id` + `status = 'superseded'`）に、`memory_events` を `DISTINCT ON (memory_id) ... ORDER BY memory_id, at DESC` で結合するだけである。**新しい索引を1本も足していない**——`idx_memories_superseded_by` と `idx_memory_events_by_memory` の組み合わせで足りる。

### ⚠ 「取れる」の正確な範囲——過大に読まないこと

- **`supersededReason` は自由文の素通しであり、厳密に型付けした分類ではない。** `meta.reason` はあくまで3つの書き手が自由文として積んだ値であり、`previewRestoreSupersededBy?` はそれを解釈も変換もしない。将来 別の書き手が `reason` を省略したり違う文字列を積んだりしても、この口は壊れない代わりに、その値をそのまま返す。
- **一致する `memory_events` 行が無ければ `null`。** サードパーティの `MemoryStore` 実装や、`updateStatusWithEvent` を直接呼んで `status: 'superseded'` にした手書きの書き込みが `meta.reason` を持たない場合、`supersededReason` は `null` になる——**「取れないことを `null` で正直に返す」**のであって、取れるふりをしない（issue の要求そのもの）。
- **群のサイズ分の `memory_events` 行を読む。** 索引はあるが、対象が数千件規模の群になった場合の実測は無い（下の「確かめていないこと」参照）。

---

## 決めておくこと3への回答 — なぜ方向2ではなく方向3か

issue の判定が並べた根拠4つを、そのまま引く（判定コメント参照、逐語は上の「文脈」に貼らない——同じ本文を2箇所に置くと片方が腐ったときに気づけない、[ADR 0230](./0230-restore-superseded-recovery-path.md) と同じ判断）:

1. **issue 自身が問題の本体を1行で書いている**——「呼び出し側は何が戻るかを事前に知る手段を持たない」。群が広いことそのものより、広いかどうかを呼び手が確かめられないことが危険を作っている。方向3はそこを直接埋める。
2. **契約を狭めないので破壊的変更にならない。** `restoreSuperseded` は既に `main` に在り `v1.0.0` で出る公開 API。方向3は読むだけの口を足すだけであり、既存の呼び出しは1バイトも変わらない。後から方向2を足す道も塞がない。
3. **この repo が同じ日に採った別の設計判断（Issue #369、findCorrectionCandidates、[ADR 0232](./0232-correction-candidates-returned-not-chosen.md)）と同じ形である。** その判定は ADR 0223 決定2 の一般形——「歯（機械検査）の担当は『検出』までである。『確定』と『書き込み』は人に残す。そして機械が判定できなかったときは、従来どおりに倒さず赤／保留で止める」——を根拠にしている。`dryRun` はこの規律を `restoreSuperseded` にも当てたものである——「何が戻るか」を検出して見せ、戻すかどうかは呼び手が決める。
4. **方向4（`resolveContested` 由来だけ別扱いにする）は、ADR 0223 決定8「新しい種類・新しいフィールド・新しい `kind` を足す理由は『違うものだから』ではない。⟹『その区別を受け取った側が、実行時に違う手を打てるか』である。打てないなら足さない」に照らすと採れない。** `dryRun` が在れば、呼び手は「由来」を厳密に知らなくても正しく手を打てる（戻る一覧を見て、意図より広ければ呼ばない）——由来の区別を API の意味（型・分岐）に持ち込む必要が無い。**そして持ち込むと害がある**——3経路の区別が利用者から見える契約に漏れ、経路が増えたときに契約が壊れる。

**方向2（`memory_events` 側にもっと細かい鍵を持たせ、群をもっと細かく絞れるようにする）は、この PR でも採らない。** 理由は費用ではなく、issue の判定が示した理由をそのまま引く——**方向3が入れば、事故は起きる前に止まる**。方向2は「起きた事故を防ぐ」ものではなく「より細かく指せるようにする」改善であり、v1.0.0 の要件ではない。⟹ この判断は `docs/roadmap.md` §5 へ回さない——方向3は契約を変えないため、オーナー判断が要る「利用者から見える契約が変わる選択」には当たらない（issue 自身の警戒に対する回答）。**将来 方向2 を採るときは §5 級として扱う**（issue の判定を引き継ぐ）。

---

## 決めておくこと4 —— 実装費用の実測（「読むだけなので安いはず」という見立てへの検算）

issue の判定は「dryRun の実装費用を測っていない……読むだけの口なので安いはずだが、これは見立てであって実測ではない。実装する担い手が現物で確かめて、大きければ報告すること」としていた。

**【実測】見立てはおおむね正しかった。** 実装そのもの（`MemoryStore` に新しい任意メソッド1つ・`Runtime` に分岐1つ・store 2実装への実装）にかかった作業は、既存の `restoreSupersededBy?` の実装（対象選定 SQL）をほぼそのまま複製し、`UPDATE`/`INSERT` を外して `memory_events` との `LEFT JOIN` を足すだけで完結した——**新しい索引・新しいマイグレーション・新しい `MemoryEventKind` のどれも不要**（下見は書き込まないため、監査ログの新種別が要らない）。

**見立てと違った点が1つある**: 「由来が取れるかどうか」の確認自体は、issue が「取れないかもしれない」と留保していた分だけ、当初の想定より掘り下げが必要だった——`memory_events` の索引構成（`idx_memory_events_by_memory`）と、3つの書き手が実際に積む `meta.reason` の値（`reextract_superseded`/`consolidated`/`contested_resolved`）を1つずつ現物で確認する調査が、実装そのものより時間を要した。**ただしこれは「費用が見立てより大きかった」という報告には当たらない**——issue が求めていたのは「取れるか取れないかを自分で判断すること」であり、その判断自体に掘り下げが要ることは、issue の留保の文言（「これは自分で判断してください」）から織り込み済みである。

---

## 決めておくこと1への確認 —— `restoreSupersededBy?` の既存の振る舞いは変えていない

【実測】本 PR の diff で `packages/postgres/src/memory-store.ts` の `restoreSupersededBy` メソッド本体・`packages/testkit` の `InMemoryMemoryStore.restoreSupersededBy`・`packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore.restoreSupersededBy` は1行も変更していない（`git diff` で確認——3ファイルとも新しいメソッドの追加のみで、既存メソッドの中身は無変更）。

既存のテスト（`packages/core/src/__tests__/restore-superseded.test.ts` の「往復」テスト・`supported: false`・「対象0件」・「reason/actor」・「reinforce 失敗」の5系統、`packages/testkit/src/memory-store-conformance.ts` の `restoreSupersededBy` 系統6本）は本 PR 前後で1つも変更しておらず、全て緑のままである（下の「測ったこと」参照）。

`opts.dryRun` を省略・`false` で明示した場合の既定動作が変わっていないことも、新規テスト「opts.dryRun を省略・false にすると、この PR 以前と同じ『実際に戻す』既定のまま」で確認した。

---

## 破壊的変更かどうか（ADR 0156 / ADR 0178 の要求）

**追加のみで、破壊的変更ではない。**

- `RestoreSupersededOptions.dryRun?` は新しい任意フィールド。
- `RestoreSupersededOutcome` に新しい union メンバー `"would_restore"` を足した。**この union を分岐する網羅的 `switch` は、出荷対象パッケージ（`packages/core`・`packages/postgres`・`packages/openai`・`packages/local-embedding`・`packages/anthropic`）のどこにも無い**（【実測】`rg -n "switch" packages/*/src` で確認。`MemoryEventKind`/`RestoreSupersededOutcome` を分岐する網羅的 switch は0件——ADR 0117/`packages/core/src/event.ts` の doc コメントが同じ確認を `"restored"`/`"unsuperseded"` の追加時に行ったのと同じ手順）。⟹ union へメンバーを足すことがコンパイルエラーを生む経路が無い。
- `MemoryStore.previewRestoreSupersededBy?` は新しい任意メソッド。既存の `MemoryStore` 実装（サードパーティ含む）はこのメソッドを持たなくても型として成立する。
- `MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy: boolean` は必須フィールドとして足した——`supportsRestoreSupersededBy` 等、既存の同種フラグと同じ判断（省略可にすると「検査していないのに緑」を許してしまう）。**これは `@mnemora/testkit` を使ってこの適合テストを呼び出す側（この repo 内の2箇所のみ、他に利用者は確認していない）に対しては破壊的**——ただし `@mnemora/testkit` は「adapter 実装者向けの検査道具」であり、`docs/architecture.md` の想定利用者もそちらである。

`node scripts/check-public-api-surface.mjs`（ADR 0178）の diff は上記の追加のみで、`@mnemora/core`・`@mnemora/testkit`・`@mnemora/postgres` の3パッケージに閉じている（`@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding` は差分なし）。

---

## 実装

- `packages/core/src/interfaces/memory-store.ts`: `MemoryStore.previewRestoreSupersededBy?(ctx, supersededById): Promise<{ candidates: Array<{ memoryId, supersededReason: string | null }> }>` を追加。
- `packages/core/src/runtime.ts`: `RestoreSupersededOptions.dryRun?: boolean`、`RestoreSupersededOutcome` に `"would_restore"` を追加。`restoreSuperseded` の実装冒頭で `opts?.dryRun === true` を分岐し、`previewRestoreSupersededBy?` へ委譲する（既存の「実際に戻す」経路には触れない）。
- `packages/postgres/src/memory-store.ts`: `previewRestoreSupersededBy` を実装。`restoreSupersededBy` の `target` CTE と同じ `WHERE` の `SELECT` のみの文（`UPDATE`/`INSERT` を持たない）に、`memory_events` を `DISTINCT ON` で結合して `supersededReason` を運ぶ。新しい索引は追加していない。
- `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`・`packages/core/src/__tests__/runtime-fakes.ts`: 同じ契約のインメモリ実装（`this.events`/`this.backing.events` から対象ごとに直近の `kind: 'superseded'` イベントを探す）。
- `packages/testkit/src/memory-store-conformance.ts`: `supportsPreviewRestoreSupersededBy` フラグと、対応する適合テスト（対象選定が `restoreSupersededBy` と一致する、書き込まない、`supersededReason` を運ぶ・無ければ `null`、`status` ガード、テナント分離、対象0件）を追加。
- `packages/core/src/__tests__/restore-superseded.test.ts`: `Runtime` レベルの `dryRun` テスト7本（書き込みなし・由来の取得・由来が無いケース・複数 `superseded` イベントのうち直近を選ぶ・`previewRestoreSupersededBy?` 単独欠如・既定不変の2本）。

---

## 測ったこと

すべて `origin/main` を取り込んだこのブランチの HEAD で、この作業者自身が実行した。

- `pnpm --filter @mnemora/core exec vitest run src/__tests__/restore-superseded.test.ts` — **16件成功**（既存9件 + 新規7件）。
- `pnpm --filter @mnemora/core exec vitest run`（core 全体）— **897件成功**（61ファイル）。
- `pnpm --filter @mnemora/testkit exec vitest run`（testkit 全体、インメモリ適合テスト含む）— **338件成功・1件skip**（既存のskipで本PRとは無関係）。
- **本物の Postgres 17 + pgvector**（`initdb` で自分専用インスタンスを作成、ポートは既定の5432を使わず専用ポートを割り当て、`AGENTS.md`「手元で Postgres を立てる」手順どおり）に対して:
  - `pnpm --filter @mnemora/postgres run migrate` — 18本のマイグレーションが適用済み（`0018_memory_events_kind_unsuperseded.sql` まで）。
  - `pnpm --filter @mnemora/postgres run test:db`（フルセット）— **589件成功**（55ファイル、約150秒）。
- `pnpm run typecheck` / `pnpm run lint` / `pnpm run format:check` / `pnpm run pack:check` — いずれも成功。
- `node scripts/check-public-api-surface.mjs`（`pnpm run build` を先に実行してから）— 差分は上記の追加のみであることを確認し、`--write` で snapshot を更新した。

### 変異試験（`docs/autonomy.md` §2、`cp` で退避・復元）

1. **Postgres**: `previewRestoreSupersededBy` の SQL から `AND status = 'superseded'` を削除 → `previewRestoreSupersededBy は status='superseded' でない行を巻き込まない` が**赤**（`archived` の行が誤って候補に混ざった）。`cp` で復元 → 同じテストが**緑**に戻ることを確認。
2. **Runtime**: `restoreSuperseded` の `if (opts?.dryRun === true)` を `if (opts?.dryRun === true && false)` に変異（下見の分岐を無効化）→ `dryRun` 系テスト7本中5本が**赤**（`dryRun: true` を指定したのに実際に書き込みが起き、`kind: "restored"` が返った）。`cp` で復元 → 同じ7本が**緑**に戻ることを確認。

---

## 確かめていないこと

- **大きな群（数千件規模）での `previewRestoreSupersededBy` の性能。** `idx_memories_superseded_by`/`idx_memory_events_by_memory` の組み合わせが小〜中規模の群で機能することは確認したが、群のサイズに対する `memory_events` 側の走査コストの実測は無い。
- **`reextract` が絡む混在ケース。** [ADR 0230](./0230-restore-superseded-recovery-path.md) が引き継いだ「確かめていないこと」——`dryRun` はこれが同型でもそうでなくても、対象選定の `WHERE` を素通しするだけなので効くはずだが、実測はしていない。
- **本番トラフィックでの利用実績。** `restoreSuperseded`/`previewRestoreSupersededBy` を呼ぶ本番コードは `packages/` に0件のまま（ADR 0230 と同じ状況）——出荷される既定では踏まれない。
- **`supersededReason` を実際の運用でどう使うか（UI・アラート等）。** この PR は API を足すところまでで、利用側の設計は範囲外。
