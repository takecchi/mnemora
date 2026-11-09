# ADR 0702: `memory_events` に記録した順の番号 `seq` を足す——時計のずれたワーカーが混ざっても、同じ記憶の履歴を遷移の順に読めるようにする

- **状態**: 採用 (2026-11)
- **日付**: 2026-11-10

**これは担い手（Claude Code のセッション）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所は、対話セッションの利用者の依頼「v2.0.0 で入れたい: 記憶の信頼性・整合性の改善」の課題C（Memory Event の整合性）。Issue [#2110](https://github.com/takecchi/mnemora/issues/2110)。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（docker の `pgvector/pgvector:pg17`）、【判断】は担い手の判断。

**⚠ この ADR の番号は仮である。** マージの直前に `node scripts/adr-renumber.mjs` が確定する（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）。

## 文脈

### 調べたこと【現物・実測】

状態を変える経路を、1本ずつ調べた。forget・restoreArchived・sweepArchive・purge・contested の印と解決・supersede・restoreSuperseded・抽出の作成・イベントの保持期間の掃除・eraseTenant が対象である。

| 観点 | 結果 |
|---|---|
| 状態の更新とイベントの追記の原子性 | `@mnemora/postgres` では、どれも同じトランザクションだった（`updateStatusWithEvent` などの口）。testkit の fixture も、検査を済ませてから書く「全部か無しか」である。 |
| 更新が CAS で弾かれたとき | イベントは積まれない（実測）。 |
| イベントの INSERT が失敗したとき | status も戻る（実測。別テナントの memoryId・kind の CHECK 違反）。 |
| 再試行 | forget を2回呼ぶと、2回目は `already_forgotten` で、イベントは1件だけ（実測）。 |
| 同時実行 | 同じ archived 行に forget と restoreArchived を同時に投げると、勝つのは片方だけで、イベントも勝った側の1件だけ（実測）。 |
| **イベントの並び順** | **問題あり（下）。** |

### 確かめた問題【実測】

**`at` は呼び出し側（runtime）の時計の値で、`EventStore.list` は `ORDER BY at` だけで並べる。** 連番の列は無かった。

- 再現の手順: 1つの DB に、時計が10秒進んだワーカーと1秒進んだワーカーを立てた。前者が `sweepArchive` で archive し、その後で後者が `restoreArchived` した。
- 結果: 最終状態は `active` なのに、`list()` の順は `restored@…01Z, archived@…10Z` だった。最後のイベントから最終状態を読むと `archived` と誤る。
- 複数プロセスで運用すれば、実際に起こりうる。`docs/memory-model.md` と ADR では、この問題への言及は見当たらなかった。ADR 0460・0531 の時計のずれは、outbox のリースの話である。

あわせて、同じミリ秒の中の遷移は `at` が同値になる。こちらは ADR 0422 と `EventStore.list` の doc が「順を規定しない」と既に書いていた。

## 何を決めたか【判断】

1. **`memory_events` に `seq bigint GENERATED ALWAYS AS IDENTITY` を足す**（migration `0035`。列を足すだけ）。
   - 同じ記憶のイベントでは、`seq` の昇順が遷移の順と一致する。
   - 理由: 状態を変える経路は、どれも同じトランザクションの中で対象の `memories` の行をロックしてからイベントを INSERT する。行ロックはコミットまで保持されるので、同じ記憶への次の遷移は前のコミットを待ってから採番される。
   - 違う記憶どうしの `seq` の大小は意味を持たない。連番の保証も無い。
2. **`MemoryEvent` に任意の欄 `seq?: number` を足す。**`@mnemora/postgres` と testkit の fixture は番号を振る。振らない adapter も適合する。`NewMemoryEvent` からは外した（store が振るため）。
3. **`EventStore.list` の並びは `at` の昇順のまま**とし、同じ `at` だけを `seq` で並べる。履歴を組み立てるときは返った配列を `seq` で並べ直す、と契約（TSDoc・`docs/memory-model.md`）に書いた。
4. **`forgotten` のイベントの meta に `previousStatus`（直前の status）を足す。**`forgotten` は active・archived・contested・superseded のどこからでも来るので、`kind` だけでは遷移元が読めなかった。core だけの変更である。
5. **適合テストに `supportsSeq?: boolean`（既定 `false`）を足す。**`true` を宣言した adapter には、次の2本の歯を当てる。`false` なら `it.skip` で名前だけ残す。
   - 同じ記憶へ append した順に `seq` が増える（`at` が逆行していても）。
   - 同じ `at` のイベントは `list` で `seq` 順に並ぶ。

## 守ったこと

- **保持期間と削除の方針は変えない。**`purgeExpiredEvents` は今までどおり `at` で選ぶ。無期限の監査や、新しいインフラは足していない。
- **`at` の意味は変えない**（呼び出し側が時刻を渡す。ADR 0037）。

## 互換性

- 型の上では非破壊である。足したのは任意の欄と、適合テストの任意のフラグだけ。
- **DB マイグレーション `0035` が要る。**列の追加だけで、既存の行も書き込みも拒まない。
- 既存の行には適用時に番号が振られる。その順は物理的な並びで、遷移の順とは限らない。
- `list` の、同じ `at` の行の並びが決まるようになった（以前は規定していなかった）。
- `forgotten` の `meta` に `previousStatus` が増えた。`meta` を `{}` や `{ reason }` と完全一致で比べていた呼び出し側だけが影響を受ける（🟡）。

## 採らなかった案

- **`at` を DB の `clock_timestamp()` にする。** 呼び出し側が時刻を渡す決まり（ADR 0037）と、時計を注入するテストを壊す。それに、DB の時刻はトランザクションの開始時刻やサーバの時計にも依る。
- **`list` の並びを `seq` だけにする。**`since`・`until`・`limit` が `at` の範囲で切る契約と、並びが食い違う。必要な呼び出し側だけが並べ直せばよい。
- **`seq` を必須の欄にする。** 第三者の `EventStore` がすべて壊れる。

## 引き受けた負債

- **`created` イベントの別コミット**（任意の口 `createMemoriesWithOutboxAndEvents?`・`supersedeWithNewMemories?` を持たない adapter）は、ADR 0416 の「直さない負債」のまま。Postgres と testkit の fixture は両方の口を実装しているので起きない。
- **抽出がコミットされた後で claim key の衝突検出が落ちると、再送では検出が走らない**（遷移の取りこぼし）。再現はしておらず、今回は扱わない。

## 確かめたこと【実測】

- Postgres: `memory-event-seq-clock-skew.postgres.test.ts`（2件）。
  - 時計のずれたワーカーの archive → restore で、`at` の順は逆になり、`seq` の順は遷移の順になる。
  - forget の `meta.previousStatus`。
- 適合テストの `seq` の歯（Postgres・fixture、各2件）。
- core: `forget.test.ts` に、4つの遷移元ごとの `previousStatus` を足した。
- 変異試験（`cp` で退避・復元）。
  - `seq` を定数にする変異で、2件が赤になった。
  - 同じ `at` を `seq` の降順にする変異で、1件が赤になった。
  - `previousStatus` を落とす変異で、core の5件が赤になった。
  - どれも、戻すと緑に戻った。

## これが覆るとしたら

- 同じ記憶のイベントを、その記憶の行ロックを取らずに積む経路が増えたとき。そのときは `seq` の順の保証が崩れるので、経路の側でロックを取る。
- 違う記憶をまたぐ順（テナント全体の因果の順）が必要になったとき。`seq` はそれを保証しない。
