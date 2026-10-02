# ADR 0548: `createBullmqTickDriver` に `lockDuration` の口と完了ジョブの保持の既定（`removeOnComplete: { count: 1000 }`）を足す — ADR 0440 の決定4、ADR 0449 の決定5・材料1・材料6 を置き換える

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

担い手が書いた。依頼はマネージャーから来た（オーナーへの問い 374f6f88 の問6を実装する、という形。決まっていることとして「`lockDuration` の口を足す」「`removeOnComplete: { count: 1000 }` を既定にする」「`removeOnFail` は触らない」が渡された）。担い手は、その問いにオーナーが答えた記録そのものは見ていない。**オーナーの判断かどうかは、この ADR からは確かめられない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 文脈

- [ADR 0440](./0440-outbox-first-terminal-wins-extraction-local-date-years-bullmq-stalled.md) の決定4は「`lockDuration` を通す口は足さなかった」だった。[ADR 0449](./0449-bullmq-tick-driver-measured-against-real-redis.md) は実 Redis の測定で、決定5「口は足していない（`lockDuration`・`removeOnComplete`・保持・`stop()` が scheduler を消さない形）」とし、判断を「材料」に積んで、オーナーに預けた。
- 0449 の実測（【実測】redis-server 7.4.7・bullmq 6.3.8）: 完了ジョブは `everyMs` ごとに1件ずつ、全部残る。45秒塞ぐ tick は約65秒後に別の Worker が再実行し、1本目の完了を記録できない（lock の期限が既定 30000 ms で、driver から変えられない）。
- 今回、この2つについて「口を足す・既定を入れる」と決まった。

## 決めたこと

1. **`CreateBullmqTickDriverOptions.lockDuration?: number | undefined` を足し、渡されたときだけ `Worker` の opts に載せる。** 省略なら BullMQ の既定（30000 ms）のまま。検査は ADR 0525 の形: 数でなければ `TypeError`、整数でない・`NaN`・`Infinity`・`1` 未満・`Number.MAX_SAFE_INTEGER` 超なら `RangeError`。message は `createBullmqTickDriver: lockDuration must be a positive integer (milliseconds), got <値>`。`Queue`・`Worker` は作る前に投げる。検査の順は `everyMs` → `jobName` → `concurrency` → `lockDuration` → `completedJobsToKeep`。
2. **`queue.upsertJobScheduler` の第3引数（job template）に `opts: { removeOnComplete: { count: 1000 } }` を既定で入れる。** `removeOnFail` は指定しない（失敗したジョブは従来どおり全部残る）。
3. **上書きの口は1つだけ足す: `completedJobsToKeep?: number | undefined`（既定 `1000`）。** `removeOnComplete: { count: <値> }` になる。`0` 以上の整数。検査は上と同じ形（数でなければ `TypeError`、小数・非有限・負・`MAX_SAFE_INTEGER` 超なら `RangeError`）。
   - 足した理由【判断】: 既定の変更は、完了ジョブの `returnvalue`（`TickResult`）を `queue.getJobs(["completed"])` で後から読んでいた人の見え方を変える（Breaking）。上書きの口が無いと、その人は新しい既定を避けられず、`Queue` を自分で作って template を書き換える手段も無い（template は driver の中の `upsertJobScheduler` だけが持つ）。口が1つ（件数）あれば、「多めに残す」「`Number.MAX_SAFE_INTEGER` で以前に近づける」「`0` ですぐ消す」が表せる。
   - **口を最小にした理由**【判断】: BullMQ の `KeepJobs`（`count`・`age`）や `boolean` をそのまま通す案は、検査の面が広がり（`age` の単位・`true`/`false`・`-1` の意味）、公開 API が BullMQ の型に結びつく。件数1つなら検査は `lockDuration` と同じ形で済む。`age` による保持・`removeOnFail` の口は足していない。
   - 名前【判断】: `removeOnComplete` と呼ばない。BullMQ の同名の欄は `boolean | number | KeepJobs` を取り、`true`（すぐ消す）と数（残す件数）で向きが逆の読み方がある。`completedJobsToKeep` は「残す件数」に決め打てる。
4. **README・TSDoc を直した**: `tick-driver.ts` の冒頭 doc の「完了したジョブ・失敗したジョブは Redis に残り続ける」の節（旧 `:84` 付近）と、`onTickError` の doc の「この driver からは設定できない」（旧 `:178` 付近）。README の保持の節・stalled の節（対処に `lockDuration` を書いた）・検査の表。公開 API の snapshot（`scripts/__snapshots__/public-api/bullmq.d.ts`）は `pnpm api:write` で更新した。
5. **CHANGELOG `[1.3.0]`**: 既定の変更を `### Breaking`、2つの口を `### Added`。`[1.2.0]` には触れていない。migration-v1 は、依頼の指示により 🟡「v1.2.0 → 次の版で、挙動が変わるが手順は要らないもの」に入れた。

## 置き換えるもの

古い ADR の本文は書き換えていない（[README](./README.md) の作法）。この ADR が上書きするのは次の4点で、読む人は新しい側を現在の決定として読むこと。

| 古い側 | 当時の決定 | この ADR での置き換え |
|---|---|---|
| ADR 0440 決定4（および同 ADR の「検討した代替案」7） | `lockDuration` を通す口は足さない | **足す。** 決定1。 |
| ADR 0449 決定5 | 口は足していない（`lockDuration`・`removeOnComplete`・保持・`stop()` が scheduler を消さない形） | `lockDuration`・`removeOnComplete`（既定）・保持の口（`completedJobsToKeep`）は**足した**（決定1〜3）。**`stop()` が scheduler を消さない形は、足していない**（0449 の材料3のまま。この ADR は触れない）。 |
| ADR 0449 材料1（溜まるジョブ） | `removeOnComplete`・`removeOnFail` の既定を入れる案（例: `{ count: 1000 }`）は材料に留める。口だけ足す案はオーナー領分 | **`removeOnComplete: { count: 1000 }` を既定に採る。口は `completedJobsToKeep`。`removeOnFail` は触らない**（決定2・3）。 |
| ADR 0449 材料6（stalled） | `lockDuration` を通す口を足すかはオーナーが決める | **足す**（決定1）。 |

**「0449-2」に当たる番号は、ADR 0449 に無い**【現物】（`docs/decisions/0449-bullmq-tick-driver-measured-against-real-redis.md` を読んで確かめた）。0449 の番号は次のとおり。
- 「決めたこと」は 1〜5 の5項目。**決定2は「文書だけを直した」**で、`lockDuration`・`removeOnComplete` に触れない。
- 「測った結果と文書の突き合わせ」の表は行 1〜7。**行2は「別 ctx の driver が同じ queueName・jobName に来ると scheduler が1つに上書きされる」**で、これも本件と関係しない。
- 「材料」の見出しは 3・1・6・4 の4つで、**2は無い**（`lockDuration` に当たるのは材料6、`removeOnComplete` に当たるのは材料1）。
- 「検討した代替案」は 1〜4。代替案2は「測定のスクリプトを置く」。
つまり、依頼文の「0449-2」が指すもの（もしあれば）は、決定2・表の行2・代替案2のどれとも、材料の2とも一致しない。この ADR は、置き換える対象を決定5・材料1・材料6に決めた。

## 採らなかった案

1. **既定を入れるだけで、上書きの口を足さない。** 退けた（決定3の理由）。
2. **`removeOnComplete`／`removeOnFail` を BullMQ の型のまま通す口。** 退けた（決定3の最小性の理由）。
3. **`removeOnFail` にも既定を入れる。** 退けた。失敗は原因を調べる材料で、`TickResult` を持つ完了ジョブと違い、消してよいかは利用者の運用による。決まっていることとして「触らない」とされた。
4. **Worker の opts（`WorkerOptions.removeOnComplete`）に置く。** 退けた【判断】。【現物】bullmq 6.3.8 の `redis-queue-backend.js` の `getKeepJobs(shouldRemove, workerKeepJobs)` は、job の opts に `removeOnComplete` があればそれを使い、無いときだけ Worker の値に倒れる。繰り返しジョブの job は `job-scheduler.js` が template の opts を各 job の opts へ混ぜて作る（`getNextJobOpts`）。依頼どおり template（`upsertJobScheduler` の第3引数）に置いた。**template の opts が実際の job に効いて完了ジョブが頭打ちになることは、実 Redis では確かめていない**（上記は現物の読み。CI の `bullmq` job の新しい redis 歯が確かめる）。
5. **`lockDuration` に上限を置かない。** 退けた【判断】。`everyMs`（ADR 0498）が `1e21` で黙って止まった例があるので、`Number.MAX_SAFE_INTEGER` で断った。この上限は `everyMs` に合わせた安全側の線であり、`lockDuration` を Redis に渡して測った境目ではない。

## 引き受けた負債

| # | 負債 | 緊急度 | 覆る条件 |
|---|---|---|---|
| 1 | 既定の変更は Breaking。完了ジョブを後から読んでいた人は古い分が読めなくなる。`completedJobsToKeep: Number.MAX_SAFE_INTEGER` で近づけられるが、「ちょうど以前と同じ」（`-1`）は表せない | 中 | 以前と同じ挙動を求める声が出たとき |
| 2 | 失敗したジョブは溜まり続ける（`removeOnFail` を触らない）。掃除は利用者が `queue.clean` で行う | 低 | 失敗ジョブの溜まりが問題になったとき |
| 3 | `stalledInterval` など Worker のほかの設定は通していない。`lockDuration` だけを長くしても、stalled checker の周期は 30000 ms のまま | 低 | 他の設定も要ると分かったとき |
| 4 | 既に動いている scheduler は、`upsertJobScheduler` の再呼び出しで template が更新される読み【未確認】。更新前の job template で作られた次回の job に新しい opts が載るか、実 Redis で見ていない | 中 | CI の `bullmq` job の結果、または手元の実 Redis での測定 |

## これが覆るとしたら

1000 件が小さすぎる／大きすぎる運用が出たとき（`completedJobsToKeep` で変えられるので、既定の値だけの話）。`lockDuration` を長くしても stalled が減らない、または長くしたことで別の害が出たと実測されたとき。オーナーが、既定の変更（Breaking）を取り下げるとき。

## 赤→緑・変異【実測。mock のテストはファイルを名指しして走らせた】

（担い手の報告に表で書き、PR 本文にも載せる。ここには数字を写さない。）

## 測っていないこと

- 実 Redis での `removeOnComplete: { count }` の頭打ち（`tick-driver.shared-scheduler.redis.test.ts` の新しい2本）。この器に Redis が無いので、手元では走らせていない。CI の `bullmq` job に任せる。
- 実 Redis で `lockDuration` を長くしたときに、45秒塞ぐ tick の再実行が起きなくなること（ADR 0449 の2プロセスの測定を、`lockDuration` 付きで繰り返していない）。
- redis-server 8.x、bullmq 6.3.8 以外の版。
