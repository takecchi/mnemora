# ADR 0420: `consolidate`・`reflect` は、材料が superseded になったときと、統合元がすべて CAS に弾かれたときに打ち切る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

振る舞い（何を打ち切るか）は、依頼元のクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
破壊的変更を v1.X.0 で出してよいことは、オーナーの回答（ask_human `6911db12`）による。
形（outcome の値・store の欄）は、クローンの委譲先が選んだ。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  2026-09-30 の穴探し（R。同じ scope への同時の書き込み）が、読むだけで次の2つを見つけた。
  どちらも「退けた、または重なった記憶が recall に出る」形で、北極星の「間違いを正すと、古いほうが先に出てこなくなる」に直接響く。

  - **R1: 同じ ids の `consolidate` が2本同時に走る。**2本とも eligible を読み、LLM を呼び、統合先を作る。
    後から書く側では、`supersedeWithNewMemories` の CAS に統合元が**すべて**弾かれる（`conflicted` に積まれる）。
    それでも統合先 C2 は commit され、runtime は `outcome: 'consolidated'` を返していた。
    同じ内容の統合記憶が2件 active になる。
    - `runtime.consolidate` の doc が約束していた部分成功は「その1件だけ `status_changed_concurrently`」であり、すべて破れた場合については何も書いていなかった。
    - tick の consolidate ジョブは同じ種を複数積みうるので、実運用でも起こりうる。
  - **R2: `reextract` と `consolidate`（`reflect` も）が同時に走る。**`consolidate` が LLM を待つ間に、`reextract` が統合元 S を X で置き換えて commit する（S は superseded、X は active）。
    それでも、S の古い本文から作った統合先 C が active で commit されていた。
    - forget に対しては、蘇らせないために打ち切ると決めていた（[ADR 0375](./0375-purge-scope-widened.md) 決定7・[ADR 0406](./0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md) の `abortIfForgotten`）。
    - superseded には同じ扱いが無かった。

- **決めたこと**:

  1. **superseded への打ち切り（R2）。**`consolidate` と `reflect` は、forget への打ち切りと同じ2か所で、材料が `superseded` になっていないかも見る。1件でも superseded なら、何も書かずに打ち切る。
     - 1か所目は、LLM 呼び出しの直後の読み直しである。
     - 2か所目は、store の書き込みのトランザクションの中である。新しい欄 `opts.abortIfSuperseded` に eligible の id を渡す。
     - この欄は `createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents?`・`supersedeWithNewMemories?` に足した。
     - `@mnemora/postgres` は、`abortIfForgotten` と同じ `SELECT … ORDER BY id ASC FOR UPDATE` の行ロックの下で見る。
  2. **統合元がすべて CAS に弾かれたときの打ち切り（R1）。**`supersedeWithNewMemories?` に `opts.abortIfAllConflicted: true` を足した。`supersede` の対象が1件以上あり、それが**すべて** CAS に弾かれたら、`news`・`created` イベントごとトランザクションを巻き戻して例外を投げる。
     - LLM 呼び出しの直後の読み直しでも、eligible のすべてが `active` でなくなっていたら打ち切る。
     - **1件でも CAS を通れば、今までどおりの部分成功**である（弾かれた要素だけ `status_changed_concurrently`）。
  3. **store が投げる例外は、新しい `SourceMemoryStatusChangedError` にした。**`kind` は `source_memory_status_changed`、判定関数は `isSourceMemoryStatusChangedError` である（[ADR 0418](./0418-store-error-kind-guards.md) の作法）。
     - 欄 `changed` には、弾いた id と、そのとき見えた `status` が入る。
     - `SourceMemoryForgottenError` を再利用しなかったのは、`forgotten` と名乗るのが事実と違うからである（`MemoryPurgeConflictError` が `MemoryStatusConflictError` を再利用しなかったのと同じ理由）。
     - forgotten と superseded の両方に当たるときは、`abortIfForgotten` の見直しが先で、`SourceMemoryForgottenError` になる。
  4. **結果の形。**`ConsolidateOutcome` と `ReflectOutcome` に `"aborted_source_status_changed"` を足した。`aborted_source_forgotten` を superseded・全件 CAS 弾かれにも広げたもので、形もそれに揃えている。
     - `consolidate` の要素は、動いていたものが `status_changed_concurrently`（`observedStatus` 付き）になる。残りは `not_attempted` で、`atomicity` は `not_attempted` である。
     - `reflect` の材料は、動いていたものが新しい `"status_changed_before_write"`（`observedStatus` 付き）になる。残りは `eligible` のままである。
     - `llmCalls` は 1 である。
     - 新しい値にしたのは、呼び出し側が `aborted_source_forgotten`（削除要請に由来する）と区別できるようにするためである。
  5. **範囲。**
     - 入れたもの：`consolidate` と `reflect`（材料を読んでから LLM を待ち、そのあとで書くもの）。
     - 入れていないもの：`reextract`。`reextract` の `supersedeWithNewMemories` には `abortIfAllConflicted` も `abortIfSuperseded` も渡さない。
     - `reflect` には、R1 に当たる形が無い。既存の行へ書かないので、CAS が無い。したがって `abortIfAllConflicted` も無い。
  6. **`packages/testkit` の `InMemoryMemoryStore` も、`abortIfSuperseded` と `abortIfAllConflicted` を実装する。**同期区間なので、窓は無い。
     - `abortIfForgotten` は、これまでどおり実装しない（ADR 0406 の判断を変えない）。
     - 実装しない第三者の adapter は、渡されても無視してよい（任意の欄）。その場合、保護は runtime の読み直しだけになる（残る窓がある）。

- **検討した代替案**:

  - **部分成功のまま、doc にすべて破れる場合を書き足す。**
    - 採らなかった理由：同じ内容の統合記憶が2件 active になり、recall に重複して出る。依頼元が「部分成功の約束の外」と判断した。
  - **巻き戻さずに、後から統合先を superseded や forgotten にする（補償の書き込み）。**
    - 採らなかった理由：一度 active で commit したものは、その間に recall や embed ジョブに見える。書き込みも増える。トランザクションを持つ口では、巻き戻すほうが単純で、窓も無い。
  - **`SourceMemoryForgottenError` と `aborted_source_forgotten` を広げて使う。**
    - 採らなかった理由：決めたこと 3・4 のとおり、名前が事実と違い、呼び出し側が削除要請と区別できなくなる。
  - **`reextract` にも同じ打ち切りを入れる。**
    - 範囲外とした。`reextract` × `reextract` と、`reextract` × tick の抽出の二重は、[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) の既知の負債と同じ穴で、依頼元が別に預かっている（候補 R5）。

- **引き受けた負債**:

  - **2段の経路が残す窓。**`supersedeWithNewMemories?` を実装しない adapter の2段の経路（統合先を書いてから、1件ずつ CAS する）では、手順5の直後の読み直しより後に全件が破れても打ち切れない。統合先は残る。トランザクションが無いので、巻き戻せない。
  - **`abortIfAllConflicted` は `supersedeWithNewMemories?` の新しい任意の欄である。**第三者の adapter が実装しなければ、R1 の store 側の窓（読み直しの後、書き込みの前）は残る。
  - **conformance には `it` を足していない。**この欄を守ることは、Postgres と fixture の歯（`consolidate-reflect-superseded-race.postgres.test.ts`）でだけ縛っている。任意の欄なので、conformance で課すと破壊的変更になる。
  - **振る舞いが変わる入力がある。**今まで `"consolidated"` / `"reflected"` で返っていた入力が、`"aborted_source_status_changed"` で返り、統合先・内省が作られなくなる。破壊的変更として数えた（`docs/migration-v1.md` 項目42）。

- **これが覆るとしたら**:

  - オーナーが「全件弾かれでも部分成功のまま」を選ぶなら、runtime が `abortIfAllConflicted` を渡すのをやめ、読み直しの全件チェックを外せば戻る。store の欄は残してよい。
  - superseded の打ち切りを外すなら、`abortIfSuperseded` を渡すのをやめる。

- **測ったこと**:

  歯は `packages/postgres/src/__tests__/consolidate-reflect-superseded-race.postgres.test.ts` の28本である。Postgres と testkit の fixture の両方で走り、LLM の中で別の操作を先に commit させる差し込みで競合を作る。

  - **赤：**PR #1523 の最初の commit（`7d92a216`）の CI で、R1・R2 の6本が、Postgres と fixture の両方で赤になった（計12本）。
    - その後に足した it（口の無い adapter の経路、全件 archived、部分成功の対照）も含めて、今の歯のファイルを直す前の実装に当てた。**26本が赤、2本が緑**だった。緑の2本は、部分成功が今どおりであることの対照である。
  - **緑：**直した後は28本すべて緑。forget の既存の歯（`consolidate-reflect-forget-race`・`consolidate-reflect-source-forgotten-for-update-race`）も緑のままである。
  - **変異試験**（手元の Postgres 17 + pgvector。戻すと28本すべて緑に戻る）:
    - 両 store の `abortIfAllConflicted` の throw を外すと、2本が赤。
    - 両 store の `abortIfSuperseded` の見直しを外すと、8本が赤。
    - runtime の LLM 直後の superseded の読み直し（consolidate・reflect）を外すと、8本が赤。
