# ADR 0358: `LocalEmbeddingProvider` は既定で128件を超えるバッチを分割する（Issue #1141）

- **状態**: 採用 (2026-09-29)
- **日付**: 2026-09-29

> **⚠ この判定は、自動化された担い手（クローンのマネージャーのセッションから委譲された、
> クローン miku の委譲先）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)・
> [ADR 0253](./0253-local-embedding-weights-fingerprint-gate.md) の同種の注記と同じ——
> repo 上の署名だけではオーナー本人と区別が付かない。
> **この決定を担い手が自分で下してよい根拠は
> [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)** である。
> 方向そのものの変更が要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0253 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で node を走らせて確かめた。
- **推測** — 出所を明示していない考察・見立て。

---

## 文脈

[Issue #1141](https://github.com/takecchi/mnemora/issues/1141) が名指しした問題【現物・要約】:
`LocalEmbeddingProvider.embed(ctx, texts)`（`packages/local-embedding/src/local-embedding-provider.ts`）は、
受け取った配列を**分割せずに1回で推論する**。peak RSS は1回に渡す件数にほぼ比例して増え、
件数が大きいと数GB規模になりうる。

この ADR に先立って、前提確認（実測の再現・runtime の呼び方・既存の門/歯への影響範囲の
確認）を別途行った。その結果を含めて、以下に記録する。

---

## 測ったこと

### 1. Issue が引く実測は、既に `packages/local-embedding/README.md` に書かれていた【現物】

README「良くなること」節（2026-09-27 追記）に、Issue と同じ実測値が既に載っている:
【実測 2026-09-27、既定の設定（q8・4スレッド）、1件20〜70文字の短文、プロセスの peak RSS】
1件 259MB / 128件 630MB / 512件 1.7GB / 2048件 6.1GB。同じ2048件を128件ずつ渡すと 822MB で、
時間も短かった（9.1秒 → 6.8秒）。⟹ **Issue 本文はこの既存の実測を要約したものであり、
新規の実測ではない。**

### 2. 独立した再実測【実測 2026-09-29】

`@huggingface/transformers@4.2.0` を単独 install した最小スクリプトで、
`createLocalEmbeddingPipeline`（`pipeline.ts`）と同じ呼び方
（`dtype: "q8"`、`session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 }`）を再現し、
`process.resourceUsage().maxRSS`（この器に `/usr/bin/time` が無いための代替。
`getrusage(RUSAGE_SELF)` 由来で、意味は同じはずである）を別プロセスごとに測った。
環境は README と同じ（Node v22.23.3・`onnxruntime-node` 1.24.3・`@huggingface/transformers` 4.2.0・x86_64）。

**文長のばらつきが小さい文**（10〜20字程度を使い回す）:

| 件数 | peak RSS | embed 時間 |
|---|---|---|
| 1 | 252.5MB | 9ms |
| 32 | 271MB | 56ms |
| 128 | 326MB | 144ms |
| 256 | 372MB | 272ms |
| 512（1回） | 485.2MB | 533ms |
| 512（128件×4回） | 386MB | 484ms |

**文長のばらつきを大きくした文**（10〜35字程度混在、Issue の「20〜70文字」に近づけた）:

| 件数 | peak RSS | embed 時間 |
|---|---|---|
| 1 | 253.2MB | 7ms |
| 128 | 378.7MB | 223ms |
| 512（1回） | 712.2MB | 897ms |
| 512（128件×4回） | 489.6MB | 754ms |

**確認できたこと（質的）**: どちらの文長分布でも、①1回の `embed()` に渡す件数が増えるほど
peak RSS が伸びる、②同じ総件数でも128件ずつに分けたほうが peak RSS が小さく、かつ総時間も
同等かそれ以下になる——という Issue の主張と同じ方向の結果が独立に再現された。
文長のばらつきが大きいほど、分割による差は大きく出た（512件で 485MB→386MB・485MBに対し、
712MB→490MB）。

**確認できなかったこと（量的）**: 1件のときの値（252〜253MB）は README の259MBとほぼ一致するが、
128件・512件は README（630MB・1.7GB）よりかなり低い（今回は326〜379MB・485〜712MB）。
環境・版・呼び方は一致させたが、原因（元の実測に使われた具体的な文の長さ分布の違いか、
測定方法の違いか）は特定していない。⚠ **この量的な乖離は未解決のまま、この ADR の決定
（下記）を進めている**——決定の理由は「分割すると増え方が抑えられる」という**方向**に
依っており、絶対値のどちらが正確かには依っていないためである（「引き受けた負債」節も見ること）。

### 3. runtime は常に1件ずつ `embed()` を呼ぶ【現物】

本番経路で `embeddingProvider.embed()` を呼ぶのは2箇所だけである
（`packages/core/src/recall-runtime.ts:947`・`packages/core/src/runtime.ts:4417`、
どちらも `embed(ctx, [1件だけの配列])`）。これは
`packages/core/src/__tests__/embed-batch-size.test.ts`
（ADR 0110 §8 歯1）が正規表現でソース全体を走査して機械的に固定している。
**この歯は provider 内部の実装を見ていない**——見ているのは core 側の呼び出しの形だけであり、
本 ADR の変更（provider 内部の分割）はこの歯の対象外である。

### 4. 既存の門・測定への影響範囲【現物】

- **ADR 0253 の門**（`scripts/check-local-embedding-fingerprint.mjs`、
  `.github/workflows/ci.yml:532`〜567、required status check）は、HF API のファイル hash と
  手元キャッシュのファイル hash を突き合わせるだけで、**`embed()` を一度も呼ばない。**
  この変更とは無関係——値は動かない。
- **出力ベクトルの指紋測定**（`scripts/measure-embedding-output-fingerprint.mjs`・
  `scripts/compare-embedding-output-fingerprints.mjs`、Issue #565、ADR 0253 追記）は
  `embed()` を呼ぶが、⛔ **門ではない**（`ci.yml:575` 「これは門ではない」、常に exit 0）。
  固定入力は `examples/chat/src/embedding-fingerprint.ts:85-89` の
  `FIXED_EMBEDDING_FINGERPRINT_INPUTS` = **3件**のみで、同ファイル264行目で
  `provider.embed(FINGERPRINT_CTX, [...FIXED_EMBEDDING_FINGERPRINT_INPUTS])` と
  **1回の embed() 呼び出しに3件全部**を渡している。3件は既定値128を大きく下回るため、
  この変更で値は動かない。
- **`packages/core/src/__tests__/embed-batch-size.test.ts`（ADR 0110 §8 歯1）**は、
  「core が embed() をバッチで呼ぶようになったら `identifier-probes` の基準値を
  録り直す必要がある」ことを守る歯だが、これは core 側の呼び出し方を固定するものであり、
  本 ADR は core の呼び出し方を変えていない（上の3番）ため対象外。
- `examples/chat` の `identifier-probe-set.ts`・`numeral-token-json.ts`・
  `local-noise-*.ts`・`openai-arm-*.ts`・`subject-crossing-measure.ts`・
  `association-probe-set.ts` はいずれも `.embed(` を直接呼んでいない
  （grep で0件、すべて runtime 経由）——これらの CI 測定ジョブも影響を受けない。
- `examples/chat/src/cli.ts:1262`（`cassette-verify`）・
  `examples/chat/src/scripts/openai-embedding-fp-ceiling.ts`・
  `openai-margin-candidate-measurement.ts` は複数件を直接 `embed()` に渡すが、
  いずれも `MNEMORA_EMBEDDING: "openai"` または `"recorded"` を明示しており
  `local` provider を経由しない。かつ、いずれも `.github/workflows/ci.yml` に
  ステップとして存在しない（grep で0件）——CI では実行されない。
- `examples/chat/src/bench/*.ts`（`embedding-cache.ts` の `precomputeEmbeddingCache`、
  `association-scale-bench.ts`、`answer-bench.ts`）は複数件をまとめて `embed()` に渡す
  独自のバッチ処理を持つが、いずれも `.github/workflows/ci.yml` に名前が現れない
  （grep で0件）——CI の測定ジョブではなく、手元のベンチ専用のスクリプトである。

⟹ **CI が測定・門としている経路のうち、128件を超える件数を1回の `embed()` に直接渡すものは
無い。**この変更で、既存の門・基準値・カセットの値はどれも動かない。

---

## 決定

### 決定1. `LocalEmbeddingProviderOptions` に `maxBatchSize?: number` を足す。既定値は 128

`DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE = 128` として export する
（既存の `DEFAULT_LOCAL_EMBEDDING_*` と同じ流儀）。

**128 を選んだ理由**:
- 上の実測（README・本 ADR いずれも）で、128件は peak RSS がまだ数百MBの水準に収まる
  （README: 630MB、本 ADR の再実測: 326〜379MB）。
- Issue 本文が自ら例示した「2048件を128件ずつ」と同じ桁を採る——別の数を選ぶ積極的な
  理由が今回の実測からは出なかった。
- `examples/chat` の既存のベンチ2箇所（`src/bench/embedding-cache.ts` の `batchSize` 既定 64、
  `src/bench/association-scale-bench.ts` の `MNEMORA_ASSOC_SCALE_EMBED_BATCH` 既定 64）は
  この半分の値をすでに使っているが、根拠となる実測の記載はコード内に見当たらない
  （由来不明の precedent）。64 も候補になりうるが、今回は Issue 本文の例示に揃える形で
  128 を採った。

⚠ **どちらもより厳密な実測に基づく最適値の主張ではない。**上の量的な乖離（「測ったこと」2番）
が解消していない以上、**128 は「実測から出てくる唯一の正しい値」ではなく、
「実測が示す方向（分割すると増え方が抑えられる）に沿った、Issue の例示と一致する妥当な既定値」**
という位置づけである。

### 決定2. 分割は「件数が `maxBatchSize` 以下なら1回、超えたら `maxBatchSize` 件ずつ直列に」

`embed(ctx, texts)` は、prefix を付けた後の配列の長さが `maxBatchSize` **以下**なら、
今までどおり `pipeline.embed(prefixed)` を1回だけ呼ぶ——**この分岐は今日の呼び出しと
1バイトも変わらない**（同じ関数を同じ引数で呼ぶ）ので、既定値以下の呼び出しは
この変更の前後でビット単位で変わらない。**超えたときだけ**、先頭から `maxBatchSize` 件ずつに
切り出し、**直列で**（`Promise.all` にしない）順に推論し、結果を順番どおりに連結する。

**直列にした理由**: 並列にすると、①onnxruntime のセッションに複数の推論が同時に走り、
`numThreads` の奪い合いで速くなる保証が無い、②「RSS を抑える」という Issue の本来の目的と
衝突する（複数バッチぶんのメモリを同時に確保することになる）。⟹ **並列化は、まず直列で
効果を確かめてからの、別の判断・別の PR とする。**

### 決定3. 不正な `maxBatchSize` は、投げずに丸める。丸め方は `retry.attempts` の流儀に揃え、非整数の扱いだけ変える

**投げるか丸めるかの判断**: このパッケージには2つの既存の precedent がある。

| 欄 | 不正な値の扱い |
|---|---|
| `numThreads` | 検証しない。そのまま `pipeline()` へ渡し、onnxruntime 側の失敗に委ねる |
| `retry.attempts` | `NaN`・0以下は 1 に丸める（構造的な下限——「一度も試さない」は for ループの前提を壊す） |

`maxBatchSize` は `retry.attempts` に近い。理由: この値は分割ループの刻み幅・
`Array.prototype.slice` の引数に**直接**使う。`numThreads` のように素通しにすると、
onnxruntime ではなく**このクラス自身のループ**が壊れる——`maxBatchSize <= 0` は
`i += maxBatchSize` が前進せず無限ループになり、`maxBatchSize === NaN` は
`texts.slice(i, i + NaN)` が常に空配列になり**テキストが静かに消える**
（onnxruntime まで届く前に、埋め込むべきテキストが失われる。`numThreads` の
「エンジン側の分かりにくいエラー」より明確に悪い壊れ方である）。⟹ **投げずに丸める**
（`retry.attempts` と同じ判断）。

**非整数の扱いだけ変えた理由**: `retry.attempts` は非整数（例 `2.5`）をそのまま許し、
ループの `<=` 比較で自然に丸められる（コメント参照）。`maxBatchSize` はループの**刻み幅**
そのものに使うため、非整数のまま使うと `i += maxBatchSize` の蓄積誤差が繰り返しの末に
チャンクの境界をずらしうる。⟹ `Math.floor` で切り捨ててから使う
（`Array.prototype.slice` 自身も `ToIntegerOrInfinity` で暗黙に切り捨てるため、
明示的に揃えても意味は変わらないが、ループの刻み幅の見た目を整数に保つ）。

**具体的な丸め**:

```
rawMaxBatchSize = options.maxBatchSize ?? DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE
maxBatchSize =
  Number.isNaN(rawMaxBatchSize) ? 1 : Math.max(1, Math.floor(rawMaxBatchSize))
```

| 入力 | 結果 | 理由 |
|---|---|---|
| 未指定 | 128 | 既定値 |
| `0`・負の数 | 1 | 構造的な下限（`retry.attempts` と同じ） |
| `NaN` | 1 | 同上（`Math.max(1, NaN) === NaN` になるため先に弾く。`retry.attempts` と同じ理由） |
| 非整数（例 `128.7`） | `128`（切り捨て） | 上記 |
| `Infinity` | `Infinity` | 「分割しない」を表す有効な値。`Math.floor(Infinity) === Infinity`、`Math.max(1, Infinity) === Infinity` なので特別扱い不要 |
| `-Infinity` | `1` | 同じ丸めで自然に下限へ落ちる |

### 決定4. 上限超過（`input_too_long`）の `index` は、分割後もグローバルな位置を名乗る

`pipeline.embed()` が投げる `LocalEmbeddingProviderError`（`kind: "input_too_long"`）の
`detail.index` は「渡された配列の何番目か」を意味するが、分割すると pipeline は
**そのチャンクの中の位置**しか知らない。`embed(ctx, texts)` の契約
（`errors.ts` の doc: 「`embed(ctx, texts)` に渡された配列の何番目か」）を壊さないため、
`LocalEmbeddingProvider` 側でチャンクの開始位置ぶんだけ `index` を足し戻してから投げ直す
（メッセージ中の数字も同じ値に差し替える。メッセージ全体は複製せず、数字だけを機械的に
置換する——複製すると片方だけ直して他方を直し忘れる腐り方をする）。

---

## 採らなかった案

### (a) 既定を64にする（`examples/chat` の既存ベンチに揃える）

**却下の理由**: 由来を辿ったが、64 という値の実測根拠がベンチのコードにもコメントにも
見当たらなかった（決定1）。Issue 本文が自ら例示した128と揃えるほうが、少なくとも
「どこから来た数か」を辿れる。

### (b) 並列化してから既定値を決める

**却下の理由**: 「RSS を抑える」という目的と正面から衝突しうる（決定2）。まず直列の効果を
測ってから、要るなら別の判断として並列化を検討する。

### (c) 不正な `maxBatchSize` を投げる（`buildLocalEmbeddingPipeline` の `maxInputTokens` と同じ扱い）

`buildLocalEmbeddingPipeline` は `model_max_length` が正の整数でなければ
`kind: "unknown_input_limit"` を投げて組み立てを失敗させる。**却下の理由**:
`maxInputTokens` は「モデルが持つ事実」を宣言させる欄であり、宣言できないこと自体が
異常事態である。`maxBatchSize` は利用者が調整する**知の性能ノブ**であり、
`retry.attempts` と同じ族——不正な値を投げるより、構造的に安全な値へ丸めて動かし続ける
ほうが、このパッケージの既存の流儀に近い。

### (d) 非整数もそのまま許す（`retry.attempts` と完全に揃える）

**却下の理由**: 決定3 に書いたとおり、ループの刻み幅に使う値の蓄積誤差を避けるため、
ここだけ `retry.attempts` と挙動を変えた。

---

## 引き受けた負債

1. 🔴 **量的な乖離が未解決のまま既定値を決めている。**「測ったこと」2番のとおり、
   本 ADR の再実測は README/Issue の絶対値（128件で630MB、512件で1.7GB）を
   大きく下回った（128件で326〜379MB、512件で485〜712MB）。環境・版・呼び方を
   揃えても再現しなかった原因は特定していない。**方向（分割で増え方が抑えられる）は
   独立に確認できたので決定を進めたが、既定値128の絶対的な妥当性（「もっと大きくても
   良かったのでは」「もっと小さくすべきでは」）は、この乖離が解けるまで確定できない。**
2. **直列化のみで、並列化の効果測定を持たない**（採らなかった案(b)）。
3. **live テスト（opt-in、実モデル）は、この変更を入れた手元で一度走らせただけである**
   （下の「測ったこと」5番）。CI の複数ランナー間での再現性は測っていない
   （ADR 0328 が別の実測で扱っている論点だが、本 ADR の変更それ自体への適用は無い）。
4. **`maxBatchSize` を明示的に大きくして q8 のバッチ依存を意図的に踏む利用者への
   案内は、README の注意書きどまりである。**踏んだ結果が「わずかに変わる」で
   済むのか「実用上問題になる」のかは、この ADR の範囲では測っていない
   （ADR 0110 §4 の任意性の議論を参照するに留めた）。

## これが覆るとしたら何が起きたときか

- **CI の測定ジョブ（identifier-probes・compare・association-probes 等）が、
  128件を超える件数を直接 `local` provider の `embed()` に渡すよう変わったとき**
  ⟹ 「測ったこと」4番の前提が崩れ、既定値128がそれらの基準値を動かしうる。
  そのときは基準値の録り直しが要る（ADR 0110 §8 歯1と同じ扱い）。
- **`packages/core` の本番経路（`runtime.ts`・`recall-runtime.ts`）が
  `embed()` を複数件まとめて呼ぶよう変わったとき** ⟹ 同上。この歯
  （`embed-batch-size.test.ts`）が赤くなることで気づける設計になっている。
- **量的な乖離（負債1）の原因が判明し、実際の peak RSS が既定値128の想定より
  大きく／小さく異なると分かったとき** ⟹ 既定値そのものを見直す理由になる。

---

## 測ったこと・確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

上の「文脈」「測ったこと」節に記載のとおり——README の既存実測の確認、独立な再実測
（短文・長さ混在の2条件）、runtime の呼び出し形の確認、既存の門・CI 測定ジョブへの
影響範囲の網羅的な確認（grep による0件の確認を含む）。

**5. 実モデルでのビット一致（opt-in live テスト）**【実測 2026-09-29、この器で1回】:
`live.local-embedding.test.ts` に、128件以下の入力で「分割ありの provider」と
「`maxBatchSize` を大きくして分割を無効化した provider」の出力が Float32 のバイト列で
完全一致することを確かめる歯を1本追加し、`MNEMORA_LIVE_LOCAL_EMBEDDING=1` で実行して
緑になることを確認した（本 PR の説明に実行結果を記載）。

### 確かめていないこと

- 量的な乖離の原因（負債1）。
- 並列化の効果（負債2）。
- 複数ランナー間での opt-in live テストの再現性（負債3）。
- 128件を明示的に大きく超える `maxBatchSize` を指定した利用者が、実際にどの程度
  ベクトルの変化を体感するか（負債4）。

---

⚠ **2026-09-29 追記（本文は書き換えていない）。公開 API 表面の破壊性【現物】。**
公開 API 表面の門（`scripts/check-public-api-surface.mjs`、[ADR 0178](./0178-public-api-surface-gate.md)）が
`@mnemora/local-embedding` の `.d.ts` に出した差分は、次の2行の**追加だけ**である
（削除・変更の行は無い）:

- `export declare const DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE = 128;`
- `LocalEmbeddingProviderOptions` の `maxBatchSize?: number;`（省略可能）

⭕ **非破壊と判断する**——新しい export と省略可能な option を足しただけで、既存の宣言も、
既存の呼び出しの型検査も変わらない（CHANGELOG `[1.1.0]` の本項目の数え方と同じ）。
実行時の意味の変化（128件を超える件数を直接渡したときにベクトルがわずかに動きうること）は
型には現れないため、この門は拾わない——それは上の決定2と CHANGELOG に書いてある。
**クローン miku の委譲先の判断であり、オーナーの判断ではない。**
この判断の後に `node scripts/check-public-api-surface.mjs --write` で snapshot を更新した。
