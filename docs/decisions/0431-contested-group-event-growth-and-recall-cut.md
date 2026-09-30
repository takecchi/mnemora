# ADR 0431: 群（`markContestedGroup`）の監査イベントの増え方を N の線形にし、段4の `cut` の求め方を O(n²) から O(n) にする

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方（下の決めたこと）はクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**K の値（10）と「切った」印の形（`memberCount`・`memberIdsTruncated`・`matchesTruncated`）は、この ADR を書いた担い手が決めた。**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。

- **文脈**:

  穴探し10巡目で、次の2つが確定した。どちらも実測している。

  1. **群の監査イベントの増え方**。`observe({ claimKey: { detectContested: true } })` が3件以上の群を結ぶと、`Runtime.markContestedGroup` は群の全メンバーに `updated`（`meta.reason: "contested"`）を1件ずつ積んでいた。既に群の一員で状態が変わらないメンバーにも積む。
     各イベントの `meta.note`（JSON 文字列。`runtime.ts` の `detectClaimKeyContested` が組む）には、`memberIds` の全員と、`matches` の全員の要約（`describeSide`）が入っていた。
     1回の呼び出しで、イベント N 件 × note の長さ O(N) で O(N²) バイト。同じ claim key・有効期間 null の発話を N 件積み上げると、イベントは約 N²/2 件、バイト数は O(N³) になる。
     インメモリで N=40 は 859 件・4.3MB、N=80 は 3319 件・32.8MB。Postgres では群が800件のとき1回の呼び出しが 22.5 秒（いずれもマネージャーからの依頼文に書かれた実測で、この ADR の担い手は Postgres の N=800 を測り直していない）。
  2. **段4（予算による切り詰め）の `cut`**。`recall-runtime.ts` の `while (cut > 0 && !fits(allUnits.slice(0, cut))) cut -= 1` は、`fits` が毎回 prefix 全体を足し直すので O(n²)。`tokenCounter.count` を呼ぶ回数も同じだけ増える（n=4000 で 4.2 秒という依頼文の実測がある）。

- **決めたこと**:

  1. **(a) 状態の変わらないメンバーに `updated/contested` を積まない。**`markContestedGroup` を実装する store のうち、`@mnemora/postgres`（`PostgresMemoryStore`）・`@mnemora/testkit` の InMemory（`InMemoryMemoryStore`）・core のテスト用 Fake（`FakeMemoryStore`）の3つが、呼び出し時点で `status === 'contested'` かつ `contestedWithId` が無いメンバーの `event` を積まない。
     - 積むのは、`active` から入るメンバーと、2者の対から群へ吸収されて `contestedWithId` が外れるメンバー（どちらも状態が変わる）。
     - 判定は store の中、CAS の判定に使った行（Postgres は `FOR UPDATE` で読んだ行）から取る。`Runtime` は CAS の前に読んだ状態から判定しない（並行する書き込みで食い違わないように）。
     - 戻り値の `events` は、積んだ分だけになり、`members` より短くなりうる。全員が既に群の一員なら 0 件で、例外にならない。
     - `MemoryStore.markContestedGroup?` の契約（interface の TSDoc）にこの点を書いた。**適合テスト（`*-conformance.ts`）には要件を足していない。**渡された `event` を全部積む第三者の adapter も、これまでどおり適合する。
  2. **(b) `note` は件数と先頭 K=10 件だけを持つ。**`kind: "claim_key_conflict_group"` の `note` に次を入れる。
     - `memberIds`: id の昇順（UTF-16 コード単位順）の先頭10件。`memberCount`（新設）に全体の件数、`memberIdsTruncated`（新設、真偽値）に切ったかどうか。
     - `matches`: id の昇順の先頭10件の要約。`matchCount`（既存）に全体の件数、`matchesTruncated`（新設、真偽値）に切ったかどうか。
     - `triggering`・`claimKey`・`subjectId`・`kind` は変えない。
     - 並びを id の昇順にしたのは、store が `findActiveByClaimKey`／`findContestedByClaimKey` の返す順や、群の探索の順（集合の挿入順）に依らず、同じ群から同じ note が決定的に出るようにするため。
     - 全員の id は、`observe()` の戻り値 `contestedDetection[].result.memberIds`（変えていない）と、各 Memory の状態と `memory_relations`（群が `contested` の間）から引ける。
     - K を10、印を真偽値2つと件数1つにした理由: 1件の `meta` が約1.5KB で頭打ちになり（下の測定）、監査ログを読む人が「どのくらいの群で、切られているか」と「代表の数件」を1件のイベントから読める。既存の meta は、件数（`matchCount`・`count`）と固定タグ、状態を表す値で書かれており、`Truncated` のような真偽値の印を新しく足すのはこの ADR が初めてである。
  3. **段4の `cut` は、累積和を1回作って二分探索で求める。**新しい内部ファイル `packages/core/src/recall-budget-cut.ts` の `findBudgetCut` が担う（公開しない。`index.ts` から export していない）。
     - 結果は旧実装と1ビットも変えない。`fits` と同じ式（文字数は単位ごとの digest 長の和が `maxMemoryChars` を超えない、トークンはメンバーごとの `tokenCounter.count(digest).tokens` を足して単位の値にし、単位の値を先頭から足した和が `maxTokens` を超えない）で、足す順も同じなので、浮動小数点の丸めも同じ。`!(sum > max)` の形で比べ、NaN との比較の向きも旧式と同じにしてある。
     - 二分探索は、`fits` が prefix の長さについて単調なときだけ使う。文字数は必ず単調。`tokenCounter` は利用者が差し替えられるので、単位ごとの値が負・NaN のときは累積和が単調でなくなる。その場合は二分探索を使わず、累積和の上を旧実装と同じ向き（k=n から下へ）に線形に探す（O(n) のまま、結果は同じ）。
     - トークンを数える範囲は、文字数の制限を満たす最大の prefix まで。旧実装が数えなかった digest のために `tokenCounter` を呼ばない。呼ぶ回数は変わる（旧実装は同じ digest を何度も数えていた）。
  4. **歯**:
     - `packages/core/src/__tests__/contested-group-event-growth.ts`（共通の走らせ方と閾値）と、それを使う3本: core Fake の `contested-group-event-growth.test.ts`、testkit の `in-memory-contested-group-event-growth.test.ts`、Postgres の `contested-group-event-growth.postgres.test.ts`。同じ claim key・有効期間 null の発話を N=10/20/40 件 observe し、イベントの件数が N+2 以下、note の長さが N=20 と N=40 でほぼ同じ、meta の合計バイト数がイベント1件あたりの定数の上限×件数以下、を縛る。note の形（`memberCount`・印・先頭の並び）も縛る。Postgres の本にはさらに、`markContestedGroup` の口そのものが「既に群の一員には積まず、`active` と対の片割れには積む」「全員が既に群の一員なら 0 件」を縛る2本を足した。
     - `packages/core/src/__tests__/recall-budget-cut.test.ts`: 旧実装をテストの中に写した参照実装（`referenceCut`）と `findBudgetCut` の `cut` が、多数の入力で一致する。境界ちょうど（全 prefix の合計 ±1）、ランダムな予算（未指定・0・全部入る・全部落ちる・負を含む）、単位が 0 件・全部空の digest、`heuristicTokenCounter` と除数を変えた `tokenCounter`、単調でない counter（負・NaN・Infinity・小数）。さらに `runtime.recall` の出力（返る記憶の並び）が、予算なしの並びの先頭を参照実装の `cut` 件だけ残したものと一致する。
  5. **この変更で事実と合わなくなった記述を直した。**[docs/memory-model.md](../memory-model.md) の、群の `updated` の説明・`note` の型の説明・「結んだときの `meta.note` の `memberIds` に全員の id が残る」という記述。`MemoryStore.markContestedGroup?` の TSDoc。CHANGELOG の `[1.2.0]` の `### Changed` に1項目を足した。
     - 関連する採用済み ADR のうち、[0327](./0327-relation-graph-contested-write-path-design.md) と [0381](./0381-contested-group-write-path-implementation.md) の末尾に、この変更の追記を足した。残りの [0378](./0378-claim-key-contested-detection-covers-contested-matches.md)・[0401](./0401-mark-resolve-contested-group-constant-statements.md) は、事実と合わなくなる記述が見つからなかったので足していない。本文は書き換えていない。
  6. **やっていないこと（オーナーへ回した）**。
     - 群のサイズの上限（(c)）。
     - 群の関係の行を完全グラフでなくす（(d)）。`memory_relations` の行数は群の大きさの2乗のままである。
     - `findActiveByClaimKey`／`findContestedByClaimKey` への `LIMIT`（候補3）。
     - `normalizeClaimKeyPart` の正規化の変更（候補4）。
     - `claim_key_conflict_unresolved`（`relationStore` を配線していないとき）の `note` は、`matches` の全員を入れたままである。1回の observe に1件だけ積むので O(N²) バイトで、この ADR の対象にしていない。

- **検討した代替案**:

  1. **`note` に何も入れず、イベントの `meta` を件数だけにする。**採らなかった。「どの記憶が群に入ったか」を1件のイベントから代表数件でも読めることは、監査ログの目的（北極星の問い3）に近い。件数だけでは、切った後に残る手がかりが無い。
  2. **(a) だけ入れて (b) を入れない。**採らなかった。(a) だけだと、積み上げは O(N²) バイト（N 件の各イベントの note が O(N)）で残り、依頼された N の線形にならない。
  3. **(a) を `Runtime` の側でやる（状態が変わるメンバーにだけ event を渡す）。**採らなかった。`MemoryStore.markContestedGroup?` の引数 `members[].event` は必須の型で、任意にするのは第三者の adapter を壊す変更になる。Runtime が CAS の前に読んだ状態で判定すると、並行する書き込みで store 側の判定と食い違う。
  4. **`note` の並びを、Runtime に渡された順（探索の順）の先頭 K 件にする。**採らなかった。store が返す順に依存し、同じ群から違う note が出うる。
  5. **段4の `cut` を、毎回 prefix を足し直す代わりに、後ろから1単位ずつ引く差分の更新にする。**採らなかった。旧式と足す順が変わり、小数を返す `tokenCounter` で丸めが変わりうる。累積和は旧式と同じ順で足すので同じ値になる。
  6. **段4の `cut` を、常に二分探索にする。**採らなかった。`tokenCounter` が負・NaN を返すと `fits` が単調でなくなり、二分探索の結果が旧実装と違うことがある。

- **引き受けた負債**:

  - **11件以上の群では、`note` から解消後の群の全メンバーを辿れなくなる。**`memory_relations` の行は `resolveContestedGroup` が消すので（[ADR 0381](./0381-contested-group-write-path-implementation.md) 決定3）、解消した後は先頭10件と件数しか残らない。以前は結んだ時点の `note` に全員の id が残っていた。全員を残す必要があるなら、別の場所（別の行・別のイベント）に持つ設計が要る。
  - **(a) により、既に群の一員だったメンバーには、その回の呼び出しの根拠（新しい発話が群に加わった）のイベントが積まれない。**根拠は、状態が変わったメンバー（新しく入った発話）のイベントの `note` に残る。既存メンバーの側から「いつ、誰が加わったか」を読むには、群のほかのイベントを見る必要がある。
  - **`MemoryStore.markContestedGroup?` の戻り値 `events` の長さが `members` と一致しなくなった。**自前の adapter が全員ぶん積んでも壊れないが、adapter ごとに積む件数が違う状態になる。適合テストに要件を足していないので、この差は検査されない（適合テストに足さないことは、依頼どおり）。
  - `memory_relations` の行数（完全グラフ、有効期間が重なる組）と、`findActiveByClaimKey`／`findContestedByClaimKey` の返す件数は、N のままである。呼び出し1回の SQL・メモリは N² のまま残る。
  - 段4の `cut` は、`tokenCounter` を呼ぶ回数と順序が旧実装と違う。副作用のある `tokenCounter`（呼び出し回数を数えるなど）には見える差になる。

- **これが覆るとしたら**:

  - 監査ログから解消後の群の全メンバーを辿る要求（規制・運用）が出たら、K の引き上げでは足りず、全員を別の場所に持つ設計（決定2の見直し）が要る。
  - 群のサイズに上限を置く（(c)）か、関係の行を完全グラフでなくす（(d)）とオーナーが決めたら、`memberCount` が指す集合の意味が変わりうる。(a)・(b) はそのまま残せる。
  - `Truncated` の印の形（真偽値2つ）を、件数の差（`memberCount > memberIds.length`）で読める形に統一する、とオーナーが決めたら、印の欄は落とせる。
  - 適合テストに「状態の変わらないメンバーには積まない」を要件として足す、とオーナーが決めたら、第三者の adapter にとっては破壊的変更になる（適合テストの判定を厳しくする変更として数える）。

- **測ったこと**:

  - 直す前（main の `5fe089c4`）に、core Fake で N=10/20/40 の順に走らせた。`updated/contested` のイベント件数、`note` の最大長、`meta` の合計バイト数の順に、54/1277/64962、209/2446/452495、819/4810/3362653。
  - 直した後は 12/1344/11823、22/1469/30346、42/1499/67624。イベントは N+2 件（2者の対の2件を含む）、note は N=20 以降ほぼ一定、`meta` の合計は約 1.5KB × 件数で頭打ちの傾きになった。
  - 3つの歯（core Fake・testkit InMemory・Postgres）は、直す前の実装に当てるとどれも赤（`expected 54 to be less than or equal to 12`）。Postgres の2本（口そのものの歯）も赤（積まれたイベントが3件に対し期待は0件、など）。直した後は緑。Postgres 17（手元、`--encoding=UTF8 --locale=C.UTF-8`）で走らせた。
  - 段4の `cut`（`heuristicTokenCounter`、1単位1メンバーの digest が 20〜49 文字、`tokenCounter` を呼ぶ側だけに予算をかけた最悪の形〔全部落ちる〕）の所要時間を、旧実装と新実装で測った。n=500/1000/2000/4000 で 89.4ms/304.7ms/1894.7ms/8075.5ms（旧）→ 0.61ms/0.68ms/1.15ms/1.97ms（新）。トークンの制限が4分の1だけ入る形でも、旧 70.0/264.9/1449.6/7118.4ms → 新 0.33/0.72/1.33/1.71ms。文字数の制限もかけた形（旧実装は文字数で先に落ちるので速い）は、n=4000 で旧 74.7ms（全部落ちる）・54.1ms（半分入る）→ 新 0.17ms・1.09ms。単位の `cut` の値はすべて旧と新で一致した。依頼文の n=4000 で 4.2 秒という値は、この測定の器では再現していない（この測定は8秒台）。測ったのは `cut` の関数だけで、`recall()` 全体の所要時間は測っていない。
  - `findBudgetCut` の歯に変異（文字数の比較を `<` にする、トークンの比較を `>=` にする、単調性の検査を緩める、トークンを数える範囲を全単位にする）を入れると、それぞれ赤になることを確かめた。
