# ADR 0532: 穴探し — ADR 0527「測っていないこと」の実測。`tick` 経由の `consolidate`・`reflect` ジョブでも、`created` の `meta.sources` は小文字（割れなし。大文字の id がジョブに入る入口は無い。歯を足した）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つは材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。**直す割れは見つからなかった**。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 要点

- **文脈**: [ADR 0527](./0527-consolidate-reflect-created-sources-lowercase.md) が、`consolidate`・`reflect` の `created` の `meta.sources` を store が返した行の id（小文字）で書くようにした。「測っていないこと」に、`tick`（outbox のジョブ）経由の経路が残った。[ADR 0526](./0526-tick-jobs-after-delete-and-reextract-after-correction.md) は `tick` 経由の `consolidate`・`reflect` を測ったが、大文字の id は対象に入れていなかった（ADR 0521 の担当として切り分けたため）。
- **大文字の id がジョブに入る入口は無い**【現物】（下）。ジョブの payload の `memoryId` は、必ず store が書いた行の id（小文字）になる。
- **入口が仮に開いていても**（payload を直接書き換えた行）、ADR 0527 の直しで `meta.sources` は小文字になる【実測】。この「届かないはずの入口」の歯は、0527 の直しを外すと赤になる。
- 実装・公開 API・CHANGELOG・migration は変えていない。歯を1ファイル足した。

## 入口の確かめ【現物】

1. **ジョブを積む口**: `consolidate`・`reflect` のジョブを積むのは `observe` だけで、`RuntimeConfig.autoQueueConsolidateReflectOnExtract` が真のとき、記憶を作る `MemoryStore.createMemoryWithOutbox(ctx, memory, ["embed", "consolidate", "reflect"])`（と `createMemoriesWithOutboxAndEvents`）に `jobKinds` として渡す（`runtime.ts`）。
2. **payload は呼び出し側が渡せない**: `jobKinds` は種別の配列だけで、payload は store が組む。`@mnemora/postgres` の実装は `{ memoryId: memory.id }`（INSERT の `RETURNING` で返った行の id。`memory-store.ts` の2か所）。testkit の InMemory・core の Fake も作った行の id から組む。利用者が id を渡す引数は無い。
3. **`OutboxStore` に積む口は無い**: `OutboxStore` は `claimBatch`・`complete`・`fail` と掃除の口だけで、`enqueue` を持たない（`interfaces/outbox-store.ts`）。
4. **`tick` の読み方**: `processConsolidateJob`・`processReflectJob` は payload の `memoryId` をそのまま `seedMemoryId` として `consolidate`/`reflect` に渡す（`readSeedMemoryIdFromPayload`）。ここで綴りは直していない。
5. **結論**【判断】: 通常の経路では、ジョブの payload の id は store の行の id（Postgres の uuid は小文字の正規形、fixture は小文字の `mem-N`）で、大文字にならない。大文字が入るのは、利用者が outbox の行を直接書き換えた場合（DB を直接触る・別の書き手がいる）だけ。

## 表【実測】

同じテナントに、種（ジョブ付きで作る）と、種と同じ本文の近傍2件を作り、`tick({ kinds: [kind] })` で処理した。「通常の入口」= store が積んだ payload のまま。「届かないはずの入口」= payload の `memoryId` を直接大文字に書き換えた行（Postgres は `UPDATE outbox SET payload = …upper(…)`、InMemory・Fake は `outboxJobs` の payload を書き換え）。

| 欄 | Postgres | InMemory | Fake |
|---|---|---|---|
| 積まれた payload の `memoryId`（通常の入口） | 種の行の id そのもの（小文字） | 同じ | 同じ |
| `tick` の `processed`／`failed` | 1／0（通常・書き換えとも） | 同じ | 同じ |
| `created` の `meta.sources`（通常・書き換えとも、`consolidate`・`reflect`） | 小文字（種と近傍2件） | 小文字（同じ） | **近傍が取れず `created` が積まれない**（下の注）。積まれた分は小文字 |
| 作られた記憶の `provenance.sources` | 小文字（同じ並び） | 同じ | 同上 |
| `superseded` イベントの `memoryId`（`consolidate`） | 小文字（3件） | 同じ | 同上 |

- 割れなし: Postgres と InMemory は、通常の入口・書き換えの入口とも、同じ値になった。小文字で渡した場合との差も無い。
- **Fake の注**【実測】: Fake は全文の語彙一致を持たず、種の `digest` を検索語にした近傍が取れない（`consolidate`・`reflect` の種の形は近傍 0 件で何もしない）。ADR 0521 の注と同じ。Fake の leg は、ジョブが処理された（`processed: 1`・`failed: 0`）、入口の payload が行の id、書かれた欄がすべて小文字、だけを見る。Fake の `meta.sources` は ADR 0527 の `fake-sources-lowercase.test.ts`（`memoryIds` の形）が縛っている。

## 歯

- `packages/postgres/src/__tests__/tick-job-sources-lowercase.postgres.test.ts`（4本。実 Postgres と InMemory・Fake）: `consolidate`・`reflect` × 通常の入口・payload を大文字に書き換えた行。conformance suite には足していない（ADR 0434 決定5）。
- 注意: ジョブの `available_at` は壁時計で積まれるので（`RuntimeDeps.clock` の TSDoc、ADR 0526）、この試験は runtime の時計を壁時計より先へ進め、記憶の減衰の起点も壁時計にそろえている。

## 変異試験【実測】

ADR 0527 の直しを外す（`runtime.ts` の2か所の `sources` を `eligibleIds` に戻す。core を再ビルド）と、**「payload を大文字に書き換えた行」の2本（`consolidate`・`reflect`）だけが赤**、通常の入口の2本は緑のまま。戻した後は4本とも緑。→ 通常の入口は 0527 の直しに依らず小文字（入口が無いため）で、届かないはずの入口の歯が 0527 の直しを縛る。

## fuzz との関係

届かない。fuzz の harness（ADR 0492・0494）の操作に `tick`・outbox のジョブは無い。ADR 0494 の `argupper` の `consolidate`（I15）は `memoryIds` の形で、0527 の直しを縛っている。既存の profile の操作の列は変えていない。

## 実行時間【実測】

`tick-job-sources-lowercase.postgres.test.ts` は 4 本で約 10.8 秒（実 Postgres。記憶の再作成が支配的）。

## 探した形

- 操作 × 入口: `consolidate`・`reflect` × （通常の payload、大文字に書き換えた payload）× 3実装。
- 入口の探索: `jobKinds` の渡し方・`OutboxStore` の口・`createMemoryWithOutbox`/`createMemoriesWithOutboxAndEvents` の payload の組み方（Postgres・InMemory・Fake）。

## 検討した代替案

1. **`readSeedMemoryIdFromPayload` で payload の `memoryId` を小文字にそろえる**。採らなかった。通常の入口が無く、書き換えの入口でも ADR 0527 の直しで書かれる欄は小文字になる。payload の綴りを直す必要は無い（`consolidate`/`reflect` は store に従う）。
2. **歯を足さず、結果だけ書く**。採らなかった。入口が閉じていること（payload が行の id であること）と、書き換えの入口でも小文字になることを縛るものが他に無い。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | Fake の `tick` 経由の `meta.sources` の中身は、近傍が取れないので見ていない（`memoryIds` の形は 0527 の歯が見る） | 低 |
| 2 | 書き換えた payload の大文字が、`consolidate` の返り値や `tick` の他の欄（`basis` など）にどう出るかは見ていない（`tick` は返り値の id を返さない）【未確認】 | 低 |

## これが覆るとしたら

`OutboxStore` に payload を渡して積む口（`enqueue`）を足したとき。`createMemoryWithOutbox` が payload に呼び出し側の id を載せる形に変わったとき。

## 測っていないこと

- 並行する複数の `tick`、リースの期限切れによる再取得（ADR 0440・0142 が当てた面）。
- `extract` のジョブ経由の `created`（`meta.sources` を持たない経路）。
- 実 API（LLM・埋め込み）。
