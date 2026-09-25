# ADR 0335: `RecalledMemory` に任意欄 `contestedWith?: MemoryId` を足す —— 矛盾する対が同伴取得を経由せず両方とも自然に候補に入った場合にも、対向の memoryId を返す（Issue #691 続き）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

**出所: オーナーの決定（ask_human 327fd89b、2026-09-25T21:11Z）。**

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> 決定そのもの（下の「決定」節）は上記 ask_human の回答に基づくが、実装方法・
> ADR の構成・言葉選びは委譲先の担い手が行った。投稿者名 `takecchi` はオーナー本人を
> 意味しない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 / ADR 0289 / ADR 0298 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `vitest` / `tsc` / `pnpm` を走らせて確かめた。
- **【受】** — 報告・Issue コメントとして受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は、本作業の分岐点 `origin/main` = `cf11cd6`（PR #827 のマージ）の
木で、2026-09-26 に行った。

---

## 文脈

### Issue #691 に残っていた「(g)」

[Issue #691](https://github.com/takecchi/mnemora/issues/691) は回答プロンプトへ
`provenanceKind`/`speaker`/`subjectId`/矛盾関係を反映する作業を追ってきたが、
issuecomment-5829247908（PR #750 の後の当て直し）が実データ（`examples/chat` の
`answer` 経路、gpt-4o-mini、n=3）で次を実測していた:

| 条件 | 訂正4件の predicate 一致 | 訂正4件の `contested` 成立 | 誤検出 /14 | 訂正4件で `[矛盾候補:]` が回答プロンプトに届いた数 |
|---|---|---|---|---|
| `detect`（基準） | 0/4 ×3回 | 0/4 ×3回 | 1, 1, 1 | 0（3回とも） |
| `detect-known-predicates-from-store`（ADR 0329） | 4/4 ×3回 | 4/4 ×3回 | 4, 3, 3 | 0（3回とも） |

**predicate 一致が改善して `contested` が4/4成立しても、`[矛盾候補:]` は0/4のまま届かない。**
原因はコメントが特定していた（`packages/core/src/recall-runtime.ts` 1148〜1170行付近、
当時の行番号）:

> `companionOf: owner?.memory.id` が付くのは、`contested` の相手を同伴取得
> （`retrievedVia: "mandatory_companion"`）で候補に引き込んだときだけである。
> 相手が普通に候補に入っていれば、印は付かない。

段2（再スコア・ランキング）で相手がたまたま `withinLimit` の内側に自然に残った場合、
段3の同伴取得（mandatory companion retrieval）は発火しない——発火しないと
`companionOf` を持つ側が存在しないので、`buildMnemoraPrompt`（`examples/chat`）の
`contradictionCounterpartIds` が対を見つける手段が無かった。

### オーナーへの問い（issuecomment-5829247908 末尾）

前の担い手は、直す道を2つに絞ってオーナーへ判断を仰いだ:

> 「`companionOf` の付く条件を広げるか／`contested` を公開するか」には、#750 の数字が
> 効く。(c) は opt-in で訂正4件とも `contested` に達し（4/4 ×3回）、残る壁は (g) だけ
> である。つまり (g) を直すと、訂正4件でタグが届く見込みがある。一方で、同じ条件のまま
> (g) を直すと、誤検出 3〜4/14 のうちタグに届くものも増えるはずである。いま誤検出側で
> 回答へ出ているのは1対（2件）だけである。だから判断には「訂正の検出 4/4」と
> 「誤検出 3〜4/14」の対比が要る。

**ask_human 327fd89b（2026-09-25T21:11Z）でオーナーの決定を受け取った**——
`companionOf` の意味は変えず、`RecalledMemory` に新しい任意欄 `contestedWith?` を足して
この経路を埋める、という方針である。誤検出が増える可能性を承知の上で(g)を埋め、
どこまで誤検出がタグへ届くかは実 API で別途測る、という判断（下の「これが覆るとしたら」
参照）。

### なぜ `companionOf` を流用しなかったか

**`companionOf` の意味を変える案は採らなかった。** 2箇所が「同伴取得された側だけが持つ」
という現在の意味に依存している:

1. `packages/core/src/recall.ts` の `companionOf` doc コメント（本 ADR 以前の逐語）
   「矛盾の相手として同伴取得された場合、その相手の memoryId」——**同伴取得** という
   条件を明示している。
2. `examples/chat/src/correction-demo.ts:510-531`（`checkCorrectionDemo`）の
   `afterMarkCompanionOfOther` が、「ちょうど片方が `retrievedVia === "mandatory_companion"`
   で、その `companionOf` がもう片方を指す」ことを**前提**にして判定を組んでいる
   （`packages/core` の訂正の一巡が段3の必須同伴取得を実際に発火させたかどうかの検査。
   ADR 0162 決定5）。`companionOf` を「両方とも自然に候補に入った場合にも付く」形へ
   広げると、この判定が「同伴取得が発火した」ことの代理指標として機能しなくなる
   ——**発火していない場合にも `companionOf` 相当の印が立つと、この既存の歯が
   何を測っているのか分からなくなる。**

⟹ 意味を変えずに**新設**する方を選んだ。これが本 ADR の決定1である。

---

## 決定

### 決定1: `RecalledMemory` に任意欄 `contestedWith?: MemoryId` を足す

`packages/core/src/recall.ts`:

```ts
export interface RecalledMemory {
  // ...
  companionOf?: MemoryId; // 既存。意味は無変更。
  contestedWith?: MemoryId; // 新設。
  // ...
}
```

zod スキーマにも同じ形で足す: `contestedWith: z.string().min(1).optional()`
（既存の `companionOf`/`associationOf` と同じ形）。

**意味**: この記憶が `contested` で、かつその相手（`Memory.contestedWithId`）が
**同じ recall 結果に含まれるとき**、その相手の memoryId。**`retrievedVia` を問わない**
——`companionOf` と違い、同伴取得（`mandatory_companion`）経由かどうかを条件にしない。

### 決定2: 付ける条件は3つすべてを満たすときだけ

`packages/core/src/recall-runtime.ts` の `finalMemories` を組み立てる箇所
（`companionOf`/`associationOf` を写している直後）に、次の3条件がすべて成り立つときだけ
`contestedWith` を書く:

1. `member.memory.status === "contested"`
2. `member.memory.contestedWithId` が truthy（段3の既存フィルタ
   `contestedNeedingCompanion` と同じ truthy チェック——`null`/`undefined`/空文字は
   どれも「対向なし」）
3. その id が、**budget による切り詰め後**の最終的な返却集合（`keptUnits` から
   組んだ memoryId の集合）に含まれる

```ts
const keptMemoryIds = new Set(
  keptUnits.flatMap((unit) => unit.members.map((member) => member.memory.id)),
);
// ...
if (
  member.memory.status === "contested" &&
  member.memory.contestedWithId &&
  keptMemoryIds.has(member.memory.contestedWithId)
) {
  recalled.contestedWith = member.memory.contestedWithId;
}
```

**3番目の条件を budget 切り詰め「後」の集合で判定する理由**: 段4（予算切り詰め）は
Unit（対向する2件をまとめた単位）を丸ごと落とすことがある（`docs/recall.md` §8、
既存の「予算に両方載らない場合、ペアごと落とす」歯）。切り詰め「前」の候補集合で
判定すると、実際には返さない相手を「返した」と偽って `contestedWith` に書くことになる
——`RecalledMemory` は「実際に返した記憶」の一覧なので、この欄が指す相手も
実際に返した記憶でなければならない。

**一方向のことがある**: `companionOf` と同じく、`contestedWithId` の相互参照は
検査しない（段3の既存コメント、ADR 0136 参照）。`a.contestedWithId = b.id` だが
`b.contestedWithId` が別の値（または無し）なら、`a` にだけ `contestedWith` が付く。

### 決定3: `examples/chat` の `contradictionCounterpartIds` を拡張する

`examples/chat/src/mnemora-path.ts` の `contradictionCounterpartIds` に、
`m.contestedWith`（自分自身が持つ場合）と、`all` を見て `other.contestedWith === m.memoryId`
（逆向き）の両方を足す。中身は `Set` なので、同じ相手が `companionOf` 経由でも
`contestedWith` 経由でも見つかった場合に重複しない——既存の同伴取得のケースの
出力は変わらない（`provenance-prompt-contract.test.ts` の既存14件で確認済み。
「測ったこと」参照）。

### 決定4: `returnedMemories`（`RecallRecordMemory`、`recalls` テーブルへの永続化）には足さない——負債として引き受ける

`packages/core/src/recall.ts` の `RecallRecordMemory`（`MemoryStore.createRecall` への
入力、`recalls.returned_memories` jsonb 列に書く形）は**変更しない**。`postgres` の
schema・migration にも触らない。

**引き受けた負債**: `recalls` テーブルへ永続化された過去の recall 記録からは、
`contestedWith` を後から復元できない——`RecallRecordMemory` が持つのは
`memoryId`/`score`/`retrievedVia`/`companionOf?`/`associationOf?` だけであり、
`contestedWith` はその場限りの返り値（`RecallResult.memories`）にしか出ない。
`companionOf` は既に同じ扱い（`RecalledMemory` にはあるが `RecallRecordMemory` にも
実は載っている——`recall.ts` の doc コメントの逐語「`score`（`ScoreBreakdown` 全項）・
`retrievedVia`・`companionOf?`・`associationOf?` は…後から同じ値を計算し直せないため持つ」)
に対して、`contestedWith` だけ永続化されないのは非対称である。

**なぜ広げなかったか**: `RecallRecordMemory` を変えると `packages/postgres` の
`recalls.returned_memories` jsonb のスキーマ・移行が絡む（本 PR の射程外——マイグレーション・
postgres schema には触らない、という本 PR の前提）。加えて、`contestedWith` の値は
「その recall 呼び出しの時点で、相手が同じ結果集合に含まれていたか」という**budget・limit
に依存する一過性の事実**であり、`companionOf`（矛盾解決という意味論そのもの）ほど
監査上の実体を持たない可能性がある——広げる価値があるかどうかは、今回は判断していない。
広げるなら別 PR・別 ADR とし、`RecallRecordMemory` の変更が migration を要するかどうかも
そこで検討する。

---

## 測ったこと

### 1. core: 赤→緑（`packages/core/src/__tests__/recall-pipeline.test.ts`）

実装前に、互いに `contestedWithId` を持つ対を `runtime.markContested` で作り、**両方**を
クエリベクトルに近い位置へ置く fixture（`setupNaturallyPairedContestedPair`）を書き、
先にテストを実行して赤を確認した:

```
❯ pnpm --filter @mnemora/core exec vitest run src/__tests__/recall-pipeline.test.ts -t contestedWith

 ❯ recall() — 段3: contestedWith（…）
   × 🔴 両方とも ann で自然に候補に入ると、両方に contestedWith が付き、相手の memoryId を指す
AssertionError: expected undefined to be 'mem-2'
```

実装後、同じテストを含む5件がすべて緑になった（他4件は付けすぎの変異検査、下記）:

```
 Test Files  1 passed (1)
      Tests  5 passed | 96 skipped (101)
```

### 2. 付けすぎの変異試験（実装の条件を一時的に緩めて確認）

**MUTATION A（決定2の条件1を外す。status 検査を外す）**: `member.memory.status ===
"contested" &&` を削除して再実行すると、「status が active のまま contestedWithId
だけが（不整合に）設定されている記憶には contestedWith が付かない」の歯が実際に赤くなった:

```
AssertionError: expected 'mem-8' to be undefined
+ Received: "mem-8"
```

`cp`で退避したファイルへ戻し、5件とも緑に復帰したことを確認した。

**MUTATION B（決定2の条件3を外す。集合の所属検査を外す）**:
`keptMemoryIds.has(member.memory.contestedWithId)` を削除して再実行すると、
「contested だが相手が最終的な結果集合に居ない…場合は contestedWith が付かない」の
歯が実際に赤くなった:

```
AssertionError: expected 'mem-11' to be undefined
+ Received: "mem-11"
```

同じく `cp` で戻し、5件とも緑に復帰したことを確認した。

⚠ **決定2の条件3（budget 切り詰め後の集合）を、budget 切り詰めそのものが相手を
落とす形（連想枠ではなく main channel の予算切り詰め）では直接検査していない。**
main channel で拾われた対は、段3のユニット組み立てが常に1つの Unit として
まとめる（`else if (companion)` 分岐）ため、budget はペアを常に丸ごと落とすか
丸ごと残すかのどちらかであり（既存の「予算に両方載らない場合、ペアごと落とす」歯が
これを検査済み）、この経路では「相手だけが budget で落ちる」状態そのものが構造的に
作れない。「相手が最終的な結果集合に居ない」を実際に作れたのは、連想枠
（`retrievedVia: "association"`）経由で単独候補になった場合だけである——
`keptMemoryIds` は budget 切り詰め後に計算するので、この経路もコードパスとしては
同じ判定を通る。**budget が直接の理由で相手が落ちるケースは、別途 fixture を
組んでいない**（下の「確かめていないこと」参照）。

### 3. 付け忘れの変異試験

上の赤→緑の歯自体が、通常の实装（3条件すべて満たす）を検査している。加えて
「active な（contested でない）記憶には contestedWith が付かない」歯が、
そもそも `contestedWithId` を持たない通常の記憶で退行しないことを検査する。

### 4. examples/chat: 赤→緑（`provenance-prompt-contract.test.ts`）

`mnemora-path.ts` の変更を一時的に戻し（`git show HEAD:...` で退避）、
新設した3ケース（`contested-with-natural-pair`・`contested-with-partner-missing`・
`contested-with-absent-no-mark`）を含む契約テストを実行して赤を確認した:

```
❯ pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/provenance-prompt-contract.test.ts

 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)

 × contested-with-natural-pair: …
   - "- [由来:stated] [話者:太郎] [主題:user-1] [矛盾候補:「休みは火曜」] 休みは月曜",
   + "- [由来:stated] [話者:太郎] [主題:user-1] 休みは月曜",
 × contested-with-partner-missing: …
```

`contested-with-absent-no-mark`（印が出ない期待のケース）は実装前後どちらでも緑
だった——期待どおり。

実装を戻すと、20件全部が緑になった:

```
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

### 5. 既存の歯への影響（回帰）

- `recall-pipeline.test.ts`・`stage3-mandatory-companion-mutation.test.ts`・
  `mark-contested.test.ts`・`apply-correction.test.ts`・`resolve-contested.test.ts`・
  `resolve-contested-loser-invariant.test.ts`・`recall-association.test.ts`・
  `recall-association-gates.test.ts`・`recall-association-usage-ranking.test.ts`
  （`packages/core`）: 9ファイル191件、全て緑。
- `provenance-prompt-contract.test.ts`・`correction-demo.test.ts`（`examples/chat`）:
  2ファイル41件、全て緑。
- `correction-demo.postgres.test.ts`（本物の Postgres 17 + pgvector、`AGENTS.md`
  の手順で自前の使い捨てインスタンスを用意して実測）: 3件、全て緑。
- ルートの6つの門: `pnpm run typecheck` / `pnpm run lint` / `pnpm run format:check` /
  `pnpm run test`（`DATABASE_URL` 無し、DB 段は「実行していません」と告知して残り全緑）/
  `pnpm run build` / `pnpm run pack:check`、すべて緑。
- `node scripts/check-public-api-surface.mjs`: `@mnemora/core` の型シグネチャに
  `contestedWith?: MemoryId` を追加する差分だけが出た（他5パッケージは差分なし）。
  `pnpm run build` を先に実行してから確認したので、dist が古いことによる偽の差分ではない
  （`docs/autonomy.md` §4.1 の「古い `dist/` のまま `check-public-api-surface.mjs
  --write` を打つ」穴を踏んでいないことの確認）。
  `--write` で snapshot を更新した。

---

## 採らなかった案

### 案A: `companionOf` の意味を広げる（同伴取得以外でも付ける）

「文脈」節のとおり、`docs/recall.md` §8 の doc コメントと
`examples/chat/src/correction-demo.ts` の `afterMarkCompanionOfOther` が
「同伴取得された側だけが持つ」という現在の意味に依存しているため、却下。

### 案B: `contested` そのものを `RecalledMemory` に公開する（`status` を返す）

オーナーへの問いが並べたもう一つの案。呼び出し側が自分で「両方 `contested` かつ
相互に `contestedWithId` を指すか」を判定できるようにする案だが、`status` を
丸ごと公開すると `superseded`/`archived`/`forgotten` も含めた全 status の意味を
呼び出し側が理解する必要が生じ、`provenanceKind` の doc コメントが明示している
設計原理（「絞り込みに使える軸は載せる。使えない詳細は `get()` に残す」、
ADR 0312）に反する。加えて `contestedWithId` 自体も返す必要が生じ、
`RecalledMemory` の欄が2つ増える（`status`+`contestedWithId`）のに対し、
本 ADR の案は1欄（`contestedWith`）で同じ情報を「相手が実際に結果に含まれるか」
まで畳んで返せる。

### 案C: `examples/chat` 側だけで判定する（core を変えない）

`RecalledMemory` が `status`/`contestedWithId` のどちらも返さないため、
`examples/chat` 側からは「この2件が矛盾しているか」を判定する材料が無い
（案Bを採らない限り）。core を変えずに解決する道は無い。

---

## 引き受けた負債

### 負債1（決定4の再掲）: `returnedMemories`（`recalls.returned_memories`）に `contestedWith` を持たない

過去に遡って `contestedWith` を復元できない。上の「決定4」参照。

### 負債2: 誤検出側で `contestedWith` が届く可能性が増える

issuecomment-5829247908 が実測した「誤検出 3〜4/14」のうち、今日 `[矛盾候補:]` が
実際に回答プロンプトへ届いているのは1対（2件）だけである（(g) が壁になっていたため）。
本 ADR で (g) を埋めると、残りの誤検出（`contested` は成立しているが両方とも自然に
候補に入り、同伴取得を経由しなかった対）にも `contestedWith` が届くようになる
——**誤検出のタグが届く率が増える可能性がある**。この増分は実 API で未測定である
（下の「確かめていないこと」参照）。

### 負債3: main channel の budget 切り詰めによる「相手が落ちる」経路を fixture で直接検査していない

「測ったこと」2番の末尾参照。コードパス（`keptMemoryIds` の判定）は連想枠経由の
fixture と共有しているため機能上は検査済みだが、「main channel の対が budget で
片方だけ落ちる」という具体的な状態そのものは、この PR の範囲では構造的に作れなかった
（段3のユニット組み立てが対を常に1つの Unit にまとめるため）。

---

## 確かめていないこと

- **誤検出側のタグ到達率の実測**: issuecomment-5829247908 が測った「誤検出 3〜4/14」の
  うち、本 ADR の実装後に実際に何件が `[矛盾候補:]` として回答プロンプトへ届くように
  なるかは、実 API（`MNEMORA_LLM=openai` 等）で `examples/chat` の `answer` 経路を
  再測定していない。オーナーへの問いの前提（「訂正の検出 4/4」と「誤検出 3〜4/14」の
  対比）を、本 ADR の実装後の数字で更新する作業は本 PR の外に残る。
- **回答の質への影響**: 誤検出側にタグが増えて届くようになった場合、回答モデルが
  それをどう扱うか（無視するか、誤って重要視するか）は評価していない。
- **`recorded`/`local` provider を使った answer ベンチでの回帰**: この PR は
  provenance-prompt-contract.test.ts（純粋な描画契約、LLM を一切呼ばない）でしか
  確かめていない。`examples/chat` の `answer`/`compare` 系のベンチ（本物の Postgres +
  記録済みカセット or `local` embedding を要する）は走らせていない
  （`DATABASE_URL` を用意した使い捨て Postgres では `correction-demo.postgres.test.ts`
  だけを実行した——`answer`/`compare` は別途カセットの録り直しが要り、本 PR の射程外
  とした）。
- **main channel の budget 切り詰めで相手だけが落ちる状態の直接検査**（負債3参照）。

---

## これが覆るとしたら

- **誤検出側のタグ到達率が実 API で測定され、回答の質を悪化させると分かった場合**、
  (g) を埋める条件をさらに絞る（例: 誤検出になりやすい `claimKey` の派生元を除く）か、
  `contestedWith` を opt-in にする方向へ戻す可能性がある。
- **`RecallRecordMemory`（`returnedMemories`）への `contestedWith` の追加が
  監査上必要になった場合**、負債1を解消する別 PR・別 ADR を起こす（migration が
  要るかどうかはそのとき検討する）。

## 関連

- [Issue #691](https://github.com/takecchi/mnemora/issues/691)
- [ADR 0136](./0136-contested-lone-dropped-not-returned-alone.md)（片側だけの `contested`
  は単独で出さない——段3のユニット組み立ての前提）
- [ADR 0150](./0150-resolve-contested-explicit-operation.md)（`resolveContested`
  が両側の `contestedWithId` を `null` に戻す——本 ADR の欄が「結果集合に含まれるか」を
  毎回判定し直す理由の裏付け）
- [ADR 0289](./0289-recalled-memory-speaker-subject.md)（`RecalledMemory` に任意欄を
  足す先例・出所の凡例の体裁）
- [ADR 0298](./0298-recalled-memory-recorded-occurred-at.md)（同じ Issue #691 系列の
  先行 ADR）
- [ADR 0329](./0329-claim-key-known-predicates-from-store.md)（issuecomment-5829247908
  が引用した誤検出3〜4/14の実測元）
