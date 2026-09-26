# ADR 0203: `result.memories` と `result.omitted` の排他性を契約にする — 段3.5 が昇格させた記憶を `below_threshold` から取り下げる（Issue #421）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0172 / 0173 / 0188 の体裁を踏む）。

- **【現物】** — この repo のコード・文書・git 履歴を、書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`tsc`/`eslint`/`prettier` を走らせて確かめた。
- **【受】** — [Issue #421](https://github.com/takecchi/mnemora/issues/421) 本文の実測報告として受け取り、
  その数値自体は自分でも `packages/core` の fake ストアで独立に再現した（下記「測ったこと」参照）。

---

## 結論（先に）

**`RecallQuery.association`（段3.5、[ADR 0151](./0151-recall-association-unprompted.md)）を on にすると、
段2が `below_threshold` として `result.omitted` へ確定させた記憶が、段3.5 を経由して
`result.memories` にも `retrievedVia: "association"` として現れることがある。** 同じ memoryId が
`memories` と `omitted` の両方に載る——「返したものについて『落ちた』と名乗る」。

**この排他性は、どの ADR も明示的に決めていなかった**（Issue #421 が ADR 0008 / 0044 / 0151 / 0172 を
確認し、確かに無いと述べている）。一方 `docs/recall.md` §1 の `RecallResult.omitted` の doc は
逐語で「返らなかったものの分類」と書いており、実際の挙動と食い違っていた。

**本 ADR が決めること**: `omitted` は「返さなかった記憶の集合」であると契約として定め、
段3.5（および構造的には段3の必須同伴取得）が `finalMemories`（実際に返す集合）へ昇格させた
記憶を、`below_threshold` の `count`/`nearMisses` から取り下げる。**連想枠の除外集合は変えない**
——`below_threshold` を連想の候補プールから外すと、連想枠の獲物の大半を失う
（Issue #421 の実測: 連想枠 on の返却の47.5%がこの範囲）。取り下げは、段2の確定を
書き換えるのではなく、**段4（予算による切り詰め）まで終わって実際に返す集合が確定した後の、
分類と実際の突き合わせ**として行う。

**`RecallQuery.association` の既定値（off）はこの ADR では変えない**——#386 / #337 で
「既定 off のまま v1.0.0 を出す」が決着している。既定 off である限り、段3.5 自体が
走らないので本 ADR の変更は1バイトも挙動に影響しない。

---

## 1. 【現物・実測】何が起きていたか

`packages/core` の fake ストア上で、Issue #421 が挙げた形をそのまま再現した
（`packages/core/src/__tests__/recall-association.test.ts` の既存フィクスチャと同じ構成——
クエリ `[1,0]`、アンカー `[0.7071,0.7071]`、連想候補 `[0,1]`）。

```ts
const result = await runtime.recall(ctx, {
  vector: [1, 0],
  association: { maxCount: 5, anchorCount: 1 },
});
```

修正前の実際の出力（陽性対照。テストコードは「測ったこと」節に転記）:

```
memories: [ { id: 'mem-1', via: 'ann' }, { id: 'mem-2', via: 'association' } ]
omitted: [
  {
    "kind": "below_threshold",
    "count": 1,
    "countKind": "exact",
    "nearMisses": [ { "memoryId": "mem-2", "score": 0 } ]
  }
]
```

**`mem-2` が `memories`（`retrievedVia: "association"`）と `omitted[0].nearMisses`
（`below_threshold`）の両方に載っている。** 同じ `recall()` 呼び出しの、同じ `RecallResult` の中である。

### なぜそうなるか

1. 段2（`recall-runtime.ts` の `partitionByThreshold` 呼び出し直後）が、閾値未満の候補を
   `below_threshold` の `Omission` として確定させる（`docs/recall.md` §3「段2で確定し、
   以降は積み上げるだけ。最後に集計し直さない」）。
2. 段3.5（連想、`:1042` 以降）が候補を足し直すのはその**後**であり、除外集合
   （`withinLimit` + `companions` + アンカー自身）は `below_threshold` を含まない
   （`:1096` 付近）。
3. ⟹ 段3.5 は「段2が落ちたと確定させた記憶」を拾い直せる。**これ自体は意図した挙動**
   ——段2で落ちた記憶こそが連想枠の主な獲物であり（Issue #421・#402 の実測: 連想枠 on の
   返却の47.5%がこの範囲）、除外すると連想枠の意味がほぼ無くなる。
4. だが誰も段2の `below_threshold` の宣言を取り下げない。⟹ 「落ちた」という宣言と
   「実際には返した」という事実が、同じ `RecallResult` の中で両立する。

### 破れていないもの（Issue #421 が切り分け済み。本 ADR もこれを引き継ぐ）

- 段2の三分割（`scored = passed + below_threshold + score_not_comparable`、ADR 0044）は
  破れていない。段2の中では正しい。
- `filtered`/`decayed` の二重計上は起きていない（`recall-runtime.ts:1228` 付近のコメントが
  「集約が数えるのは集合の大きさであって、どの段が落としたかではない」と明記）。
- 忘却ゲート（ADR 0172）も破れていない。

**破れているのは `memories` と `omitted` の排他性、その1点だけである。**

---

## 2. 北極星の5つの問いに実際に当てた結果

| 問い | この判断にどう当たったか | 落ちた案 |
| --- | --- | --- |
| **1**（毎回渡す量を減らす方向に働くか） | `omitted` の該当エントリが縮む（または消える）だけで、`memories` の量は1バイトも変わらない。 | — |
| **2**（無効にしても成立するか） | `association` を渡さない呼び出しでは `promotedFromBelowThreshold` は常に空集合になる（`finalMemories` と `belowThreshold` の交差が構造的に生じない）。⟹ 挙動は1バイトも変わらない。**「§9.6 これが無くても成立する」の性質をそのまま保つ**。 | — |
| **3**（選ばれた理由を後から説明できるか） | **これが本題**——「そもそも below_threshold ではなかった」のか「below_threshold だったが返した」のかを、`omitted` の中身自体からは区別できなくなる（取り下げた痕跡を残さない）。この負債は「採らなかった案」2番で検討し、引き受けた（下記「引き受けた負債」1番）。 | `Omission` に「昇格した」ことを示す新しい札を足す案（§3「採らなかった案」2番）。 |
| **4**（推論と事実を区別しているか） | 該当しない——`finalMemories` と `belowThreshold` はどちらも同じ実行の中で既に確定した JS 側の値であり、推論（LLM 等）を経由しない。 | — |
| **5**（LLM を呼ばずに済ませられないか） | 既存の配列に対する `Set` の構築とフィルタだけ。DB 往復も LLM 呼び出しも増えない。 | — |

---

## 3. 決めたこと

1. **`omitted` を「返さなかった記憶の集合」と契約として定める。** `RecallResult.omitted` の
   doc（`packages/core/src/recall.ts`）と `docs/recall.md` §1 に、この契約を明文化する
   （「決める必要があること」3番の逆——排他性を「持たない」と明示するのではなく、
   「持つ」と決めて実装を合わせる）。

2. **段2・段4がすべて終わり `finalMemories`（実際に返す集合）が確定した直後に、
   `below_threshold` の `Omission` を `finalMemories` と突き合わせて取り下げる。**
   場所は `recall-runtime.ts` の `finalMemories` 構築の直後——`associationChars`
   （連想の usage 集計）より前。段2の確定を書き換えるのではなく、**後処理**として
   実装する（`docs/recall.md` §3「最後に集計し直す構造にはしない」という規約と
   正面から当たらないための選択——ここでやっているのは「三分割をもう一度数え直す」
   ことではなく、「確定した分類 1件を、実際に返した集合という既に確定した別の値と
   突き合わせる」ことである）。

3. **対象は `below_threshold` だけにする。** `Omission` の11種のうち、memoryId を
   明示的に持つのは `BelowThresholdOmission.nearMisses` だけである
   （`recall.ts` の各 interface を実際に読んで確認した——他の10種は `count`/`countKind`
   と、種別ごとの分類キー（`condition`/`reason`/`stage` 等）しか持たない）。
   ⟹ 「同じ memoryId が両方に載る」という**個体単位で検証可能な**矛盾を作れるのは
   `below_threshold` だけであり、本 PR の直す範囲もそこに絞る。他の kind
   （`over_limit`/`budget_dropped`/`score_not_comparable` 等）で同種の昇格が
   起きても、それは「件数の内訳が怪しい」という弱い形の問題にしかならず、
   Issue #421 も実測していない（「引き受けた負債」2番）。

4. **連想の除外集合（`recall-runtime.ts:1096` 付近）は変えない。** `below_threshold` を
   除外集合に足す案（「決める必要があること」2番）は採らない——連想枠の獲物の大半
   （47.5%、Issue #421・#402 の実測）を失うため、連想枠の意味がほぼ無くなる。

5. **`count` は「昇格した件数」ぶん正確に減らす。** `belowThreshold`（段2の partition が
   持つ全件、`nearMisses` の上位5件サンプルより広い）を突き合わせの基準にする——
   `nearMisses` だけを基準にすると、`nearMisses` に載らなかった6件目以降が昇格した
   場合に `count` が過大なまま残る。**全件昇格した場合は `below_threshold` の
   `Omission` 自体を配列から取り除く**——他の kind が `count === 0` では push しない
   作法（`filtered`/`over_limit` 等）に揃える。

6. **`RecallQuery.association` の既定値は変えない（off のまま）。** #386 / #337 の決着
   （既定 off のまま v1.0.0 を出す）に触れない。

---

## 採らなかった案

1. **段2の `below_threshold` を段3.5の後まで確定させない（パイプラインの最後に
   まとめて集計する）。** **却下**——`docs/recall.md` §3 が明示的に禁じている構造
   （「パイプラインの最後に『結局何が何件落ちたか』を集計し直す構造にはしない
   ——集計し直す設計は、集計ロジックが実装と乖離した瞬間に `omitted` が嘘をつき
   始める」）。本 ADR の実装は「段2の確定を段3.5の後まで遅らせる」のではなく、
   「段2の確定はそのまま行い、実際に返した集合との差分だけを後から引く」——
   確定のタイミングは変えていない。

2. **`Omission` に「一度落ちたが後で返った」ことを示す新しい情報を残す**
   （例: `below_threshold.promoted: MemoryId[]` を足す、または `RecalledMemory` に
   `wasOmitted: boolean` を足す）。**却下**——北極星の問い3（選ばれた理由を説明できるか）
   には却って強く応えるが、**この PR の射程を超える**。Issue #421 が明示的に
   「決める必要があること」として3案を挙げ「どれを選ぶかはこの issue では決めない」と
   書いた上で、着手コメントは「`omitted` から取り除く形」を推奨として明示した——
   新しい情報を足す設計は、その推奨よりも一段重い決定（型を増やす）であり、
   `docs/roadmap.md` §5 を通す判断に近い。**この却下は「引き受けた負債」1番として
   明示する**——将来、呼び手から「なぜこの記憶が返ったのか、below_threshold
   だったのに」という問い合わせが実際に増えたら、この案を再検討すべきである。

3. **`omitted` の文言を「返らなかったものの分類」から「返らなかった、または段3.5で
   後から返ったものの分類」のように緩め、排他性を契約に**しない**（Issue #421
   「決める必要があること」3番）。** **却下**——`docs/north-star.md` 項目6
   「知らないことを、知らないと言える」の趣旨に反する。呼び手が `memories` と
   `omitted` を足し合わせて母集団を数えている場合、排他性が無いと二重計上になる。
   排他性を「無い」と明示するより、**実際に排他にする**ほうが呼び手の負担が小さい。

4. **`over_limit`/`budget_dropped`/`score_not_comparable` 等、memoryId を持たない
   Omission にも同様の後処理を試みる**（例: 昇格した件数を推定して `count` から
   減らす）。**却下**——これらの kind は「どの記憶が昇格したか」を個体で特定できず、
   `count` を減らす根拠（どの候補が段3.5 の候補プールに実際に含まれ得たか）を
   正確に再現するには、段2・段3.5 双方の内部状態を余分に持ち回る必要があり、
   実装が「決めたこと」3番の判断（個体単位で検証可能な矛盾だけを直す）を
   超えて肥大化する。Issue #421 自身もこれらの kind での発生を実測していない。

---

## 誰が壊れうるか / 引き受けた負債

1. **昇格の痕跡が消える。** `below_threshold` から取り下げられた記憶は、`omitted` から
   見て「そもそも below_threshold ではなかった」場合と区別がつかなくなる。呼び手が
   「なぜこの記憶が閾値未満なのに返ったのか」を `RecallResult` だけから読み取ることは
   できない（`RecalledMemory.retrievedVia: "association"` と `associationOf` から
   「連想枠が拾った」ことは分かるが、「段2では below_threshold だった」ことまでは
   分からない）。「採らなかった案」2番で検討し、コストに見合わないと判断して
   引き受けた。
2. **`below_threshold` 以外の kind（`over_limit`/`budget_dropped`/`score_not_comparable`
   等）で同種の昇格が起きても、この PR は直さない。** 具体的には、段2で `passed` した
   が `limit` を超えて `over_limit(stage:"rescore")` に計上された候補
   （`passed.slice(limit)`）は、連想の除外集合に含まれていない
   （除外集合は `withinLimit` + `companions` + アンカー自身であり、`overLimit` を
   含まない）。⟹ 理論上、段3.5 がこの候補を拾い直すことも構造的にあり得るが、
   `OverLimitOmission` は memoryId を持たないため「同じ memoryId が両方に載る」形の
   矛盾としては検証できず、本 PR は実測もしていない。
3. **段3（必須の同伴取得）が同種の昇格を起こす経路は、構造的には本 PR の後処理で
   救われるが、実測していない。** 争われている記憶の同伴（`contestedWithId`）が
   偶然 `belowThreshold` に居た場合、`companions` 経由で `finalMemories` に入り、
   本 PR の後処理（`finalMemories` 全体との突き合わせ）はこの経路も等しく処理する
   ——コードはどの段が昇格させたかを区別せず、`finalMemories` に実際に載っているか
   どうかだけを見る。だが Issue #421 はこの経路を測っておらず、本 ADR もこの経路に
   限定した歯を置いていない。

## これが覆るとしたら

1. **呼び手から「なぜ below_threshold だった記憶が返ったのか分からない」という
   問い合わせが実際に増えたとき**——「採らなかった案」2番（`promoted` 情報を残す）を
   再検討する。
2. **`association` の既定が on になったとき**（PR #386 が進行中）——本 ADR の
   取り下げ処理は既定経路で常に走るようになる。処理自体は「無効にしても成立する」
   （北極星の問い2）ため挙動に懸念は無いはずだが、`finalMemories` と `belowThreshold`
   の交差判定（`Set` の構築とフィルタ）の計算量が既定経路の一部になる——
   `belowThreshold` は通常小さい（段2の候補全体からの部分集合）ため軽いと見込むが、
   実測はしていない。
3. **`over_limit(stage:"rescore")` や段3の同伴取得で、同じ形の「返したのに落ちたと
   名乗る」矛盾が実際に観測されたとき**——「引き受けた負債」2番・3番の対象を
   本 ADR と同じ設計（`finalMemories` との突き合わせ）で広げる。ただし memoryId を
   持たない kind については、まず `Omission` の型自体に memoryId のサンプルを
   持たせる拡張（`below_threshold.nearMisses` に倣う）が前提になる。

---

## 測ったこと

- 【実測】陽性対照（修正前）: `packages/core` の fake ストア上で、`association` を
  on にした recall を1回実行し、`result.memories` の `mem-2`
  （`retrievedVia: "association"`）が同時に `result.omitted[0].nearMisses`
  （`below_threshold`）にも現れることを、`console.log` の実際の出力で確認した
  （上記「1. 何が起きていたか」に出力を転記）。
- 【実測】修正後、同じ入力に対し `result.omitted` が `[]` になり（below_threshold の
  対象がこの1件だけだったため Omission 自体が配列から消えた）、`result.memories` は
  `mem-2` を `retrievedVia: "association"` のまま返し続けることを確認した。
- 【実測】`packages/core/src/__tests__/recall-association.test.ts` に恒久的な歯を
  2本追加し、緑であることを確認した:
  1. 「段2で below_threshold として落ちた記憶が連想で丸ごと昇格すると、
     below_threshold の omission 自体が消える」
  2. 「below_threshold の一部だけが連想で昇格したときは、残りだけが omitted に残る
     （count / nearMisses とも）」——2件の below_threshold 候補のうち1件だけが
     連想で昇格する構成で、`count` が2→1に減り、`nearMisses` から昇格した側だけが
     消えることを確認した（全件削除ではなく部分フィルタが効いていることの証明）。
- 【実測】変異試験: `recall-runtime.ts` の取り下げブロック（`returnedMemoryIds` の
  構築から `omitted.splice`/代入までの約50行）を丸ごと除去し、上記2本の歯が
  実際に赤くなることを確認した（1本目: `expect(...).toBe(false)` が
  `true` を受け取り失敗、2本目: `expect(belowThreshold.count).toBe(1)` が `2` を
  受け取り失敗）。他8本の既存の歯は影響を受けず緑のままだった。除去した内容は
  `cp` で退避したファイルから `cp` で復元し、`git status --porcelain` が空になる
  ことを確認したうえで、同じ2本の歯が緑に戻ることを確認した。
- 【実測】`pnpm --filter @mnemora/core run typecheck`: 緑。
- 【実測】`pnpm run lint`（eslint、全体）: 緑、警告0。
- 【実測】`pnpm run format:check`（prettier、全体）: 緑。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-association.test.ts src/__tests__/recall.test.ts
  src/__tests__/recall-pipeline.test.ts`: 3ファイル・149件すべて緑
  （既存の `below_threshold`/連想枠の歯を含め、回帰は無い）。

## 確かめていないこと

- **手元の6つの門のうち `test`（DB 込み）・`build`・`pack:check` は走らせていない。**
  `docs/autonomy.md` §2 の方針（「確かめる場所は CI である」）に従い、CI の緑で見届ける。
- **実運用での発生頻度。** Issue #421 が実測した47.5%という数字は「順位の窓」
  （#402）から借りたものであり、「取り下げが実際に何件発生するか」はこの ADR でも
  再測していない。
- **`over_limit(stage:"rescore")`/段3の必須同伴取得 経由の同種の矛盾が実在するか。**
  「引き受けた負債」2番・3番のとおり、構造的にあり得ることは分かるが、実測していない。
- **`decayClock: 'activity'`/`'either'` 経路での挙動。** Issue #421 の元の実測が
  既定の壁時計だけを見ており、本 ADR もそこに追随した——`finalMemories` との
  突き合わせは decay clock に依存しないロジックのはずだが、明示的に確認していない。
- **CI（`typecheck`/`lint`/`test`/`build` の4 required job）の実際の結果。**
  PR 本文に、この ADR を書いた後に取得した sha 付きの実測を記載する。

Refs #421

---

## 2026-09-26 追記（クローン miku、Issue #823）

**「これが覆るとしたら」3番が観測条件として挙げていた経路——`over_limit(stage:"rescore")`
の候補が段3（必須の同伴取得）を経由して昇格する——は、この日付で解消した。**
[Issue #823](https://github.com/takecchi/mnemora/issues/823) が、枝
`fix/omitted-over-limit-promotion`（commit `aa4c873`）の陽性対照テストでこの経路を
実際に起こし、`packages/core/src/recall-runtime.ts` の `runRecall` に below_threshold
と同型の取り下げ処理を追加して塞いだ。

解消した経路は、「引き受けた負債」2番（below_threshold 以外の kind で同種の昇格が
起きても本 PR は直さない、という一般的な留保。具体例として段3.5 経由の
`over_limit(stage:"rescore")` 昇格を挙げていた）の対象に入るが、同項が具体例として
挙げていた段3.5（連想）経由の昇格ではなく、**段3（必須の同伴取得）経由の昇格**という、
同項が具体例としては挙げていなかった経路である。「引き受けた負債」2番が名指しした
段3.5 経由の昇格は未解消のまま残る（[Issue #925](https://github.com/takecchi/mnemora/issues/925)、
下の「残り」節を参照）。

「引き受けた負債」3番（below_threshold + 段3）自体は、この PR のコードでは何も
変えていない——ADR 0203 採用時点の既存の取り下げ処理がそのまま処理する設計になって
おり、コードの欠陥ではなく実測していないという**測定の欠落**だった。
`recall-over-limit-promotion.test.ts` の3本目の歯（below_threshold から段3経由で
昇格するケースを実際に組んだもの）が、この経路が既存の設計どおりに正しく処理される
ことを実測で確認した——3番はコードではなく測定として、この Issue #823 の副産物で
埋まった。

**「これが覆るとしたら」3番が前提に置いていた型の拡張は、置かなかった。** 同項は
「memoryId を持たない kind は、先に `Omission` の型に memoryId のサンプルを持たせる
拡張が前提になる」と書いていたが、これは `over_limit(stage:"rescore")` には
当てはまらなかった——`runRecall` は段2で `overLimit`（`passed.slice(limit)` の結果、
`ScoredCandidate[]`）を関数内部のローカル値として構築しており、段3（必須の同伴取得）の
結果（`finalMemories`）が確定するところまで、この値は生きたまま保持されている。
⟹ 「どの記憶が昇格したか個体で特定できない」という「これが覆るとしたら」3番の前提は、
`Omission` という**公開型**についてだけ成り立つ話であり、`runRecall` 内部の
**未公開の状態**には最初から当たらなかった。公開型を1バイトも広げずに、
`overLimit` と `finalMemories` を memoryId で突き合わせるだけで、below_threshold と
同じ形の後処理を書けた。

**差し引く数の取り方**: 「段3で返した同伴の総数」ではなく、「`overLimit` に居て、かつ
段3の必須同伴取得（`companions`、`retrievedVia: "mandatory_companion"`）で実際に
`finalMemories` に返った id の数」に絞った。当初の実装案は前者（`finalMemories` 全体
との突き合わせだけ）で below_threshold 側とコードを共有しようとしたが、これだと
companion が最初から `withinLimit` に居た場合や、companion が `over_limit` ではなく
`below_threshold` から昇格した場合まで数えてしまい、無関係な `over_limit(stage:"rescore")`
の count を誤って減らす（過剰実装）。`recall-over-limit-promotion.test.ts` の3本目の歯
（below_threshold 経由の昇格と、無関係な over_limit のバイスタンダーを同時に置く構成）が、
変異試験でこの過剰実装を実際に赤で捕まえた。

同様の理由で、**段3.5（連想、既定 on、ADR 0337）が同じ `overLimit` の候補を独立に
`finalMemories` へ昇格させる経路は対象に含めなかった**——今回の後処理は
`companions`（段3が構築した配列）に居るかどうかで判定しており、段3.5 経由の昇格は
`companions` に現れない。含めると `over_limit(stage:"rescore")` と
`over_limit(stage:"association")` の両方に跨る昇格の勘定が混ざり、
`omission-kind-generation.test.ts` の既存の歯（`over_limit(stage:"rescore")` が
単独で発生することを確認する歯）を壊すことも実測で確認した——一度この形で広げてから
気づいた回帰であり、`companions` 限定に絞り直して塞いだ。

### 採らなかった案

1. **`OverLimitOmission` に任意の memoryId サンプル欄を足す**（「これが覆るとしたら」3番
   が前提に置いていた案そのもの）。**却下**——上のとおり、この段には型を広げる前提が
   そもそも当たらなかった。加えて、公開型への欄追加は一度出すと戻しにくい
   （`docs/autonomy.md` の一般的な注意）。今回はそれをせずに済んだ。
2. **段3の必須同伴取得が `over_limit` に回った候補を companion として取らない**
   （Issue #823 本文が挙げていた候補3）。**却下**——ADR 0043/0136 の「争われている主張を
   単独で出さない」と衝突する。companion を候補から外すと、owner ごと
   `unit_assembly_dropped` に落ちるなど、`memories` に**実際に返る集合**が変わる。
   本 PR の制約（`memories` は変えない、`omitted` の数え方だけを直す）と両立しない。
3. **段3.5 経由の昇格・`over_limit(stage:"association")` も同じ形で広げる。**
   **今回は見送った**（上の「壊した回帰」参照）。`companions` に限定した判定は
   `over_limit(stage:"association")` 側の内部状態（連想候補の追跡）をそのまま
   使い回せる保証が無く、別途の設計判断が要る——本 PR の射程は Issue #823 が実測した
   `over_limit(stage:"rescore")` + 段3の経路だけに絞った。

### 「引き受けた負債」・「これが覆るとしたら」の残り

- **`over_limit(stage:"association")`/`budget_dropped`/`score_not_comparable` 等、
  段2の内部状態自体が memoryId を持ち回っていない他の kind についての前提**
  （「これが覆るとしたら」3番の「型の拡張が先」）は、そのまま残っている。
  これらの kind は `runRecall` 内部でも候補を memoryId 付きで保持していないため、
  今回と同じ手は使えない。
- **「引き受けた負債」2番が名指しした経路——段3.5（連想）経由で
  `over_limit(stage:"rescore")` の候補が昇格する経路——は、今回もあえて塞がなかった。**
  「採らなかった案」3番のとおり、今回は `companions`（段3限定）に絞ったため、この経路は
  まだ残っている。**「未実測」ではない**——実装の途中でこの経路を塞ごうとして
  `finalMemories` 全体との突き合わせに広げたところ、`omission-kind-generation.test.ts`
  の既存の歯が実際に赤くなった（連想が既定 on のため、`over_limit(stage:"rescore")` の
  候補が段3.5 経由で `retrievedVia: "association"` として昇格し、無関係なはずの
  `over_limit(stage:"rescore")` の Omission が誤って消えた）。⟹ **この経路は既定 on の
  連想の下で実際に起こりうることを、回帰として実測で確認している。**「引き受けた負債」
  2番は今回も未解消のまま残る。**この経路は [Issue #925](https://github.com/takecchi/mnemora/issues/925)
  として別途起票した**（再現の形・実測した出力・直し方の候補を記載。決めていない）。

### 測ったこと

- 【実測】陽性対照（修正前、fake ストア）: `recall-over-limit-promotion.test.ts` の
  1本目・2本目が赤になることを確認した——1本目は `over_limit(stage:"rescore")` の
  Omission が消えるはずが `{ count: 1, ... }` のまま残る、2本目は `count` が
  `2` のまま `1` に減らない。3本目（過剰実装を捕まえる歯）は、この時点ではまだ
  正しい実装が無いため素通りで緑だった（対象の count がそもそも動かないため）。
- 【実測】修正後、同じ3本がすべて緑になることを確認した。
- 【実測】変異試験:
  (a) 追加した取り下げブロックを丸ごと除去 → 1本目・2本目が実際に赤になることを
      確認した（1本目: `over_limit` が `undefined` になるはずが定義されたまま、
      2本目: `count` が `1` になるはずが `2` のまま）。
  (b) 差し引く数を「`overLimit` に居たか問わず、段3で返した同伴（`companions`）の
      総数」に変える過剰実装 → 3本目（below_threshold 経由の昇格と無関係な
      over_limit のバイスタンダーを同時に置く歯）が実際に赤になることを確認した
      （`over_limit(stage:"rescore")` が消えるはずが `count: 1` のまま残るべきところ、
      誤って消えた）。1本目・2本目はこの過剰実装でも緑のままだった——この2本だけでは
      過剰実装を検出できないことも合わせて確認した。
  両方とも `cp` で退避したファイルから `cp` で復元し、`git status --porcelain` が
  意図どおりの差分（本 PR の変更点だけ）に戻ることを確認したうえで、3本とも緑に
  戻ることを確認した。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-over-limit-promotion.test.ts src/__tests__/omission-kind-generation.test.ts
  src/__tests__/recall-association.test.ts src/__tests__/recall.test.ts
  src/__tests__/recall-pipeline.test.ts src/__tests__/recall-association-gates.test.ts
  src/__tests__/recall-association-usage-ranking.test.ts src/__tests__/schema-type-equals-parity.test.ts`:
  8ファイル・257件すべて緑（既存の omitted/over_limit 関連の歯を含め、回帰は無い）。
- 【実測】`pnpm --filter @mnemora/core run typecheck` / `pnpm run lint` / `pnpm run format:check`:
  すべて緑、警告0。
- 【実測】`pnpm run api:check`（6パッケージ）: 全パッケージ「差分なし」——本 PR は
  公開 API 表面を1バイトも変えていない。
- 【実測】本物の Postgres + pgvector（`packages/postgres`、initdb で自前に構築した
  ローカルインスタンス）に対し、`recall.postgres.test.ts` に同型の歯を1本追加し、
  修正前に赤（`over_limit` が `{ count: 1, ... }` のまま残る）、修正後に緑になることを
  確認した。同ファイルの既存17本（新設分含め）もすべて緑、`recall-association-gates.postgres.test.ts`
  の既存7本も緑（回帰なし）。
- **確かめていないこと**: `test:db` 全体（他ファイル含む約4分のスイート）・`build`・
  `pack:check` は走らせていない（`docs/autonomy.md` の方針どおり、CI の緑で見届ける）。
  実運用での発生頻度も未計測——Issue #823 と同じく、この追記も頻度の実測はしていない。

Refs #823

---

## 2026-09-26 追記2（クローン miku の委譲先、Issue #925）

**「引き受けた負債」2番が名指ししていた経路——段3.5（連想、既定 on、ADR 0337）が
`over_limit(stage:"rescore")` の候補を独立に拾い直して `finalMemories` へ昇格させる
経路——を、直前の追記と同じ日付で塞いだ。**

**塞いだこと**: `recall-runtime.ts` の排他性契約ブロックが、差し引く対象を
「`overLimit`（段2、まだこの時点で生きている `ScoredCandidate[]`）に居て、かつ
(a) `companions`（段3の必須同伴取得）に居るか、(b) `finalMemories` に
`retrievedVia: "association"` で実際に返った」id に広げた。(a) は直前の追記の判定を
そのまま残し、(b) を OR で足した形である。

**差し引く数の取り方**: 「連想で返った総数」ではなく、**`overLimit` に居て、かつ
(a)(b) いずれかの経路で実際に `finalMemories` に返った id の数**に絞った。(b) を
`retrievedVia: "association"` で絞ったのは、`finalMemories` 全体との突き合わせだけで
判定すると、`overLimit` に一度も居なかった連想候補（below_threshold から連想で
拾われた場合など）まで数えてしまい、無関係な `over_limit(stage:"rescore")` の count
を誤って減らすため——これは below_threshold 側の取り下げが既に正しく処理している経路
であり、二重に差し引くと過剰実装になる。
`packages/core/src/__tests__/recall-over-limit-association-promotion.test.ts` の(c)が、
`overLimit` に一度も居ない連想候補（below_threshold 経由）を実際に組み、count が
無関係に減らないことを変異試験で確認した。

**既存 probe に `association: null` を明示した理由**: `omission-kind-generation.test.ts`
の `over_limit` probe のフィクスチャ（候補2件・`limit:1`）は、連想が既定 on のままだと
まさにこの経路を踏む——2件目が段2で `over_limit(stage:"rescore")` に落ちると同時に、
段3.5 のアンカーから拾い直されて `retrievedVia: "association"` として昇格し、今回の
取り下げで Omission 自体が消える。同 probe が確かめたいのは「`over_limit` という kind
の生成経路が本番コードに実在すること」（ADR 0159 のレジストリが縛る範囲）であり、
連想を含む既定構成での挙動まではこのレジストリの契約に含まれない——だから同 probe には
`association: null` を明示して連想を切り、射程を「kind の生成経路が在る」ことだけに絞った。

**訂正**: 直前の追記（Issue #823）は「壊した回帰」を、「`omission-kind-generation.test.ts`
の既存の歯が実際に赤くなった…無関係なはずの `over_limit(stage:"rescore")` の Omission
が誤って消えた」と書いていた。**この記述は不正確だった。** 実測し直すと、当時
「誤って消えた」と読んでいたその Omission は、実際には**連想で実際に返った記憶
（B）の分**であり、消えたこと自体は本追記の判定（overLimit ∩ 実際に association で
返った id）に照らして正しい——「無関係な」候補が巻き込まれて消えたのではない。
壊れていたのは Omission の消え方ではなく、**probe 側が「連想を明示的に切っていない」
という前提の甘さ**だった。同 probe が検査したいのは「over_limit という kind が
生成されること」であり、その検証に連想の挙動を混ぜていたのが赤の原因である。

**「引き受けた負債」2番**（below_threshold 以外の kind で段3.5 が同種の昇格を起こす
経路）は、`over_limit(stage:"rescore")` については本追記で解消した。**残るのは
`over_limit(stage:"association")`/`budget_dropped`/`score_not_comparable` 等、段2の
内部状態自体が memoryId を持ち回っていない他の kind についての前提**（「これが覆る
としたら」3番の「型の拡張が先」）であり、これは直前の追記から変わっていない。
`over_limit(stage:"association")` 自身の内部状態（連想候補の追跡）が id 付きで
保持されているかは、引き続き調べていない（Issue #925「確かめていないこと」）。

### 測ったこと

- 【実測】陽性対照（修正前、fake ストア）:
  `recall-over-limit-association-promotion.test.ts` の(a)(b)が赤になることを確認した
  ——(a) は Issue #925 本文の再現構成そのまま（`omission-kind-generation.test.ts` の
  `over_limit` probe と同一のフィクスチャ）で、`over_limit(stage:"rescore")` の
  Omission が消えるはずが `{ count: 1, ... }` のまま残る。(b) は `count` が `2` の
  まま `1` に減らない。(c)（過剰実装を捕まえる歯）は、この時点ではまだ緑だった
  （対象の count がそもそも動かないため）。
- 【実測】修正後、(a)(b)(c) の3本がすべて緑になることを確認した。
- 【実測】既存の `omission-kind-generation.test.ts` の `over_limit` probe に
  `association: null` を明示する前は、修正の適用によってこの probe 自体が赤くなる
  ことを確認した（2件目が連想で昇格し、Omission 自体が消えるため）。`association: null`
  を明示した後は緑に戻ることを確認した。
- 【実測】変異試験:
  (i) 追加した `associationReturnedIds` の判定を丸ごと除去（直前の追記の
      `companions` 限定の判定に戻す）→ (a)(b) が実際に赤になることを確認した。
  (ii) 差し引く数を「`overLimit` に居たか問わず、連想で返った総数をそのまま加算する」
      過剰実装に変える → (b)(c) が実際に赤になることを確認した（(c) は「無関係な
      候補が返っても count は減らない」という主張そのものが破れる）。
  両方とも `cp` で退避したファイルから `cp` で復元し、`git status --porcelain` が
  意図どおりの差分に戻ることを確認したうえで、3本とも緑に戻ることを確認した。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-over-limit-association-promotion.test.ts
  src/__tests__/recall-over-limit-promotion.test.ts
  src/__tests__/omission-kind-generation.test.ts
  src/__tests__/recall-association-gates.test.ts
  src/__tests__/recall-association-usage-ranking.test.ts
  src/__tests__/recall-association.test.ts
  src/__tests__/recall.test.ts
  src/__tests__/recall-pipeline.test.ts`:
  8ファイル・256件すべて緑（既存の omitted/over_limit/連想関連の歯を含め、回帰は無い）。
- 【実測】`pnpm --filter @mnemora/core run typecheck` / `pnpm run lint` /
  `pnpm run format:check`: すべて緑、警告0。
- 【実測】`pnpm run api:check`（6パッケージ、`pnpm run build` 実行後）: 全パッケージ
  「差分なし」——本追記は公開 API 表面を1バイトも変えていない。
- 【実測】本物の Postgres + pgvector（`packages/postgres`、initdb で自前に構築した
  ローカルインスタンス、UTF8+C locale）に対し、`recall.postgres.test.ts` に同型の歯を
  1本追加し、修正前に赤（`over_limit` が `{ count: 1, ... }` のまま残る）、修正後に
  緑になることを確認した。同ファイルの既存18本（新設分含め）もすべて緑、
  `recall-association-gates.postgres.test.ts` の既存7本も緑（回帰なし）。
- 【実測】`examples/chat` の `compare` ベンチ（`MNEMORA_PROVIDER_SOURCE=recorded`、
  実 API は叩いていない、`examples/chat/cassettes/compare.json` の再生）を本追記の
  修正の前後で実行し、`MNEMORA_COMPARE_JSON` で機械可読な出力を比較した。
  12行中5行（`turnCount` 42/82/162/322/642）で `omitted` の
  `over_limit(stage:"rescore")` の `count` が減った（42: 4→3、82: 15→12、
  162: 30→25、322: 30→26、642: 30→20）——いずれも本追記が狙った、連想で実際に
  拾い直された分の取り下げである。⭐門（`scripts/compare-summary.mjs` が見る
  `mnemoraShareOfNaiveChars`/`factStatementSurvived` の2欄）はこの5行を含む
  12行すべてで不変であり、退行ではない。手元の実行値は基準値には書いていない
  （「手元で測った値を書かない」、ADR 0121 決定1・ADR 0119 決定6）。
- 【実測】`examples/chat/compare-baseline.json` は、PR #930 自身の CI（example-chat
  ジョブ、run 36240303816）の artifact `compare` を attempt 1・2 の2本取り、
  `measuredAt`/`commit` を除いて `rows` がバイト単位で一致することを確かめてから
  （ADR 0231 決定5）、プログラムで差し替えた。動いたのは上の5行の
  `over_limit(stage:"rescore")` の `count` だけで、手元の実測と同じ値だった。
  経緯は同ファイルの `provenance.fifthUpdate` に記録した。
- **確かめていないこと**: `test:db` 全体（他ファイル含む約4分のスイート）・
  `examples/chat` の `retrieval`/`identifier-probes`/`numeral-token-probes` 等の
  他のベンチ・`pack:check` は手元では走らせていない。
  実運用での発生頻度も未計測。`over_limit(stage:"association")` 側の内部状態が
  id 付きで保持されているかどうかも、引き続き未調査。

Refs #925

---

## 2026-09-26 追記3（クローン miku の委譲先、Issue #940）

**直前の2つの追記（Issue #823・#925）が塞いだのは、`over_limit(stage:"rescore")` の候補が
段3（`companions`）または段3.5（連想）を経由して**候補集合に戻り、そのまま
`finalMemories` へ実際に返った**場合だけだった。**どちらの追記も、取り下げの条件に
`returnedMemoryIds.has(...)`（段4の予算切り詰めの**後**の最終集合）を AND で課していた
——「戻った先で最終的に返ったか」まで見ていたことになる。[Issue #940](https://github.com/takecchi/mnemora/issues/940)
が指摘したのは、この AND 条件のために、**戻った候補が段4の予算切り詰めで改めて落ちる**
ケースが素通りしていたことである。候補は `companions`/`associationUnits` に入った時点で
「戻った」にもかかわらず、そのあと budget で落ちると `returnedMemoryIds` に入らず、
取り下げが一度も発火しない——結果、同じ1件が `over_limit(stage:"rescore")` と
`budget_dropped` の両方に数えられる（Issue #940 本文の再現がこれをそのまま示している）。

**決めたこと**: 1件の Memory は `omitted` の中で1回だけ、**最後にその候補を落とした段**で
数える。段3/段3.5 で候補集合に戻り、段4の予算で改めて落ちたときは `budget_dropped` 側に
残し、`over_limit(stage:"rescore")` の count からは差し引く（0件になれば below_threshold と
同じ作法で Omission 自体を配列から外す）。

**塞いだこと**: 取り下げの判定から `returnedMemoryIds.has(...)` の AND 条件を外し、
「`overLimit` に居て、かつ (a) `companions`（段3）に居るか (b) `associationUnits`
（段3.5が席を埋めた候補、`selectedCandidates` をそのまま Unit にしたもの。段4より前の
内部状態）に居るか」だけで判定するように変えた。**戻った先で最終的に `finalMemories` に
残るか `budget_dropped` で落ちるかは、この判定にとって無関係になった**——`companions`/
`associationUnits` に一度でも入れば、それだけで `over_limit(stage:"rescore")` の勘定からは
外れる。

**(b) の判定基準も変えた**: 直前の追記（Issue #925）は (b) を「`finalMemories` に
`retrievedVia: "association"` で実際に返った」で判定していた。これは `returnedMemoryIds`
と同じ「段4の後」を見る判定だったため、今回は `associationUnits`（段4より前、席を
埋めた時点の内部状態）に居るかどうかに変えた——`companions` が最初から「段3が構築した
配列」という段4より前の内部状態で判定されていたのと、形を揃えたことになる。

**この入れ替えが二重計上にも取りこぼしにもならない理由（不変条件）**: `companions` ∪
`associationUnits` の members は、段4の後、必ず `finalMemories` か `budget_dropped` の
どちらかに入る——それ以外に消える経路が無い。コードを読んで確かめた根拠は次のとおり。

- `companions`（段3が `getMany` で構築した配列）の各要素は、その owner が
  `withinLimit` に居る限り、単位組み立ての繰り返し（`for (const candidate of
  withinLimit) { ... }`）が owner を訪れたときに必ず `byId` 経由で見つかり、
  owner と companion の2件で1つの `Unit` を組む。`companions` は
  `contestedNeedingCompanion`（`withinLimit` から作った配列）の `contestedWithId` を
  `getMany` で引いた結果であり、owner は定義上つねに `withinLimit` に居る——
  companion 自身が `withinLimit` に含まれることは無い（`presentIds` で除外済み）ので、
  この訪問を素通りする経路が無い。⟹ `companions` の各要素は必ずどれかの `Unit` の
  member になり、`allUnits`（`units` と `associationUnits` を連結したもの）に入る。
- `associationUnits` は `selectedCandidates`（連想の席取り合いで実際に席を得た候補）を
  1候補=1 `Unit` として `push` しているだけで、これより後に別の条件で間引く処理は無い
  ——`associationUnits` の要素数と `selectedCandidates` の要素数は常に一致する。
- 段4（予算による切り詰め）は `allUnits` を先頭から `cut` 件だけ `keptUnits` に残し、
  残りを丸ごと `droppedUnits` として `budget_dropped` の count に数える——`allUnits` の
  全要素が `keptUnits` か `droppedUnits` のどちらかに入り、この2つの間に「どちらでもない」
  経路は無い。`keptUnits` の members はそのまま `finalMemories` になる
  （`keptUnits.flatMap(...)` 以降、`finalMemories` の構築に至るまでの間にさらに間引く
  フィルタは無い）。

⟹ 段4の前に `companions`/`associationUnits` に入った候補は、必ず `allUnits` の
どれかの `Unit` の member であり、段4の後は `finalMemories` か `budget_dropped` の
どちらかに現れる。**この不変条件が成り立つ前提で、`over_limit(stage:"rescore")` から
一度差し引いた分は、必ずどちらか一方（`memories` 側か `budget_dropped` 側）でだけ
数えられる**——差し引いた分が「間で消えて、どこにも数えられない」経路は無い。

### 段3.5 経由でも実際に起きることを先に実測した

Issue #940 は段3（`companions`）経由の再現しか実測しておらず、段3.5（連想）経由でも
同じ形の二重計上が起きるかどうかは「読んだだけで、再現はしていない」と明記していた。
本追記の作業では、まず修正前のコードに対して段3.5 経由の陽性対照を組み、実際に
`over_limit(stage:"rescore")` と `budget_dropped` の両方に数えられることを実測した
（`recall-over-limit-budget-promotion.test.ts` の(b)）——段3経由と同型の形で実際に起きる
ことを確認したうえで、(a)(b) を同じ修正・同じ判定で揃えた。

### 採らなかった案・Issue #940 の(1)(2)(3)との関係

Issue #940 は直し方を3つ挙げ、どれも「約束の書かれていない振る舞いを決めることになる」
として起票にとどめていた。

1. **「取り下げの条件を『後段で一度でも引き直されたか』に広げる」**。本追記が実際に
   採ったのはこの形に近い——`returnedMemoryIds`（最終的に返ったか）ではなく
   `companions`/`associationUnits`（一度でも候補集合に戻ったか）で判定するように
   変えた。Issue 本文は「`over_limit(stage:"rescore")` の意味が変わる」ことを懸念して
   いたが、**意味が変わるのは `over_limit(stage:"rescore")` という Omission が
   `omitted` に載るかどうかであって、`memories`/`budget_dropped` 側の集合や件数では
   ない**——`companions`/`associationUnits` に戻った候補は、以前から
   `over_limit(stage:"rescore")` の count には含まれない経路（Issue #823/#925 が
   既に塞いだ「最終的に返った」場合）を持っていた。本追記は「最終的に返った」を
   「候補集合に戻った」へ広げただけであり、`over_limit(stage:"rescore")` が
   「段2の順位で漏れ、かつ以降のどの段でも拾い直されなかった」件数を表す、という
   読み方は変えていない——むしろこの読み方に厳密に一致させたのが本追記である
   （旧判定は「拾い直されたが、その後さらに落ちた」候補を誤って含めていた）。
2. **「`budget_dropped` 側から、over_limit に数えた分を除く」**。**採らなかった**。
   `budget_dropped` の count は変えていない——段4が実際に落とした件数（droppedUnits の
   members 総数）をそのまま数え続ける。除いていたら「段4が実際に落とした件数」を
   過小に見せる、という Issue 本文の懸念どおりになる。差し引いたのは常に
   `over_limit(stage:"rescore")` 側だけである。
3. **「負債として ADR に追記するだけ」**。**採らなかった**——今回のADR追記は「直した」
   記録であり、負債を残す記録ではない。

### 段3.5・段3以外の kind への非対称は変えていない

`over_limit(stage:"association")`/`score_not_comparable` 等、段2の内部状態自体が
memoryId を持ち回っていない他の kind は、引き続き対象外である（ADR 0203「引き受けた
負債」がそのまま残っている部分）。今回の変更は、既に対象になっていた
`over_limit(stage:"rescore")` の判定条件を「戻ったか」に絞り直しただけで、対象の
範囲そのものは広げていない。

### 範囲外と分かったこと（実測、直していない）

作業の過程で、次の2つが実際に二重計上になることを一時テスト（commit していない）で
確かめた。どちらも今回の修正の対象には含めていない。

- **over_limit(rescore) の候補が連想の候補になったが席に着けず、
  `over_limit(stage:"association")` にも数えられる**。段2で `over_limit(stage:"rescore")`
  に落ちた候補が、段3.5 のアンカー近傍として `rankedCandidates` には入ったものの
  `maxCount` の席を他候補に取られて `selectedCandidates` に入らなかった場合、その候補は
  `over_limit(stage:"rescore")`（今回の取り下げは `associationUnits` に居る候補にしか
  効かないので、この候補には効かない）と `over_limit(stage:"association")`（席取りに
  負けた分としてそのまま数えられる、`recall-runtime.ts` の該当コメント参照）の
  **両方**に数えられることを実測した。
- **below_threshold の候補が段3/段3.5で戻り、段4で落ちると、
  below_threshold と budget_dropped の両方に数えられる**。below_threshold 側の取り下げ
  （`promotedFromBelowThreshold`）は今回直していない `returnedMemoryIds.has(...)` を
  そのまま使っており、`companions`/連想で候補集合に戻った below_threshold の候補が
  段4の予算で改めて落ちると、below_threshold 側の取り下げが発火しないまま
  `budget_dropped` にも数えられることを実測した——本追記が `over_limit(stage:"rescore")`
  について解消したのと**同型の**問題が、below_threshold 側にはそのまま残っている。

この2件は、ADR 0203「これが覆るとしたら」3番・「引き受けた負債」2番のどちらにも
明示的には書かれていなかった経路であり、Issue #940 が挙げた3択のような選択肢の
検討もしていない。**別途 Issue として起票するかどうかは、この追記の射程外である。**

### 測ったこと

- 【実測】陽性対照（修正前、fake ストア）: `recall-over-limit-budget-promotion.test.ts`
  の(a)(b)(c)が赤になることを確認した——(a)(b) は `over_limit(stage:"rescore")` の
  Omission が消えるはずが `{ count: 1, ... }` のまま残る。(c)（過剰実装を捕まえる歯）は、
  この時点ではまだ緑だった（対象の count がそもそも動かないため）。
- 【実測】修正後、(a)(b)(c) の3本がすべて緑になることを確認した。
- 【実測】変異試験:
  (i) 判定に `returnedMemoryIds.has(...)` の AND を復活させる（直前の追記の判定に
      戻す）→ (a)(b)(c) の3本すべてが実際に赤になることを確認した（(c) も赤に
      なったのは、この変異が (a) と同じ fixture を使っているため——companion の
      取り下げが発火しなくなり、over_limit(stage:"rescore") の count が期待の 1 では
      なく 2 のままになった）。
  (ii) 判定を `promotedFromOverLimit = overLimit`（`overLimit` 全件を無条件に差し引く
      過剰実装）に変える →
      `recall-over-limit-promotion.test.ts` の2本目・3本目、
      `recall-over-limit-association-promotion.test.ts` の(b)・(c)、
      `recall-over-limit-budget-promotion.test.ts` の(c) の、あわせて5本が
      実際に赤になることを確認した——いずれも「無関係な over_limit の候補まで
      count から差し引かれてしまう」形の赤である。
  どちらも `cp` で退避したファイルから `cp` で復元し、`git status --porcelain` が
  意図どおりの差分（本追記の変更点だけ）に戻ることを確認したうえで、全数が緑に
  戻ることを確認した。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-over-limit-budget-promotion.test.ts
  src/__tests__/recall-over-limit-promotion.test.ts
  src/__tests__/recall-over-limit-association-promotion.test.ts
  src/__tests__/omission-kind-generation.test.ts
  src/__tests__/recall-association.test.ts
  src/__tests__/recall-association-gates.test.ts
  src/__tests__/recall-association-usage-ranking.test.ts
  src/__tests__/recall-budget-channel-registry.test.ts
  src/__tests__/recall.test.ts
  src/__tests__/recall-pipeline.test.ts
  src/__tests__/schema-type-equals-parity.test.ts`:
  11ファイル・269件すべて緑（既存の omitted/over_limit/連想/budget 関連の歯を含め、
  回帰は無い）。
- 【実測】`pnpm --filter @mnemora/core run typecheck` / `pnpm run lint` /
  `pnpm run format:check` / `pnpm run build`: すべて緑、警告0。
- 【実測】`pnpm run api:check`（6パッケージ、`build` 実行後）: 全パッケージ
  「差分なし」——本追記は公開 API 表面を1バイトも変えていない。
- 【実測】本物の Postgres + pgvector（initdb で自前に構築したローカルインスタンス、
  `--encoding=UTF8 --locale=C.UTF-8`）に対し、`recall.postgres.test.ts` に段3経由の
  同型の歯を1本追加し、修正前に赤（`over_limit` が `{ count: 1, ... }` のまま残る）、
  修正後に緑になることを確認した。同ファイルの既存21本（新設分含め）もすべて緑、
  `recall-association-gates.postgres.test.ts` の既存7本も緑（回帰なし）。段3.5経由の
  歯は Postgres には追加していない——`packages/core` で段3・段3.5 とも同じ判定
  コードを通ることを確認済みであり、AGENTS.md の変異試験の手順（1本に絞って走らせる）
  にならい、Postgres 側は代表として段3経由の1本に絞った。
- 【実測】`examples/chat` の `compare` ベンチ（`MNEMORA_PROVIDER_SOURCE=recorded`、
  実 API は叩いていない、`examples/chat/cassettes/compare.json` の再生）を本追記の
  修正の前後で実行し、`MNEMORA_COMPARE_JSON` で機械可読な出力を比較した——
  `measuredAt`/`commit` を除いて `rows` を含む出力全体がバイト単位で一致した
  （差分ゼロ）。**理由は、`compare` が `recall()` に budget を渡さない設計だから
  である**（`compare.ts` のコメント「ここでは budget を渡さない——『切り詰めずに、
  そのままだと何文字になるか』を見る」）。本追記の修正は「段3/段3.5で戻った候補が
  段4の予算で落ちる」場合にだけ挙動を変えるため、budget が無い `compare` の実行では
  構造的に差分が出ない——今回の差分ゼロは「効果が無かった」ことではなく
  「この計測は対象の外にある」ことを示している。`compare-baseline.json` は
  変更していない（差し替える理由が無い）。
- **確かめていないこと**: `test:db` 全体（他ファイル含む約4分のスイート）・
  `examples/chat` の `retrieval`/`identifier-probes`/`numeral-token-probes`/`chat`
  （budget を渡す経路）等の他のベンチ・`pack:check` は手元では走らせていない。
  実運用での発生頻度も未計測。上の「範囲外と分かったこと」の2件は、直しても
  いなければ Issue としても起票していない。

Refs #940

---

## 2026-09-26 追記4（クローン miku の委譲先、Issue #949）

**直前の追記3「範囲外と分かったこと」1番目——`over_limit(stage:"rescore")` の候補が
段3.5（連想）の候補プールに入ったが席に着けず、`over_limit(stage:"association")` にも
数えられる経路——を、この日付で解消した。**

### 決めたこと

1件の Memory は `omitted` の中で、最後にそれを落とした段で1回だけ数える。段3.5（連想）は
段2より後の段なので、この経路の"最後の段"は段3.5になる——`over_limit(stage:"rescore")`
からは差し引き、`over_limit(stage:"association")` 側に1回だけ残す。全件差し引いた場合は
below_threshold/`over_limit(stage:"rescore")` と同じ作法で Omission 自体を配列から外す。

**塞いだこと**: `recall-runtime.ts` の排他性契約ブロックが、差し引く対象を「`overLimit`
（段2、まだこの時点で生きている `ScoredCandidate[]`）に居て、かつ (a) `companions`
（段3）に居るか (b) `associationUnits`（段3.5が席を埋めた候補）に居るか (c) 段3.5 の
候補プールに入ったが席に着けなかったか」に広げた。(a)(b) は追記3の判定をそのまま残し、
(c) を OR で足した形である。

### 判定条件

(c) の判定は、`over_limit(stage:"association")` の count（`overLimitAssociationCount`）を
構成する式と**同じ2つの式**を、件数ではなく id の集合として組み立て直したものである
（`overLimitAssociationSeatlessIds`）。

- 過取得の窓の外に居た分: `associationHits.slice(rankFetchCount)` の id。
- 土俵（`rankedCandidates`）に上がって `maxCount` の席を競り負けた分:
  `rankedCandidates` のうち `selectedCandidates` に入らなかった要素の id。

`promotedFromOverLimit` は、`overLimit` の各要素についてこの3条件（(a)(b)(c)）を OR で
判定する——同じ候補が複数の条件に同時に当たることは構造的に起きない
（`companions`/`associationUnits`/`overLimitAssociationSeatlessIds` は互いに素な集合
——companion は同伴取得、`associationUnits` は席を得た連想候補、
`overLimitAssociationSeatlessIds` は席を得なかった連想候補であり、同じ候補が
同時に2つの身分を持つことは無い）ため、`Set` を経由しなくても二重に差し引く心配は無い
——`Array.prototype.filter` は各要素を1回だけ評価する。

**`over_limit(stage:"association")` 自身の count はここでは変えない**——差し引くのは
常に `over_limit(stage:"rescore")` 側だけである（追記3までと同じ非対称）。

### 多層防御の分を除いた理由

`overLimitAssociationSeatlessIds` は、多層防御（`survivesSubjectFilter`/
`survivesAttributesFilter`/`survivesLabelsFilter`/`survivesValidityGate`/
`survivesDecayGate` ほか、`rankFetchHits` を `rankedCandidates` へ絞り込む for ループの
中）で落ちた候補を**含まない**。これは新しい除外ロジックを足したのではなく、
`overLimitAssociationCount` が最初から数えている2つの式（過取得の窓の外／席を競り負けた分）
を、そのまま id で複製しただけだからである——多層防御で落ちた候補は、そもそも
`rankedCandidates` に一度も入らない（for ループの `continue` で弾かれる）ため、
「土俵に上がって競り負けた分」（`rankedCandidates` に居るが `selectedCandidates` に
居ない）にも「過取得の窓の外」（`associationHits.slice(rankFetchCount)`、
`rankFetchHits` の外）にも当たらない。多層防御で落ちた分は段5の `aggregateScope` が
`filtered(...)` として別途数えており（Issue #329 / ADR 0173）、ここで差し引くと
二重計上になる——この区別は`overLimitAssociationCount` の既存のコメント
（「🔴 落ちた件数はここでは数えない」）がそもそも守っていた線であり、今回はそれを
複製しただけで新しく作った線ではない。

**この区別を歯で直接押さえてはいない**——多層防御で落ちた候補を意図的に混入させ、
それが `over_limit(rescore)` から差し引かれないことを確認する歯は書いていない。
上の段落の論拠はコードを読んで確かめたものであり、`recall-over-limit-association-
seat-promotion.test.ts` の3本はどれも多層防御が1件も落とさない構成になっている
（`overLimitAssociationCount` 自身の既存の歯もこの区別を直接検査したものは無い
——追跡した範囲では、この区別は「二重計上を作らない」という不変条件の帰結として
コードレビューでしか確認していない）。

### 採らなかった案

1. **`over_limit(stage:"association")` の内部状態（連想候補の追跡）が id 付きで
   保持されているかを、あらためて型を拡張してから調べる**（ADR 0203「これが覆るとしたら」
   3番が前提に置いていた順序）。**不要だった**——`over_limit(stage:"rescore")` の
   ときの ADR 0203 追記（Issue #823）と同じ理由で、`Omission` という公開型を1バイトも
   広げずに `runRecall` 内部の未公開の状態（`associationHits`/`rankedCandidates`/
   `selectedCandidates`）だけから `overLimitAssociationSeatlessIds` を組み立てられた。
2. **`overLimitAssociationCount` の式をこの機会に書き直す**（例えば
   `overLimitAssociationSeatlessIds.size` を直接使う）。**採らなかった**——
   `overLimitAssociationCount` は「件数」という既存の契約をそのまま維持する値であり、
   今回変えたいのは`over_limit(stage:"rescore")` 側の判定だけである。同じ集合を
   2通りの表現（数と id）で独立に持つことは、どちらかが将来ズレたときに片方だけ
   直して他方を見落とす負債を生むが、`overLimitAssociationSeatlessIds` の構築式は
   `overLimitAssociationCount` の式のコメントをそのまま複製しており、片方を直すときは
   もう片方も直すべきことがコード上で並んで見える位置にある（実装した位置を参照）。
3. **`associationHits ∩ overLimit`（席に着いたかどうかを見ずに、連想候補プールに
   入った時点で全部差し引く）という、より粗い判定にする**（マネージャーが過剰実装の例
   として挙げた案の一つ）。**検討したが、正しい判定と区別できないことが分かった**——
   `overLimit` に居るある候補が `associationHits` に入った時点で、その候補は必ず
   「席を得て `associationUnits` に入る」か「席を得ずに `overLimitAssociationSeatlessIds`
   に入る」かのどちらか一方になる（`rankFetchHits` の外に出た分・`rankedCandidates`
   で競り負けた分・`selectedCandidates` に入った分の3つで `associationHits` の全体を
   汲み尽くす。多層防御で落ちた分だけが例外だが、これは上の段落の理由でそもそも
   `associationHits`ではなく`rankFetchHits`から`rankedCandidates`への絞り込みの内側の
   話であり、「連想候補プールに入った」時点の粗い判定でも `associationHits` 自体には
   含まれているので、この粗い判定はむしろ多層防御で落ちた分**も**拾ってしまう）。
   ⟹ この粗い判定は、多層防御で落ちた分を除けば正しい判定と常に同じ結果を返すため、
   「過剰実装だが今回のフィクスチャでは見分けが付かない」変異になる——(c)（バイスタンダー
   の歯）は捕まえられなかった（多層防御を1件も落とさない構成のため）。かわりに
   「`overLimit` 全件を無条件に差し引く」というさらに粗い過剰実装（下の変異試験(ii)）を
   採用し、それは(c)で確かに捕まえた。**この案と「本当の正しい判定」を区別する歯は
   書けていない**——多層防御で意図的に候補を落とす歯を別途組まないと区別できない
   （上の「多層防御の分を除いた理由」の限界と同じ）。

### 訂正

直前の追記3の「測ったこと」は、`recall-over-limit-budget-promotion.test.ts` の(c)
（過剰実装を捕まえる歯）について「修正前…(c)は、この時点ではまだ緑だった（対象の count
がそもそも動かないため）」と書いていた。**この記述は不正確だった。** 本追記の作業中に、
`recall-runtime.ts` を追記3の直前の状態（commit `3b09840`^、Issue #925 の判定
——`returnedMemoryIds` との AND を課す形）に戻して実際に走らせ直すと、(c) は
`expected 2 to be 1` で**赤**になった——(a)(b) と同時に赤くなっており、「(c) だけが
この時点で緑だった」という記述は誤りである。壊れていたのは記述であり、当時の
コード・修正・変異試験の結論（(a)(b)(c) が修正後に緑になり、変異(i)(ii)で正しく
赤くなること）自体は正しいままである——(a)(b) が主張していた二重計上そのものは
実在し、修正前が(a)(b)(c) すべてで赤かったか(a)(b)だけで赤かったかは、修正が正しいことの
証明には影響しない。**なぜ見落としたか**: 追記3の作業ログを読み返すと、「(c)は対象の
count がそもそも動かないため緑」という予測を、実測せずにそのまま書いていた可能性が高い
——`recall-over-limit-promotion.test.ts`・`recall-over-limit-association-promotion.
test.ts` の同型の(c)（bystander の歯）は「新しい判定が無い状態」でも入力の bystander
自体が無関係であり続けるため実際に緑になる場合があり、その類推を
`recall-over-limit-budget-promotion.test.ts` の(c)にも当てはめて書いた可能性がある。
だが budget-promotion の(c)は bystander に加えて「companion 経由で戻り、over_limit
からも budget_dropped からも差し引かれるべき候補」も同時に含む構成であり
（`recall-over-limit-budget-promotion.test.ts` の該当フィクスチャを参照）、修正前の
コード（追記2の判定、`returnedMemoryIds` の AND 付き）では後者の取り下げが発火せず、
`over_limit(rescore)` の count がbystanderの1件だけでなくこの候補の分も足された2に
なっていた——だからこの(c)は独立した過剰実装の検出だけでなく、追記3が直した本題の
再現も部分的に相乗りしていた（(a)(b)と同じ理由で赤くなっていた）。

### 「引き受けた負債」・「これが覆るとしたら」の残り

- **below_threshold の候補が段3/段3.5で戻り、段4で落ちると、below_threshold と
  budget_dropped の両方に数えられる経路**（追記3「範囲外と分かったこと」2番目）は、
  本追記でも塞いでいない。[Issue #950](https://github.com/takecchi/mnemora/issues/950)
  として別途起票した状態のまま、未解消で残っている——起票にとどめた理由は同 Issue 本文の
  とおり、`below_threshold.nearMisses` が memoryId 付きの**公開の欄**であり、
  「戻ったが最終的に返らなかった」ものまで `nearMisses` から取り下げるかどうかを、
  `over_limit` の件数だけの直しとは別の判断として扱うべきだからである。
- **`over_limit(stage:"association")`/`budget_dropped`/`score_not_comparable` 等、
  段2の内部状態自体が memoryId を持ち回っていない他の kind についての前提**
  （「これが覆るとしたら」3番の「型の拡張が先」）は、`over_limit(stage:"rescore")` からの
  差し引き対象を広げる形では引き続き解消してきているが（今回で(a)(b)(c)の3経路）、
  `over_limit(stage:"association")` 自身の count を他の kind の昇格に応じて調整する
  経路（例えば below_threshold から連想で拾われて席を得た場合に
  `over_limit(stage:"association")` 側を調整するような話）は検討していない——
  今回の射程は常に「`over_limit(stage:"rescore")` から何を差し引くか」であり、
  他の kind 同士の突き合わせには広げていない。

### 測ったこと

- 【実測】陽性対照（修正前、fake ストア）:
  `recall-over-limit-association-seat-promotion.test.ts` の(a)(b)(c)が赤になることを
  確認した——(a)(b) は `over_limit(stage:"rescore")` の Omission が消えるはずが
  `{ count: 1, ... }` のまま残る。(c)（過剰実装を捕まえる歯）は
  `expected 2 to be 1` で赤だった（D（バイスタンダー）は元から無関係なので1のまま
  残るべきだが、T の分が差し引かれないため2のまま）。
- 【実測】修正後、(a)(b)(c) の3本がすべて緑になることを確認した。
- 【実測】本物の Postgres + pgvector（initdb で自前に構築したローカルインスタンス、
  `mnemora_test`、UTF8/C.UTF-8 ロケール）に対し、`recall.postgres.test.ts` に(a)と
  同型の歯を1本追加し、`recall-runtime.ts` を本追記の変更前の内容（commit `3b09840`、
  PR #947 の内容そのもの）に戻して実行すると赤（`over_limit(rescore)` が
  `{ count: 1, ... }` のまま残る）になり、変更後の内容に戻すと緑になることを確認した。
  同ファイルの既存21本・
  新設1本の計22本もすべて緑、`recall-association-gates.postgres.test.ts` の既存7本も
  緑（回帰なし）。
- 【実測】変異試験:
  (i) 追加した `overLimitAssociationSeatlessIds.has(...)` の OR 条件を丸ごと除去
      （追記3の判定——`companions`/`associationUnits` の2条件だけ——に戻す）→ (a)(b)(c)
      の3本すべてが実際に赤になることを確認した。
  (ii) 判定を `promotedFromOverLimit = overLimit`（`overLimit` 全件を無条件に差し引く
      過剰実装）に変える →
      `recall-over-limit-promotion.test.ts` の2本、
      `recall-over-limit-association-promotion.test.ts` の2本、
      `recall-over-limit-budget-promotion.test.ts` の(c)、
      `recall-over-limit-association-seat-promotion.test.ts` の(c) の、
      あわせて6本が実際に赤になることを確認した——いずれも「連想の近傍に現れていない、
      または無関係な over_limit の候補まで count から差し引かれてしまう」形の赤である。
  どちらも `cp` で退避したファイルから `cp` で復元し、`git status --porcelain` が
  意図どおりの差分（本追記の変更点だけ）に戻ることを確認したうえで、全数が緑に
  戻ることを確認した。
  **より粗い過剰実装（`associationHits ∩ overLimit` を席に着いたかどうかを見ずに
  差し引く、上の「採らなかった案」3番）は、上の(a)(b)(c)のどの歯でも赤にならなかった**
  ——「採らなかった案」3番に書いたとおり、多層防御を1件も落とさない今回のフィクスチャ
  では正しい判定と数学的に一致するため、区別する歯を用意できていない。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
  src/__tests__/recall-over-limit-association-seat-promotion.test.ts
  src/__tests__/recall-over-limit-budget-promotion.test.ts
  src/__tests__/recall-over-limit-promotion.test.ts
  src/__tests__/recall-over-limit-association-promotion.test.ts
  src/__tests__/omission-kind-generation.test.ts
  src/__tests__/recall-association.test.ts
  src/__tests__/recall-association-gates.test.ts
  src/__tests__/recall-association-usage-ranking.test.ts
  src/__tests__/recall-budget-channel-registry.test.ts
  src/__tests__/recall.test.ts
  src/__tests__/recall-pipeline.test.ts
  src/__tests__/schema-type-equals-parity.test.ts`:
  12ファイル・272件すべて緑（既存の omitted/over_limit/連想/budget 関連の歯を含め、
  回帰は無い）。
- 【実測】`pnpm --filter @mnemora/core run typecheck` / `pnpm --filter @mnemora/postgres
  run typecheck` / `pnpm run lint` / `pnpm run format:check` / `pnpm run build`:
  すべて緑、警告0。
- 【実測】`pnpm run api:check`（6パッケージ、`build` 実行後）: 全パッケージ
  「差分なし」——本追記は公開 API 表面を1バイトも変えていない。
- 【実測】`examples/chat` の `compare` ベンチ（`MNEMORA_PROVIDER_SOURCE=recorded`、
  実 API は叩いていない、`examples/chat/cassettes/compare.json` の再生）を本追記の
  修正の前後で実行し、`MNEMORA_COMPARE_JSON` で機械可読な出力を比較した——
  **本追記は budget を渡さない `compare` でも差分が出た**（追記3が「`compare` は
  budget を渡さないため対象の外にあり、差分ゼロは効果が無かったことを意味しない」と
  書いていたのとは対照的に、本追記の判定は budget に依存しない）。12行中1行
  （`turnCount` 642）で `omitted` の `over_limit(stage:"rescore")` の `count` が
  20→12 に減った——連想の候補プールで席に着けなかった分が、この修正で正しく
  `over_limit(stage:"rescore")` から差し引かれたことを示す。他の11行（`over_limit
  (stage:"association")` の count を含む）はすべて不変。⭐門（`mnemoraShareOfNaiveChars`/
  `factStatementSurvived`）はこの1行を含む12行すべてで不変であり、退行ではない。
  手元の実行値は基準値には書いていない（「手元で測った値を書かない」、ADR 0121 決定1・
  ADR 0119 決定6）。`examples/chat/compare-baseline.json` はこの手元の実測時点では
  642ターンの行が `over_limit(stage:"rescore")` の count を旧値（20）のまま持っており、
  本追記の変更を適用した状態のCIが走ったときに、ADR 0231 決定5の手順（CI artifact の
  attempt 1・2 の一致を確認してから機械的に差し替える）で更新されるべき対象として残って
  いる——本追記ではプログラムでの差し替えは行っていない（手で書き換えない、という
  制約に従った）。
- **確かめていないこと**: `test:db` 全体（他ファイル含む約4分のスイート）・
  `examples/chat` の `retrieval`/`identifier-probes`/`numeral-token-probes`/`chat`
  （budget を渡す経路）等の他のベンチ・`pack:check` は手元では走らせていない。
  実運用での発生頻度も未計測。「採らなかった案」3番・「多層防御の分を除いた理由」で
  触れた、多層防御で候補を意図的に落とす歯は組んでいない。`over_limit(stage:
  "association")` 自身の内部状態を他の kind（below_threshold 等）の昇格と突き合わせる
  経路は検討していない。

Refs #949

---

## 2026-09-27 追記5（クローン miku の委譲先、Issue #950）

**追記3「範囲外と分かったこと」2番目——`below_threshold` の候補が段3/段3.5 で候補集合に
戻り、段4の予算で改めて落ちると、`below_threshold` と `budget_dropped` の両方に数えられる
経路——を、この日付で解消した。**

### 決めたこと

追記3・追記4 が `over_limit(stage:"rescore")` について決めた「1件の Memory は `omitted` の
中で、最後にそれを落とした段で1回だけ数える」を、`below_threshold` にも当てた。段3/段3.5 で
戻った候補の「最後の段」は段4なので、`budget_dropped` 側に1回だけ残し、`below_threshold` の
`count` と `nearMisses` からは取り下げる。取り下げの作法（`count` を減らす・`nearMisses` から
外す・0件なら Omission ごと外す、`nearMisses` を6件目以降で埋め直さない）は、決定5 と同じで
ある。

**塞いだこと**: `recall-runtime.ts` の排他性契約ブロックで、`promotedFromBelowThreshold` の
判定を「`finalMemories` に返ったか」から「`finalMemories` に返ったか、または (a) `companions`
（段3）に居るか (b) `associationUnits`（段3.5 が席を埋めた候補。#959 以降は段3.5 が取った
必須の同伴を含む）に居るか」へ広げた。(a)(b) は追記3 が `over_limit(stage:"rescore")` の
判定に使っている集合と同じものであり、判定の式を共有するために集合の組み立てを
below_threshold のブロックの前へ移した（`over_limit` 側の判定は変えていない）。

### `nearMisses` の意味について

Issue #950 は、`nearMisses`（memoryId を持つ公開の欄）から「予算で落ちた」記憶が消えることを、
#940 と別の判断にする理由に挙げていた。決定5 が決めていたのは「昇格して返ったもの」の
取り下げだけで、「戻ったが返らなかったもの」は決めていなかったからである。この追記は次の
理由で取り下げる側を採った。

- `BelowThresholdOmission` の doc が約束しているのは「`memories` に返った memoryId を
  含まない」ことと、「`nearMisses` は段2の閾値未満の候補の上位5件で、`count` の全件の
  サンプルではない」ことだけである。予算で落ちた記憶を `nearMisses` に残すことは、
  どこも約束していない。
- 取り下げなければ、同じ memoryId が `below_threshold.nearMisses` と `budget_dropped` の
  両方に数えられ、追記3・追記4 の原則に反したままになる。
- ⟹ 取り下げ後の `nearMisses` は「最後に閾値で落ちた」記憶の上位だけになる。予算で落ちた
  記憶は、個体としてはどの Omission にも現れず、`budget_dropped` の件数にだけ残る
  （`budget_dropped` はもともと memoryId を持たない）。

### 範囲外と分かったこと（実測、直していない）

- **below_threshold の候補が段3.5 の候補プールに入ったが席に着けず、
  `over_limit(stage:"association")` にも数えられる**。追記4 が `over_limit(stage:"rescore")`
  について塞いだ経路と同じ形が、below_threshold 側に残っている。fake ストアの一時テスト
  （commit していない）で、`maxCount: 1` の連想枠で席を競り負けた below_threshold の候補が
  `below_threshold`（`nearMisses` にも載る）と `over_limit(stage:"association")` の両方に
  数えられることを確かめた。この追記では直していない（Issue #984 に切り出した）。

### 測ったこと

- 【実測】歯 `packages/core/src/__tests__/recall-below-threshold-budget-promotion.test.ts`
  （fake ストア、3本）: 修正前に (a)（段3の同伴）と (b)（段3.5 の連想）が赤。(c)（どの経路でも
  戻っていない候補は残る）も修正前は赤——(b) と同じ二重計上で `count` が 2 になるため。
  修正後は3本とも緑。
- 【実測】変異試験: 判定を「すべて取り下げる」にすると (c) だけが赤、段3の同伴（(a) の条件）を
  判定から外すと (a) だけが赤。どちらも戻すと緑。
- 【実測】`packages/core` の recall・omission まわりの既存の歯 31 ファイル（484本）を
  ファイル名指定で実行し、すべて緑。`pnpm api:check` の差分は0。
- **確かめていないこと**: 本物の Postgres での再現（この判定は `packages/core` の中だけで
  完結しており、adapter に依存しない）。`budget` を渡すベンチの基準値への影響は CI で見る。

Refs #950

---

## 2026-09-27 追記6（クローン miku の委譲先、Issue #984）

**追記5「範囲外と分かったこと」——`below_threshold` の候補が段3.5 の候補プールに入ったが
席（`maxCount`）に着けず、`below_threshold` と `over_limit(stage:"association")` の両方に
数えられる経路——を、この日付で解消した。**

### 決めたこと

追記4（Issue #949）が `over_limit(stage:"rescore")` について入れた処置を、`below_threshold` にも
当てた。この経路で最後にその候補を落とした段は段3.5 なので、`over_limit(stage:"association")`
側に1回だけ残し、`below_threshold` の `count` と `nearMisses` からは取り下げる。取り下げの作法は
「決めたこと」5 と同じである。

**塞いだこと**: `recall-runtime.ts` の `promotedFromBelowThreshold` の判定に、
`overLimitAssociationSeatlessIds`（段3.5 の候補プールで席に着けなかった候補の id。追記4 が
`over_limit(stage:"association")` の count を構成する2つの式から組み立てた集合）を OR で足した。
`over_limit(stage:"association")` 自身の count は変えていない。多層防御で落ちた候補がこの集合に
入らないことも、追記4 に書いたとおりである。

⟹ 追記3〜6 により、`below_threshold` と `over_limit(stage:"rescore")` の2つについては、
段3（`companions`）・段3.5 の席（`associationUnits`）・段3.5 の席に着けなかった分
（`overLimitAssociationSeatlessIds`）の3つの経路のどれで扱われても、`omitted` の中で1回だけ
数えられる。

### 測ったこと

- 【実測】歯 `packages/core/src/__tests__/recall-below-threshold-association-seat-promotion.test.ts`
  （fake ストア、2本）: 修正前は (a)（席を競り負けた below_threshold の候補が
  `below_threshold` から外れる）が赤。(b)（連想の土俵に上がっていない候補は `below_threshold` に
  残る）も、同じ二重計上で `count` が 2 になり赤。修正後は2本とも緑。
- 【実測】変異試験: 判定を「すべて取り下げる」にすると (b) だけが赤。
  `overLimitAssociationSeatlessIds` を判定から外すと（修正前と同じ）(a)(b) が赤。
- 【実測】`packages/core` の recall・omission まわりの既存の歯 32 ファイル（486本）を
  ファイル名指定で実行し、すべて緑。
- **確かめていないこと**: 本物の Postgres での再現（判定は `packages/core` の中で完結する）。
  `maxCount` を渡すベンチの基準値への影響は CI で見る。

Refs #984

---

## 2026-09-27 追記7（クローン miku の委譲先、Issue #1019）

**段2で `score_not_comparable`（`total` が `NaN`）に数えた候補が、段3の必須の同伴取得や段3.5 の連想で候補集合に戻ると、`memories`（または段4の `budget_dropped`）と `score_not_comparable` の両方に数えられていた。これを解消した。**

見つけた経緯: シードつきのランダムな操作列で不変条件を検査する使い捨ての検査器（Fake）が、「返した件数とスコープ内で落ちた件数の和が `totalInScope` を超える」という形で拾った。最小化すると「記憶 A とゼロベクトルの記憶 B を `markContested` で結び、A に近いクエリで recall する」だけで起きる。連想枠が既定の on のときは、段2で比較不能だった記憶を段3.5 が拾い直した場合にも同じことが起きていた。

### 決めたこと

追記3〜6 の「1件の Memory は `omitted` の中で、最後にそれを落とした段で1回だけ数える」を `score_not_comparable` にも当てた。段2の `partition.notComparable` は memoryId を持つ内部状態なので、below_threshold と同じ判定（返ったか、`companions`/`associationUnits` に居るか）で突き合わせ、戻った分を `score_not_comparable` の `count` から差し引く。0件になれば Omission ごと外す。

本 ADR の「引き受けた負債」2番と追記3「段3.5・段3以外の kind への非対称は変えていない」は、`score_not_comparable` を「段2の内部状態自体が memoryId を持ち回っていない」kind として対象外にしていた。`score_not_comparable` についてはこの前提は当たらず（`partition.notComparable` は `ScoredCandidate[]` である）、この追記で対象に入れた。

### 既存の歯の変更

`recall-pipeline.test.ts` の「三分割は網羅である: scored = passed + below_threshold + score_not_comparable」は、`omitted` の `score_not_comparable` の件数が段2の比較不能の件数と一致することを測っていた。連想枠が既定の on（ADR 0337）になって以降、この歯の構成では、段2で比較不能だった記憶を段3.5 が拾い直して返していた（二重計上が起きていた）。この歯が測りたいのは段2の三分割そのものなので、`association: null` を明示して後の段が何も拾い直さない形で測るようにした。

### 測ったこと

- 【実測】歯 `packages/core/src/__tests__/recall-score-not-comparable-promotion.test.ts`（fake ストア、3本）: 修正前は (a)（段3の同伴で返った）・(b)（同伴の組が予算で落ちた）・(c)（どこからも戻っていないゼロベクトルは残る）の3本とも赤（(c) は二重計上で件数が 2 になる）。修正後は3本とも緑。
- 【実測】変異試験: 判定を「すべて取り下げる」にすると (c) だけが赤。「返った分だけ」にすると (b) だけが赤。
- 【実測】recall・omission まわりの既存の歯 33 ファイル（489本）をファイル名指定で実行し、すべて緑（上の1本は `association: null` を足した後）。
- **確かめていないこと**: 本物の Postgres での再現（判定は `packages/core` の中で完結する）。

Refs #1019

---

## 2026-09-27 追記8（クローン miku の委譲先、Issue #1020）

**段3.5（連想枠）で席（`maxCount`）を競り負けて `over_limit(stage:"association")` に数えた候補が、同じ段3.5 の必須の同伴取得（Issue #959、ADR 0151 の 2026-09-27 追記）で対向として取られると、`memories`（または段4の `budget_dropped`）と `over_limit(stage:"association")` の両方に数えられていた。これを解消した。**

見つけた経緯: シードつきのランダムな操作列で不変条件を検査する使い捨ての検査器（Fake）が拾った。`over_limit(stage:"association")` の件数は、席が決まった時点（`recall-runtime.ts` の `overLimitAssociationCount`）で積まれる。Issue #959 の同伴の取得はその後に走るので、席を競り負けた候補が同伴として Unit に入っても、件数が直らなかった。**Issue #959 の修正（PR #970）が持ち込んだ二重計上である。**

### 決めたこと

追記4 が作った `overLimitAssociationSeatlessIds`（席に着けなかった候補の id）のうち、段3.5 の Unit（`associationUnits`）に入ったものを、`over_limit(stage:"association")` の `count` から差し引く。0件になれば Omission ごと外す。戻った先で返るか、予算で落ちて `budget_dropped` に数えられるかは問わない（追記3〜6 の「最後に落とした段で1回だけ数える」）。`over_limit(stage:"rescore")` と `below_threshold` の側は、追記4・追記6 の判定（`associationUnits` か `overLimitAssociationSeatlessIds` のどちらかに居れば差し引く）で既に1回だけ差し引かれているので、変えていない。

### 測ったこと

- 【実測】歯 `packages/core/src/__tests__/recall-association-seatless-companion.test.ts`（fake ストア、3本）: 修正前は (a)（席を競り負けた候補が同伴として返った）・(b)（同伴として取られた後に予算で落ちた）・(c)（同伴として取られていない候補は残る）の3本とも赤（(c) は二重計上で件数が 2 になる）。修正後は3本とも緑。
- 【実測】変異試験: 判定を「席に着けなかった分をすべて差し引く」にすると (c) だけが赤。
- 【実測】recall・omission まわりの既存の歯 33 ファイル（489本）をファイル名指定で実行し、すべて緑。
- **確かめていないこと**: 本物の Postgres での再現（判定は `packages/core` の中で完結する）。

Refs #1020

---

## 2026-09-27 追記8 の補足（クローン miku の委譲先、Issue #1026）

追記8（Issue #1020）と同じく、Issue #959 の段3.5 の必須の同伴取得（PR #970）まわりの取りこぼしである。番号は、同じ日に予定している追記9（集約の層と候補ごとの札の区別、Issue #1021・#1025）のために空けておき、追記8 の補足として記録する。

**段2で `over_limit(stage:"rescore")`（または `below_threshold`・`score_not_comparable`）に数えた contested の候補を段3.5 が席に着け、その後の必須の同伴取得で対向が取れずに Unit ごと落ちると、同じ記憶が段2の札と `unit_assembly_dropped` の両方に数えられていた。これを解消した。**

見つけた経緯: recall の不変条件を固定シードで検査する検査器（repo に入れる準備中、Fake）が、シード24・38 で拾った。排他性の後処理は、段3.5 の候補を「Unit に入った（`associationUnits`）」か「席に着けなかった（`overLimitAssociationSeatlessIds`）」かで差し引いていた。「席に着いたが組み立てで落ちた」候補はどちらにも入らず、段2の札に残っていた。

### 決めたこと

段3.5 の組み立てで落ちた候補の id を `associationAssemblyDroppedIds` に集め、`over_limit(stage:"rescore")`・`below_threshold`・`score_not_comparable` の差し引きの判定に OR で足した。最後にその候補を落とした段は段3.5 の組み立て（`unit_assembly_dropped`）なので、段2の札からは外れる（追記3〜8 の原則）。`unit_assembly_dropped` 自身の件数は変えていない。

### 測ったこと

- 【実測】歯 `packages/core/src/__tests__/recall-association-assembly-dropped.test.ts`（fake ストア、3本）: 修正前は (a)（`over_limit(rescore)` の候補が組み立てで落ちた）・(b)（`below_threshold` の候補が組み立てで落ちた）・(c)（連想枠に拾われなかった `over_limit(rescore)` の候補は残る）の3本とも赤（(c) は二重計上で件数が 2 になる）。修正後は3本とも緑。
- 【実測】変異試験: 落ちた id を集めないようにすると3本とも赤。
- 【実測】recall・omission まわりの既存の歯 36 ファイル（501本）をファイル名指定で実行し、すべて緑。
- **確かめていないこと**: 本物の Postgres での再現（判定は `packages/core` の中で完結する）。

Refs #1026
