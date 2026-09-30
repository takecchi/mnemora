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
  純関数（`resolveConcurrency`）だけを検査し Redis を要らないが、`test:redis`
  （`pnpm --filter @mnemora/bullmq run test:redis`）は実際に BullMQ の `Queue`/`Worker` を
  構築するため Redis を要る（`.github/workflows/ci.yml` の `bullmq` job は
  `redis:7` の service container を使う）
- `runtime` は `Pick<Runtime, "tick">`——`@mnemora/core` の `createRuntime()` が返す
  `Runtime` 全体ではなく、`tick` メソッドさえ満たせば渡せる

## 動く最小の例（Redis が無いため未実行——型のみ確認）

```ts
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

詳しい API（`CreateBullmqTickDriverOptions` の各フィールド）は
[`src/tick-driver.ts`](./src/tick-driver.ts) の doc コメントを見ること。

## ⚠ エラーの通知先（`onTickError`）

- **`onTickError` を渡さないと、tick 自体の失敗は誰にも知らされない。**`runtime.tick()` の throw（BullMQ の `'failed'`）も、
  Worker の `'error'`（接続エラーなど）も、driver は `opts.onTickError?.(err)` へ渡すだけで、
  渡していなければ何も出さない（[`src/tick-driver.ts`](./src/tick-driver.ts)）。ログにも例外にもならず、
  tick が動かないまま見た目は静かである。**本番で使うなら渡すこと**（ログに出す・メトリクスに積むなど）。
  ```ts
  createBullmqTickDriver({
    // ...
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
    ```ts
    createBullmqTickDriver({
      // ...
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

## 確かめていないこと

- BullMQ の Job Scheduler が実運用のワークロードでどの程度「重なる」かは測っていない。
- BullMQ 自身の可用性・再接続・Redis 障害時の挙動は検査していない。
- 複数マシン・ネットワーク越しの複数 OS プロセスからの同時 tick は測っていない
  （同一ホスト上の複数 OS プロセスまでは ADR 0325 の歯が測っている）。

（詳細は [ADR 0325](../../docs/decisions/0325-bullmq-tick-driver.md) の
「確かめていないこと」「引き受けた負債」を見ること）
