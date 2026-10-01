# ADR 0480: 穴探し51巡目 — 想起の記録の往復。`createRecall` の Invalid Date の `createdAt` を InMemory と Fake が受けていた。Fake の記録は呼び出し側と同じオブジェクトを共有していた

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・フィクスチャの揃え）の中だけを直し、新しく断る入力や既定値の変更に当たるものは「材料」に回した。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 51巡目は `MemoryStore.createRecall`・`getRecall`・`Runtime.getRecall` と、`observe({ kind: "memory_usage" })` が `recallId` で記録を指す往復を、postgres・testkit の InMemory・core の Fake の3実装で突き合わせた。`createRecall` の活動時計（ADR 0447 前後）・`recall_usages` が別テナントを指す件（ADR 0439）・footprint（ADR 0467・0470）・`RecallQuery.tags` の重複（ADR 0474）・ADR 0282 決定4（`getRecall` は zod で検証しない）・ADR 0438 は数えない。

- **見つけたこと**:
  1. 【実測】`createRecall` に `createdAt: new Date(NaN)` を渡すと、Postgres は `recalls` の INSERT で拒み（何も書かない）、InMemory と Fake は受けて `rcl-N` を返す。InMemory の `getRecall` はその後 Invalid Date を返す。runtime は `clock.now()` を渡すので、注入した時計が Invalid Date を返すと、本番だけが落ち、手元のテストは通る。他の書く口の Invalid Date（#807、ADR 0434）は fixture が拒むのに、この口だけ残っていた。
  2. 【実測】`FakeMemoryStore.createRecall` は `...record` で入力をそのまま保存し、`getRecall` は保存した `query`・`explain` を同じ参照のまま返す。書いた後に入力を、読んだ後に戻り値を書き換えると記録が変わる。InMemory は `structuredClone`、Postgres は jsonb の往復で、どちらも別物になる。

- **確かめ方**: 先に歯を書いて commit し、直す前に走らせて赤を取った（`.mgr-notes/red-before-0480.txt`）【実測】。歯は次のファイルの中に足した。
  - `packages/postgres/src/__tests__/recall-record-query-roundtrip.postgres.test.ts`（Postgres が拒むこと、testkit が拒むこと、`getRecall` の id の今の振る舞い）
  - `packages/testkit/src/__tests__/in-memory-recall-claim-storable.test.ts`
  - `packages/core/src/__tests__/fake-purge-expired-recalls-and-completed-jobs.test.ts`

- **決めたこと**【判断】:
  1. InMemory と Fake の `createRecall` は、`createdAt` が Invalid Date なら `createRecall: createdAt must be a valid Date (got Invalid Date)` で拒み、何も書かず活動時計も進めない。省略は壁時計を使うので検査しない。
  2. Fake の `createRecall` は入力を、`getRecall` は戻り値を `structuredClone` して持ち渡しする。`createdAt` も複製する。
  3. 本番コードは変えない。変えたのはテスト用の fixture（testkit）と Fake（core）だけで、公開 API・CHANGELOG・migration-v1 に影響しない。ADR 0434・0466・0475 と同じ、フィクスチャだけの揃えである。

- **歯の確かめ**【実測】: 変異 6 本（`.mgr-notes/mutations-0480.txt`）。Fake の検査の削除・Fake の書く側の複製の削除・読む側の複製の削除・testkit の検査の削除（足りなすぎ）と、Fake で「2026 年より前を拒む」・testkit で「渡された `createdAt` を全部拒む」（やりすぎ）の全てを歯が落とした。

- **照合して、割れていなかったもの**:
  - 【実測】`getRecall` の入力（Postgres と InMemory を同じ形で当てた）: 別テナント・実在しない id・空文字・NUL つき・前後の空白・波括弧つき・ハイフン無し・`undefined`・`null`・数値は、どちらも `null`。大文字の uuid は Postgres だけが同じ行を引き（`uuid` 列の比較）、`recallId` は小文字で返る。InMemory と Fake の id は `rcl-N` で uuid ではないので、この形は当たらない（ADR 0438 と同じ扱い）。
  - 【現物】`recall()` が返す並び・`omitted`・`usage`・`indexBand`・`explain` は、`createRecall` へ渡す値と同じ変数である（`recall-runtime.ts` 3384 行付近）。`returnedMemories` は `finalMemories` を写すだけで並びは同じ。JSON の往復で変わる値は `RecallRecord.query` の doc の表と `recall-explain-accounting.postgres.test.ts` が既に縛っている。
  - 【現物】観点4: 記録は `recalls` の jsonb で自己完結しており、指す記憶が `forget`・`purge` されても `getRecall` は同じ記録を返す（読み直さない）。`purgeExpiredRecalls` で消えた `recallId` への `recordUsage` は例外になる（ADR 0404、`recall-purge-race.postgres.test.ts`）。`observe` は使用の Observation を先に書いてから `recordUsage` を呼ぶので、その例外のあとも Observation の行は残る。これは ADR 0404 が書いた今の振る舞いであり、変えていない。【未確認】この巡では観点4を新しく実走していない。

- **材料（直していない。決めるのはクローンまたはオーナー）**:
  - Fake の `createRecall` は、InMemory が拒む NUL を含む `subjectId`・`query` や、JSON にならない値を拒まず、`assertWellFormedCtx` も呼ばない。Fake 全体の方針なので触っていない。
  - 消えた `recallId` に対する `observe({ kind: "memory_usage" })` が、使用の Observation を残したまま例外になること（上の観点4）。順序を入れ替える・先に検査する、は新しく断る入力の増減に当たるので、決めていない。
