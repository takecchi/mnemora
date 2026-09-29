# ADR 0380: `reextract` は、版を跨いで退けた記憶を見る——`MemoryStore.listBySourceObservationAllVersions` を新設する

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1432](https://github.com/takecchi/mnemora/issues/1432)（クローン miku の委譲先が実測して起票、
  直していない）は、2026-09-28 の変更（Issue #1079・#1149、`Runtime.reextract` が「利用者の意思で
  退けた記憶を持つ Observation では抽出をやり直さない」）に、版を跨ぐと効かなくなる欠陥があることを
  示した。

  `listWithdrawnBySourceObservation`（`packages/core/src/runtime.ts:4146` 付近）は
  `MemoryStore.listBySourceObservation(ctx, observationId, extractorVersion)` を経由して
  **今の runtime インスタンスが固定した `extractorVersion` に一致する Memory だけ**を見る
  ——これは `listBySourceObservation` 自体の契約（Issue #873、ADR 0028 決定1）であり、変えていない。

  ⟹ `extractorVersion` を上げた別の runtime インスタンスで同じ Observation を reextract すると、
  前の版で `forget`（あるいは forget → purge）・`contested`（訂正でも claimKey の自動検出でも）にした
  記憶が一切見えず、退けたはずの内容と同じ意味の Memory が印の無い新しい `active` として書き直される
  （実測、Fake・Postgres 双方。Issue #1432 本文の表）。forget の約束
  （「利用者の意思で退けたものは戻ってこない」）が、版を上げる操作だけで効かなくなる。

  Issue #1432 は3つの案を挙げた:

  1. **版を跨いで退けたものを探す。** `MemoryStore` に「版を問わない」読み口を足す。いちばん小さい
     変更だが、port の署名が変わる。
  2. **Observation の側に「利用者が退けた」印を持たせる。** スキーマ変更（マイグレーション）と
     「Observation は追記専用」という既存原則との整理が要る。
  3. **今の振る舞いを約束として明記する。** コードは変えないが、forget の約束が版を跨ぐと弱まることを
     利用者に強いる。

  オーナー代理（クローン miku）は方向1を採ると決定した。本 ADR はその実装を確定する。

- **決めたこと**:

  1. **`MemoryStore` に必須メソッド
     `listBySourceObservationAllVersions(ctx, observationId): Promise<Memory[]>` を新設する。**
     ある Observation から作られた Memory を、`extractorVersion` を**問わず**列挙する
     （**SELECT のみ**。マイグレーション・索引は追加しない）。`status` でも絞らない。**既存の
     `listBySourceObservation` は1行も変えない**——#873・ADR 0028 決定1・conformance の既存5本は
     そのまま有効。`packages/postgres`（`PostgresMemoryStore`）・`packages/testkit`
     （`InMemoryMemoryStore`）・`packages/core` のテスト専用 `FakeMemoryStore`
     （`packages/core/src/__tests__/runtime-fakes.ts`）の3実装すべてに実装する。

  2. **`listWithdrawnBySourceObservation`（`Runtime.reextract` の内部）は新しい口を使い、
     版を問わず退けたものを数える。** 数えるものは2026-09-28 の決定と同じ:
     `forgotten`（purge を含む）・`contested`（訂正でも claimKey でも）・訂正の解決で負けた
     `superseded`（最新の `superseded` イベントの `meta.reason === "contested_resolved"`）。
     機構（reextract・consolidate）で置き換えた `superseded` と、理由を読めない `superseded`
     は今どおり数えない。

  3. **打ち切ったときの戻り値は、同じ版の経路（#1079・#1149、ADR 0028 の2026-09-28追記）と揃える。**
     `extraction: "skipped"`、`atomicity: "not_attempted"`、`memoryIds: []`、
     `supersededMemoryIds: []`、`skipped` に退けた記憶ごとの `status_not_active`。**`skipped` に
     版の欄は足さない**——`memoryId` から `MemoryStore.get` で版をたどれるため、冗長な情報を
     公開の型に持ち込まない。

  4. **版を跨いでも、1件でも退けたものがあれば、その Observation の抽出全体を打ち切る**
     （同じ版のときと同じ規律。同じ Observation の他の、退けていない `active` な事実も作り直さない）。
     **版を跨いだ `active` の扱い（#873「運用側の責務」）は変えない**——supersede 対象の判定
     （`existingBefore`、`reextract` 本体）は今どおり
     `listBySourceObservation(ctx, observationId, extractorVersion)`（**今の**
     `extractorVersion` 限定）のままであり、退けたものが無い Observation では、今どおり新しい版で
     抽出され、旧い版の `active` は supersede されない。

     **帰結**: 版を上げても、退けたものを含む Observation は新しい版の記憶を1件も作らない。⟹
     運用側が旧い版の記憶を forget すると、その Observation のほかの（退けていない）事実も、
     以後の reextract では想起から作られなくなる。**運用側が見分ける手がかり**: `skipped` に
     `status_not_active` が出た Observation では、旧い版の記憶を残すこと（forget を早まらない
     こと）。この帰結は `docs/memory-model.md`（本 ADR へのリンク）と、`Runtime.reextract` の
     TSDoc に明記した。

  5. **費用の歯（ANALYZE を出すもの）は足さない。** 既存の一意索引
     `uq_memories_extraction (tenant_id, source_observation_id, extractor_version, content_hash)`
     は `(tenant_id, source_observation_id)` の前方一致だけでも Index Scan に使える——版で
     絞り込む・込まないは索引の使い方を変えない。実測（下の「EXPLAIN の実測」）で確認した。

- **検討した代替案**:

  1. **sentinel（例: `extractorVersion: undefined` を渡すと絞り込まない）にする案。** ⛔
     採らなかった——`listBySourceObservation` は既に `extractorVersion: null` を
     「`extractor_version IS NULL` の行」という意味で使っている（`NULLS NOT DISTINCT` と同じ規約）。
     `undefined` を「絞り込まない」という3つ目の意味に割り当てると、`null`/`undefined` を
     JavaScript の呼び出し側が混同しやすい1つの引数に3値の意味を詰め込むことになり、
     型で防げない誤用（`extractorVersion` を渡し忘れて全件返る）を生む。別のメソッドに分けた
     ほうが、呼び出し側の意図が型シグネチャに出る。
  2. **`listBySourceObservationAllVersions` を任意メソッド（`?`）にする案。** ⛔ 採らなかった
     ——任意にすると、実装しない adapter では `Runtime.reextract` が版を跨いだ退けた記憶を
     見落とし続ける。Issue #1432 が直そうとしている欠陥そのものが、任意メソッドを実装しない
     adapter に残る。この欠陥は「新しい独立した能力」（PR #524/PR #526、ADR 0237 の前例が任意に
     している類のもの）ではなく、既存の `reextract` の契約が最初から意図していた振る舞い
     （forget は効く）の欠落であり、必須にすべきと判断した。
  3. **Observation の側に「利用者が退けた」印を持たせる案（Issue #1432 の案2）。** ⛔
     採らなかった——スキーマ変更（マイグレーション）が要り、「Observation は追記専用」という
     既存原則（Issue #1207 の論点と重なる）との整理も要る。今回の欠陥は「Memory 側の情報を
     版で絞りすぎている」ことが原因であり、Memory 側の読み口を直すだけで閉じられる。
  4. **今の振る舞いを約束として明記するだけに留める案（Issue #1432 の案3）。** ⛔ 採らなかった
     ——forget の約束が版を上げる操作だけで効かなくなるのは、利用者から見て直感に反する
     退行であり、オーナー代理は「直すに値する」と判断した（決定は上の「文脈」に記載）。
  5. **`reextract()` に `extractorVersion` を引数として渡せるようにする案。** ⛔ 採らなかった
     ——ADR 0028 の2026-09-26追記が既に却下している（「1メソッドの呼び出しだけ別の版を
     使わせると、その runtime が以後作る他の Memory の版と食い違う状態を作りうる」）。
     本 ADR はこの却下を変えない——`listWithdrawnBySourceObservation` の**判定**だけを
     版を問わないものに直し、`reextract` 自体が作る Memory の版（`this.extractorVersion`）は
     変えていない。

- **引き受けた負債**:

  1. **判定のために、`superseded` の記憶1件ごとに `EventStore.list` を1回読む——版を跨ぐと、
     この対象が増えうる。** 同じ Observation から複数の版で `superseded` の記憶が作られている
     場合、版の数だけ読みが増える。2026-09-28 の決定が既に引き受けていた費用と同じ性質で、
     悪化の程度は「その Observation に対して reextract を呼んだ版の数」に比例する。
  2. **`listBySourceObservationAllVersions` は `status` で絞らない全件を返す**——長期間
     `reextract` を繰り返した Observation では、返る Memory の件数が版の数だけ積み上がる
     （supersede されずに `active` のまま残る旧い版のぶん、#873「運用側の責務」）。判定側
     （`listWithdrawnBySourceObservation`）はこの全件を JS 側でフィルタするため、件数に
     比例して費用が増える。今回は8000行未満の想定（Observation あたりの抽出のやり直し回数は
     通常小さい）で許容したが、上限を設ける対応はしていない。

- **これが覆るとしたら**:

  - Observation 側に印を持たせる案（採らなかった案3）が、Issue #1207 の「追記専用」原則の
    見直しとあわせてオーナーから求められたとき。
  - 1つの Observation に対して `reextract` を極端に多い版で繰り返す運用が実際に生じ、
    上の「引き受けた負債」2の件数の積み上がりが無視できない費用になったとき——`status` で
    絞る新しい索引、または版の上限を設ける対応が要る。

- **EXPLAIN の実測**（2026-09-30、自分専用の使い捨て Postgres インスタンス。ローカルソケット
  接続。単一テナント、20,000 Observation × 5 Memory/Observation = 100,000 行、
  `extractor_version` は `v1`/`v2`/`v3` を均等に混在、`status` は `forgotten` 5%・
  `contested` 3%・残り `active`。`ANALYZE` 実行済み）:

  | クエリ | 実行計画 | `Buffers` | `Execution Time` |
  |---|---|---|---|
  | `listBySourceObservation`（版指定 `v1`。`Index Cond` 2列 + `Filter` で版を絞る） | `Index Scan using uq_memories_extraction` | shared hit=4 | 0.101 ms |
  | `listBySourceObservationAllVersions`（版なし。`Index Cond` 2列のみ） | `Index Scan using uq_memories_extraction` | shared hit=4 | 0.129 ms |
  | 参考: 版なし + `status IN ('forgotten','contested','superseded')` で絞った場合 | `Index Scan using uq_memories_extraction` | shared hit=4 | 0.091 ms |

  3クエリとも同じ索引 `uq_memories_extraction (tenant_id, source_observation_id,
  extractor_version, content_hash)` を `(tenant_id, source_observation_id)` の前方一致で
  `Index Scan` に使っており、`Seq Scan` へ倒れない。版で絞る・絞らないは実行計画の種類を
  変えず、`Buffers`（shared hit）も同じ——版の有無で追加の索引・ANALYZE は要らないと
  確認できた。⚠ この実測は1テナント・1索引構成・ローカルソケット接続に限る（下の
  「確かめていないこと」参照）。

- **破壊的変更として数える理由**:

  `MemoryStore` は公開 interface（`@mnemora/core` が export）であり、`listBySourceObservation`
  等の既存メソッドと同じ並びに **必須**メソッドを追加する。自前で `MemoryStore` を実装している
  第三者は、このメソッドを実装しないとその実装が interface を満たさなくなり、型検査が
  通らない（`docs/migration-v1.md`「破壊的変更」の定義——公開の型の必須化——に当たる、
  項目12「`Runtime` に必須メソッド `restoreSuperseded` が増えた」等の前例と同じ扱い）。
  任意メソッドにしなかった理由は上の「検討した代替案」2のとおり。

- **確かめたこと（赤の証拠・変異試験）**:

  **赤の証拠**（`git checkout origin/main -- <path>` は使わず、`origin/main` から切った
  使い捨て worktree に、本 PR が追加した
  `packages/postgres/src/__tests__/reextract-withdrawn-memories.postgres.test.ts` の
  拡張分（cross-version の7 it × 2 kit = 14）だけを `cp` でコピーして実行した。実装ファイルは
  worktree のまま——`origin/main` 時点の旧実装）:

  | テストファイル | 使い捨て worktree での結果（旧実装） |
  |---|---|
  | `packages/postgres/src/__tests__/reextract-withdrawn-memories.postgres.test.ts`（cross-version 追加分、2 kit × 6 it） | 12 failed（forget/purge/contested_correction/contested_claim_key/resolved の5形 + 「隣の事実」1本、testkit の InMemory・Postgres 双方） |
  | 同ファイルの既存分（2026-09-28 決定、同一版のみ。18 it） | 18 passed（旧実装でも同一版の判定はそのまま通る——本 ADR が壊していないことの確認でもある） |

  `listBySourceObservationAllVersions` 自体の conformance（新設5本、
  `packages/testkit/src/memory-store-conformance.ts`）は、**この使い捨て worktree には
  当てていない**——`origin/main` 時点の `MemoryStore` interface にこのメソッド自体が無く、
  型検査の時点で通らない（インターフェースの必須メソッドをそもそも実装できない旧コードに
  対して「新設したメソッドの契約が赤になる」という主張はできないため）。この5本の green は、
  本 PR の実装（3 adapter × 5 テスト = 15 assertion 相当）を持つ worktree で確認した。

  **変異試験**（実装ファイルを持つ worktree で一度 green を確認した後、
  `packages/core/src/runtime.ts` の `listWithdrawnBySourceObservation` を、新しい口
  `listBySourceObservationAllVersions` から旧い口
  `listBySourceObservation(ctx, observationId, extractorVersion)` へ1行だけ戻し、
  対応する歯だけが赤くなることを確認、元に戻して green に戻ることを確認した）:

  | 壊し方 | 赤くなった歯 | 他の歯 |
  |---|---|---|
  | `listWithdrawnBySourceObservation` の呼び出しを `listBySourceObservationAllVersions(ctx, observationId)` → `listBySourceObservation(ctx, observationId, extractorVersion)` に戻す | cross-version の12 it（forget/purge/contested_correction/contested_claim_key/resolved の5形 + 隣の事実、testkit の InMemory・Postgres 双方） | 20 passed（同一版の既存18 it + none 1 it × 2 kit のうち残り。cross-version の "none" は元々今どおり抽出する形なので影響を受けない） |

  復元後、`diff` で元ファイルと完全一致することを確認した。

- **確かめていないこと**:

  - 並行下での `listBySourceObservationAllVersions` の一貫性（読みそのものは SELECT のみで
    書き込みを伴わないため、他の書き込みとの直接の競合は無いはずだが、専用の並行の歯は
    本 PR に含めていない）。
  - 1つの Observation に対して `reextract` を10版・20版と繰り返した極端なケースでの実測
    ——上の「引き受けた負債」2の費用の積み上がりは、測っていない。
  - `packages/testkit` の `InMemoryMemoryStore`・`packages/core` の `FakeMemoryStore` に
    ついての EXPLAIN 相当の費用測定——どちらも索引を持たないインメモリ実装であり、
    Postgres の実行計画の議論はそのまま当てはまらない。
  - 本番相当のネットワーク越しの Postgres（自分専用インスタンス、ローカルソケット接続での
    実測である）。
