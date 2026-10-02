# ADR 0529: 穴探し — ADR 0526「測っていないこと」の実測。`tick` が種類を混ぜて回るとき・並行する複数の `tick`・リースが切れた後の再取得（Runtime の層。3者一致。割れは見つからなかった。決定的にできる部分だけ歯にした）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・Fake・InMemory を Postgres に揃える）の中だけを直す方針だったが、**直す割れは見つからなかった**。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポート `54871` で）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0526 の「測っていないこと」のうち、(b) `tick` が `extract`・`embed` と、`consolidate`・`reflect` のジョブと同じ回に回る組み合わせ、(c) 並行する複数の `tick` と、リースが切れた後の再取得、を Runtime の `tick` の層で、Fake・InMemory・Postgres の3者に同じ操作列を流して測った。大文字の id・実 API は外した。

## 既にある歯の地図（足したのは差分だけ）【現物】

| 層 | 既にある歯 | 縛っているもの |
|---|---|---|
| `OutboxStore`（3実装共通） | `packages/testkit/src/outbox-store-conformance.ts` | claim の可否（`availableAt`・`kinds`・`limit`）、リース内の行は再 claim されず後続に届く（先頭詰まりが無い）、リースが切れた行は再 claim される、`complete`/`fail` の `attempts` の CAS（`OutboxLeaseConflictError`）、遅れたワーカーが再 claim 後の終端を上書きできない（Issue #233）、先に付いた終端が勝つ |
| InMemory の入力 | `in-memory-fixtures-claim-batch-lease-ms.test.ts` | `now - leaseMs` が Date にならない入力の断り（Postgres と同じ） |
| Postgres の store | `outbox-skip-locked-non-blocking.postgres.test.ts`・`outbox-claim-statement-failure-recovery.postgres.test.ts`・`outbox-claim-lease-index.test.ts`（`SKIP LOCKED` が詰まらないこと、claim 文の失敗からの回復、索引が使われること。二重 claim を `FOR UPDATE` が止める実測〔10ラウンド中8ラウンドで二重 claim〕は `packages/postgres/src/outbox-store.ts` 冒頭のコメントに書いてある） | store の層の並行（claim の取り合い・索引） |
| Runtime の層 | `packages/core/src/__tests__/tick-batch-lease-expiry.test.ts`（Fake のみ。1バッチ内で後ろのジョブのリースが先に切れる） | 別の `tick` が再 claim → 遅れた側が `leaseConflicts`、provider は二重に走る |
| 同期 observe | `observe-sync-extract-job-lease.test.ts`（core・testkit・postgres） | observe が持っている間は extract のジョブを `tick` が取らない（ADR 0407）。リース切れ後は拾う |
| `extract` の再配達 | `tick-concurrent-extract.postgres.test.ts`（並行の2本の配達）・`tick-sequential-redelivery.postgres.test.ts`（逐次の再配達。`embed`・`consolidate`・`reflect`・`extract`） | 時計と門で順序を決めた再配達の結果 |
| `leaseMs` の TSDoc | `runtime.ts` の `TickOptions.leaseMs` | 0 以下の `leaseMs`、入口の検査（ADR 0496）、処理がリースより長いとき、バッチの claim 時点から数えること |

**足りなかった差分**: (1) 種類を混ぜた1回の `tick`（`extract`・`embed`・`consolidate`・`reflect` が同じ回に回る）の3者比較。(2) Runtime の層での、複数の `tick` の並行（種類を問わず、全件が1回ずつ処理されること）の3者比較。(3) リースが切れて別の `tick` が再取得し、元の `tick` が遅れて `complete`／`fail` する流れの、InMemory・Postgres での比較（既存は Fake だけ、または `extract` だけ）と、死んだワーカーの claim を次の `tick` が拾う流れ。

## 結果

### (b) 種類を混ぜた `tick` — 3者一致【実測。決定的】

- **既定の `kinds` で、4種類のジョブ（embed・extract・consolidate・reflect）が1回の `tick` で全部処理される**（`processed: 4`）。処理の途中で積まれる後続のジョブ（`extract` が作った記憶の `embed`、`reflect` が作った記憶の `embed`）は、同じ `tick` では claim されず、次の `tick` で処理される（claim は先頭で一括）。2回の `tick` の後に outbox は全て完了。
- **`limit` は種類を問わず、`availableAt` の古い順**（`limit: 2` で、積んだ順の先頭2件。種類は選ばれない）。
- **`kinds: ["embed", "extract"]`** は、`consolidate`・`reflect` の行に触れない（claim すらしない）。
- **知らない種類の行（`custom-kind`）**: 既定の `kinds` では claim されず終端にもならない。名指しで渡すと `unsupported` として `fail`（`lastError: runtime.tick: unsupported outbox job kind: custom-kind`）に落ちる（ADR 0082）。
- 見かけの差（実装の差ではない）: 同じ時刻に作った行の `created_at` の並び（歯は 5ms 空けて作り、順を決める）。

### (c) 並行する複数の `tick` — 不変条件は3者で成り立つ。誰が何件取るかは Postgres の実の並行で転ぶ【実測】

- **不変条件（どう転んでも成り立つ。3者とも）**: 全てのジョブが高々1回だけ claim される（`attempts <= 1`）。`leaseConflicts` は空・`failed` は 0。embed の呼び出し回数 = 処理した件数。取られなかった行は触れられずに残る。処理した分の記憶は `ready`。
- **Fake・InMemory は決定的**: claim が同期的に済むので、先に走った `tick` が上限まで全部取る（`limit: 50` の2本なら 8/0、`limit: 3` の2本なら 3/3）。
- **Postgres は転び方が毎回違う**（`FOR UPDATE SKIP LOCKED` で、取り合いに負けた側は飛ばして次の行を取る）。**測り方と観測**: 8件の embed ジョブを積み、同じ tenant に対して `Promise.all` で複数の `tick` を撃つ。これを 40 回繰り返した（各構成）。
  - `limit` 既定（50）の2本: 処理件数の分かれ方（多い順）は 8/0 が 32 回、7/1 が 3 回、6/2 が 3 回、5/3 が 2 回。
  - `limit: 3` の2本: 3/3 が 40 回（毎回）。
  - 3本・処理が 20ms かかる embed: 8/0/0 が 23 回、6/2/0 が 6 回、7/1/0 が 4 回、4/4/0 が 2 回、5/3/0 が 2 回、4/3/1・5/2/1・4/2/2 が各 1 回。
  - 種類を混ぜた（embed・consolidate・reflect の8件）2本: 8/0 が 29 回、7/1 が 8 回、6/2 が 2 回、4/4 が 1 回。
  - **どの構成でも、二重 claim（`attempts > 1`）・`leaseConflicts`・合計が行数を超えることは 0 回**（160 回）。
- 【判断】分かれ方は歯にしない（決定的に再現できない）。**不変条件だけ**を歯にした（上）。

### (c) リースが切れた後の再取得 — 3者一致【実測。決定的】

順序は時計のオフセット（`RuntimeDeps.clock` を壁時計＋オフセットにする）と、embed の前の門（Promise）で決めた。
- A の `tick` が embed の途中で止まる（門）。リース内の別の `tick` は何も取らない（`processed: 0`）。時計をリースより先へ進めると、B の `tick` が同じ行を再 claim して処理する（`attempts: 2`・完了）。そのあと A の門を開けると、
  - A の embed が成功しても、A の `complete` は `leaseConflicts`（`complete`）に載る。
  - A の embed が失敗しても（遅れて provider が落ちた）、A の `fail` は `leaseConflicts`（`fail`）に載り、行は B の完了のまま、記憶は `ready` のまま（ADR 0053 の巻き戻さない規則）。
  - embed は2回呼ばれる（二重に走る。TSDoc のとおり）。
- 死んだワーカーが claim したまま（`complete` も `fail` もしない）の行: リース内の `tick` は取らず、リースが切れた後の `tick` が取って完了させる（`attempts: 2`）。
- 境界: `claimedAt + leaseMs` ちょうどの時刻で再 claim できる（`claimedAt + leaseMs - 1ms` ではできない）。

## 決定したこと

1. 割れが無かったので、実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
2. **決定的にできる部分と、不変条件だけを歯にした**（conformance suite には足さない）:
   - `packages/core/src/__tests__/fake-tick-mixed-kinds-concurrency-lease-parity.test.ts`（Fake）
   - `packages/postgres/src/__tests__/tick-mixed-kinds-concurrency-lease-parity.postgres.test.ts`（InMemory と実 Postgres。DB はファイルの冒頭で `resetTestDatabase` により作り直し、tenant はこのファイル専用の名前を使う）
   - 2つは同じ操作列と同じ `EXPECTED`（11 項目）を持つ。
3. **歯にしなかったもの**: Postgres の並行で「どの `tick` が何件取るか」の分かれ方（上の観測のとおり毎回違う）。

## 変異試験【実測】

歯が噛むことを、実装を1つずつ曲げて確かめた。戻した後は `git status` に歯の2ファイル以外が無い。
- Fake の `claimBatch`: リース切れの行を再取得しない／リース内の行も再取得する（二重 claim）／`kinds` を無視する（Fake の歯が赤。3件）。
- Fake の `complete`: `attempts` の CAS を外す（Fake の歯が赤）。
- InMemory の `claimBatch`: リース切れの行を再取得しない／リース内の行も再取得する（InMemory・Postgres の歯が赤。2件）。
- Postgres の `claimBatch` から `FOR UPDATE SKIP LOCKED` を削る（実装の変異）: **5回走らせて4回赤、1回緑**。並行の不変条件の歯は確率的に噛む（二重 claim が起きた回だけ赤になる）。常に赤になる歯ではない。store の層の歯（`outbox-skip-locked-non-blocking.postgres.test.ts` など）は詰まらないことを縛る歯で、二重 claim を決定的に縛る歯は無い。この歯は、二重 claim が起きた回に気づける確率的な補強である。
- 変異なしで、Postgres の歯を 10 回、Fake の歯を 5 回走らせて、すべて緑（フレークは見えなかった）。

## 検討した代替案

1. **並行する `tick` の分かれ方を歯にする。** 採らなかった（決定的に再現できない）。
2. **リースの期限切れを実時間の `sleep` で作る。** 採らなかった。時計のオフセットと門で決める（`tick-concurrent-extract.postgres.test.ts` と同じ作法）。
3. **歯を足さず、結果だけ書く。** 採らなかった。

## これが覆るとしたら

- `tick` がジョブごとにリースを延ばす口を持つとき（`OutboxStore` に口を足す。公開 API の変更でオーナーの領分）。
- claim の取り合いの規則（`FOR UPDATE SKIP LOCKED`）を変えるとき。

## 測っていないこと

- 大文字の id・実 API（外した）。
- 複数のプロセス・複数の接続プールからの並行（この測定は1プロセスの1つのプールで、`Promise.all` の複数の `tick`）。
- `limit` が大きく、1バッチ内のジョブの処理時間の合計が `leaseMs` を超える場合の Postgres での比較（Fake の `tick-batch-lease-expiry.test.ts` が縛る形。Postgres・InMemory では測っていない）。
- `extract` のジョブを含む並行する `tick` の LLM 呼び出しの二重化（`tick-concurrent-extract.postgres.test.ts` が縛る）。
