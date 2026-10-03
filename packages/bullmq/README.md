# @mnemora/bullmq

BullMQ で `runtime.tick()` を駆動する役
（[docs/decisions/0325-bullmq-tick-driver.md](../../docs/decisions/0325-bullmq-tick-driver.md)）。

## npm への公開

**`v1.1.0` から npm に出ている**（Issue #205）。初版 `1.1.0` は 2026-09-30 にオーナーが手元から
publish した（bootstrap。手順は [docs/release-v1.md](../../docs/release-v1.md) の `@mnemora/bullmq`
初回 publish の節）。⚠ **この初版には provenance が付いていない**——手元からの publish は
OIDC を経由しないため。次の版からは、ほかの `@mnemora/*` と同じく Release の publish ワークフローが
provenance 付きで上げる。

## ⚠ `Scheduler` を実装しない

`@mnemora/core` の `Scheduler` interface（`enqueue`）は実装しない——本番コードのどこからも
呼ばれておらず、実装しても呼び手が無い（ADR 0325「根拠①への応答」）。このパッケージが
することは、**BullMQ の Worker が定期的に発火するたびに `runtime.tick()` を呼ぶ**、
それだけである。

**outbox は今日どおり Postgres が正本のまま。** BullMQ（Redis）はジョブの中身を一切
持たない——運ぶのは「いま tick して」という合図だけであり、outbox の行と Redis 側の
ジョブが二重に帳簿を持つことはない。同時 tick からの二重処理を防いでいるのは
`@mnemora/postgres` の `PostgresOutboxStore.claimBatch`（`FOR UPDATE SKIP LOCKED`）で
あって、このパッケージや BullMQ 自身ではない（詳しくは ADR 0325「測ったこと」）。

## インストール

```bash
pnpm add @mnemora/bullmq @mnemora/core
# または
npm i @mnemora/bullmq @mnemora/core
```

**Redis が要る。** BullMQ は Redis（または互換サーバ）への接続を前提にする
——`connection` オプションにその接続先を渡す（下の例参照）。このパッケージ自身は
Redis サーバを同梱・起動しない。

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `module`/`moduleResolution` を `nodenext` にし、
  TypeScript 5.8 以降を使うこと。5.7 以前の `nodenext` と、どの版の `node16` も `TS1479` になる）
- **Redis（または互換サーバ）が要る。** `test`（`pnpm --filter @mnemora/bullmq run test`）は
  純関数（`resolveConcurrency`）と、`bullmq` を差し替えた検査（`vi.mock`）だけを走らせ、Redis は要らないが、`test:redis`
  （`pnpm --filter @mnemora/bullmq run test:redis`）は実際に BullMQ の `Queue`/`Worker` を
  構築するため Redis を要る（`.github/workflows/ci.yml` の `bullmq` job は
  `redis:7` の service container を使う）
- `runtime` は `Pick<Runtime, "tick">`——`@mnemora/core` の `createRuntime()` が返す
  `Runtime` 全体ではなく、`tick` メソッドさえ満たせば渡せる

## 動く最小の例（Redis が無いため未実行——型のみ確認）

```ts check
import { createBullmqTickDriver } from "@mnemora/bullmq";
import type { Runtime } from "@mnemora/core";

declare const runtime: Runtime;

const driver = createBullmqTickDriver({
  connection: { host: "127.0.0.1", port: 6379 },
  queueName: "mnemora-tick",
  runtime,
  ctx: { tenantId: "acme" },
  tick: { leaseMs: 30 * 60 * 1000, kinds: ["embed"] },
  everyMs: 5_000,
});

await driver.start();
// ... プロセスが生きている間、5秒おきに runtime.tick() が呼ばれる ...
await driver.stop();
```

**`start()` を呼ぶまでジョブは処理しない。** `createBullmqTickDriver(...)` は
Queue/Worker を構築するだけで、Worker は `autorun: false` で作る——ジョブの処理は
`start()` が明示的に `worker.run()` を呼んで初めて始まる。

**`stop()` の後は再開できない。** `stop()` を呼んだ driver は使い捨てである。その後に
もう一度 `start()` を呼ぶと Error を投げる（BullMQ の `Queue`/`Worker` は `close()` した後、
同じインスタンスを再利用できないため）。もう一度動かしたいときは
`createBullmqTickDriver(...)` を新しく呼び直すこと。

## 複数プロセスで動かすとき

**同じ `queueName` に対して複数プロセスが `createBullmqTickDriver(...).start()` を
呼んでよい。** BullMQ の Job Scheduler（`queue.upsertJobScheduler`）を `jobSchedulerId`
固定値で登録するため、二重登録にはならない——発火した個々の tick ジョブは、その時点で
空いているどのプロセスの Worker が処理してもよい（BullMQ の通常の負荷分散）。

🔴 **これは「同じテナントに対して2つの `runtime.tick()` が同時に走らない」ことを
保証しない。** その重なりから outbox の二重処理を防いでいるのは、上に書いたとおり
`@mnemora/postgres` 側の行ロックである。

🔴 **1台の `stop()` が、全プロセスの予定を止める。**`stop()` は Worker と Queue を閉じる前に
`queue.removeJobScheduler(jobName)` を呼ぶ。この scheduler は上のとおり全プロセスで共有している
（同じ `jobSchedulerId`）ので、1つのプロセスが `stop()` すると、他のプロセスの Worker は動いたままでも
tick のジョブがもう発火しない。エラーにもならない。動いている driver の `start()` をもう一度呼んでも
何もしない（冪等）ので、登録はし直されない。新しく作った driver の `start()` が `upsertJobScheduler` で登録し直すと、
再び発火する。⟹ rolling deploy や台数の縮小で1台を止めるときは、残りのプロセスのどれかを再起動する
（新しい driver で `start()` する）こと。
（【実測】redis-server 7.4.7・bullmq 6.3.8。同じ `queueName`・`jobName` の driver を2つ `start()` し、一方を `stop()` すると、`getJobSchedulers()` が空になり、
動いたままの他方の Worker は、その後3秒間 tick を1回も呼ばなかった。`onTickError` も鳴らない。新しい driver の `start()` で再び発火した。
⚠ **rolling deploy で「新しいプロセスを `start()` してから古いプロセスを `stop()` する」順だと、古い方の `stop()` が新しい方の登録を消す**——
上の実測と同じ形なので、新しいプロセスが動いていても tick は止まる。次に `start()` する driver が現れるまで、outbox に積まれた行は処理されないまま溜まる
（データは消えないが、embed・extract が止まったように見える）。**止めるプロセスを `stop()` する代わりに、`stop()` を呼ばずにプロセスごと終わらせる**
（Worker の lock が切れるまでは、その Worker が掴んだ最後のジョブが stalled になりうる）、または `stop()` の後に残るプロセスのどれかで新しい driver を `start()` し直すこと。）

🔴 **`queueName` か `jobName` は、テナント（`ctx`）ごとに分けること。**Worker はジョブの中身を見ずに、
自分に渡された `ctx` で `runtime.tick(ctx, tick)` を呼ぶ。テナントの違う driver が同じ `queueName` と
同じ `jobName`（既定は `"mnemora-tick"`）を使うと、scheduler は1つに上書きされ（`everyMs` は最後に
`start()` した driver の値になる）、1回の発火はどれか1つの Worker、つまりどれか1つのテナントの tick に
しかならない。どのテナントが何回 tick されるかは決まらない。上の `stop()` も、全テナントの予定を止める。
（【実測】redis-server 7.4.7・bullmq 6.3.8。同じ `queueName`・`jobName` で `everyMs: 100`（テナントA）と `everyMs: 1000`（テナントB、後から `start()`）を動かすと、scheduler は1つ
（`every: 1000`）になり、6秒間の7回の tick は A に4回・B に3回と、どちらの Worker が拾うかで振り分けられた。A は 100ms ごとには ticks されない。
`jobName` をテナントごとに分けると、200ms・3秒で A も B も15回ずつ tick され、scheduler は2つになった。）

**同じ `queueName` に、`everyMs` を変えて `start()` し直しても同じである。**`start()` は `upsertJobScheduler` で登録するので、**後から `start()` した
driver の `everyMs` で共有の scheduler が置き換わり**、先に動いていた driver の間隔も変わる（【実測】1000ms で動いていたものが、別の driver の `start()` で 200ms になり、
さらに 1000ms の driver の `start()` で 1000ms に戻った）。同じ driver の `start()` を重ねて呼んでも何も変わらない。`everyMs` を後から変える口は無いので、
変えたいときは新しい driver を作って `start()` する（古い driver の `stop()` は、上のとおり新しい登録を消すので、呼ぶ順に注意）。

詳しい API（`CreateBullmqTickDriverOptions` の各フィールド）は
[`src/tick-driver.ts`](./src/tick-driver.ts) の doc コメントを見ること。

## ⚠ 完了したジョブは直近 1000 件だけ残る。失敗したジョブは Redis に残り続ける

[ADR 0548](../../docs/decisions/0548-bullmq-lock-duration-and-remove-on-complete-default.md) から、この driver は繰り返しジョブの template に
`removeOnComplete: { count: 1000 }` を既定で入れる。完了したジョブは新しい順に 1000 件だけ Redis に残り、古いものは BullMQ が消す。
件数は `completedJobsToKeep`（`0` 以上の整数）で変えられる。

```ts check
import type { CreateBullmqTickDriverOptions } from "@mnemora/bullmq";

declare const base: CreateBullmqTickDriverOptions;

// 完了したジョブを 100 件だけ残す。
const opts: CreateBullmqTickDriverOptions = { ...base, completedJobsToKeep: 100 };
void opts;
```

⚠ **以前（ADR 0548 より前）は `removeOnComplete` の指定が無く、完了したジョブも全部残っていた。** 以前の「全部残す」に近づけたいなら
`completedJobsToKeep: Number.MAX_SAFE_INTEGER` を渡す。`0` は完了したらすぐ消す。完了ジョブの `returnvalue`（`TickResult`）を後から
`queue.getJobs(["completed"])` で読んでいた人は、古い分が読めなくなる。

**`removeOnFail` は指定していない。** BullMQ（6.3.8）は、指定が無いとき失敗したジョブを**全部残す**（`redis-queue-backend.js` の `getKeepJobs` が
`{ count: -1 }` を返す）。`runtime.tick()` が throw した回は、失敗の理由と stack を持った失敗ジョブとして残る。失敗は調べる材料なので、
消す口は足していない（`completedJobsToKeep` は完了だけに効く）。（【実測】redis-server 7.4.7・bullmq 6.3.8、ADR 0449。ADR 0548 の前の状態。
`everyMs: 50` で5秒走らせると、`getJobCounts` が完了41・失敗13（tick を4回に1回 throw させた）、その queue のキーが66個、`MEMORY USAGE` の合計が約83.5KB
（1ジョブあたり約1.5KB。戻り値が `{}` の最小の場合で、実際の `TickResult` や失敗ジョブの stack ではこれより大きい）だった。ADR 0548 の後の完了ジョブの
頭打ちは、CI の `tick-driver.shared-scheduler.redis.test.ts` が縛る。手元の Redis では測っていない。）

失敗したジョブが溜まるのが気になるなら、Queue の側で掃除する。同じ `queueName` の `Queue` を自分で作り、
BullMQ の `queue.clean(grace, limit, type)` を定期的に呼ぶ（`grace` ミリ秒より古いジョブを、`type` ごとに最大 `limit` 件消す）。

```ts check
import { Queue } from "bullmq";

const queue = new Queue("mnemora-tick", { connection: { host: "127.0.0.1", port: 6379 } });
// 1時間より古い完了ジョブと、1日より古い失敗ジョブを、それぞれ最大1000件消す（完了ジョブは driver の既定でも 1000 件に頭打ちになる）。
await queue.clean(60 * 60 * 1000, 1000, "completed");
await queue.clean(24 * 60 * 60 * 1000, 1000, "failed");
await queue.close();
```

（【実測】redis-server 7.4.7・bullmq 6.3.8。この形の `queue.clean` は、上の driver が溜めた完了42件・失敗13件を、`grace: 0`・`limit: 0`（無制限）で全部消した。`limit` を付けたときは
その件数までである。ADR 0548 の前の状態での測定。）

## ⚠ `everyMs`・`jobName` は構築時に検査する（`queueName` は BullMQ が検査する）

`createBullmqTickDriver(...)` は、`concurrency`（正の整数）に加えて `everyMs`・`jobName` を構築時に検査し、不正なら投げる（`Queue`・`Worker` は作らず、Redis にも繋がない）。
[ADR 0477](../../docs/decisions/0477-bullmq-tick-driver-everyms-jobname-queuename-not-checked.md) が測ったとおり、検査しないと `start()` が成功したまま tick が黙って止まる入力があったため
（[ADR 0498](../../docs/decisions/0498-constructor-config-checks.md)）。

| 入力 | 結果 |
|---|---|
| `everyMs` が数・有限・`1` 以上・`Number.MAX_SAFE_INTEGER` 以下 | 通る。小数（`1.5`）も通り、BullMQ が切り捨てた間隔（`1` ms）で動く |
| `everyMs` が負・`0`・`1` 未満の小数・`NaN`・`Infinity`・`MAX_SAFE_INTEGER` 超（`1e21` を含む）・数値の文字列（`"50"`）・`null`・`undefined` | **構築時に投げる**（数でなければ `TypeError`、数として不正なら `RangeError`） |
| `jobName` を省略 | 既定 `"mnemora-tick"` |
| `jobName` が空でない文字列（`:` を含む・空白・日本語・300 文字も） | 通る |
| `jobName` が空文字・文字列でない | **構築時に投げる**（文字列でなければ `TypeError`、空文字なら `RangeError`） |
| `lockDuration` を省略 | Worker に渡さない（BullMQ の既定 30000 ms） |
| `lockDuration` が `1` 以上 `Number.MAX_SAFE_INTEGER` 以下の整数 | 通り、Worker にそのまま渡る（ADR 0548） |
| `lockDuration` が `0`・負・小数・`NaN`・`Infinity`・`MAX_SAFE_INTEGER` 超・数でない（`"30000"`・`null` など） | **構築時に投げる**（数でなければ `TypeError`、数として不正なら `RangeError`） |
| `completedJobsToKeep` を省略 | 既定 `1000`（`removeOnComplete: { count: 1000 }`）。ADR 0548 |
| `completedJobsToKeep` が `0` 以上 `Number.MAX_SAFE_INTEGER` 以下の整数 | 通り、`removeOnComplete: { count }` になる |
| `completedJobsToKeep` が負・小数・`NaN`・`Infinity`・`MAX_SAFE_INTEGER` 超・数でない | **構築時に投げる**（数でなければ `TypeError`、数として不正なら `RangeError`） |
| `queueName` が空文字・`:` を含む | BullMQ が `createBullmqTickDriver(...)` の中で同期的に投げる（driver は検査しない） |
| `queueName` が空白・日本語・300 文字 | 動く |

（検査を足す前の測定【実測】redis-server 7.4.7・bullmq 6.3.8: 負の `everyMs`・`1` 未満の小数・`1e21`・空文字の `jobName` は `start()` が成功し、tick が数回（`1e21`・空文字は1回）で止まり `onTickError` も鳴らなかった。`0`・`NaN`・`null` は `start()` が reject、`Infinity` は Lua のエラーで reject した。数字は ADR 0477。）

`concurrency`・`lockDuration`・`completedJobsToKeep` が不正なときも同じ形で投げる（検査の順は `everyMs` → `jobName` → `concurrency` → `lockDuration` → `completedJobsToKeep`。数でなければ `TypeError`、小数・`NaN`・`1` 未満なら `RangeError`）。message は [ADR 0525](../../docs/decisions/0525-config-error-types-align-with-provider.md) の前後で変わらない（型だけが素の `Error` から変わった）。

⚠ **利用側は、不正な設定のまま既に動かしていたコードが、更新後は構築時に投げる。** 移行は [migration-v1](../../docs/migration-v1.md) の 🔴 56。

## ⚠ エラーの通知先（`onTickError`）

- **`onTickError` を渡さないと、tick 自体の失敗は誰にも知らされない。**`runtime.tick()` の throw（BullMQ の `'failed'`）も、
  Worker の `'error'`（接続エラーなど）も、driver は `opts.onTickError?.(err)` へ渡すだけで、
  渡していなければ何も出さない（[`src/tick-driver.ts`](./src/tick-driver.ts)）。ログにも例外にもならず、
  tick が動かないまま見た目は静かである。**本番で使うなら渡すこと**（ログに出す・メトリクスに積むなど）。
  ```ts check
  import { createBullmqTickDriver } from "@mnemora/bullmq";
  import type { CreateBullmqTickDriverOptions } from "@mnemora/bullmq";

  declare const base: CreateBullmqTickDriverOptions; // 必須の項目（connection・queueName・runtime など）

  createBullmqTickDriver({
    ...base,
    onTickError: (error) => console.error("mnemora tick failed", error),
  });
  ```
- 🔴 **`onTickError` を渡せば「失敗が全部分かる」わけではない。**`onTickError` に届くのは、`runtime.tick()`（と `onTickResult`）の
  throw と、Worker・Queue の異常だけである。tick の中の**個々のジョブ（outbox の行）が失敗しても、tick が throw しなければ
  `onTickError` は鳴らない**——その tick は成功として返り、失敗は戻り値の `TickResult` に数として載る。
  - **個々のジョブの失敗は `onTickResult` で見る。**`TickResult.failed` は、その tick で `outboxStore.fail()` を呼んで
    リース競合で弾かれなかった件数、`TickResult.unsupported` は `failed` の内訳のうち「`tick` がその kind を処理する分岐を
    持っていなかった」ジョブの配列である（`unsupported` に入ったジョブも `failed` に数える。
    フィールドの定義は `packages/core` の `TickResult`）。
    ```ts check
    import { createBullmqTickDriver } from "@mnemora/bullmq";
    import type { CreateBullmqTickDriverOptions } from "@mnemora/bullmq";

    declare const base: CreateBullmqTickDriverOptions; // 必須の項目（connection・queueName・runtime など）

    createBullmqTickDriver({
      ...base,
      onTickResult: (result) => {
        if (result.failed > 0) {
          console.warn("mnemora tick: jobs failed", {
            failed: result.failed,
            unsupported: result.unsupported,
          });
        }
      },
    });
    ```
  - **失敗した行そのものは、outbox の `last_error` 列（`text`）で見る。**`TickResult` は件数と
    `unsupported` の名指ししか持たないので、「どの行が・なぜ」は DB を引くこと。
  - ⚠ `failed` の件数は「行が終端 `failed` になった数」と常に一致するとは限らない（コミット後の接続断など。`TickResult.failed` の
    doc、Issue #836）。
  - `onTickError` の守備範囲は変えていない。`failed > 0` で `onTickError` を呼ぶ形や、`TickResult` の形を変える形は採っていない。
- **`Queue` 側のエラーも `onTickError` に届く**（`onTickError` を渡しているとき）。driver は `Worker` の
  `'error'`・`'failed'` に加え、`Queue`（繰り返しジョブの登録に使う）の `'error'` にも listener を付け、
  Redis 接続の失敗などを `onTickError` へ渡す。以前は `Queue` に listener が無く、bullmq が `console.error` へ
  固定で出すだけだった。
  - **`onTickError` を渡さないときは、`Queue` に listener を付けない。**付けると bullmq（6.3.8 の `QueueBase.emit`:
    listener の無い `'error'` は EventEmitter が throw し、bullmq がそれを捕まえて `console.error` へ出す）の
    既定の出力が消え、`Queue` の異常が完全に黙るため。渡していなければ従来どおり標準エラーに出る
    （`Worker` 側は従来から、渡していなければ黙る）。
  - **同じ障害で、`onTickError` が複数回呼ばれうる。**`Queue` と `Worker` は別々の Redis 接続を持ち、接続ごとに
    `'error'` を出す。Redis が落ちると両方が出す——同じ事象の重複ではなく別の接続の事象なので、driver は束ねない。
    tick の失敗（`'failed'`）は、1回の失敗につき1回。通知のたびに通知先（アラートなど）が鳴るなら、
    呼び出し側で間引くこと。
  - 【実測】Redis が居ないポートを指した `Queue` と `Worker` は、それぞれ `ECONNREFUSED` を emit した
    （bullmq 6.3.8、Redis 無しで確かめた）。**Redis が在る状態での `Queue` の失敗は測っていない**
    （歯は fake の `Queue` が emit する形で縛っている）。
  - 【実測】redis-server 7.4.7・bullmq 6.3.8。**Redis が在る状態で、動いている driver の Redis を止める**と、6秒間で `onTickError` が30回（すべて `ECONNREFUSED`。Queue と Worker の2接続で、再接続のたびに）届いた。
    Redis を **永続化あり（`appendonly yes`）で再起動すると、tick は自動で再開した**（5秒で25回）。**永続化なしで再起動すると、scheduler が Redis ごと消えるので、tick は再開せず、
    `onTickError` も鳴らない**（driver は `start()` のときにしか登録しない）。キャッシュ用途の Redis（永続化なし）を使うなら、再起動のあとに `start()` し直す仕組み
    （新しい driver を作り直す）が要る。
  - 【実測】redis-server 7.4.7・bullmq 6.3.8。**Redis が落ちている間の `start()` は、reject せず、少なくとも15秒 pending のままだった**（`maxRetriesPerRequest: null` でも、指定しなくても。その間 `onTickError` には
    ECONNREFUSED が届く）。Redis が戻ると resolve した。「失敗したら reject し、もう一度 `start()` すればやり直す」（Issue #963）は、接続が拒まれる間は効かない。
    `start()` に自分でタイムアウトを掛けるなら、その後の `stop()` で後始末すること。
  - 【実測】redis-server 7.4.7・bullmq 6.3.8。`connection` に **ioredis のインスタンス**を渡すとき、`maxRetriesPerRequest: null` を指定していないインスタンス（ioredis の既定は 20）だと、
    `createBullmqTickDriver(...)` が `BullMQ: Your redis options maxRetriesPerRequest must be null.` で**同期的に throw** する（`start()` ではなく構築の時点）。`null` を指定したインスタンスは動き、
    `stop()` の後もそのインスタンスは閉じられない（`status` は `ready` のまま。呼び出し側が閉じる）。オプションのオブジェクトを渡した場合は、BullMQ が警告を出して上書きする。
  - 【実測】redis-server 7.4.7・bullmq 6.3.8。**Redis が在る状態で、動いている driver の Redis を止める**と、6秒間で `onTickError` が30回（すべて `ECONNREFUSED`。Queue と Worker の2接続で、再接続のたびに）届いた。
    Redis を **永続化あり（`appendonly yes`）で再起動すると、tick は自動で再開した**（5秒で25回）。**永続化なしで再起動すると、scheduler が Redis ごと消えるので、tick は再開せず、
    `onTickError` も鳴らない**（driver は `start()` のときにしか登録しない）。キャッシュ用途の Redis（永続化なし）を使うなら、再起動のあとに `start()` し直す仕組み
    （新しい driver を作り直す）が要る。
  - 【実測】redis-server 7.4.7・bullmq 6.3.8。**Redis が落ちている間の `start()` は、reject せず、少なくとも15秒 pending のままだった**（`maxRetriesPerRequest: null` でも、指定しなくても。その間 `onTickError` には
    ECONNREFUSED が届く）。Redis が戻ると resolve した。「失敗したら reject し、もう一度 `start()` すればやり直す」（Issue #963）は、接続が拒まれる間は効かない。
    `start()` に自分でタイムアウトを掛けるなら、その後の `stop()` で後始末すること。
  - 【実測】redis-server 7.4.7・bullmq 6.3.8。`connection` に **ioredis のインスタンス**を渡すとき、`maxRetriesPerRequest: null` を指定していないインスタンス（ioredis の既定は 20）だと、
    `createBullmqTickDriver(...)` が `BullMQ: Your redis options maxRetriesPerRequest must be null.` で**同期的に throw** する（`start()` ではなく構築の時点）。`null` を指定したインスタンスは動き、
    `stop()` の後もそのインスタンスは閉じられない（`status` は `ready` のまま。呼び出し側が閉じる）。オプションのオブジェクトを渡した場合は、BullMQ が警告を出して上書きする。

## ⚠ lock の期限切れ（stalled）で、1回の tick に `onTickResult` と `onTickError` の両方が届きうる

🔴 **【実測】redis-server 7.4.7・bullmq 6.3.8（ADR 0449）。** ソースの読み（`dist/cjs/classes/worker.js` の `processJob`・`retryIfFailed`、ADR 0440）のとおりだった。
2つの OS プロセスが同じ `queueName` で動き、一方の `runtime.tick()` がイベントループを45秒塞ぐ（lock を延長できない）と、**もう一方の Worker が約60秒後（lock の期限30秒の後、次の stalled checker の周期）に
同じジョブの2本目の tick を走らせ**、塞いでいた1本目は45.8秒で戻ってから `onTickResult` を呼び、**直後に `onTickError` が2回**（`Missing lock for job ... moveToFinished`、0.1秒以内）届いた。
最終のジョブは完了1件・失敗0件で、`attemptsStarted: 2`・`stalledCounter: 1`。（以下の箇条書きの「読み」は、この実測で裏づいた。`lockDuration` 既定30000ms の値は `worker.js` の読みのまま。）

- BullMQ は、Worker が処理中のジョブの lock を `lockDuration`（既定 30000 ms）で持ち、その半分の間隔で延長する。**この driver は `lockDuration` を渡さない限り設定しない**（ADR 0548 より前は口が無かった。省略すると `Worker` には bullmq の既定値が渡る。`lockDuration` オプションで変えられる）。`runtime.tick()` がイベントループを長く塞ぐ・Redis との接続が途切れるなどで lock の延長が間に合わずに期限が切れると、stalled checker（既定 `stalledInterval` 30000 ms）がそのジョブを wait へ戻し、**別の Worker が2本目の tick を走らせうる**（同じジョブの再実行）。
- **データは壊れない。** 2本の tick が重なっても、outbox の行は `claimBatch` の行ロック・リース・CAS（`attempts`）で二重に処理されない（「複数プロセスで動かすとき」と同じ守り）。driver も同じジョブを二重に数えない。
- **ただし通知は素直ではない。** 遅れて終わった1本目は、processor の中で `onTickResult` を呼んだあと、BullMQ が完了を記録する `moveToCompleted` を `Missing lock` で失敗させ、Worker の `'error'` 経由で **`onTickError` に届きうる（2回届く読み）**。つまり**その tick の `onTickResult` が届いたあとに `onTickError` が鳴る**ことがある。`onTickError` を「tick が動かなかった」の意味でだけ扱うと、この場合は誤る。
- **対処: `lockDuration` を、1回の tick が塞ぎうる時間より長くする**（ADR 0548。ミリ秒の正の整数。例: `lockDuration: 120_000`）。省略すると BullMQ の既定（30000 ms）。長くすると、プロセスが落ちたときに別の Worker が引き継ぐまでの時間も伸びる。`stalledInterval` など、ほかの Worker の設定は通していない。driver で束ねることもしていない。`lockDuration` を足すまでの経緯は [ADR 0440](../../docs/decisions/0440-outbox-first-terminal-wins-extraction-local-date-years-bullmq-stalled.md) の決定4・[ADR 0449](../../docs/decisions/0449-bullmq-tick-driver-measured-against-real-redis.md) の材料6・[ADR 0548](../../docs/decisions/0548-bullmq-lock-duration-and-remove-on-complete-default.md)。`onTickError` のログには、同じ時刻の `onTickResult` があるかを見ること。⚠ `lockDuration` を長くして stalled が出なくなることは、実 Redis では測っていない（BullMQ の仕様の読みと、mock で Worker に値が渡ることだけ）。

## 確かめていないこと

- BullMQ の Job Scheduler が実運用のワークロードでどの程度「重なる」かは測っていない。
- BullMQ 自身の可用性・再接続・Redis 障害時の挙動は、「エラーの通知先」の実測（Redis を止めて再起動、`start()` が pending のまま）の範囲だけ測った。Redis Cluster・Sentinel・フェイルオーバーは測っていない。
- 複数マシン・ネットワーク越しの複数 OS プロセスからの同時 tick は測っていない
  （同一ホスト上の複数 OS プロセスまでは ADR 0325 の歯が測っている）。

（詳細は [ADR 0325](../../docs/decisions/0325-bullmq-tick-driver.md) の
「確かめていないこと」「引き受けた負債」を見ること）
