# ADR 0020: 使い捨てテスト DB は「接続0本」を実測してから `DROP DATABASE`（`WITH (FORCE)` を使わない）

- **状態**: 採用 (2026-09)

- **文脈**:

  `main` の CI ジョブ「ルートの `test` 門の DB 段」（`root-gate-db-stage`）が
  **間欠的に**赤くなっていた。落ちていたのはアサーションではなく、vitest の
  unhandled error 1件——テスト自体は 99/99（後述の歯を足す前の本数）通っている。

  CI ログ（run 33988004555 / job 101365020776）の逐語:

  ```
  Vitest caught 1 unhandled error during the test run.
  Uncaught Exception
  error: terminating connection due to administrator command
  severity: 'FATAL', code: '57P01', file: 'postgres.c', routine: 'ProcessInterrupts'
  ```

  そのエラーが持っていた client の状態: `database: 'mnemora_lock_concurrent'`,
  `_ending: true`, `_ended: false`, `_connected: true`, `_poolUseCount: 3`。
  `This error originated in "src/__tests__/migrate-concurrency.test.ts"`。

  **この不具合は PR #14（`vector-space-concurrency.test.ts` を追加した PR）が
  入れたものではない。PR #13（`migrate-concurrency.test.ts` を新設した PR）の
  時点で既に在った。** bench ブランチの run 33987981306
  （2026-09-05T19:43、job 101364960034）が同じ署名で落ちている——
  `Unhandled Errors` / `Uncaught Exception` /
  `This error originated in "src/__tests__/migrate-concurrency.test.ts"` /
  `Test Files 9 passed (9)` / `Errors 1 error` /
  `✗ DB テストが落ちました（@mnemora/postgres）。`。`Test Files` が9本なので
  `vector-space-concurrency.test.ts`（PR #14 で追加、以降は10本）を含まない木。
  ただし `vector-space-concurrency.test.ts` にも同じ形の穴がそっくり
  重複していたことは変わらないため、両方直した。

  **機構**（`node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js`
  を実際に読んで確認した。行番号は同ファイルのもの）:

  - `Pool.end()`（488-499行）は `this.ending = true` にして `_pulseQueue()` を
    呼ぶだけ。
  - `_pulseQueue()`（133-143行）の `ending` 分岐は、idle client を `_remove()`
    した**直後**、`client.end()` の完了コールバックを待たずに
    `if (!this._clients.length) { this.ended = true; this._endCallback() }`
    を実行する。
  - `_remove(client, callback)`（172-186行）は `this._clients` を**同期的に**
    フィルタして空にしてから `client.end(cb)` を呼ぶ。`ending` 分岐からの
    呼び出しは `callback` を渡さないため、実際のソケット close の完了は
    **一切待たれない**。
  - **⟹ `await pool.end()` は、ソケットが実際に閉じ切る前に resolve する。**
    サーバー側の backend はまだ生きている。
  - `_release()`（389行）が client に `idleListener` を付けており、
    `_remove()` はそれを外さない。`makeIdleListener`（53-64行）は受け取った
    エラーを `pool.emit('error', ...)` する。**`Pool` に `'error'` リスナーが
    無いため、Node の `EventEmitter` がそのまま投げ、uncaught exception になる。**

  **因果の連鎖**: `afterAll` が `await pool.end()` を回した直後に
  `DROP DATABASE ... WITH (FORCE)` を撃つ → FORCE がまだ生きている自分自身の
  backend を SIGTERM → backend が `57P01`（FATAL）を返す → 閉じかけの client が
  それを `'error'` として emit → `Pool` に listener が無い → uncaught → vitest の
  unhandled error → **全テスト緑でも exit 1。**

  **間欠性の根拠**: 落ちた run 33991930658 を `gh run rerun --failed` で
  **同じ SHA のまま**再実行したところ success になった（マネージャーが実行して
  確認、このリポジトリの作業者は再現していない）。⟹ 差分ではなく時刻（競合）。

  **ベースラインの失敗率**（マネージャーが `gh api` で実測。この作業者は
  再導出していない）: `migrate-concurrency.test.ts` が入って以降、木が
  コンパイルできている run に限ると、`root-gate-db-stage` 相当のジョブは
  9試行中6試行が緑・3試行がこの署名で赤——**約33%**。

- **採ってはいけないと明示された直し方（オーナーが名指しで禁じた）とその理由**:

  1. **`dangerouslyIgnoreUnhandledErrors` で黙らせる。** 実装時に手元で実測した
     （下の「歯」参照）: このフラグを立てると、`Vitest caught 1 unhandled error`
     という出力そのものは変わらず出るが、**exit code だけが 0 に変わる**。
     「unhandled error が在る」という区別自体が消え、次に本物の不具合が
     unhandled error として現れても、門は気づかない。採らない。
  2. **`57P01` を一律に握り潰す。** 意図して落とした自分の接続が受け取る
     `57P01`（今回のように FORCE で自滅させた場合）と、予期しない外部要因
     （運用者の手動切断、クラウド側のフェイルオーバー等）による `57P01` は
     別物である。一律に握り潰すと、後者を検知できなくなる。採らない。
  3. **`pool.on('error', () => {})` で握る。** 症状（uncaught exception）だけが
     消え、「閉じ切れていない接続がある」という不具合そのものは直っていない
     ——`57P01` を握り潰すのと同じ性質の問題を、経路を変えて再現するだけ。採らない。
  4. **テストを削る・skip する。** `migrate-concurrency.test.ts` /
     `vector-space-concurrency.test.ts` は advisory lock による排他という
     本物の並行性を測っている歯であり、ADR 0017 / 0018 の実測（まっさらな DB へ
     N=4 同時に呼ぶと排他無しでは12/12決定的に失敗する）を裏付ける唯一の検査。
     採らない。

- **検討した選択肢（直し方そのもの）**:

  1. **`DROP DATABASE ... WITH (FORCE)` の前に `pg_terminate_backend` を
     自分で先に呼んでおく。** FORCE と同じ「他人の接続を殺してから消す」という
     性質を持ち込むだけで、根の問題（「自分が閉じ切ったと思っていたが、
     実はまだ生きていた」という事実そのもの）を測れない・直さない。採らない。
  2. **`pool.end()` の代わりに、各 client を個別に `client.end()` して
     Promise を待つ。** `pg` の `Pool` は個々の client への直接アクセスを
     公開する API を持たない（`_clients` は private）ため、正規の手段では
     実現できない。内部実装への依存を増やすだけで、`pg-pool` のバージョンが
     上がれば壊れる。採らない。
  3. **落とす前に、接続が本当に0本になったことを `pg_stat_activity` で実測
     してから、`WITH (FORCE)` を使わずに `DROP DATABASE` する（採用）。**
     FORCE を外すと、閉じ切れていない接続が万一残っていた場合
     `DROP DATABASE`（FORCE 無し）は `55006`（`object_in_use`）で素直に
     失敗する——**黙って握り潰されず、必ず表に出る。** これは「対処療法」
     ではなく、「FORCE が隠していた不整合を、隠さない形に変える」という
     意味で根の直し方だと判断した。

- **決定**:

  `packages/postgres/src/__tests__/temp-database.ts` を新設し、
  `dropTempDatabase(admin: Pool, database: string, opts?: { drainTimeoutMs?: number })`
  を export する:

  1. `SELECT pid, state, application_name, query FROM pg_stat_activity WHERE datname = $1`
     が0行になるまで100ms間隔でポーリングする。既定の上限は10秒
     （`DEFAULT_DRAIN_TIMEOUT_MS`）。
  2. 上限を超えたら、`DatabaseDrainTimeoutError` を投げる。メッセージに
     DB 名と、残っている接続それぞれの `pid` / `state` / `application_name` /
     `query` を含める——黙って `WITH (FORCE)` へフォールバックしない。
  3. 0行を確認してから `DROP DATABASE IF EXISTS <database>`
     （**`WITH (FORCE)` は付けない**）。

  **`admin` 自身の接続を数えない理由**: `admin` は `requireDatabaseUrl()` が
  指す管理用データベース（テスト全体で共有する接続先であり、使い捨ての
  `database` そのものではない）に繋がっている。`pg_stat_activity.datname = $1`
  （`$1` = 使い捨て DB 名）で絞り込む時点で、別の DB に繋がっている `admin`
  自身の行は元から対象に入らない。これは
  `temp-database.test.ts` の正のケース（`admin` 接続が生きたまま
  `dropTempDatabase` を呼んでも即座に0本と判定され、例外にならないこと）で
  実測して確認している。

  `migrate-concurrency.test.ts` の `createBlankDatabase()` /
  `vector-space-concurrency.test.ts` の `createMigratedDatabase()`
  （使い捨て DB を作る前の掃除）と、両ファイルの `afterAll`
  （使い捨て DB を最終的に捨てる箇所）を、すべて `dropTempDatabase()` 経由に
  統一し、`WITH (FORCE)` の呼び出しを1つも残さなかった。「自分が開けたのでは
  ない接続を黙って殺す」のがそもそも塞ぎたい形であるため——残骸に繋いでいる
  誰か（例えば手元で `psql` を開いたままの人間）が居るなら、殺すのではなく
  「閉じ切れていない」と教える方が正しい。

  **同じ形の穴が3つ目のファイルにも丸ごと残っていた。** 最初の実装
  （このADRの初版）では `migrate-concurrency.test.ts` /
  `vector-space-concurrency.test.ts` の2ファイルしか直していなかったが、
  `packages/postgres/src/__tests__/migrate-ledger-handover.test.ts` の
  `createBlankDatabase()`（87-93行）と `afterAll`（122-133行）も、
  構造・使い捨て DB 名（`mnemora_ledger_handover_*` 4種）まで含めて
  完全に同じ形で `DROP DATABASE ... WITH (FORCE)` を使っていた。これは
  マネージャーが CI の tarball（head `eaa8ee8e`）を展開して
  `grep -rn -E "CREATE DATABASE|DROP DATABASE"`（`node_modules` と `docs/` を除外）
  で全文検索し、指摘したもの（出所: マネージャーの報告。このリポジトリの
  作業者は指摘を受けて該当ファイルを実際に読み、構造が同一であることを
  確認した）。このファイルにはこの unhandled error が実際に観測された例は
  無い（観測された3件はすべて `mnemora_lock_concurrent`、つまり
  `migrate-concurrency.test.ts` 由来）が、`await pool.end()` が resolve
  しても socket が閉じ切っていないという前提（このADR冒頭の「機構」）は
  ファイルに関係なく成り立つため、同じ形で起こりうる——同じ穴を1つだけ
  残すと直したという記述が事実とずれるため、この3つ目のファイルも
  `dropTempDatabase()` 経由に統一した。このファイルには
  `grabLockFromAnotherSession()` 相当のヘルパは無い（実際に全文を読んで
  確認した）ため、pool 登録漏れの問題は生じていない。

  副次的に見つけた漏れも直した: `migrate-concurrency.test.ts` /
  `vector-space-concurrency.test.ts` の `grabLockFromAnotherSession()`
  が作る `Pool` が `openedPools`（`afterAll` が一括で `pool.end()` する配列）に
  登録されていなかった。登録し、`release()` はロックを手放すことだけを担い、
  pool を閉じるのは `afterAll` の一括処理に一本化した（同じ pool を2箇所で
  `end()` すると `pg-pool` が「Called end on pool more than once」で例外を
  投げるため）。

  **`WITH (FORCE)` がヘルパ以外に残っていないことの確認**: 実装後に
  `grep -rn "WITH (FORCE)" .` と `grep -rn -E "CREATE DATABASE|DROP DATABASE" .`
  （どちらも repo ルートから、`node_modules` 配下を除外）を自分で実行し、
  ヒットしたのは `temp-database.ts`（ヘルパ自身とそのコメント）・
  `temp-database.test.ts`（歯のコメント）・このADR・ADR 0018（別の実験
  ハーネスに関する歴史的記述、このリポジトリ内のテストコードではない）
  のみであることを確認した。`CREATE DATABASE` を呼んでいる全箇所
  （`migrate-ledger-handover.test.ts` / `migrate-concurrency.test.ts` /
  `vector-space-concurrency.test.ts` / `temp-database.test.ts`）が、
  いずれもその直前で `dropTempDatabase()` を呼んでいることも確認した。

  加えて、`scripts/__tests__/no-unhandled-errors.test.mjs` を新設し、
  「unhandled error を黙らせる設定がどこかに紛れ込んでいないか」を別の角度から
  測る（オーナーの「可能なら」に応えたもの）:

  - **静的**: repo 内の全 `vitest.config.mts` と全 `package.json` の
    `scripts` に `dangerouslyIgnoreUnhandledErrors` という文字列が
    無いことを検査する。
  - **動的**: 「テストは全部通るが非同期の unhandled error が1件出る」だけの
    使い捨てフィクスチャ（`EventEmitter` に listener 無しで `'error'` を
    `setImmediate` 経由で発火するだけの最小の `it()`）を `.tmp/`
    （`.gitignore` 済み。root の vitest の `include` は
    `scripts/**/*.test.mjs` なのでこのフィクスチャは対象に入らない）へ
    生成し、本物の vitest（このリポジトリの `node_modules` のもの）を
    子プロセスで実際に走らせて、**exit code が非0になり、出力に
    `Vitest caught 1 unhandled error during the test run.` が出ること**を
    実測する。これが静的な歯に意味がある根拠——実装時に手元で確認した通り、
    `dangerouslyIgnoreUnhandledErrors: true` を足すと同じ出力のまま exit code
    だけが0に変わる（下の「歯」参照）。

- **理由**:

  FORCE を外すことが直し方の核心である。FORCE 無しの `DROP DATABASE` は、
  誰かが繋いでいれば `55006` で素直に落ちる。つまり「閉じ切れていない」が
  黙って握り潰されず、必ず表に出る——`pool.end()` が「resolve した」ことと
  「サーバー側の接続が本当に閉じた」ことの間にあるギャップ（`pg-pool` の
  実装が構造的に持つギャップ）を、テスト側のコードが実測することでしか
  埋められない。

- **歯（この決定を測る歯）**:

  `packages/postgres/src/__tests__/temp-database.test.ts` を新設した。
  決定的な（時刻に依存しない）2本:

  - **正**: 使い捨て DB を作り、pool を開いて `SELECT 1` で実際に接続を
    張ってから `await pool.end()` し、`dropTempDatabase()` を呼ぶ →
    例外なく終わり、`pg_database` を引くと DB が実際に消えている。
  - **負（本命）**: 使い捨て DB を作り、pool を開いて接続を張ったまま
    **閉じずに**、`drainTimeoutMs: 300` で `dropTempDatabase()` を呼ぶ →
    必ず `DatabaseDrainTimeoutError` を投げ、メッセージに DB 名と
    `pid=<number>` を含む残存接続の詳細が出る。かつ `pg_database` を引くと
    DB はまだ存在する（FORCE で勝手に殺していない証拠）。

  `scripts/__tests__/no-unhandled-errors.test.mjs` の動的な歯について、
  この実装の過程で以下を手元で実測した（このリポジトリの `.tmp/` に
  一時フィクスチャを作って `pnpm exec vitest run --root ... --config ...`
  を実行し、都度削除した）:

  - フィクスチャ（`it()` のアサーションは全部通り、`setImmediate` 内で
    `EventEmitter` の無 listener `'error'` を発火するだけ）を素の vitest
    設定で実行すると: `Test Files 1 passed (1)` / `Tests 1 passed (1)` /
    `Errors 1 error` / **exit code 1**。
  - 同じフィクスチャを `dangerouslyIgnoreUnhandledErrors: true` を足した
    vitest 設定で実行すると: 出力（`Vitest caught 1 unhandled error...` を
    含む）は変わらないが、**exit code が 0** に変わる。

  この2つの実測により、「静的にこのフラグを禁止する検査」が実際に
  意味のある区別を守っていることを確認した。

  **静的な歯への変異試験**: ルートの `vitest.config.mts` へ
  `dangerouslyIgnoreUnhandledErrors: true` を一時的に足して
  `no-unhandled-errors.test.mjs` を実行したところ、「vitest.config.mts の
  どれも `dangerouslyIgnoreUnhandledErrors` を設定していない」の歯が
  実際に赤くなることを確認した（`AssertionError: expected [ Array(1) ] to
  deeply equal []`、該当ファイルのパスを含む）。変異を戻すと緑に戻ることも
  確認した。

  **動的な歯の脆さを直した経緯**: 最初の実装は `expect(output).toContain(
  "Test Files  1 passed (1)")` のような素朴なリテラル文字列一致だった。
  この PR 自身の CI（`typecheck / lint / test / build` ジョブ、run
  33995845407）で実際に赤くなった——GitHub Actions のランナーが子プロセスの
  標準出力に色を強制し、vitest の reporter が `"Test Files"` と
  `"1 passed (1)"` の間に ANSI エスケープシーケンスを挟み込んだため。
  手元で `FORCE_COLOR=1` を強制して再現し、原因を特定した。

  この歯が誤って赤くなることの実費は他の歯より一段高い——赤くなれば
  この repo の**すべてのマージ**が止まり、次に踏んだ人は「歯を弱める」
  誘惑を持つ（オーナーの指摘）。そのため2つの手当てを両方行った:

  1. **色（環境依存の軸）**: 子プロセスへ `NO_COLOR=1` / `FORCE_COLOR=0` を
     明示して渡す**うえで**、`output.replace(/\x1b\[[0-9;]*m/g, "")` で
     ANSI エスケープそのものを剥がしてから一致させる。`NO_COLOR` が
     尊重されるかどうかはランナー側の実装に依存する仮定であり、
     剥がすほうが強い保証になる。
  2. **文言・空白（vitest のバージョン依存の軸）**: リテラル一致
     （空白の個数を固定する形）をやめ、`/Test Files\s+1 passed\s+\(1\)/` /
     `/Vitest caught\s+1\s+unhandled error/` という正規表現にした。
     **ただし件数の数字（`1`）は残したまま**——ここを `\d+` のように
     緩めると「1 passed」と「2 passed」の区別が付かなくなり、この歯の芯
     （全部 passed でも unhandled error が在れば赤になること）が測れなく
     なる。緩めすぎて歯を殺すことは、脆さを直すこととは別の失敗である。

  **変異試験（4本、すべて「当たったうえで赤くなった」ことを確認、SKIP は
  無い）**:

  | # | 変異 | 結果 |
  |---|---|---|
  | M1 | 1本目の正規表現の `1 passed` を `2 passed` へ | 赤（`scripts/__tests__/no-unhandled-errors.test.mjs:166` で失敗、他の2本は緑のまま） |
  | M2 | 2本目の正規表現の `caught\s+1\s+unhandled` を `caught\s+2\s+unhandled` へ | 赤（同ファイル:167 で失敗） |
  | M3 | 3本目の `.not.toBe(0)` を `.toBe(0)` へ | 赤（`expected 1 to be +0`） |
  | M4（測定対象側） | フィクスチャから `setImmediate(...)` の塊を削り、unhandled error が出ないようにする | 赤（2本目・3本目が独立に失敗することを、アサーションの順序を一時的に入れ替えて個別に確認した——1つの `it()` 内では最初に失敗したアサーションで打ち切られるため） |

  4本とも変異を当てた状態で実際にその歯が実行され（skip されていない）、
  赤くなったことを確認し、変異を戻すと緑に戻ることも確認した
  （最終的な `no-unhandled-errors.test.mjs` は変異を含まない）。

  **`temp-database.test.ts` / `migrate-concurrency.test.ts` /
  `vector-space-concurrency.test.ts` / `migrate-ledger-handover.test.ts` に
  対する変異試験・実行そのものは行っていない。** 下の「確かめていないこと」を
  参照——この環境に PostgreSQL が無く、手元で DB テストを1本も実行できない
  ため。CI（`postgres` ジョブ・`root-gate-db-stage` ジョブ）を、この決定の
  唯一の実行環境として位置づけている。

- **結果（この決定が招くもの）**:

  - 使い捨て DB を捨てる操作が、常に最大 `drainTimeoutMs`（既定10秒）だけ
    遅くなりうる。通常時（接続がすでに閉じている）は最初のポーリングで
    即座に0本と判定されるため、体感の遅延はほぼ無い。
  - `packages/postgres/src/__tests__/migrate-concurrency.test.ts` /
    `vector-space-concurrency.test.ts` / `migrate-ledger-handover.test.ts`
    の `afterAll` が失敗する経路が新たに生まれた
    （`DatabaseDrainTimeoutError`）。これは「隠していた
    不具合を隠さない形に変える」という決定の意図した効果であり、退行では
    ない——ただし、もし本当に接続が長時間残る別の原因（例えばテスト本体の
    バグで pool を閉じ忘れる）が今後入り込むと、`afterAll` がこのエラーで
    失敗するようになる。それは検知であって、この決定が生んだ新しい壊れ方
    ではない。

- **これが覆るとしたら**:

  - **drain 待ちの上限値（10秒）** は経験的な値であり、実測してチューニング
    したものではない。CI のサービスコンテナが今より低スペックになる、
    あるいはテストの並行度が上がって `pg_stat_activity` への問い合わせ自体が
    詰まるようになれば、この上限では足りなくなる可能性がある。そのときは
    値を上げるか、`drainTimeoutMs` を呼び出し側でもっと積極的に使う
    （現状は既定値のまま呼んでいる）。
  - **`pg_stat_activity` への依存**: このビューはサーバー全体の状態を映す
    ものであり、権限（`pg_read_all_stats` 等）が無いロールでは他人の
    `query` 列が見えないことがある（PostgreSQL の仕様）。現状のテストは
    superuser 相当のロールで実行しているため顕在化していないが、将来
    より権限の弱いロールでこのヘルパを使う経路が増えたときは、
    `query` 列が空で返ってくる可能性がある（`pid` / `state` /
    `application_name` は権限に関わらず見える）。
  - もし PostgreSQL の将来のバージョンで `DROP DATABASE`（FORCE 無し）の
    挙動が変わり、`55006` 以外の形で失敗するようになった場合、
    `dropTempDatabase()` はその新しい失敗の形を判別していない（現状は
    「投げたら投げっぱなし」で、呼び出し元がそのまま伝播させる）。

- **確かめていないこと**:

  - **この環境（この ADR を書いた作業）には PostgreSQL が無く（`docker` /
    `psql` / `initdb` 無し、root 権限無し）、DB を要求するテストを
    1本も手元で実行していない。** `temp-database.test.ts` /
    `migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` /
    `migrate-ledger-handover.test.ts` の実行結果は、すべて CI（GitHub
    Actions の `pgvector/pgvector:pg17` service container）でのみ確認した。
    この ADR の「歯」節に書いた `temp-database.test.ts` の2本の意図（正・負）
    は、コードレビューの上での設計であり、**CI で実際に緑になることを
    見て初めて実測したと言える。**
  - **`migrate-concurrency.test.ts` / `vector-space-concurrency.test.ts` /
    `migrate-ledger-handover.test.ts` へ実際に変異（`dropTempDatabase` を
    元の `WITH (FORCE)` へ戻す等）を当てて赤くなることは確認していない。**
    DB が無い環境では変異試験自体が実行できないため。ADR 0017 / 0018 が
    行ったのと同水準の変異試験は、この決定については**行われていない、
    未確認**として明記する。
  - **間欠障害が実際に直ったことについて、実測した内容と、その限界**:

    マネージャーが実測した（出所(1)、マネージャーの実測）: head
    `eaa8ee8ee4b9b2b6b634d7460b500f2ab2845586` に対する CI run
    `33996088663` の `root-gate-db-stage` ジョブを、`gh run rerun <run> --job
    <id>` で9回再実行し、**attempt 1〜10 の合計10回すべてが
    `completed`/`success`（10/10）だった。** 各 attempt で4ジョブ
    （`typecheck / lint / test / build` / `packages/postgres` /
    `examples/chat` / `root-gate-db-stage`）すべてが実行されたことも確認した
    （job id: 101386790627 / 101389490502 / 101390968525 など）。
    直す前のベースラインは約33%（9試行中6緑・3赤、上述）であり、
    **偶然に10連続緑になる確率は 0.67^10 ≒ 1.8%** と見積もれる。

    **⚠ これは確率的根拠であって証明ではない。** 33%という数字自体、
    9試行という小さい母数から出したものであり、真の発生率の点推定として
    強い精度を持たない。1.8%は「直っていないのに10連続で偶然通った」
    可能性を完全には排除しない。

    **⚠ さらに、この10/10は head `eaa8ee8e`（動的な歯の脆さを直す前の
    コミット）に対する観測であり、その後に積んだコミット
    （動的な歯の ANSI 対応・正規表現化、`migrate-ledger-handover.test.ts`
    への横展開）を含む最終 head に対する観測ではない。** 最終 head に
    対する追加の CI 実行結果は、PR 本文・やり取りに記録する
    （このリポジトリの作業者が最終 head で改めて複数回 rerun し、
    その回数と結果を報告する）。
  - **`pg_stat_activity` に自分自身の管理接続（`admin`）が含まれないこと**は
    `datname` で絞り込む設計上そうなるはずだが、これも CI 上の
    `temp-database.test.ts` の正のケースが実際に緑になることでしか
    実測できていない（手元では未実行）。
