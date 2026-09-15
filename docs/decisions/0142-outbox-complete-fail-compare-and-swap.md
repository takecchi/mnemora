# ADR 0142: `OutboxStore.complete`/`fail` を compare-and-swap にする — `attempts` をフェンシングトークンに使う（Issue #233、ADR 0032 が残した named debt の実装）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 結論

**再現できた。**`OutboxStore.complete`/`fail` は条件なしの単純 `UPDATE` であり、リースが切れて
別のワーカーが再 claim・完了させた後に、遅れて戻ってきた古いワーカーが `complete`/`fail` を
呼ぶと、**新しいワーカーが書いた終端状態を検知なく上書きしうる**ことを、この作業環境で
実際にテストとして走らせて確認した（下記「測ったこと」の再現テスト参照）。

**`OutboxStore.complete`/`fail` に `expectedAttempts: number`（必須・省略不可）を追加し、
`attempts` 列（`claimBatch` が claim のたびに厳密に単調増加させる列、ADR 0032）を
フェンシングトークンとして使う compare-and-swap にする。** 一致しなければ
`OutboxLeaseConflictError` を投げる。対象の行がそもそも存在しない場合は、
`expectedAttempts` の値に関わらず例外を投げない（べき等な終端更新、既存契約を維持）。

**壊れる人がどれだけ居るか（本リポジトリ内で実際に数えた件数）と、「外部の利用実態は
確認できない」は別の主張であり、下の「誰が壊れうるか」で段落を分けて書く。**

---

## §3 の手続きについて（オーナーの決定の記録）

`docs/autonomy.md` §3 の⛔表は「公開 API の破壊的変更」を「`0.x` なので semver 上は
許されるが、提起までにする。ADR を書き、実装は別 PR にして、承認を待つ」と定めている。
本 ADR が実装する変更（`complete`/`fail` が第三引数 `expectedAttempts` を必須で要求する
ようになる)はこの条項に該当する。

**マネージャー経由で、オーナー本人の回答として次を受領した**（逐語、本タスクの指示に
そのまま示された文言。**私自身がオーナー本人に直接確認したものではない**）:

> **ほとんど使われていない(v0.X.X)の段階なので破壊的変更であっても構わず実装してください**

この文言は [ADR 0140](./0140-contested-write-side-companion-required.md) が Issue #243 に
ついて引いたものと一字一句同じである。**同じ回答が別の issue にも適用される標準方針として
転用されたのか、独立に同じ判断が今回も下ったのかは、私には分からない**——マネージャー経由の
受領であり、出所を検算する手段がこの作業環境には無い。**ただし、いずれであっても
「この具体的な変更（`OutboxStore.complete`/`fail` への `expectedAttempts` 追加）を実装して
よい」という許可として使うことに支障は無い**と判断した——ADR 0140 と同じ理由（0.x・破壊的変更が
許容される段階・記録は残す）がそのまま当てはまるため。

**⟹ §3 の「公開 API の破壊的変更は提起までにする」条項は、この件については解けた。**
**「気にせず実装してよい」は「記録しなくてよい」ではない**——以下の「誰が壊れうるか」
「移行の道」は、その記録として書く。

---

## 問い（Issue #233、ADR 0032 が残した named debt）

[ADR 0032](./0032-outbox-claim-lease.md) の「これが覆るとしたら」節（本文末尾）:

> `fail()` の自動リトライ・`attempts` の活用・`complete`/`fail` の CAS 化は、本 PR の
> 範囲外として名前だけ残した（PR 本文「範囲外」参照）。これらが実装されるとき、
> リースとの相互作用（例: リース切れの再 claim と自動リトライのバックオフが
> 二重に効かないか）を再検討する必要がある。

Issue #233 はこの named debt のうち「`complete`/`fail` の CAS 化」を対象にする
（`attempts` の活用・自動リトライは引き続き範囲外——下記「採らなかった案」）。

---

## 現物を自分で読んだ（出所: 私が実行した）

`packages/core/src/interfaces/outbox-store.ts` の `OutboxStore` interface（本 PR 以前）:

```ts
export interface OutboxStore {
  claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
  complete(ctx: Ctx, jobId: string): Promise<void>;
  fail(ctx: Ctx, jobId: string, error: string): Promise<void>;
}
```

`packages/postgres/src/outbox-store.ts` の `PostgresOutboxStore.complete`（本 PR 以前）:

```ts
async complete(ctx: Ctx, jobId: string): Promise<void> {
  if (!isUuidLike(jobId)) {
    return;
  }
  await this.db.execute(sql`
    UPDATE outbox
    SET completed_at = now()
    WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
  `);
}
```

`fail` も同型（`failed_at`/`last_error` を書く点だけが違う）。**`WHERE` に `claimed_by`/
`claimed_at`/`attempts` のどれも条件として現れない**——Issue #233 が引用した棚卸し
（#168 項目4-4）の主張どおりだった。`packages/testkit/src/__fixtures__/
in-memory-outbox-store.ts` の `InMemoryOutboxStore`、`packages/core/src/__tests__/
runtime-fakes.ts` の `FakeOutboxStore` も同型（既存行を id/tenantId だけで探して
無条件に書き換える）。

**リースの仕組み**（ADR 0032）: `claimBatch` は `claimed_at IS NULL OR claimed_at <=
now - leaseMs` の行を claim し、`attempts` を1増やす。一度 `completed_at`/`failed_at` が
付いた行は `claimBatch` の `WHERE`（`completed_at IS NULL AND failed_at IS NULL`）から
二度と対象にならない。**⟹ `attempts` は claim のたびに単調増加し、終端化された行では
その値が永久に固定される。**

**`MemoryStore.updateStatus` の CAS**（[ADR 0030](./0030-update-status-compare-and-swap.md)）
は `expectedStatus`（省略可・既定は無条件更新）という形で同種の問題を解いていた。
本 ADR は同じ形（`UPDATE ... WHERE <条件> RETURNING id` → 0行なら読み直して
「無い」か「不一致」かを切り分け、不一致なら型付き例外）を流用しつつ、
**CAS 対象の値を `status` ではなく `attempts` にし、かつ省略不可にする**
（理由は下記「決定」参照）。

---

## ⭐ 決める前に、実際に壊れることを示した(再現)

**出所: 私がこの作業環境で実行した。** 修正前のコード（`InMemoryOutboxStore`、CAS 追加前）
に対して、次の手順を実際に走らせた:

1. ワーカーA が `claimBatch` でジョブを claim する（`leaseMs = 1000`）。
2. リースが切れる時刻まで時計を進める。
3. ワーカーB が同じジョブを再 `claimBatch` し、`complete()` を呼ぶ。
4. ワーカーA が遅れて `fail()` を呼ぶ（自分がまだ処理中だと思っている——実際はとうに
   B に奪われ、B は既に complete している）。
5. ジョブの最終状態を見る。

**結果（修正前）**: `completedAt` と `failedAt` の**両方**が非 null になった——
`claimBatch` の契約が前提にしている「`completed_at IS NULL AND failed_at IS NULL`」が
両方満たされない、本来ありえないはずの矛盾した終端状態が実際に作れた。ログ:

```
finalJob: {
  id: 'job-2',
  tenantId: 't1',
  kind: 'extract',
  ... completedAt: <Date>, failedAt: <Date>, ...
}
```

**⟹ Issue #233 の前提（「CAS でない」は構造の指摘に留まらず、実害を生む）は正しかった。**
この再現手順は、CAS 実装後の回帰テストとして
`packages/testkit/src/outbox-store-conformance.ts`・`packages/core/src/__tests__/
runtime.test.ts` の双方に、修正後の API（`expectedAttempts` を使い、上書きの代わりに
`OutboxLeaseConflictError` が投げられ、Bの結果が保たれることを確認する形)へ書き換えて
そのまま残した（「測ったこと」参照）。

---

## 誰が壊れうるか

### 本リポジトリ内で実際に数えた件数（私が実行した）

`git grep` で `OutboxStore` の `complete`/`fail` を呼ぶ箇所を、production（`__tests__`
以外の `src`）とテストに分けて数えた。

```
grep -rn "outboxStore\.complete(\|outboxStore\.fail(\|\.complete(ctx\|\.fail(ctx" \
  --include=*.ts packages examples | grep -v node_modules
```

**production コード（`packages/*/src`、`__tests__` を除く）**:

- `packages/core/src/runtime.ts` の4箇所（`handleExtractableObservation` の同期抽出パス
  1箇所、`tick` のループ内3箇所——`complete` 1・`fail` 2）。**これが唯一の production
  呼び出し元であり、本 PR で更新済み。**
- `examples/chat/src/embed-drain.ts` は `runtime.tick()` を呼ぶだけで、`OutboxStore.
  complete`/`fail` を直接呼ばない（`grep` で確認、ヒット0件）。

**テストコード**:

- `packages/testkit/src/outbox-store-conformance.ts` の4箇所（既存の complete/fail の
  適合テスト。本 PR で `expectedAttempts` を渡す形に更新済み）。
- 他に `.complete(`/`.fail(` を含む行は `packages/anthropic`・`packages/openai` の
  `LLMProvider.complete`（**別の interface、同名の別メソッド**——`OutboxStore` とは無関係）
  のみで、`OutboxStore` の呼び出しではない。

**⟹ 本リポジトリ内で `OutboxStore.complete`/`fail` を直接呼ぶ箇所は
`packages/core/src/runtime.ts`（production）と `packages/testkit/src/
outbox-store-conformance.ts`（テスト）だけであり、両方とも本 PR で更新済みである。**

### 外部の利用実態（別段落・未検証であることを明記する）

**上の件数は、あくまで本リポジトリの中で私が数えたものである。** `@mnemora/core`
（`OutboxStore` interface の定義元）・`@mnemora/postgres`（`PostgresOutboxStore`）は
npm に公開済みであり（`docs/autonomy.md` 「いまの状態」）、**この2パッケージを消費する
外部のコードが、独自のワーカー実装から `OutboxStore.complete`/`fail` を直接呼んでいる
可能性を、本リポジトリから確認する手段は無い。** 「見つからなかった」は「居ない」の
証拠ではない——この点は測定ではなく、確認できないことの明記である。

---

## 決定1: `attempts` をフェンシングトークンにした CAS を、`expectedAttempts` を
## **必須引数**として実装する

```ts
export interface OutboxStore {
  claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
  complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void>;
  fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void>;
}
```

呼び出し側は、直前に自分が受け取った `OutboxJobRecord.attempts`（`claimBatch` から、
または `createObservationWithOutbox` 等の生成経路から）をそのまま渡す。adapter は
`UPDATE ... WHERE tenant_id = ... AND id = ... AND attempts = ${expectedAttempts}` を実行し、
0行なら `SELECT attempts FROM outbox WHERE ...` で読み直して「行が無い」（べき等な
no-op、例外にしない）か「行はあるが `attempts` が不一致」（`OutboxLeaseConflictError`
を投げる）かを切り分ける。`MemoryStore.updateStatus`（ADR 0030）と同型。

### なぜ `attempts` か（`claimed_at`/新規の UUID トークンではなく）

- **`attempts` は claim のたびに厳密に単調増加する**（`claimBatch` の
  `SET ... attempts = attempts + 1`）。
- **一度終端化された行は `claimBatch` の対象から永久に外れる**
  （`completed_at IS NULL AND failed_at IS NULL` の `WHERE`）ため、終端化後の
  `attempts` は固定される。
- **この2つを合わせると、「自分が claim した瞬間の `attempts`」は、他の誰にも奪われて
  いない自分のリースを指すフェンシングトークンとして機能する。** 新しい列も新しい型も
  要らず、既存の列を読み替えるだけで済む——`claimed_at`（タイムスタンプ、クロックの
  分解能次第で理論上の衝突がゼロではない）より、整数の厳密な単調増加のほうが
  比較に適している。

### なぜ省略不可にするか（ADR 0030 の `expectedStatus` とは対照的に）

ADR 0030 は `expectedStatus` を**省略可能**にし、「省略時は今日と一字も変えない」を
選んだ——当時の唯一の呼び出し元（`reextract`）以外に無条件更新を必要とする既存の
呼び出し元（`archived`/`forgotten` への遷移等）が複数あったため。

**`OutboxStore.complete`/`fail` にはそのような既存の無条件呼び出し元が無い**
（上の「誰が壊れうるか」で確認済み——production は `runtime.ts` の1箇所のみ、
すべて `job`/`extractJob` オブジェクトを直前に手にしている）。ADR 0032 が `leaseMs` を
省略不可にした理由——「寛容な既定は『今日の壊れ方』を裏から実装し直すだけになる」
（`claimed_at IS NULL` 単独案を却下した理由と同じ形）——がここでも同じ形で効く。
`expectedAttempts?: number` を省略可能にし「省略時は無条件」を許すと、**呼び出し側が
うっかり省略するだけで Issue #233 が指摘したバグがそのまま復活する**——CAS を実装した
意味が無くなる。だから省略できない形にした。

### 対象の行が存在しない場合の扱い（既存契約の維持）

interface の既存契約「`complete`/`fail` は対象が既に完了/失敗していても例外を投げない
（べき等な終端更新）」を割らない。CAS 判定は「行が存在するが `attempts` が不一致」の
場合にのみ発火する。「その id の行がそもそも存在しない」場合は `expectedAttempts` の
値に関わらず何もせず正常終了する——`PostgresOutboxStore` が既に持っていた
`isUuidLike` チェック（不正な形式の id を静かに無視する）とも整合する。

### `attempts` が一致し、かつ既に終端化されている場合の扱い

CAS の判定は `attempts` の一致だけを見て、`completed_at`/`failed_at` が既に付いている
かどうかは見ない。**同じ worker が同じ claim に対して `complete`/`fail` を重ねて呼ぶ**
（呼び出し側のリトライ等)は `attempts` が変わっていないため引き続き成功する
（idempotent、既存契約と同じ）。この状態は `claimBatch` の `WHERE` が
`completed_at IS NULL AND failed_at IS NULL` を要求する以上、**別のワーカーが割り込む
余地が無いまま終端化されている行**に限られる——「別ワーカーの割り込み」を防ぐという
本 ADR の主題を割らない。

## 決定2: 競合したときは型付き例外 `OutboxLeaseConflictError` を投げる（結果値ではない）

```ts
export class OutboxLeaseConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly expectedAttempts: number,
    readonly observedAttempts: number | null,
  ) { ... }
}
```

`MemoryStatusConflictError`（ADR 0030）・`ContestedWithoutCompanionError`（ADR 0140）と
同じ形——`instanceof` で判別できる専用の例外。**結果値（例: `{ ok: false, reason:
"conflict" }`）にしなかった理由**は ADR 0030 の「採らなかった案」と同じ——結果値にすると
呼び出し側が握りつぶして無視できてしまう。例外にすると、呼び出し側は明示的に catch
しない限り失敗を無視できない。`observedAttempts` は ADR 0030 の `observedStatus` と
同じ限界を持つ（弾かれた後に読み直した値であり、弾かれた瞬間の値そのものの保証では
ない——doc コメント参照)。

## 決定3: `runtime.tick`/`observe` の呼び出し元は、対応する `job`/`extractJob` オブジェクト
## の `attempts` をそのまま渡す。`OutboxLeaseConflictError` を tick() 内では特別扱いしない

`packages/core/src/runtime.ts` の4箇所すべてで、直前に受け取った `OutboxJobRecord` の
`attempts` を渡す(`handleExtractableObservation` の同期抽出パスは `extractJob.attempts`
——`createObservationWithOutbox` が返した生成直後の値、通常は`0`。`tick` のループは
`job.attempts`——`claimBatch` が返した値)。

**`tick()` は `OutboxLeaseConflictError` を catch しない。** ジョブ処理中に自分のリースが
奪われるという事態が実際に起きた場合、その例外は `tick()` の呼び出し元まで伝播し、
その回の `tick()` は残りの claim 済みジョブを処理せずに終わる（それらの行は、いずれ
リースが切れれば別のワーカーに再 claim される——at-least-once の枠内)。**これは意図的な
選択であり、黙って握りつぶす代替案より安全側に倒した**——「自分のリースはもう有効では
ない」という事実を、`tick()` が knowingly 飲み込んで「何も無かった顔」で処理を続ける
ほうが、この issue が塞ごうとしている「気づかれない上書き」の族に近い。**ただし、
これは1回の `tick()` 呼び出しが複数ジョブを claim している場合、1件のリース競合が
残り全部の処理を止めてしまうという意味でもある**——この振る舞いが運用上望ましいかは
別途判断が要る余地として残す（下記「これが覆るとしたら」)。

---

## 開いている穴（塞げなかった・塞がなかった入口を明記する）

1. **`fail()` の自動リトライ・`attempts` を使ったバックオフは範囲外のまま。** ADR 0032の
   「これが覆るとしたら」が名指ししていた3項目のうち、本 ADR は「CAS 化」だけを実装する。
   `attempts` の値そのものを使ったリトライ判断（例: 3回失敗したら諦める）は別の設計判断
   であり、1 PR = 1 ADR の原則を超える。
2. **サードパーティの `OutboxStore` 実装には、型システム上の強制力はあるが振る舞いの
   強制力は無い。** `expectedAttempts` を必須にしたことで**型としては**呼び出し側に
   渡すことを強制するが、独自に `OutboxStore` を実装する第三者が中身で無視して無条件
   更新することは（TypeScript の型では）止められない。ADR 0140 が挙げた同じ限界。
3. **本物の並行**（複数プロセスが実際に同時にネットワーク越しで CAS な `UPDATE` を撃つ
   ときに「ちょうど1本だけ成功する」こと）は、この作業環境では検証していない
   （下記「確かめていないこと」）。CAS 自体は Postgres の行レベルロック・MVCC が提供する
   保証にそのまま乗るので理論上は問題ないはずだが、実測はできていない。
4. **`tick()` がリース競合を特別扱いしない**（決定3）ことで、1件の競合が同じ `tick()`
   呼び出し内の残りのジョブ処理を止める。運用上これが問題になるなら、別 ADR で
   `TickResult` に競合の件数を出す・競合したジョブだけスキップして処理を続ける、
   といった設計が要る。

---

## 採らなかった案

### `expectedAttempts` を省略可能にし、省略時は無条件更新（ADR 0030 の `expectedStatus` と同じ形）

決定1参照。既存の無条件呼び出し元がここには存在せず(唯一の production 呼び出し元
`runtime.ts` は常に `job`/`extractJob` を手にしている)、省略可能にすると
「うっかり省略」で Issue #233 のバグがそのまま復活する。ADR 0032 の `leaseMs` と
同じ理由で却下。

### `claimed_at`（タイムスタンプ）をフェンシングトークンにする

却下。整数の `attempts` のほうが比較が厳密（タイムスタンプはクロックの分解能・NTP
補正等の影響を理論上受けうる)。加えて `attempts` は既存の列であり、意味論も
「claim の回数」として既に確立している(ADR 0032)——新しい概念を持ち込まずに済む。

### 新しい列（`leaseToken: uuid`、claim のたびに新規発行）を足す

却下。`attempts` が既に同じ役割（claim ごとに一意に変わる値）を果たせるため、
新しい列・新しいマイグレーションを足す理由が無い。複雑さに見合わない。

### 競合を結果値（`{ ok: boolean }` 等）で返す

決定2参照。ADR 0030 の「採らなかった案」と同じ理由——結果値は握りつぶせる。

### `fail()`/`complete()` の呼び出しごとに、`tick()` がリース競合を catch して
### 「スキップ」として扱い、残りのジョブ処理を続ける

決定3の代替案。**採らなかった。** 実装の複雑さ（`TickResult` に新しいフィールドが
要る・「競合してスキップした」と「対応していない kind」「処理して失敗した」の3つを
呼び出し側がどう区別するかという ADR 0082 と同種の設計判断が要る）が、本 PR の主題
（CAS を可能にすること）を超える。将来、運用上これが必要になったら別 ADR で扱う
（「これが覆るとしたら」参照）。

---

## これが覆るとしたら

- **`tick()` が1件のリース競合で残りのジョブ処理を止めることが、運用上問題になったとき**
  ——競合したジョブだけスキップして処理を続ける設計へ変える別 ADR が要る。
- **`attempts` を使った自動リトライ・バックオフが実装されるとき**——CAS との相互作用
  （リトライ判断に使う `attempts` の値と、CAS のフェンシングトークンとしての `attempts`
  が同じ列を指すことによる副作用が無いか）を再検討する必要がある。
- **本物の並行環境での実測**（CI の postgres ジョブ、または将来の負荷試験）で、
  「ちょうど1本だけ成功する」という前提が崩れることが分かったら、CAS の実装
  （`WHERE attempts = ...`）自体を見直す必要がある。
- **サードパーティの `OutboxStore` 実装者から、この破壊的変更で壊れたという報告が
  実際に来たとき**——移行ガイドの追記や、次のマイナー版での注記が要るかもしれない。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**無関係。** 本 ADR は outbox の書き込み側の整合性を扱うものであり、recall が
毎回渡す量には影響しない。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** 正しく動いている単一ワーカー・リースが切れない運用には一切影響しない
（`expectedAttempts` は必須なので「無効にする」選択肢自体が無い——これは意図的:
「無効にできる」形にすると Issue #233 のバグが復活する経路を残すことになる、決定1参照)。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**影響なし。** 本 ADR は outbox ジョブの終端状態の整合性を扱うだけで、recall の
出力・trace には関与しない。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。** `attempts`/`completed_at`/`failed_at` のみを見る。

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** 列の比較だけで完結する。

---

## 測ったこと

**出所: 私がこの作業環境で実行した。**

- `pnpm --filter @mnemora/core run typecheck` / `pnpm --filter @mnemora/testkit run
  typecheck` / `pnpm --filter @mnemora/postgres run typecheck` — 個別に緑を確認した後、
  ルートの `pnpm run typecheck`（全7 workspace projects: core/testkit/openai/postgres/
  anthropic/local-embedding/examples-chat）も緑。
- `pnpm run lint`（eslint、リポジトリ全体） — 緑。
- `pnpm run format:check`（prettier、リポジトリ全体） — 緑。
- `rm -rf packages/*/dist && pnpm run build` — 緑。
- `pnpm run pack:check` — 緑（6パッケージとも publish 梱包の検査を通過）。
- `pnpm run test`（ルート） — root 943 / `@mnemora/core` 627（+4）/ `@mnemora/testkit`
  260（+4）/ `@mnemora/openai` 43 passed + 11 skipped / `@mnemora/anthropic` 49 passed +
  2 skipped / `@mnemora/local-embedding` 83 passed + 15 skipped、すべて緑。
  **`packages/postgres` と `examples/chat` の DB テストは実行していない**
  （`DATABASE_URL` 未設定。「DB テストは実行していません」と明示的に告知されることを
  確認した。ADR 0015 の通り、これは「DB 側を見ていない」であって「全部通った」ではない）。

### ⭐ 再現（バグが実害であることの実験）

上の「決める前に、実際に壊れることを示した」参照。修正前の `InMemoryOutboxStore` に
対して、ワーカーA claim → リース失効 → ワーカーB 再claim・complete → ワーカーA 遅延
fail、という手順を実際に走らせ、`completedAt`/`failedAt` の両方が非 null になる矛盾
した終端状態を確認した。

### 変異試験（`packages/core`/`packages/testkit` は DB を要さないため、実際に実行した）

**手順**: 変異の前に対象ファイルを `/tmp/mnemora-backup-233/` へ退避コピーしてから、
その場でコードを直接書き換えて赤を確認し、退避コピーから `cp` で戻して緑を確認した
（`git checkout` は使っていない——`docs/autonomy.md` §4 が指摘する「未コミットの編集も
消える」穴を踏まないため）。

- **M1**（`packages/testkit` の `InMemoryOutboxStore`: CAS 判定を `if (false && ...)`
  に変異）: `packages/testkit` で260本中**3本が固有に赤くなった**（「attempts が
  一致しないと `OutboxLeaseConflictError` を投げる」complete/fail の2本、および
  ⭐ 再現テスト1本）。残り257本（CAS の成功パスを検査する歯を含む）は無傷のまま。
  `cp` で復元後、260本すべて緑に戻ることを確認した。
- **M2**（`packages/core` の `FakeOutboxStore`: 同じ変異）: `packages/core` の
  `runtime.test.ts` で66本中**3本が固有に赤くなった**（M1 と対応する3本——
  `FakeOutboxStore` は `packages/testkit` の適合スイートの対象外であるため、
  この歯が無いと ADR 0053 が残した「Mu5a 変異が生存」と同じ穴が `FakeOutboxStore` に
  も開くところだった)。残り63本は無傷。復元後、66本すべて緑に戻ることを確認した。
- **M3**（`packages/core/src/runtime.ts`: `tick`/`handleExtractableObservation` の
  `complete(ctx, jobId, job.attempts)` 呼び出しの第三引数を、意図的に間違った定数
  `9999` へ変異——「wiring 自体が間違っていたら検出できるか」を検査): `packages/core`
  で**44ファイル中3ファイル・627本中52本が赤くなった**（`runtime.test.ts` の
  tick/observe を経由するテストの大半——CAS が実際に効いている以上、
  誤った `expectedAttempts` を渡すだけで大半の既存フローが `OutboxLeaseConflictError`
  で落ちることが分かった。想定通り: この wiring は「間違えたら静かに通る」形では
  ない)。復元後、627本すべて緑に戻ることを確認した。

いずれの変異も、`git diff --stat` が空でないこと（変異が実際に入ったこと）・
`cp` での復元後に `git status --short`（追跡対象ファイルの差分）が変異前の状態に
戻っていること・該当パッケージのテストスイートが全数元通りの緑になることを確認した。

### `packages/postgres`（CAS の実装自体）

**この環境では実行できない**（下記「確かめていないこと」）。ただし、本 PR の
`packages/testkit/src/outbox-store-conformance.ts` に足した新しい CAS 系の歯は
**共有適合スイート**であり、`packages/postgres/src/__tests__/conformance.postgres.test.ts`
が既に `describeOutboxStoreConformance({ name: "postgres", ... })` として
`PostgresOutboxStore` に対しても呼んでいる——ADR 0032/0140 のように専用の
DB 不要スタブテストを別途新設する必要は無く、**CI の postgres ジョブが走れば
自動的に本 PR の新しいテストも `PostgresOutboxStore` に対して実行される。**

---

## 射程外（担い手の作業指示により、この PR では触っていない）

- **`docs/architecture.md` §5.11**（`OutboxStore` の interface 抜粋）は、本 PR の
  `complete`/`fail` のシグネチャ変更を反映していない——本 PR の作業指示が変更を
  `packages/core`/`packages/postgres`/`packages/testkit` と新しい ADR 1本に限定しており、
  `docs/architecture.md` はその範囲外である。ADR 0032 のときはこの doc も同じ PR 内で
  更新されていた（該当箇所に「2026-09 追記」として残っている）が、本 PR はそれを踏襲
  していない。**マージする側が、別途この doc の該当箇所（§5.11 の `interface` コード
  ブロックと契約の箇条書き）を更新する必要がある。**

## 確かめていないこと

- **`packages/postgres` の DB を伴うテスト全体**（`PostgresOutboxStore` に対する新しい
  CAS の歯を含む）。この作業環境には `DATABASE_URL` も docker も無い
  （`which docker podman psql postgres initdb` は全部何も返さない、実測）。
  Issue #247 / alteroid #965 / alteroid #1015 の族として既知の構造的な穴。
- **本物の並行**（複数プロセスが実際に同時にネットワーク越しで CAS な `UPDATE` を撃つ
  ときに「ちょうど1本だけ成功する」こと）は、この作業環境では検証していない。
  CAS 自体は Postgres の行レベルロック・MVCC が提供する保証にそのまま乗るはずだが、
  実測はできていない——次の CI 実行、または将来の負荷試験が唯一の実測経路である。
- **`packages/postgres/src/outbox-store.ts` の SQL 文言そのもの**（`RETURNING id`
  → 0行なら `SELECT attempts` で読み直す、という2段の往復)が本物の Postgres に対して
  型どおりに動くこと。手元では型検査（`tsc`）が通ることのみ確認した——SQL の実行結果
  としての正しさは CI の postgres ジョブで初めて確認される。
- **CI 全体の緑。** この PR を出した後、`node scripts/ci-green-check.mjs --pr <番号>`
  で確認する（下記、報告参照）。
- **外部実装者への実際の影響。** 提起した通り、本リポジトリからは確認できない。
- **`tick()` がリース競合を catch せず伝播させる設計（決定3）が、実運用のワーカー
  実装にとって適切かどうか。** `examples/chat` は現状このシナリオ（`tick()` の
  実行中にリースが切れて別ワーカーに奪われる)が起きない構え（ADR 0032 決定4——単一
  プロセス・単一ワーカーで `tick()` が同じ呼び出し内で claim/complete/fail を完結
  させる)なので、この作業では実運用相当の検証ができていない。
