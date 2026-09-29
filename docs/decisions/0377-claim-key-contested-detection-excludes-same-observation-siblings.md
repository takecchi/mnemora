# ADR 0377: claim key の衝突検出は、同じ observation（＝同じ発話）から抽出された兄弟 Memory どうしを一致から除く（Issue #835 候補1）

- **状態**: 採用 (2026-09-29)
- **日付**: 2026-09-29

> **⚠ これはクローン miku の判断であり、オーナーの判断ではない。**本文はクローン miku の委譲先が書いた
> （ADR 0220）。案の選択（候補1を採る、store 側の型・実装は変えない、`findActiveByClaimKey?` の
> interface の TSDoc に前提を注記する）はクローン miku の委譲先が決めた。

---

## 文脈

[Issue #835](https://github.com/takecchi/mnemora/issues/835) は、claim key の衝突検出
（`ClaimKeyOptions.detectContested`、ADR 0324）を opt-in で有効にしたときに起きる2つの
症状を扱っている。本 ADR は、そのうち U2（同 issue のコメント
[5860966614](https://github.com/takecchi/mnemora/issues/835#issuecomment-5860966614)
「時期だけが違う2文」）を直す**候補1**（同コメントの選択肢表・案 (c)「検出の側で、
同じ観測（同じ発話）から出た2件どうしは contested にしない」）を実装したものである。
U1（語彙ヒントの吸い寄せ）は本 ADR の対象外——下の「効かないもの」を見ること。

### 機序: `8c45801`（PR #1318、ADR 0347）の2ループ化

`createMemoriesFromCandidates`（`packages/core/src/runtime.ts`）は、1回の `observe()` が
複数の候補を抽出したとき、以前は候補ごとに「書く → `created` イベントを積む →
（opt-in なら）`detectClaimKeyContested` を呼ぶ」を1件ずつ繰り返していた。
`8c45801`（PR #1318、[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md)
決定4）が、これを「**全件を書いてから**、書けた全件について `created`/検出を行う」の
2ループへ分けた——決定4 の逐語は「候補を全件書いてから `created` を積む（落とした候補は、
全件を書き終えるまで分からないため）」であり、**候補の書き込みと検出の分離は決定4の
意図した変更ではなく、書き込みループを分けたことの副作用**である。

この分離の結果、同じ observation（＝同じ `observe()` 呼び出し）が生んだ兄弟 Memory は、
検出ループに入る時点で**互いにもう `active`** になっている。`detectClaimKeyContested`
は `MemoryStore.findActiveByClaimKey?` で同じ claim key・重なる有効期間・違う
`contentHash` を持つ `active` な Memory を探すので、兄弟どうしも一致に混入する。これが
2つの症状を生む:

- **(a) 誤検出**: 1回の `observe()` が同じ claim key の2件を生むと（例:
  「去年は札幌で働いていた。今年は福岡で働いている。」——`answer-case-set.dev.ts` の
  `other-period-city-this-year`）、互いが `matchCount: 1` の一致として現れ、訂正でも
  何でもないのに `contested` になる。**この症状自体は `8c45801` より前から在った**
  （下の「陽性対照」参照。ADR 0329 の追記〔2026-09-25〕・
  [issue コメント 5841326189](https://github.com/takecchi/mnemora/issues/835#issuecomment-5841326189)
  「2. 札幌と福岡…opt-in の中では直せない」が同じ現象を、既定の claim key プロンプトの
  性質として先に記録している）。
- **(b) 退行**: 先行 observe が作った Memory M1 が在るとき、後続の1回の `observe()` が
  同じ claim key の2件（訂正の新値と、旧値の言い直し）を生むと、一致が
  `[M1, 兄弟]` の2件になる。`detectClaimKeyContested` は一致が2件以上のとき
  `markContested` を一切呼ばない（[ADR 0324](./0324-claim-key-contested-detection.md)
  決定5・決定6）ので、**M1 は訂正されているのに `contested` にならない**。
  `negation-moved-city`・`schedule-change-deadline` が記録の再生
  （`answer.claim-key.known-predicates-{1,2,3}.json`）で訂正 4/4 → 2/4 に落ちた
  （下の「陽性対照」参照）。**この症状は `8c45801` が導入した退行である**——
  1ループ時代（`f7c8d1e`、`8c45801` の親）では、兄弟の書き込みと検出が交互に起きるため、
  2件目の兄弟が書かれる前に1件目の兄弟がもう M1 と対になって `contested`（＝非
  `active`）になっており、一致が2件に膨らまない。

### 実測: `f7c8d1e` → `8c45801` で 4/4 → 2/4

【実測】bisect 用の worktree（`8c45801` の上に構築済み、`f7c8d1e` へ `git checkout --detach`
で移動）で、本 ADR の (R) 回帰の歯（下の「陽性対照」参照）を both commit へ当てた:

| commit | 位置づけ | (R) の結果 |
|---|---|---|
| `f7c8d1e` | `8c45801` の親（1ループ時代） | 緑（1 passed） |
| `8c45801` | PR #1318（ADR 0347、2ループ化） | 赤（`matchCount` が期待の1でなく2。M1 は `active` のまま） |

`negation-moved-city`・`schedule-change-deadline` の記録の再生での 4/4 → 2/4 の実測は
[issue コメント 5860966614](https://github.com/takecchi/mnemora/issues/835#issuecomment-5860966614)
「今の main で症状が出るか【実測 2026-09-28、main `151e3d1`】」の表に在る
（種 = `answer.claim-key.known-predicates-{1,2,3}.json`、`{ enabled: true,
detectContested: true, knownPredicatesFromStore: true }`、訂正4件・誤検出2件の対象で
訂正 `contested` 4/4 ×3——ただし対象は「訂正が成立したか」であり、`negation-moved-city`・
`schedule-change-deadline` 個別の 2/4 への退行は、上記 issue コメントより前の bisect 調査
（このマネージャー系列の前段の担い手の実測、本文の引用元は同コメント本文の記述）で
特定された）。

## 決定

### 決定1: `Runtime.detectClaimKeyContested`（core 側）で、一致から同じ observation の兄弟を除く

`packages/core/src/runtime.ts` の `detectClaimKeyContested` は、`findActiveByClaimKey` が
返した一致（`rawMatches`）から、**検出中の Memory と同じ `sourceObservationId` を持つもの
を、件数を数える前に除く**:

```ts
const memorySourceObservationId = memory.sourceObservationId ?? null;
const matches =
  memorySourceObservationId === null
    ? rawMatches
    : rawMatches.filter((m) => (m.sourceObservationId ?? null) !== memorySourceObservationId);
```

- **`memory.sourceObservationId` が `null` のときは何も除かない。** `null` は
  「observation を持たない」（例: `reextract`/`consolidate`/`reflect` が作る Memory、
  ADR 0324 負債3）という意味であり、「observation 0番」ではない——`null` 同士を
  「同じ観測」と見なすと、observation を持たない Memory どうしを不当に無関係化する。
- 除いた後の件数で、今までどおり 0/1/2+ の3分岐（ADR 0324 決定5）を行う。

### 決定2: `MemoryStore.findActiveByClaimKey?` の型・Postgres 実装・testkit は変えない

除外は呼び出し側（`Runtime`）だけで行い、`findActiveByClaimKey?` の interface（型）・
`@mnemora/postgres` の実装・`packages/testkit` の in-memory 実装には**手を入れない**。

**理由**:

1. **外部 adapter への要求を増やさない。** `findActiveByClaimKey?` は任意メソッドであり、
   第三者が実装している可能性がある（`@mnemora/core` は npm 公開済み）。契約に
   `sourceObservationId` での絞り込みを追加すると、既存の実装がこの絞り込みを持たない
   限り、黙って古い（過検出の）振る舞いのまま残る——`AGENTS.md`「機械には検出まで」の
   精神には反しないが、「口を変えたのに一部の adapter にだけ効く」という非対称を
   増やす。core 側で除外すれば、どの adapter でも同じ後処理が効く。
2. **`findActiveByClaimKey?` の契約はもともと `Memory[]` の配列を返す**
   （`packages/core/src/memory.ts` の `Memory` 型は `sourceObservationId` を持つ、
   `postgres/src/mapping.ts` の `mapMemoryRow` も testkit の実装も、この欄を
   `active` な行から常に埋めて返す）。**呼び出し側が返り値から後処理で絞るのに
   必要な情報は、契約を変えなくても既にすべて揃っている。**

### 決定2の限界: store 側が独自に `LIMIT` を付けると、この除外は効かないことがある

`findActiveByClaimKey?` の契約に `LIMIT` の規定は無い（「返す順序は規定しない」だけで、
返す**件数**の上限には触れていない）。**このため store 側の除外（本 ADR が採らなかった
案）ではなく core 側の除外を選んだこと自体は、正しさを損なわない**——core は
`rawMatches` の**全件**を受け取り、その全件から後処理で除くので、`LIMIT` の有無に
関わらず正しく除ける。

一方で、**この decision2 の理由1（「口を変えなくても、どの adapter にも同じ後処理が
効く」）には、`LIMIT` に関する暗黙の前提がある**——「`findActiveByClaimKey?` が返す件数
そのものが、除外の**前**（＝一致の全件）である」という前提である。もし将来、ある
adapter が独自の判断で `findActiveByClaimKey?` に `LIMIT`（例: 上位N件だけ返す）を
つけた場合、その adapter が返す `rawMatches` が既に一部の一致を欠いていれば、core 側の
除外はその欠けた集合に対してしか働けない——**interface 自体は adapter が独自に
`LIMIT` を付けることを禁じていない**。今のところ `@mnemora/postgres`・testkit の
どちらも `LIMIT` を付けていない（`packages/postgres/src/memory-store.ts` の
`findActiveByClaimKey` 実装を読んで確認した。【現物】）ので、この限界は今は顕在化していない。

### 決定3: `findActiveByClaimKey?` の interface の TSDoc に、core 側の前提を注記する（型は変えない）

`packages/core/src/interfaces/memory-store.ts` の `findActiveByClaimKey?` の doc
コメントに、「この口自体は `sourceObservationId` で絞らない」「呼び出し側
（`Runtime.detectClaimKeyContested`）が返り値から同じ observation の行を除く前提で
実装されている」「`LIMIT` の契約が無いのでこの前提は保てるが、adapter が独自に
`LIMIT` を付ける自由までは禁じていない」という3点を注記した。**型・契約の文言（何を
返すか）自体は1バイトも変えていない**——注記は「呼び出し側がどう使うか」を書いた
補足であり、adapter に新しい義務を課すものではない。

**注記するかどうか自体を判断した**（マネージャー指示の「必要なら注記するかを判断し、
その判断も ADR に書く」）: 注記しない案も検討したが、決定2の限界（`LIMIT` を付ける
adapter が現れた場合に何が起きるか）を、この口の doc から辿れる形にしておくほうが、
将来 adapter を書く・読む人にとって説明可能性（北極星 問い3）が高いと判断し、注記する
側を採った。

## 失うもの

**1つの発話の中の言い直し**（例: 「すみません、やはり金曜日ではなく水曜日でお願い
します」のような、同じ発話の中で新値と旧値の両方に触れる訂正）が、抽出で**2件の候補
に分かれ**、かつ**たまたま同じ claim key に当たった**場合、決定1の除外により、今後は
互いに `contested` にならない。これは同じ observation の兄弟なので、決定1がまさに
「兄弟どうしを対にしない」ために入れた除外の対象になる。

**これは意図して受け入れた損失である。** 候補1（本 ADR）以外の選択肢
（issue コメント [5860966614](https://github.com/takecchi/mnemora/issues/835#issuecomment-5860966614)
の U2 選択肢表、案 (a) 抽出で相対期間を `validFrom`/`validUntil` に入れる・案 (b) 既定の
claim key プロンプトに「時期の違う主張は別の predicate にする」を足す）は、どちらも
**既定の経路**（抽出プロンプト、または claim key の既定プロンプト）を変える——
案 (b) は ADR 0329 の追記〔2026-09-25〕・issue コメント
[5841326189](https://github.com/takecchi/mnemora/issues/835#issuecomment-5841326189)
が実測した4変種（v1〜v4）と同じ失敗の形（否定を伴う訂正 `negation-moved-job` を取りこぼす）
に陥る危険が高い。候補1は既定の経路を1バイトも変えず、opt-in の `detectContested` の
結果だけを変えるので、この危険を引き受けない代わりに、上の損失を引き受ける。

### 実際の14件（`answer-case-set`）への影響は無いことを確かめた

測定対象14件（`examples/chat/src/answer-case-set.dev.ts`・`.eval.ts`）のうち、1つの発話の
中で新値と旧値の両方に触れる候補は `schedule-change-meeting-day`
（「すみません、やはり定例会議は水曜日に移してください。金曜日は都合が悪くなりました。」）
だけである。この発話は抽出で**1件の候補**にまとまり（下の実測）、旧値（金曜日）は
**別の observation**（同じ会話の turn 0、「来週の定例会議は金曜日にお願いします。」）に
在る記憶と対になる。したがって、このケースは決定1の除外の対象にならず、訂正の
`contested` 成立は今までどおり保たれる。**14件の中に、本 ADR の損失が実際に現れる
ケースは無い**（測定した範囲で。将来の会話・ケース追加では起こりうる）。

【実測 2026-09-29、実装枝、`initdb` で立てた自分専用の Postgres】本 ADR の実装枝の上で、
`examples/chat/src/scripts/measure-claim-key-835.ts`（追跡外の測定スクリプト、bisect調査で
作られたものを対象6件・訂正4件+誤検出2件へ広げた版）を、種カセット
`answer.claim-key.known-predicates-{1,2,3}.json` に対して seed 1〜3 の3回実行した
（`OPENAI_API_KEY` はダミー文字列、`{ enabled: true, detectContested: true,
knownPredicatesFromStore: true }`）:

| ケース | seed1 | seed2 | seed3 |
|---|---|---|---|
| `schedule-change-meeting-day`（1件の候補にまとまる） | contested | contested | contested |
| `negation-moved-city` | contested | contested | contested |
| `schedule-change-deadline` | contested | contested | contested |
| `negation-moved-job` | contested | contested | contested |
| `other-period-city-this-year`（2件の候補、同じ observation） | active/active（no_conflict） | active/active（no_conflict） | active/active（no_conflict） |
| `unknown-favorite-number`（2件の候補、別 observation） | contested | contested | contested |

訂正4/4 ×3・`other-period-city-this-year` の誤検出は3回とも消え・`unknown-favorite-number`
の誤検出は3回とも残った——「効かないもの」節の予想どおりである。

⚠ **`real=0` は確認できなかった。**3回とも `LLM seed=37 real=2`
（embedding は3回とも `real=0`）。real になった2件は、いずれも
`other-period-city-this-year` の turn#2・turn#4（filler「新しい趣味を始めようと
思っている」「相談したいことがある」）の claim key 派生呼び出しであり、種カセット
（`answer.claim-key.known-predicates-{1,2,3}.json`）にヒットしなかった——ダミーの
API キーで 401 になり、`claimKeyFailure` として捕まった（`observe()` 自体は例外に
ならない。claim key が付かないので検出は試みられない）。

**原因は実行順ではない。原因は、本 ADR の決定1が直した対象そのもの
（Sapporo/Fukuoka の `work_location`）が、後続の filler の語彙ヒントに新しく
入ってきたことである。**

【実測 2026-09-29、実装枝、`OpenAILLMProvider.prototype.complete`/`completeStructured`
を一時的に monkey-patch して 401 に落ちる直前の `PromptSpec.system` を横取りする
追跡外の確認スクリプト（`measure-claim-key-835-mgr-check.ts`、コミットしていない）を
seed 1〜3 で実行】real になった2呼び出しが実際に送ろうとした system プロンプトは、
3シードすべてで「既知の predicate 候補一覧: `work_location`」の1語だけだった
（`deriveClaimKeys` が turn#0 で Sapporo/Fukuoka に割り当てる predicate 名は LLM 呼び出し
ごとに揺れる——seed 1・3 は `work_location`、seed 2 は `working_location`——が、
**語彙ヒントが1語だけで、その1語が turn#0 の work_location 系 predicate である**という
構造は3シードとも同じだった）。

機序は `listActiveClaimPredicates`（`packages/postgres/src/memory-store.ts`、
`status = 'active'` の predicate だけを返す）である。turn#0 の直後、決定1（本 ADR）の
除外により Sapporo/Fukuoka の2件は互いに `contested` にならず**両方とも `active` の
まま残る**——このため turn#2 以降の `listActiveClaimPredicates` がこの predicate を
拾い、無関係な filler の語彙ヒントへ加える。

対して `answer.claim-key.known-predicates-{1,2,3}.json`（3ファイルとも）には、
この2つの filler の claim key 派生呼び出しに `work`/`working` を含む語彙ヒントが
付いた記録が1件も無い（3ファイル全体を `work`（大小無視）で機械的に検索して確認——
【現物】）。**理由**: この3ファイルを記録した時点の main は、既に本 ADR の (a) の
誤検出を持っていた——turn#0 で Sapporo/Fukuoka が互いを誤って `contested`
（非 `active`）にしていたため、記録時点では turn#2 以降の
`listActiveClaimPredicates` が常に空を返していた（記録に残る該当呼び出しは、
語彙ヒントの無い system プロンプトである）。**⟹ 本 ADR が (a) を直した副作用として、
Sapporo/Fukuoka が `active` のまま残るようになり、後続の filler 2ターンの語彙ヒントが
記録と食い違うようになった——候補1が意図どおりに効いた結果である。**

**headline の結果（上の表）には影響しない**——real になった2ターンは対象の claim key
（`work_location`）を持たない filler であり、訂正4件・`other-period-city-this-year`
のターン0（実際に測りたい対）は3回とも種カセットにヒットしている。

**確かめていないこと**: 401 で claim key 派生が落ちたこの2ターンは、`claimKeyFailure`
を持ったまま claim key 無し（`claim_key_subject`/`claim_key_predicate` とも `NULL`）で
保存され、`detectClaimKeyContested` 自体が呼ばれない（`contestedDetection: []`）。
**この2つの filler が、候補1の適用後に実 API の下で互いに `contested` になるかどうかは、
この記録の再生では判定できていない。**issue コメント
[5860966614](https://github.com/takecchi/mnemora/issues/835#issuecomment-5860966614)
が実 API（gpt-4o-mini、main、3回中2回）で観測した「filler どうしの対の成立」に相当する
事象が候補1の適用後も起きるかは、実 API を当てないと分からない——ダミー鍵での記録の
再生は、この2ターンについては構造的に判定できない（両方とも claim key 自体が
付かないため）。

## 効かないもの

- **`unknown-favorite-number`（U1、語彙ヒントの吸い寄せ）は残る。** 「新しい趣味を
  始めようと思っている」「旅行の計画を立てている」は**別々の turn＝別々の
  observation**なので、決定1の除外の対象にならない。issue コメント
  [5891683180](https://github.com/takecchi/mnemora/issues/835#issuecomment-5891683180)
  （本 ADR の直前のコメント）が実測したとおり、**候補2「語彙ヒントに下限を置く」は
  今回は採らない**——下限をどこに置いても、訂正を助けている場面（`negation-moved-city`
  の語彙1語で predicate が一致する場面）と、誤検出を起こす場面（`unknown-favorite-number`
  の語彙1語で無関係な filler が吸い寄せられる場面）を、語彙の数という軸では分けられない
  ことが記録済みカセットの読み取りで分かっている。U1 は本 ADR の対象外のまま残る
  （issue #835 の未決 U1 として）。
- **filler どうしの誤った対（issue コメント 5860966614 の「3回目は…filler どうしの対も
  成立」）も、別 observation どうしなら残る。** 同じ理由。

## 陽性対照

**core の Fake（`packages/core/src/__tests__/claim-key-same-observation-not-contested.test.ts`、
新規）で3点＋(a) を取った。**

| 歯 | 対象 | 結果 |
|---|---|---|
| (R) 回帰の歯 | `8c45801`（bisect worktree、detached） | 赤（`matchCount` 期待1、実測2。M1 は `contested` にならない） |
| (R) 回帰の歯 | `f7c8d1e`（`8c45801` の親、detached） | 緑（1 passed。API の調整は不要だった） |
| (R) 回帰の歯 | 本 ADR の実装枝 | 緑 |
| (a) 誤検出の歯 | `main`（`82a6785`） | 赤 |
| (a) 誤検出の歯 | 本 ADR の実装枝 | 緑 |

コマンド（bisect worktree、`/tmp/.../wt-bisect` に歯を追跡外でコピーして当てた）:

```
pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/claim-key-same-observation-not-contested.test.ts -t "回帰の歯"
```

既存の歯（`packages/core/src/__tests__/runtime.test.ts`・
`claim-key-sequential-arrival.test.ts`・`fake-memory-store-tsdoc-edges-round3.test.ts`・
`memory-model-doc-detect-contested-default.test.ts`、計 159 件）は実装枝ですべて緑
——(c) 別観測2件の contested・(d) 既定経路（`detectContested` を渡さない/渡しても
`findActiveByClaimKey` が0回しか呼ばれない）が壊れていないことを、既存の歯で確認した
（新規の歯は追加していない——マネージャー指示「既存の歯で足りればそれを示す」）。

## これが覆るとしたら

- U1（語彙ヒントの吸い寄せ）を直す案が採られたとき、本 ADR の「効かないもの」は変わる。
- [Issue #207](https://github.com/takecchi/mnemora/issues/207)（`memory_relations`、
  多対多）が実装され、ADR 0324 決定5・決定6 の「一致件数2+では `markContested` を呼ばない」
  が変わったとき、決定1の除外の意味も変わりうる（2+ の分岐先が変わるため）。
- `findActiveByClaimKey?` の第三者実装が実際に `LIMIT` を付けていることが分かったとき、
  決定2の限界が顕在化する——そのときは store 側への押し下げ（決定2で採らなかった案）を
  再検討する。

## 確かめていないこと

- **実 API（gpt-4o-mini）での確認。** 本 ADR の陽性対照は core の Fake（決定的な
  LLM スタブ）だけで取った。記録の再生（seed 1〜3）は行ったが、実 API そのものへは
  当てていない。
- **`@mnemora/postgres`・testkit の適合テストでの確認。** `findActiveByClaimKey?` の
  2実装（Postgres・testkit の in-memory fixture）に対する専用の歯は追加していない
  ——決定1が `Runtime`（core）側だけの変更であり、店側の型・実装を変えていないため、
  既存の適合テスト（`conformance.postgres.test.ts` 等）が緑のままであることは typecheck
  と既存の歯の再実行で確認したが、`findActiveByClaimKey?` を実際に呼ぶ Postgres の
  統合的な歯（`claim-key-sequential-arrival.postgres.test.ts` 等）で、本 ADR の
  シナリオ（同じ observation の兄弟2件）そのものを再現する専用の歯は追加していない。
- **並行の2本の観測**（`ADR 0347`「追記」の並行 extract と同じ形）が claim key 検出と
  絡んだときの振る舞い。本 ADR は触れていない。
- **U3・U4**（issue #835 の未決点、回答の質への影響・`[矛盾候補:]` の確度）は本 ADR の
  範囲外。
- **`other-period-city-this-year` の filler 2件（turn#2・turn#4）が、候補1の適用後に
  実 API の下で互いに `contested` になるか。**上の「測ったこと」節のとおり、記録の
  再生ではこの2件の claim key 派生がダミー鍵の 401 で落ち、claim key 自体が付かない
  （`detectClaimKeyContested` が呼ばれない）ため、この記録の再生では構造的に判定
  できない。

## ADR 0324 決定5・決定6 との関係

ADR 0324 決定5・決定6 は「`findActiveByClaimKey` の一致件数で0/1/2+の3方向に分岐する」
ことを決めている——**本 ADR は、その分岐先（0/1/2+ のどれになるか）を変える**。決定1の
除外により、同じ observation の兄弟は「一致」として数えられなくなるので、**同じ状況
（先行 Memory 1件 + 今回の2兄弟）でも、以前は 2+（`unresolved_conflict`、決定6）に
分岐していたものが、今は 1（`contested`、決定5）に分岐する**（上の「機序」節の症状(b)）。
ADR 0324 決定5・決定6 が定めた**分岐そのもの**（0/1/2+の3方向とその扱い）は変えていない
——**何を「一致」として数えるか**が変わるだけである。
