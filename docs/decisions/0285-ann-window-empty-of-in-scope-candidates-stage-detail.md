# ADR 0285: ANN の候補枠が scope 内の候補を1件も拾えなかったことを stage detail に名乗らせる — `Omission` union は変えない（Issue #671）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-24

**⚠ 各主張の出所を分ける**（ADR 0111 / 0188 / 0193 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`vitest`/`tsc`/`eslint`/`prettier` 等を
  走らせて確かめた。
- **【受】** — Issue #671 に記録された実測（PostgreSQL 17.11 + pgvector 0.8.0 での
  HNSW 候補枠占有の再現）を、そのまま引用した（本 ADR の作業では再測していない）。

---

## 結論（先に）

[Issue #671](https://github.com/takecchi/mnemora/issues/671) は、他テナントの
near-duplicate が HNSW の候補枠（既定 `kPrime == hnsw.ef_search == 40`）を
埋め尽くすと、`runtime.recall()` が自テナントの候補を1件も見ないまま0件を返す
ことを実測している。このとき `omitted` に積まれるのは `ann_unreached` だけであり、
**`ann_unreached` は正常時（窓は満杯だが scope の候補は一部拾えている）にも
同じ形で鳴る**（[ADR 0193](./0193-ann-unreached-covers-full-window.md) が意図的に
広げた発火条件）。⟹ 「見つからなかった」（scope に本当に候補が無い）と
「探していない」（scope の候補を ANN が一度も見ていない）が、同じ `ann_unreached`
の顔で返る。これは `docs/north-star.md` 33行目「知らないことを、知らないと
言える。——『見つからなかった』と『探していない』を、同じ顔で返さない。」と
正面から食い違う。

**この ADR の決定は、`Omission` union（`packages/core/src/recall.ts`）に新しい
`kind` を足さず、`RecallResult.explain.stages` の ANN チャンネルの
`StageTrace.detail`（型無しの診断欄）へ `annWindowHadNoInScopeCandidates: true` を、
**条件が真のときだけ**足すことである（偽のときはキー自体を出さない）。条件は
`candidateGenerationExecuted && kPrime > 0 && eligible > 0 && annHits.length === 0`
——`ann_unreached` の前提（`candidateGenerationExecuted && kPrime > 0`）と揃え、
それに「scope は空ではない（`eligible > 0`）」「ANN が本当に1件も返さなかった
（`annHits.length === 0`）」を足した、`ann_unreached` より狭い条件。**新しい SQL
は足していない**——`eligible` と `annHits.length` は既存の計算（段5の
`aggregateScope` と ANN 段の `search()` 結果）をそのまま再利用する。**既存の
`ann_unreached` の発火条件・意味は1バイトも変えていない。**

**⚠ 「条件が真のときだけキーを出す」は、当初案（常に真偽値を出す）から PR の CI
実測を受けて直した設計である。**[ADR 0084](./0084-lexical-recall-channel.md) §6
は「既定（ANN 1本）のとき、`explain.stages` は ADR 0084 以前と1要素も1バイトも
変わらない」ことを明示的な決定として持ち（「新しい欄を常に足す案を落とした結果
である——足すと既定の `explain` が変わってしまう」、同 ADR 逐語）、
`packages/core/src/__tests__/recall-channels.test.ts` の歯②がこれを厳密な
`toEqual` で固定している。当初案（偽のときも `false` を出す）は既定経路の detail
に `annWindowHadNoInScopeCandidates: false` を常に足すため、既定経路の
`explain.stages` の形そのものを変え、歯②を機械的に壊す
——**ADR 0084 §6 が先にある決定であり、この ADR の側が合わせた。**詳細は §5
「引き受けた負債」4番。

---

## 1. 何が起きているか（Issue #671 の実測、抜粋）

【受、Issue #671】環境: PostgreSQL 17.11 + pgvector 0.8.0、GUC は既定
（`hnsw.ef_search=40` / `hnsw.iterative_scan=off` / `hnsw.max_scan_tuples=20000`）。
クエリ対象テナント（home）が10万行に育ちプランナが自然に HNSW を選ぶ規模で、
他テナントが gold より近い near-duplicate を40件（`kPrime` と同数）以上持つと:

| 条件                 | `memories` | gold     | `omitted`                                  |
| -------------------- | ---------- | -------- | ------------------------------------------ |
| near-dup 0件（正常） | 10件       | 10/10    | `over_limit(rescore, 30)`、`ann_unreached` |
| **near-dup 60件**    | **0件**    | **0/10** | **`ann_unreached` のみ**                   |

`tenant_id` の絞り込みは索引スキャンの**後**に効くため、HNSW が返す上位40件が
すべて他テナントの行だと、自テナントの候補は1件も窓に残らない。この状態と
「正常に探して本当に0件だった」状態は、`omitted` を見る限り**見分けが付かない**
——どちらも `ann_unreached` だけが積まれる。

`ann_unreached` の発火条件（`packages/core/src/recall-runtime.ts`、ADR 0193 で
拡張済み）:

```ts
candidateGenerationExecuted && kPrime > 0 && annHits.length < eligible;
```

`annHits.length < eligible` は「scope 内にまだ見られていない候補が残っている」
を意味する。**全滅時（`annHits.length === 0`）も正常時（`annHits.length > 0`
だが `eligible` に届かない）も、この1条件では区別できない。** ADR 0193 §8
「引き受けた負債」1番が既に指摘していた「`eligible` が `kPrime` を超えると
`ann_unreached` は実質毎回鳴る定型文になる」という懸念の、具体的な最悪ケースが
Issue #671 である。

---

## 2. 採った案・採らなかった案

### 2.1 採った案: `StageTrace.detail` へ診断キーを足す

`RecallStageName = 'candidate_generation' | ...` の ANN チャンネルの trace
（`detail.channel === 'ann'`）は既に `kPrime`・`hits`・`decayGate`・`clock`・
`validityGate` を持つ型無しの診断欄である（ADR 0084 §6）。ここへ
`annWindowHadNoInScopeCandidates: true` を、条件が真のときだけ足すことは:

- **公開型（`Omission` union・`RecalledMemory`・`RecallResult` の他のフィールド）
  を1つも変えない。** `StageTrace.detail?: Record<string, unknown>` は元々
  形の定まらない欄であり、キーの増減は型シグネチャに現れない
  （実測は §7「測ったこと」）。
- **`ann_unreached` の意味論・発火条件を変えない。** 別の判定として並べて
  いるだけで、既存の歯（ADR 0026 の歯B、ADR 0193 の歯C/D）は無傷のまま通る。
- **既定経路（channels 未指定・全滅していない通常の recall）の `explain.stages`
  を1バイトも変えない。** ADR 0084 §6 が「既定のとき `explain.stages` は
  ADR 0084 以前と1バイトも変わらない」ことを明示的に決定しており、
  `recall-channels.test.ts` の歯②がこれを厳密な `toEqual` で固定している
  ——**キーを条件付きで出す**（真のときだけ）ことで、全滅していない限り
  この決定と衝突しない。当初は「常に出す（false も出す）」案を採っていたが、
  歯②の CI 実測で衝突が判明し、この形へ直した（下の「これが覆るとしたら」
  ではなく、この ADR 自身の初稿の誤りの訂正である）。
- **⚠ 型無しの診断欄なので、`RecallOutputValidationMode`（`recall-output-validation.ts`）
  のような公開契約の対象にはならない。**呼び出し側がこのキーに依存するコードを
  書いても、`RecallResult` の zod スキーマはこれを検証しない——**「型で守られた
  契約」ではなく「デバッグ・監視のための添え書き」**である。この性質は
  `contradiction_resolution` の `detail.companionsAdded`（`docs/recall.md` 850行目）
  と同じ扱いに揃えている。

### 2.2 採らなかった案 (b-1): `Omission` union に新しい `kind` を足す

`Omission`（`packages/core/src/recall.ts:435` 付近）に、例えば
`{ kind: 'ann_window_exhausted_by_out_of_scope_rows', countKind: 'unknown' }`
のような新しい判別子を足し、呼び出し側が型で判定できるようにする案。

**却下（この ADR の範囲では）。**

- `Omission` は判別共用体（discriminated union）であり、新しい `kind` を足す
  ことは既存の網羅的な `switch`/`if` チェーンを壊しうる——これは
  [Issue #541](https://github.com/takecchi/mnemora/issues/541) が指摘している、
  **union 拡張を破壊的変更として数えるかどうかという未決の線**に直接依存する
  （#541 は `MemoryEventKind` の union 拡張が破壊的変更として一貫して数えられて
  いない非対称を指摘している——同じ論点が `Omission` にも当たる）。
- **この ADR は「バグ修正・診断の追加」の範囲に留め、公開 union の拡張方針という
  別の判断（#541 の線引き）にオーナー判断を仰ぐ方を選んだ。** 見送りであって
  却下ではない——§4「これが覆るとしたら」参照。
- ADR 0173 / ADR 0188 が採ってきた「次の一手が変わらない区別は増やさない」
  という基準にも照らした: `annWindowHadNoInScopeCandidates` が教える一手
  （「別の subject へ絞る」「厳密検索へフォールバックする」「近隣の
  near-duplicate を疑う」）は、公開 `Omission` の新しい `kind` にしなくても
  `explain.stages` を読めば得られる——**呼び出し側の主経路（`memories`/`omitted`
  を見るだけの経路）を壊さずに、詳しく見たい側にだけ手を伸ばさせる**設計に
  倒した。

### 2.3 採らなかった案: store 側（`VectorStore.search()`）で「絞り込みで落とした件数」を返す

`PostgresVectorStore.search()` が、ANN の候補枠のうち何件が scope 外（他
テナント等）の行に占められたかを実測して返す案。

**却下。**

- [ADR 0011](./0011-no-window-count-in-ann-stage.md) が実測している通り、
  HNSW の索引スキャン中に「窓の中身のうち scope 外が何件か」を厳密に数えようと
  すると、`count(*) OVER ()` と同じ事故になる——プランナは索引を捨てて
  Seq Scan + WindowAgg へ倒れるか（ADR 0011 分岐B）、索引を保てば返る件数は
  データと無関係な `hnsw.ef_search` 依存の値になる（ADR 0011 分岐A）。
  どちらも「正確な件数を安く得る」という前提を満たさない。
- [ADR 0024](./0024-remove-exact-counts-option.md) が同じ理由で
  `RecallQuery.exactCounts` を「予約」として残さず削除している——**測る手段が
  無いまま欄だけを用意すると、名乗りどおりの値を持たない欄が残る**という同じ
  失敗パターンになる。
- 本 ADR が採った条件（`eligible > 0 && annHits.length === 0`）は、**store を
  一切変えず**、core 側が既に持っている値（段1の ANN 結果件数、段5の scope
  集約）の比較だけで導ける。「scope 外の行が何件窓を占めたか」という**正確な
  内訳**は引き続き分からないままだが（ADR 0011 の限界そのもの）、
  「scope 内の候補が1件も窓に入らなかったか」という**2値の判定**には
  内訳を数える必要が無い——ここが store 側の変更を避けられた理由である。

---

## 3. 北極星の5つの問いに当てた結果

| 問い                                      | この判断にどう当たったか                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1**（量を減らす方向か）                 | `explain.stages` に真偽値1つが増えるだけ。`memories`/`omitted` の量・形は変わらない。                                                                        |
| **2**（無効にしても成立するか）           | 該当しない——`wantsAnn` が真の通常経路でしか関与せず、オプトインの機構を増減させない。既存の呼び出し側（このキーを読まないコード）は1バイトも影響を受けない。 |
| **3**（選ばれた理由を後から説明できるか） | **これが本題**。全滅と正常時の混同を、公開型を壊さずに説明可能にした。ただし「型で守られた契約ではない」という限界は §5 に明記する。                         |
| **4**（推論と事実を区別しているか）       | 該当する——`annWindowHadNoInScopeCandidates` は `eligible`/`annHits.length` という実測済みの件数の比較から導く事実の申告であり、推測を含まない。              |
| **5**（LLM を呼ばずに済ませられないか）   | 既存の比較演算を1つ足しただけ。DB 往復も LLM 呼び出しも増えない。                                                                                            |

### `docs/north-star.md`「目指す姿」6番目との対応

逐語（[docs/north-star.md](../north-star.md) 33行目）:

> **知らないことを、知らないと言える。**——「見つからなかった」と「探していない」を、
> 同じ顔で返さない。

`ann_unreached` 単体では、この2つが同じ顔（`omitted` に `ann_unreached` だけ）
で返る（§1）。本 ADR は `explain.stages` にもう1段深い顔を用意した——
`annWindowHadNoInScopeCandidates: true` が**在れば**「探していない」（scope の
候補を ANN が一度も見ていない）の側を指し、**キー自体が無ければ**「見つかったが
`eligible` に届かない」（正常時、または `eligible == 0` でそもそも探す対象が
無かった）の側を指す。**ただし ADR 0193 §8 と同じ限界を引き継ぐ**——
`explain.stages` を読まない呼び出し側にとっては、依然として `ann_unreached`
だけが見える顔のままである（§5「引き受けた負債」）。

---

## 4. これが覆るとしたら

1. **[Issue #541](https://github.com/takecchi/mnemora/issues/541) の線引き
   （union 拡張を破壊的変更としてどう扱うか）が決まったとき。** 決まった線が
   「診断的な `kind` の追加は許容範囲」だと判断されれば、`annWindowHadNoInScopeCandidates`
   相当の情報を `Omission` の新しい `kind`（b-1）へ昇格させる方が、呼び出し側に
   とって `explain.stages` を読まなくてよい分だけ発見しやすくなる。**この ADR の
   決定はそのときのための土台**——条件式（`eligible > 0 && annHits.length === 0`）
   は既にここで確定しているので、昇格する際に新しい判定ロジックを作り直す
   必要は無い。
2. **`explain.stages` を読む呼び出し側が実際に現れ、`detail` の型無し性
   （zod で検証されない）が実運用で問題になったとき。** そのときは
   `StageTrace.detail` 全体、あるいは ANN チャンネルの detail だけでも
   型付きスキーマへ昇格する設計判断が要る——本 ADR の範囲外。
3. **store 側（`PostgresVectorStore`）で「窓の内訳」を安価に数える手段が
   新しく見つかったとき**（例えば pgvector 側の将来のバージョンが
   `EXPLAIN` 相当の情報を安価に返す拡張を持つ場合）。そのときは §2.3 の
   却下理由（ADR 0011 の実測）自体を作り直す必要がある——現時点ではその
   手段は無い。

---

## 5. 誰が壊れうるか / 引き受けた負債

**⛔ 以下は「問題ない」と断定しない。正直に負債として書く。**

1. **`explain.stages` を読まない既存の呼び出し側（`memories`/`omitted` だけを
   見る経路）にとっては、Issue #671 の全滅と正常時は依然として区別できない
   ままである。** 本 ADR は「区別する手段を追加した」のであって、「既定で
   区別が見える」ようにはしていない——`omitted` だけを見る呼び出し側（例えば
   `examples/chat`）は、この ADR の後もこの区別を利用しない。
2. **`StageTrace.detail` は zod で検証されない型無しの欄である。**
   `annWindowHadNoInScopeCandidates` というキー名の綴りや値の形（boolean）が
   将来変わっても、`RecallOutputValidationMode` はそれを検出しない——公開型の
   破壊的変更としては現れないが、**事実上の契約変更が静かに起こりうる**という
   一般的なリスクを、この欄の性質としてそのまま引き継ぐ（`companionsAdded` と
   同じ性質、新しく持ち込んだものではない）。
3. **b-1（`Omission` の新しい `kind`）を見送ったことで、Issue #541 の線引きが
   長期間決まらなければ、この情報は `explain.stages` に留め置かれたままになる。**
   §4-1 の「これが覆るとしたら」が実現しない限り、呼び出し側にとっての
   発見しやすさは今のままである。
4. **「キーが在れば true、無ければ偽」という表現は、同じ ANN チャンネルの trace が
   既に持つ他の欄（`decayGate`・`validityGate` は常に在り、値そのもので状態を
   名乗る）と作法が非対称である。** ADR 0084 §6 の「既定経路は1バイトも変わら
   ない」という決定を優先した結果、この欄だけ「値の有無」で状態を名乗る形に
   なった——呼び出し側が `detail.annWindowHadNoInScopeCandidates === false` を
   期待するコードを書くと、全滅していない場合に `undefined` を受け取り、
   期待どおりには判定できない（`!== true` あるいは `?? false` で読む必要が
   ある）。この非対称は正直に負債として残す——ADR 0084 §6 と両立する形を
   優先した結果であり、解消していない。
5. **`detail` のペイロードが増えるのは全滅時（`annWindowHadNoInScopeCandidates: true`
   が付く経路）に限られる。** ADR 0193 §8-4 が `recall-footprint.ts`・
   `examples/chat` の費用への影響が無いことを確認したのと同じ理由
   （`omitted`/`ann_unreached`/`ann_truncated` を参照する経路のみが費用計算に
   影響し、`explain.stages` の detail は参照されない）で、本 ADR でも影響は
   無いと考えているが、**この ADR の作業では `recall-footprint.ts` を改めて
   読み直していない**——ADR 0193 の実測からの外挿であり、確かめていない
   （§7「確かめていないこと」）。

---

## 6. 決めたこと（実装）

1. `packages/core/src/recall-runtime.ts`: ANN チャンネルの `candidate_generation`
   trace を `let annStageTrace: StageTrace | undefined` に保持し、既存の
   `ann_unreached` 判定の直後で、その判定を変えずに、**条件が真のときだけ**
   `annStageTrace.detail.annWindowHadNoInScopeCandidates = true` を追記する
   （偽のときは detail に触れない）。push する場所・順序・既存の detail キーは
   1つも変えない。
2. `packages/core/src/__tests__/recall-pipeline.test.ts`: 新しい `describe` を
   1本追加——陽性（ANN 0件・`eligible > 0`、キーが `true`）、対照A（正常時、
   キー自体が無い）、対照B（`eligible == 0`、キー自体が無い）の3歯。
3. `docs/recall.md` の `ann_unreached` の説明（行377付近）に、この ADR を指す
   追記を足す（型例・既存の記述は書き換えない）。
4. `CHANGELOG.md` の既存の未リリース節に1行足す（新しい版の節は起こさない）。

---

## 7. 測ったこと

- 【実測】`pnpm --filter @mnemora/core run typecheck`: 緑。
- 【実測】`npx eslint packages/core/src/recall-runtime.ts
packages/core/src/__tests__/recall-pipeline.test.ts`: 差分無し。
- 【実測】`npx prettier --check` 同2ファイル: 差分無し。
- 【実測】`pnpm --filter @mnemora/core exec vitest run
src/__tests__/recall-pipeline.test.ts src/__tests__/recall-channels.test.ts`:
  2ファイル・92件すべて緑。
- 【実測】公開 API 表面の門（[ADR 0178](./0178-public-api-surface-gate.md)、
  `node scripts/check-public-api-surface.mjs`）: 6パッケージすべて build した
  うえで実行し、`@mnemora/core` を含む全パッケージが「差分なし」。
  `StageTrace.detail` は元々 `Record<string, unknown>` 型であり、キーの追加は
  `.d.ts` シグネチャに現れないことを、この実測で裏付けた。
- 【実測】**当初案（常に真偽値を出す）は、CI の実際の赤で見つかった。**
  PR #672 の CI 実行（`typecheck / lint / test / build` ジョブ）が
  `packages/core/src/__tests__/recall-channels.test.ts:452`・`:480`
  （歯②「既定は ADR 0084 以前と1バイトも変わらない」、厳密な `toEqual`）で
  落ちた。原因は当初案が既定経路の ANN detail に
  `annWindowHadNoInScopeCandidates: false` を常に足していたことで、
  この2箇所を個別に実行して再現を確認した後、§2.1 の決定（条件が真のときだけ
  キーを出す）へ直した。**この PR 自身のローカル実行（`vitest run
recall-pipeline.test.ts`）は元々この衝突を検出していなかった**
  ——`recall-channels.test.ts` を一緒に走らせていなかったため。⟹ 「関係する
  テストファイルを個別に走らせる」だけでは、**どのファイルが『関係する』かの
  見積もりを誤ると取りこぼす**という実例がここに残る（下の「これが覆るとしたら」
  ではなく §8「確かめていないこと」に近い教訓——網羅を主張しない）。
- 【実測】変異試験（`git checkout` は使わず、`cp` で退避・復元。直した後の形で
  やり直した）:
  1. **変異1**（ガードを `annStageTrace !== undefined` だけに緩め、常に
     `true` を足す）: `recall-pipeline.test.ts` の対照A・対照Bが赤くなった
     （`expected [...] to not include 'annWindowHadNoInScopeCandidates'`）。
     **併せて** `recall-channels.test.ts` の歯②2本（`:452`・`:480`）も赤く
     なることを確認した——CI が実際に検出した経路と同じ歯が、変異試験でも
     同じ理由で落ちることを裏付けた。
  2. **変異2**（`if` の条件を `if (false)` に固定し、キーを一切出さない）:
     `recall-pipeline.test.ts` の陽性が赤くなった
     （`expected {...} to match object {annWindowHadNoInScopeCandidates: true}`）。
  3. 各変異後 `cp` で復元し、`diff` で1バイトも残っていないことと、
     `git status --porcelain` が空になることを確認したうえで、対象の歯が
     緑に戻ることを実測した。

---

## 8. 確かめていないこと

- **Issue #671 の実測（HNSW の候補枠が他テナントの行で埋まり全滅する）そのものを、
  本 ADR の作業で再現していない。** Issue #671 の実測をそのまま引用した
  （【受】）——本 ADR が足すのは `annWindowHadNoInScopeCandidates` という
  診断キーであり、Issue #671 が指摘する根本原因（`hnsw.iterative_scan` の
  既定値、`kPrime == ef_search` の余裕の無さ）には触れない。根本原因側の
  対応は PR 1（`hnsw.iterative_scan=relaxed_order` を `search()` に入れる案、
  ADR 0284（PR 1、未マージ）が検討している）の射程であり、**本 ADR の決定は
  PR 1 の有無に関係なく単独で成り立つ**——`annWindowHadNoInScopeCandidates` は
  `hnsw.iterative_scan` の設定値に依存せず、`eligible`/`annHits.length` の
  比較だけで決まる。
- **`recall-footprint.ts`・`examples/chat` への費用影響**——ADR 0193 §8-4 の
  実測（`omitted`/`ann_unreached`/`ann_truncated` を参照する経路のみが影響し
  `explain.stages` の detail は参照されない）からの外挿であり、本 ADR の
  作業で `recall-footprint.ts` を改めて read し直してはいない。
- **本番規模での `eligible > 0 && annHits.length === 0` の発生頻度**——
  Issue #671 は合成データでの最悪ケースを実測しているが、実際のテナントの
  scope 分布でこの条件がどれだけ発生するかは測っていない（ADR 0193 §10 と
  同じ限界）。
