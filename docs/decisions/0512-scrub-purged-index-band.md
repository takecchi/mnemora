# ADR 0512: v1.0.x の purge が `recalls.index_band` に残した digest を、`scrubPurged`（purge のかけ直し）で伏せる——下書き

- **状態**: 提案 (2026-10)（下書き。実装は未着手）
- **日付**: 2026-10-02

クローン miku の決定の下書きである。書いたのは担い手で、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**この PR（前半）は再現の歯と本 ADR の下書きまでで、`packages/postgres/src/memory-store.ts` は編集していない**（別の PR #1625 のマージ待ち）。直しは #1625 のマージ後に、同じ PR に積む。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  [ADR 0437](./0437-helpers-params-subject-ids-repurge.md) 決定6は、v1.0.x の purge が `recalls.index_band` の `digestBand` に残した digest が今も残るかを「未確認・範囲外」とした。[ADR 0375](./0375-purge-scope-widened.md) 決定3は、`index_band` の書き換えを `purgeMemory` の中（purge 時）だけに置いた。【現物】`PostgresMemoryStore.scrubPurged` は `memories`・`memory_labels`・`labels` だけを書き、`recalls` を触らない。

- **測ったこと**（【実測】2026-10-02、手元の Postgres 17、UTF8 `C.UTF-8`）:

  - **残る。** v1.0.2 の実物（`git worktree` で tag を build し、その `@mnemora/postgres`／`@mnemora/core` を通して、`scripts/generate-upgrade-fixture.mjs` と同じ作り方で）で、3件を observe・embed し、`budget: { maxMemoryChars: 25 }` の recall で1件を目次帯（`digestBand`）に載せ、その記憶を forget→purge した。purge 後、`memories.digest` は `[purged]` だが、`recalls.index_band.digestBand` の同じ `memoryId` の `digest` は元の本文のまま残った。
  - **陽性対照**: 同じ手順を今の main で走らせると、帯の digest は `[purged]` になる。手順が帯に digest を載せられていること（「残らない」が手順の不備でないこと）を、before の値で確認した。
  - **版**: `git show <tag>:packages/postgres/src/memory-store.ts` に `UPDATE recalls` は v1.0.0・v1.0.1・v1.0.2 に無く、v1.1.0 に在る。よって v1.0.0〜v1.0.2 で purge した行が対象である（【現物】）。
  - **既存の fixture の限界**: `upgrade-from-v1.0.x.sql` は purge の**後**に recall を撃つ作りで、帯に purge 済みの記憶が載らない。fixture は作り直していない（遡った書き換えではないが、fixture の再生成は別の判断）。
  - **歯**: `packages/postgres/src/__tests__/repurge-legacy-index-band.postgres.test.ts`。v1.0.x の purge の状態は、今の purge のあとで `index_band` だけを purge 前へ SQL で戻して作る。【実測】直す前: 陽性対照（今の purge は伏せる）は緑、`Runtime.purge` のかけ直しの歯は「帯の digest が `[purged]` にならない」で赤（dryRun が書かないことの確認までは通る）。

- **決めたこと（下書き）**:

  1. **`scrubPurged` は、渡された id のうち `status = 'forgotten' AND purged_at IS NOT NULL` の行について、そのテナントの `recalls.index_band` の `digestBand` のエントリを伏せる**（ADR 0375 決定3 の SQL を、`scrubPurged` の同じトランザクションの3文目として呼ぶ）。エントリは残し `digest` だけを置き換える（ADR 0375 代替案3 のとおり。`digestBandCoverage` の件数を保つ）。
  2. **置き換える値は、その行の `memories.digest`（purge が書いたトゥームストーン、既定 `[purged]`）にする。**`scrubPurged` には `tombstone` が渡らないので、purge 時に使われた値を行から読む（v1.0.x の purge も `digest` にトゥームストーンを書いている。【現物】）。
  3. SQL の形（`${id}` を `memoryId` ごとに回す。複数 id は `unnest` で結ぶ）:
     ```sql
     UPDATE recalls r
     SET index_band = jsonb_set(r.index_band, '{digestBand}', (
       SELECT coalesce(jsonb_agg(
         CASE WHEN p.digest IS NOT NULL
              THEN jsonb_build_object('memoryId', elem->'memoryId', 'digest', p.digest)
              ELSE elem END ORDER BY ord), '[]'::jsonb)
       FROM jsonb_array_elements(r.index_band->'digestBand') WITH ORDINALITY AS t(elem, ord)
       LEFT JOIN (SELECT id::text AS id, digest FROM memories
                  WHERE tenant_id = $tenant AND id = ANY($ids::uuid[])
                    AND status = 'forgotten' AND purged_at IS NOT NULL) p
         ON p.id = elem->>'memoryId'))
     WHERE r.tenant_id = $tenant AND r.index_band ? 'digestBand'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.index_band->'digestBand') e
                   JOIN memories m ON m.id::text = e->>'memoryId'
                    AND m.tenant_id = $tenant AND m.id = ANY($ids::uuid[])
                    AND m.status = 'forgotten' AND m.purged_at IS NOT NULL
                   WHERE e->>'digest' IS DISTINCT FROM m.digest)
     ```
     最後の `IS DISTINCT FROM` で、既に伏せた行は更新しない（べき等）。【判断】細部は実装時に歯に合わせる。
  4. **`InMemoryMemoryStore`（testkit）にも同じ範囲を実装する**。適合テスト（conformance）に `it` は足さない。`scrubPurged` の doc の契約（「`recalls` は書かない」）は書き換える。

- **問い（オーナーの領分になりうる）**:

  - **`recalls.query`（問いの文字列）をどうするか。** ADR 0375 引き受けた負債3・ADR 0437 のとおり、`consolidate`／`reflect` が種の digest を `text` にして撃った recall の `query` には、元の digest が入りうる。`memoryId` で特定できないため、何を消すか（`query` 全体か、digest と一致する部分か、触らないか）が決まらない。今回は触らない。
  - **migration で一括に消すか。**採らない（ADR 0437 決定5。オーナーの領分）。

- **検討した代替案**:

  1. **migration で遡って一括で伏せる。**採らない（上と同じ）。
  2. **`purgeMemory` の契約を変える。**採らない（ADR 0437 代替案1）。
  3. **エントリごと帯から削除する。**採らない（ADR 0375 代替案3）。

- **引き受けた負債**:

  - 費用: 対象テナントの `recalls` 全体を走査する（ADR 0375 決定6・負債1と同じ。0030 の索引が効く範囲は実装時に測る）。purge のかけ直しを大量に呼ぶ運用では積み上がる。
  - `recalls.query`・`explain`・`recall_usages` は残る。
  - 自動では走らない。利用者が purge をかけ直すまで残る（ADR 0437 と同じ）。

- **これが覆るとしたら**: オーナーが migration での一括処理を選んだとき（上の SQL がそのまま本体になる）。`recalls.query` の扱いが決まったとき（同じ口に足す）。

- **測っていないこと**: 本番規模での時間。v1.0.0・v1.0.1 の実物での再現（`UPDATE recalls` が無いことをコードで確認しただけで、v1.0.2 だけ走らせた）。SQL_ASCII の DB での歯。上の SQL の実行（下書きで、実行していない）。
