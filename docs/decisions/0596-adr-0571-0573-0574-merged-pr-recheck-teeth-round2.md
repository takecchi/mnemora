# ADR 0596: マージ済みの #1683・#1685・#1686（ADR 0571・0573・0574）の確かめ直しで見つかった歯の穴を塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-587fc473）が切り出した担い手が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポート 55702 で。`initdb --encoding=UTF8 --locale=C.UTF-8`）、【判断】は担い手またはクローンの判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0589](./0589-adr-0552-0553-teeth-holes-controls.md) などの試験だけの PR と同じ）。

## 経緯【実測】

マージ済みの #1683（[ADR 0571](./0571-doc-code-drift-sweep-public-tsdoc.md)）・#1685（[ADR 0573](./0573-fake-event-time-nul-claim-controls.md)）・#1686（[ADR 0574](./0574-adr-0557-superseded-by-controls.md)）を変異試験で確かめ直したところ、歯が噛まない約束が残っていた。次の表がその一覧で、ここに挙げたものはこの PR で歯を足す。

| # | 元 | 約束 | 通った変異 |
|---|---|---|---|
| 1 | ADR 0574 決定3 | 存在しない行どうしが輪になるときは、not found ではなく循環の `RangeError`（pair・group とも） | 循環の検査を「存在確認の後、CAS の前」へ動かす（Fake・InMemory・Postgres の pair・group の6通り） |
| 2 | ADR 0573 | `archiveDecayed`・`purgeMemory` の後も `createdAt` は作ったときのまま | archive で `createdAt = opts.now`、purge で `createdAt = event.at`（Fake・InMemory）／UPDATE に `created_at = now()`（Postgres） |
| 3 | ADR 0573（N5） | 記号を含む `extractorVersion`（`v1.2-rc_3`）は断られない（断るのは NUL だけ） | Fake の `createMemory` に、英数字以外を断る行を NUL の検査の隣へ足す |
| 4a・4b | ADR 0571 の C3・C4 | `registerEmbeddingSpace` は、`schema`・`extensionSchema` が `assertSafeSchemaName` を通らなければ `Error` | `schema` の検査を消す／`extensionSchema` の検査を消す（別々） |
| 4c | ADR 0571 の B1 | `acquireAdvisoryLock` は、`lock_timeout` の設定（`set_config`）に失敗したら `unavailable` | `errors.unavailable(err)` を `errors.timeout(0, err)` にする |
| 4d | ADR 0571 の A3 | `PostgresRelationStore.link` は、両端とも存在しないとき `fromId` 側を報告する | 報告する順（from・to）を入れ替える |
| 4e | ADR 0571 の D4 | `LocalEmbeddingProvider` の `revision` は `trim()` されずにそのまま渡る | `revision: options.revision?.trim()` |

## 決定【判断】

1. 実装は変えない。どれも実装は約束どおりで、歯が足りなかった。
2. **`createdAt` の歯（2）の出自。** `archiveDecayed`・`purgeMemory` の後に `createdAt` が変わらないという**明文の約束は無い**。ただし、作成時刻が後から書き換わらないことは当然の不変条件だと**クローンが判断し**、縛ることにした。同じ判断で supersede の `createdAt` を縛った [ADR 0592](./0592-adr-0583-0588-merged-pr-recheck-teeth.md)（#1704）と同じ線である。この判断が覆れば（作成時刻を操作の時刻で書き換える設計にする等）、この歯の期待値を一緒に直す。
3. 歯を次の置き場所に足す（すべて試験だけ）。
   - **1**: `packages/postgres/src/__tests__/store-superseded-by-checks-controls.postgres.test.ts` の3脚（InMemory・Fake・Postgres）に、「存在しない2件・3件が互いを指して輪になる循環は、not found ではなく循環の RangeError」を足す。既存の「位置: contested でない2件・3件の循環」の隣。Fake 単独の歯は `fake-superseded-by-checks-controls.test.ts` に既にある。
   - **2**: Fake は `packages/core/src/__tests__/fake-event-time-nul-claim-controls.test.ts`、InMemory は `packages/testkit/src/__tests__/in-memory-fixtures-created-at-after-archive-purge.test.ts`（新規）、Postgres は `packages/postgres/src/__tests__/created-at-after-archive-purge.postgres.test.ts`（新規）。Fake・InMemory は `Date` だけを固定して、作成と操作の間で壁時計を進める。Postgres は `now()` を止められないので、作成の後に `created_at` を SQL で 2000-01-01 へ書き換えてから操作する（ADR 0592 の `store-supersede-created-at.postgres.test.ts` が `created_at` を過去へ書き換える手法に倣った。変異試験を走らせた時点では #1704 は未マージで、そのファイルは手元の main に無かったため、手法を ADR の記述から借りて書いた。後から取り込んで読み、同じ手法であることを確かめた【現物】）。
   - **3**: `fake-event-time-nul-claim-controls.test.ts` の、NUL の歯の隣に陽性対照を足す。
   - **4a・4b**: `packages/postgres/src/__tests__/register-embedding-space-unsafe-schema.postgres.test.ts`（新規）。`"bad;name"` を `schema` に渡す／安全な `schema`（`public`）と `extensionSchema` に渡す。どちらも `assertSafeSchemaName` の message（`unsafe SQL identifier: bad;name`）で断ることを見る。門が無いと `"bad;name"` は二重引用符で囲まれて SQL に入り、DB の別の例外になる。陽性対照として、`schema` を指定しないときは `extensionSchema` を検査しない（TSDoc の括弧書き）ことも縛る。
   - **4c**: `packages/postgres/src/__tests__/advisory-lock-set-config-failure.test.ts`（新規）。`acquireAdvisoryLock` の引数 `pool` は `Pool` 型の値を受けるだけなので、`connect()` が `query` で `set_config` のときだけ reject する最小の偽クライアントを返す偽の pool を渡す。DB には繋がない。`errors.unavailable` の Error が cause 付きで投げられ、接続は返却（`release` 1回・`removeListener` 1回）され、`set_config` 以外の query（`pg_advisory_lock`）は撃たれないことを見る。**実物の接続で `set_config` を失敗させる自然な経路は見つけられなかった**（`lock_timeout` の値は `String(lockTimeoutMs)` で、不正な値を渡せない）ので、偽クライアントで測る【判断】。
   - **4d**: `packages/postgres/src/__tests__/relation-store-link-both-absent.postgres.test.ts`（新規）。両端とも無いときの message が `fromId` の id であること。対照として、片方だけ無いときは無い側を報告する。
   - **4e**: `packages/local-embedding/src/__tests__/revision-passthrough.test.ts` に、前後に空白がある revision（`"  0123abc\t"`）が、そのまま注入点の spec に載る歯を足す。測り直しの結果は下の「足さなかったもの」に書く（既存の歯は捕まえなかったので、足した）。
4. 試験の `it` の題・コメントに ADR 0596 を引く。

## 変異試験【実測】

各行は次の順で行った。歯を足して緑 → 実装ファイルを `cp` で退避 → Edit で変異 → 名指しのテストファイル1本を走らせて赤 → `cp` で戻して `cmp` で一致 → もう一度走らせて緑。**ループ・自作スクリプトは使わず、1回ずつ別のコマンドで打った。**

| 歯 | 変異 | 赤（落ちた it） | 戻して |
|---|---|---|---|
| 1・Fake の pair | `runtime-fakes.ts` の `resolveContestedPair` の `assertFakeNoSupersededCycle` を存在確認の後・CAS の前へ | 1本赤（54本中。「core の Fake」脚の「存在しない2件・3件が互いを指して輪になる循環…」） | cmp 一致、54本緑 |
| 1・Fake の group | 同 `resolveContestedGroup` | 1本赤（同 it、Fake 脚） | cmp 一致、54本緑 |
| 1・InMemory の pair | `in-memory-memory-store.ts` の `resolveContestedPair` | 1本赤（同 it、InMemory 脚） | cmp 一致、54本緑 |
| 1・InMemory の group | 同 `resolveContestedGroup` | 1本赤（同 it、InMemory 脚） | cmp 一致、54本緑 |
| 1・Postgres の pair | `memory-store.ts` の `resolveContestedPair`（トランザクション内の存在確認の後・CAS の前） | 1本赤（同 it、Postgres 脚） | cmp 一致、54本緑 |
| 1・Postgres の group | 同 `resolveContestedGroup` | 1本赤（同 it、Postgres 脚） | cmp 一致、54本緑 |
| 2・Fake の archive（3回） | `archiveDecayed` に `memory.createdAt = new Date(opts.now)` | 3回とも 1本赤（13本中。「archiveDecayed の後も、createdAt は作成時の値」） | cmp 一致、3回とも13本緑 |
| 2・Fake の purge（3回） | `purgeMemory` に `memory.createdAt = new Date(at)` | 3回とも 1本赤（13本中。「purgeMemory の後も、createdAt は…」） | cmp 一致、3回とも13本緑 |
| 2・InMemory の archive（3回） | 同じ変異を `in-memory-memory-store.ts` に | 3回とも 1本赤（2本中。archiveDecayed の it） | cmp 一致、3回とも2本緑 |
| 2・InMemory の purge（3回） | 同 | 3回とも 1本赤（2本中。purgeMemory の it） | cmp 一致、3回とも2本緑 |
| 2・Postgres の archive（3回） | `archiveDecayed` の UPDATE に `created_at = now()` | 3回とも 1本赤（2本中。archiveDecayed の it） | cmp 一致、3回とも2本緑 |
| 2・Postgres の purge（3回） | `purgeMemory` の UPDATE に `created_at = now()` | 3回とも 1本赤（2本中。purgeMemory の it） | cmp 一致、3回とも2本緑 |
| 3 | `runtime-fakes.ts` の `createMemory`、NUL の検査の隣（NUL の検査の行には触れず）に `/[^A-Za-z0-9]/` に当たる `extractorVersion` を断る行 | 1本赤（13本中。「陽性対照…記号を含む extractorVersion」） | cmp 一致、13本緑 |
| 4a（C3） | `vector-space.ts` の `schema` の `assertSafeSchemaName` を消す | 1本赤（3本中。C3） | cmp 一致、3本緑 |
| 4b（C4） | 同 `extensionSchema` の検査を消す | 1本赤（3本中。C4） | cmp 一致、3本緑 |
| 4c（B1） | `advisory-lock.ts` の `throw errors.unavailable(err)` を `errors.timeout(0, err)` に | 1本赤（1本中） | cmp 一致、1本緑 |
| 4d（A3） | `relation-store.ts` の `link` の報告の順を to → from にする | 1本赤（2本中。「両端とも存在しないときは、fromId 側を報告する」） | cmp 一致、2本緑 |
| 4e（D4） | `local-embedding-provider.ts` の `revision: options.revision?.trim()`（下記） | 足す前は捕まらない。足した後は 1本赤（5本中） | cmp 一致、5本緑 |

2 は時刻を比べる歯なので、赤と緑を別々のコマンドで3回ずつ走らせた（12通りすべて、赤3回・緑3回）。

## 足さなかったもの・測れなかったもの【判断】

- **A5（`link` の id の小文字化）は足さない。** Postgres の `uuid` 型は、大文字・小文字のどちらで渡しても保存される値が同じで、小文字化の有無を変えても結果が変わらない（ほぼ等価な変異）。歯が噛む入力を作れない。大文字の id の扱いは別の歯（`purge-memory-uppercase-id.postgres.test.ts` など）が縛っている。
- **D4 の測り直し（結果）【実測】。** `revision` に `trim()` を足す変異（`revision: options.revision?.trim()`）を、先に `pnpm --filter @mnemora/local-embedding run build` で dist を作った（生成物は commit しない）うえで、既存の `revision-passthrough.test.ts`（4本）・`revision-offline-preflight.test.ts`（5本）・`revision-env-swap.test.ts`（9本）・`local-embedding-provider.test.ts`（49本）・`create-pipeline-options-passthrough.test.ts`（1本）に当てた。**どれも緑のままで、既存の歯は捕まえなかった**（入力に空白を含む revision が無い）。そのため 4e の歯を足した。
- **B1 は足した。** 実物の接続で `set_config` を失敗させる経路は見つからなかったので、偽の pool・偽のクライアントで縛った（上の決定3の4c）。実物の `set_config` の失敗そのものは測っていない。確かめていないのは、実接続で `set_config` が実際に失敗したときの `pg` の例外の形（`unavailable` に包んで投げる側は、どんな `err` でも同じ分岐に入る【現物】）。

## 直さないもの

- ADR 0571・0573・0574 の確かめ直しで出たほかの変異のうち、この表に無いものには手を付けていない。
- `extensionSchema` を `schema` を指定したときだけ検査する扱い（TSDoc に明記）は変えていない。

## これが覆るとしたら

作成時刻を後から書き換える設計にしたとき（決定2）。`registerEmbeddingSpace` が `extensionSchema` を `schema` なしでも検査するようにしたとき。`revision` を整形して渡す設計にしたとき（TSDoc の「そのまま渡る」が変わるとき）。`link` の両端が無いときに `toId` 側を報告すると決めたとき。いずれもこの歯の期待値を一緒に直す。
