# ADR 0655: `@mnemora/bullmq` の `stop()` は、この queue に自分以外の Worker が居るとき共有 scheduler を消さない（ADR 0449 の材料3の一部を直す）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

> **⚠ この判断はクローン（依頼主）のものであり、⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> オーナーへのまとめ問い 374f6f88 の問9（repo の外。オーナーには推奨なしで聞いていて、**未回答**）について、クローンが「案4」を選んだ。
> 実装・実測は担い手（マネージャー mgr-f1a44881 の配下）が行った。**この ADR を「オーナーが決めた」と読まないこと。**
> オーナーが覆せる点は「これが覆るとしたら」に問いの候補として書いた。

- **【現物】** — 読んだコード・文書。**【実測】** — この PR の担い手が手元で走らせた結果。**【受】** — 報告として受け取り、再導出していない。

**測定条件**: 断りの無い【現物】【実測】は `origin/main` = `48e297e6` の木（2026-10-06）、redis-server 7.4.7（自分専用ポート）、bullmq 6.3.8、ioredis 6.0.0。

## 文脈

- 【現物】[ADR 0449](./0449-bullmq-tick-driver-measured-against-real-redis.md) の表の3行目「1台の `stop()` が全プロセスの発火を止める」は、実測で確かめたうえで「直していない」とし、オーナー判断の材料に回した（緊急度は【判断】で高い）。`stop()` は共有の scheduler（同じ `queueName`・`jobName` の全プロセスで1つ）を `queue.removeJobScheduler(jobName)` で消すので、動いたままの他のプロセスの Worker の tick も止まる。エラーにもならない。
- 【受】前回の調査の再現: 別プロセス3つ・`everyMs=100`・各1回で、`B.stop()` の後5秒間 A の tick は 0 回。陽性対照（`stop()` の前）は A が 49 回。Worker の居ない scheduler は、5秒で waiting が1件のままで溜まらなかった。
- 【現物】ADR 0449 が材料3の直し方として退けていたのは、「`stop()` が scheduler を消さないよう直す」案だった。理由は、公開の振る舞いの変更であることと、`stop()` の後に Worker の居ない発火が溜まる別の問題が出ること。
- 【現物】`@mnemora/bullmq` は npm に出ている（`v1.1.0` 以降）。rolling deploy（新しいプロセスを `start()` してから古いプロセスを `stop()` する）の順でも、古い方の `stop()` が新しい方の登録を消す。
- 【実測】この PR の担い手が、同じプロセス内に2つの driver（同じ `queueName`・`everyMs: 100`）で測った。`B.stop()` の後5秒間、A の tick は +49 回、`getJobSchedulers()` は1件。続けて `A.stop()` で 0 件。**ADR 0449 の時点の実装（この PR の1つ目の commit まで）では、同じ歯が赤**（下の「測ったこと」）。

## 決定

1. **`stop()` は、`removeJobScheduler` の前に `queue.getWorkers()` で「この queue に自分以外の Worker が居るか」を見る。居れば scheduler を消さない。居なければ（最後の1台）今までどおり消す。** その後の `worker.close()` / `queue.close()` は今までどおり。
2. **居るかどうか分からないときは、今までどおり消す側に倒す。** 具体的には次の2つ。
   - `getWorkers()` が throw した（`CLIENT LIST` を禁じた ACL・接続の失敗など）。
   - 一覧の行に `rawname` が無い。【現物】bullmq 6.3.8 の `baseGetClients` は、`CLIENT` コマンドが未対応（エラー文が ``ERR unknown command `client` `` に当たる）のとき throw せず、`[{ name: "GCP does not support client list" }]` という偽の1件を返す。これを「他の Worker が居る」と読むと、`CLIENT` の使えない環境で scheduler が誰にも消されず残る。
3. **公開 API（型・オプション・既定値）は変えない。** 単一プロセス（Worker が自分だけ）の意味も変えない。`pnpm api:check` は差分 0。
4. **直さないもの**: (b) 永続化なしの Redis の再起動で scheduler が消える件（ADR 0449 の表の4行目）。案1（`stop()` は scheduler を消さず、別のメソッドで消す）。

## 「自分」の見分け方とその根拠

- 【現物】`queue.getWorkers()`（`queue-getters.js`）は `CLIENT LIST` を読み、接続名が `<prefix>:<base64(queue)>`（名前なしの Worker）または `<prefix>:<base64(queue)>:w:<name>` で始まる行を返す。各行の `rawname` が接続名そのもので、`name` は queue 名に書き換えられる。
- 【現物】Worker の blocking 接続の名前は `utils/create-backend.js` の `createBlockingConnection` が決める。Worker の `name` オプションがあれば `:w:<name>` が付く。Worker の `id`（`randomUUID`）は接続名に入らない。
- ⟹ **driver ごとに一意な Worker 名（`mnemora-tick-<randomUUID>`）を `Worker` の `name` に渡し、`rawname` が `:w:<その名前>` で終わる行だけを自分として除く。** 残った行（名前なしの Worker＝この変更より古い版の driver、他の driver の Worker）は「他」と数える。
- 【現物】Worker の `name` は `moveToActive` にも渡され、bullmq 6.3.8 の `commands/includes/prepareJobForProcessing.lua` が、処理を始めたジョブのハッシュに `pb`（processedBy）フィールドとしてその名前を書く。テレメトリを有効にしていれば、属性 `WorkerName` にも載る（`classes/worker.js`）。tick のジョブの処理の中身には影響しない。公開の型には出ない。
- 【実測】同じプロセス内の2つの driver で `getWorkers()` が返した `rawname` は、`bull:<base64(queue)>:w:mnemora-tick-<uuid>` の形で、2台それぞれに違う uuid が付いていた。
- **自分の接続を判別できない場合**: 自分の接続名が付かない環境（`SETNAME` を無視するプロキシなど）では、自分も他も一覧に出ない。「他が居る」と言えないので、今までどおり消す。⟹ **判別できないときは必ず「消す」側に倒れ、「消さない」側には倒れない。**
- 【現物】`getWorkers()` が見るのは Redis 上の接続であり、`stop()` の中で自分の `worker.close()` は `getWorkers()` の後に走る。自分の行は一覧に在り、上の規則で除かれる。

## 採らなかった案

- **案1: `stop()` は scheduler を消さず、別のメソッド（例: `removeScheduler()`）で消す。** `stop()` の意味が変わる破壊的変更で、公開 API の追加でもある。オーナーの領分。ADR 0449 の「`stop()` の後に Worker の居ない発火が溜まる」問題が、単一プロセスの利用者に出る。
- **案2: `stop({ removeScheduler })` のオプション。** 公開 API の追加（`### Added`）で、既定のままでは落とし穴が残る。気付いた人しか直らない。
- **案3: 定期的な `upsertJobScheduler` による自己修復。** 全部止めたい `stop()` と競合し（消した直後に別の driver が登録し直す）、`everyMs` の違う driver が上書きし合う。
- **案4（採用）の中での代替: Worker の `id` や接続の `id` で自分を見分ける。** Worker の `id` は接続名に入らない。接続の `id`（`CLIENT ID`）を自分の blocking 接続から取る手もあるが、`worker.client` を経由する内部への依存が増える。名前を自分で付けるほうが小さい。
- **`getWorkers()` が throw したとき「消さない」側に倒す。** `CLIENT LIST` の使えない環境で scheduler が誰にも消されず残り続ける。今までの利用者の `stop()` の意味（最後の1台が止めたら予定が消える）を壊す。

## 引き受けた負債

- **2台が同時に `stop()` すると、互いに相手を見て、どちらも消さず、scheduler が1件残りうる。** 【実測】同じプロセスで `Promise.all([a.stop(), b.stop()])` したら `getJobSchedulers()` は1件残り、5秒後も1件（waiting 0・delayed 1、active 0）。【受】Worker の居ない scheduler がジョブを溜めない（ADR 0449 の調査の「5秒で waiting が1件」）のは前回の観測で、**長時間は未測定**。次に `start()` する driver が `upsertJobScheduler` で引き継ぐ。歯は縛っていない（競合の再現を保証できない）。
- **`CLIENT LIST` が使えない環境では直らない。** そこでは今までどおり、1台の `stop()` が全プロセスの予定を止める。README と doc に書いた。
- **(b) 永続化なしの Redis の再起動で scheduler が消え、自動では戻らない件は、直っていない。**
- **`getWorkers()` は `CLIENT LIST` を全接続ぶん読む。** `stop()` が1回 Redis の往復を増やす（Redis の接続数が多いとき、`CLIENT LIST` は重い）。`stop()` は終了時に1回なので許容した。測っていない。
- **自分以外の Worker は、止まりかけ（`close()` 中・接続が切れる直前）かもしれない。** 他の Worker が `getWorkers()` の後に落ちると、scheduler は残るが処理する Worker が居なくなる。`stop()` の前後で Worker が居なくなる競合は、同じ形で残る（次に `start()` する driver が引き継ぐ）。
- **Worker に `name` を付けたので、`CLIENT LIST` の接続名が `:w:mnemora-tick-<uuid>` になる。** 運用側で接続名を見ているなら、見え方が変わる。
- **この変更の後に処理された tick のジョブのハッシュには、`pb`（processedBy）= `mnemora-tick-<uuid>` が増える**（Redis に書く中身が1フィールド増える。保存済みのジョブには触らない。完了ジョブは既定で 1000 件まで残るので、その分だけ載る）。読むのは bullmq 側の監視（Bull Board など）だけで、mnemora は読まない。
- **オプション渡しの歯（`tick-driver.option-passthrough.test.ts` の Worker の opts の「丸ごと固定」）に `name` を足した。**

## これが覆るとしたら

- **オーナーへの問いの候補**:
  - 案1（`stop()` は scheduler を消さず、別メソッドで消す）を次のメジャーで採るか。採るなら、この ADR の `getWorkers()` による判定は要らなくなる。
  - (b) 永続化なしの Redis の再起動で scheduler が戻らない件を、自己修復（定期的な `upsertJobScheduler` など）で直すか。直すなら案3と、全部止めたい `stop()` との競合を整理し直す必要がある。
- bullmq の `getWorkers()` の実装（接続名の付け方・偽の1件を返す挙動）が変わったとき（bullmq を上げるとき、`tick-driver.stop-last-worker.redis.test.ts` が落ちる）。
- `CLIENT LIST` が使えない環境が主な利用形態だと分かったとき（この判定が効かない）。
- 同時 `stop()` で scheduler が残ることで、実際に困った報告があったとき。

## 測ったこと / 確かめていないこと

**測ったこと**（【実測】）:

- **赤**（実装の前の木、1つ目の commit）: `REDIS_PORT=<自分専用ポート> pnpm --filter @mnemora/bullmq run test:redis` の対象2ファイルで、本体（2台のうち1台が `stop()` しても scheduler が残り tick が続く）・「全員が順に `stop()` したら最後の1台が消す」・書き換えた既存の `tick-driver.shared-scheduler.redis.test.ts` の1件が赤。陽性対照と `getWorkers()` 失敗の2件は緑のまま（今の振る舞いを縛る側）。
- **緑**（実装後）: 同じ2ファイルで10件緑。
- **変異試験**（`tick-driver.ts` を `cp` で退避→変異→`cp` で戻し）: (m1) `getWorkers()` の結果を無視して常に消す → 本体など3件赤。(m2) 自分も数える（`workers.length > 0`）→ 陽性対照と「全員が順に」の2件赤。(m3) catch で消さない側へ倒す → `getWorkers()` が throw する歯が赤。(m4) `rawname` が無い行の扱いを外す → 偽の1件の歯が赤。いずれも戻して緑に戻ることを確かめた。
- 同じプロセス内の2台の driver での再現の数字（上の「文脈」と「引き受けた負債」）。

**確かめていないこと**:

- 別プロセス（OS プロセス）の driver での再測定。前回の調査の数字は【受】のまま。この PR の歯は同じプロセスの複数の driver である（Redis から見れば別の接続）。
- 同時 `stop()` の残骸が長時間どうなるか。
- `CLIENT LIST` を実際に禁じた Redis（ACL）。`getWorkers()` の失敗の注入で見ただけ。
- Redis Cluster・Sentinel。`getWorkers()` の cluster の扱い（ノードごとの一覧のうち最大のもの）は読んだだけ。
- `getWorkers()` が使えない環境が実際にどれだけ在るか。
