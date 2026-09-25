# ADR 0325: `@mnemora/bullmq` は `Scheduler` を実装せず、BullMQ で `runtime.tick()` を駆動する（Issue #205 の2本目）

⚠ **この番号は 2026-09-25 時点で `node scripts/adr-renumber.mjs`（引数無し）を実行して
確定させたものである。** 当初 `--next` が返した楽観的な次番号は `0324` だったが、
`git merge origin/main` の後にこのブランチ上で `adr-renumber.mjs` を実行したところ、
その間に別 PR（Issue #372、PR #745）が `ADR 0324`（`0324-claim-key-contested-detection.md`）
を先に使っていたため衝突し、`0325` へ自動的に付け替わった（ファイル名・本ファイルの見出し・
`docs/architecture.md`・`docs/roadmap.md`・`docs/decisions/0206-*.md` の参照を機械的に
書き換えた。`packages/bullmq/**` と `.github/workflows/ci.yml` は対象外だったため手で直した
——下の「引き受けた負債」参照）。

**通常、ADR を追加する PR の作成者はこのスクリプトを実行しない**
（`docs/decisions/README.md`「ADR を追加する PR の作成者は、原則としてこのスクリプトを
実行しない」——並行 PR 間の索引の行衝突を防ぐ設計、ADR 0137）。**この PR に限っては、
依頼元（クローン）の明示の指示により、Ready の前にこの担い手が実行した。**
⚠ **それでもなお、実際にマージされる直前に再度衝突する可能性は残る**——この実行と
実際のマージの間に、別の ADR PR が `0325` を先に取る形で着地すれば、再び付け替えが要る。
その場合は同じ手順（`git fetch && git merge origin/main` → `adr-renumber.mjs` →
`generate-adr-index.mjs`）をもう一度踏むこと。

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

**⚠ 各主張の出所を分ける**（ADR 0206 と同じ体裁）。

- **【現物】** — この repo のコード・文書・`gh` の出力を、この書き手が自分で読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。この ADR では特に、
  「オーナーが 2026-09-25 に『機能改善・追加改修もどんどん』と述べたことをクローン miku が
  Issue #205 の 9/17 判定の根拠④への上書きと判断した」という一節は、**このセッションを
  委任したマネージャーからの申し送りであり、この書き手自身は当該発言の一次ソース
  （issue コメント・チャット等）を確認していない。** 探した範囲（`gh search issues`/
  `gh search prs` で「機能改善」「機能改善・追加改修」を検索）では該当する逐語は
  見つからなかった——**見つからなかった、というだけであり、存在しないことの証明ではない**
  （`docs/autonomy.md` §5「他のエージェントの報告を、そのまま事実として引かない」）。

---

## 問い

[Issue #205](https://github.com/takecchi/mnemora/issues/205) は「実質2本に割れる」と自認していた:

1. `OutboxStore.claimBatch` の同時 claim 適合テスト — [ADR 0206](./0206-outbox-concurrent-claim-conformance.md)（PR #450）で着地済み。
2. **`packages/bullmq` 本体** — 本 ADR の対象。

**この2本目は、2026-09-17 に「いま着手すべきでない」と判定されていた**（Issue #205 コメント、
【現物】）。根拠は4点:

1. 受け入れ条件「`packages/bullmq` が `packages/testkit` の適合テストを通る」が、
   `Scheduler` の適合 suite がそもそも存在しないため文字どおり成立しない。
2. ADR 0206 自身が「`packages/bullmq` が入った日に、この判定は即座にひっくり返る」と
   名指しで警告していた（負債2: 単一プロセス内の複数接続までしか測っていない）。
3. v1.0.0 が出る前に入れると、v1.0.0 の判定材料を自分で増やすことになる。
4. `docs/autonomy.md` §1「何を選ぶか」の4段（壊れている／北極星を動かす／その前提／
   測れていないものを測る）のどれにも当たらない——本文が自認している。

**本 ADR は、この4点を1つずつ検討し直したうえで着手する。**

### 根拠①(受け入れ条件)への応答 —— `Scheduler` を実装しない

Issue #205 本文の受け入れ条件は「`Scheduler` interface を BullMQ で実装し、その適合 suite を
`packages/testkit` に新設して通す」ことを前提にしていた。**本 ADR はその前提を採らない。**

【現物】`packages/core/src/interfaces/scheduler.ts` の `Scheduler.enqueue` は、
2026-09-25 時点で本番コードのどこからも呼ばれていない
（`grep -rn "\.enqueue(" packages/*/src examples/*/src` が `InlineScheduler` 自身の実装
以外に呼び出し箇所を返さない）。`InlineScheduler`（`packages/core/src/inline-scheduler.ts`）が
唯一の実装であり、`runtime.observe()` の内部で同期的に使われるだけである。

⟹ **`Scheduler` を実装しても、呼び手が無い。** 適合 suite を新設するコストを払っても、
検査する対象（呼ばれ方の契約）がほぼ無い——`docs/roadmap.md` §1.2 が testkit を Phase 1 に
入れた理由（「差し替え可能は、実行可能な適合テストが無ければ願望にすぎない」）を、
形だけ満たして中身で裏切ることになる、と 9/17 の判定が指摘したとおりである。

**⟹ 根拠①はそもそも前提が違う受け入れ条件だった、として回避する**（満たすのではなく、
その受け入れ条件を要求しない設計を採る）。

### 根拠②(ADR 0206 の警告)への応答 —— この歯で負債2を埋めにいく

**根拠②はそのまま有効な警告であり、本 ADR はこれを正面から引き受ける。** 下の「測ったこと」で、
複数 OS プロセス・複数 `pg.Pool` に対する同時 claim を実測する。

### 根拠③(v1.0.0 前)への応答 —— 消えた

**【実測】`gh release list` で `v1.0.0` は `2026-09-22T23:54:08Z` に出ている
（tag `v1.0.0`、`Latest` マーク付き）。** ⟹ 「v1.0.0 の前に入れると判定材料を増やす」という
懸念は、v1.0.0 が既に出たことで前提が消えた。

### 根拠④(`docs/autonomy.md` §1 の4段に当たらない)への応答 —— クローンの上書きと見る（【受】）

9/17 の判定は「北極星の物差しを直接は動かさない」「段3（前提）にすら当たらない可能性がある」と
自認していた。**この書き手はこれを、マネージャーからの申し送り
（オーナーの 2026-09-25 の発言「機能改善・追加改修もどんどん」をクローン miku が
根拠④への上書きと判断した）に基づいて進める。** ⚠ 上の「出所の印」に書いたとおり、
この一次ソースはこの書き手自身では確認していない——**オーナー本人の直接の決定ではなく、
クローンの判断であるという区別を保ったまま扱う**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) と同じ注意）。

**⟹ 根拠④は「消えた」のではなく「クローンの判断で上書きされた、と申し送られている」。**
オーナー本人がこれを直接決定したのかどうかは、この書き手からは判定できない。

---

## 決定

### 1. 案B: `@mnemora/bullmq` は BullMQ で `runtime.tick()` を駆動する役

**検討した3案**（Issue #424・Issue #205 のコメント史で既に名前が付いていたものを踏襲）:

- **案A: `BullMQScheduler implements Scheduler`。**
  ⛔ **採らない。** 上の「根拠①への応答」のとおり `Scheduler.enqueue` に呼び手が無い。
  実装しても本番経路のどこにも繋がらない飾りになる。
- **案C: outbox → BullMQ への relay。**
  `docs/decisions/0005-job-queue-abstraction.md`「理由」2番が触れている「実際のキューへは
  relay が outbox の未処理行を読んで渡す」という設計。
  ⛔ **採らない。** relay を作ると、ジョブの状態（claim/complete/fail）を Postgres の
  outbox と Redis 側の BullMQ ジョブの**両方**に持つことになる——「outbox が正本」という
  transactional outbox の設計（ADR 0005「理由」2番、`docs/architecture.md` §3.4）が崩れ、
  2つの帳簿の整合を新たに保証する必要が生まれる。`packages/core` にも relay を差し込む
  ための手が入る（`⛔ packages/core・packages/postgres の src には触れない` という本作業の
  制約にも反する）。
- **案B: BullMQ は「いま tick して」という合図だけを運び、ジョブの中身を持たない。**
  ⭕ **採用。** `Scheduler` を実装しない——`@mnemora/bullmq` は `@mnemora/core` の
  公開面（`Runtime.tick` / `Ctx` / `TickOptions` / `TickResult`）だけに依存する。
  BullMQ の Worker が発火するたびに、呼び出し側が組み立てた `runtime.tick(ctx, opts)` を
  呼ぶだけである。outbox は今日どおり Postgres が正本のまま。

**実装**: `packages/bullmq/src/tick-driver.ts` の `createBullmqTickDriver(opts)`。
BullMQ 6.x の Job Scheduler（`queue.upsertJobScheduler`）で繰り返しジョブを登録し、
Worker が発火のたびに `opts.runtime.tick(opts.ctx, opts.tick)` を呼ぶ。
`opts.runtime` の型は `Pick<Runtime, "tick">`——`Runtime` 全体ではなく `tick` だけを要求する
（呼び出し側が `Runtime` 全体を持っていなくても、`tick` さえ満たせば渡せる）。

**default（既定の振る舞い）は変えていない。** `InlineScheduler` と手動 `tick()` 呼び出しは
今日どおりで、`@mnemora/bullmq` を import しない限り何も変わらない——
[docs/north-star.md](../north-star.md) 末尾の表が「Scheduler / BullMQ を必須にする」を
**既に落とした案**として記録しているとおり（問い2）。

### 2. `private: true`。`scripts/publish-targets.mjs` には入れない

`package.json` の `version` は `0.0.0`（root と同じ、Release の tag が版の権威を持つという
[ADR 0070](./0070-version-comes-from-the-release-tag.md) に従い、publish しないパッケージに
手で版を振らない）。

npm に出すかどうかは今回決めない——**オーナーへ上げる**。初版を OIDC で publish することは
できない（npm/cli#8544 は 2026-09-25 時点で OPEN。[ADR 0066](./0066-npm-trusted-publishing.md)）
ため、初回 publish にはオーナーの手が要る。

### 3. CI に専用 job を1本足す。required には入れない

`.github/workflows/ci.yml` に `bullmq` job を足した——`pgvector/pgvector:pg17` と `redis:7` の
2つの service container を持つ。**required status check には入れていない**
（`.github/required-status-checks.json` は書き換えていない。【実測】
`node scripts/check-required-status-checks.mjs` はこの PR のブランチ上でも
`一致（match）` を返す——宣言と branch protection の実物は今日どおり6件のままで揃っている）。

**既存の検査スクリプトへの影響を実測した**（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」・
「新しい job を足すことで既存の検査スクリプトが赤くなるかは確かめる」という本作業の要求への
応答）:

- `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` が最初に赤くなった——
  「`image: pgvector/pgvector:pg17` を使う service は全部 `POSTGRES_INITDB_ARGS` を宣言し、
  matrix 化していない全ジョブは `postgres` job の UTF8 脚と同じ値を持つ」ことを固定する歯
  （Issue #148 ②/Issue #224）。新しい `bullmq` job も pgvector イメージを使う
  （`registerEmbeddingSpace` が `vector(N)` 列を作るため pgvector が要る）ので、
  この歯の対象に含まれる。**`POSTGRES_INITDB_ARGS: "--encoding=UTF8"` を足して解消した**
  （`example-chat` job など、regime を測らない他の pgvector job と同じ扱い）。
- `scripts/__tests__/ci-yml-measurement-jobs-wiring.test.mjs`・
  `scripts/__tests__/workflow-name-comment-wiring.test.mjs`・
  `scripts/__tests__/workflow-yaml-parses.test.mjs` はいずれも
  **固定リスト（job id・ファイル名）を対象にする歯であり、新しい job を足しただけでは
  赤くならない**——【実測】全部緑のままだった。
- `scripts/__tests__/publish-targets.test.mjs`・`check-public-api-surface.test.mjs`・
  `check-publish-pack*.test.mjs`・`check-cjs-transpile-parse.test.mjs` は
  `scripts/publish-targets.mjs` の `PUBLISH_TARGETS`（固定リスト）だけを対象にする——
  `@mnemora/bullmq` をそこへ入れていないので対象外のまま。【実測】全部緑。
- `pnpm-workspace.yaml` の `allowBuilds` に `msgpackr-extract: false` を明示で足した
  （bullmq が推移的に持ち込む optional native アドオン。`pnpm install` が既定で
  `ERR_PNPM_IGNORED_BUILDS` を出すのを、`@mnemora/local-embedding` の3件と同じ形で
  「拒否した」と記録する側に倒した）。

### 4. スクリプト名: Redis を要るテストは `test:redis`

`scripts/run-db-tests.mjs` は `test:db` を持つ workspace を `pnpm list --recursive --json` から
動的に発見し、ルートの `pnpm run test`（DATABASE_URL 在りのとき）で自動的に走らせる
（AGENTS.md「ルートの `pnpm run test` は、DB テストを走らせたかどうかを必ず報告する」・
ADR 0015）。**`test:db` という名前を使うと、Redis の無い既存ジョブ（`root-gate-db-stage` 等）で
自動的に拾われて実行され、赤くなる。** ⟹ `packages/bullmq/package.json` の `test:redis` は
`test:db` と綴りを変え、`run-db-tests.mjs` の対象から外れる（【実測】
`grep -n "test:db" scripts/run-db-tests.mjs` を確認し、対象キーが `test:db` 固定であることを
読んで確かめた）。

`test`（Redis 不要、`resolveConcurrency` の純関数のみ検査）は `pnpm -r --if-present run test`
経由で既存ジョブでも緑になる——【実測】`pnpm --filter @mnemora/bullmq run test` → `Test Files
1 passed (1)` / `Tests 4 passed (4)`。

`vitest.config.mts`（既定）は `**/*.redis.test.ts` を除外し、`vitest.redis.config.mts` は
逆にそれだけを対象にする——2つの設定ファイルで切り分ける形を採った
（`packages/postgres` の `test:db` は全テストが DB 前提なので分ける必要が無く、この形の前例は
`packages/bullmq` が最初である）。

### 5. 歯の本体: 複数 OS プロセスの同時 tick が outbox を二重処理しないこと

`packages/bullmq/src/__tests__/concurrent-tick.redis.test.ts`(親) +
`concurrent-tick-child.ts`(子、`pnpm exec tsx` で spawn される別 OS プロセス)。

- K 個の子プロセスを実際に `node:child_process.spawn` で立てる。各子プロセスは
  **自分専用の `pg.Pool`**（`createPostgresClient` を自分で呼ぶ、接続は事前に温める）と
  **自分専用の BullMQ `Worker`**（同じ `queueName` を共有）を持つ。
  `EmbeddingProvider` は「呼ばれた `texts` を記録するだけ」の fake
  （決定5「embedding provider 等は数を数える fake でよい」）。
- 🔴 **2026-09-25 改訂（ADR 0206「測ったこと3」の知見に倣う）**: `it` の中で
  **`ROUNDS` 回の独立したラウンド**を回す。各ラウンドで、親が**小さいバッチ**
  （`BATCH_SIZE` 件）の Memory + embed ジョブを outbox へ積み、直後に BullMQ の
  queue へ「起爆ジョブ」（中身は空。Worker は job の中身を見ず、発火のたびに
  `runtime.tick()` を1回呼ぶだけ）を `BURST_SIZE`（≧ 全ワーカー数）件まとめて積む
  （`queue.addBulk`）。**BullMQ の repeat ジョブ（背景の心拍、`EVERY_MS` は大きめ）は
  今も動いているが、重なりを作る主因ではない**——主因はラウンドごとの
  「まとめ撃ち」である（旧設計は repeat ジョブの発火間隔 `EVERY_MS` を embed 遅延
  `EMBED_DELAY_MS` より短くして積み上げに頼っていたが、検出率が最終パラメータでも
  8試行中7回に留まったため、この形に変えた——下の「測ったこと」参照）。
- 全子プロセス・全ラウンドを通じて embed した `content` を集め、**重複が0件であること**
  だけを検査する。⛔ **「合計が用意した本数と一致すること」は検査しない**（ADR 0206
  決定2 と同じ理由——`FOR UPDATE SKIP LOCKED` 相当の実装は競合下で拾い残しを設計上
  許容する。次の tick が拾う）。

---

## 測ったこと【実測】

器: このセッションの担い手が手元に立てた PostgreSQL 17 + pgvector（専用ポート 55432、
専用 PGDATA、`AGENTS.md`「手元で Postgres を立てる」節の手順）と、Redis 7.4.11
（専用ポート 46379。手元に docker/podman/`redis-server` バイナリが無かったため、
Docker Hub の `redis:7-bookworm` イメージの layer を `curl` で取得して展開し、
中の `redis-server` バイナリをそのまま実行した——ホストの glibc 2.41 は
image のベースである Debian bookworm の glibc より新しく、動的リンクがそのまま解決できた。
**CI では `redis:7` の service container を使うため、この手順は手元でだけ要ったもの
であり、CI の再現には関係しない。**）。**測ったときの `main` = `785221a`。**

### プロセス概要とマイグレーション

`concurrent-tick.redis.test.ts` の `beforeAll` が `runMigrations`/`registerEmbeddingSpace` を
直接呼ぶ。⚠ **`@mnemora/core`/`@mnemora/postgres` を事前に build する必要が無い**——
`concurrent-tick-child.ts`（子プロセス）は両パッケージの `src` を**相対 import**で直接読む
（`import ... from "../../../postgres/src/index.js"`）。bare specifier
（`import ... from "@mnemora/postgres"`）だと `node_modules` 経由で `dist/index.js` に
解決され、変異試験のたびに `pnpm --filter @mnemora/postgres run build` を挟まないと
変異が反映されない——相対 import はその手間を構造的に無くす。

### パラメータ調整の過程

最初の設計（接続の事前温め無し・`MEMORY_COUNT=20`・`TICK_LIMIT=5`）は、
`FOR UPDATE SKIP LOCKED` を丸ごと削る変異 (i) に対して **3試行中1試行しか検出できなかった**
——ADR 0206「案F」が単一プロセス内で見つけた「`pg.Pool` は遅延接続であり、接続確立の時間差が
競争の窓を閉じる」という現象が、複数プロセスでも同じ形で起きていた。

`concurrent-tick-child.ts` に ADR 0206 と同じ**接続の事前温め**
（`Promise.all(Array.from({length: concurrency}, () => pool.query("SELECT pg_sleep(0.05)")))`）
を足し、`MEMORY_COUNT`/`CONCURRENCY_PER_CHILD`/`TICK_LIMIT` を調整して検出率を上げた
（詳しい値は `concurrent-tick.redis.test.ts` のコメント参照。最終値:
`MEMORY_COUNT=80` / `CHILD_COUNT=4` / `CONCURRENCY_PER_CHILD=4` / `EVERY_MS=10` /
`EMBED_DELAY_MS=200` / `TICK_LIMIT=1`）。

### 変異試験の表

`packages/postgres/src/outbox-store.ts` を `cp` で退避 → 変異 → 撃つ → `cp` で戻す
（⛔ `git checkout` は使っていない）。**戻した後、同じ歯が緑に戻ることも実測した。**

| 変異 | パラメータ | 試行 | 結果 |
|---|---|---|---|
| （変異なし、初期パラメータ） | 温め無し・`MEMORY_COUNT=20`・`TICK_LIMIT=5` | 4 | 4回とも GREEN |
| **(i) `FOR UPDATE SKIP LOCKED` を丸ごと削る** | 同上 | 3 | 🔴 **1回 RED / 2回 GREEN（見逃し）** |
| **(i) 同上** | 温め追加・`MEMORY_COUNT=60`・`TICK_LIMIT=2` | 5 | 3回 RED / 2回 GREEN |
| **(i) 同上** | 最終パラメータ（上記） | 8 | **7回 RED / 1回 GREEN** |
| （変異なし、最終パラメータ） | 最終パラメータ | 2 | 2回とも GREEN |
| **(ii) `SKIP LOCKED` だけ外して `FOR UPDATE` を残す** | 最終パラメータ | 5 | **5回とも GREEN** |
| （変異を戻した後の確認） | 最終パラメータ | 2 | 2回とも GREEN |

⟹ **歯は噛む。** ただし ⚠ **確率的である——最終パラメータでも100%ではない
（8試行中7回の検出）。** 見逃しが起きても複数回撃てば拾える前提で読むこと
（`AGENTS.md`「⚠『出なかった』を、事象が無いことの証明にしない」の裏返し——
ここでは逆に「出た」を複数回のうち1回でも捕まえられれば十分、という設計判断）。

⟹ **(ii) は ADR 0206 と同じ結論——`SKIP LOCKED` だけを外しても赤くならない。**
`FOR UPDATE` の行ロックが二重 claim を止めており、`SKIP LOCKED` は詰まらないことにしか
効いていない、という ADR 0206 の説明が、複数 OS プロセスの水準でも成り立つ。
⟹ **ADR 0206「引き受けた負債」2（単一プロセス内までしか測っていない）は、
本 ADR の歯で埋まる。** ただしネットワーク越しの複数マシンまでは測っていない
（下の「確かめていないこと」参照）。

### 2026-09-25 追記: ラウンドを複数回す形に改め、再測定した（見逃しを減らす）

**上の表は書き換えていない。**依頼元（クローン）から「歯が1/8で見逃しているのは
この PR の本体の価値にとって弱すぎる」という指摘を受け、ADR 0206「測ったこと3」の
知見（ラウンド数を増やすと見逃しが消える）に倣って歯を改めた——`concurrent-tick.redis.test.ts`
の `it` 1本の中で、**独立したラウンドを複数回す**形にした（決定5の改訂・設計は上記）。

**設計の要点**: 子プロセス4本（`CONCURRENCY_PER_CHILD=4` → 全ワーカー数16）を先に起動し、
`ROUNDS=10` 回、各ラウンドで `BATCH_SIZE=3` 件の Memory を積んだ直後に `BURST_SIZE=24`
件の「起爆ジョブ」（中身は空、`runtime.tick()` を1回呼ぶだけ）を BullMQ の queue へ
`queue.addBulk` でまとめて積む——ADR 0206 の `Promise.all`（同一プロセス内で8並行）を、
複数 OS プロセスへそのまま翻訳した形である。ラウンドあたりの候補行（3件）はワーカー総数
（16）よりずっと少なく、競合を厚くしてある。

器: 同じ手元の PostgreSQL 17（専用ポート 55432）・Redis 7.4.11（専用ポート 46379）。
**測ったときの `main` = `7987de4`**（`git merge origin/main` 後。旧「測ったこと」表の
時点（`785221a`）より進んでいるが、`packages/postgres/src/outbox-store.ts` 自体は
この間変わっていない——`git diff 785221a 7987de4 -- packages/postgres/src/outbox-store.ts`
で確認済み、差分0）。

| 変異 | パラメータ | 試行 | 結果 |
|---|---|---|---|
| （変異なし） | ラウンド版・最終パラメータ（ROUNDS=10・BATCH_SIZE=3・BURST_SIZE=24・TOTAL_WORKERS=16） | 6 | **6回とも GREEN（偽陽性0）** |
| **(i) `FOR UPDATE SKIP LOCKED` を丸ごと削る** | 同上 | 12 | 🔴 **12回とも RED（見逃し0）** |
| **(ii) `SKIP LOCKED` だけ外して `FOR UPDATE` を残す** | 同上 | 5 | **5回とも GREEN**（ADR 0206 と同じ結論、変わらず） |
| （変異を戻した後の確認） | 同上 | 1 | GREEN |

⟹ **見逃しは0になった**（旧パラメータの8試行中1回見逃し → 新パラメータで12試行中0回）。
⚠ **「0になった」は「原理的に0%」の証明ではない**——12試行で観測されなかった、という
以上の主張はしない（`AGENTS.md`「⚠『出なかった』を、事象が無いことの証明にしない」と
対称の注意——ここでは逆に、出続けたことを根拠にしているが、母数は有限である）。
より多くの試行を重ねれば、低確率の見逃しが観測される可能性は残る。

**CI の所要時間の増え方**: 手元では、テスト本体の所要時間が旧パラメータ（1試行あたり
約8.7〜10.5秒、ADR 0325 初版の実測）から新パラメータ（1試行あたり約11.3〜13.5秒、
上記12+6+5+1=24試行の観測範囲）へ、**約25〜30%増えた**。
**CI（GitHub Actions）側の実測**: 旧パラメータでの `packages/bullmq` job（PR #746、
run 36107185178）は checkout〜test:redis まで含めて **45秒**（`07:21:05Z` 〜
`07:21:50Z`、`gh api .../jobs` で実測）だった。新パラメータでの同 job の所要時間は、
この変更を push した後の CI run で改めて実測し、PR 本文・コメントで報告する
（本 ADR 本文はここで一旦区切る——実測が入り次第、この段落の下に追記する）。

### 貼ったテストの行

```
$ pnpm --filter @mnemora/bullmq run test
 Test Files  1 passed (1)
      Tests  4 passed (4)

$ pnpm --filter @mnemora/bullmq run test:redis   # ラウンド版（改訂後）
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

---

## 採らなかった案

### 案A: `BullMQScheduler implements Scheduler`

上の「根拠①への応答」参照。`Scheduler.enqueue` に呼び手が無く、実装しても本番経路に
繋がらない。

### 案C: outbox → BullMQ の relay

上の「決定 1」参照。`packages/core` に手を入れる必要があり、帳簿が二重になる
（outbox と BullMQ ジョブの両方が「処理済みか」の状態を持つ）。

### npm へ出す

初回 publish は OIDC で行えない（ADR 0066）——オーナーの手が要る。今回は `private: true` に
留め、出すかどうかの判断はオーナーへ上げる。

---

## 引き受けた負債

### 1. 変異試験の検出率は100%であることを主張しない（改訂: 12試行中12回検出）

🔴 **2026-09-25 改訂。** 初版（repeat ジョブの発火間隔に頼る設計）は最終パラメータでも
8試行中7回の検出（1回見逃し）に留まっていた。ADR 0206「測ったこと3」の知見に倣い、
`it` の中で独立したラウンドを複数回す設計に改めたところ（上の「測ったこと」2026-09-25
追記参照）、**12試行中12回検出（見逃し0）**に改善した。

⛔ **それでも「100%である」とは主張しない。** 本 ADR の歯は「出なかった」を
「起きない」の証明として使っていない——検出できたという肯定的な実測（複数回の RED）を
根拠にしている。12試行で見逃しが0だったことは、**その12試行では見逃さなかった**以上を
主張しない——母数が有限である以上、より低い確率の見逃しが存在する可能性は排除できない。
CI で偶然この歯が GREEN になった1回だけを見て「安全」と判定しないこと。

### 2. 複数マシン・ネットワーク越しの claim は測っていない

本 ADR の歯は同一ホスト上の複数 OS プロセスまでである。別ホストの複数マシンが
同じ Postgres・同じ Redis に対して同時に tick する状況（レイテンシが数桁変わる）は
測っていない。

### 3. BullMQ の Job Scheduler の「重なり」は、この歯が意図的に作ったものである

`EVERY_MS < EMBED_DELAY_MS` という極端な比率でわざと重ねている。実運用でここまで
極端な比率を選ぶ呼び出し側は考えにくいが、**「処理時間が発火間隔を超えたら重なりうる」
こと自体は BullMQ の Job Scheduler の一般的な性質であり、この歯の外の設定でも起こりうる**
——だからこそ、outbox 側（Postgres）で守られていることに価値がある、という主張である。

### 4. `queue.upsertJobScheduler`/`removeJobScheduler` は BullMQ 6.x の API である

BullMQ 5.x 以前の `queue.add(..., { repeat })`/`queue.removeRepeatable(...)` とは異なる
（型が合わずビルドが赤くなることで気づいた。【実測】）。`package.json` は `bullmq: "6.3.8"`
に固定してある（`.npmrc` の `save-exact=true`）ため、この差異は今日のところ露出しないが、
将来 BullMQ のメジャーバージョンを上げるときは API 差分を確認すること。

### 5. `adr-renumber.mjs` は `packages/` 配下・`.github/workflows/` の参照を書き換えない【実測】

2026-09-25、`git merge origin/main`（Issue #372 の PR #745 を取り込み、`ADR 0324` が
既に使われている状態にした）の後で `node scripts/adr-renumber.mjs`（引数無し）を実行し、
`0324 -> 0325` の付け替えを実際に観測した。**書き換えられたのは `docs/architecture.md`・
`docs/roadmap.md`・`docs/decisions/0206-outbox-concurrent-claim-conformance.md`・
ADR 自身のファイル名と見出しの4ファイルだけだった。** `packages/bullmq/**`（`tick-driver.ts`・
`index.ts`・`package.json`・テストのコメント計8箇所）と `.github/workflows/ci.yml`
（2箇所）に残っていた「ADR 0321〔仮番号〕」（旧い暫定表記——本 ADR が最終的に `0324` を
経て `0325` になる前、依頼段階の仮の番号をそのまま書いてしまっていたもの）は、
`adr-renumber.mjs` の実行では1バイトも変わらず、**この担い手が手で `grep -rn` して
見つけ、個別に直した。**

**原因はスキャン対象の絞り込みにある**——`scripts/adr-renumber.mjs` の
`performRenumber()` は `git diff --name-only origin/main` で「origin/main に対して
このブランチが変更した全ファイル」を対象にするが、**そのうえで実際に書き換えるのは
`rewriteReferencesInText` が「`ADR ` に直接続く**付け替え対象の旧番号（このときは
`0324`）**」を見つけた行だけである。** `packages/bullmq/**` の該当箇所はそもそも
`0324` ではなく（依頼段階の指示の写しである）`0321` という**別の数字**を書いてしまって
いたため、`0324 -> 0325` の付け替えの対象にすらならなかった——**ツールの不具合ではなく、
この ADR の作成者（この担い手）が仮の番号を実コードへ先に書いてしまい、後で ADR 側だけ
`0324` を経て確定させ、参照側の更新を1回忘れた、という書き手側の欠落である。**

⟹ **`adr-renumber.mjs` は「ADR の番号」を指す参照の書き換えを、`docs/` 配下や
参照を持つ `.md` ファイルに限定してはいない（`packages/` や `.github/` も対象になりうる）
が、書き換えられるのはあくまで「診断対象の旧番号と一致する箇所」だけである。**
的外れな番号（この場合の `0321`）を書いてしまった箇所は、どのみち機械では拾えない
——**ADR を書く担い手自身が、コード側のプレースホルダ表記を確定番号へ揃える作業を、
`adr-renumber.mjs` の実行に頼らず自分で行う必要がある。**

---

## これが覆るとしたら

- **見逃し率（8試行中1回）が実際の運用で無視できない頻度で起きると分かったとき。**
  ⟹ パラメータ（`MEMORY_COUNT`/`TICK_LIMIT`/`EMBED_DELAY_MS` 等）をさらに調整するか、
  検出のための構造（陽性対照の自動化・複数回撃って多数決を取る等）を歯自体に足すこと。
- **複数マシン構成が実際の要求になったとき。** ⟹ 「引き受けた負債」2 が実害になる。
  別ホストでの再現を歯に足すこと（この歯の `child_process.spawn` を、複数マシンへの
  `ssh`/コンテナ起動に置き換える形が考えられる——測っていない）。
- **BullMQ を npm に出す判断がオーナーから下りたとき。** ⟹ `private: true` を外し、
  `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` へ追加すること（依存の向きは
  `@mnemora/core` にしか依存しないため、末尾でも整合する）。
- **`Scheduler.enqueue` に本番の呼び手が現れたとき。** ⟹ 案Aを再検討する価値が生まれる
  ——ただしそれは「BullMQ が Scheduler を実装する」こととは独立に決まる話である。

---

## 確かめていないこと

- **BullMQ の Job Scheduler が実運用のワークロードでどの程度「重なる」か**は測っていない
  ——この歯は意図的に重なりを起こしているのであって、実運用の典型的な比率
  （`everyMs` と処理時間の比）を実測したものではない。
- **BullMQ 自身の可用性・再接続・Redis 障害時の挙動**は一切検査していない
  （`worker.on("error")` を観測するだけで、リトライ戦略・dead letter・Redis Cluster
  構成での挙動は範囲外）。
- **`concurrency` を1より大きくしたときの、同一プロセス内での重複防止**は、この歯では
  「複数プロセス」の重複としてまとめて測っており、同一プロセス内の重複だけを
  切り分けて測ってはいない（ADR 0206 が単一プロセス内を既に測っているため、
  本 ADR はそこを再測定する優先度を置かなかった）。
- **本 ADR の「根拠④への応答」で引いたオーナー発言は、この書き手自身は一次ソースを
  確認していない**（上の「出所の印」参照）。
- **npm に出したときの動作**（`private: true` を外した場合の pack 内容・依存解決）は
  検査していない——`scripts/check-publish-pack.mjs` 等の対象に入れていないため。
