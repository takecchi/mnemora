# ADR 0361: `LocalEmbeddingProvider` の `cacheDir` を、読み込みの前段の確認にも反映させる（`env.cacheDir` の一時的な差し替え + 直列化。Issue #1239）

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

**⚠ 各主張の出所を分ける**（ADR 0253・0358 の体裁を踏む）。

- **【現物】** — この repo・`@huggingface/transformers` のコードを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で node を走らせて確かめた。
- **推測** — 出所を明示していない考察・見立て。

---

## 文脈

[Issue #1239](https://github.com/takecchi/mnemora/issues/1239) が名指しした問題【現物・要約】:

`LocalEmbeddingProvider` に `cacheDir` を渡して、そこにモデルの4ファイル（`config.json`・
`tokenizer.json`・`tokenizer_config.json`・`onnx/model_quantized.onnx`）が揃っていても、
`@huggingface/transformers@4.2.0` の `pipeline()` は読み込みの前段の確認（`get_pipeline_files`
の中の `get_files`/`get_config`・`get_file_metadata`）で `config.json`・`tokenizer_config.json`
の有無を**既定のキャッシュ（`env.cacheDir`）だけ**で確かめる。`pipeline()` へ渡した
`cache_dir` オプションは、この前段の確認には運ばれない。⟹ **`cacheDir` を渡して温めても、
既定のキャッシュが空なら、この前段の確認だけがネットワークへ出て、オフラインでは
読み込みが失敗する。**

Issue 本文には「事実だけを書き、採否は書かない」形で4つの案が並んでいる（下の「採らなかった
案」節で扱う）。この ADR は、その中から**案1**（`env.cacheDir` の一時的な差し替え）を採る
決定を記録する。

---

## 測ったこと

### 1. `@huggingface/transformers@4.2.0` の現物を読んで、前段の確認の実装を特定した【現物】

- `pipelines.js` の `pipeline()` は、実際の読み込みの前に
  `get_pipeline_files(task, model, { device, dtype })` を呼ぶ（`cache_dir`・`revision`・
  `local_files_only` を渡さない）。
- `get_pipeline_files.js` は `get_files(modelId, { ...options, include_tokenizer,
  include_processor })` を呼び、これが `config.json`・`tokenizer_config.json` の有無を
  `get_file_metadata` で確かめる。
- `get_file_metadata.js` の `get_file_metadata(path_or_repo_id, filename, options)` は、
  `memoizePromise(key, ...)` でプロセス内メモ化されている。鍵は
  `JSON.stringify([path_or_repo_id, filename, options?.revision, options?.cache_dir,
  options?.local_files_only])` ——**`get_pipeline_files` からの呼び出しでは `options.cache_dir`
  が常に `undefined` なので、鍵の中の `cache_dir` の位置は常に無い状態になる。**
- `_get_file_metadata` の中身は `getCache(options?.cache_dir)`（`cache_dir` が `undefined`
  なら `env.cacheDir` を見る）→ ローカルファイルの確認 → リモートの Range リクエスト、の順。
  ⟹ **既定のキャッシュ（`env.cacheDir`）にファイルが無ければ、必ずネットワークへ出る。**
- `hub.js` の `getModelFile`（実ファイルの取得。`INFLIGHT_LOADS` で `${repo}::${filename}`
  をキーに重複読み込みを防ぐだけで、これも `cache_dir` を鍵に含まない）は、成功でも失敗でも
  `INFLIGHT_LOADS.delete(key)` する——**在り続けるのは「いま実行中の間」だけ**である。
- `memoizePromise`（`get_file_metadata`・`get_config` が使う LRU、最大100件）は、
  **成功した結果は残り続け、失敗（reject）した結果だけ `cache.delete(key)` で即座に外れる**
  （`memoize_promise.js` の doc に明記）。

### 2. 実測で確かめた5つの事実

【実測 2026-09-29、`@huggingface/transformers@4.2.0`、実際に配布されている
`sirasagi62/ruri-v3-30m-ONNX`（q8）を一度だけ温めた `warm-cache/` を使用】

1. **バグの再現**: `cacheDir` に4ファイルが揃い、既定のキャッシュが空・`env.fetch` を
   必ず失敗させると、`config.json` を取りに1回だけネットワークへ出て、読み込みが失敗する
   （`fetchCount: 1`、`this.tokenizer is not a function` ではなく明確な network エラー）。
2. **案1（`pipeline()` を呼んでいる間だけ `env.cacheDir` を `cacheDir` へ向け、`finally`
   で戻す）で直る**: 同じ条件で `env.cacheDir` を一時的に差し替えると、`fetchCount: 0`・
   256次元のベクトルが返った。
3. **直列化していないと壊れる**: 2つの読み込み（片方は warm な `cacheDir`、もう片方は空の
   `cacheDir`）を、待ち行列を挟まずに `Promise.all` で並行させると、**本来成功するはずの側**
   が `this.tokenizer is not a function` で落ちた（もう片方の `finally` の巻き戻しが割り込む）。
   待ち行列を挟むと、両方とも正しく決着する（成功する側は成功、空の `cacheDir` の側は
   そのディレクトリの中身どおりに失敗する）。
4. **失敗はメモ化に残らない**: 同一プロセスで、1つ目の読み込み（空の `cacheDir`、ネットワーク
   無効）が失敗した直後に、2つ目の読み込み（**同じ repo**・warm な `cacheDir`）を行うと、
   2つ目は成功し、しかも追加のネットワーク要求は0回だった（`fetchCountAfterFirst: 1`
   → `fetchCountTotal: 1`、増えていない）。⟹ **1回目の失敗が、2回目の成功を妨げない**
   ——`memoizePromise` が失敗を即座に外す実装（上の「測ったこと」1番）と整合する。
5. **`revision` のキャッシュ鍵**: `hub.js` の該当行
   （`revision === 'main' ? request_url : pathJoin(path_or_repo_id, revision, filename)`）
   を読み、`revision` が `"main"` 以外だとキャッシュの鍵が `<repo>/<revision>/<file>` に
   なることを確認した（Issue 本文の記載と一致）。

### 3. `env.cacheDir` を差し替えない既存の代替 2つも実測した【実測 2026-09-29】

- `local_files_only: true` を `pipeline()` の options に足す・`env.allowRemoteModels = false`
  を設定する、のどちらか（または両方）を試したが、**前段の確認そのものは避けられない**
  ——`env.cacheDir` が空のままだと、この2つを付けても `get_file_metadata` は
  「存在しない」と判定し、後続の読み込みが別の形で失敗する（`env.allowRemoteModels = false`
  はネットワークへの到達を防ぐだけで、前段の確認が既定のキャッシュを見る先を変えない）。
  ⟹ この2つは、今回の問題の**代替の直し方にはならない**——README の「ネットワークに一切
  出ずに、手元のファイルだけで動かす」節が案内している `env.localModelPath` の使い方
  （下の「採らなかった案」§4）とは別の話である。

---

## 決定

### 決定1. 既定の `createPipeline`（`createLocalEmbeddingPipeline`）が、`spec.cacheDir` が
指定されているときだけ、`pipeline()` を呼んでいる間だけ `env.cacheDir` を `spec.cacheDir`
と同じ場所へ差し替える

`pipeline.ts` の `loadWithCacheDirSwap` が、`pipeline()` を呼ぶ直前に
`env.cacheDir` を保存してから差し替え、`try`/`finally` で成功・失敗どちらでも元へ戻す。
`spec.cacheDir` が未指定なら触らない（`cacheDir` を渡さない既定の使い方は変えない）。

**なぜこの形か**: 前段の確認は `env.cacheDir` だけを見る（「測ったこと」1番）。それ以外に
「前段の確認だけに `cache_dir` を渡す」経路は transformers.js の公開 API に無い。
⟹ **前段の確認が実際に見ている値そのもの（`env.cacheDir`）を、必要な間だけ動かすのが、
公開 API の中で完結する唯一の直し方である。**

### 決定2. `env.cacheDir` を触る経路（＝ `createLocalEmbeddingPipeline` を呼ぶ経路）は、
プロセス内で1本の待ち行列に直列化する。`cacheDir` を差し替えない呼び出しも同じ待ち行列を通す

`pipeline.ts` に、`export` しないモジュールスコープの `cacheDirQueue`（`Promise<void>`）と
`withCacheDirLock`（同期関数。`cacheDirQueue.then(task)` を積み、`cacheDirQueue` 自身は
`run.then(() => undefined, () => undefined)` で「次へ進めてよい」という決着だけを伝える）を
持たせ、`createLocalEmbeddingPipeline` はこれを経由してから実際の読み込みを行う。

**なぜ直列化が要るか**: `env` はプロセス全体で共有される大域である。「測ったこと」3番の
実測どおり、待ち行列が無いと、2本の読み込みが同時に走ったとき、片方の `finally` の
巻き戻しがもう片方の `pipeline()` 呼び出しの途中に割り込みうる。

**なぜ `cacheDir` を差し替えない呼び出しも巻き込むか**: 差し替えない呼び出しは
`env.cacheDir` を読むだけだが、**読むタイミングが、差し替えている最中の呼び出しと重なれば、
他人の `cacheDir` を見てしまう。**この漏れは「差し替える側」の注意だけでは防げない
——読む側も同じ待ち行列に並ばせて、時間的に重ならないようにするしかない。

**なぜ失敗を待ち行列に残さないか**: `cacheDirQueue` に積む「次の待ち行列」は、実行結果を
`() => undefined` / `() => undefined` で握りつぶし、常に解決済みの状態にする。**そうしないと、
1回の読み込みの失敗が、それ以降のすべての読み込みを待ち行列の中で reject させたまま
詰まらせてしまう**（「測ったこと」4番の「1回目の失敗が2回目を妨げない」という前提を、
実装の側でも保つ）。

### 決定3. `env` を読めない・持たない差し替え（`vi.mock` が `pipeline` だけを返す形）では、
差し替えを試みない

`transformers.env` の読み出しは既存の `recordTransformersCacheDir` と同じ try/catch で
守り、読めなければ「差し替えられない」として、読み込みそのものは止めない。

**なぜ**: 既存のユニットテスト（`create-pipeline-options-passthrough.test.ts` など）は
`@huggingface/transformers` を `{ pipeline: pipelineMock }` だけで `vi.mock` しており、
`env` を返さない。ここで例外を投げると、`cacheDir` を渡す既存の呼び出しがすべて壊れる。

---

## 採らなかった案

### 案2. 読み込みの前に、`cacheDir` の中の `config.json`・`tokenizer_config.json` を
既定のキャッシュへ物理的に写す

**却下の理由**:

- transformers.js の内部の鍵の形（`<repo>/<file>` または `<repo>/<revision>/<file>`）に
  実装が結びつく——バージョンが変われば鍵の形も変わりうる、より深い非公開の実装詳細への
  依存になる（このパッケージが「非公開の内部（transformers.js の非公開の関数や、
  キャッシュの物理的な配置）には依存しない」という要求と衝突する）。
- パッケージの中の `.cache/`（`node_modules` の下）へ**書き込む**——`node_modules` を
  消す・入れ直すたびに消える上、書き込み権限が無い環境（読み取り専用の `node_modules`）
  では動かない。案1は書き込みを一切増やさない。
- 前段の確認が `config.json`・`tokenizer_config.json` の**2つだけ**で足りている（「測ったこと」
  1番）のは今のバージョンの実装詳細であり、将来もっと多くのファイルを確認するようになれば、
  この案は写す対象を追いかけ続ける必要がある。案1は「何を確認するか」を知らなくてよい
  ——`env.cacheDir` さえ向ければ、確認先が増えても自動的に付いてくる。

### 案3. README に今の振る舞いと回避の仕方を書くだけで、実装は変えない

**却下の理由**: 「オフラインで使うために、利用者が自分で既定のキャッシュへファイルを
手で置く」という回避策は、`cacheDir` という名前の option が実際に約束していること
（「モデルの置き場所を指定すれば、そこから読める」）を果たしていない。**この Issue が
CI で再発し続けている**（Issue 本文・#1004）ことも、doc だけでは実運用上の問題が
解決しないことを示している。

### 案4. transformers.js へ上げる（前段の確認が `cache_dir`・`revision`・`local_files_only`
を受け取らない件を upstream で直してもらう）

**却下の理由**: 直るまでの時間が読めず、直るまでの間はこの repo の利用者が困り続ける。
ただし**この案を諦めたわけではない**——「これが覆るとしたら」節を見ること。

### `env.localModelPath` + `env.allowRemoteModels = false`（README「ネットワークに一切出ずに、
手元のファイルだけで動かす」節、既存の案内）

これは Issue の4案の外にある、**既存の README がすでに案内している**別の経路である。
今回の決定の対象（`cacheDir` オプション経由の一般的な直し方）としては採らなかった。

**却下の理由**:

- `env.localModelPath` は `repo` を**相対パス**として解決する（絶対パスを渡せない）。
  既定の `repo`（`sirasagi62/ruri-v3-30m-ONNX`、Hugging Face の repo id の形）とは
  別の使い方であり、**利用者が自分で `createPipeline` を書き直す**ことを前提にしている
  （README の当該節も、独自の `createPipeline` の実装例として案内している）。
- `env.allowRemoteModels = false` はネットワークへの到達そのものを止める設定であり、
  「前段の確認が `cacheDir` の中身を見る」ことを直接には保証しない——「測ったこと」3番の
  実測のとおり、これだけでは前段の確認の判定先（既定のキャッシュ）は変わらない。
- ⟹ この経路は「`createPipeline` を自分で書ける・書きたい利用者」向けの、
  **既存の別の解決策として残す**（本 ADR は変更しない）。今回の決定は、**既定の
  `createPipeline`（何も注入しない、いちばん多い使い方）でも `cacheDir` が機能する**
  ようにすることが目的であり、この既存の経路と競合しない。

---

## 引き受けた負債

1. 🔴 **`env` はプロセス全体で共有される大域であり、このパッケージの直列化は
   「このパッケージ自身の呼び出しどうし」にしか及ばない。**同じプロセスで、この
   パッケージを経由せずに `@huggingface/transformers` を直接使うコード（自分で
   `import()` して `pipeline()` を呼ぶ利用者コード、または別のライブラリ）が、
   `pipeline()` の呼び出しの最中（＝差し替えている最中）に `env.cacheDir` を読めば、
   このパッケージの `cacheDir` を見てしまう。**この形の巻き添えは直していない**
   ——直すには transformers.js 自身が `cache_dir` を前段の確認に運ぶ必要がある
   （案4）。README にこの限界を明記した。
2. **`revision` を `main` 以外にしたときの相互作用は、doc に書いただけで実装・歯を
   足していない**（「測ったこと」2番5）。`cacheDir` の中の鍵が `<repo>/<revision>/<file>`
   になるため、`revision` を指定する前に `revision` 無しで温めた `cacheDir` には
   当たらない——この ADR の差し替えは `cache_dir` オプションのルートディレクトリを
   差し替えるだけで、鍵の組み立てには関与しないので、この相互作用はそのまま残る。
3. **同一 repo・異なる `cacheDir` の「両方とも成功する」組み合わせを、実モデルでは
   測っていない。**「測ったこと」2番4で確かめたのは「失敗の後に成功する」組み合わせ
   だけである。`get_file_metadata`/`get_config` の `memoizePromise` は**成功した結果を
   残し続ける**（失敗だけを外す）ため、理論上は「同じ repo・cacheDir A で成功した後、
   同じ repo・cacheDir B で読もうとすると、A の存在確認の結果が再利用され、B の中身を
   正しく見ない」という食い違いが起こりうる——ただし、実際にファイルを取得する経路
   （`getModelFile`/`getModelJSON`）は毎回 `cache_dir` を正しく受け取って動くため、
   起こりうるのは「前段の確認の判定が古い repo の状態を指す」ことだけで、**最終的に
   返るベクトルが壊れることは無いと考えている**（推測——実測はしていない）。
   同じ既定の repo を、異なる `cacheDir` で複数回読み込む使い方（同じモデルの複数の
   私設ミラーを cacheDir だけ変えて使う、など）をする利用者は、この負債の射程に入る。
4. **待ち行列は本パッケージの読み込みが遅くなりうる。**複数の `LocalEmbeddingProvider`
   インスタンス（`cacheDir` が違うものを含む）を同じプロセスで使うと、読み込みは
   もう並行しない——直列に順番待ちする。個々のインスタンスの `#ready` による
   1インスタンス内の重複排除（既存の仕組み）は変えていないが、**インスタンスをまたいだ
   読み込みどうしの並行性は、この ADR で失われた。**読み込みは通常プロセスの生存期間で
   数回（インスタンスの数だけ）しか起きないため、実害は小さいと考えているが、
   計測はしていない。

## これが覆るとしたら何が起きたときか

- **transformers.js が前段の確認に `cache_dir`（と `revision`・`local_files_only`）を
  運ぶようになったとき**（案4）⟹ この ADR の差し替え・直列化は不要になる
  （実害は無いが意味の無い迂回になる）。`cache-dir-preflight-default-cache.test.ts` は
  0回のまま緑を維持するはずだが、`cache-dir-env-swap-serialization.test.ts` が
  `env.cacheDir` の変化を直接見ているため、その歯を見直すきっかけになる。
- **負債1（他の transformers.js 利用者との巻き添え）が実運用で実際に踏まれたとき**
  ⟹ より重い直し方（案2 の「物理的に写す」、または transformers.js のフォーク）を
  再検討する理由になる。
- **負債3（同一 repo・異なる cacheDir の食い違い）が実際にベクトルの誤りとして
  観測されたとき** ⟹ 前段の確認の結果を repo 単位ではなく `(repo, cacheDir)` 単位で
  区別する必要が生まれる——ただしそれは transformers.js 内部の鍵の形に踏み込む変更に
  なり、案2 を却下した理由（非公開の内部への依存）と正面から衝突するため、そのときは
  transformers.js 側への upstream 修正を優先する。

---

## 測ったこと・確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

上の「測ったこと」節に記載のとおり——transformers.js 4.2.0 の現物を読んでの原因特定、
バグの再現・案1での修正・直列化無しでの破壊・直列化ありでの復旧・失敗後の成功、を
すべて実際に配布されているモデル（`sirasagi62/ruri-v3-30m-ONNX`、一度だけ温めた
`warm-cache/`）で確かめた。`revision` のキャッシュ鍵の形は現物のソースで確認した。

**歯**:

- `src/__tests__/cache-dir-preflight-default-cache.test.ts`（`createLocalEmbeddingPipeline`
  経由・偽のファイル・本物の transformers.js。ネットワーク要求0回を縛る）。
- `src/__tests__/cache-dir-env-swap-serialization.test.ts`（`@huggingface/transformers` を
  丸ごと mock。`env.cacheDir` の復元・直列化・失敗後の継続を縛る）。
- `src/__tests__/live.cache-dir-offline-read.test.ts`（opt-in、`MNEMORA_LIVE_LOCAL_EMBEDDING`。
  本物のモデルを一度だけ温め、まっさらな別プロセス・既定のキャッシュ空・ネットワーク無効の
  状態で `createLocalEmbeddingPipeline` から読み、256次元のベクトルがネットワーク0回で
  返ることを確かめる。手元で1回実行して緑を確認した——実行結果は本 PR の説明に記載）。

### 確かめていないこと

- 負債3（同一 repo・異なる `cacheDir` の「両方とも成功する」組み合わせ）を実モデルで。
- 負債4（複数インスタンスをまたいだ直列化による速度低下）の定量。
- `revision` を `main` 以外にした状態での、この差し替えの実際の動作（本物のモデルでの
  検証は行っていない。README・本 ADR の記載はソースの読解に基づく）。
- transformers.js の 4.2.0 以外の版での前段の確認の実装（版が上がれば「測ったこと」1番の
  詳細が変わりうる）。
