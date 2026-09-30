# ADR 0407: `extract: "sync"` の observe は、積んだ extract ジョブを claim 済みの状態で作る（`createObservationWithOutbox` の `opts.claimedBy?`）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「決めたこと」の各項の末尾にある。**

- **文脈**:

  `runtime.observe` の `extract: "sync"`（既定）は、`createObservationWithOutbox(ctx, obs, ["extract"], { now })` で
  extract ジョブを**すぐ claim できる状態**（未 claim・`attempts: 0`・`available_at <= now`）で積み、その場で
  `runExtraction`（LLM）を待ち、終わったら `complete(ctx, job.id, job.attempts)` を呼ぶ。
  tick worker の `claimBatch` は、observe が LLM を待っている間にその行を claim できる。
  起きること（穴 D-1、Postgres と InMemory の両方で再現した）:

  1. sync の observe が LLM を待つ間に、tick が同じジョブを claim する（`attempts` 1）。
  2. tick も LLM を呼ぶ。**LLM が2回呼ばれ、内容の違う記憶が2件とも active で残る**
     （同じ本文なら冪等の鍵で1件に畳まれる。[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) の並行配達の節と同じ形）。
  3. observe の `complete` は `attempts` の CAS に負け、`OutboxLeaseConflictError` を投げる。
     **書き込みは済んでいるのに observe が失敗し、`memoryIds` が返らない。**

  ジョブの目的は transactional outbox（[docs/architecture.md](../architecture.md) §3.4）——observe の
  コミットとジョブの積みを同一トランザクションにして、observe が途中で死んでも tick が後で拾えること——である。
  sync の間だけは、observe 自身が処理を持っている。

- **決めたこと**:

  1. **sync で積む extract ジョブは、observe が「claim 済み」の状態で作る。**
     `MemoryStore.createObservationWithOutbox` の `opts` に、省略可能な `claimedBy?: string` を足す。
     渡すと、積む行は `claimed_at = opts.now`（省略時は壁時計）・`claimed_by = claimedBy`・`attempts = 1`
     （`claimBatch` の初回の claim が付ける値と同じ）で作られる。返る `jobs[].attempts`（= 1）を、observe は
     そのまま `complete` の `expectedAttempts`（CAS のフェンシングトークン、[ADR 0142](./0142-outbox-complete-fail-compare-and-swap.md)）に渡す。
     runtime は `extract: "sync"` のときだけ `claimedBy: "runtime.observe:sync"` を渡す。**deferred は今までどおり**
     （tick に渡すためのジョブなので、未 claim で積む）。
     **`claimBatch` の `WHERE`（リースの判定）は1行も変えない。**observe は「自分が claim した worker」として
     現れるだけで、他の worker から見れば、リース（[ADR 0032](./0032-outbox-claim-lease.md)）を持っている行である。

  2. **observe が LLM の途中で死んだとき**: ジョブは claim 済みのまま残り、tick の `leaseMs` が切れた後に
     `claimBatch` が拾う（`claimed_at <= now - leaseMs`）。transactional outbox の意味（クラッシュしても失われない）は
     保たれる。取り直しでは `attempts` が 2 になり、`available_at` が `now` に書き直される
     （[ADR 0357](./0357-outbox-reclaim-requeues-to-tail.md)）。歯: 「observe が LLM の途中で死んだ（戻らない）とき、
     リースが切れた後は tick が拾う」。

  3. **LLM がリースより長くかかったとき**: リース切れの後、tick が同じジョブを取り直しうる。**これは塞がない**
     ——リースはそのための仕組みであり、observe の LLM 呼び出しに上限の時間を課す案は採らない（下）。
     このとき observe の `complete` は `OutboxLeaseConflictError` で負けるが、**observe は例外を握って通常の結果を返す**
     （`memoryIds` は observe 自身が書いたもの）。書き込み済みの observe を失敗にしない。
     ジョブの終端は取り直した側が持つ。**握るのは `OutboxLeaseConflictError` だけ**で、それ以外の例外
     （接続断など）は今までどおり投げる。この窓での二重抽出（内容の違う2件が active）は残る
     （[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) の「並行の再配達は塞げない」と同じ負債。
     `leaseMs` を LLM の最長時間より長くとる運用で狭める）。歯: 「LLM がリースより長くかかり tick に取り直されても、
     書き込み済みの observe は例外を投げず memoryIds を返す」。

  4. **InMemory の outbox（`@mnemora/testkit`）と core の Fake も同じ意味にする。** `claimedBy` を渡すと
     `claimedAt = now`・`attempts: 1` で作る。あわせて、core の `FakeMemoryStore.createObservationWithOutbox` は
     job の**複製**を返すようにした（Postgres の `INSERT ... RETURNING` と同じ）。生の参照を返していたため、
     後の claim が observe の手元の `attempts` を書き換え、CAS の食い違いが Fake の上では起きなかった。
     適合テスト（`memory-store-conformance.ts`）に、`claimedBy` の指定あり・なしの2件を足した。

  5. **破壊的かどうか**: **破壊的ではない。** `opts` は既に省略可能な第4引数で（Issue #1237）、`claimedBy` も省略可能。
     省略時の振る舞いは今日と同じ。第三者の `MemoryStore` 実装が `claimedBy` を無視しても型は通る——ただしその実装では
     穴が塞がらない（無視すると未 claim・`attempts: 0` で積まれ、従来の動きになる）。公開 API の snapshot
     （`core.d.ts`・`postgres.d.ts`・`testkit.d.ts`）は、この1欄の分だけ変わる。**v1.2.0 の Fixed として出す。**

- **採らなかった案**:

  - **`available_at` を先へずらして積む（`now + leaseMs` 等）**: runtime は tick の `leaseMs` を知らない
    （tick ごとに呼び出し側が渡す）。ずらす幅を発明することになり、tick の `leaseMs` より短ければ穴は残る。
    また行は未 claim・`attempts: 0` のままで、`claimed_by` にも observe が持っている印が残らない。
  - **sync では outbox を積まず、observe が成功したときだけ完了済みの行を書く**: observe が LLM の途中で死んだとき、
    ジョブが無く、tick が拾えない。transactional outbox の意味が失われる。
  - **observe の `complete` が負けたら例外のまま投げる（今の動き）**: 書き込み済みなのに失敗になり、
    呼び出し側が再送すると冪等（`created: false`）で `memoryIds: []` が返る——結果が永久に失われる。
  - **LLM 呼び出しに、リースより短い上限を課す**: LLM の遅延の分布を core が決めることになる。
    上限に当たると全文フォールバック等の別の挙動が要り、範囲が広がる。
  - **`claimBatch` 側で `claimed_by` が特定の値の行を飛ばす**: 待つ側（tick）の判定を書き換えると、
    クラッシュした observe の行が永久に拾われなくなる（リースの意味を壊す）。

- **引き受けた負債**:

  - リースより長い LLM 呼び出しでは、二重抽出の窓が残る（決めたこと3）。
  - 取り直された行の `claimed_by` は tick の worker になる。observe が書いた抽出結果と、tick が書いた結果の
    どちらが「本物」かは決めない（どちらも `extracted` の記憶で、冪等の鍵で同一本文は1件に畳まれる）。
