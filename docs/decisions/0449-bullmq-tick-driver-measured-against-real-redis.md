# ADR 0449: bullmq の tick-driver を実 Redis（redis-server 7.4.7）に当てた——文書の「未実測」7件を測り、ずれた所だけ文書を直す・README の片に型検査の印を付ける

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0d3098f9）が書いた。直し方の線（「文書を直す。口は足さない」）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探しの25巡目。`packages/bullmq` の README と `tick-driver.ts` の doc は、「コードからの読み」「Redis が無いため走らせていない」と自認する約束を7件抱えていた
  （[ADR 0440](./0440-outbox-first-terminal-wins-extraction-local-date-years-bullmq-stalled.md) の stalled を含む）。実 Redis で走る歯は2本（`concurrent-tick.redis.test.ts`・`tick-driver.failed.redis.test.ts`）だけだった。
  今回は **redis-server 7.4.7**（CI の `redis:7` に揃えた。conda-forge の `redis-server-7.4.7` を、compiler も root も無い器で、`.conda` を node で展開して使った）と bullmq 6.3.8（`ioredis` 6）で測った。
  ⚠ **版が違えば数字は変わりうる**（8.x は測っていない）。

  併せて、依頼の前提にあった「TSDoc の `@example`」は**0件**だった（非テストの `.ts`）。TSDoc 内の ```ts は2件だけ（`tick-driver.ts` の「使い方」、testkit の `in-memory-event-store.ts`）。
  `scripts/check-doc-snippets.mjs`（[ADR 0345](./0345-doc-snippets-typechecked-opt-in-gate.md)）は `*.md` の ```` ```ts check ```` の印の付いた片しか見ず、`.ts` の TSDoc は見ない。
  `packages/bullmq/README.md` の見出しは「動く最小の例（……型のみ確認）」と書いていたのに、印が0件で門を通っていなかった（openai・anthropic の README も0件）。

- **決めたこと**:

  1. **測った結果と文書の突き合わせ**（【実測】redis-server 7.4.7・bullmq 6.3.8・node v22.23.3）。測定の道具は commit していない（`.hunt-r25/`）。次の「測ったこと」に手順と数字を書いた。

     | # | 文書の約束 | 実測 | 判定 |
     |---|---|---|---|
     | 1 | 完了・失敗ジョブが全部残り、`everyMs: 5_000` で1日17,280件 | `everyMs: 50`・5秒で完了41・失敗13が残る。1ジョブ約1.5KB（戻り値 `{}` の下限）。`removeOnComplete:{count:5}` の素の Worker は5件で頭打ち。`queue.clean` は全件消した | 一致。README に数字を追記 |
     | 2 | 同じ queueName・jobName で別 ctx の driver が来ると scheduler が1つに上書きされ、どれか1つの tenant の tick にしかならない | scheduler は1つ（後から start した `everyMs`）。7回の tick は A に4回・B に3回。jobName を分けると A・B が15回ずつで scheduler は2つ | 一致。振り分けの実数を追記 |
     | 3 | 1台の `stop()` が全プロセスの発火を止める | 一方を stop すると `getJobSchedulers()` が空になり、動いたままの他方は3秒間0回。`onTickError` は鳴らない。新しい driver の `start()` で再開。**「新を start してから旧を stop」の順（rolling deploy）でも同じ** | 一致。**被害の形を材料として下に出した。直していない** |
     | 4 | （Redis 障害・再接続は「検査していない」） | 6秒の停止で `onTickError` が30回（ECONNREFUSED）。**永続化ありで再起動すると tick は再開（5秒で25回）。永続化なしだと scheduler が消え、tick は再開せず、`onTickError` も鳴らない。Redis が落ちている間の `start()` は reject せず15秒 pending（Redis が戻ると resolve）** | **ずれ（文書に無かった）**。README と TSDoc に追記 |
     | 5 | 「後から呼んだ側は同じスケジュールを再登録するだけ」 | `everyMs` が違うと、**共有の scheduler の間隔が置き換わる**（1000→200→1000ms と変わり、先に動いていた driver の間隔も変わった）。同じ driver の `start()` の重ね呼びは何も変えない | **ずれ（言葉足らず）**。README・TSDoc に追記 |
     | 6 | stalled で `onTickResult` の後に `onTickError` が最大2回（ADR 0440、未実測） | 2プロセス。一方の tick がイベントループを45秒塞ぐと、他方が約65秒後（実行開始から。lock 30秒の後、次の stalled checker）に2本目を走らせ、塞いだ側は45.8秒で `onTickResult`、直後に `onTickError` が2回（`Missing lock ... moveToFinished`）。最終は完了1・失敗0・`attemptsStarted: 2`・`stalledCounter: 1` | 一致（ADR 0440 の読みが裏づいた）。【未実測】を【実測】に直した |
     | 7 | `connection` は ioredis 互換をそのまま使う | ioredis インスタンスを渡すと、`maxRetriesPerRequest: null` が無いインスタンス（ioredis の既定は20）は **`createBullmqTickDriver` が同期的に throw**（`start()` ではない）。`null` のインスタンスは動き、`stop()` の後も閉じられない | **ずれ（文書に無かった）**。README と TSDoc に追記 |

  2. **文書だけを直した**（コードの公開 API・既定値・振る舞いは1つも変えていない）: `packages/bullmq/README.md`（stop・テナント分け・`everyMs` の置き換え・溜まるジョブの数字・Redis 障害・start の pending・ioredis インスタンス・stalled の実測・「確かめていないこと」）と、`packages/bullmq/src/tick-driver.ts` の TSDoc（コメントだけ）。
  3. **実 Redis の歯を1本足した**（`packages/bullmq/src/__tests__/tick-driver.shared-scheduler.redis.test.ts`、3本）: 後から start した `everyMs` が勝つこと、1台の stop が他の driver の発火を止めること（陽性対照として stop 前の発火を見る。新しい driver で再開）、完了ジョブが残ること。⚠ **2本目は望ましい振る舞いの宣言ではなく、今の振る舞いの記録である**。直すなら、この歯の期待を変えること。
  4. **README の `ts` の片に `check` 印を付けた**: bullmq 4片・openai 2片・anthropic 4片。**型が通らなかった片が4つあり、すべて例の書き方だけを直した**（本体の型は変えていない）: anthropic の `createRuntime` の例は省略した部品を `...stores`（`Omit<RuntimeDeps, ...>` の宣言）で補い、`completeStructured` の例は `llmProvider`・`prompt`・`schema` の宣言を足し、bullmq の `onTickError`・`onTickResult` の例は `import` と `...base`（`CreateBullmqTickDriverOptions` の宣言）を足した。**陽性対照**: bullmq の例の `everyMs: 5_000` を `"5s"` にすると、`TS2322` で門が落ちた（戻すと緑）。
  5. **口は足していない**（`lockDuration`・`removeOnComplete`・保持・`stop()` が scheduler を消さない形）。下の「材料」に数字だけ積む。

- **材料（オーナー判断。コードは変えていない）**:

  - **3（stop が全プロセスの発火を止める）の被害の形・再現・緊急度。**
    - 被害の形: **tick が止まるだけで、`onTickError` も例外も出ない**。outbox は Postgres が正本なので行は消えないが、`embed`・`extract` の行が処理されないまま溜まり、新しい記憶が想起に載らない（embedding が付かない）。次に誰かが `start()` するまで続く。止まったことに気づく口が driver には無い。
    - **一番ありふれた引き金**は rolling deploy の「新プロセスを `start()` → 旧プロセスを graceful `stop()`」の順（Kubernetes の既定、SIGTERM で `stop()` を呼ぶ実装）。新しい Worker は生きているのに、旧プロセスの `stop()` が共有の scheduler を消す。台数を減らすスケールインでも同じ。
    - 再現（約10秒、Redis があれば）: 同じ `queueName` で driver A・B を作って `start()` し、`B.stop()` を呼ぶと、`new Queue(name).getJobSchedulers()` が `[]` になり、A の `runtime.tick` が呼ばれなくなる。`tick-driver.shared-scheduler.redis.test.ts` の2本目がそのまま再現する。
    - 緊急度【判断】: **高い**。「データ損失に近い」とまでは言えない（行は残り、新しい driver の `start()` で処理が再開する）が、**静かに止まる**ため検知が遅れ、複数プロセス運用（README が薦める形）で普通に起きる。README の回避策（`stop()` を呼ばずプロセスを終わらせる／stop の後に残りのどれかで新しい driver を `start()`）は、利用者が README を読んでいる前提に頼っている。
    - 直し方の候補（どれも公開 API の挙動の変更で、v2 相当に近い。決めていない）: (a) `stop()` は scheduler を消さない（`removeJobScheduler` を呼ばない）。代わりに「全部止める」ための別の口を足す。ただし、消さないと `stop()` した後も Redis に発火が残り、Worker が居ないので wait にジョブが溜まる（`delayed`→`wait`）。(b) scheduler の登録者を数える（参照カウント。Redis に自前のキーを足す）。(c) `start()` を繰り返し呼ぶ（定期的な再登録）ことを薦める。
  - **1（溜まるジョブ）**: 数字は上の表。`removeOnComplete`・`removeOnFail` の既定を driver に入れる（例: `{ count: 1000 }`）案は、既定値の変更で、結果を後から見たい利用者の見え方が変わるので材料に留める。口だけ足す案（`retention` のような任意項目）は公開 API の追加でオーナー領分（ADR 0440 決定4と同じ線）。
  - **6（stalled）**: `lockDuration` を通す口は、今回の実測で「driver は45秒塞ぐ tick を、約65秒後に別の Worker が再実行し、1本目の完了を記録できない」ことが確かめられたので、**ADR 0440 決定4の判断（口を足さない）の材料が増えた**。追加するかはオーナーが決める。
  - **4（永続化なしの Redis）**: 再起動後に scheduler が戻らない件は、driver が定期的に `upsertJobScheduler` を呼び直せば消える（公開 API の追加ではなく内部の挙動の変更）。ただし、`stop()` 済みの scheduler を勝手に戻す競合が出るので、設計が要る。

- **検討した代替案**:

  1. **`stop()` が scheduler を消さないよう直す。** 採らなかった。公開の振る舞いの変更であり、`stop()` を呼んだ後に Worker の居ない発火が溜まる別の問題が出る。クローン miku の指示（3は直さず材料）。
  2. **測定のスクリプトを `packages/bullmq` に置く。** 採らなかった。数字（件数・秒）は環境で揺れるので、CI の歯には「向き」だけを縛る3本を置いた。
  3. **stalled を実 Redis の歯にする。** 採らなかった。2プロセス・65秒かかり、`lockDuration` が driver から設定できないので、短くできない。
  4. **TSDoc の ```ts を検査する門を足す。** 採らなかった。対象が2件で、道具（md しか見ない）を広げる費用に見合わない。bullmq の1件は README の片と同じ。

- **引き受けた負債**:

  - 測ったのは redis-server 7.4.7 の単体のみ。8.x・Cluster・Sentinel・フェイルオーバーは測っていない。
  - 1ジョブ約1.5KB は戻り値 `{}` の下限。実際の `TickResult` と失敗ジョブの stack では大きい。実運用の量は測っていない。
  - 6 の「約65秒」は、`stalledInterval` の位相に依る（lock が切れてから次の checker までが 0〜30秒）。1回の実測である。
  - 4 の「15秒 pending」は、15秒で観測を打ち切った下限であり、本当に無限かは測っていない。
  - `check` 印を付けた片の型検査は、型だけである（実行はしない）。
  - TSDoc の2件の ```ts は、引き続き門が見ない。

- **これが覆るとしたら**:

  - オーナーが `stop()` の挙動（3）を直すと決めたとき（`tick-driver.shared-scheduler.redis.test.ts` の2本目の期待を変える）。
  - `lockDuration`・`removeOnComplete`・`removeOnFail` を `CreateBullmqTickDriverOptions` に通すと決めたとき（公開 API の追加）。
  - redis-server の別の版で数字や挙動が違うと分かったとき（README の【実測】の版と数字を直す）。

- **測ったこと**（【実測】2026-10-01、redis-server 7.4.7、bullmq 6.3.8、ioredis 6、node v22.23.3。ポート 56440）:

  - 1: `everyMs: 50` の driver を5秒（tick を4回に1回 throw）→ `getJobCounts` 完了41・失敗13・delayed 1・active 1、キー66、`MEMORY USAGE` の合計 83,510B（約1,546B/ジョブ）。`queue.clean(0, 0, ...)` が完了42・失敗13を消し、`DBSIZE` 4。対照の `removeOnComplete:{count:5}`・3秒 → 完了5。
  - 2・3・5: 同じ queue に複数 driver（1プロセス内で Worker を複数）。上の表の数字。3は、`stop()` の前に A が 2 回・B が 8 回 tick していること（陽性対照）、`B.stop()` の後の3秒で A が0回、新しい driver C の `start()` の後2秒で10回。
  - 4: 動いている driver の Redis を `shutdown nosave` で止め、`redis-server` を再起動（永続化なし／`appendonly yes --appendfsync always`）。`start()` の pending は、Redis を止めたまま `start()` を呼び15秒観測（`maxRetriesPerRequest: null` と未指定の両方）。
  - 6: 親が2つの子プロセス（`block`＝`tick` が45秒の busy loop、`fast`）を同じ queue で起動（`everyMs: 600000` で1ジョブに絞る）。時刻は実行開始からの秒。`block` が tick START 0.8s、`fast` 起動 4.9s、`block` の tick END と `onTickResult` 45.8s、`onTickError`×2 45.8s/45.9s、`fast` の tick START・END・`onTickResult` 64.9s。最終 `completed:1, failed:0`。
  - 7: インスタンス3通り（既定／`null`／2つの driver で共有）。
  - 歯: `pnpm --filter @mnemora/bullmq exec vitest run -c vitest.redis.config.mts src/__tests__/tick-driver.shared-scheduler.redis.test.ts src/__tests__/tick-driver.failed.redis.test.ts`（`REDIS_PORT=56440`）4本緑。**変異**: `stop()` の `removeJobScheduler` を外すと、2本目が赤（他は緑）。戻すと緑。
  - `pnpm run check:doc-snippets`: 印の付いた片34件、落ちた片0件（上の4片を直した後）。陽性対照は決めたこと4。
  - **測っていないこと**: 上の負債のとおり。

---

**2026-10-06 追記**: 材料3（1台の `stop()` が全プロセスの発火を止める）は、[ADR 0655](./0655-bullmq-stop-removes-scheduler-only-when-last-worker.md) で一部直した。`stop()` は、この queue に自分以外の Worker が居るときは共有の scheduler を消さない（最後の1台だけが消す）。`CLIENT LIST` が使えない環境では今までどおり消す。同時に `stop()` する2台が互いに相手を見て scheduler が1件残る点と、材料の (b)（永続化なしの Redis の再起動で scheduler が消える件）は直っていない。この判断はクローン（依頼主）のもので、オーナー本人の判定ではない（ADR 0220）。上の本文は当時の記録であり書き換えていない。
