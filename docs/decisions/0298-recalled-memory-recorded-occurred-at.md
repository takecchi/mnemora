# ADR 0298: `RecalledMemory` に `recordedAt`/`occurredAt` を任意欄として足す —— Issue #691 の子（Issue #702）、「後で訂正された」を読むための時点（非破壊）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 / ADR 0289 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `vitest` / `tsc` / `pnpm` / `psql` を走らせて確かめた。
- **【受】** — 報告・Issue コメントとして受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は、本作業の分岐点 `origin/main` = `9ddf828` の木で、2026-09-25 に行った
（本 ADR の作業中に `origin/main` は `b2640f0`（#700 のマージ）まで進んだが、#700 は
`examples/chat/src/answer-retention-mutation.ts` 等を足しただけで、本 ADR が触るファイル
（`packages/core/src/recall.ts`/`recall-runtime.ts` とそのテスト）と重ならないことを
`git diff --stat 9ddf828 b2640f0` で確認済み——リベースはしていない）。

---

## 文脈

### Issue #691・PR #698 が踏んだ退行

[Issue #691](https://github.com/takecchi/mnemora/issues/691) は、回答プロンプト
`buildMnemoraPrompt`（`examples/chat`）が `recall()` の返す `provenanceKind`/`speaker`/
`subjectId`/`companionOf` を一切読まず digest だけを並べていることを問題視し、
それらを回答プロンプトへ反映することを求めた。実装（PR #698、`feat/691-answer-prompt-provenance`）
はこれに沿って由来・話者・主題・矛盾候補のタグを各記憶行へ足した。

【受】マネージャーの実測報告（本 Issue #702 の依頼文——マネージャーが answer ベンチの
dev ケースで実際に測った結果）: この変更により、answer ベンチの dev ケース
`schedule-change-meeting-day`（`examples/chat/src/answer-case-set.dev.ts:36`）が退行した。

このケースの記憶集合は2件——「来週の定例会議は金曜日にお願いします。」（第0ターン）と
「すみません、やはり定例会議は水曜日に移してください。金曜日は都合が悪くなりました。」
（第6ターン）——で、どちらも `provenance.kind === "stated"`・話者 `user`・`subjectId` 無し
であり、`recall()` の構造上これらは対向関係として捕捉されない（矛盾の同伴取得
`companionOf` が付かない——文面上は後者が前者を訂正しているが、`recall()` はこれを
検出する仕組みを持たない）。

同じ記憶集合に対して**描画だけ**を入れ替えた対照実験（gpt-4o-mini、各5〜10回、マネージャー実測）:

| 描画 | 正答率 |
|---|---|
| 旧描画（digest だけ） | 10/10 |
| 現行（由来+話者+主題+矛盾タグ、PR #698） | 1/10 |
| 由来タグのみ | 0/10 |
| 話者タグのみ | 1/10 |
| 主題タグのみ | 6/10 |

**読み**: 付帯情報（由来・話者・主題タグ）を各行に付けると、行の並びだけで読めていた
「これは後で訂正された」が読めなくなる。直すには**時点**（いつの発言か）が要るが、
`RecalledMemory`（`packages/core/src/recall.ts`）にはその欄が無かった。

### この ADR の射程 —— core に時点の欄を足すところまで

**回答プロンプト（`buildMnemoraPrompt`）を直すのは、この ADR・この PR の範囲外である。**
[Issue #702](https://github.com/takecchi/mnemora/issues/702)（本 ADR が実装する Issue、
#691 の子）は「core に時点の欄が無ければ、回答プロンプト側で直しようが無い」という
前提を埋めるためのものであり、**core に欄を足すところまでがこの ADR の仕事**。
描画側の配線は別 PR（#698 の続き、もしくは #691 の続き）に委ねる。

### `Memory` が既に持つ2つの時計（`memory.ts:95` 以降）

`packages/core/src/memory.ts` の `Memory` interface は、この ADR より前から次の2欄を持つ:

- **`recordedAt: Date`（必須）** —— この記憶を**取り込んだ**壁時計の時刻。
- **`occurredAt?: Date | null`（任意）** —— その出来事・事実が**いつのものか**
  （1点、鮮度スコアに使う。`memory.ts:104` のdocコメントが `validFrom`/`validUntil`
  との違いを明記している）。

`recall-runtime.ts` は既にこの2つから「実効時刻」（`occurredAt ?? recordedAt`、ADR 0039、
`recall-runtime.ts:155-156`・`:779`・`:1270` の3箇所）を計算し、鮮度スコアと候補の
既定ソート順に使っている——**この区別・優先順位付けは、この ADR が発明したものではなく、
`Memory`/`recall-runtime.ts` に既に在ったものを `RecalledMemory` へ引き継ぐだけである。**

---

## 決定

### 1. `RecalledMemory` に `recordedAt?: Date` と `occurredAt?: Date | null` を**任意欄**として足す

```ts
export interface RecalledMemory {
  memoryId: MemoryId;
  digest: string;
  retrievedVia: "ann" | "lexical" | "mandatory_companion" | "association";
  companionOf?: MemoryId;
  associationOf?: MemoryId;
  provenanceKind: ProvenanceKind;
  score: ScoreBreakdown;
  speaker?: string | null;
  subjectId?: string | null;
  recordedAt?: Date;     // 新設
  occurredAt?: Date | null; // 新設
}
```

`RecalledMemorySchema`（zod）にも同じ形で `recordedAt: z.date().optional()` /
`occurredAt: z.date().nullable().optional()` を足す。**既存の欄の型・名前・必須性は
1バイトも変えていない**（`git diff` で確認——追加行のみ）。

**`recordedAt` は `nullable()` を付けない**——`Memory.recordedAt` 自体が必須（`Date`。
`null` になりようが無い）ためであり、`occurredAt` を `nullable()` にする（`Memory.occurredAt`
自体が `Date | null` の任意欄）のと非対称なのは意図的である。

### 2. `recordedAt` の意味と、値の決め方

- **その Memory 自身の `Memory.recordedAt` をそのまま引き継ぐ。**`Memory.recordedAt` は
  必須欄（`Date`）なので、この値が「無い」ことはあり得ない——runtime が書く限り常に
  実際の `Date` を持つ。
- **観測（会話のターン）を取り込んだ順序を表す。**Issue #691 の背景にある
  「後で訂正された」を読むための、いちばん素朴な手がかりはこの欄である
  （下の「answer ベンチでの実測」参照——`occurredAt` は現状すべて `null` なので、
  今日この repo で唯一使える時点情報は事実上これだけである）。

### 3. `occurredAt` の意味と、値の決め方

- **その Memory 自身の `Memory.occurredAt` をそのまま引き継ぐ。**`Memory.occurredAt` が
  `undefined` のときも `null` に揃える（`undefined` を呼び出し側へ渡さない——
  「述べられていない」を正直に `null` として伝える）。
- **この欄が `null` なのは「出来事の時点が分からない・述べられていない」ことを表す。**
  `Memory.occurredAt` 自体の意味（`memory.ts:95` 以降のdocコメント）をそのまま引き継ぐ。

### 4. runtime は常に値か `null` を書く。`undefined` にもキー省略にもしない

`packages/core/src/recall-runtime.ts` の `finalMemories` を組む1箇所（ADR 0289 が
決定5で数えた、`RecalledMemory` を組み立てる唯一の本番の箇所）で:

```ts
recordedAt: member.memory.recordedAt,
occurredAt: member.memory.occurredAt ?? null,
```

**「無い（`null`）」と「頼まなかった・書き忘れた（`undefined`）」を実行時に混ぜない**
——ADR 0289・ADR 0257・ADR 0035 決定3 と同じ規律をこの2欄にも適用した。

### 5. 組み立て箇所を数えたこと（ADR 0289 決定5・ADR 0035 §1 と同じ形で数えた）

ADR 0289 が実測した「`RecalledMemory` を組み立てている本番の箇所は1箇所
（`recall-runtime.ts` の `finalMemories`）だけ」という結論は、本 ADR の作業でも
変わっていない（`speaker`/`subjectId` を足したのと同じ1箇所に、隣接する2行として
足しただけであり、新しい組み立て経路は増えていない）。ANN・語彙・同伴取得・連想の
すべての経路が同じ `ScoredCandidate.memory: Memory` を経由することも ADR 0289 決定5の
とおりであり、`Memory.recordedAt`/`occurredAt` は必ず在る（DB への追加往復は無い）。

### 6. 永続化（`RecallRecordMemory`／`recalls.returned_memories`）には足さない

ADR 0289 決定6と同じ理屈——`RecordRecallMemory` は「後から再現できないもの」だけを
持つ設計（`recall.ts:1698` 前後のdoc）であり、`recordedAt`/`occurredAt` はどちらも
`MemoryStore.get(memoryId)` から再現できる（`Memory.recordedAt`/`Memory.occurredAt`
そのもの）。⟹ **`packages/postgres` のマイグレーションは不要。**`runtime.ts` の
`returnedMemories` 組み立ては1バイトも変えていない。

### 7. 決めなかったこと —— 欠落値を推測で埋めない

**`occurredAt` が `null` のとき、`recordedAt` で埋めない。**「実効時刻」
（`occurredAt ?? recordedAt`、ADR 0039）という計算は `recall-runtime.ts` の**スコアリング**
（鮮度・既定ソート順）の内部でだけ使われている概念であり、`RecalledMemory` という
**公開の返り値**にこの計算結果を持たせることは、本 ADR ではしない。

**理由**: マネージャーの依頼文が明示的に禁じている
（「欠落値（occurredAt が null 等）を推測で埋めない」）のに加え、この計算を core 側で
確定させてしまうと、「訂正の順序を読みたいとき `occurredAt` が無ければ `recordedAt` へ
フォールバックする」という**呼び出し側の判断**を、core が代わりに下してしまうことになる
——ADR 0257 の「探したが無かった」と「探していない」の区別と同じ形で、「`occurredAt` が
無い」と「`occurredAt` の代わりに `recordedAt` を使ってよい」は**別の判断**であり、
前者（core の仕事）と後者（呼び出し側の仕事）を混ぜない。**`RecalledMemory` は両方の
生の値をそのまま渡すところまでで止め、どちらを・どう使うかは呼び出し側（次段の
描画配線 PR）に委ねる。**

---

## 採らなかった案

| 案 | 却下の理由 |
|---|---|
| **`recordedAt`/`occurredAt` の代わりに、単一の「実効時刻」欄（`effectiveAt`、`occurredAt ?? recordedAt` の計算結果）だけを足す** | 決定7のとおり、この計算は core 側の判断であり、呼び出し側の判断を core が代わりに下すことになる。生の2値を渡すほうが、呼び出し側が「`occurredAt` が無いことそのもの」を読める（例えば「出来事の時点は分からないが、この順で発言された」という描画をしたい場合、`effectiveAt` だけでは `occurredAt` が有ったか無かったかが失われる） |
| **`recordedAt` だけを足し、`occurredAt` は足さない** | `Memory` 自体が2つの時計を区別している以上、`RecalledMemory` だけがその区別を隠す理由が無い。将来 `occurredAt` が実際に埋まるようになったとき（Issue #689 の抽出文脈の作業などが進んだとき）に、既に `RecalledMemory` の型がその値を運べる形になっている方が良い |
| **`occurredAt` だけを足し、`recordedAt` は足さない** | 下の「answer ベンチでの実測」のとおり、今日の `examples/chat` では `occurredAt` は常に `null`——`occurredAt` だけでは「後で訂正された」を読む手がかりが1つも無くなる。Issue #691 の背景にある退行を直す実際の手がかりは、今日のところ `recordedAt` のほうである |
| **必須欄として足す** | `docs/migration-v1.md` の数え方（下記「破壊的変更の判定」）では破壊的変更になる。ADR 0289 が同じ理由で必須化を撤回した先例をそのまま踏む |
| **`occurredAt` が無いとき `recordedAt` で埋める（実効時刻を `occurredAt` の欄自体に書く）** | 決定7の理由。マネージャーの依頼文が明示的に禁じている「欠落値を推測で埋める」実装そのもの——変異試験 m6 で実際にこの実装を作って赤くなることを確認した（下記） |

---

## 引き受けた負債

1. **型の上では `undefined` がまだありうる**（ADR 0289 と同じ負債）。`docs/migration-v1.md`
   の数え方の下で非破壊を選んだ以上、必須化による完全な型強制はできない。唯一の
   組み立て箇所（`recall-runtime.ts`）の規律は歯で固定したが、独自の `RecallResult`
   実装がこの欄を省略する可能性そのものは型では塞がれていない。
2. **`occurredAt` は、今日の `examples/chat` では実質的に使えない**（下記「answer ベンチ
   での実測」のとおり常に `null`）。この ADR は core 側に欄を用意しただけであり、
   `occurredAt` が実際に埋まるようにする作業（Issue #689 の射程）は行っていない。
3. **回答プロンプトへの配線は、この ADR・この PR の射程外。**Issue #691 の退行が
   実際に直るかどうかは、次段（描画配線 PR）の実装と評価に懸かっている——本 ADR は
   「直すための材料を core 側に用意した」ところまでである。
4. **本物の Postgres に対する DB テストは、`packages/postgres` 自体には実行していない**
   （`packages/postgres` を1バイトも変更していないため、決定6の設計上の結論——ADR 0289
   決定4と同じ確認手順——から導いた）。ただし本 ADR は answer ベンチの実測（下記）のために
   ローカルの Postgres 17 + pgvector（`mnemora_t702`、使用後に削除済み）に対して
   `@mnemora/postgres` の実装（`PostgresMemoryStore` 等）を実際に動かし、`recordedAt`/
   `occurredAt` が `RecalledMemory` まで実際に伝わることを確認している——「型だけの
   確認」ではない。

---

## 射程 —— 確かめていないこと・閉じないもの

- **[Issue #691](https://github.com/takecchi/mnemora/issues/691) は閉じない。**
  回答プロンプトへの配線が残っている限り、Issue 全体としては未完了である。
- **`examples/chat`/`buildMnemoraPrompt` の出力にこの2欄を反映するかどうかは決めていない。**
  この PR の範囲に含めていない。
- **書き込み容量への影響を実測していない。**`RecalledMemory` は永続化されない
  （決定6）ため、HTTP payload 側のみに影響するが、実測（ADR 0035 §2.2 のような
  「1件あたり+N文字」測定）はしていない。プロンプトへ積む量（`usage.chars`）が
  動かないことだけは歯で固定した（下記「測ったこと」）。

---

## これが覆るとしたら

1. **Issue #689（抽出に会話文脈・話者・観測日時を渡す）が実装され、`occurredAt` が
   実際に埋まるようになったとき**——本 ADR が用意した `occurredAt` 欄が、初めて
   実用的な値を持つようになる。
2. **回答プロンプトへの配線（次段）が、`recordedAt`/`occurredAt` の**両方**を使う形にも
   **片方**だけを使う形にもなりうる**——その実装・評価の結果次第で、この ADR が
   両方を用意したことの当否が判断される。
3. **オーナーが「必須欄にすべきだった」「単一の実効時刻を core が計算すべきだった」と
   判断したとき**——本 ADR は無効になり、別の形（別 ADR）を検討することになる。

---

## 破壊的変更の判定（`docs/migration-v1.md` の数え方）

`docs/migration-v1.md` は「返り値の型に**必須**フィールドが増えた」形（項目7・9・10）
だけを破壊的変更に数え、**任意欄の追加を非破壊の代表例**としている（項目7「入力側は
省略可能フィールドとして追加されており、省略すれば0として扱われる（非破壊）」）。
`docs/migration-v1.md:886` は現在 v0.5.0 → v1.0.0 の破壊的変更を「**未リリース。
いまのところ1件も無い**」としている。

【実測】本 PR の差分:

```
$ git diff --stat origin/main -- packages/
 packages/core/src/__tests__/recall-association.test.ts | 43 ++
 packages/core/src/__tests__/recall-channels.test.ts     |  5 +
 packages/core/src/__tests__/recall-pipeline.test.ts     | 145 ++++
 packages/core/src/__tests__/recall.test.ts              | 48 ++
 packages/core/src/recall-runtime.ts                     |  6 +
 packages/core/src/recall.ts                             | 39 ++
 6 files changed, 286 insertions(+)

$ git diff --stat origin/main -- scripts/__snapshots__/public-api/
 scripts/__snapshots__/public-api/core.d.ts | 12 +++++++++---
 1 file changed, 9 insertions(+), 3 deletions(-)
```

`recall.ts`/`recall-runtime.ts` への変更はテストの追加とコメント以外はすべて**追加行のみ**
（既存行の削除・変更は無い）。公開 API スナップショットの差分も、`RecalledMemory`
interface・`RecalledMemorySchema`・`RecallResultSchema` 内の同スキーマへの**追加2行×3箇所**
であり、いずれも既存フィールドの型・必須性は変えていない。

⟹ **これは `docs/migration-v1.md` の数え方における非破壊変更である**（ADR 0282・ADR 0289
の先例と同じ「新しい任意プロパティの追加」——[ADR 0178](./0178-public-api-surface-gate.md)
が semver 的に安全と明記した形）。`docs/migration-v1.md` への追記・更新は不要と判断した
（項目18の追加を要する変更ではない）。

🔴 **公開 API スナップショットには、このPRの意図と無関係な2件のリオーダーが同じ差分に
含まれる**——`NewMemorySchema` の `recordedAt`/`occurredAt` の2行の出力位置と、
`NewObservationSchema` の `tenantId`/`occurredAt` の2行の出力順序である。これは
**ADR 0289 が既に文書化した現象と同型**——`NewMemorySchema`（`memory.ts:256`
`MemorySchema.omit({...})`）・`NewObservationSchema`（`observation.ts:59`
`ObservationSchema.omit({...})`）はどちらも `.omit()` チェーンの型であり、
`schema-type-equals-parity.test.ts` が `Equals`（型としての同一性）ではなく
`MutualAssignable`（弱い相互代入可能性）でしか固定していない——**プロパティの順序は
この型の構造的な同一性の一部として扱われていない。**`tsc` の宣言ファイル出力が、
同一コンパイル単位内の無関係な変更（本 PR は `recall.ts`/`recall-runtime.ts` だけを
変更した）に応じてこの種の交差型のプロパティ出力順を変えることがある、という
`.d.ts` 生成側の挙動だと考えられる——**field の集合・型・必須性は1つも変わっていない。**
⟹ ADR 0289 と同じ判断で、これを `RecalledMemory` への追加とは無関係の snapshot 生成の
ノイズと判断した。この判断が誤りだと分かった場合、追って訂正する。

---

## 測ったこと

### 【実測】赤（実装前）

```
$ pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall.test.ts src/__tests__/recall-pipeline.test.ts

 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — recordedAt/occurredAt（Issue #691 の子、Issue #702、ADR 0298） > recordedAt は Memory.recordedAt をそのまま名乗る（Memory 側は必須なので常に値）
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — recordedAt/occurredAt（Issue #691 の子、Issue #702、ADR 0298） > occurredAt が在れば、その値をそのまま名乗る
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — recordedAt/occurredAt（Issue #691 の子、Issue #702、ADR 0298） > occurredAt が無ければ null（キー自体は在る。newMemory の既定どおり occurredAt: null）
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — recordedAt/occurredAt（Issue #691 の子、Issue #702、ADR 0298） > Memory.occurredAt が undefined でも null に揃える（subjectId と同じ防御）
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — recordedAt/occurredAt（Issue #691 の子、Issue #702、ADR 0298） > recordedAt が異なる2件は、区別できる値を持つ（『後で訂正された』を読むための前提。Issue #691 背景）
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — recordedAt/occurredAt（Issue #691 の子、Issue #702、ADR 0298） > 同伴取得（mandatory_companion）でも recordedAt/occurredAt は対向の Memory 自身の値を名乗る

 Test Files  1 failed | 1 passed (2)
      Tests  6 failed | 176 passed (182)
```

（`recall.test.ts`——`RecalledMemorySchema` の schema テスト——は0本の赤で緑のまま
通っている。型・schema（`recall.ts`）は runtime 実装より先に足しており、schema 自体は
`recordedAt`/`occurredAt` を受理できていたため——赤いのは `recall-runtime.ts` の
組み立てにまだ書いていない `recall-pipeline.test.ts` の6本だけ。下記「進め方の実際」参照）。

### 【実測】進め方の実際 —— このADRでは型/schema定義を先に置き、runtime 実装を後回しにした

ADR 0289 は「型を先に置いて実装を後回しにする」ことを Issue #106（ADR 0084）の罠として
戒めているが、それは**「実装を伴わない値を union に永続的に置く」**（呼び出し側が
「使える」と誤読する）ことへの戒めであり、本 PR のように**同じコミット内で型→テスト→
runtime実装の順に数十分で埋める TDD の赤**とは別物である。実際の作業順序:

1. `recall.ts` に型・schema を追加（この時点で `schema-type-equals-parity.test.ts` は緑
   のまま——型と schema が同時に揃っているため）。
2. `recall-pipeline.test.ts`/`recall.test.ts`/`recall-association.test.ts` にテストを追加
   （**この時点で `recall-runtime.ts` はまだ変更していない**——ここが実質的な赤)。
3. `pnpm --filter @mnemora/core exec vitest run src/__tests__/recall.test.ts
   src/__tests__/recall-pipeline.test.ts` で赤を確認（上記ログ、6 failed）。
4. `recall-runtime.ts` の `finalMemories` に2行を追加。
5. 同じコマンドで緑を確認（下記）。

### 【実測】緑（実装後）

```
$ pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall.test.ts src/__tests__/recall-pipeline.test.ts \
  src/__tests__/recall-association.test.ts src/__tests__/recall-channels.test.ts \
  src/__tests__/schema-type-equals-parity.test.ts
 Test Files  5 passed (5)
      Tests  214 passed (214)

$ pnpm --filter @mnemora/core exec vitest run
 Test Files  68 passed (68)
      Tests  1034 passed (1034)
```

（既存の完全一致スナップショット歯 `recall-channels.test.ts` の「②-a 全体の一致」が、
実装直後に赤くなった——ADR 0289 と同じ形。期待値リテラルへ `recordedAt:
NOW.toISOString(), occurredAt: null` を足して緑に戻した。）

### 【実測】変異試験（`cp` で退避・復元。`git checkout` は使っていない。復元後に
`diff` で各ファイルが変異前と完全に一致すること、同じテストが緑へ戻ることまで確認した）

| # | 変異 | 検出した歯 |
|---|---|---|
| (m1) | `recordedAt`/`occurredAt` の両方を組み立て箇所から丸ごと省く | vitest 赤 8本（`recall-pipeline.test.ts`/`recall-association.test.ts`/`recall-channels.test.ts` 計3ファイル） |
| (m2) | `occurredAt` だけ省く（`recordedAt` は残す） | vitest 赤 5本 |
| (m3) | `occurredAt` の `?? null` を外し、`Memory.occurredAt` が無いとき `undefined` をそのまま渡しうる形にする | vitest 赤 1本（`Memory.occurredAt が undefined でも null に揃える` の `not.toBeUndefined()`/`toBeNull()` assert。`occurredAt が無ければ null` のほうは `newMemory` の既定が `occurredAt: null`——`undefined` ではなく既に `null`——を渡すため、この変異では巻き込まれず緑のまま） |
| (m4) | interface と schema の両方を必須（`?` を外す）にする——「やりすぎ」 | vitest 赤 11本（後方互換の歯）／`tsc`（typecheck）赤（`recall-footprint.test.ts` の既存リテラルが `RecalledMemory` を満たさなくなる。`TS2739`） |
| (m5) | interface だけ必須にし、schema は任意のまま残す（型と schema の不一致） | `tsc`（typecheck）赤——`recall-footprint.test.ts` の `TS2739` に加えて、`schema-type-equals-parity.test.ts` 自体が `TS2344`（`Expect<Equals<...>>` が `false`）で2件、`RecalledMemorySchema`/`RecallResultSchema` の `satisfies z.ZodType<...>` 行で `TS1360` が2件。vitest 自体は esbuild ベースで型を見ないため通ってしまう（型不一致は `tsc` でのみ検出される） |
| (m6) | 🔴 **「やりすぎた実装」——`occurredAt` が無いとき `recordedAt` で埋める**（`occurredAt: member.memory.occurredAt ?? member.memory.recordedAt`） | vitest 赤 4本、3ファイル（`recall-pipeline.test.ts` の「occurredAt が無ければ null」「Memory.occurredAt が undefined でも null に揃える」の2本、`recall-association.test.ts` の連想枠の1本、`recall-channels.test.ts` の②-a 全体一致の1本。`recall.test.ts`（schema 自体の歯）は影響を受けず0本）。**推測で埋める実装は、この ADR が明示的に禁じた形であり、歯が正しく検出することを確認した** |

**緑のまま残った変異は無かった。**

### 【実測】answer ベンチでの、この2欄の実際の値（次段の描画配線のための下調べ）

`examples/chat/src/mnemora-path.ts` の `ingestConversation` を読むと:

```ts
await runtime.observe(ctx, {
  kind: "utterance",
  text: turn.text,
  speaker: turn.role,
  externalId: externalIdForTurn(turn.index),
});
```

**`occurredAt` を一度も渡していない。**`packages/core/src/extraction.ts:448`
（`occurredAt: params.observation.occurredAt ?? null`）・`runtime.ts:2775`
（`occurredAt: input.occurredAt ?? null`）を辿ると、`ingestConversation` が `occurredAt`
を渡さない限り `Memory.occurredAt` は常に `null` になる。**これを実際に確かめるため**、
ローカルの Postgres 17 + pgvector（`mnemora_t702`、確認後に削除済み）に対し、
`ingestConversation` と同じ形の `observe()` ループ（`schedule-change-meeting-day` と
同じ4発話、deterministic provider——実 API・カセットのどちらにも触れていない）を
実際に走らせた:

```
turn 0: wall time before observe() = 2026-09-24T20:02:19.609Z
turn 1: wall time before observe() = 2026-09-24T20:02:19.652Z
turn 2: wall time before observe() = 2026-09-24T20:02:19.667Z
turn 3: wall time before observe() = 2026-09-24T20:02:19.681Z
{"digest":"旅行の計画を立てています。","recordedAt":"2026-09-24T20:02:19.673Z","occurredAt":null}
{"digest":"最近読んだ本がとても面白かったです。","recordedAt":"2026-09-24T20:02:19.657Z","occurredAt":null}
{"digest":"来週の定例会議は金曜日にお願いします。","recordedAt":"2026-09-24T20:02:19.628Z","occurredAt":null}
{"digest":"すみません、やはり定例会議は水曜日に移してください。金曜日は都合が悪くなりました…","recordedAt":"2026-09-24T20:02:19.685Z","occurredAt":null}
```

**分かったこと**:

1. **`occurredAt` は今日の answer ベンチでは常に `null`。**Issue #689（抽出に会話文脈・
   話者・観測日時を渡す）が実装されない限り、この欄は使えない。
2. **`recordedAt` は、システム時計（`createRuntime` の既定 `clock`、`answer-bench.ts` は
   `clock` を渡していない）に基づき、ターンの投入順に単調増加するミリ秒精度の値を持つ。**
   上記の実測では隣接ターン間で約13〜32ミリ秒の差があった——`ingestConversation` の
   `for` ループが `observe()` を1件ずつ `await` しており、各 `observe()`（LLM 抽出・
   DB 書き込みを含む）の実処理時間の分だけ実際の壁時計が進むためだと考えられる。
3. **⚠ この差は「実処理時間」に依存する測定であり、性能の物差しではない。**
   `deterministic` provider の実測であることに加え（AGENTS.md「`deterministic` で
   測った想起の質は性能について何も言っていない」と同じ注意）、`recorded`/`openai`
   モードでは LLM 呼び出しの実際のレイテンシによって差の大きさが変わりうる
   （ただし**単調増加すること自体**は `for` ループの逐次 `await` という構造から
   保証される——`Promise.all` 等で並列化していない限り、ある呼び出し側の実装が
   これを崩すことは無い）。
4. **⟹ 次段（描画配線）が「後で訂正された」を読ませたいなら、今日使える唯一の
   時点情報は `recordedAt` である。**`occurredAt` を使う描画は、Issue #689 が
   実装されるまで意味を持たない（常に `null` を描画することになる）。

### 【実測】公開 API スナップショット・6つの門

```
$ pnpm run build          → exit=0（7 workspace すべて Done）
$ pnpm api:check          → 差分1件（@mnemora/core のみ。上記「破壊的変更の判定」参照）
$ pnpm run api:write      → snapshot 更新（core.d.ts のみ、+9/-3 行）
$ pnpm api:check          → 緑（api:write 後）
$ pnpm run typecheck      → exit=0（7 workspace すべて Done）
$ pnpm run lint           → exit=0
$ pnpm run format:check   → exit=0
$ pnpm run test           → exit=0
   （ルート門: 3/3 段が実行、DB テストは「実行していません」と告知——DATABASE_URL 未設定。ADR 0015）
   @mnemora/core: Test Files 68 passed (68) / Tests 1034 passed (1034)
```

---

## 参照

- [Issue #691](https://github.com/takecchi/mnemora/issues/691) — 回答プロンプトで
  記憶の由来・話者・主題・矛盾関係を保持する。本 ADR が埋める前提を必要とした親 Issue
- [Issue #702](https://github.com/takecchi/mnemora/issues/702) — 本 ADR が実装する
  子 Issue（この担い手が起票）
- [ADR 0289](./0289-recalled-memory-speaker-subject.md) — `speaker`/`subjectId` を
  任意欄として非破壊に足した直接の先例。本 ADR の決定1〜6・引き受けた負債・変異試験の
  形はこれを踏襲した
- [ADR 0178](./0178-public-api-surface-gate.md) — 「新しい任意プロパティの追加」を
  semver 的に安全と明記した根拠
- [ADR 0155](./0155-recall-score-breakdown-persisted.md) — `RecallRecordMemory` が
  「後から再現できないもの」だけを持つ設計。決定6の根拠
- [ADR 0257](./0257-searched-and-found-nothing-versus-did-not-search.md) — 「探したが
  無かった」と「探していない」を分ける。決定7（推測で埋めない）の根拠
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) —
  本 ADR の決定がいずれも自動化された担い手のものであり、オーナー本人の決定ではない
  ことの根拠
- `docs/migration-v1.md` — 破壊的変更の数え方（項目7・9・10）。「破壊的変更の判定」節
