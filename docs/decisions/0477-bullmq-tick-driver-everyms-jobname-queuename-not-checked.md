# ADR 0477: 穴探し48巡目 — `createBullmqTickDriver` の `everyMs`・`jobName`・`queueName` は検査されない。不正値で何が起きるかを実 Redis で測り、README と TSDoc に書く

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し。新しく断る入力・既定値や公開 API の変更は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 48巡目は、今日の ADR 0441〜0476 が見ていない面を選ぶところから始めた。選んだのは `packages/bullmq/src/tick-driver.ts`。【現物】`resolveConcurrency`（198〜207 行付近）だけが入力を検査し（正の整数）、同じ options の `everyMs`（`upsertJobScheduler(jobName, { every: opts.everyMs }, …)` へそのまま渡る）・`jobName`（`opts.jobName ?? "mnemora-tick"`）・`queueName`（`new Queue(opts.queueName, …)`）は検査されない。この driver を実 Redis で測った [ADR 0449](./0449-bullmq-tick-driver-measured-against-real-redis.md)（溜まるジョブ・scheduler の上書き・`stop()`・Redis の再起動・`everyMs` の置き換え・stalled・ioredis のインスタンス）は当て直していない。0449 は `everyMs` の**不正値**を見ていない【現物。0449・README を grep】。

- **確かめ方**【実測】: redis-server 7.4.7（conda-forge の `redis-server-7.4.7-h35e630c_0.conda` を、zip と zstd を node（`zlib.zstdDecompressSync`）で展開して使った。ポート 56441、`--save "" --appendonly no`）と bullmq 6.3.8（ioredis 6）、node v22.23.3。`createBullmqTickDriver({ runtime: 偽の tick, everyMs: 100, … })` の1つの値だけを変えて `start()` し、1.8 秒後の tick の回数・`getJobCounts`・`getJobSchedulers` を見た。止まったものは、さらに 6 秒後まで見て回数が増えないことを確かめた。BullMQ のソース（`node_modules/bullmq/dist/cjs/classes/job-scheduler.js`・`queue-base.js`）も読んだ。測定の道具は commit していない（`.hunt-r48/`）。測定後に `shutdown nosave` で止め、接続が拒まれることを確かめた。

- **測った結果**【実測】:

  | 入力 | `createBullmqTickDriver` | `start()` | その後 |
  |---|---|---|---|
  | 基準 `everyMs: 100` | 成功 | 成功 | 1.8 秒で 19 tick。scheduler `every: 100` |
  | `everyMs: 0`・`NaN`・`null`・`undefined` | 成功 | **reject**: `Either .pattern or .every options must be defined for this repeatable job` | — |
  | `everyMs: Infinity` | 成功 | **reject**: `ERR user_script:175: Cannot serialise number: must not be NaN or Inf …` | — |
  | `everyMs: -1`・`-100` | 成功 | 成功 | **tick が 2〜5 回で止まる**（6 秒後も増えない）。`delayed` が 0。scheduler は `every: -1` で Redis に残る。エラーは出ない |
  | `everyMs: 0.5` | 成功 | 成功 | tick 8 回で止まる。scheduler は `every: 0`。エラーは出ない |
  | `everyMs: 1e21` | 成功 | 成功 | **tick 1 回で止まる**（次の発火が 1e21 ms 先）。scheduler は `every: 1`。エラーは出ない |
  | `everyMs: 1.5` | 成功 | 成功 | `every: 1` に切り捨てて動く。6 秒で 1,035 tick |
  | `everyMs: 2^31`・`2^53 + 2` | 成功 | 成功 | 動くが、次の発火は 24.8 日後・約 28.5 万年後（tick 1 回） |
  | `everyMs: "50"`（数値の文字列） | 成功 | 成功 | `every: 50` で動く |
  | `jobName: ""` | 成功 | 成功 | **tick 1 回で止まる**（scheduler id が空文字）。`??` は空文字を既定に倒さない |
  | `jobName: "a:b"`・`"repeat:x"`・`" "`・`"ジョブ"`・300 文字 | 成功 | 成功 | 動く |
  | `queueName: ""` | **同期的に投げる**: `Queue name must be provided` | — | — |
  | `queueName: "a:b"` | **同期的に投げる**: `Queue name cannot contain :` | — | — |
  | `queueName: " "`・`"キュー"`・300 文字 | 成功 | 成功 | 動く |
  | `concurrency: 0`・`NaN`・`1.5`・`"2"` | **投げる**: `concurrency must be a positive integer` | — | —（driver 自身の検査） |

  - **回復**【実測】: 負の `everyMs` で止まった queue に、同じ `queueName`・正しい `everyMs: 100` の driver が `start()` すると、scheduler が上書きされて tick が再開した（2 回目の driver で 1.5 秒に 14 tick）。
  - `queueName` が空文字・`:` のときは、BullMQ が `Queue` のコンストラクタの冒頭で投げる【現物 `queue-base.js:31-36`】。`createBackend()`（Redis への接続）の前なので、接続は作られない。

- **🔴 静かに止まる入力の詳細**（`start()` は成功し、`onTickError` は 1 回も鳴らない。気づく口が無い形。ADR 0449 の `stop()` の件と同じく、利用者が「動いている」と読んだまま止まっている）【実測。redis-server 7.4.7・bullmq 6.3.8。各入力で、driver を `start()` して 2 秒観測し、`stop()`、同じ不正値の driver を再 `start()` して 2 秒、最後に正しい `everyMs: 100` の driver を `start()` して 1.5 秒観測した】:

  | 入力 | `start()` + 2 秒の tick 数 | `onTickError` | Redis に残るもの（止まった状態） | `stop()` の後 | 同じ不正値で再 `start()` | 正しい値の driver で `start()` |
  |---|---|---|---|---|---|---|
  | `everyMs: -1` | **6 回で止まる**（別の回では 2〜5 回） | 0 回 | scheduler `every: -1`、`delayed` 0、`waiting` 0、完了ジョブ 6 | scheduler は消える（`stop()` が `removeJobScheduler` する）。完了ジョブは残る | 1 回だけ tick して、また止まる | 15 回 tick して再開。scheduler `every: 100` |
  | `everyMs: 0.5` | **3 回で止まる**（別の回では 8 回） | 0 回 | scheduler `every: 0`、`delayed` 0、完了ジョブ 3 | 同上 | 5 回 tick して止まる | 15 回で再開 |
  | `everyMs: 1e21` | **1 回で止まる** | 0 回 | scheduler `every: 1`、**`delayed` 1（次の発火が 1e21 ms 先のジョブ）** | scheduler は消えるが、**`delayed` のジョブ 1 件は残り続ける**（正しい driver が動いた後も `delayed` は 2） | 1 回だけ tick | 15 回で再開 |
  | `jobName: ""` | **1 回で止まる** | 0 回 | scheduler id が空文字（`every: 100`）、`delayed` 0、完了ジョブ 1 | scheduler は消える | 1 回だけ tick | 15 回で再開（`jobName` が既定の `mnemora-tick` の driver は、空文字の scheduler とは別物として登録される） |

  - 止まるまでの回数にはばらつきがある（同じ入力でも回ごとに違った）。【判断】止まる回数は BullMQ の内部の動きで、保証できる数字ではない（原因の機構は読み切っていない。【未確認】）。「数回で止まる」としか言えない。
  - 気づく手がかり: `onTickResult` が呼ばれなくなる。`Queue#getJobSchedulers()` の `every` が期待と違う。`getJobCounts()` の `delayed` が 0（`1e21` は 1 で、時刻が遠すぎる）。いずれも driver は教えない。

- **直し方の候補とそれぞれがかかる線**（依頼主がオーナーへのまとめ問いに回す）:

  | 案 | 内容 | 線 |
  |---|---|---|
  | 案0（採用） | 直さない。README と TSDoc に測定結果を書き、「そのまま渡す」を歯で縛る | 内側（文書と歯） |
  | 案1 | `createBullmqTickDriver(...)` の中で `everyMs`（正の有限の数）・`jobName`（空でない文字列）を検査して投げる。`resolveConcurrency` と同じ形で、`Queue`・`Worker` を作る前に断る | 外側（今は通る入力が投げる。`"50"`・`1.5` を使っている利用者が壊れる） |
  | 案2 | `start()` の中で検査して reject する。構築は通すので、`start()` を呼ぶ時に気づく | 外側（案1より影響が小さいが、今は成功する `start()` が reject する） |
  | 案3 | 正規化する（`everyMs` を `Math.floor` して 1 以上に丸める、空文字の `jobName` を既定に倒す） | 外側（黙って別の値で動く。断らないが、間隔が変わる。`jobName: ""` を既定に倒すのは公開の挙動の変更） |
  | 案4 | `start()` が登録のあと scheduler の `every` を読み戻して一致を確かめる（登録が壊れていたら reject） | 外側（`start()` が往復を 1 つ増やす。成功する `start()` が reject しうる） |

- **穴の評価**【判断】: 静かな破損が1種類ある。**`everyMs` が負・`1` 未満の小数・`1e21`、`jobName` が空文字のとき、`start()` は成功し、`onTickError` にも何も届かないまま、tick が数回で止まる**。止まった scheduler は Redis に残る。ただし、README と TSDoc は「`everyMs` を BullMQ の `repeat.every` にそのまま渡す」と書いており、実装はその通りである。**約束と実装の食い違いではない**（約束に実装を戻す直しが成り立たない）。直すには構築時の検査（断る入力を増やす）が要る。

- **決定**（線の内側＝文書と歯だけ。実装は変えていない）:
  1. `CreateBullmqTickDriverOptions` の `everyMs`・`jobName`・`queueName` の TSDoc に、検査しないこと・不正値の測定結果を書いた。
  2. `packages/bullmq/README.md` に節「`everyMs`・`jobName`・`queueName` は検査しない」を足し、上の表（要点）と「止まったことの見分け方」（`onTickResult` が呼ばれ続けているか、`Queue#getJobSchedulers()` の `every`）を書いた。
  3. 歯 `packages/bullmq/src/__tests__/tick-driver.option-passthrough.test.ts`（Redis の要らない、`bullmq` をモックに差し替える形）: 不正値でも driver が投げず、`upsertJobScheduler(jobName, { every }, { name: jobName })` と `Queue`・`Worker` の第1引数にそのまま渡すことを縛った。`concurrency` が検査されるという非対称の対照も縛った。**誰かが driver に検査を足すとこの歯が赤になる**——その場合は、この ADR と README の節を読み直す役目がある。

- **直さなかった理由（材料）**: 構築時に `everyMs` を「正の有限の数（できれば整数）」、`jobName` を「空でない文字列」と検査して投げるのが自然な直しだが、**今は通る入力が投げるようになる（新しく断る入力）**。依頼主の線の外側。`"50"`（数値の文字列）と `1.5` は今は動いており、これを断ると壊れる利用者がいないとは言えない【未確認】。検査を足すなら、断る範囲（負・`1` 未満・`1e21` 以上・空文字のどこまでか）をオーナーが決めること。

- **検討した代替案**:
  1. **`everyMs`・`jobName` を構築時に検査して投げる。** 採らなかった。上のとおり、新しく断る入力。
  2. **`jobName: ""` を既定（`"mnemora-tick"`）に倒す（`??` を `||` に替える）。** 採らなかった。公開の挙動の変更で、`jobName` の既定の意味が変わる。空文字を渡す利用者は止まっているはずなので、実害は小さいと見るが、挙動の変更は外側。
  3. **BullMQ の例外の文面を driver が包み直す**（`Either .pattern or .every…` は driver の利用者に意味が通じない）。採らなかった。例外の文面の変更で、`start()` の reject の形を変える。材料。
  4. **実 Redis の歯（`*.redis.test.ts`）を足す。** 採らなかった。測定値は版（redis-server・bullmq）に依存し、CI の `packages/bullmq` ジョブに足すと版の更新で揺れうる。数字は ADR と README に書いた。

- **引き受けた負債（材料）**:

  | # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
  |---|---|---|---|---|---|
  | 1 | 負・`1` 未満・`1e21` の `everyMs`、空文字の `jobName` で、`start()` が成功して黙って止まる | 上の表 | tick が止まるが誰にも知らされない | **中**（気づく口が無い。`start()` は成功し `onTickError` も鳴らない。誤った設定という前提だが、気づくのが遅れる） | 構築時の検査を足すとオーナーが決めたとき |
  | 2 | BullMQ の reject の文面が driver の語彙と合わない（`.pattern`） | `everyMs: 0` | 利用者が原因を辿りにくい | 低 | 同上、または包み直すと決めたとき |
  | 3 | `everyMs` の文字列・小数が通る | `"50"`・`1.5` | 動く（切り捨て・数値化は BullMQ 任せ） | 低 | 同上 |

- **探した形の一覧**: `everyMs`（0・負・NaN・Infinity・小数 0.5/1.5・2^31・2^53 超・1e21・数値の文字列・null・undefined）、`jobName`（空・`:`・`repeat:x`・空白・日本語・300 文字）、`queueName`（空・`:`・空白・日本語・300 文字）、`concurrency`（0・NaN・1.5・文字列）。見つからなかった形: `jobName` や `queueName` の `:`（`jobName` は動く。`queueName` は BullMQ が断る）、日本語・長い名前（どちらも動く）。

- **これが覆るとしたら**: 構築時の検査を足すと決まったとき（歯が赤になり、README の節を書き直す）。bullmq の版が上がって不正値の扱いが変わったとき（README の【実測】の版と表を直す）。

- **測っていないこと**: redis-server 7.4.7 以外・bullmq 6.3.8 以外。Cluster・Sentinel。`everyMs` が小さい値（`1`〜`10` ms）での負荷。`start()` を呼ばない driver。`stop()` 後の scheduler の残り（ADR 0449 が測った）。止まった scheduler を Redis から消す手順（`removeJobScheduler`）の実走。

- **追記（ADR 0498、2026-10-02）**: 「これが覆るとしたら」の条件が満たされた。オーナーが v1.X.0 での破壊的変更を許したので、案1を採り、`everyMs`・`jobName` を構築時に断る形にした（`queueName` は BullMQ が投げるので触らない）。上の「決定」の3（歯）と README の節は書き換わっている。この ADR の本文（測定値・案の比較）はそのまま残す。
