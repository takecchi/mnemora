# ADR 0028: `reextract` は古い抽出結果を `superseded` にする（`forgotten` にしない）

- **状態**: 採用 (2026-09)

- **文脈**:

  [ADR 0013](./0013-extraction-outcome-taxonomy.md) は「LLM 呼び出し自体が失敗した」ことを
  `ExtractionOutcome.llm_failed_whole_observation` として検知できるようにしたが、
  「引き受ける負債」節で次を未解決のまま残していた。

  > **やり直しの経路自体は Phase 1 では提供しない。**検知できるようになっただけで、
  > 「失敗した抽出を再実行する」操作は無い。……**やり直すと生テキストの Memory が残ったまま
  > 正しい Memory が追加される**（重複）。この掃除をどうするかは未解決である。

  この重複が起きる理由はスキーマの一意索引そのものにある
  （`packages/postgres/migrations/0001_init.sql:105`）。

  ```sql
  CREATE UNIQUE INDEX uq_memories_extraction
    ON memories (tenant_id, source_observation_id, extractor_version, content_hash)
    NULLS NOT DISTINCT
    WHERE source_observation_id IS NOT NULL;
  ```

  冪等キーは `content_hash` を含む。全文フォールバックで作られた Memory の `content_hash` は
  Observation の全文のハッシュであり、やり直しで LLM が正しく抽出した Memory の
  `content_hash` とは一致しない。**⟹ 同じ `(tenant_id, source_observation_id,
extractor_version)` の下に、別の `content_hash` を持つ行として両方が生き残る。**
  `createMemoryWithOutbox` が返す `{ memory, created }` の `created` は「今回の挿入が
  実際に起きたか」しか教えてくれず、「同じ Observation に紐づく古い行を探して片付ける」
  経路は元々どこにも無かった——`MemoryStore` に「ある Observation から作られた Memory を
  列挙する」メソッド自体が存在しなかった。

- **決定**:

  1. `MemoryStore` に **SELECT のみ**のメソッド `listBySourceObservation(ctx, observationId,
extractorVersion)` を追加する。マイグレーション・索引は追加しない——
     `uq_memories_extraction` が既に `(tenant_id, source_observation_id, extractor_version)` の
     前方一致で使える形をしている。
  2. `runtime.reextract(ctx, observationId)` を追加する。流れ:
     a. Observation を取得する（無ければ例外）。
     b. `extractCandidates`（`observe()` と同じ核）を走らせる。
     c. LLM がまた失敗したら（`usedWholeObservationFallback`）、**何も supersede せず**
     `extraction: 'llm_failed_whole_observation'` を返す。
     d. 候補が0件なら、**何も supersede せず** `extraction: 'ok'` を返す。
     e. 候補が1件以上なら、`createMemoryWithOutbox` の同じ冪等経路で Memory を作る
     （ON CONFLICT により、既に同じ内容の行があれば新規行を作らない）。
     f. supersede 判定は**今回作る前**に読んだ既存 Memory の一覧を基準にする——これから
     作る Memory 自身が判定対象に混ざって「今回作ったものを今回 supersede する」という
     自己矛盾を避けるため。
     g. 同じ `(sourceObservationId, extractorVersion)` を持つ既存 Memory のうち、
     **`status: 'active'`** かつ今回作った `content_hash` の集合に含まれないものだけを
     `updateStatus(ctx, id, 'superseded', { supersededById: <今回作った Memory の1件> })`
     で置き換える。
     h. 置き換えた Memory それぞれについて `memory_events` に `kind: 'superseded'` を積む
     （`meta.reason: 'reextract_superseded'`）。
  3. supersede の対象は `status: 'active'` の Memory に限る。**オーナー決定**:
     全文フォールバックの Memory は `forgotten` ではなく `superseded` にする。
     理由（オーナーの言葉）: `forgotten` は**製品の振る舞い**（利用者が意図して忘れた）、
     `superseded` は**機構の都合**（より良い抽出に置き換えられた）。同じ札にすると
     この区別が消える。`superseded_by_id` が指す先を持てる（`forgotten` には指す先が無い）
     のも効く——「なぜ無いのか」を辿れるようにしておく。

- **採らなかった案**:

  - **全文フォールバックの Memory を `forgotten` にする**: 却下。上記のオーナー決定の理由
    そのもの。加えて、`aggregateScope`/`recall()` の `omitted` は `forgotten` を「利用者が
    意図して忘れさせた」という前提で扱っている（ADR 0027）。全文フォールバックはその前提と
    矛盾する——**利用者は何も指示していない**。抽出器が一時的に壊れていただけの内部事情を、
    利用者の意思決定を表す状態に紛れ込ませると、「なぜこの記憶が無いのか」という監査可能性
    （north-star の物差し）が壊れる。
  - **`extractorVersion` を上げて別物として並べる**: 却下。一見自然に見えるが、二つの理由で
    却下した。第一に、`extractorVersion` は「抽出器のロジックが変わった」ことを表す値であり
    （`RuntimeConfig.extractorVersion` のコメント参照）、「同じ抽出器で、たまたま LLM 呼び出しが
    一度失敗した」という状況に流用すると、`extractorVersion` の意味が「抽出器の版」と
    「試行回数」の二重の意味を持つことになり、冪等キー全体の意味が曖昧になる。第二に、
    バージョンを上げるだけでは**古い版の Memory が active のまま残り続ける**
    ——`recall()` の候補集合にもそのまま出続ける。ADR 0013 が解決しようとした「重複」問題を
    そのまま先送りするだけで、掃除にならない。
  - **`reextract` の中で古い Memory を無条件に消す（物理削除）**: 検討の対象外。
    `docs/memory-model.md` §9 が明言する「削除経路は必ず `EventStore.append` と同一
    トランザクション」「purge は Phase 2」という規律に反する。`superseded` という既存の
    lifecycle 状態（Phase 1 スキーマに既にある）で表現できるものを、わざわざ物理削除の
    経路を新設してまで実現する理由が無い。
  - **既存 Memory を全部 supersede する（content_hash の集合比較をしない）**: 却下。
    「変わっていない候補」まで supersede してしまうと、reextract を2回目に走らせただけで
    直前に作ったばかりの Memory が supersede される（本 PR のテスト
    「変わっていない候補は、2回目の reextract でも superseded にならない」が検出する）。
    content_hash の集合比較は、「今回の抽出結果と一致するかどうか」を判定する唯一の手段
    であり、これを外すと reextract 自体が意味のある操作でなくなる。

- **安全弁（2つ。どちらも歯にした）**:

  - **候補が0件なら、何も supersede しない。** 「何も記憶に値しない」という判断は正常な
    抽出結果であり（ADR 0013 と同じ判定基準）、これを根拠に既存の記憶を消す理由にならない。
    そもそも supersede 先の Memory が1件も作られないので `superseded_by_id` の指す先が無い。
  - **`status: 'active'` 以外は supersede しない。** 特に `forgotten` は絶対に触らない
    ——利用者が意図して忘れさせたものを、機構の都合（抽出器の再試行）で上書きしない。
  - **`contested` も対象外にした**（本 PR の判断）。`contested` は対向 Memory との対で
    初めて意味を持つ契約（mandatory companion retrieval、`docs/memory-model.md` §5）を
    持つ。機構都合の reextract がその対の片方だけを一方的に supersede すると、
    もう片方だけが `contested` のまま残る・あるいは矛盾の解決ロジックと二重に競合する、
    といった経路を作りかねない。`contested` を reextract の対象に含めるべきかどうかは
    実装した範囲では判断材料が無く、**含めない**という保守的な側に倒した。

- **冪等性の検査方針（オーナーの線）**:

  「やり直したら重複が残る」が本当に解消したかは、reextract を**2回**走らせて Memory の
  総数を数えるまで「直った」に数えない。1回目で増え、2回目では1件も増えないことを
  assert する（`packages/core/src/__tests__/runtime.test.ts` の
  「⭐ reextract を2回走らせても、2回目では Memory が増えない」）。**「キーが存在する」を
  確認するだけでは、時刻・乱数などが絡む実装のバグを見逃す**——実際にこのリポジトリの
  作業では、DB を使わない `packages/core` の fake ストアに対して3種の変異
  （安全弁を外す・status ガードを外す・content_hash 比較を外す）を当て、それぞれ狙った歯が
  赤くなることを確認した（本 PR の報告参照）。

- **引き受ける負債**:

  - **🔴 `active` 以外を飛ばしたことが、どこにも出ない（2026-09-06 に確認）。**
    `reextract` は `status !== 'active'` の既存 Memory を `continue` で飛ばすが、
    **飛ばしたことは `ReextractResult` にも `memory_events` にも残らない**
    （`superseded` イベントは実際に supersede したときだけ積む）。
    ⟹ **`supersededMemoryIds: []` は、次の3つで同じ顔になる**:

    | 実際に起きたこと | 呼び出し側から見える形 |
    |---|---|
    | `contested` だったので飛ばした | `supersededMemoryIds: []` |
    | `forgotten` だったので飛ばした | `supersededMemoryIds: []` |
    | そもそも置き換えるものが無かった | `supersededMemoryIds: []` |

    **[ADR 0008](./0008-absence-taxonomy.md) の判定基準（その区別があると次の一手が変わるか）に
    照らすと、変わる**——`contested` なら対向の解決が先に要る、`forgotten` なら触ってはいけない、
    無かったのなら何もしなくてよい。**次の一手は3つとも違う。**

    **⚠ これはこの repo で繰り返し現れている形である**——
    [ADR 0011](./0011-no-window-count-in-ann-stage.md)（件数が設定値を返していた）、
    [ADR 0025](./0025-ann-underfill-is-not-reported-in-omitted.md)（取りこぼしが `omitted` に出ない）、
    [ADR 0027](./0027-split-superseded-forgotten-omission.md)（`superseded` と `forgotten` が同じ札）
    と同じ族である。**本 ADR ではこれを記録に留め、直していない。**
    直すなら別の ADR を起こすこと（欄を足す判断になり、
    [ADR 0024](./0024-remove-exact-counts-option.md) の義務——足した欄の経路を実測する——が生じる）。

  - `runtime.reextract` を実際に**いつ**呼ぶかの経路（cron、手動、`ExtractionOutcome ===
'llm_failed_whole_observation'` を検知した監視からの自動トリガーなど）は本 PR の範囲外
    である。ADR 0013 と同じく「検知・掃除の機構」を作っただけで、「いつ使うか」の運用は
    別途決める必要がある。
  - `reextract` は LLM を**都度呼ぶ**（`observe()` と同じ経路）。大量の
    `llm_failed_whole_observation` を一括で再試行する運用（バッチ処理、レート制御、
    指数バックオフ等）は本 PR に含まれない。
  - `supersededById` は「今回作られた Memory のうちの1件」（先頭）を指す。候補が複数件
    あった場合、どの1件を指すかは配列の順序に依存する——LLM が返した順序がそのまま
    `supersededById` の選択に影響する。これで十分かどうかは、実運用で「なぜこの Memory に
    置き換えられたのか」を辿るときに問題にならないかを見てから判断する。
  - `reextract` は `tick()` の外側にある独立した公開 API であり、`extract: 'deferred'` の
    outbox ジョブの一種にはしていない。理由: `reextract` は「呼び出し側が明示的に選んだ
    Observation」に対して行う操作であり、`observe()` の通常経路（新規 Observation の取り込み）
    とは呼ばれる文脈が異なる。同じ `tick()` の待ち行列に混ぜると、「なぜこの Observation が
    再抽出されたのか」（新規取り込みなのか、やり直しなのか）が outbox の中で見分けにくくなる
    懸念があったため、別関数として分離した。この判断はオーナーに確認していない。

- **確かめていないこと**:

  - **本物の PostgreSQL に対して `listBySourceObservation` を実行して確認していない。**
    作業環境に手元の PostgreSQL が無く（マネージャー指示）、`packages/postgres` 側の実装は
    型検査とコードレビューのみで確認した。`packages/testkit` の適合テスト
    （`listBySourceObservation` の2本）は `packages/postgres` の CI ジョブで
    `describeMemoryStoreConformance` 経由として走る**はず**だが、実際に本物の Postgres に
    対して緑になることは確認していない。
  - **`reextract` を実際の LLM（本物の OpenAI 等）に対して実行していない。** `OPENAI_API_KEY`
    を読まない・実 API を叩かないという制約の下で作業したため、`packages/core` の
    決定的な fake LLM provider に対してのみ検査した。
  - `contested` を reextract の対象から外したことが、実運用上「不便」なケース
    （例えば、矛盾していた2件のうち片方が実は誤抽出で、reextract で正しい内容に
    置き換えたいのに supersede されない）を生むかどうかは確かめていない。
  - `supersededMemoryIds` が複数件になるケース（同じ Observation から複数の Memory が
    抽出されており、そのうち何件かが今回の抽出結果と一致しなくなった場合）は
    テストで検査したが、実運用でどの程度の頻度で起きるかは分からない。

- **これが覆るとしたら**:

  - `contested` を reextract の対象に含めるべきだと運用で分かったら、対向 Memory との
    契約をどう扱うか（両方を一緒に supersede する、片方だけ許すが `contested` の相方を
    探すロジックを足す等）を決める別の ADR を起こす。
  - `reextract` の呼び出し経路（バッチ化・自動トリガー）を実装する際、`tick()` に統合する
    かどうかを再検討する。
