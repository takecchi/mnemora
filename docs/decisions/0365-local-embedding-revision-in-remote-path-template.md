# ADR 0365: `LocalEmbeddingProvider` に `revision` を渡したら、`env.remotePathTemplate` に埋め込み、キャッシュの根を revision ごとに分ける（Issue #1403）

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
> 採る形（E′）・`cacheDir` を渡さない場合の扱い・CHANGELOG での数え方は、クローン miku が決めた。
> 方向そのものの変更が要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0253・0358・0361 の体裁を踏む）。

- **【現物】** — この repo・`@huggingface/transformers` のコードを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で node を走らせて確かめた。
- **推測** — 出所を明示していない考察・見立て。

---

## 文脈

[ADR 0361](./0361-local-embedding-cache-dir-env-swap.md)（Issue #1239）で、`cacheDir` を渡したら、その中身だけで
オフラインで読めるようにした。ただし `revision` を `main` 以外にすると、この直し方は届かなかった（ADR 0361 の負債2）。

- 【実測 2026-09-29】`<repo>/<revision>/` の下に4ファイルを揃えた `cacheDir` と、固定の sha
  （`scripts/local-embedding-pinned-revision.json`）を `createLocalEmbeddingPipeline` に渡し、`env.fetch` を必ず
  失敗させると、`resolve/main/config.json` へ1回出て、読み込みは失敗した。
- 【実測】PR #1401 の CI でも、`examples/chat` ジョブの「温めたキャッシュだけで…（測るだけ）」のステップは
  `ok=false requests=3`（3回とも `resolve/main/config.json`）のままだった。同ジョブは `cacheDir` と `revision` を
  両方固定している。

## 測ったこと

### 1. 前段の確認に `revision` を届ける公開の口は無い【現物】

- `@huggingface/transformers` の 4.2.0（使っている版）・4.3.0（npm の最新）・上流の `main`（`836b9cb`、
  2026-09-23）のどれでも、`pipeline()` は前段の確認 `get_pipeline_files(task, model, { device, dtype })` に
  `revision` も `cache_dir` も渡さない。その先の `get_tokenizer_files` は `get_file_metadata(modelId,
  "tokenizer_config.json", {})`、`get_model_files` は `get_config(modelId, { config })` を呼ぶ。
- 前段の確認が読む `env` の設定（`cacheDir`・`useFSCache`・`useCustomCache`/`customCache`・`allowLocalModels`・
  `localModelPath`・`allowRemoteModels`・`remoteHost`・`remotePathTemplate`）の中に、`revision` の値そのものに
  効くものは無い。
- 上流の Issue・PR にも、この件は見当たらなかった（`gh search` で `get_pipeline_files` などを当てた）。

### 2. 鍵と URL の組み立て【現物】

`utils/hub.js` の `buildResourcePaths`:

- FileCache の鍵は、`revision` が `main` なら `<repo>/<file>`、それ以外なら `<repo>/<revision>/<file>`。
- `remoteURL` は `env.remoteHost` と `env.remotePathTemplate`（既定 `'{model}/resolve/{revision}/'`。`{revision}` は
  `encodeURIComponent` して埋める）から作る。
- ⟹ `revision` を渡さず、`env.remotePathTemplate` の `{revision}` を先に埋めておけば、前段の確認も実際の読み込みも
  同じ revision の URL を見る。キャッシュの鍵は `main` と同じ `<repo>/<file>` になる。

### 3. 形ごとの実測【実測 2026-09-29】

`env.fetch` は必ず失敗させた。

| 形 | 結果 |
|---|---|
| E. `env.remotePathTemplate` を `{model}/resolve/<sha>/` にし、`revision` は渡さず、`<repo>/<file>` の配置で温めた根を `cache_dir` と `env.cacheDir` にする | fetch 0回、256次元のベクトルが出た |
| E（温めていない根） | `resolve/<sha>/config.json` を取りに行った（前段の確認も sha を見る） |
| A. 温めた `<cacheDir>/<repo>/<sha>/` の絶対パスを、モデル id として `pipeline()` に渡す | fetch 0回、256次元のベクトルが出た |

## 決定

### 決定1. `spec.revision` があるとき、既定の `createPipeline` は `revision` を `pipeline()` に渡さず、`pipeline()` を呼んでいる間だけ `env.remotePathTemplate` に埋め込む

`packages/local-embedding/src/pipeline.ts` の `loadWithCacheDirSwap` が、`env.remotePathTemplate` の `{revision}` を
`encodeURIComponent(revision)` に置き換えたものへ差し替え、成功でも失敗でも finally で戻す。元の値を土台にするので、
利用者が変えた template は壊さない。

### 決定2. キャッシュの根を `<基の根>/<encodeURIComponent(revision)>/` に分ける

基の根は `spec.cacheDir`、無ければ読み込みの時点の `env.cacheDir`（既定のキャッシュ）。`cache_dir` と `env.cacheDir` を
この根にする。`cacheDir` の有無で振る舞いを分けない（クローン miku の判断）。

**なぜ分けるか**: 決定1 で、transformers.js はキャッシュを `main` と同じ `<repo>/<file>` の鍵で引く。根を分けないと、
`revision` 無しで温めた中身が、固定した revision の中身として黙って読まれる。**この根の形は mnemora が決めたもので、
transformers.js の内部の鍵の形には依存しない**（transformers.js から見れば、ただの `cache_dir` である）。

### 決定3. 差し替えは ADR 0361 の待ち行列の中で行い、差し替えられないときは今までどおり `revision` を渡す

`env` を読めない（`vi.mock` が `env` を返さない形）・`env.remotePathTemplate` が文字列でない・基の根が無い
（`cacheDir` を渡さず、既定のキャッシュも無い）のどれかなら、決定1・2 はせず、今までどおり `revision` を
`pipeline()` へ渡す。`spec.revision` が無いときは何も変えない。

### 決定4. repo の中で配置に依存しているものを、同じ変更で合わせる

- `scripts/print-local-embedding-cache-key-lib.mjs` の `CACHE_LAYOUT_TAG` を `revision-layout-1` から
  `revision-root-2` に上げた。古い配置のキャッシュが当たらないようにするため（CI のキャッシュは1回外れる）。
- `scripts/check-local-embedding-fingerprint.mjs`（ADR 0253 の門）は、平たい `<cacheDir>/<repo>/` と
  `<cacheDir>/<encodeURIComponent(固定revision)>/<repo>/` の両方を見る（`cacheRepoDirs`）。CI では `revision` を渡す
  ステップと渡さないステップが同じキャッシュを使うため、両方が並ぶ。
- 読み込みに失敗したときのメッセージ（Issue #1223）が名指す「消せば取り直す場所」も、`revision` を渡したときは
  新しい根の下を指す。

## 採らなかった案

### A. 温めた `<cacheDir>/<repo>/<revision>/` の絶対パスを、モデル id として `pipeline()` に渡す

公開の口（ディレクトリをモデル id に渡す）だけを使い、実測でも読めた。**却下の理由**: キャッシュの物理的な配置
（`<repo>/<revision>/`）を読む側に回るので、依存の種類が ADR 0361 の案2 と同じである。さらに、温まっていないと
ネットワークへ出られないので、先に在るかを確かめる必要があり、そこでも配置に依存する（クローン miku の判断）。

### 案2（ADR 0361）. 前段の確認が探す `main` の鍵の形で、`config.json`・`tokenizer_config.json` の写しを置く

**却下の理由**: transformers.js の内部の鍵の形（`<repo>/<file>`）に結びつく。ADR 0361 と同じ。

### 上流の transformers.js へ上げるだけにする

**却下の理由**: 直るまでの時間が読めず、その間 `revision` を固定した利用者はオフラインで読めない。今回は上流への
Issue も立てない（クローン miku の判断）。

## 引き受けた負債

1. 🔴 **`env.remotePathTemplate` という大域を、もう1つ触る。**ADR 0361 の負債1 と同じく、このパッケージを経由しない
   transformers.js の利用が差し替えの最中に読み込むと、差し替え後の値（固定した revision の URL）を見うる。
   直列化が守るのは、このパッケージの読み込みどうしだけである。
2. **既存のキャッシュが1回外れる。**この変更より前に `revision` を渡して温めたキャッシュ（`<根>/<repo>/<revision>/<file>`）
   は、もう使われない。ネットワークがあれば1回取り直す（約42MB）。ネットワークの無い場所では、先に新しい根へ温め直す
   必要がある。古い置き場所は自動では消さない。
3. **`revision` に同じ中身の別名（枝名と、それが指す sha）を渡すと、別の根になり、別々に落とす。**推測——鍵が
   revision の文字列で決まるのは、この変更の前（`<repo>/<revision>/`）と同じである。

## これが覆るとしたら何が起きたときか

- **transformers.js が前段の確認に `revision`（と `cache_dir`）を運ぶようになったとき** ⟹ 決定1 の埋め込みは不要になり、
  `revision` を `pipeline()` に渡す形へ戻せる。ただし戻すとキャッシュの配置がまた変わるので、`CACHE_LAYOUT_TAG` と
  指紋の門も一緒に見直すこと。
- **`env.remotePathTemplate` の意味が変わったとき**（`{revision}` の置き換えをやめる・別の置き場所の設定に移る）
  ⟹ 決定1 は成り立たなくなる。`revision-env-swap.test.ts` と `revision-offline-preflight.test.ts` が赤くなるはずである。
- **負債1 が実運用で踏まれたとき** ⟹ ADR 0361 と同じく、上流への修正を優先して再検討する。

## 測ったこと・確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- 上の「測ったこと」1〜3。
- 歯（赤は `main` の版の worktree で、緑はこの変更で確かめた）:
  - `packages/local-embedding/src/__tests__/revision-offline-preflight.test.ts`（本物の transformers.js・偽のファイル）。
  - `packages/local-embedding/src/__tests__/revision-env-swap.test.ts`（`@huggingface/transformers` を丸ごと mock）。
  - `packages/local-embedding/src/__tests__/live.revision-offline-read.test.ts`（opt-in。本物のモデルを固定の sha で温め、
    まっさらな別プロセス・ネットワーク無効で読み、256次元のベクトルがネットワーク0回で返る）。
  - `scripts/__tests__/check-local-embedding-fingerprint-lib.test.mjs`・`check-local-embedding-fingerprint-cli.test.mjs`
    （`cacheRepoDirs` と、新しい配置での照合）・`local-embedding-cache-key.test.mjs`（`CACHE_LAYOUT_TAG`）。

### 確かめていないこと

- transformers.js の 4.2.0 以外の版で、この差し替えが実際に効くこと（4.3.0 と上流の `main` は、前段の確認が
  `revision` を運ばないことをソースで確かめただけで、動かしてはいない）。
- 負債3 の実害の大きさ。
