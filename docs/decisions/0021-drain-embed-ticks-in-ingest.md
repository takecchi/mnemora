# ADR 0021: `examples/chat` の `ingestConversation` は `tick()` を干上がるまで回す

- **状態**: 採用 (2026-09)

- **文脈**:

  [ADR 0019 §5](./0019-real-openai-measurement-cost.md#5-もう1つ既存ベンチが測れていなかったこと実測擬似-providerでも成り立つ)
  が実測して記録した欠陥が、記録されただけで直っていなかった。

  `packages/core/src/runtime.ts` の `DEFAULT_TICK_LIMIT` は **50**。
  `PostgresOutboxStore.claimBatch` は `ORDER BY available_at ASC` で先着順に
  embed ジョブを claim する。`examples/chat/src/mnemora-path.ts` の
  `ingestConversation`（`docs/north-star.md` の物差しを直接測る `compare` サブ
  コマンドが使う、主測定の取り込み段）は、observe() をすべて終えた後に
  `runtime.tick(ctx, { kinds: ["embed"] })` を**1回しか**呼んでいなかった。

  **⟹ 会話が長くなって observe() された発話（＝作られる Memory）が50件を
  超えると、51件目以降は埋め込まれないまま `embeddingStatus: "pending"` に
  残り、`recall()` の ANN 候補にすらなれない。** `recall()` はこれを隠さず、
  `omitted` に `{ kind: "not_indexed", reason: "pending" }` として正直に出す
  （[ADR 0008](./0008-absence-taxonomy.md)）——**隠していたのは mnemora ではなく、
  `omitted` を読まずに実測結果を要約した側である。**

  ADR 0019 §5 が擬似 provider・642ターンで実測した数字:
  スコープ内 Memory 321件のうち、`omitted = [ann_truncated, over_limit:30,
  not_indexed(pending):271]`——**271件が `pending` のまま。実際に ANN の
  候補として競ったのは50件だけ**だった。`examples/chat/README.md` の
  「冒頭の事実が `recall()` に残るか」の表（642ターンで✅）は、この事実を
  踏まえずに書かれていた。冒頭の事実（`FACT_STATEMENT`）は必ず最初の
  embed ジョブになるため50件の枠に入り、たまたま生き残っていただけである。

  **同じリポジトリの中に、正しい直し方が既に存在していた。**
  `examples/chat/src/retrieval-quality.ts` の `drainEmbedTicks()` は
  `tick()` を `processed === 0` になるまで回し切る形で、まさにこの問題を
  回避していた。ただし `retrieval-quality` という別サブコマンド（意味的関連性の
  測定用）の中だけに閉じており、北極星の主測定である `compare` が使う
  `ingestConversation` には移植されていなかった。`drainEmbedTicks` 自身の
  docstring が「`ingestConversation` は `tick()` を1回しか呼ばない」と
  名指ししていたにもかかわらず、である。

- **決定**:

  1. `drainEmbedTicks`（と戻り値型 `DrainResult`）を `retrieval-quality.ts`
     から `examples/chat/src/embed-drain.ts` へ切り出した。`retrieval-quality.ts`
     は `./embed-drain.js` から import し、同名で re-export する
     （既存の `retrieval-quality.ts` の振る舞い・公開 API は変えていない）。
  2. `mnemora-path.ts` の `ingestConversation` の末尾を、1回きりの `tick()`
     から `drainEmbedTicks(runtime, ctx)` に差し替えた。これにより
     `ingestConversation` が返った時点で「observe() した分は全件 embed
     済み」であることが保証される（会話の長さに関わらず）。
  3. `ingestConversation` の docstring に、なぜ1回では足りないのかを
     背景ごと書いた（`DEFAULT_TICK_LIMIT` / `claimBatch` の先着順 / ADR 0019 §5
     の実測値を指す形で）。

- **採らなかった案**:

  - **`packages/core` の `DEFAULT_TICK_LIMIT` を上げる、あるいは無くす。**
    却下した。`DEFAULT_TICK_LIMIT` は `tick()` という**単発の呼び出し**に
    対する安全弁であり、「1回の `tick()` にどれだけの仕事を持たせるか」という
    `packages/core` 側の関心事である。これを上げる、あるいは撤廃すると、
    1回の `tick()` が処理する件数に上限が無くなる——バッチ的に大量の
    observe() をまとめて ingest する呼び出し側（`examples/chat` の
    `compare`/`retrieval` がまさにそう）が現れるたびに、`tick()` 1回が
    無制限に長く伸びる方向へ core 側の既定値を動かすことになる。
    **「まとめて取り込んでから干上がるまで処理したい」という要求は
    呼び出し側の都合であり、`packages/core` の `tick()` は「1回で
    ちょうどいい量だけ処理する」という素直な契約のままにしておくのが筋である。**
    干上がるまで回す責任は、まとめて ingest する側（`drainEmbedTicks` を
    呼ぶ側）に置く。

- **引き受ける負債**:

  `ingestConversation` が踏んでいたのと同じ罠を、mnemora を使う実アプリも
  踏みうる。`tick()` の戻り値（`{ processed, failed }`）だけを見ていると、
  「今回の呼び出しで何件処理したか」は分かっても「まだ outbox に残っているか」
  は分からない——`processed` が `limit` と一致していれば「もっとあるかもしれない」
  という**推測**はできるが、`TickResult` はそれを明示的な boolean や残数として
  返していない。この API 人間工学の改善（例: `hasMore` を返す、`drainEmbedTicks`
  相当のヘルパーを `packages/core` 側に用意する等）は**本 PR の範囲外**とする。

  ただし、これは「隠れた不整合」ではない。**`recall()` は取り残された記憶を
  `omitted` に `not_indexed(reason: "pending")` として必ず正直に報告する**
  （ADR 0008）——呼び出し側が `tick()` を干上がるまで回し忘れても、
  `recall()` の結果を見れば「まだ埋め込まれていない記憶がある」ことには
  気づける形になっている。今回 `examples/chat` 自身がその `omitted` を
  読まずに実測結果を要約してしまった（ADR 0019 §5）ことが、この負債の
  実害を裏付けている。

- **歯（この決定を測る歯）**:

  `examples/chat/src/__tests__/mnemora-path.postgres.test.ts` に**2本**の歯を
  置いた。役割が違うので両方残す——1本目は「内部状態」の主張、2本目は
  「振る舞い」の主張である。

  **歯1: 「50件を超える量を ingest しても干上がるまで embed され、pending の
  まま取り残される記憶が無い」**（内部状態の歯）。`buildConversation(60)` で
  user 発話61件（fact 1 + filler 60）を ingest する——`DeterministicLLMProvider`
  は1発話につき必ず1件の Memory を作るため embed ジョブも61件になり、
  `DEFAULT_TICK_LIMIT`(50) を11件超える。

  検査する2点:

  - **(a)** `ingestConversation` → `queryRecall` の結果の `omitted` に
    `{ kind: "not_indexed", reason: "pending" }` が一切現れないこと
    （`result.omitted.find((o) => o.kind === "not_indexed" && o.reason ===
    "pending")` が `undefined` であることを assert）。
  - **(b)** それでも冒頭（turn-0）の事実（`FACT_STATEMENT`、"私の好きな色は
    青です。……"）が `recall()` の `memories` に残っていること
    （digest に "青" を含む要素が存在することを assert）。

  **歯2: 「50件超で置き去りにされていた末尾の発話が、修正後は recall() で
  実際に拾えるようになる」**（振る舞いの歯）。歯1の (a) は
  「`omitted` の中身」という**内部状態**の主張であり、
  「使う側が探している答えが、削られた後にも実際に得られるか」という
  この repo の北極星を**直接**は測っていない。歯1の (b) は振る舞いに
  近いが、下で述べる通り regression を検知できない（turn-0 は常に先着50件
  に入るため）。歯2はこの隙間を埋める——`buildConversation(60)`（fact 1 +
  filler 60 = user発話61件）の末尾に、テスト側で一意な発話を1件足して
  user発話62件（末尾がちょうど62番目）にした会話を ingest し、
  **`runtime.recall(ctx, { text: <その末尾の発話と完全に同じ文字列> })`
  を直接撃って、その記憶が `result.memories` に（実質1位で）現れることを
  assert する**。`scenario.ts` は変更していない（他の測定の再現性の要の
  ため）——末尾の1ターンはテストファイル内の `appendTailUserTurn()` で
  `buildConversation()` の結果に足している。

  歯2が距離0の完全一致に依存できる理由（コードを読んで確認済み）:
  `packages/core/src/extraction.ts` の `observationPayloadText()`/
  `buildExtractionPrompt()` と `packages/testkit/.../deterministic-llm-provider.ts`
  の `completeStructured()` により、`kind: "utterance"` で `text: T` を
  observe すると Memory の `content` は `T` と完全一致する。
  `packages/core/src/runtime.ts` は `embed(ctx, [memory.content])` で
  埋め込み、`DeterministicEmbeddingProvider`
  （`packages/testkit/.../deterministic-embedding-provider.ts`）は同じ
  テキストに常に同じベクトルを返す。⟹ `recall({ text: T })` のクエリ
  ベクトルは `T` の Memory のベクトルと完全一致し、コサイン距離0——
  `packages/postgres/src/vector-store.ts` の ANN 検索は距離の昇順なので、
  候補になれてさえいれば必ず最上位に来る。**擬似 embedding の意味的な
  弱さ（下記 MRR 0.018）に一切依存しない。** 詳細な導出はテストファイル内
  の歯2の docstring 参照。

  **⚠ どちらの歯も実行して確認できていない。** 作業した環境に
  `DATABASE_URL` が無く（PostgreSQL 自体が用意できない）、`examples/chat`
  の DB テストは `requireDatabaseUrl()` が例外を投げて実行できない。以下は
  **実行せずにコードを読んで組み立てた推論**であり、CI（本物の Postgres +
  pgvector がある環境）での実測が要る:

  - **`ingestConversation` の末尾を `drainEmbedTicks(runtime, ctx)` から
    `await runtime.tick(ctx, { kinds: ["embed"] })`（1回だけ）に戻す変異**を
    当てると、歯1の (a) は必ず赤くなるはずである。根拠: `tick()` の
    既定 `limit` は50（`DEFAULT_TICK_LIMIT`）であり、`claimBatch` は
    `available_at ASC` の先着順で claim する。この歯は embed ジョブを
    61件作るため、1回の `tick()` では最初の50件しか処理されず、残り11件が
    `embeddingStatus: "pending"` のまま残る。`recall-runtime.ts` の
    `aggregate.notIndexed.pending.count` はこの11件を数え、`omitted` に
    `{ kind: "not_indexed", reason: "pending", count: 11, ... }` を push する
    （`packages/core/src/recall-runtime.ts` 416-426行）。この歯の (a) の
    assertion（`pendingOmission` が `undefined` であること）は、この要素が
    存在する時点で必ず失敗する。
  - **歯1の (b) はこの変異単体では赤くならない。** turn-0
    （`FACT_STATEMENT`）の embed ジョブは常に最初に enqueue されるため、
    `available_at ASC` の先着順で常に「最初の50件」に含まれる——1回の
    `tick()` でも埋め込まれる。したがって (b) はこの歯の中では regression
    検知の役に立っていない。(b) を残したのは、「pending が無いこと」と
    「目的の記憶は落ちないこと」を同じ会話で確認しておくのが自然だった
    ためであり、**この歯の regression 検知力は (a) 側の assertion 単独に
    依存している**、と明記しておく。
  - **同じ変異を当てると、歯2は必ず赤くなるはずである。** 歯2の会話は
    embed ジョブが62件で、末尾（62番目）はどんな並び方をしても先着50件
    には入らない。1回の `tick()` では末尾の発話が embed されないまま
    `pending` に残り、ベクトルを持たないため ANN 検索に載らない——
    距離0で一致するはずのクエリを撃っても `result.memories` に現れず、
    `tailMemory` の存在 assertion が必ず失敗する。**歯2は、歯1の (b) が
    構造的に持てなかった regression 検知力（末尾を使うことで先着50件に
    絶対入らないという性質）を、同じ会話の形の変奏で埋める。**

  **(b)・歯2 のどちらも、擬似 provider の下で「多様な干し草の中でも
  意味的に正しく引ける」ことの証明ではない。** `docs/decisions/
  0019-real-openai-measurement-cost.md` §7.3 が実測した通り、
  `DeterministicEmbeddingProvider`（文字コードの合計から機械的にベクトルを
  作るだけで意味的な類似度を持たない）は、内容が1件ずつ違う haystack が
  60件並ぶ場面では MRR 0.018 まで落ちる（語彙が重なる対照群ですら圏外になる
  ことがある）。歯1で使った haystack は `scenario.ts` の12種類の filler
  の巡回であり、`probe-set.ts` の「1件ずつ内容が違う」haystack とは異なる
  ——**なぜ巡回する filler だと擬似 embedding でも安定するのかを、
  マネージャーが実際に計算して確かめた**（`DeterministicEmbeddingProvider.vectorFor()`
  は純関数なので、DB もモデルも要らずに手元で再現できる）。
  `QUERY_TEXT`（"ところで、わたしの好きな色を覚えていますか?"）に対する
  コサイン距離は `FACT_STATEMENT` が **0.1719** で、12種類の filler のうち
  **これより近いのは1種類だけ**（`"最近のニュースについてどう思いますか。"` = 0.1333）。
  ⟹ filler が何回巡回しても、事実より前に来るのはその1種類の複製だけであり、
  会話が伸びても事実の順位は緩やかにしか下がらない。実際に数えると:

  | 会話 | embed される件数 | 事実の順位 | 既定 `limit`(10) に入るか |
  |---|---|---|---|
  | `buildConversation(80)`（既存の歯）**修正前** | 50 | 5位 | ✅ |
  | `buildConversation(80)`（既存の歯）**修正後** | 81 | **7位** | ✅ |
  | `buildConversation(60)`（歯1）修正後 | 61 | 6位 | ✅ |

  ⟹ **本 PR は既存の「会話が長くなって……」歯（162ターン）を赤くしない**
  （事実の順位が 5位 → 7位 に下がるだけで、既定 `limit` の10位以内に留まる）。
  **ただし余裕は薄い。**filler をさらに積む変更を入れると事実は10位の外へ出うる
  ——そのとき赤くなるのは擬似 embedding の性質であって mnemora の欠陥ではない、
  という切り分けをこの計算が可能にする。
  **この計算は純関数の再実装に対するものであり、本物の Postgres + pgvector 上の
  実際のクエリで確認したわけではない**（段2の再スコアで decay・freshness・strength も
  掛かるが、同じ ingest 内で作られる Memory 同士は経過時間がミリ秒単位で
  ほぼ等しく、半減期は時間単位であるため similarity が支配的である、という
  前提を置いている——これも実測ではない）。
  歯2はこの弱さを迂回する——「意味的に近い」ことではなく「文字列として
  完全一致するので距離が構造的に0になる」ことだけに依存しているため、
  擬似 embedding の意味的な弱さの影響を受けない。ただし歯2にも別の
  未検証の前提がある: `DeterministicEmbeddingProvider.vectorFor()` が
  文字コードの和を8バケットへ振り分けるだけである以上、理論上は異なる
  文字列が同じベクトルに衝突する可能性はゼロではない（目視で filler 等と
  重複しないことは確認したが、確率的な非衝突の証明はしていない）。
  **一般に「意味的に関連する記憶が正しく上位に来るか」を擬似 provider の下で
  安定して検査することは、この PR の範囲では実現できなかった。**

- **これが覆るとしたら**:

  - `packages/core` 側に「干上がるまで tick する」ヘルパー、あるいは
    `TickResult` に「まだ残っているか」を示すフィールドが追加されたとき
    （上の「引き受ける負債」参照）——そのときは `examples/chat` 側の
    `drainEmbedTicks` はその薄いラッパーに置き換えられる。
  - `extract` を `deferred` に倒す構成が `examples/chat` に入ったとき
    （現状は `extract: 'sync'` が既定であり、抽出自体は observe() の中で
    同期的に終わる。embed だけが outbox 経由の非同期）。

- **確かめていないこと**:

  - **上の「歯」節に書いた通り、変異を当てて実際に赤くなることは確認して
    いない。** 実行できる PostgreSQL 環境が無かったため、コードを読んで
    組み立てた推論にとどまる。CI での実測が要る。
  - **どの実測値がこの修正で無効になるか（マネージャーが現物で切り分けた。
    ⟹ 有料の測り直しは要らない）**:

    | 実測 | スコープ内 Memory | この修正の影響 |
    |---|---|---|
    | `retrieval-quality`（ADR 0019 §7、本物 provider、arm A/B/C） | 74〜76件 | **無し。**このベンチは最初から `drainEmbedTicks` を呼んでいる——本 PR はその関数を共有モジュールへ移しただけで、呼び出しの有無を変えていない |
    | `compare`（ADR 0019 §7、**本物** provider、642ターン） | **数件**（ADR 0019 §4——本物の `gpt-4o-mini` は filler を記憶として抽出しない） | **無し。**`DEFAULT_TICK_LIMIT`(50) に遠く届かないため、1回の `tick()` で元々全件が embed されていた |
    | `compare`（**擬似** provider、642ターン） | **321件** | **有り。**271件が `pending` だった（ADR 0019 §5）。**本 PR が直すのはここである** |

    ⟹ **本 PR で無効になるのは擬似 provider の実測だけであり、それは
    `OPENAI_API_KEY` を必要としない（費用が出ない）。** 本物の API を
    叩き直す必要は無い。ADR 0019 §7 の本物の provider による数値
    （arm 別 MRR・chars の表・実費）は、**この修正の前後で変わらないはずである。**
    ただし「変わらないはず」は上の表からの演繹であり、**測り直して
    確認したわけではない。**
  - **`examples/chat/README.md` の「スコープ内の Memory」表（173〜181行）・
    直前の `omitted` 実測値を、この修正後の挙動で測り直してはいない。**
    README には `TODO(実測)` の形で空欄を残した——CI で実測できる環境が
    このリポジトリに用意され次第、埋めること。
  - **`compare`/`retrieval` 以外の呼び出し側**（`cli.ts` の `chat`
    サブコマンド等）が `ingestConversation` を経由する経路も、同じ修正の
    影響を受けるはずだが、個別に実測してはいない。
