# ADR 0432: recall の段1・連想枠の後置に `status` の再検査を足し、`archiveDecayed` の `reachedLimit` を直し、archived まわりの文書を実装に揃える

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの依頼を受けた委譲先の担い手が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
下の判断（`omitted` に数えない扱い、他の経路を触らないこと、AL-2 を記録だけにしてオーナーへ回すこと、`limit: 0` を断らないこと）は、クローンの判断である（オーナーではない）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  前の巡で、archived まわりの5件（AL-1〜AL-5）が見つかった。

  **(AL-1) archived / forgotten の記憶が recall の `memories` に入る窓。**【現物】段1の `vectorStore.search` は `VectorFilter.status = ["active", "contested"]` を渡すが、これは検索の時点でしか効かない。`search` が返してから `memoryStore.getMany` が今の状態を読むまでのあいだに `sweepArchive`（archived）や `forget`（forgotten）が入ると、後置の再検査（`survivesSubjectFilter`・`survivesAttributesFilter`・`survivesLabelsFilter`・期間・`validAt`・忘却ゲート）は `status` を見ないので、その記憶が残る。連想枠（段3.5）の後置も同じ述語の並びで、同じ穴を持つ。【実測】（前の巡の担い手による）`search` のあとに `sweepArchive` を割り込ませると、両 adapter で `memories` に archived が入り、同じ結果の `omitted` に `filtered(archived)` が1件出た。割り込ませない recall では archived は返らなかった（陽性対照）。

  **(AL-2) `restoreArchived` と `sweepArchive` が重なる窓。**【現物】`restoreArchived` は `updateStatusWithEvent`（archived → active）のあとに、別の書き込みとして `reinforce` を呼ぶ。そのあいだ `decay_floor_at` は過去を指している。【実測】（前の巡の担い手による）この窓に同じ Memory への `sweepArchive` が入ると、結果は `restored` のまま、最終の `status` は archived（イベントは archived → restored → archived）。

  **(AL-3) 文書が、archived は強化すれば戻ると書いている。**【現物】`recall.ts` の `FilteredOmission` の doc と `docs/recall.md` の3箇所が「`archived` は強化すれば戻る可能性がある」と書く。`reinforce` は `status` を動かさないので、戻すのは `restoreArchived` だけである。

  **(AL-4) `reachedLimit` が `limit: 0` で `true` になる。**【現物】`archiveDecayed` の `reachedLimit` は、Postgres（`memory-store.ts`）も testkit のインメモリも `archived.length === opts.limit`。`limit: 0` だと対象が0件でも `true`。`MemoryStore.archiveDecayed` の doc は「対象が0件なら `reachedLimit: false`」と書いている。

  **(AL-5) `docs/memory-model.md` §11 行8 の `<` と、`reextract` の archived の扱い。**【現物】行8は `decay_floor_at < now()` と書くが、実装（doc の契約）は `<=`（境界を含む）。また、archived の記憶を持つ Observation を `reextract` したときの帰結が、どこにも書かれていない（ADR 0028「archived は退けた記憶に数えない」の帰結）。

- **決めたこと**:

  1. **(AL-1) 段1の後置の再検査と連想枠の後置に、`status ∈ {active, contested}` の検査（`survivesStatusGate`）を足した。** 述語は `recall-runtime.ts` に1つだけ置き、2箇所が同じものを呼ぶ（`survivesAttributesFilter` などと同じ「1箇所に述語を置く」規律）。`VectorFilter.status` と同じ集合である。
     - **返す件数が減る方向の直しで、新しい throw は無い。** 落とすだけである。
     - **落とした記憶は、この場では `omitted` に数えない。** 段5の `aggregateScope` が `filtered(archived)`（`countKind: "exact"`）として、scope 内の集合の大きさで数えるので、ここで足すと二重計上になる。これは忘却ゲート（`survivesDecayGate`）の後置が「ここでは数えない」としている規律（ADR 0172 決めたこと3・[ADR 0173](./0173-decayed-omission-counted-by-aggregate-scope.md)）と同じである。【実測】割り込みの recall で、`memories` に archived は入らず、`filtered(archived)` はちょうど1件（段5の分だけ）出た。forgotten は `filtered` の条件として段5が数える対象であり（`forgotten`）、superseded も同様である。forget の割り込みでは `memories` から落ちることだけを縛った（件数は縛っていない）。
     - **ほかの経路の扱い**【現物】:
       - 必須の同伴取得（段3、`fetchMandatoryCompanions`）は、`companionMemory.status === "contested"` を既に見ている（`recall-companion-status-gate.test.ts` が archived・superseded・forgotten の対向で縛っている）。**変更なし。**
       - 関係の探索（`listRelated` のあとの `getMany`）は、`m.status !== "contested"` の門を既に持つ。**変更なし。**
       - 目次帯の digest（`aggregate.digests`）は、adapter の集計が `status` を見た上で返す。core の再検査（`getMany`）は `attributes`/`labels` だけを見る。search と getMany のあいだの窓とは構造が違い、**この窓が在るかは測っていない。触っていない。**
  2. **(AL-2) 文書だけ。** `Runtime.restoreArchived` の TSDoc と `docs/memory-model.md` §11 行14に、sweep と重なると `restored` と返っても archived のままのことがある窓を、記録文で書いた。結果に欄を足す直しも、`status` の復帰と `reinforce` を1つの store 操作にする直しもしていない。オーナーへ回す（下の代替案1・2）。
  3. **(AL-3) 文書だけ。** `recall.ts` の doc と `docs/recall.md` の該当箇所を、「`archived` を戻すには `restoreArchived` を呼ぶ。強化では戻らない」に直した。同じ言い回しが `docs/recall.md` の `filtered` の節にも1箇所あった（依頼の410・533行に加えて）ので、同じ直しを掛けた。
  4. **(AL-4) `reachedLimit` を `opts.limit > 0 && archived.length === opts.limit` にした**（Postgres と testkit のインメモリの両方）。`limit: 0` は断らず、何も掃かずに `{ archived: [], reachedLimit: false }` を返す。`MemoryStore.archiveDecayed` と `ArchiveDecayedResult.reachedLimit` の TSDoc に、この振る舞いと、「`limit: 0` の `false` は『もう無い』とは読めない」ことを書いた。
  5. **(AL-5) 行8の `<` を `<=`（境界を含む）に直した。** `reextract` の帰結は、`Runtime.reextract` の TSDoc と `docs/memory-model.md` の reextract の節に、記録文で足した（内容が同じなら何も起きず archived のまま、`skipped` に `status_not_active`。内容が違えば新しい版が `active` で作られ、古い archived は archived のまま、restore すると新旧が並ぶ）。**書く前に、今の main で成り立つことを両 adapter で走らせて確かめた**（下の測ったこと）。

- **検討した代替案**:

  1. **(AL-2) A案: `RestoreArchivedOutcome` に「復帰のあとに status が変わった」ことを示す欄を足す。** 採らなかった。公開の型を増やす判断はオーナーのものである。`reinforce` の直後に `get` で読み直す追加の往復が要り、それでも読み直しのあとの窓は残る。オーナーへ回した。
  2. **(AL-2) B案: `status` の復帰と `reinforce`（`decay_floor_at` の引き直し）を、store の1つの操作（1トランザクション）にする。** 採らなかった。窓そのものを閉じるが、`MemoryStore` に任意メソッドを足すことになり、adapter の契約と適合テストに波及する。オーナーへ回した。
  3. **(AL-1) 落とした記憶を、後置の場で `omitted` に `filtered(archived)` として数える。** 採らなかった。段5が同じ記憶を数えるので二重計上になる（ADR 0172・0173 の線）。
  4. **(AL-1) 段5の集計を、段1の後に取り直す。** 採らなかった。集計は recall 全体で1回という設計であり、窓は集計の後にも残る。
  5. **(AL-1) 窓を閉じるために、`search` と `getMany` を1つの読み取りトランザクションにする。** 採らなかった。`VectorStore` と `MemoryStore` は別の口であり、同じトランザクションに載せられる保証が無い。core は後置で多層に守る（ADR 0034）。
  6. **(AL-4) `limit: 0` を断る（例外を投げる）。** 採らなかった。Postgres の `LIMIT 0` は通り、Fake も通る。断るのは公開の振る舞いを変える直しで、既存の呼び出し側を壊しうる。`reachedLimit` の意味だけを合わせた。
  7. **(AL-5) `reextract` が archived を戻す、または archived を supersede の対象にする。** 採らなかった。振る舞いの変更で、ADR 0028 の決定（archived は退けた記憶に数えない）を覆すことになる。今の振る舞いを記録するだけにした。

- **引き受けた負債**:

  - **(AL-2) の窓は残っている。** `restored` と返っても archived のままのことがある。呼び出し側が今の `status` を読み直すしかない。
  - **後置の `status` の再検査は、検索のあとの窓を狭めるだけで、閉じない。** `getMany` が今の状態を読んだあとに archived になった記憶は、そのまま返る（返したあとの状態変化は recall の責任の外である）。
  - **落とした件数は、段5の集計が名乗る件数と、後置が実際に落とした件数が一致するとは限らない。** 集計は scope 内の集合の大きさであり、窓の中で archived になった記憶は段5の読みの時点で archived だったかどうかで決まる。測っていない。
  - **(AL-1) の目次帯の digest に status の窓があるかは測っていない。**
  - **`limit: 0` の `reachedLimit: false` は「もう無い」ではない。** 対象が残っていても `false` である。TSDoc に書いた。

- **これが覆るとしたら**:

  - オーナーが (AL-2) の A案か B案を選んだとき。B案なら、`restoreArchived` の TSDoc と memory-model 行14の記録文は「直した」に書き換える。
  - recall の後置で落とした記憶を、呼び出し側が個体単位で知りたいという要求が出たとき（今は段5の件数だけである）。
  - `limit: 0` を断る方針をオーナーが決めたとき（AL-4 は `limit: 0` の扱いを断る側へ変える）。
  - `reextract` が archived を扱う方針（戻す・supersede する）を決めたとき（AL-5 の記録文は書き換える）。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）、ポート 56330。歯を先に commit して赤を見せ、次の commit で直した）:

  - **AL-1**: `packages/core/src/__tests__/recall-status-recheck.test.ts`（core の fake、6本）。直す前は4本赤（段1の archived の割り込み・forget の割り込み、連想枠の archived・forget）、2本（陽性対照）緑。直したあとは6本緑。`packages/postgres/src/__tests__/recall-status-recheck.postgres.test.ts`（testkit のインメモリと Postgres の2 adapter、各5本）。`status` の再検査を外した変異で、両 adapter とも4本ずつ赤（計8本赤）、対照の2本は緑。戻すと10本緑。連想枠の `search` は両 adapter とも `searchMany` 1回に束ねられるので、割り込みは `searchMany` の直後に入れた。
  - **AL-4**: `packages/testkit/src/__tests__/in-memory-fixtures-archive-decayed-limit-zero.test.ts`（3本）と `packages/postgres/src/__tests__/archive-decayed-limit-zero.postgres.test.ts`（3本）。直す前は各2本赤（`limit: 0` で対象あり／対象なし。`reachedLimit: true` が返る）、対照の1本（`limit: 1` で1件掃いて `true`）は緑。直したあとは各3本緑。
  - **AL-5**: `packages/postgres/src/__tests__/reextract-archived-memory.postgres.test.ts`（両 adapter、各2本）。今の main で4本とも緑（内容が同じ: `memoryIds` は既存の記憶そのもの、記憶は1件のまま、archived のまま、`skipped` に `status_not_active`（`status: "archived"`）。内容が違う: 新しい版が `active`、古い版は archived のまま、`restoreArchived` で戻すと新旧が `active` で並ぶ）。これは赤→緑の歯ではなく、今の振る舞いを縛る歯である。
  - 既存の recall・restore-archived・runtime の歯（core の 46 ファイル・608 テスト）が緑であること。
  - **測っていないこと**: AL-2 の窓の再現（前の巡の実測に拠る。この巡では再走していない）。目次帯の digest の窓。`decay_clock` が `activity`/`either` のテナントでの AL-1 の割り込み。
