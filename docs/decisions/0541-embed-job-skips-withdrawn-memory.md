# ADR 0541: 埋め込みジョブは、forget・purge した記憶の本文を外部の embedding provider に送らない（オーナーへの問28）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。**オーナーへのまとめ問い（374f6f88）の問28の、依頼主の推奨を先に形にしたもの**。オーナーには「2026-10-03 01:00Z までに止められなければ、依頼主の判断で進める」と伝えてある。それまでは Draft のまま、マージしない。オーナーが止めれば、この ADR と変更を取り下げる。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 問いと直す前の赤【実測】

forget した記憶でも、forget の前に積まれた埋め込みジョブ（`createMemoryWithOutbox` の `jobKinds: ["embed"]`。`observe` が積む）が後から `tick` で走ると、`processEmbedJob` は記憶を読み、`deps.embeddingProvider.embed(ctx, [resolveEmbeddingInput(memory)])` を呼ぶ。外部の provider（OpenAI など）に、消したはずの本文が渡る。

数える provider（呼ばれた回数と渡された入力を記録する）で、記憶を作る → 埋め込みジョブが積まれる → forget（別の歯で purge）→ `tick` でジョブを処理する、を Postgres・testkit の InMemory・core の Fake で走らせた。直す前:

| 状態 | provider に渡った入力（3実装とも同じ） |
|---|---|
| forgotten | **本文そのもの**（`secret-body-XYZ`） |
| purged | **墓標 `[purged]`**（purge は本文を墓標に置き換えるので、本文はもう無く、空・例外ではなく墓標が渡る） |
| active・archived・superseded・contested | 本文（今までどおり） |

歯（直す前に 6 本赤、3実装 × forgotten・purged）。ベクトルは forgotten の記憶に書かれた（purged は `processEmbedJob` の後段の読み直しが消す）。

## 決定

1. **`processEmbedJob` は、読んだ記憶が `forgotten` か purge 済み（`purgedAt` あり）なら、provider を呼ばずに返す**（`packages/core/src/runtime.ts`。判定は既存の `isWithdrawnSeed`＝ADR 0152 の `consolidate`/`reflect` の種の線と同じ）。`embeddingInput` のフックも呼ばない。
2. **ジョブの終え方は `complete`**（`tick` は handler が返れば `complete` する）。`failed` にしない。理由【判断】: 消された記憶に埋め込みは要らないので、失敗ではなく「済み」。`fail` にすると `lastError` が残って障害に見え、`TickResult.failed` を数える監視を鳴らす。再試行は元から無い（終端）ので、回り続けない。【実測】2回目の `tick` は `processed: 0`。
3. **印は残さない**。`embeddingStatus` は触らず（`pending` のまま）、ベクトルも書かない。`skipped` に書き換える案は採らなかった（新しい状態遷移を足し、forgotten からは戻せないので意味が無い。`recall` は forgotten を元から出さない）。
4. **他の状態は変えない**【実測】: `active`・`archived`・`superseded`・`contested` は埋め込む（`embeddingStatus: ready`・ベクトルあり）。歯がやりすぎの対照として縛る。
5. **判定の時点と残る窓**: 判定は、handler が `get` で読んだ記憶による。読んだ後、provider を呼ぶ前に forget されると、本文は送られる。**塞げない窓**で、読み直しても、読み直しと送信の間に同じ窓が残る（送信前の最後の読みは存在しない）。【実測】Fake で、`get` が返した直後に forget を差し込むと、本文が送られる（歯が「残る窓」として記録している）。この窓は材料にする。provider への送信は取り消せない。

## 他の経路【実測・現物】

provider（embedding・LLM）に本文を送る経路を、`deps.embeddingProvider.embed`・`deps.llmProvider` の呼び出し箇所（`runtime.ts`・`recall-runtime.ts`・`extraction.ts`）から数えた。

| 経路 | provider | forgotten・purged の記憶の本文を渡すか | 直したか |
|---|---|---|---|
| `tick` の `embed` ジョブ（`processEmbedJob`） | embedding | **渡していた** | **直した（この ADR）** |
| `reembed`（`requeueEmbedJobs`）で積み直したジョブ | embedding（上の経路） | 同じ経路。`embeddingStatus` だけで選ぶので forgotten も積まれるが、走らせるとき上の判定で止まる | 上で止まる（積み直し自体は変えていない。材料1） |
| `recall` のクエリ埋め込み（`recall-runtime.ts`） | embedding | 渡さない（クエリの文字列。記憶の本文ではない） | 不要 |
| `consolidate`（`memoryIds`・`seedMemoryId`・`query`） | LLM | 渡さない。forgotten・purged の元は `status_not_active` で材料から外れ、prompt に載らない。種が forgotten・purged なら LLM を呼ばない【実測】 | 不要（歯で今の振る舞いを縛った） |
| `reflect`（同上） | LLM | 同上 | 不要（同上） |
| `tick` の `consolidate`・`reflect` ジョブ | LLM | 上と同じ（種が forgotten なら何もしない。ADR 0526） | 不要 |
| `extract`・`reextract`・`observe` の抽出 | LLM | 渡さない。prompt は Observation の本文と `extractionContext` から作る。forget した記憶の本文は入らない【現物】。再配達で forgotten な記憶を蘇らせない線は ADR 0347 | 不要 |
| `findCorrectionCandidates`・`applyCorrection` | embedding（クエリ） | 渡さない（訂正の発話の文字列） | 不要 |

- `consolidate`・`reflect` が「元の一部が forgotten だった」ときは、その記憶だけを材料から外して残りで進める（`status_not_active`）。**断らない**。この線は既存で、今回変えていない【実測】。
- 同じ形の経路は、`embed` ジョブの 1 本だけだった。

## 歯と変異試験【実測】

- `packages/postgres/src/__tests__/embed-job-skips-withdrawn-memory.postgres.test.ts`（25 本。実 Postgres と InMemory・Fake）: forgotten・purged で provider が 0 回・ジョブが complete・2 回目の tick で拾い直されない・ベクトルが書かれない・`embeddingStatus` が `pending` のまま。active・archived・superseded・contested は今までどおり埋め込む。残る窓（Fake）。consolidate・reflect の prompt に forgotten・purged の本文が載らないこと。
- `packages/core/src/__tests__/fake-embed-job-skips-withdrawn.test.ts`（4 本。DB を要らない Fake の歯）。
- 直す前に当てると、postgres の歯は 6 本、core の歯は 2 本が赤。
- 変異: `processEmbedJob` の `isWithdrawnSeed` の早期 return を外すと、postgres の歯は 6 本、core の歯は 2 本が赤（対照と窓の歯は緑のまま）。戻した後は全部緑。
- 既存の歯: core の embed・tick・reembed・forget・purge・requeue 系 29 ファイル（183 本）、postgres の同系 36 ファイル（423 本）は緑のまま。
- conformance suite には何も足していない（ADR 0434 決定5）。

## CHANGELOG・migration

- CHANGELOG: `[1.3.0]` の `### Fixed` に書いた。この repo の CHANGELOG に `### Security` の見出しは無い（使われたことが無い）ので、Fixed。`[1.2.0]` は触っていない。
- migration-v1: 「v1.2.0 → 次の版」の🟡に書いた。新しく断る入力は無いが、provider の呼び出し回数・forgotten な記憶のベクトルの有無に頼るコードは影響を受ける。

## 範囲の外（触っていない）

- すでに送られた分は取り消せない。
- 残った行（forget の後に書かれたベクトルなど）の遡っての掃除（問いの ✕ 側）。migration・バックフィルも作っていない。
- conformance suite。

## 材料（直していない）

1. **`reembed` が forgotten・purged の記憶を積み直す**: 選ぶのは `embeddingStatus` だけで、status では絞らない。積み直されても走らせるとき止まる（この ADR）ので送信は起きないが、無駄なジョブが積まれる。選ぶ側で除くと、`reembed` の対象が変わる（公開の振る舞い）。オーナーの領分。
2. **窓**: `get` の後・provider を呼ぶ前に forget されると本文が送られる。塞ぐなら、provider 呼び出しを forget と直列にする（記憶ごとのロック）か、送信後に forget を検出して通知する形になるが、どちらも大きな設計で、送信は取り消せない。
3. **`consolidate`・`reflect` の同じ窓**: 材料の一覧を `get` で読んでから LLM を呼ぶまでの間に forget されると、本文が prompt に載る（書く前の読み直し〔ADR 0420〕は LLM の後なので、送信は防げない）。新しい断りにはならないが、大きな設計になる。
4. 問28の ✕ 側（残った行の遡っての掃除）。

## 検討した代替案

1. **ジョブを `fail` で終える**。採らなかった（上の決定2）。
2. **`embeddingStatus` を `skipped` にする**。採らなかった（決定3）。
3. **ジョブを取る時点（`claimBatch`）で forgotten のジョブを除く**。採らなかった。outbox は記憶の status を知らない（store の責務の外）で、除くなら JOIN が要り、公開の振る舞いが変わる。
4. **provider を呼ぶ直前に読み直す**。採らなかった。読み直しても窓は消えず、`get` の回数が増えて既存の歯（`get` の回数を数えるもの）に影響しうる。

## 引き受けた負債

材料1〜3。

## これが覆るとしたら

オーナーが問28で「forgotten・purged でも埋め込む」を選んだとき（この変更を取り下げる）。材料2・3 の窓を塞ぐ設計が決まったとき。
