# ADR 0542: `reembed` は元から forgotten・purge 済みの記憶のジョブを積まない（ADR 0541 の材料1は現物の読み違いだった。割れなし。歯を足した）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。依頼は「ADR 0541 の材料1（`reembed` が forgotten の記憶のジョブも積み直す）を、ジョブを積む段階で forgotten・purge 済みを外して直す」だった。**現物を読むと、積み直す対象は元から `active`・`contested` だけで、直す割れは無かった**。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定。

## 現物【現物】

- Runtime の `reembed`（`runtime.ts`）は `limit` を検査して `memoryStore.requeueEmbedJobs` へ渡すだけ。選ぶのは store。
- **Postgres**: `buildRequeueEmbedTargetSelect`（`memory-store.ts`）の `WHERE` に `status IN ('active', 'contested')` がある。`embedding_status = ANY(statuses)`・`memoryIds` の絞り込みの前に効き、`ORDER BY updated_at ASC, id ASC LIMIT n` はその後。
- **testkit の InMemory**・**core の Fake**: どちらも `(m.status === "active" || m.status === "contested") && …` で絞る。
- したがって forgotten（purge 済みも `status = forgotten`）・archived・superseded は、`embeddingStatus` が対象でも選ばれない。3実装で同じ。

ADR 0541 は材料1に「選ぶのは `embeddingStatus` だけで、status では絞らない」と書き、経路の表にも「forgotten も積まれる」と書いた。**これは `WHERE` の最初の行を読まずに書いた誤り**で、事実と違う（0541 は未マージの Draft〔#1644〕で、その材料1と表の1行は訂正が要る。この ADR の枝では 0541 の文書に触れていない）。0541 の直し（`processEmbedJob` が forgotten・purged で provider を呼ばない）は、`reembed` とは別の経路（forget の前に積まれていたジョブ）に効くもので、変わらず必要。

## 実測【実測】

記憶を `embeddingStatus: failed` で作り、状態を変えてから `reembed({ statuses: ["failed"], limit })`。3実装（Postgres・InMemory・Fake）で同じ結果。**直す前の赤は出なかった**（そもそも直すものが無い）。

| 状態 | 積まれるか | 備考 |
|---|---|---|
| active | 積む | |
| contested | 積む | 相方（同じく `failed`）も積む |
| archived | 積まない | |
| superseded | 積まない | |
| forgotten | 積まない | |
| purged | 積まない | |

- `limit` との関係: **外してから `limit` 件まで詰める**（`WHERE` が `LIMIT` より先に効く）。最も古い `updated_at` の forgotten が1件あっても、`limit: 2` で active が3件あれば 2 件返る【実測】。
- `memoryIds` で forgotten を名指ししても、積まれない（`{ requeued: 0, memoryIds: [] }`）。
- 返り値（`requeued`・`memoryIds`）の形は変えていない。

## 決定

1. **実装は変えない**。依頼の直し（ジョブを積む段階で forgotten・purged を外す）は、すでに入っている。
2. **今の振る舞いを歯で縛った**: `packages/postgres/src/__tests__/reembed-skips-withdrawn.postgres.test.ts`（24 本。実 Postgres と InMemory・Fake。上の表の 6 状態、`limit` の詰め方、`memoryIds` の名指し）。conformance suite には足していない（ADR 0434 決定5）。
3. **変異試験**【実測】: 3 実装それぞれで、選ぶ述語に `forgotten` を足す（Postgres の `status IN (…, 'forgotten')`、InMemory・Fake の `|| m.status === "forgotten"`）と、4 本が赤（forgotten・purged・`limit`・`memoryIds` の名指し）。元に戻すと 24 本とも緑。
4. **CHANGELOG・migration-v1 は書かない**: 出荷物の振る舞いは変わっていない。

## 材料2・3（塞がずに記録するだけ。ADR 0541 を指す）

- 材料2（`get` で読んでから provider を呼ぶまでの窓。embed）と材料3（`consolidate`・`reflect` の、材料を読んでから LLM を呼ぶまでの同じ窓）は、[ADR 0541](./0541-embed-job-skips-withdrawn-memory.md) の「材料」に書いたとおり。塞いでいない。読み直しても、読み直しと送信の間に窓が残る。塞ぐなら記憶ごとの直列化などの大きな設計で、オーナーの領分。
- 0541 の材料1は、この ADR の実測で「無かった」ことになる。

## 検討した代替案

1. **それでも `Runtime.reembed` の側で status を絞る（二重に効かせる）**。採らなかった。store が元から絞っている。Runtime にもう一つ足すと、`limit` に満たなくなる（先に `limit` で切ってから外す）形のずれを作りうる。
2. **歯を足さず、結果だけ書く**。採らなかった。3 実装のどれかが `forgotten` を含めても、既存の歯は気づかない（変異で確かめた）。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | ADR 0541（#1644、Draft）の材料1・経路の表の1行が事実と違う | 低（0541 の側で直す） |

## これが覆るとしたら

`requeueEmbedJobs` が選ぶ status を広げる（archived なども積み直す）と決めたとき。
