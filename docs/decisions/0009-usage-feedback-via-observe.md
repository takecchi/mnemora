# ADR 0009: 使用フィードバックを observe() で受ける

- **状態**: 採用 (2026-09)

- **文脈**:
  `docs/decisions/0004-decay-at-query-time.md` の強化(reinforcement)は「実際に使われた」記憶だけを
  対象にする。検索に出ただけでは強化しない。そのためには、recall が返した候補のうち、呼び出し側
  （LLM・アプリケーション）が実際にどれを使ったかを mnemora に伝え返す経路が必要になる。
  一方で mnemora の API 表面は5つの動詞（`observe` / `recall` / `reflect` / `consolidate` / `forget`）
  に固定する方針であり、6つ目を安易に足さない。この制約の中でどう受けるかを決める必要がある。

- **決定**:
  動詞を5つに保つ。「どの記憶を実際に使ったか」は既存の `observe()` で受ける。

  ```
  observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })
  ```

  `observe()` の入力は判別可能ユニオン（`utterance | event | usage | document | ...`）にし、
  `memory_usage` はその一種として扱う。

- **検討した選択肢**:
  - **`recall()` の戻り値にメソッドを生やす**（例: `result.markUsed(memoryIds)` のような API）:
    呼び出し側にとって直感的ではあるが、**戻り値がメソッドを持つ時点でシリアライズできず、
    HTTP 越しに使えなくなる。**mnemora は Phase 4 で `packages/server`（HTTP）と `packages/sdk`
    （クライアント）を持つ計画であり、`recall()` の戻り値が将来 JSON としてネットワークを
    越える必要がある。メソッドを生やす設計は、この時点で確実に破綻する。**これが却下の決定打。**
  - **6つ目の動詞 `reinforce()` を足す**: 意味は明確になるが、「動詞を5つに保つ」という
    API を小さく保つ要求に正面から反する。動詞を増やす代償（呼び出し側が覚える操作が増える、
    API サーフェスが広がる）に見合う理由が無い。却下。
  - **既存の `observe()` で受ける**: 採用。

- **理由**:
  1. **「起きたことを記録する」という入口を一つに保てる。**`observe()` はもともと「外から入ってきた
     出来事を記録する」動詞であり、「この recall のこの記憶が使われた」という事実も、広い意味で
     「起きたこと」の一種である。動詞の意味を過度に拡張せずに収まる。
  2. **冪等キーの扱いが一箇所で済む。**`observe()` は既に `externalId` による冪等性の仕組みを
     持っており、`memory_usage` もその枠組み（`(recall_id, memory_id)` 主キー、
     `docs/decisions/0006-memory-schema.md` 参照）にそのまま乗せられる。新しい動詞を作ると、
     冪等性の設計をもう一箇所増やすことになる。
  3. **動詞を増やさないという要求を満たす。**`recall()` の戻り値にメソッドを生やす案が
     シリアライズ不能という決定的な欠陥を持つ以上、残る選択は「既存の動詞で受けるか」
     「新しい動詞を作るか」のどちらかであり、要求を満たすのは前者だけだった。

- **結果（この決定が招くもの）**:
  良い面: API サーフェスが5動詞のまま保たれる。HTTP 越しの `server`/`sdk`（Phase 4）でも同じ
  `observe()` エンドポイントがそのまま使え、特別な経路を用意する必要が無い。冪等性・記録の仕組みが
  `observe()` に一本化される。

  引き受ける負債: **`observe()` の入力が判別可能ユニオンとして肥大しうる。**`utterance` /
  `event` / `usage` / `document` に加えて将来入力の種類が増えるたびに、この1つの動詞が扱う
  スキーマの数が増える。1つの動詞に責務が集中しすぎるリスクがある。
  対処: **種別ごとにスキーマを zod で分け（判別可能ユニオンの各枝を独立した zod スキーマとして
  定義し）、`observe()` 自体の責務は「起きたことを1つ記録する」という一点に固定する。**
  `observe()` の実装が種別ごとの分岐で複雑化しないよう、種別ごとの処理は `kind` に基づいて
  ディスパッチする構造にし、`observe()` 本体にビジネスロジックを持たせない。

- **これが覆るとしたら**:
  - `observe()` の入力ユニオンが実際に肥大化し、可読性・型推論のパフォーマンス・API ドキュメントの
    分かりやすさが実用上損なわれると分かったら、使用頻度の高い種別（`memory_usage` など）だけを
    独立した動詞に昇格させることを再検討する余地はある。ただしその場合も「動詞を増やす」という
    コストに見合う理由（実測される問題）が必要であり、本 ADR の時点ではその理由は無い。
  - Phase 4 の `server`/`sdk` を実装する過程で、`memory_usage` の報告に `observe()` 以外の
    より適した経路（例えばイベントストリーミング）が必要だと分かったら、その時点で見直す。

- **確かめていないこと**:
  - `observe()` の入力ユニオンが将来何種類まで増える見込みかは見積もっていない。Phase 1 時点で
    確定しているのは `utterance | event | usage | document` の4種であり、これで十分かは
    実装・運用を経ないと分からない。
  - zod のユニオン型の型推論パフォーマンス（種別数が多くなったときの TypeScript のコンパイル時間
    への影響）は検証していない。

## 追記（2026-09-26、[Issue #871](https://github.com/takecchi/mnemora/issues/871)）: 使用報告による強化は `memory_events` に書かない——文書を実装に合わせた

⚠ この追記はクローン miku の判断による（オーナー本人の決定ではない。
[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
上の本文（決定・理由・結果）は書き換えていない。

**なぜこの ADR に書くか**: `docs/memory-model.md` §9 の記録項目の段落と §11 行4 は、
使用報告による強化が `memory_events` に `kind='updated'`・`meta.reason='reinforced'` を積むと書いていた。
この約束は設計フェーズの PR #1 で `docs/memory-model.md` に直接書かれたもので、
`memory_events` の記録項目を決めた ADR は無かった（ADR 0001〜0009 のどれも
`memory_events` の記録項目に触れていない）。使用報告から強化へ至る経路を決めたのは本 ADR なので、
ここに記録した。

**食い違い（Issue #871 の実測、2026-09-26 に現物のコードで再確認）**:
- `packages/core/src/runtime.ts` の `handleMemoryUsage` は、`MemoryStore.recordUsage` で
  `recall_usages` に行を挿入し、挿入された id それぞれに `MemoryStore.reinforce` を呼ぶだけで、
  `EventStore.append` も `MemoryStore.updateStatusWithEvent` も呼ばない。
- `PostgresMemoryStore.reinforce`/`recordUsage` は `memories` の `UPDATE` と `recall_usages` の
  `INSERT` だけを撃ち、`memory_events` に触れない。testkit の `InMemoryMemoryStore` と
  `packages/core` のテスト用 Fake も同様である。
- Issue #871 は Fake と本物の Postgres の両方で、使用報告の前後で `memory_events` が0件のまま
  変わらないことを実測している。

**決めたこと**: 文書を実装に合わせた。`docs/memory-model.md` §9 の例から `reinforced` を外し、
§11 行4 の「残るイベント」を「なし（使用の記録は `recall_usages` の行の存在で表す）」とした。
コード（`packages/*/src`）の挙動は変えていない。
根拠はオーナーの2つの方針である。2026-09-16 の「設計文書と実装がずれたら、原則として記述を
実態へ合わせる。元の設計思想は保つ」と、2026-09-24 の「決められるものは判断して進めてよい」。
元の設計思想——「使われたかどうか」は行の存在で表す（`docs/architecture.md` の使用報告の表）——は、
`recall_usages` の `(recall_id, memory_id)` 主キーがそのまま担っており、この変更で損なわれない。

**採らなかった案**: 実装を文書に合わせる（使用報告の処理の中で `kind='updated'`・
`meta.reason='reinforced'` を積む）。採らなかった理由は次の2つである。
1. 使用報告のたびに、対象 Memory 1件につき1行ずつ監査ログが増える。1回の recall は複数の Memory を
   返すので、書き込みと保持容量は他のどの操作よりも高い頻度で増える。既存の利用者の DB では、
   この分の増加が予告なく始まる。
2. `memory_events` は追記専用（`docs/memory-model.md` §9）なので、一度積んだ行は保持期間が
   来るまで残る。後で書き込みを止めても、それまでに積んだ分は減らない。文書の変更は、
   後で方針が変わっても文書を書き換えるだけで戻せる。

**残るもの**: 「なぜ強化されたか」を `memory_events` から後で引く経路は無い。使用の事実は
`recall_usages`（`recall_id`・`memory_id`・`used_at`）から引く。
Issue #871 が触れている別の穴（#840、強化が `status` を見ない）は、この追記では扱っていない。
