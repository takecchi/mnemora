# ADR 0357: `OutboxStore.claimBatch` の取り直しは `available_at` を進め、先頭詰まりを解消する

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

## 文脈（[Issue #1196](https://github.com/takecchi/mnemora/issues/1196)）

`OutboxStore.claimBatch`（ADR 0032 が足した claim のリース）は、`available_at` の古い順に
`limit` 本を取る。リースが切れた行（`claimed_at` が `leaseMs` 以上前）も、未 claim の行と
同じ `WHERE` で対象になる——だが `claimBatch` は `claimed_at`/`claimed_by`/`attempts` だけを
書き、`available_at` は一切動かさない。

その結果、**終端に達しないまま止まり続ける job**（毎回ワーカーを落とす job）が `limit` 本
以上あると、次のことが起きる（Issue #1196、【実測 2026-09-27、`main` `df24e5c`、
`@mnemora/postgres` と testkit の fixture で同じ】）:

- 積んだ10本のうち、最も古い3本に `complete` も `fail` も呼ばない。`limit: 3`・
  `leaseMs: 60000` で、リースを切らしては `claimBatch` を5回呼ぶと、**5回とも同じ3本が
  取られ、残りの7本は一度も取られなかった**。
- 後ろに届くのは、止まった job がまだ claim 中（リースの内）のうちに別の claim が来た
  ときだけ——止まった job はリースが切れると再び先頭に戻ってくる。

これは ADR 0032 が「先頭詰まり」として一度扱った問題（未 claim の行がリース *内* の claim
済みの行に阻まれる）とは別の形である——ADR 0032 が塞いだのは「claim 済み・未完了の行が
`available_at` を進めないので、リースが有効な間ずっと先頭を塞ぐ」ケース。今回のIssueは
「リースが切れて *取り直された* 行が、それでもなお先頭に戻ってくる」ケースであり、
リースの仕組みそのものが解決しない。

## 決定

**`claimBatch` は、リースが切れた行を「取り直す」（＝claim 時点で `claimed_at` が既に
非 NULL）ときに限り、`available_at` を `opts.now` へ書き直す。初めての claim（`claimed_at`
が NULL だった行）では `available_at` を変えない。**取る順（`available_at` の古い順）
そのものは変えない——索引 `(tenant_id, available_at)` もそのまま効く。

### Postgres

```sql
UPDATE outbox o
SET claimed_at = ${now}, claimed_by = ${claimedBy}, attempts = attempts + 1,
    available_at = CASE WHEN o.claimed_at IS NULL THEN o.available_at ELSE ${now} END
FROM claimable c
WHERE o.id = c.id
RETURNING o.*
```

🔴 **`SET` 句の中の `o.claimed_at` は、この `UPDATE` 自身が今まさに書こうとしている新しい
値ではなく、この行の更新前の値である**——PostgreSQL は同一 `UPDATE` 文の `SET` 内で他列を
右辺に使うとき、常に更新前の値を見る（同じ `UPDATE` の複数の `SET` 項が互いに前後関係を
持たない）。この性質に頼って、「初めての claim か取り直しか」を1つの `UPDATE` 文の中だけで
判定している。

### testkit の fixture（`InMemoryOutboxStore`）

同じ意味論を手で複製する——`claimed.forEach` のループの中で、書き換える前の
`job.claimedAt`（`null` かどうか）を見てから `availableAt` を条件付きで更新する。

### 狙い

止まり続ける job が何本あっても、後ろの job がいつかは claim されること（飢餓が起きない
こと）。取り直された job の `available_at` は、そのときの `now`（通常は他のどの未処理 job
の `available_at` よりも新しい）へ進むため、次にリースが切れて `claimBatch` が呼ばれる
ときには、まだ一度も claim されていない古い job のほうが先に来る。

**正直に書くと、取り直された job は先頭で「2回」claim されてから後ろへ回る**——1回目は
初めての claim なので `available_at` を動かさず、2回目（最初の取り直し）で初めて `now`
へ進む。3回目以降の claim では、その時点でまだ `available_at` が古い他の job に先を譲る。
ゼロ回で後ろへ回るわけではない。

## 検討して採らなかった案

- **案B: `ORDER BY attempts, available_at`（attempts が少ない job を優先する）。** 却下。
  流入が続く運用では、一度リースが切れた job（無実のクラッシュに巻き込まれた job を含む）
  が `attempts` の大きさゆえに恒久的に後回しにされる——今度は「止まらない job」の継続的な
  流入が「かつて止まった job」を飢えさせる、逆向きの飢餓を作る。しかも `ORDER BY attempts,
  available_at` は既存の索引 `(tenant_id, available_at)` で並べ替えられない（`attempts`
  を先頭に持つ新しい索引が要り、追加のマイグレーションが要る）。
- **案C: `ORDER BY COALESCE(claimed_at, available_at)`。** 却下。`available_at` の値
  そのものは変えずに済む（元のデータを保てる）が、この式に対する新しい索引（式索引）を
  張るマイグレーションが要る。案Aは既存の列・既存の索引だけで完結する。

## 範囲外（Issue #1196 の「決めていないこと」のうち、答えていないもの）

- ⛔ **`attempts` が N を超えたら `fail` にする、のような上限で終端にする形は入れていない。**
  ADR 0032「これが覆るとしたら」が範囲外として残した論点のままである。
- **隔離する**（別の状態に移す）設計も入れていない。
- **観測（`TickResult` に「この tick で取り直した件数」を出す）は見送った。**理由は下の
  「引き受けた負債」。

## 引き受けた負債

- **止まり続ける job は消えない。** 後回しにするだけで、無限に `attempts` を増やしながら
  存在し続ける。上限で終端にする設計が無い限り、outbox 行は無限に蓄積する。
- **取り直された job は先頭で2回 claim される。** 「1回で後ろへ回る」ほうが直感的に見えるが、
  「初めての claim では `available_at` を変えない」という既存の契約（`available_at` は
  積んだ順・積んだ時刻を表す）を壊さずに実装すると、この形になる。
- **`TickResult` への観測（「この tick で取り直した件数」）の追加を見送った。** 検討した
  実装（`claimBatch` が返す `attempts > 1` の件数を数える）は、`packages/core` の型
  `TickResult` に新しい必須フィールドを足すことになる。この型は「無いことを示すのに
  `undefined` を使わない」という規律（`unsupported`/`leaseConflicts` と同じ）に従うため、
  省略可能なフィールドにはできない。実際に構築している箇所は `packages/core/src/runtime.ts`
  の1箇所のみで型的な影響は無いが、`toEqual` で `TickResult` を厳密比較しているテストが
  `packages/core`・`packages/postgres` に26箇所以上あり、全部に新しい欄の期待値を足す
  必要がある。これは「先頭詰まりを解消する」という本 PR の主題から見て波及が大きく、
  かつ `TickResult` への必須フィールド追加はそれ自体が破壊的変更（ADR 0178 が指摘した
  「必須メソッド追加は破壊的」と同型のパターン）になるため、CHANGELOG・
  `docs/migration-v1.md` への追記も余分に要る。今回はスコープアウトし、必要なら別の
  Issue/PR で対応する。**`attempts` の値を見れば、呼び出し側は今でも「この job が何回目の
  claim か」を知ることはできる**（`OutboxJobRecord.attempts`）——ただし「この tick で
  何件取り直したか」を tick 単位で集計する口はまだ無い。

## Breaking か否かの判定（クローン miku の判断であり、オーナーの判断ではない）

**非破壊（⚠付き）と数える。** 判定はこのリポジトリの既存の数え方の規律
（`CHANGELOG.md` `[1.1.0]` 節前書き「保留と非破壊の数え方」）に照らした:

- **型は1バイトも変わっていない**（`ClaimOutboxJobsOptions`・`OutboxJobRecord`・
  `OutboxStore` のインターフェース宣言。`pnpm run api:check` で `@mnemora/core`・
  `@mnemora/testkit`・`@mnemora/postgres` すべて「差分なし」を確認済み）。
- **例外を投げる入力の集合は変えていない。** `claimBatch` が例外を投げる条件（`limit` の
  整数・非負・bigint範囲チェック、`now`/`leaseMs` の Invalid Date チェック、`claimedBy` の
  NUL チェック）は1つも増減していない。
- **変わるのは、claim した行が返す `availableAt` の値と、リース切れの繰り返しに対する
  「取る順」の実質的な帰結だけである。** これは「例外を投げず結果だけが変わる修正」に
  該当し、このリポジトリが PR #1289・#1299・#1379・#1389 等で一貫して採ってきた
  「非破壊（⚠付き）」の分類と同型である。

一方で、**`OutboxStore` を自作している第三者実装者への影響はゼロではない**——契約 doc
（`packages/core/src/interfaces/outbox-store.ts`）に、取り直し時に `available_at` を
進める義務が新しく明記された。この義務を満たさない独自実装は、今後もコンパイルは通るが、
Issue #1196 の先頭詰まりを起こしたままになる。CHANGELOG の当該項目にこの点を明記した。

## これが覆るとしたら

- `TickResult` に「取り直した件数」の観測を足すことになったとき（別 Issue/PR）、
  `toEqual` の厳密比較テスト群の扱いを再検討する必要がある。
- 「止まり続ける job を隔離する・上限で終端にする」が実装されるとき、本 ADR の「取り直しは
  後ろへ回す」という緩和と、新しい終端化の仕組みが二重に効かないか（例: 上限に達する前に
  十分な回数後ろへ回っていれば、上限判定の意味が薄れる）を再検討する必要がある。
- 案B（`ORDER BY attempts, available_at`）を採る場合が来たら、既存の索引
  `(tenant_id, available_at)` を張り替える（または `attempts` を先頭に持つ新しい索引を
  足す）マイグレーションが要る。

---

## 追記（2026-09-30）: 完了した outbox 行を消す口は [ADR 0404](./0404-purge-expired-recalls-and-completed-outbox-jobs.md) で足した——負債1の「止まり続ける job」は消えない

クローン miku の委譲先が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**上の本文は書き換えていない。**

「引き受けた負債」1の「outbox 行は無限に蓄積する」のうち、**完了した行**については、
`OutboxStore.purgeCompletedJobs?`（[ADR 0404](./0404-purge-expired-recalls-and-completed-outbox-jobs.md)）で
消せるようになった。**ただし対象は `completed_at` が付いた行だけである。** 止まり続ける job（`completed_at` も
`failed_at` も付かないまま再 claim され続ける行）と、`failed_at` が付いた行は、この口では**決して消さない**
——この負債はそのまま残る。保持期間の既定値と `failed` 行の扱いは、オーナーに聞く事柄として ADR 0404 に残した。
