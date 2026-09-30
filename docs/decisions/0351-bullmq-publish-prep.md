# ADR 0351: `@mnemora/bullmq` を npm 公開の準備状態にする — `PUBLISH_TARGETS` へ末尾で加え、初回 publish 前の version 検査を除外する仕掛けを足す（Issue #205）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

**⚠ 各主張の出所を分ける**。

- **【現物】** — この repo のコード・文書・`gh` の出力を、この書き手が自分で読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[Issue #205](https://github.com/takecchi/mnemora/issues/205) は、`packages/bullmq`
本体を [ADR 0325](./0325-bullmq-tick-driver.md) で着地させた時点で
「`private: true`。npm に出すかどうかは今回決めない——オーナーへ上げる」として
公開判断を保留していた（同 ADR 決定2）。

**オーナーの回答（2026-09-28、【受】——このセッションを委任したマネージャーからの
申し送りであり、この書き手自身は issue コメント等の一次ソースを確認していない）:
「公開する準備をお願い」。** ⟹ 本 ADR は、ADR 0325「これが覆るとしたら」が挙げた条件
（「BullMQ を npm に出す判断がオーナーから下りたとき。⟹ `private: true` を外し、
`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` へ追加すること」）が実際に発火した
記録である。

**⛔ 本 ADR が決めるのは「公開の準備」までである。** npm publish・Release・tag・
`package.json` の `version` bump は、いずれもオーナーの手に残す
（`docs/autonomy.md` §3、ADR 0070）。`packages/bullmq/package.json` の `version` は
`0.0.0` のままにする。

## 決定

### 1. `package.json` から `private: true` を外し、他の publish 対象と同じ必須フィールドを揃える

`packages/local-embedding/package.json`（直近に追加された publish 対象）を基準に、
`repository` / `homepage` / `bugs` / `publishConfig.access: "public"` / `prepack` を
揃えた。**`description` を内部向けの文（「Issue #205 の2本目、ADR 0325 案B」）から、
利用者向けの文へ書き換えた**——他の6パッケージの `description` がいずれも実装の中身を
説明する文であり、Issue 番号や ADR の案の記号（「案B」）を含まないことに合わせた。

`dependencies` の実行時依存2本を見直した:

- **`bullmq`（`6.3.8`、完全固定のまま）**: 緩めない。ADR 0325「引き受けた負債」4が
  名指しした理由がある——BullMQ 6.x の Job Scheduler API（`queue.upsertJobScheduler`）は
  5.x 以前に無く、メジャー版を上げると型もビルドも壊れうる。範囲指定（`^6.3.8`）に
  緩めると、この repo が確かめていない次のメジャー版が `pnpm install` で黙って入りうる。
  `scripts/publish-pack-checks.mjs` の `EXACT_PINNED_DEPENDENCY_EXEMPTIONS` へ、
  他の4件（openai/anthropic/postgres/local-embedding の各 SDK）と同じ形で明示的に
  退避した——ただし他の4件が「`save-exact=true` の機械的な結果、未確認のまま残した
  負債」であるのに対し、`bullmq` は**積極的に固定を選んだ**という違いを doc コメントに
  明記した。
- **`ioredis`（`6.0.0` → `^6.0.0`、範囲指定へ緩めた）**: `bullmq@6.3.8` 自身の
  `peerDependencies` は `ioredis: ">=5.0.0"` としか要求しておらず（【実測】
  `node -p` で `node_modules/.pnpm/bullmq@6.3.8_.../package.json` を読んで確認）、
  メジャー版固有の API に依存していない。ADR 0112 が zod で採った判断（下流の
  dedupe を壊す完全固定を、理由が無いなら緩める）と同じ理由で緩めた。
  `pnpm-lock.yaml` の `specifier` も追随させた（`pnpm install`、解決バージョンは
  `6.0.0` のまま変わらない）。

### 2. `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` 末尾に加える

ADR 0325「これが覆るとしたら」が指示したとおり——`@mnemora/bullmq` は
`@mnemora/core` にしか依存しないため、末尾でも依存の向きと整合する
（`scripts/__tests__/publish-targets.test.mjs` が機械的に検査する）。

**末尾に置く理由は `@mnemora/anthropic` / `@mnemora/local-embedding` の前例と同じ**
（`publish-targets.mjs` 冒頭のコメント）: 初版を Trusted Publishing (OIDC) で出すことは
できない（[npm/cli#8544](https://github.com/npm/cli/issues/8544) は 2026-09-29 時点で
OPEN。ADR 0066）ため、`@mnemora/bullmq` は次の Release で publish 段に入ると
**一度 404 で落ちる**（オーナーの段0 bootstrap が済むまで。下記・ADR 0096 と同じ形）。
末尾に置くことで、その赤が既に公開済みの6本を巻き込まない。

**⚠ この PR をマージした後、段0（手元からの初回 publish）と段1（Trusted Publisher
設定）を済ませずに次の Release を切ると、ほかの6本は出るが `@mnemora/bullmq` だけが
404 で落ち、publish ジョブは赤になる（末尾に置いたので、ほかの6本が取り残されることは
ない）。** オーナー向けの具体的な手順は `docs/release-v1.md` の該当節を見ること。

【実測】2026-09-29、`npm view @mnemora/bullmq version` は `404 Not Found` を返した
（この書き手が実行）——registry に一度も publish されていないことの確認。

### 3. `NEVER_PUBLISHED_TARGETS` を新設し、初回 publish 前の version 検査を除外する

**問題**: `scripts/check-publish-pack.mjs`（`pnpm run pack:check`、毎PRのCIでも走る。
Issue #241）の `findVersionViolations` は「`version` が `0.0.0` のままなのは publish
対象として異常」と判定し、`findVersionSkewViolations` は「publish 対象すべてが
同じ版であること」を要求する。**この2つは、6パッケージが全部すでに一度は publish
されている（＝ tag の値を受け取った実績がある）という前提に立っている（ADR 0070）。**
`@mnemora/bullmq` は今回その前提を満たさない——**まだ一度も publish されておらず、
`version: "0.0.0"` のままにする（オーナーの手が入るまで、この repo は版を手で
振らない）**。素直に `PUBLISH_TARGETS` へ加えると、この PR 自身の CI で
`pnpm run pack:check` が赤くなる（【実測】、下記）。

**決定**: `scripts/publish-pack-checks.mjs` に `NEVER_PUBLISHED_TARGETS`
（`Set<string>`、publish 対象名の集合）を新設し、初出として `"@mnemora/bullmq"` を
載せた。`scripts/check-publish-pack.mjs` は、対象がこの集合に載っていれば
`findVersionViolations` を呼ばず（`0.0.0` のままで違反にしない）、
`findVersionSkewViolations` の対象数（`targetCount`）からも除外する。

`scripts/__tests__/check-publish-pack.test.mjs` の直書きリスト（`publish-targets.mjs`
と2箇所目の写しを意図的に持つ設計、`check-publish-pack.mjs` 冒頭のコメント参照）にも
`@mnemora/bullmq` を追加し、この1件だけ version 検査の向きを反転させた
（`version が 0.0.0 のままではない` ではなく `初回 publish 前なので version は 0.0.0
のまま`）。

**採らなかった案**:

| 案 | なぜ採らないか |
|---|---|
| **`version` を `0.1.0` 等の適当な値に手で書く** | オーナーの明示の指示（version bump はしない）に反する。ADR 0070 は版の権威を Release の tag に置いており、`apply-release-version.mjs` が実際の Release で書き込むまで、手で振った値は「書いたという事実」以上の意味を持たない——書けば `findVersionViolations` は通るが、その値自体に根拠が無い |
| **`check-publish-pack.mjs` の version 検査そのものを緩める（全対象で `0.0.0` を許す）** | 既存6パッケージについて「まだ tag の値を受け取っていない」ことを検出する能力を失う。今回問題なのは「bullmq が特殊」であって「検査が間違っている」のではないので、対象を絞った例外のほうが正しい |
| **`PUBLISH_TARGETS` へ加えず、`private: true` のまま今回は見送る** | オーナーの回答（「公開する準備をお願い」）に応えない。Issue #205 が求めているのはまさにこの一歩である |

### 4. `NEVER_PUBLISHED_TARGETS` に依存する他の歯への波及を確認した

**7つ目のパッケージが増えたことで赤くなった歯を洗った**
（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」への応答。件数を直書きしている
箇所を機械的に見つける方法が無いため、`grep -rn "6パッケージ\|6本\|6つ"` と、
`anthropic` と `local-embedding` の両方を同じ配列・文字列に持つ箇所を突き合わせて洗った）:

- `scripts/__tests__/publish-targets.test.mjs`「6パッケージである」→ 7へ。
- `scripts/__tests__/check-cjs-transpile-parse.test.mjs` /
  `scripts/__tests__/check-public-api-surface.test.mjs` の `PACKAGE_DIRS`（直書き配列）
  へ `"bullmq"` を追加。**アサーション自体（`PACKAGE_DIRS.length` を使う箇所）は
  元々件数を直書きしていなかったため、そちらは無修正で7に追随した。**
- `scripts/check-consumer-install-lib.mjs` の `EXPECTED_ENTRY_POINTS` へ
  `"@mnemora/bullmq"` を追加（`scripts/check-consumer-install.mjs` が使う。
  これは registry からではなく **ローカルの `pnpm pack` tarball を install** して
  確かめる道具なので、`@mnemora/bullmq` が未公開でも動く——ADR 0346）。
- `scripts/check-public-api-surface.mjs`: 新規パッケージなので
  `scripts/__snapshots__/public-api/bullmq.d.ts` が存在せず、
  `node scripts/check-public-api-surface.mjs --write` で新規生成した（既存6件の
  snapshot は【実測】バイト単位で差分なし）。
- `scripts/publish-pack-checks.mjs` の `EXACT_PINNED_DEPENDENCY_EXEMPTIONS` へ
  `"@mnemora/bullmq": ["bullmq"]` を追加（決定1参照）。
- `.github/workflows/publish.yml` / `.github/workflows/ci.yml` /
  `.github/required-status-checks.json` は**触っていない**——required status check の
  名前・数は変えない（この作業の制約。`git diff --stat origin/main` で確認可能）。

**【実測】確認した検査**: `pnpm install --frozen-lockfile`、
`pnpm --filter @mnemora/core run build && pnpm --filter @mnemora/bullmq run build`、
`pnpm run pack:check`（7パッケージとも通過。`@mnemora/bullmq` は version 検査を
`NEVER_PUBLISHED_TARGETS` により除外した旨のログが出る）、
`node scripts/check-public-api-surface.mjs`（7パッケージとも「差分なし」）、
`node scripts/check-cjs-transpile-parse.mjs`（118個の配布物）、
`pnpm run typecheck` / `pnpm run lint` / `pnpm run format:check`、
`pnpm --filter @mnemora/bullmq run test`（19 tests）、
ルートの `pnpm run test`（`DATABASE_URL` 無し。DB テストは「実行していない」と
名指しで出力——ADR 0015。`--no-file-parallelism` を付けないとこの器では
vitest worker が `EAGAIN`/`SIGABRT` で落ちることがあった——**この器固有の資源制約と
見られ**、コード側の回帰ではない。直列実行では 123 ファイル・1998 tests・2 skipped、
すべて成功）。すべて緑。

### 5. `packages/bullmq/README.md` を新設した

他パッケージ（`packages/anthropic/README.md` 等）と同じ体裁——インストール・前提
（Redis が要ること）・`createBullmqTickDriver` の最小例・outbox は Postgres が正本
であること。**まだ npm に出ていないことを冒頭に明記した**——利用者が README どおりに
`pnpm add @mnemora/bullmq` を打っても、段0 が済むまでは `404` になる。

## 引き受けた負債

1. **`NEVER_PUBLISHED_TARGETS` は手で保守する一覧であり、消し忘れを機械的には検知
   できない。** オーナーが段0（手元からの初回 publish）を実行した後、この一覧から
   `"@mnemora/bullmq"` を消さないと、`check-publish-pack.mjs` はその後も version 検査を
   その1パッケージにだけ適用し続け、`0.0.0` のまま publish されても気づかない
   （`EXACT_PINNED_DEPENDENCY_EXEMPTIONS` と同じ「消せば検査が始まる」設計であり、
   同じ「消し忘れ」のリスクを引き継ぐ）。
2. **`docs/release-v1.md` のオーナー向け手順は、まだ実行されていない。** ADR 0096
   の段0〜段3の前例を読んで書いたが、bullmq という別パッケージ・別の状況
   （Redis 依存の runtime 依存を持つ点は local-embedding の ONNX 依存と性質が違う）
   に対して実際に通るかどうかは、オーナーが実行するまで確認できない。
3. **`ioredis` を `^6.0.0` に緩めた影響は、実際に新しいマイナー/パッチ版が出るまで
   確認しようがない。** peerDependencies の要求（`>=5.0.0`）を満たす範囲でしか
   緩めていないが、bullmq 自身とのメジャー版の組み合わせを CI が実際に検査するのは
   `pnpm-lock.yaml` が解決した `6.0.0` に対してだけである。

## これが覆るとしたら

- **オーナーが段0（手元からの初回 publish）を実行したとき。** ⟹
  `scripts/publish-pack-checks.mjs` の `NEVER_PUBLISHED_TARGETS` から
  `"@mnemora/bullmq"` を消すこと（負債1）。
- **BullMQ のメジャー版を上げる判断が下ったとき。** ⟹ `EXACT_PINNED_DEPENDENCY_EXEMPTIONS`
  から `"@mnemora/bullmq"` を消すか、範囲指定へ緩めてよいかを ADR 0325「引き受けた
  負債」4 と合わせて再検討すること。
- **もう1つ、初回 publish 前のパッケージが `PUBLISH_TARGETS` に加わったとき。**
  ⟹ `NEVER_PUBLISHED_TARGETS` は複数件を持てる設計（`Set`）なので、そのまま
  名前を足せばよい。

## 確かめていないこと

- **オーナー向けの bootstrap 手順（`docs/release-v1.md`）が実際に通ること**は
  確かめていない（負債2）。
- **`pnpm run check:consumer-install`（ADR 0346、npm registry が要る）は実行していない**
  ——このタスクの検証要求に明示的には含まれておらず、ネットワークに依存する重い検査
  であるため優先しなかった。ローカル tarball を対象にする設計上、`@mnemora/bullmq` が
  未公開でも動くはずだが、実行して確認してはいない。
- **`pnpm --filter @mnemora/bullmq run test:redis`（Redis が要る）は実行していない**
  ——この書き手の環境に Redis が無い。ADR 0325 の歯（`concurrent-tick.redis.test.ts`）
  自体は変えていないので、この PR による回帰の可能性は低いと見ているが、実測はしていない。
- **オーナーの 2026-09-28 の回答「公開する準備をお願い」の一次ソース**——issue コメント
  等——はこの書き手自身は確認していない（申し送りとして受け取った。上の「出所の印」
  参照）。

---

## 追記（2026-09-30）: 「引き受けた負債」1・2 と「これが覆るとしたら」1 は、実行済みになった

**上の本文は当時の記録として書き換えない。** 以下は PR・`git log`・`AGENTS.md` の現物で確かめた事実である。

- **`@mnemora/bullmq` は npm に出た。** `v1.1.0` で公開された（[PR #1446](https://github.com/takecchi/mnemora/pull/1446)、`AGENTS.md` の package 表の bullmq の行）。初版はオーナーが手元から出した（`docs/release-v1.md` の段0）ため、provenance は無い（同 PR・`AGENTS.md`）。⚠ 公開日は、PR #1446 の本文と `AGENTS.md` が 2026-09-30、[PR #1454](https://github.com/takecchi/mnemora/pull/1454) の本文が 2026-09-29 と書いており、食い違っている。どちらが正しいかは npm 側で確かめていない。
- **`NEVER_PUBLISHED_TARGETS` から `"@mnemora/bullmq"` を外した**（PR #1454、`e269de6`）。`NEVER_PUBLISHED_TARGETS` は空の `Set` として残してある（`scripts/publish-pack-checks.mjs`）。外すには git 上の `packages/bullmq/package.json` の `version` が他の publish 対象と揃っている必要があったので、`0.0.0` を他と同じ置き値 `0.1.1` にした（版の権威は Release の tag のまま、ADR 0070）。
- **「引き受けた負債」1（消し忘れを機械的には検知できない）**: 段0の実行後に消す、という手順は実行された（PR #1454）。一覧が手保守である性質は変わっていない。
- **「引き受けた負債」2（`docs/release-v1.md` の手順がまだ実行されていない）**: 段0は実行された（PR #1446 本文の記述）。ただし手順が書かれたとおりに通ったかどうかは、この追記の書き手は確かめていない。
- **「これが覆るとしたら」1（オーナーが段0を実行したとき ⟹ `NEVER_PUBLISHED_TARGETS` から消す）**: 発火し、PR #1454 で実行された。
- 「これが覆るとしたら」3（初回 publish 前のパッケージが `PUBLISH_TARGETS` に加わったとき）のために、`Set` は空のまま残してある。
- Issue #205 は、この追記の時点で閉じているかを確かめていない。
