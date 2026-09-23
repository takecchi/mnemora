# ADR 0282: `ScoreBreakdown` に `affinityMeasured?: boolean` を追加のみで足す —— Issue #548 方向1（非破壊）を採る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-23

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0151 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `node` / `vitest` / `pnpm` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は `origin/main` = `2323ca6`（本作業の分岐点）の木で、2026-09-23 に行った。

---

## 文脈

### Issue #548 が並べた3方向と、いったん保留された経緯

[Issue #548](https://github.com/takecchi/mnemora/issues/548) は、連想枠（段3.5）が返す
`score.total` が段2の棄却時より高く見えることがある問題（[ADR 0246](./0246-association-rank-includes-decay.md)
「⛔ これが閉じないもの」2）に対して、3方向を並べて**逐語で「⛔ どれも決めていない」**としていた
（【現物】Issue本文、`gh issue view 548 --repo takecchi/mnemora --json body,comments` で取得。
comments は0件）:

> 1. `ScoreBreakdown` に「affinity を測っていない」を名乗る欄を足す（破壊的変更）
> 2. 連想枠が返す `score` を、比較可能な量だけに絞った別の形にする（破壊的変更）
> 3. 契約として「`retrievedVia` が異なる記憶どうしの `score.total` は比較可能ではない」と明記、
>    型は変えない（「穴を塞がないことを承知で選ぶ必要がある」と自認）

先行する作業（本 ADR と同じ分岐から切り出された別セッション）は、当初「方向3 のみが v1.0.0
公開後の semver 制約下で採れる」という論証で方向3 に着手しかけたが、**着手前の検証で
その論証の一部が崩れることを見つけ、方向1 の再検討を依頼元へ差し戻した**。本 ADR はその
差し戻しを受けて、方向1 を実装する。

### 🔴 「方向1 = 必ず破壊的変更」という Issue 本文・ADR 0246 の分類は、required 実装を前提にした結論だった

**Issue #548 本文・ADR 0246 は、方向1・方向2 をどちらも「破壊的変更」と括弧書きしている。**
⛔ **本 ADR はこの分類を書き換えない**（Issue 本文にも ADR 0246 本文にも手を入れていない
——`git diff` で確認）。**そのうえで、この分類が required（必須フィールド追加）を実装として
暗黙に前提していたことを、この repo 自身が明文化している基準に照らして示す。**

**根拠1【現物】** [ADR 0178](./0178-public-api-surface-gate.md)「引き受けた負債」1（逐語）:

> 「変わった」ことは分かるが「壊れているか」は判定しない。**semver 的に安全な変更
> （例: 新しい任意プロパティの追加、union へのメンバー追加で既存呼び出し側が壊れない形）**
> も、危険な変更（必須メソッドの追加）も、この歯は同じ「赤」として扱う。判定は人間・ADR
> に委ねる

**この repo 自身が「新しい任意プロパティの追加」を semver 的に安全（＝非破壊）の代表例として
名指ししている。**

**根拠2【現物】** [`docs/migration-v1.md`](../migration-v1.md) の既存18項目のうち、
項目7（`RecallFootprintEstimate` の入力側フィールド追加）は逐語で「省略可能フィールドとして
追加されており、省略すれば0として扱われる（**非破壊**）」と明記しており、項目3・9・10・17
（`ScopeAggregate`/`FilteredOmission`/`Omission.over_limit`/`MemoryEventKind`）はいずれも
「**必須**フィールド・union メンバの追加」だけを破壊的と数えている——「⭕ 読むだけ・呼ぶだけの
利用者には影響しない」「自分で組み立てている場合だけ」という言い回しが繰り返されている。

**根拠3【現物】** `ScoreBreakdown` は、この基準どおりに**既に一度、任意フィールドの追加で
非破壊に育った実例を持つ**。`lexicalMatch?: number` は [ADR 0084](./0084-lexical-recall-channel.md)
（Issue #106、`v0.1.1` の後）で足された欄だが、`docs/migration-v1.md`・`CHANGELOG.md` の
どちらにも破壊的変更として載っていない（【実測】両ファイルへの `grep -n "lexicalMatch"` は
0件）。`packages/core/src/strategies/scoring.ts` の `scoreWithDefaultStrategy` は、
`similarity`/`lexicalMatch` を「値がある場合だけ `score.x = x` で足す」形で書かれており
（同ファイル270行目台）、この形がそのまま「任意フィールドの追加＝非破壊」という基準を
体現している。

⟹ **方向1 を、この既存の形（任意フィールドの追加）で実装すれば、この repo 自身の基準に
照らして非破壊である。**Issue #548 本文・ADR 0246 が「破壊的変更」と括弧書きしたのは、
required（必須）で足す実装だけを想定していたためだと考えられる——**ただしこれは本 ADR の
推測であり、Issue 本文・ADR 0246 自身にその区別についての言及は無い。**

### README.md の「版の付け方」（v1.0.0 以降）【現物】

`v1.0.0` は 2026-09-22T23:54:08Z に published 済みである（【実測】`gh release list --repo
takecchi/mnemora --limit 3`、npm 6パッケージとも `version=1.0.0`）。README.md はこれを踏まえ:

> `v1.0.0` 以降は semver に従う——公開 API の破壊的変更は major を上げる。⛔「もう変わらない」
> という意味ではない。破壊的変更は major を上げる形で起こりうる。ただしそのとき ADR を書く
> ことは必須である（ADR 0156 逐語「公開 API の破壊的変更も、ADR を書けば実装してよい……」）

⟹ v1.0.0 後も破壊的変更そのものは（ADR を伴えば）担い手が実装してよい、という委譲
（[ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)）は repo 側で
失効させられていない。**本 ADR はこの委譲を使う必要が無い**——方向1 を非破壊で実装する
ため、そもそも破壊的変更の手続き自体が要らない。

---

## 決定

### 1. `ScoreBreakdown` に `affinityMeasured?: boolean` を**任意フィールドとして**足す

```ts
export interface ScoreBreakdown {
  similarity?: number;
  lexicalMatch?: number;
  decay: number;
  tagMatch: number;
  freshness: number;
  strength: number;
  total: number;
  affinityMeasured?: boolean; // 新設
}
```

`ScoreBreakdownSchema`（zod）にも同じ形で `affinityMeasured: z.boolean().optional()` を足す。
**既存の欄の型・名前・必須性は1バイトも変えていない**（`git diff` で確認——追加行のみ）。

### 2. 値は `defaultScoringStrategy` が常に埋める。値の意味は「`similarity`/`lexicalMatch`
のどちらかが在ったか」

```ts
const affinityMeasured = similarity !== undefined || lexicalMatch !== undefined;
```

- **`true`**: `affinity`（`total` の内訳のうち、クエリ関連度を表す項）が `similarity` または
  `lexicalMatch` の実測値から来ている。
- **`false`**: `similarity`・`lexicalMatch` のどちらも無く、`affinity` が中立の `1` に退化した
  （現状ではこれは連想枠のみで起きる。`strategies/scoring.ts` 冒頭 doc の分岐そのもの）。

**⟹ `affinityMeasured: false` の記憶の `score.total` を、`true` の記憶の `score.total` と
比較しないこと。**同じ値どうし（`false` と `false`、`true` と `true`）の比較は妨げない。
これが Issue #548 の核心（「連想枠経由で返った記憶の `score.total` は、段2 が棄却した記憶の
`total` と比較可能ではない」）に対する契約である。

### 3. `similarity`/`lexicalMatch` と違い、`affinityMeasured` は**常に**（値が `false` のときも）
`score` オブジェクトへ足す

`similarity`/`lexicalMatch` は「値がある場合だけ足す」形（`if (x !== undefined) score.x = x`）
だが、`affinityMeasured` はそれに倣わない——**倣うと `false` と「欄が無い」が同じ見た目に
なり、下の設計問2 の区別が最初から失われる。** `true`/`false` のどちらでも必ず書き込む
ことで、「欄が在るのに undefined」という状態を型の上では作らず、**「欄が丸ごと無い」ことだけを
別の意味（下記）に残す。**

### 4. 永続化への影響: 無し（マイグレーション不要）【現物・実測】

[ADR 0155](./0155-recall-score-breakdown-persisted.md) により `ScoreBreakdown` は
`recalls.returned_memories`（**jsonb**、固定スキーマの列ではない）に埋め込まれて永続化される。
`packages/postgres/src/mapping.ts` の `rowToRecallRecord` は zod 検証を通さない単純な cast
であることを確認した（同関数はフィールドごとの変換を持たず `row.returned_memories` を
そのまま `RecallRecord.returnedMemories` へ代入するだけ）。

⟹ **SQL 側のスキーマ変更は不要。マイグレーションも不要。** 既存の永続化済み行
（本 PR より前に書かれた `breakdownCaptured: true` の行）は、その `score` オブジェクトの
JSON に `affinityMeasured` キーを持たない——読み出すと `undefined` になるだけで、型は
`affinityMeasured?: boolean`（任意）なので型エラーにも実行時エラーにもならない。
**これは「欄が無い」の3つ目の発生源であり、下の「引き受けた負債」に書く。**

---

## 設計問2 —— 「測っていない」と「欄を埋めていない」は区別できるか

⚠ **できない。区別できないことを、そのまま引き受けた負債として書く**（下記）。

`affinityMeasured` が `undefined` になる経路は実際には2つある:

1. **`ScoringStrategy`（`packages/core/src/strategies/scoring.ts` が公開する型。利用者が
   自分で実装できる公開の拡張点——`ann-truncation.ts` の `strategy: ScoringStrategy` が
   これを受け取る）を自作していて、この欄を書いていない場合。**
2. **本 PR より前に永続化された `recalls` 行を `getRecall` で読み戻した場合**
   （上の決定4）。

型の上ではこの2つも、そして「将来 `affinityMeasured: undefined` を明示的に書く行儀の悪い
実装」も、すべて同じ `undefined` として現れ、**区別できない。**

⟹ 本 ADR が採る立場: **`undefined` を見たら「関連度を測ったかどうか分からない」とだけ
扱い、比較可能とも不可能とも仮定しない。** これは「エラーにする」でも「`false` にみなす」
でもない——後者（`undefined` を `false` とみなす）は、実際には測ったのに欄を書いていない
だけの独自実装の記憶を「比較不可能」と誤って決めつけることになり、前者（エラーにする）は
既存の独自 `ScoringStrategy` を握っている利用者を壊す（非破壊の方針と矛盾する）。
**"わからない"を"わからない"のままにする**——[ADR 0008](./0008-absence-taxonomy.md)
「無いには種類がある」の族と同じ考え方である。

---

## 採らなかった案

| 案 | 却下の理由 |
|---|---|
| **方向2（連想枠が返す `score` を、比較可能な量だけに絞った別の形にする）** | Issue 本文が示す方向のうち最も構造変更が大きい——`score` の形そのものを変える（型を再設計する）ため、方向1 のような「既存の型に触れず追加のみ」という道が閉じている可能性が高い。**個別に required/optional の余地を検討していない**（射程外・確かめていないこと参照）。方向1 が非破壊で穴を塞げる以上、より侵襲的な方向2 を採る理由が無い |
| **方向3（契約として明記するだけ。型は変えない）** | Issue 本文自身が「穴を塞がないことを承知で選ぶ必要がある」と自認している——ドキュメントの契約だけでは、`score.total` を見ている呼び手が**その場で**比較可能性を判定できない（呼び手は `docs/recall.md` を毎回参照する必要がある）。**方向1 が非破壊で実装できる以上**、穴を塞がない方向3 を積極的に選ぶ理由が消えた。方向3 は「方向1・2 が採れない」という前提（v2.0.0 が要る＝オーナー領分）の上でのみ選ばれる次善策であり、その前提が本 ADR の検証で崩れた |
| **`affinityMeasured` を必須（required）フィールドにする** | この repo の基準（ADR 0178・migration-v1.md item 7）では必須フィールドの追加は破壊的変更に数えられる。任意で足せば同じ実用上の効果（`defaultScoringStrategy` を経由する限り常に `true`/`false` が入る）を、非破壊で得られる——required にする実益が無い |
| **欄名を `totalComparable?: boolean` にする（affinity ではなく total の比較可能性を直接名乗る）** | 検討した。「利用者に分かりやすい」という利点はあるが、`true`/`false` が指す境界は「`total` が比較可能かどうか」ではなく「`affinity` を測ったかどうか」であり（同じ `false` どうしはむしろ比較できる）、`totalComparable` という名前は「他のどの記憶とも比較できない」という誤読を招きやすい。`affinityMeasured` は何を測った/測っていないかを直接名乗り、比較可能性はそこから読み手が導く形にした——`ScoreBreakdown` の既存欄（`similarity`/`lexicalMatch`/`decay`/`tagMatch`/`freshness`/`strength`）がいずれも「何を計算したか」を名乗る欄であり、`affinityMeasured` もその並びに揃えた |
| **`undefined` を `false` とみなすヘルパー関数を公開する**（例: `isAffinityMeasured(score): boolean`） | 設計問2 の区別ができない以上、このヘルパーは「独自 `ScoringStrategy` の記憶」と「本当に測っていない記憶」を同じ `false` に潰してしまう——上の設計問2 の結論（"わからない"を"わからない"のままにする）と矛盾する。要求があれば別途検討する |
| **`docs/recall.md` の既存記述（`score.semanticSimilarity` という誤記）を、この PR のついでに直す** | 依頼の射程外として明示されている。実フィールド名の言及が必要な箇所（新設した addendum）でのみ正しい名前 `similarity` を使い、既存の誤記そのものは書き換えていない |

---

## 引き受けた負債

1. **`undefined` の3つの発生源を型では区別できない**（設計問2）。独自 `ScoringStrategy` が
   この欄を埋めていない場合と、本 PR より前に永続化された recall 行を読み戻した場合が、
   同じ `undefined` として現れる。読み手はどちらの場合も「わからない」としてしか扱えない。
2. **同じ `affinityMeasured` の値どうしの比較可能性そのものは保証していない。**
   本 ADR が保証するのは「`false` と `true` を跨いだ比較をしないこと」だけである。
   例えば `lexicalMatch` 由来の `affinity`（語彙被覆率、値域 `(0,1]`）と `similarity` 由来の
   `affinity`（コサイン類似度、値域 `[-1,1]`）は、どちらも `affinityMeasured: true` だが
   尺度が異なる——この差は ADR 0084/0092 が既に受け入れている既存の設計であり、
   本 ADR の射程外である。
3. **永続化済みの過去の recall 行は、この欄を持たないまま残る。**
   決定4 のとおりマイグレーションはしていない・する必要も無いと判断したが、これらの行を
   `getRecall` で読み戻しても `affinityMeasured` は付かない（そもそも当時 `defaultScoringStrategy`
   がこの欄を計算していなかったため、後から復元することもできない）。
4. **書き込み容量への影響を実測していない。** 1レコードあたり `boolean` 1個ぶんの増加であり、
   ADR 0155「引き受けた負債」1（`ScoreBreakdown` 全体の容量増を実測していない）の射程に
   そのまま合流する。個別に実測していない。

---

## これが覆るとしたら

1. **設計問2 の区別（独自 `ScoringStrategy` が埋めていない vs 本当に測っていない）が
   実際に必要になったとき** —— そのときは `ScoringStrategy` 型自体を拡張するか
   （`BoundedScoringStrategy` と同じ「本体は変えず、後から生やす」形が使えるか検討する）、
   あるいは3値（`true`/`false`/`"unknown"`）にする破壊的変更を検討することになる。
2. **`lexicalMatch` 由来の affinity と `similarity` 由来の affinity の尺度の違い
   （引き受けた負債2）が実害を生んだとき** —— ADR 0084/0092 の再検討が要る。本 ADR
   単独では覆らない。
3. **オーナーが「方向1 は required で実装すべきだった」「非破壊であっても v2.0.0 まで
   待つべきだった」と判断したとき** —— 本 ADR は無効になり、`affinityMeasured` を
   required にする追加の破壊的変更（別 ADR）を検討することになる。
4. **オーナーが本 ADR の分類（Issue #548 本文・ADR 0246 の「破壊的変更」という括弧書きが
   required 実装の前提だった、という上の「文脈」節の推測）を「違う」と言ったとき** ——
   その場合、方向1 の非破壊性そのものを再検証する必要がある。

---

## 測ったこと

### 【実測】赤（実装前）

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/scoring.test.ts src/__tests__/recall-association.test.ts
...
 FAIL  src/__tests__/scoring.test.ts > defaultScoringStrategy: affinityMeasured（Issue #548 方向1、ADR 0282） > similarity も lexicalMatch も無いとき affinityMeasured は false（affinity が中立の1に退化した合図）
AssertionError: expected undefined to be false // Object.is equality
 FAIL  src/__tests__/scoring.test.ts > defaultScoringStrategy: affinityMeasured（Issue #548 方向1、ADR 0282） > similarity だけあるとき affinityMeasured は true
AssertionError: expected undefined to be true // Object.is equality
 FAIL  src/__tests__/scoring.test.ts > defaultScoringStrategy: affinityMeasured（Issue #548 方向1、ADR 0282） > lexicalMatch だけあるとき affinityMeasured は true
AssertionError: expected undefined to be true // Object.is equality
 FAIL  src/__tests__/scoring.test.ts > defaultScoringStrategy: affinityMeasured（Issue #548 方向1、ADR 0282） > similarity と lexicalMatch の両方があるとき affinityMeasured は true
AssertionError: expected undefined to be true // Object.is equality
 FAIL  src/__tests__/scoring.test.ts > defaultScoringStrategy: affinityMeasured（Issue #548 方向1、ADR 0282） > similarity が負の値でも（0 ではなく）在ることに変わりはないので affinityMeasured は true
AssertionError: expected undefined to be true // Object.is equality
 FAIL  src/__tests__/recall-association.test.ts > recall() — 連想枠（association、既定 off） > 連想で拾った候補は retrievedVia:'association' と associationOf:<アンカー> を持ち、クエリには当たらない
AssertionError: expected undefined to be true // Object.is equality

 Test Files  2 failed (2)
      Tests  6 failed | 33 passed (39)
```

### 【実測】緑（実装後）

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/scoring.test.ts src/__tests__/recall-association.test.ts
 Test Files  2 passed (2)
      Tests  39 passed (39)
```

### 【実測】変異試験（`cp` で退避・復元。`git checkout` は使っていない）

`strategies/scoring.ts` の `const affinityMeasured = similarity !== undefined || lexicalMatch !== undefined;`
を `const affinityMeasured = true;` に変異させた:

```
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/scoring.test.ts src/__tests__/recall-association.test.ts
 × similarity も lexicalMatch も無いとき affinityMeasured は false（affinity が中立の1に退化した合図）
 × 連想で拾った候補は retrievedVia:'association' と associationOf:<アンカー> を持ち、クエリには当たらない
 Test Files  2 failed (2)
      Tests  2 failed | 37 passed (39)
```

**赤くなったのは狙った2本（`false` を要求する assert）だけで、`true` を要求する assert は
（変異が「常に true」なので）そのまま通った——意図どおりの検出。** 復元後、同じ39本が
緑に戻ることを実測した（上の「緑」のログと同じ出力）。

### 【実測】公開 API スナップショット

`pnpm run build` の後、`pnpm run api:check` は次の diff だけを報告した（`@mnemora/core` の
みが変わり、他5パッケージは差分なし）:

```diff
     freshness: number;
     strength: number;
     total: number;
+    affinityMeasured?: boolean;
 }
 export declare const ScoreBreakdownSchema: z.ZodObject<{
     ...
+    affinityMeasured: z.ZodOptional<z.ZodBoolean>;
 }, z.core.$strip>;
```

（他2箇所、`RecalledMemory`/`RecallRecordMemory` に埋め込まれた同じ zod スキーマでも
同じ1行が追加。**合計4行の追加のみ、既存行の変更は0**。）`pnpm run api:write` で
snapshot を更新し、`pnpm run api:check` が緑に戻ることを確認した
（`git diff --stat scripts/__snapshots__/public-api/` = `core.d.ts | 4 ++++`）。

### 【実測】6つの門のうち4つ（手元。マージの根拠にはしない。ADR 0195）

```
$ pnpm run typecheck > /tmp/typecheck.log 2>&1; echo exit=$?     → exit=0（7 workspace すべて Done）
$ pnpm run lint > /tmp/lint.log 2>&1; echo exit=$?               → exit=0
$ pnpm run format:check > /tmp/format.log 2>&1; echo exit=$?     → exit=0
$ pnpm run test > /tmp/t.log 2>&1; echo exit=$?                  → exit=0
   （ルート門: 3/3 段が実行、DB テストは「実行していません」と告知——DATABASE_URL 未設定。ADR 0015）
   @mnemora/core: Test Files 67 passed (67) / Tests 947 passed (947)
```

**既存の1本（`recall-channels.test.ts` の完全一致スナップショット歯）が、実装直後に赤くなった**
——`ScoreBreakdown` を含む `RecallResult` 全体を `toEqual` でリテラル比較する歯であり、
新しい欄が増えたこと自体を検出した（この歯自身が ADR 0098 の追加時にも同じ形で検出した
実績を持つ、テストファイル内のコメント参照）。期待値リテラルへ `affinityMeasured: true`
を足して緑に戻した——**期待値を緩めたのではなく、増えたのがこの1欄だけであることを
リテラルで固定し直した**（同ファイルの既存の規律をそのまま踏襲）。

---

## 確かめていないこと

1. 🔴 **DB テストを実行していない。** この作業環境には `DATABASE_URL` が無く、
   `packages/postgres` の適合テストは走らせていない。決定4（マイグレーション不要）は
   `packages/postgres/src/mapping.ts` の現物コードを読んで確認した設計上の結論であり、
   本物の Postgres に対して「新しい欄を持たない旧行を `getRecall` で読み戻しても壊れない」
   ことを実行して確認してはいない。
2. **書き込み容量の実測をしていない**（引き受けた負債4、ADR 0155 の負債1にそのまま合流）。
3. **`examples/chat` の配線は変更していない・確認していない。** この PR の範囲に含めていない。
4. **`lexicalMatch` 由来の affinity と `similarity` 由来の affinity の尺度の違い**
   （引き受けた負債2）が実際にどれだけ誤読を招くかは測っていない——ADR 0084/0092 の射程。
5. **Issue #548 本文・ADR 0246 が「破壊的変更」と括弧書きした意図**（required 実装を
   前提にしていたのか、それとも別の理由があったのか）は、書き手自身に確認していない
   ——上の「文脈」節の推測のとおり。
6. **方向2 について、required/optional の余地を個別に検討していない**（採らなかった案の表、
   1行目）。

---

## 参照

- [Issue #548](https://github.com/takecchi/mnemora/issues/548) — 本 ADR が閉じる Issue（⛔ close しない。オーナー確認を待つ）
- [ADR 0246](./0246-association-rank-includes-decay.md) — 「⛔ これが閉じないもの」2 が本 ADR の出発点
- [ADR 0151](./0151-recall-association-unprompted.md) — アンカー類似度を `score.similarity` に入れない、という決定1・2（本 ADR はこれを覆さない——`affinityMeasured` はアンカー類似度の値そのものを運ばない）
- [ADR 0155](./0155-recall-score-breakdown-persisted.md) — `ScoreBreakdown` の永続化。本 ADR の決定4の根拠
- [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md) — 破壊的変更の委譲。本 ADR は非破壊なのでこの委譲を使う必要が無いことを確認した
- [ADR 0178](./0178-public-api-surface-gate.md) — 「新しい任意プロパティの追加」を semver 的に安全と明記した「引き受けた負債」1。本 ADR の中心的な根拠
- [ADR 0084](./0084-lexical-recall-channel.md) / [ADR 0092](./0092-lexical-or-coverage.md) — `lexicalMatch?: number` を任意フィールドとして非破壊に追加した先例
- [ADR 0008](./0008-absence-taxonomy.md) — 「無いには種類がある」。設計問2 の考え方の族
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) — 本 ADR の決定が自動化された担い手のものであり、オーナー本人の決定ではないことの根拠
- `docs/migration-v1.md` — 破壊的変更の数え方（項目3・7・9・10・17）
