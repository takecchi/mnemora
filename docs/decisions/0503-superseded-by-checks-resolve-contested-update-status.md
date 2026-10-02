# ADR 0503: `supersededById` の約束を壊す入力を断る（`resolveContestedPair`・`resolveContestedGroup`・`updateStatus`・`updateStatusWithEvent`）

- **状態**: 採用 (2026-10)（⚠ 下書き。Postgres 側の実装は [PR #1610](https://github.com/takecchi/mnemora/pull/1610)〔ADR 0499〕のマージ後。「測ったこと」の【未】を見ること）
- **日付**: 2026-10-02

クローン miku の決定（2026-10-02）。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**前提**: [ADR 0499](./0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md) と同じ。「型の中でも約束を壊す入力を新しく断る直しは、クローンの線の内側」と読んだ。**この読みがずれていれば、「これが覆るとしたら」から戻せる。**
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17）や名指しのテストで走らせた結果、【判断】は担い手の判定。

- **文脈**: [ADR 0447](./0447-lifecycle-operation-state-matrix-round23.md) の材料3〜5と [ADR 0450](./0450-contested-group-operation-state-matrix-round26.md) の材料1・2が、直されないまま残っていた。どれも `MemoryStore` を直接呼んだときだけ起きる（`Runtime` は常に勝者を渡す）。型は通るが、置き換えた側（`supersededById`）の約束を壊す。

  1. `resolveContestedPair`・`resolveContestedGroup` が `status: "superseded"` に `supersededById` を付けずに通る → `superseded_by_id = NULL` の敗者ができ、`restoreSuperseded`（置き換えた側で群を引く）の対象に入らず戻せない。
  2. `supersededById` に自分自身（自己置換）、2者版で互いを指す（循環）、群版で群の外の `forgotten` な記憶を指す、`active` のメンバーに `supersededById` を付ける、が通る。
  3. `updateStatus(T, "superseded", { supersededById: T })`（自己）と `updateStatus(T, "superseded")`（省略）が通る。`updateStatusWithEvent` も同じ口（【現物】`opts.supersededById` は任意）。

- **決めたこと**:
  1. **書く前に `RangeError` で断る。** 値は message に入れない。新しい例外クラス・公開 API は足していない。message は2実装（Postgres・testkit の InMemory）で同じ。
     - `status: "superseded"` なのに `supersededById` が無い: `<口>: <欄>.supersededById is required when status is "superseded"`（欄は `first`・`second`・`members[i]`・`opts`）。
     - 自己置換: `<口>: <欄>.supersededById must not be the memory itself`。
     - `resolveContested*` で `status: "active"` に `supersededById`: `<口>: <欄>.supersededById must not be set unless status is "superseded"`。
     - 循環（同じ呼び出しで `superseded` になるメンバーの `supersededById` の鎖が輪になる。2者の互い、群の A→B→A など）: `<口>: supersededById must not form a cycle among the members`。
     - 群で、群の外の `forgotten` な記憶を指す: `resolveContestedGroup: members[i].supersededById must not be a forgotten memory outside the group`。
  2. **位置**: 形だけで決まる検査（欠落・自己・active への付与・循環）は、`status` の範囲の検査（ADR 0499）のあと、id の存在確認・CAS より前。`updateStatus*` では `contested` の検査のあと、対象の存在確認より前。群の外の `forgotten` は状態を読むので、テナントの照合（ADR 0439）のあと、書く前。
  3. **自己置換は id の大文字小文字を畳んで比べる**（Postgres の入口は uuid を小文字に畳む。【未】実装済みの Postgres 側で確かめる）。InMemory は綴りどおり。
  4. **正当な用途は断らない**（陽性対照を歯にした）: 勝者を指す `superseded`、`both_active`、群の外の `active` な記憶を指す `superseded`（2者版・群版）、群のメンバーが別のメンバーに置き換えられる鎖（輪にならない限り）、`updateStatus*` で別の記憶を指す `superseded`、`supersededById` なしの `superseded` 以外の status。
  5. **「群の外の `forgotten` を指す」を断ってよいかを確かめた**【判断】: TSDoc（`resolveContestedGroup` の契約・`restoreSuperseded` の doc）に、書き込み時に `forgotten` な記憶を置き換えた側にする用途は書かれていない。`restoreSuperseded` が「置き換えた側が `forgotten` でも群を戻す」のは、書いたあとで置き換えた側が忘れられた場合の話で、この検査（書く時点で既に `forgotten`）とは別。ADR 0150・0381・0421 にも、`forgotten` を勝者にする記述は無い。正当な用途は見つからなかったので断る。**群の外の `archived`・`superseded`・`contested` を指すのは、断らない**（依頼の範囲外。置き換え先がそれらのとき、それは正当かもしれない）。
  6. **`Runtime` が常に正しく渡していることを確かめた**【現物】:
     - `resolveContested`（`runtime.ts`）: 勝者側は `supersededById` なしの `active`、敗者は `supersededById: resolution.winnerId`（`firstId`・`secondId` のどちらか、同じ呼び出しで `contested` を確かめた側）。`both_active` は両方 `active`・付与なし。自己置換・循環は `firstId !== secondId` と勝者の検査で起きない。
     - `resolveContestedGroup`: 敗者は `supersededById: winnerId!`（群の一員で、`active` になる側）、勝者・`both_active` は付与なし。
     - `updateStatusWithEvent` の呼び出しは4か所。`superseded` を書くのは2か所（`reextract`〔`supersededById` は今回の抽出の新しい行の先頭。ADR 0454〕、`consolidate`〔`consolidatedMemory.id`、統合先の行〕）で、どちらも渡している。自己置換になる経路は見つからなかった。**【未確認】** 冪等な作成が既存の行を返したとき（`created: false`）、その行が `reextract` の `toSupersede`・`consolidate` の統合元と一致しうるかは、追っていない。一致すれば自己置換になり、断られる（その場合は `Runtime` の別の不具合である）。残りは `active`（`restoreArchived`）・`forgotten`（`forget`）で、`superseded` ではない。
     - **`Runtime` が省略している経路は見つからなかった。**よって `Runtime` 経由の挙動は変わらない。
  7. **除外**: `event.memoryId` が別の記憶を指す件（[ADR 0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md) M6・ADR 0450 材料4）は触らない。
  8. **既存の歯の更新**: 次は、`superseded` を置き換えた側なしで書いていた、または自己置換していた。意図は CAS・対象が無い・並行の検査で、`supersededById` ではなかったので、別の記憶を指すよう直した（期待は変えていない）。`memory-store-conformance.ts` の `updateStatus*` の CAS・存在確認の歯（勝者を1件作って渡す。**`it` は足していない**）と `resolveContestedPair` の「片方が contested でない」の下ごしらえ、`in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts`・`memory-store-tsdoc-edges-round3.postgres.test.ts`、`memory-store-update-status-concurrency.test.ts`・`memory-store-update-status-with-event-transaction.test.ts`（自己置換していた）。
  9. **歯は各パッケージの `__tests__` に置き、conformance suite には足さない**: `packages/postgres/src/__tests__/store-superseded-by-checks.postgres.test.ts`（同じ入力を InMemory と Postgres に流す）と `packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts`（DB 無し）。

- **採らなかった案**:
  - **conformance suite に約束として足す**: 禁止（歯は各パッケージ）。第三者の adapter に新しい約束を課すのはオーナーの判断。
  - **`updateStatus(T, "active", { supersededById })` や `archived` への付与も断る**: 依頼の範囲外。`active` に戻すとき `superseded_by_id` を `COALESCE` で残す既存の振る舞いに触れる。手を付けていない。
  - **循環を、群で「鎖が `superseded` のメンバーに当たること」全般として断る**: A→B→C（B も C も `superseded`）の輪にならない鎖まで断る。やりすぎ。輪だけを断る。
  - **群の外の `forgotten` に加えて、群の外の `superseded`・`archived` も断る**: 上の5。
  - **2者版にも「群の外の `forgotten` を指す」を足す**: 依頼は群版のみ。2者版の `supersededById` は、`Runtime` が常に対の片方を渡す。**断っていない**（引き受けた負債）。
  - **検査を CAS・存在確認のあとへ置く**（既存の歯の期待を動かさないため）: Postgres は条件付き UPDATE が0行だったときの切り分けにしか読み直しの場が無く、2実装で例外の優先順位が割れる。形だけの検査は DB に触れる前に置くほうが単純で、「書く前に断る」にも合う。代わりに既存の歯を直した（上の8）。

- **引き受けた負債**:
  - **2者版は、群の外の `forgotten` を指す `supersededById` を断らない。** Runtime 経由では起きない。
  - **`updateStatus*` は、`superseded` 以外の status への `supersededById`、`forgotten` な記憶を指す `supersededById` を断らない。**
  - **例外が `RangeError`（programmer error）で、状態が理由の「群の外の `forgotten`」も同じ型にした。** 専用の型は足していない（オーナーの領分）。
  - **`supersedeWithNewMemories` の `supersede[]` は、`supersededById` を自分で解決するアンカーから埋める**（【現物】呼び出し側が渡す値ではない）ので、この ADR の対象外。
  - **core の `FakeMemoryStore`（`packages/core/src/__tests__/runtime-fakes.ts`）は揃えていない。**
  - **他の第三者 adapter は、この断りを持たない。** conformance に足していないので、適合テストは検査しない。

- **これが覆るとしたら**:
  - 「型の中でも約束を壊す入力を新しく断るのはクローンの線の内側」が撤回されれば、全体が戻す対象になる。
  - 「群の外の `forgotten` を置き換えた側にする」正当な用途が見つかれば（例: 置き換えた側が、書く時点で既に忘れられていることを許す運用）、その1項目だけ外す。
  - `Runtime` が `supersededById` を省略する経路を足す設計変更があれば、その経路は断られて壊れる。

- **測ったこと**（【実測】。手元の PostgreSQL 17。件数は書かない）:
  - **testkit の InMemory（DB 無し）**: 歯を書いてから直した。直す前は新しい歯がすべて赤（陽性対照は緑）、直した後はすべて緑。変異（InMemory）: 循環の検査を外す → 循環の2件が赤。群の外の `forgotten` の検査を外す → その1件が赤。自己置換の検査を外す → 自己置換の4件が赤。欠落の検査を外す → 欠落の4件が赤。`active` への付与の検査を外す → 2件が赤。**やりすぎ**: 群の外の記憶を何でも断る → 陽性対照が赤、循環の検査が鎖の1歩目から断る → 陽性対照が赤。戻して緑。
  - **Postgres の歯**（InMemory と同じ入力）: 実装の前の赤を実測した。**【未】Postgres の実装（#1610 のマージ後）と、その変異・既存の歯への影響は、まだ測っていない。**
  - 既存の歯への影響: testkit の `in-memory-fixtures.conformance.test.ts`・InMemory を使う名指しの歯を走らせ、赤になった conformance の `updateStatus*` の歯と tsdoc-edges の歯を直した（上の8）。Postgres 側の既存の歯（`store-boundary-diff` の `updateStatus(self,superseded,{supersededById:self})` など）は、実装後に走らせる。
