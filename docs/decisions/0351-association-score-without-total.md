# ADR 0351: 連想枠・必須の同伴取得が返す `score` を、`total` を持たない別の形にする —— Issue #548 方向2（破壊的変更）

- **状態**: 採用 (2026-09-29)
- **日付**: 2026-09-29

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。ただし「破壊的変更を `v1.1.0` に入れてよいか」という
> semver の運用そのものは、下の「文脈」節のとおりオーナー本人が別途答えている
> （ask_human 6911db12）——**この ADR が自分で下した判断ではない。**

**⚠ 各主張の出所を分ける**（ADR 0282 / ADR 0246 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `node` / `vitest` / `pnpm` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は `origin/main` = `d1d4fac`（本作業の分岐点）の木で、2026-09-29 に行った。

**⚠ 2026-09-29 追記（rebase）**: 作業の途中で `origin/main` が進み（PR #1374〜#1379・#1381・#1383）、
本 ADR が指していた ADR 番号 `0350` は PR #1377（`0350-provider-client-type-decoupled-from-sdk-classes.md`、
無関係な変更）に先に使われていたため、`node scripts/adr-renumber.mjs` で本 ADR を `0351` へ付け替えた
（本ファイルの旧ファイル名は `0350-association-score-without-total.md`）。`origin/main` = `9319358`
へ rebase し、「測ったこと」節の実測はすべて rebase 後に取り直した——`d1d4fac` 時点の実測ではない
（この段落だけ例外的に、断りを入れた実測の出所を上書きする）。

---

## 文脈

### Issue #548 と、既に着地している方向1

[Issue #548](https://github.com/takecchi/mnemora/issues/548) は、連想枠（段3.5）が返す
`score.total` が、段2 がその同じ記憶を棄却したときの `total` より高く見えることがある問題を
「説明可能性」の軸（正典「目指す姿」項目3）として起票し、3つの方向を並べていた。

**方向1**（`ScoreBreakdown` に「affinity を測っていない」を名乗る欄を追加のみで足す）は
[ADR 0282](./0282-score-breakdown-affinity-measured.md)（PR #642）で非破壊のまま着地した——
`affinityMeasured?: boolean` が `false` の記憶の `total` を、`true` の記憶の `total` と
比較しないこと、という**契約**である。

### 方向2は「どの形も v2.0.0 を要する」と判定されていた

Issue #548 の 2026-09-23 のコメント（この担い手と同じ委譲の系列にある、別セッションの調査）は、
`main` の現物（`RecalledMemory`/`ScoreBreakdown`/`ScoringStrategy` の当時の形）に当てて、
方向2（「連想枠が返す `score` を、比較可能な量だけに絞った別の形にする」）の実装しうる4つの形
（a〜d）をすべて検討し、**非破壊で入る形（d）は方向2そのものとは呼べず、方向2の中身
（比較不可能な量を実際に外すこと）はどの形でも公開 API の破壊的変更になる**と判定した
（【現物】Issue #548 のコメント、`gh issue view 548 --comments`）。
⟹ **この判定自体は本 ADR も覆さない**——方向2は今日も破壊的変更である。**覆るのは
「`v1.0.0` 後に破壊的変更を入れてよいか」という運用の側**である（次節）。

### `v1.0.0` 後の破壊的変更の運用 —— オーナーの回答（ask_human 6911db12）

`README.md`「版の付け方」は逐語で「`v1.0.0` 以降は semver に従う——公開 API の破壊的変更は
**major を上げる**」と定めている（【現物】、下の「README.md への追記」節で引用する）。
この規律のままでは、方向2を実装するには `v2.0.0` が要る。

**マネージャーから本作業への指示として、オーナーへの問い `ask_human 6911db12`
問6（2026-09-28）への回答が、逐語で次のとおり引き渡されている**:

> v1.X.0とかで破壊的変更しちゃっていいよ僕しか使ってないし

⚠ **出所の性質を正直に書く**: この逐語は、マネージャー（本作業の依頼元）から受け取った
指示に含まれていたものであり、**この ADR の書き手はこの `ask_human` の記録そのものを
この repo の中に見つけていない**——`grep -rn "6911db12"` はこの作業ツリーで0件だった
（【実測】）。ADR 0337 の `ask_human ac5953d1` や roadmap.md の他の `ask_human` 記録が
repo 内の ADR・docs に「id・日時・逐語」の形で残っているのと同じ形で、この回答が
別途 repo 側に記録されるかどうかは、この書き手の管理下にない。⟹ **本 ADR は、この逐語を
マネージャー経由の【受】として扱う**——repo 上で独立に検算していない。

⟹ **この回答により、`v1.0.0` 以降も破壊的変更を minor（`v1.X.0`）で出荷してよい、という
運用が、少なくとも本件については成立する。**本 ADR はこの運用の下で、方向2を `v1.1.0`
（未リリース、`CHANGELOG.md` `[1.1.0]` 節）に破壊的変更として入れる。

### 誰が壊れうるか（先取り。詳細は「決定」節）

`RecalledMemory.score`/`RecallRecordMemory.score`/`CorrectionCandidate.score` を読み、
`.total`/`.similarity`/`.lexicalMatch` へ**型を絞り込まずに**アクセスしている呼び出し側は、
`affinityMeasured: false` の記憶に対してこれらの欄が「無い」ことに、コンパイル時または
実行時に気づく。詳細は「決定」5番。

---

## 決定

### 1. `AffinityUnmeasuredScore` を新設し、`RecalledScore = ScoreBreakdown | AffinityUnmeasuredScore` を作る

```ts
export interface AffinityUnmeasuredScore {
  affinityMeasured: false;
  decay: number;
  tagMatch: number;
  freshness: number;
  strength: number;
}

export type RecalledScore = ScoreBreakdown | AffinityUnmeasuredScore;
```

`ScoreBreakdown` 自体は**1バイトも変えていない**（`total`・`similarity`・`lexicalMatch`・
`affinityMeasured?: boolean` は ADR 0282 のままの形。`git diff` で確認——`recall.ts` への
差分はすべて追加行）。

`RecalledMemory.score` と `RecallRecordMemory.score` の型を、両方とも `ScoreBreakdown` から
`RecalledScore` に変える。**判別子は `affinityMeasured` である**——`score.affinityMeasured
=== false` なら `AffinityUnmeasuredScore`（`total` 無し）、それ以外（`true`/`undefined`）
なら `ScoreBreakdown`（`total` 有り）。

### 2. 判別子を `retrievedVia` にしない

**検討した代案**（下の「採らなかった案」参照）だが、採らなかった。理由:

`fetchMandatoryCompanions`（`recall-runtime.ts` 冒頭、段3・段3.5 が共有する必須の同伴取得の
関数、Issue #959 / PR #970 で共有化）は、**段3 自身の必須同伴取得（`retrievedVia:
"mandatory_companion"`、owner が `"ann"`/`"lexical"` の contested の対向を取る場合）でも、
段3.5（連想枠）が拾った contested の対向を取る場合でも、一度も `similarity`/`lexicalMatch`
を `defaultScoringStrategy` へ渡さない**（【現物】`fetchMandatoryCompanions` の本体、
`recall-runtime.ts`）。⟹ **`retrievedVia: "mandatory_companion"` は、段3経由か段3.5経由かに
関わらず、常に `affinityMeasured: false` になる**——これは今日の実装の副産物であり、
`retrievedVia` の値そのものから導かれる規則ではない。

もし判別子を「`retrievedVia` が `"association"`/`"mandatory_companion"` なら
unmeasured」という形で**素朴に決め打つ**と、実装者が退行を作りうる——例えば
`retrievedVia === "association"` だけを見て `retrievedVia === "mandatory_companion"`
を見落とせば、段3・段3.5 どちらの必須同伴取得も unmeasured 型に変換されず、比較不可能な
`total` を持つ `ScoreBreakdown` のまま返ってしまう（本 ADR が閉じようとしている穴が
半分残る）。**`affinityMeasured` は `defaultScoringStrategy` がその場で「`similarity`/
`lexicalMatch` を実際に渡されたか」から計算する実測の合図であり、経路の値（`retrievedVia`）
を後から矛盾なく保守し続けるより、この合図を直接読むほうが取りこぼしが起きない。**

⟹ **変換関数 `toRecalledScore`（`recall-runtime.ts`）は `score.affinityMeasured === false`
だけを見て変換する。**`retrievedVia` を一切参照しない。

### 3. `ScoringStrategy` の公開シグネチャは変えない

```ts
export type ScoringStrategy = (input: ScoringInput) => ScoreBreakdown;
```

`strategies/scoring.ts` は1バイトも変えていない——`defaultScoringStrategy` は今日も
常に `ScoreBreakdown`（`total` を含む）を返す。**独自の `ScoringStrategy` を実装している
利用者のコードは、この変更の影響を受けない**（引き受けた負債1、後述）。

### 4. 変換は `recall-runtime.ts` の1箇所だけで行う。内部の順位付けは1バイトも変えない

```ts
function toRecalledScore(score: ScoreBreakdown): RecalledScore {
  if (score.affinityMeasured !== false) {
    return score;
  }
  const { decay, tagMatch, freshness, strength } = score;
  return { affinityMeasured: false, decay, tagMatch, freshness, strength };
}
```

**内部表現（`ScoredCandidate.score: ScoreBreakdown`）は変えていない**——`compareScoredCandidates`
（段2の並び順、`score.total` 降順）・`partitionByThreshold`（段2の閾値分割）・
`countKindForPartition`・段3.5 の `rankKey = hit.similarity * score.total`
（ADR 0246 決定1）は、すべて変換**前**の `ScoreBreakdown`（`total` を持つ）をそのまま読む。
`toRecalledScore` を呼ぶのは、`finalMemories`（`recall()` の戻り値・`recalls` への
永続化、両方の元になる配列）を組み立てる1箇所だけである（`recall-runtime.ts` の
`finalMemories: RecalledMemory[] = keptUnits.flatMap(...)` の中、`score:
toRecalledScore(member.score)`）。

⟹ **ADR 0246 決定1 の逐語「実装上は `hit.similarity * score.total` である」は、内部の
順位付けについては今日も正確である。**ただし、**この式の `score` は、もはや `recall()` の
返り値に現れる `RecalledMemory.score` と同じ形ではない**——返り値の `score` は
`toRecalledScore` を経由した後の `RecalledScore`（`affinityMeasured: false` なら `total`
無し）である。ADR 0246 の逐語自体は書き換えない（採用済み ADR の本文は書き換えない、
`docs/decisions/README.md`）——**この注記が、その逐語と今の実装の対応を補う。**

### 5. 永続化: マイグレーション不要。過去の行は書かれた形のまま読み戻る

[ADR 0155](./0155-recall-score-breakdown-persisted.md) により `ScoreBreakdown`（現
`RecalledScore`）は `recalls.returned_memories`（jsonb）に埋め込まれる。ADR 0282 決定4
が確認したとおり、`packages/postgres/src/mapping.ts` の `rowToRecallRecord` は
zod 検証を通さない単純な cast である（【現物、再確認】）。

⟹ **SQL 側のスキーマ変更は不要。マイグレーションも不要。**

**読み戻しの扱い（今回決めたこと）**: 本 ADR より前に永続化された `association`/
`mandatory_companion` の行は、その `score` の jsonb に `total`（と、当時
`affinityMeasured` フィールドが在れば `affinityMeasured: false`）を**そのまま持っている**。
本 ADR は、**これらの過去の行を後から `AffinityUnmeasuredScore` の形に作り直さない**——
書かれた形をそのまま返す。理由:

- **型の上でも同じ扱いになる。** `RecalledMemory`/`RecallRecordMemory` の zod スキーマは
  `RecalledScoreSchema = z.union([ScoreBreakdownSchema, AffinityUnmeasuredScoreSchema])`
  であり、`z.union` は先頭から順に試して最初に成功したスキーマの結果を返す
  （【実測】下記）。`total` を持つ過去の行は `ScoreBreakdownSchema`（先頭）に**そのまま
  一致する**ので、`total` を持ったまま `ScoreBreakdown` として読み戻る。`total` を
  持たない（本 ADR 以降に書かれた）行は `ScoreBreakdownSchema` の必須欄 `total` を
  満たせず、`AffinityUnmeasuredScoreSchema`（2番目）に一致する。⟹ **union の順序
  そのものが「書かれた形を尊重する」規則を実装している**——追加のコードは要らない。
- **「わからない」を偽って作らない。** 過去の行が実際に `affinityMeasured: false` で
  書かれていたとしても、**当時の `total` の値そのものは変わらない**（ADR 0282 以降・
  本 ADR より前の書き込みは `defaultScoringStrategy` が計算した実際の値を持っている）。
  それを消して `null`/`undefined` に置き換えることは、**既に永続化された実測値を
  破棄する**ことになり、ADR 0008「無いには種類がある」の精神（測ったものを「無い」に
  しない）に反する。**読み戻すときにこの値を見せない理由が無い**——契約
  （ADR 0282: `affinityMeasured: false` の `total` は他の `total` と比較しない）は
  今日も有効であり、値そのものを隠す必要は無い。

⟹ **`getRecall` で古い `association`/`mandatory_companion` の行を読み戻すと、
`total` が「見える」ことがある**（本 ADR 以降の新しい recall では見えない）。
これは引き受けた負債として下に書く。

### 6. 公開 API への影響（破壊的変更の範囲）

`pnpm run build` の後、`pnpm run api:check` は `@mnemora/core` にのみ差分を報告した
（他5パッケージは差分なし。詳細は「測ったこと」節）。差分の内訳:

1. `AffinityUnmeasuredScore`・`AffinityUnmeasuredScoreSchema`・`RecalledScore`・
   `RecalledScoreSchema` の新規追加（非破壊）。
2. `RecalledMemory.score: ScoreBreakdown` → `RecalledScore`（**破壊的**——`total`/
   `similarity`/`lexicalMatch` を無条件に読んでいた呼び出し側は、型の絞り込みが
   要るようになる）。同じ変更が `RecalledMemorySchema`（zod）にも入る。
3. `RecallRecordMemory.score: ScoreBreakdown` → `RecalledScore`（同上。永続化された
   行を読み戻す側に影響する）。
4. `CorrectionCandidate.score`（`correction-candidates.ts`、`Runtime.findCorrectionCandidates`
   の戻り値）: `ScoreBreakdown` → `RecalledScore`（**破壊的**——`RecalledMemory.score`
   をそのまま運ぶ欄なので、2番と同じ変更が連鎖する）。
5. `computeAffinity`（`strategies/consolidate.ts`、`{ seedMemoryId }` 形の `consolidate`/
   `reflect` が使う「似ている」の物差し）: 引数の型が `ScoreBreakdown` → `RecalledScore`
   に変わる（**この関数自体は公開されている**——`pnpm run api:check` の差分に現れる）。
   **値は1バイトも変わらない**——`affinityMeasured === false` を新しい早期 return に
   したが、以前も `similarity`/`lexicalMatch` がどちらも無い候補には `-Infinity` を
   返していた（同じ集合、同じ値）。呼び出し側の型が変わるだけである。

⟹ **2〜5番が破壊的変更の実体である。**「決定7」でこの範囲を `CHANGELOG.md`/
`docs/migration-v1.md` に記録する。

### 7. 既定値は一切変えない

`association` の既定（on、ADR 0337）・`maxCount`・`minSimilarity`・`anchorCount`・
`scoreThreshold`・`overFetchFactor` は1つも変えていない。本 ADR は**返す `score` の形**
だけを変える——**どの記憶が返るか・どの順で返るか・どの記憶が連想枠の席を取るかは
1ビットも変わらない**（決定4）。

---

## 採らなかった案

| 案 | 却下の理由 |
|---|---|
| **判別子を `retrievedVia` にする**（`"ann"`/`"lexical"` なら `ScoreBreakdown`、`"mandatory_companion"`/`"association"` なら `AffinityUnmeasuredScore`） | 決定2 の理由のとおり——今日の実装ではこの2つの分け方は `affinityMeasured` と一致するが、それは `fetchMandatoryCompanions` が `similarity`/`lexicalMatch` を渡さないという実装の**結果**であって、`retrievedVia` という**値そのもの**が意味として持つ規則ではない。将来 `retrievedVia` の値が増える・意味が変わる際に、この対応表を保守し忘れる余地を型の外に残すより、実測の合図（`affinityMeasured`）を直接読むほうが安全である |
| **`total` を `number \| undefined` にするだけ**（型を分けず、`ScoreBreakdown.total` を任意にする） | `docs/migration-v1.md` の数え方・ADR 0178 の基準では、既存の必須フィールドを任意にすることも「読み手側で `number` が `number \| undefined` になる」破壊的変更であり（ADR 0282 が方向2の形bとして既に却下している）、しかも `similarity`/`lexicalMatch` の「無い」の意味（測っていない）と `total` の「無い」の意味（測ったが比較不可能）を1つの `undefined` に混ぜることになり、Issue #548 が求めている「別の形にする」（構造で区別する）を満たさない |
| **`totalComparable?: boolean` のような、比較可能性だけを名乗る第3の欄を足す**（`total` は残す） | ADR 0282 の「採らなかった案」表が同種の案（`totalComparable`という欄名）を却下した理由がそのまま当たる——欄が増えるだけで、Issue #548 の核心（比較できない `total` がそもそも存在してしまう）を消さない。**Issue #548 本文が言う「方向2」はまさに「比較可能な量だけに絞る」ことであり、`total` を残したまま欄を足す形は方向1の変種であって方向2ではない**（ADR 0282 決定4 の分類と同じ） |
| **`v2.0.0` まで待つ**（元の判定どおり） | 「文脈」節のとおり、オーナーの回答（ask_human 6911db12）により、この repo の運用としては `v1.X.0` での破壊的変更が許容されている。待つ理由が無くなった |
| **`AffinityUnmeasuredScore` に `similarity`/`lexicalMatch` を `undefined` として残す**（`total` だけ落とす） | 検討したが採らなかった。`ScoreBreakdown` の `similarity`/`lexicalMatch` は元々任意（`?: number`）であり、`AffinityUnmeasuredScore` にも同じ任意欄を残すと、「値が無い」ことを型でも示せる一方、**構造がほぼ `ScoreBreakdown` と同じになり、2つの型を分ける意味（Issue #548 が求める「別の形」）が薄まる**。加えて、`similarity`/`lexicalMatch` が常に `undefined` になることが`affinityMeasured: false` から既に導けるため、欄自体を持たせる情報量が無い |

---

## 引き受けた負債

1. **独自 `ScoringStrategy` を実装している利用者は、この変更の影響を受けない代わりに、
   `affinityMeasured` を自分で正しく設定する責務を負ったままである**（ADR 0282
   「引き受けた負債」1 がそのまま引き継がれる）。独自戦略が `affinityMeasured: false`
   を返せば、その候補は本 ADR により `total` を失う——ADR 0282 の時点では「値の意味」
   の問題だったが、本 ADR 以降は「型・構造」の問題になる。独自戦略の作者は、この変更を
   認識していなければ、突然 `total` が読めなくなったコンパイルエラーに直面しうる。
2. **本 ADR より前に永続化された `association`/`mandatory_companion` の行は、
   `getRecall` で読み戻すと `total` を持ったままである**（決定5）。**新規の recall
   と、読み戻した過去の recall とで、同じ `retrievedVia`/`affinityMeasured: false`
   の記憶でも `score` の形が違う**——呼び出し側が `getRecall` の結果を型で判別する際、
   この非対称を意識しないと「今日はこの記憶に `total` が無いはずなのに、なぜか古い
   recall では在る」という混乱を招きうる。ドキュメント（`RecallRecordMemory.score`
   の doc コメント）で明記したが、実行時に検知する仕組みは無い。
3. **`CorrectionCandidate.score`・`computeAffinity` の型変更は、この ADR の主目的
   （Issue #548）の直接の対象ではなく、`RecalledMemory.score` の変更が連鎖しただけの
   副作用である。**個別に「本当に必要か」を検討していない——`RecalledMemory.score` を
   経由する以上、型としては避けられない連鎖だが、影響範囲の広さそのものは実測していない
   （下の「確かめていないこと」）。
4. **`examples/chat` の多くのファイルが、この変更を機に「握り潰さず投げる」
   （`requireMeasuredTotal`/`assertAffinityMeasured`）と「無いものとして扱う」
   （`scoreTotalOrNull`）の2つの方針を使い分けている。**どちらを選ぶかは、その呼び出しが
   `association: null` を渡しているか（前者が妥当）、既定の呼び出し（association 既定
   on。後者が妥当）かで決めたが、**この判断基準自体は本 ADR が新設したものであり、
   `examples/chat` 側の既存の設計原則として文書化されていない。**

---

## これが覆るとしたら

1. **オーナーが「ask_human 6911db12 の回答はこの変更を指していなかった」「`v2.0.0` を
   切ってからにすべきだった」と判断したとき** —— 本 ADR は無効になり、方向2の実装を
   `v2.0.0` まで差し戻すか、この ADR ごと revert することになる。
2. **独自 `ScoringStrategy` の利用実績が実際に見つかり、`affinityMeasured` の扱いを
   誤って壊れた実例が出たとき**（引き受けた負債1） —— `ScoringStrategy` の契約文書を
   強化するか、`affinityMeasured` の既定値（省略時の扱い）を再検討することになる。
3. **過去の recall 行の読み戻しで `total` が見えたり見えなかったりする非対称
   （引き受けた負債2）が、実際に呼び出し側を混乱させた実例が出たとき** —— 過去の行を
   後方互換のために書き換えるマイグレーション（ADR 0155 の追記が要る）を検討することになる。
4. **判別子を `affinityMeasured` から別の形（例: 3値の enum、`totalComparable`
   のような直接的な名前）に変えたほうがよい、という実装上の知見が積み上がったとき**
   —— 決定1・2 を再検討する別の ADR が要る（本 ADR 単独では覆らない——`AffinityUnmeasuredScore`
   という型名・`affinityMeasured` という判別子は、ADR 0282 が既に選んだ語彙をそのまま
   引き継いだものであり、変えるなら ADR 0282 の語彙選択そのものを問い直すことになる）。

---

## 測ったこと

### 【実測】赤（実装前。association の score から total を落とす前）

`packages/core` の `defaultScoringStrategy`/`recall-runtime.ts` は、この ADR 以前は
`RecalledMemory.score` を常に `ScoreBreakdown`（`total` あり）として返していた——
この形を変えたことで、`packages/core`・`packages/postgres`・`examples/chat` の全体で
**35箇所のコンパイルエラー**（`Property 'total'/'similarity'/'lexicalMatch' does not
exist on type 'RecalledScore'` など）が出た。内訳は「測ったこと」の実装ログを参照
（`packages/core` 本体2ファイル、`packages/core` のテスト4ファイル、`packages/postgres`
のテスト1ファイル、`examples/chat` の本体ソース9ファイル、`examples/chat` のテスト5ファイル）。
これは「既存の呼び出し側が、絞り込み無しに `total`/`similarity`/`lexicalMatch` を
読んでいた」ことの実測であり、決定6 が挙げた破壊的変更の範囲と一致する。

### 【実測】緑（実装後）

```
$ pnpm run typecheck   # 8 workspace すべて Done
$ pnpm run lint        # エラー0
$ pnpm run format:check  # 全ファイル prettier 準拠
$ pnpm run build       # 8 workspace すべて Done
```

`packages/core` のテスト（DB 不要）: **Test Files 154 passed (154) / Tests 2051 passed
| 85 expected fail (2136)**。
`packages/testkit` のテスト（DB 不要）: **Test Files 67 passed (67) / Tests 1691 passed
| 13 skipped (1704)**。
`examples/chat` のテスト（DB 不要な分。`*.postgres.test.ts` を除く）: 90 ファイル中
DB を要さないものはすべて緑（DB を要する30ファイルは `DATABASE_URL` 未設定で
「実行していない」という失敗——本物の Postgres を立てた後の実測は下の追記を見ること）。

### 【実測】公開 API スナップショット

`pnpm run build` の後、`pnpm run api:check` は `@mnemora/core` にのみ差分を報告した
（他5パッケージは差分なし）。差分の要約は決定6 のとおり——追加4件（`AffinityUnmeasuredScore`
本体・schema、`RecalledScore`・schema）、既存3箇所の型変更（`RecalledMemory.score`・
`RecallRecordMemory.score`・`CorrectionCandidate.score`）、既存1箇所の引数型変更
（`computeAffinity`）。`pnpm run api:write` で snapshot を更新し、`pnpm run api:check`
が緑に戻ることを確認した。

### 【実測】`packages/core` の変異試験（`cp` で退避・復元。`git checkout` は使っていない）

変異試験の詳細な表は、この ADR を実装した PR の本文・報告に記録する（この ADR 自身は
「どの歯が対象か」までを記録し、実行ログの全文は複製しない——`AGENTS.md`「⚠ 数を、
道具と生成物に焼き込まない」と同じ理由）。狙った変異と対象の歯:

1. **足りない変換**（`toRecalledScore` の `affinityMeasured !== false` 分岐を外し、
   常に `score` をそのまま返す）—— `recall-association.test.ts`
   「連想で拾った候補にも…」の `expect(assocEntry?.score).not.toHaveProperty("total")`
   が赤くなることを確認。
2. **やりすぎの変換**（`toRecalledScore` を常に `AffinityUnmeasuredScore` の形に
   変換する）—— `recall-channels.test.ts` の `assertAffinityMeasured` を通す複数の歯
   （ann/lexical 経由で `total`/`similarity`/`lexicalMatch` を読む歯）が
   `assertAffinityMeasured` の例外で赤くなることを確認。
3. **mandatory_companion の取りこぼし**（`toRecalledScore` の判定を
   `retrievedVia === "association"` だけにする——`mandatory_companion` を見落とす形）
   —— `recall-association-contested-companion.test.ts`（PR #970 の歯）の一部と、
   `recall-invariant-fuzz-harness.ts` の I5 チェック（`mandatory_companion` の
   `score` にまだ `total` が残ることを検出）が赤くなることを確認。
4. **内部順位の変更**（`compareScoredCandidates`/段3.5 の `rankKey` の計算対象を、
   変換後の `RecalledScore` に差し替える——内部表現を壊す形）——型エラーで
   即座に検出される（`RecalledScore` には `total` が無条件には存在しないため、
   `a.score.total` のような式がコンパイルできない）。**これは実行時の変異試験ではなく
   コンパイル時に落ちる**——決定4 が「内部表現は `ScoreBreakdown` のまま」とした設計
   そのものが、この種の退行を型で防いでいる。

いずれも `cp` で退避したファイルへ戻し、同じ歯が緑に戻ることを確認した。

### 【実測】Postgres

（このセクションは、本物の Postgres を立てて `packages/postgres`/`examples/chat` の
DB テストを実行した後に追記する。）

---

## 確かめていないこと

1. 🔴 **`ask_human 6911db12` の記録そのものを、この repo の中・GitHub 上のどこにも
   見つけられていない**（「文脈」節）。マネージャーから受け取った逐語を、そのまま
   引用しているだけである——この回答が実在すること自体は、この ADR の書き手が
   独立に検算していない。
2. **独自 `ScoringStrategy` を実装している利用者が実際にどれだけ存在し、この変更で
   何人が影響を受けるかは測っていない**（引き受けた負債1と同じ射程）。
3. **本物の Postgres に対する DB テスト**（`packages/postgres run test:db`・
   `examples/chat run test:db`）は、この ADR を書いた時点ではまだ実行していない
   ——上の「測ったこと」の Postgres 節に追記する。
4. **`examples/chat` のベンチの実測値（`compare`/`retrieval-quality` 等の数値）が、
   この変更で動くかどうかは測っていない。**型を通すための変更（`requireMeasuredTotal`/
   `scoreTotalOrNull` による分岐）は、`association: null` を渡す既存の呼び出しの
   挙動を変えないはずだが（`scoreTotalOrNull`/`requireMeasuredTotal` はどちらも
   `affinityMeasured !== false` のときは元の `total` をそのまま返す）、実際にベンチを
   走らせて数値が一致することは確認していない。
5. **`packages/bullmq`/`packages/openai`/`packages/anthropic`/`packages/local-embedding`
   のテストは実行したが、これらのパッケージが `RecalledScore`/`AffinityUnmeasuredScore`
   を直接参照するコードを持つかは深く調べていない**（`api:check` の差分が0件だった
   ことから、公開 API の面では影響が無いと判断しているが、内部実装での参照の有無までは
   確認していない）。

---

## 参照

- [Issue #548](https://github.com/takecchi/mnemora/issues/548) — 本 ADR が閉じる Issue
- [ADR 0282](./0282-score-breakdown-affinity-measured.md) — 方向1（非破壊）。
  `affinityMeasured` という語彙・欄名の出所
- [ADR 0246](./0246-association-rank-includes-decay.md) — 連想枠の順位キー
  （`similarity × score.total`）。決定4 の注記が、この ADR の逐語と今の実装の対応を補う
- [ADR 0151](./0151-recall-association-unprompted.md) — アンカー類似度を
  `score.similarity` に入れない、という決定。本 ADR はこれを覆さない
- [ADR 0155](./0155-recall-score-breakdown-persisted.md) — `ScoreBreakdown` の永続化。
  決定5 の根拠
- [ADR 0155](./0155-recall-score-breakdown-persisted.md) / [ADR 0008](./0008-absence-taxonomy.md) —
  「無いには種類がある」。決定5 が過去の行を作り直さない理由の考え方の族
- [ADR 0337](./0337-recall-association-default-on.md) — 連想枠の既定 on。
  `ask_human` を逐語で引く先例の形式
- [ADR 0178](./0178-public-api-surface-gate.md) — 公開 API 破壊性の数え方の基準
- [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md) — 破壊的変更の委譲
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) —
  本 ADR の決定が自動化された担い手のものであることの根拠
- `docs/migration-v1.md` — 破壊的変更の数え方・一覧（本 ADR の変更を項目として追加する）
- `CHANGELOG.md` `[1.1.0]` 節 — 本 ADR の変更を `### Breaking` として記録する
