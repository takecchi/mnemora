# @mnemora/local-embedding

`EmbeddingProvider` の、**外部サービスへ繋がない**実装。
[ruri v3 30m](https://huggingface.co/cl-nagoya/ruri-v3-30m) の ONNX 変換を
[transformers.js](https://github.com/huggingface/transformers.js) で
**同じプロセスの中**で走らせる（[docs/architecture.md](../../docs/architecture.md) §5.5）。

API キーは要らない。ネットワークが要るのは**初回のモデル取得のときだけ**である。

---

## ⚠ 何が良くなって、何が良くならないか

**先に読むこと。**「ローカルに置いたから精度が上がる」ではない。

### 良くなること

|                                  |                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| **外部へテキストが出ない**       | 埋め込むテキストがプロセスの外に出ない。API キーも要らない                                |
| **課金が無い・レート制限が無い** | 件数が増えても料金は増えない。429 で止まらない                                            |
| **日本語**                       | 日本語で学習されたモデルである（`text-embedding-3-small` は多言語だが日本語特化ではない） |
| **ベクトルが小さい**             | 256次元。`text-embedding-3-small` の 1536 次元に対して 1/6 で、索引も小さい               |
| **軽い**                         | 重み 36MB（q8）/ peak RSS 362MB / 4スレッドで **985 文/秒**（32コア機での実測）           |

⚠ **peak RSS は、1回の推論に渡す件数に比例して増える**
（362MB は [ADR 0085](../../docs/decisions/0085-local-embedding-provider.md) の選定時の実測）。
【実測 2026-09-29（[ADR 0358](../../docs/decisions/0358-local-embedding-provider-splits-large-batches.md) §2 の独立した再実測）、既定の設定（q8・4スレッド）、別プロセスごとの peak RSS】1件 253MB /
128件 326〜379MB / 512件（1回） 485〜712MB / 512件を128件×4回に分けると 386〜490MB
（幅は2つの文長分布——10〜20字程度の使い回し・10〜35字程度の混在——の違い。ばらつきが大きいほど幅の上端）。
同じ総件数なら、分けたほうが peak RSS が小さく、時間も同等以下だった。
⚠ 同じ ADR が引く元の 2026-09-27 の実測は、128件・512件で上の約2倍（630MB・1.7GB）だった。原因は特定できておらず
（測り直しはしていない）、ここには再実測の数字を採った。**2048件の数字（旧実測にだけ在る）は、再実測に無いため載せない。**

⭐ **`LocalEmbeddingProvider` は既定で128件ずつに分けて推論する**
（[Issue #1141](https://github.com/takecchi/mnemora/issues/1141) / [ADR 0358](../../docs/decisions/0358-local-embedding-provider-splits-large-batches.md)、2026-09-29）。
`embed(ctx, texts)` に渡す件数が `maxBatchSize`（既定 `DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE` = **128**）
**以下**なら、今までどおり1回の推論で済ませる——**この範囲では、この変更の前後でビット単位で変わらない。**
**128件を超える件数を直接渡したときだけ**、先頭から `maxBatchSize` 件ずつに分けて順に（直列で）推論し、
結果を順番どおりに連結する。mnemora の runtime（embed ジョブ・recall のクエリ）は常に1件ずつ渡すため、
この分割は runtime の経路には影響しない——影響するのは、利用者が `embed()` を直接呼んで129件以上を
まとめて渡すとき（移行・一括の再埋め込みなど）だけである。**そのときも、既定のままで分割は自動的に
行われる**——実測（上記・[ADR 0358](../../docs/decisions/0358-local-embedding-provider-splits-large-batches.md)）
による既定値なので、多くの場合は `maxBatchSize` を自分で指定する必要は無い。より小さい・大きい単位に
分けたいときだけ `maxBatchSize` を指定すること。

⚠ **分割すると、q8 ではベクトルがわずかに変わりうる。**このモデルの量子化（q8）は、バッチの長さ構成に
依存して出力が動くことが実測されている
（[ADR 0095](../../docs/decisions/0095-embedding-provider-conformance.md) 決定5・
[ADR 0099](../../docs/decisions/0099-conformance-against-real-embedding-providers.md) 追記・
[ADR 0110](../../docs/decisions/0110-single-char-token-discriminator.md) §4）。⟹ 129件以上を一度に渡すと、
分割しなかった場合と比べてベクトルがわずかに動く——ただし、これは分割**する前から**、本物の埋め込みモデルが
バッチ不変性を約束していないこと（ADR 0095 決定5）の帰結であり、この変更が新しく持ち込んだ性質ではない。
**128件以下の呼び出し（mnemora の runtime を含む）は、この変更の前後でベクトルが1ビットも変わらない。**

### 🔴 良くならないこと（このモデルでも解けないもの）

**埋め込みは「似ている文字列」を近くに置く道具であって、意味を理解する道具ではない。**
ローカルにしても、そこは変わらない。

- **否定が解けない。**「紅茶は飲まない」と「紅茶を飲む」は近い。
- **時制が解けない。**「引っ越した」と「引っ越す予定だ」は近い。
- **矛盾が解けない。**実測: **「コーヒーより紅茶が好き」と「紅茶よりコーヒーが好き」の
  cos は 0.9949** である。**逆のことを言っている2文が、ほぼ同一と判定される。**
  【実測 2026-09-26、この README にある例文そのものを既定設定（`ruri-v3-30m/sym`・q8・
  256次元）の `LocalEmbeddingProvider` に通した値。環境: x86_64、Node.js v22.23.3、
  `onnxruntime-node` 1.24.3、`@huggingface/transformers` 4.2.0、重み
  `sirasagi62/ruri-v3-30m-ONNX@cdf9391f…`（`onnx/model_quantized.onnx` の sha256
  `3d374a62…`）。[ADR 0328](../../docs/decisions/0328-local-embedding-output-cross-runner-reproducibility-measured.md)
  の実測によれば、この組み合わせ（x64 ランナー・同一版・同一重み）では出力はビット一致する】

- **絵文字が効かない。**このモデルのトークナイザは絵文字を語彙に持たず、どの絵文字も未知語
  `<unk>`（id 0）1つに置き換える（続けて並んだ絵文字もまとめて1つになる）。⟹ 絵文字だけが違う2文は、
  同じベクトルになる。実測: **「寿司🍣が好き」と「寿司🐶が好き」の cos は 1.000000**（トークン列はどちらも
  `<s> 寿司 <unk> が好き </s>`）、「🍣」と「😀」も 1.000000 である。記憶の内容のうち絵文字が担う意味は、
  埋め込みでは区別されない。⚠ これはトークナイザ（モデル）の性質であり、`LocalEmbeddingProvider` の約束の
  違反ではない——返るベクトルは有限・256次元・ノルム 1 で、例外にもならない。
  【実測 2026-09-27、cos は既定設定（`ruri-v3-30m/sym`・q8・256次元、`revision` 未指定）の
  `LocalEmbeddingProvider` に通した値。トークン列は重み `sirasagi62/ruri-v3-30m-ONNX@cdf9391f…` の
  tokenizer で確かめた。環境は上の矛盾の例と同じ（x86_64、Node.js v22.23.3、`onnxruntime-node` 1.24.3、
  `@huggingface/transformers` 4.2.0）】

⟹ **「どちらが正しいか」「いつの話か」を埋め込みに決めさせないこと。**
矛盾の検出・時系列の解決は、mnemora では埋め込みではなく別の層の仕事である
（[docs/memory-model.md](../../docs/memory-model.md)）。

### 🔴 入力は 8192 トークンまで。**超えると例外になる**（黙って切らない）

**このモデルの上限は 8192 トークンである**（`tokenizer_config.json` の `model_max_length`、
`config.json` の `max_position_embeddings`。日本語の自然文では**おおよそ 18,000 字**に相当したが、
⚠ **トークン数と文字数の比は文章によって変わるので、字数は目安にしかならない**）。

**上限を超えた入力を渡すと `embed()` は例外を投げる**（[ADR 0090](../../docs/decisions/0090-embedding-input-token-limit.md)）。
⚠ これは既定の pipeline（`createPipeline` を省いたとき、または `buildLocalEmbeddingPipeline` で組み立てたとき）の振る舞いである。
`LocalEmbeddingProvider` 自身は上限を検査しない——`createPipeline` で自前の pipeline を差したときは、上限を守るのはその pipeline の `embed` である
（`maxInputTokens`・`countTokens` は宣言として要るが、`LocalEmbeddingProvider` はどちらも読まない）。

```ts check
import { isLocalEmbeddingProviderError } from "@mnemora/local-embedding";

try {
  await provider.embed(ctx, [veryLongText]);
} catch (error) {
  if (isLocalEmbeddingProviderError(error) && error.kind === "input_too_long") {
    // error.detail = { index, tokens, maxInputTokens, characters }
    // ⚠ 同じ入力で再試行しても永久に失敗する。分割するか短くすること。
  }
}
```

⚠ **`instanceof` ではなく `kind` で分岐すること**（bundler がクラスを二重に読み込むと
`instanceof` は落ちるが、`kind` は値なので影響を受けない）。

**なぜ例外にするか。**transformers.js は `truncation: true` で呼ぶため、
**上限を超えた入力は黙って切り捨てられ、正常な形のベクトルが返る。**
⟹ **前 8192 トークンだけを表すベクトルが「成功」として DB に入り、
悪くなったことが検索結果の質にしか現れず、原因を追えなくなる。**
落とせば `runtime.tick()` が `embeddingStatus: 'failed'` を書くので、**問い合わせられる状態が残る。**

⛔ **このパッケージは入力（1件の長いテキストの中身）を自動で分割しない。**どう割るか（文境界・重ね幅・
割った後の統合）は想起の質を直接動かす設計判断であり、**呼び出し側の判断として残してある**（ADR 0090 §3.5）。
⚠ **これは `texts`（配列）を件数で分けて推論する話とは別である**——後者（`maxBatchSize`）は
「良くなること」節・[ADR 0358](../../docs/decisions/0358-local-embedding-provider-splits-large-batches.md) を見ること。

### 確かめていないこと

- **`@mnemora/openai` と比べて想起の質がどうなるか**は、このパッケージの作業では測っていない。
  上の「日本語」は**モデルカードの主張であって、この repo のゴールデンセットでの実測ではない。**
- 実測してあるのは prefix 方式の比較だけである（次節）。
- **`observe()` に渡した長いテキストが、この上限に当たる経路は開いたままである**
  （LLM 抽出が失敗すると生の全文が `embed()` へ届く。ADR 0090 §1.5）。
  **このパッケージが買ったのは「当たったことが分かる」までであり、
  「当たらないようにする」ではない。**

---

## `space` の形 — 🔴 `ruri-v3-30m/sym` の `/sym` を消さないこと

```ts check
import type { EmbeddingSpaceId } from "@mnemora/core";

const space: EmbeddingSpaceId = { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 };
```

- **`provider: "local"`** — **プロセス内推論であること**を表す。将来 `packages/tei` 等が
  同じモデルを別のランタイムで動かしても、出てくるベクトルはビット一致しない。
  ⟹ 空間を分けるのが正しい。
- **`model: "ruri-v3-30m/sym"`** — `/sym` は**対称 prefix**（クエリと文書に同じ prefix を
  付ける。ruri v3 では空文字）で作られたベクトルであることを表す。

  ruri v3 は本来 `検索クエリ: ` / `検索文書: ` という**非対称**の prefix を持つモデルで、
  reranking を入れる段でそちらへ切り替える判断はありうる。
  **そのとき、非対称で作ったベクトルと対称で作ったベクトルは同じ空間の点ではない。**
  `/sym` が無ければ `EmbeddingSpaceId` が等しくなり、**両者が同じ space に混ざる**——
  混ざったことは検索結果が少し悪くなる形でしか現れず、原因を追えない。

  `/sym` を持たせておけば、切り替えた実装は `ruri-v3-30m/asym` を名乗ることになり、
  **別 space ⟹ 再インデックスが強制される。**静かに壊れる代わりに、うるさく作り直させる。

**対称 prefix を既定にした根拠（実測）**: 非対称 prefix と比べて
**ΔMRR −0.031、95%CI [−0.094, +0.031]**。信頼区間が 0 をまたいでおり、
**品質は有意に落ちていない。**

### `repo` を上書きするなら `modelId` も上書きすること（Issue #142 / ADR 0247）

**`space.model` は `modelId` から作られ、`repo` からは作られない。**⟹ `repo` だけを
`DEFAULT_LOCAL_EMBEDDING_REPO` と異なる値へ差し替えると、別モデルのベクトルが
同じ space へ混ざる——`/sym` の節が警戒しているのと**同じ壊れ方**である。ただし
そちらは prefix 方式を変えたときの話で、こちらは `repo` そのものが入れ替わる経路である。

⭐ **同じ重みの私設ミラーを使うだけなら、`modelId` に既定と同じ値
（`DEFAULT_LOCAL_EMBEDDING_MODEL_ID`）を明示的に渡せばよい**——別モデルを名乗る
必要は無い。

⚠ **この節は保険であって対処ではない。**実際に止めているのは実装側の guard
（コンストラクタ）である——`repo` が既定と異なり `modelId` が未指定のままだと、
`new LocalEmbeddingProvider(...)` がその場で throw する。この節を読まずに踏んでも、
機械が止める。

---

## インストール

```bash
pnpm add @mnemora/local-embedding @mnemora/core
# または
npm i @mnemora/local-embedding @mnemora/core
```

## 前提

- **TypeScript の `lib`・`target` は ES2022 以上**。公開の `.d.ts` が `ErrorOptions`（ES2022 の lib）を使う（`LocalEmbeddingProviderError` のコンストラクタ。`@mnemora/core` の `memory-store`・`vector-store` の例外クラスも同じ）。
- Node.js >= 22
- **ESM のみ**（`"type": "module"`）
- **初回だけネットワークが要る**（Hugging Face から重みを取得する）。2回目以降はキャッシュから読む。
  既定の置き場所は、transformers.js の既定——`@huggingface/transformers` パッケージ自身の中の
  `.cache/`（例: `node_modules/@huggingface/transformers/.cache/`。pnpm なら
  `node_modules/.pnpm/@huggingface+transformers@<版>/node_modules/@huggingface/transformers/.cache/`）で、
  ホームの `~/.cache` の下ではない。⚠ `node_modules` を消す・入れ直すと一緒に消え、次の読み込みで取り直す。
  置き場所を固定したいときは `cacheDir` を渡す（読み込みの前段の確認も `cacheDir` を見るようになった。
  詳しくは「[`cacheDir` を渡すと、読み込みの前段の確認もそこを見る](#-cachedir-を渡すと読み込みの前段の確認もそこを見る)」の節）
- ネイティブ依存として `onnxruntime-node` が入る（次節）

### 🔴 linux/x64 では、install が **CUDA EP を勝手に落とす**（要らないのに）

**このパッケージは CPU 推論しかしない。**それでも `onnxruntime-node` の postinstall は、
**プラットフォームによっては CUDA execution provider を追加ダウンロードする。**
`onnxruntime-node@1.24.3` の `script/install-metadata.js` を読んで測った既定値:

| プラットフォーム                                                            | postinstall が落とすもの                            |
| --------------------------------------------------------------------------- | --------------------------------------------------- |
| **`linux/x64`**                                                             | 🔴 **`cuda12`**（このリポジトリの実測で **302MB**） |
| `linux/arm64` / `darwin/x64` / `darwin/arm64` / `win32/x64` / `win32/arm64` | **無し**（`[]`）                                    |

⚠ **効くのは linux/x64 ——つまり大半の CI runner・Docker image・サーバである。**
手元の mac では起きないので、**気づくのは本番の image を焼くときになる。**

**CPU 版のネイティブバイナリは tarball に同梱済みなので、落とさなくても動く。**

#### 止め方

| 使っている物     | 既定                                                                                                          | やること                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **npm / yarn**   | 🔴 **postinstall が走る**                                                                                     | `ONNXRUNTIME_NODE_INSTALL=skip npm i`、または `.npmrc` に `onnxruntime-node-install=skip`                                                                                                                                                                                                                                                                          |
| **pnpm 10**      | ✅ 走らない（ビルドスクリプトは既定で拒否。警告だけ出て install は通る）                                      | 何もしなくてよい。**明示したいなら** 下の pnpm 11 以降と同じ3行を書く                                                                                                                                                                                                                                                                                              |
| **pnpm 11 以降** | ✅ 走らない。🔴 **ただし install が `ERR_PNPM_IGNORED_BUILDS` で終了コード 1 になる**（パッケージ自体は入る） | `pnpm-workspace.yaml` に `allowBuilds:` の3行 `onnxruntime-node: false`・`protobufjs: false`・`sharp: false` を書く（`onnxruntime-node` だけでは、残りの2つで同じく 1 になる）。pnpm が自分で `set this to true or false` という仮の値を書き足していたら、それを置き換えること【実測 2026-09-27、`pnpm pack` した tarball を repo の外の空のプロジェクトに入れた】 |

⚠ **このリポジトリ自身の `pnpm-workspace.yaml` の `allowBuilds` は、公開物には付いていかない。**
あれはこの repo を clone した人にしか効かない設定であり、
**`npm i @mnemora/local-embedding` を打った人は、上を自分でやる必要がある。**

**確かめていないこと**: `ONNXRUNTIME_NODE_INSTALL=skip` を渡した状態で
このパッケージが動くことは、**この repo では測っていない**（pnpm が既定で
postinstall を拒否しており、その状態で動いていることは測ってある——
つまり「CUDA EP 無しで動く」ことは押さえられているが、
**npm 経路でその env を渡す形そのもの**は測っていない）。

⚠ 2026-09-27 追記: 上の「確かめていないこと」は、その後に測った。`ONNXRUNTIME_NODE_INSTALL=skip npm i @mnemora/local-embedding @mnemora/core` で入れると、`onnxruntime-node` の `bin/napi-v6/linux/x64/` には CPU 版（`libonnxruntime.so.1`・`onnxruntime_binding.node`）だけが在り（CUDA EP は落ちていない）、`warmup()` → `embed()` が 256 次元を返した【実測 2026-09-27、`pnpm pack` した tarball を repo の外の空のプロジェクトに入れた】。

### ⚠ 依存に `npm audit` の high が5件在る（すべて推移的・上流に修正版が無い）

**先に言う: 直せない。**`@huggingface/transformers` の下にあり、
`fixAvailable: false` である。**隠さずに書くほうを選んでいる。**

素の consumer で `@mnemora/local-embedding@0.1.4` を install して測った結果
（`high: 5` / `critical: 0`）:

| package   | 経路                          | 中身                                                                                                              |
| --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `adm-zip` | `onnxruntime-node` →          | 細工した ZIP で 4GB 確保 / **展開時に destination symlink を辿り任意ファイルを上書き**                            |
| `sharp`   | `@huggingface/transformers` → | libvips（CVE-2026-33327 / -33328 / -35590 / -35591）と libheif（GHSA-g89c-p67h-r497 / GHSA-2jg2-4ch7-h545）の継承 |

> **⭐ 2026-09-17 追記（一次情報を当て直した。上の表も本文も書き換えていない）。**
> ⭐ **表に並ぶ6つの識別子は、すべて実在する一次情報へ辿れる。** **【実測 2026-09-17】** 当てた先と結果:
>
> | 識別子                                            | 当てた先                                           | 結果                                                                                                                                                                                                                      |
> | ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `CVE-2026-33327` / `-33328` / `-35590` / `-35591` | MITRE CVE Services（`cveawg.mitre.org/api/cve/…`） | **4件とも HTTP 200 / `state: PUBLISHED`**。`vendor: libvips`。影響は `<= 8.18.0`（33327 / 33328）・`<= 8.18.1`（35590 / 35591）                                                                                           |
> | 同上（sharp 側の名乗り）                          | GitHub advisory database                           | [`GHSA-f88m-g3jw-g9cj`](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) _"sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591"_（`sharp < 0.35.0`、2026-07-21） |
> | `GHSA-g89c-p67h-r497` / `GHSA-2jg2-4ch7-h545`     | GitHub advisory database / OSV                     | ⚠ **単独では引けない**（下記）                                                                                                                                                                                            |
> | 同上（sharp 側の名乗り）                          | GitHub advisory database                           | [`GHSA-rgj7-g3m4-5g8c`](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) _"sharp: Vulnerabilities in libheif: GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545"_（`sharp < 0.35.4`、2026-09-08）                             |
>
> - ⚠ **`GHSA-g89c-p67h-r497` と `GHSA-2jg2-4ch7-h545` は、当てた3箇所すべてで引けなかった**
>   （`gh api /advisories/<id>` → **404**、`https://github.com/advisories/<id>` → **404**、
>   `https://api.osv.dev/v1/vulns/<id>` → **404**）。
>   ⛔ **「存在しない」ということではない。** **`strukturag/libheif` のリポジトリ配下の advisory**
>   （`https://github.com/strukturag/libheif/security/advisories/…`）であり、
>   **グローバルの advisory database と OSV には載っていない**——`GHSA-rgj7-g3m4-5g8c` の
>   `references` がその URL を指している。⟹ **識別子は正しい。引く先が違うだけである。**
> - ⭐ **`GHSA-g89c-p67h-r497` には CVE も付いている**——`GHSA-rgj7-g3m4-5g8c` の本文が
>   **`CVE-2026-84383`** として引いている。
> - ⚠ **上の「上流に修正版が無い」は、`fixAvailable: false` からは出てこない。**
>   `npm audit` の `fixAvailable: false` は「**いまの依存木の制約の中では修正版へ上げられない**」であって、
>   「上流に修正版が無い」ではない。**【実測 2026-09-17】** 上流 `sharp` には修正版が在る——
>   libvips 側は **`0.35.0`**、libheif 側は **`0.35.4`** で修正済み（patched）と advisory に書かれている。
>   この repo の `pnpm-lock.yaml` が解決しているのは **`sharp@0.34.5`**（`@huggingface/transformers@4.2.0` 経由）であり、
>   **上げられないのは上流ではなく、依存木の制約の側である。**
>   ⛔ **だからどうしろ、とはここでは書かない。** ⭐ **測った結果を書いただけである。**
>   ⚠ **確かめていないこと**: 当てたのは**この repo の `pnpm-lock.yaml`** であって、
>   公開された `@mnemora/local-embedding` を素の consumer が install した木ではない。
>   **上の表を作った `npm audit` の実行を再現してはいない。**
> - ⭐ **この追記が腐ったかは、`gh api /advisories/GHSA-rgj7-g3m4-5g8c` と
>   `gh api "/advisories?ecosystem=npm&affects=sharp"` で引き直せる。**

⭐ **脆弱な経路は、どちらもこのパッケージが通らない経路である**:

- **`sharp` は画像入力用。**テキスト埋め込みでは通らない
- **`adm-zip` は `onnxruntime-node` の postinstall がアーカイブを展開するところ**
  ⟹ 🔴 **上の「postinstall を止めろ」は、302MB を節約するだけでなく、
  この展開経路そのものを踏まないことでもある**

⚠ **「通らない経路だから安全」は、この repo が読んだ限りの話である。**
`@huggingface/transformers` が内部でどこから `sharp` を触りうるかを
**網羅的に追ったわけではない。**気になるなら自分で `npm audit` を打つこと
（版が進めば結果は変わる）。

## 使い方

```ts
import { createRuntime } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";

// 既定で ruri-v3-30m/sym・256次元・q8・4スレッド。
const embeddingProvider = new LocalEmbeddingProvider();

// space は new した直後に確定している（モデルの読み込みを待たない）。
console.log(embeddingProvider.space);
// { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 }

const runtime = createRuntime({
  // ...memoryStore / vectorStore / ... は省略
  embeddingProvider,
  llmProvider,
});
```

### `signal`（abort）を渡したときの振る舞い（ADR 0359 / ADR 0428）

`embed(ctx, texts, { signal })` は、abort されると reject する。値は `signal.reason`（`reason` 無しの `abort()` なら
`AbortError` の `DOMException`）。呼ぶ前に abort 済みならモデルを読み込まずに reject する。**モデルの読み込み中・読み込みの
再試行の待ちも、`signal` ごとに切れる**——abort された呼び出しは読み込みの完了を待たずに即座に reject する。
⚠ **ただし読み込みそのものは abort で止まらない。**複数の `embed()` が待つ共有の読み込み（とその再試行）は続き、切れるのは
abort した呼び出しの待ちだけである（ある呼び出しの abort が、同じ読み込みを待つ別の呼び出しを巻き添えにしない。全員が
abort しても読み込みは終わりまで走り、成功すればモデルは保持される）。⚠ **推論の途中も止まらない**——`/transformers`
の呼び出し自体を中断する口が無いので、推論が終わるまで待ち、終わった時点で abort 済みならベクトルを返さずに reject する。
⚠ **2026-10-01 追記（ADR 0445）: 件数が `maxBatchSize`（既定 128）を超えて分割されたときは、チャンクの合間で abort を見る**——動いている1チャンクは止まらないが、abort 済みなら残りのチャンクは推論せずに `signal.reason` で reject する（以前は全チャンクを推論してから reject していた）。
`warmup()` は `signal` を取らない。

### モデルは**最初の `embed()` まで読み込まれない**

`new` はモデルを読まない。読むのは最初の `embed()` である。
**同時に何本 `embed()` が来ても、読み込みは1回に畳まれる**——
これを畳まない素朴な実装では、8本並行で**8回読み込み、
557ms / 406MB が 3,138ms / 1,009MB になる**ことを実測している。

読み込みに失敗したら、次の `embed()` で**やり直す**
（一度の失敗でインスタンスが永久に使えなくなることは無い）。

### 🔴 読み込みは、種類の分かっていない失敗を既定で3回まで試す（Issue #261 / ADR 0141）

**モデルの取得（Hugging Face からのネットワーク取得）は、キャッシュが効いていても
完全には無くならない**——`AutoTokenizer` の内部実装が `cacheDir` を運ばない
1本の軽いメタデータ確認（`tokenizer_config.json` への Range リクエスト）が、
キャッシュの温かさに関係なく毎回残る（ADR 0107 で実測・特定済み）。
**この1回が一時的なネットワーク断や 429 に当たると、キャッシュが完全に効いていても
読み込みが失敗する。**

⟹ **`createPipeline` が「`kind` の付いていない」失敗（`errors.ts`。多くはネットワーク）を
返したときは、指数バックオフ（+ jitter）を挟んで既定 **3回**まで試してから諦める。**
呼び出し側（`embed()` / `warmup()`）には、リトライを使い切って本当に失敗したときしか
例外が届かない。

⚠ 2026-09-27 追記: 【実測】キャッシュを温めた後に、**ネットワークを完全に切った**（別の network namespace で、どこにも届かない）状態で新しいプロセスから読み込むと、失敗せずに `embed()` が 256 次元を返した（`@huggingface/transformers@4.2.0`、`cacheDir` 未指定、pnpm）。⟹ 上の「この1回が一時的なネットワーク断…に当たると、キャッシュが完全に効いていても読み込みが失敗する」は、**少なくとも「どこにも届かない」形の断では起きなかった。**`HTTP 429` などの応答がその1回に返ったときに読み込みが失敗するかは、確かめていない（[ADR 0141](../../docs/decisions/0141-local-embedding-load-retry.md) が CI で見た 429 は、キャッシュの無い取得の回のものだった）。

```ts check
const provider = new LocalEmbeddingProvider({
  retry: {
    attempts: 5, // 既定は3
    delayMs: (attempt) => attempt * 500, // 既定は指数バックオフ + full jitter
  },
});
```

⚠ **`attempts` に有限でない値（`Infinity`・`-Infinity`）を渡すと、構築時に `RangeError` を投げる**（Issue #1785。「成功するまで無限に再試行」は約束しない）。`NaN`・0以下は 1 回（実質リトライ無し）に丸め、小数は切り捨てた回数だけ試す（`2.5` は2回）。

⚠ **`kind` の付いた失敗（`input_too_long` / `unknown_input_limit`）はリトライしない。**
入力・設定の問題であり、同じ入力で再試行しても結果は変わらないため
（README「入力は 8192 トークンまで」節・ADR 0090）。

⚠ **これは「CI の都合」で足した振る舞いではない。**ネットワーク越しに1回だけ取得する
処理が一時的な失敗を吸収せずに使う側へそのまま投げるのは、CI に限らずこのパッケージを
使うどの環境でも起きうる話であり、ライブラリとして自然な既定だと判断した
（採らなかった案・理由は ADR 0141）。

### 🔴 キャッシュのファイルが壊れていると、再試行でも次のプロセスでも直らない

（[Issue #1140](https://github.com/takecchi/mnemora/issues/1140)。今の振る舞いを書くだけで、自動で消して取り直すか・
壊れていると分かった失敗を再試行しないかは決めていない。）

モデルのキャッシュのファイルが壊れていると（取得の中断・ディスクの問題などで、onnx や `tokenizer.json` が途中で
切れている・0 バイトになっている）、読み込みは**同じ失敗を繰り返す**:

- 壊れたファイルの失敗は「種類の分かっていない」失敗なので、上の再試行（既定3回）の対象になる。だが同じファイルを
  読み直すだけなので、**3回とも同じく失敗する。**
- **壊れたファイルは消さない。**失敗の後もそのまま残るので、次のプロセス（新しい `LocalEmbeddingProvider`）でも
  同じく失敗する。
- 失敗のメッセージは、原因の候補にキャッシュのファイルの破損を挙げ、消す場所（`<cacheDir>/<repo>`、`cacheDir` が
  未指定なら既定の置き場）を名指す（PR #1134。`revision` を渡していれば根が `<cacheDir>/<encodeURIComponent(revision)>` に変わり、名指す場所も `<その根>/<repo>` になる）。原因そのものは `cause` にある（例: `Protobuf parsing failed`、
  `Unexpected end of JSON input`）。

⟹ 直すには、名指された場所（そのモデルの repo のディレクトリ）を**自分で消して**、取り直させること
（消すと、次の読み込みで取り直して動いた。Issue #1140）。
⚠ 同じ `cacheDir` を別のプロセスが使っているなら、消す前に止めること。

【実測 2026-09-27、transformers.js 4.2.0】onnx を途中で切る・onnx を 0 バイトにする・`tokenizer.json` を途中で切る・
`config.json`・`tokenizer_config.json` を空にする、の4形で同じだった（Issue #1140）。歯は `src/__tests__/corrupt-cache-persists.test.ts`
（途中で切れた `tokenizer.json` と onnx、ネットワークに出ない形）。

### ⭐ `cacheDir` を渡すと、読み込みの前段の確認もそこを見る

（直った。[Issue #1239](https://github.com/takecchi/mnemora/issues/1239)・[Issue #1004](https://github.com/takecchi/mnemora/issues/1004)。[ADR 0361](../../docs/decisions/0361-local-embedding-cache-dir-env-swap.md)）

【実測 2026-09-27、`@huggingface/transformers@4.2.0`】`cacheDir` にモデルの4ファイル（`config.json`・`tokenizer.json`・
`tokenizer_config.json`・`onnx/model_quantized.onnx`）が揃っていても、transformers.js の `pipeline()` は読み込みの前段の
確認で `config.json`・`tokenizer_config.json` の有無を**既定のキャッシュ**（transformers.js の `env.cacheDir`。上の「前提」の
置き場所）**だけで**確かめ、`cache_dir` オプションを運ばない。⟹ 既定のキャッシュが空だと、`cacheDir` がどれだけ温かくても
この前段の確認だけが Hugging Face へ出て、ネットワークが無ければ読み込みが失敗していた。

**いまは、`createLocalEmbeddingPipeline`（既定の `createPipeline`）が `pipeline()` を呼んでいる間だけ、
transformers.js の `env.cacheDir` を `cacheDir` と同じ場所へ一時的に向ける**（呼び出しが終わったら、成功でも失敗でも
必ず元へ戻す）。前段の確認は `env.cacheDir` だけを見るので、これで `cacheDir` の中身がそのまま見える。⟹ **`cacheDir` に
4ファイルが揃っていれば、既定のキャッシュが空でも、ネットワークへの要求は0回になる**（下の歯で実測・固定している）。

- ⭐ **`cacheDir` を渡さない（既定のキャッシュそのものを温めた）使い方は、今までどおり変わらない**——`env.cacheDir` に
  触るのは `spec.cacheDir` が指定されているときだけである。
- ⚠ **`env` はプロセス全体で共有される大域であり、このパッケージだけのものではない。**差し替えは
  `pipeline()` を呼んでいる間だけの一時的なものだが、その**間**に**このパッケージを経由しない、同じプロセスの
  他の transformers.js の利用**（自分で `import("@huggingface/transformers")` して `pipeline()` を直接呼ぶコード、
  自前の `createPipeline`、`@mnemora/local-embedding` 以外の別のライブラリ）が読み込むと、差し替えた後の値
  （`cacheDir`）を見うる。**それらは下の直列化の外に居るので、このパッケージからは守れない。**
  `cacheDir` の違う2つの `LocalEmbeddingProvider`（や `warmup()`/`embed()` の並行呼び出し）どうしは、
  下の直列化により、もう片方の差し替えの最中の値を見ない。
- ⭐ **`createLocalEmbeddingPipeline` を呼ぶ経路（＝このパッケージがモデルを読み込む唯一の経路）は、
  プロセス内で1本の待ち行列に直列化してある。**`cacheDir` を差し替えていないだけの呼び出しも、
  この待ち行列を通る——通さないと、差し替えている最中の値が漏れて見えてしまう。
  【実測】2つの読み込み（片方は warm な `cacheDir`、もう片方は空の `cacheDir`）を待ち行列無しで並行させると、
  **本来成功するはずの側**が `this.tokenizer is not a function` で落ちた。待ち行列を挟むと両方とも正しく決着する
  （片方は成功、もう片方はそのディレクトリの中身どおりに失敗する）。**一方が失敗しても、待ち行列そのものは
  詰まらない**——次の読み込みは待たされず進む。
- `revision` を `main` 以外にしたときは、キャッシュの根が `revision` ごとに分かれる（下の節。Issue #1403）。
- ⚠ 確かめていないこと: transformers.js の 4.2.0 以外の版。同じプロセス内の別のライブラリが `env.cacheDir` を読む・書く
  タイミングと重なったときの網羅的な組み合わせ（直列化しているのはこのパッケージ自身の呼び出しどうしだけである）。

`env.cacheDir` の差し替えは、次の歯が縛っている:

- `src/__tests__/cache-dir-preflight-default-cache.test.ts`（本物の transformers.js・偽のファイル。
  `createLocalEmbeddingPipeline` 経由で読み込み、ネットワークへの要求が0回であることを縛る）。
- `src/__tests__/cache-dir-env-swap-serialization.test.ts`（`@huggingface/transformers` を丸ごと mock。
  `env.cacheDir` の差し替えと復元・直列化そのものを縛る——上の実測の再現も含む）。
- `src/__tests__/live.cache-dir-offline-read.test.ts`（opt-in。本物のモデルを一度だけ温め、まっさらな別プロセス・
  既定のキャッシュ空・ネットワーク無効の状態で `createLocalEmbeddingPipeline` から読み、256次元のベクトルが
  ネットワーク0回で返ることを確かめる）。

transformers.js の版上げで前段の確認が `cache_dir` を自分で運ぶようになれば、上の歯は0回のまま変わらず緑だが、
この差し替え自体が不要になる（実害は無いが、意味の無い迂回になる）——ADR 0361 の「これが覆るとしたら」を見ること。

#### `revision` を `main` 以外にしたときの置き場所

（[Issue #1403](https://github.com/takecchi/mnemora/issues/1403)。[ADR 0365](../../docs/decisions/0365-local-embedding-revision-in-remote-path-template.md)）

**`revision` を渡すと、キャッシュの根は `<根>/<encodeURIComponent(revision)>/` になる。**その下の置き方は
`revision` 無しと同じ `<repo>/<file>` である。根は、`cacheDir` を渡していればそれ、渡していなければ
transformers.js の既定のキャッシュ（上の「前提」の置き場所）で、`cacheDir` の有無で振る舞いは分かれない。

| 渡したもの | ファイルの置き場所 |
|---|---|
| `revision` 無し | `<根>/<repo>/<file>` |
| `revision: "<sha>"` | `<根>/<sha>/<repo>/<file>` |
| `revision: "refs/pr/1"` | `<根>/refs%2Fpr%2F1/<repo>/<file>` |

既定の `createPipeline` は、`revision` を transformers.js の `pipeline()` へ渡さず、`pipeline()` を呼んでいる間だけ
次の2つを差し替える（成功でも失敗でも元へ戻す。上の `env.cacheDir` の差し替えと同じ待ち行列の中で行う）。

- `env.remotePathTemplate` の `{revision}` を、`encodeURIComponent(revision)` に置き換える（利用者が変えた
  template を土台にする）。
- キャッシュの根（`cache_dir` と `env.cacheDir`）を、上の `<根>/<revision>/` にする。

**なぜこうするか。**transformers.js（4.2.0。4.3.0 と、2026-09-23 時点の上流の `main` も同じ）の読み込みの前段の確認は、
`cache_dir` だけでなく `revision` も運ばない。`revision` を `pipeline()` に渡すと、実際の読み込みは
`<repo>/<revision>/<file>` を探すのに、前段の確認だけは `main` の鍵（`<repo>/config.json`）を探す。
そのため、以前は `revision` を固定すると、温めてもオフラインでは読めなかった
（【実測 2026-09-29】`resolve/main/config.json` へ出て失敗した。`examples/chat` の CI の「温めたキャッシュだけで…
（測るだけ）」のステップも `ok=false` だった）。いまは前段の確認も実際の読み込みも、同じ根・同じ revision の URL を見る。
ネットワークがあるときに前段の確認が `main` の `config.json` を見ることも、なくなった。

根を `revision` ごとに分けるのは、`revision` 無しで温めた中身が、固定した `revision` の中身として黙って
読まれないようにするためである（template に埋め込むと、transformers.js はキャッシュを `main` と同じ
`<repo>/<file>` の鍵で引く）。

- ⚠ **この版より前に `revision` を渡して温めたキャッシュ（`<根>/<repo>/<revision>/<file>`）は、もう使われない。**
  ネットワークがあれば、新しい根へモデル一式（約42MB）を1回取り直す。**ネットワークの無い場所で使うなら、先に新しい根へ
  温め直すこと**（`revision` を渡して一度読み込めばよい）。古い置き場所は自動では消さない。
- ⚠ `env.remotePathTemplate` も、`env.cacheDir` と同じくプロセス全体で共有される大域である。このパッケージを
  経由しない transformers.js の利用が、差し替えの最中に読み込むと、差し替え後の値を見うる（上の `env.cacheDir` と同じ限界）。
- ⚠ `env` を読めない、根が無い（`cacheDir` を渡さず、既定のキャッシュも無い）、`env.remotePathTemplate` が
  文字列でない、のどれかのときは、今までどおり `revision` を `pipeline()` へ渡す。

この振る舞いは次の歯が縛っている: `src/__tests__/revision-offline-preflight.test.ts`（本物の transformers.js・
偽のファイル）・`src/__tests__/revision-env-swap.test.ts`（`@huggingface/transformers` を丸ごと mock）・
`src/__tests__/live.revision-offline-read.test.ts`（opt-in。本物のモデル）。

### 先に読み込ませたいときは `warmup()`

```ts check
await embeddingProvider.warmup(); // 最初のリクエストにロード時間を被せない
```

⚠ **`embed(ctx, [])` ではウォームアップできない**——空配列は `[]` を即返し、
モデルを起こさない（`@mnemora/openai` と同じ）。だから `warmup()` が別に在る。

⚠ `warmup()` が済ませるのは**モデルの読み込みだけ**である。推論は一度も走らせない
（初回推論のグラフ確保ぶんは残る）。ウォームアップのつもりで
モデルへ勝手な入力を流さないため、意図してそうしてある。

### 使い終わったら `dispose()`（任意）

```ts check
await embeddingProvider.dispose(); // モデル（ONNX のセッション）を手放す
```

- 上流（`@huggingface/transformers`）の `dispose()` に委ねる。一度も読み込んでいなければ何もしない。
- 読み込み中・推論中に呼んでも、それらが終わるのを待ってから解放する。2回呼んでも安全。
- 🔴 **呼んだ後の `embed()` / `warmup()` は例外になる**（空配列でも）。読み込み直さない——続けるなら新しいインスタンスを作ること。
- `EmbeddingProvider` の interface には無い（この provider だけの任意の口）。`runtime` は呼ばない。
  終了時に呼ぶのは利用者の仕事（[ADR 0419](../../docs/decisions/0419-local-embedding-provider-dispose.md)）。

### オプション

| オプション       | 既定                                          |                                                                                                                                                                   |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`           | `"sirasagi62/ruri-v3-30m-ONNX"`               | Hugging Face の repo id                                                                                                                                           |
| `dtype`          | `"q8"`                                        | 量子化の別                                                                                                                                                        |
| `dimensions`     | `256`                                         | **宣言する**次元数。実物と食い違えば初回 `embed()` で例外になる。正の安全な整数でなければ構築時に投げる（ADR 0498）                                                                                                   |
| `modelId`        | `"ruri-v3-30m/sym"`                           | `space.model` に載る文字列                                                                                                                                        |
| `prefix`         | `""`                                          | 全テキストの先頭に付ける文字列                                                                                                                                    |
| `cacheDir`       | 未指定（`@huggingface/transformers/.cache/`） | モデルの置き場所                                                                                                                                                  |
| `numThreads`     | `4`                                           | onnxruntime の intra-op スレッド数。正の安全な整数でなければ構築時に投げる（ADR 0498）                                                                                                                                |
| `maxBatchSize`   | `128`                                         | `embed()` を1回の推論に渡す最大件数。超えた分は分けて呼ぶ（ビット一致するのはこの値以下。Issue #1141 / ADR 0358）                                                 |
| `revision`       | 未指定（transformers.js の既定 `"main"`）     | Hugging Face の revision（枝名・tag・commit sha）。渡すと、キャッシュの根が `<根>/<encodeURIComponent(revision)>/` に分かれる（「`revision` を `main` 以外にしたときの置き場所」の節。Issue #1403）。重みの指紋の照合との関係は Issue #597 |
| `createPipeline` | transformers.js                               | モデルを読み込む関数（**テスト用の注入点**）                                                                                                                      |
| `retry`          | `{ attempts: 3 }`                             | 読み込みが「種類の分かっていない」失敗（多くはネットワーク）をリトライする回数・間隔（Issue #261 / ADR 0141）                                                     |
| `sleep`          | `setTimeout` を使う本物の待ち                 | リトライの待ち時間を実際に待つ関数（**テスト用の注入点**）                                                                                                        |

既定値は `DEFAULT_LOCAL_EMBEDDING_REPO`・`DEFAULT_LOCAL_EMBEDDING_DTYPE`・`DEFAULT_LOCAL_EMBEDDING_DIMENSIONS`・
`DEFAULT_LOCAL_EMBEDDING_MODEL_ID`・`DEFAULT_LOCAL_EMBEDDING_PREFIX`・`DEFAULT_LOCAL_EMBEDDING_NUM_THREADS`・
`DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE`・`DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS` として export している
（`space.provider` の `"local"` は `LOCAL_EMBEDDING_PROVIDER_ID`）。

**`numThreads` の既定が 4 なのは実測による**——32コア機で、既定（コア数まかせ）の
819 文/秒 に対し 4スレッドで **985 文/秒**だった。**増やすほど速くなるわけではない。**

### 🔴 `prefix` は1本の文字列である（クエリ用と文書用に分けられない）

これは意図した制限である。`EmbeddingProvider.embed(ctx, texts)` は、
**渡されたテキストがクエリなのか文書なのかを知らない。**
そしてそれを知っている呼び出し口（`recall-runtime.ts` / `runtime.ts`）は、
この interface 越しにしか provider を触らない。

⟹ 非対称 prefix を**表現できる型**（`{ query, document }`）にすると、
「設定できるのに、どちらが使われるかは呼ばれ方次第」という、
**設定した人が裏切られる形**になる。型のほうで対称性を強制して、それを起こせなくしてある。

**`prefix` を変えたら `modelId` も変えること**——変えないと、別の prefix で作った
ベクトルが同じ space に混ざる。

---

## モデルが取得できなくなったら（再変換の手順）

**このパッケージが読み込みに失敗したときの例外は、この節を指している。**

既定の `repo`（`sirasagi62/ruri-v3-30m-ONNX`）は**個人の変換 repo** である。
消える可能性は承知のうえで選んでいる。**成り立っている前提は、
「元モデルが公式で、変換を自分でやり直せる」ことである。**

|                |                                                          |
| -------------- | -------------------------------------------------------- |
| 元モデル       | **`cl-nagoya/ruri-v3-30m`**（ライセンス **apache-2.0**） |
| 揃えるべき条件 | **dtype `q8` / mean pooling / L2 normalize / 256次元**   |

pooling は ruri v3 の `1_Pooling/config.json` が mean pooling であることを確認した値である。
**pooling や正規化を変えると、出てくるベクトルは別物になる**——
そのときは `modelId` も変えて別 space にすること（`/sym` の節と同じ理由）。

### 変換（Optimum の CLI を使う想定）

```bash
pip install "optimum[onnxruntime]"

# 1. ONNX へ書き出す
optimum-cli export onnx \
  --model cl-nagoya/ruri-v3-30m \
  --task feature-extraction \
  ./ruri-v3-30m-onnx

# 2. q8（動的量子化）を作る。transformers.js は dtype="q8" のとき
#    onnx/model_quantized.onnx を探す
optimum-cli onnxruntime quantize \
  --onnx_model ./ruri-v3-30m-onnx \
  --avx512 \
  -o ./ruri-v3-30m-onnx-q8
```

⚠ **上のコマンド列は、この作業では実行していない**（Python 環境を用意していない）。
Optimum の文書から書いたものであり、**動くことを確かめていない。**
オプション名や出力ファイル名は Optimum の版で変わりうる。
確かなのは表の側——**元モデルの識別子・ライセンス・揃えるべき条件**である。

⛔ **重みをこのリポジトリへ持ち込まないこと**（オーナーの判断）。手順だけを置く。

### 変換したものをどこに置けば拾われるか

**確かめた経路**（このパッケージのコードとして成立している）:

```ts check
// 自分の Hugging Face repo へ push して、その id を指す。repo を差し替えるときは modelId も渡す
// （上の「`repo` を上書きするなら `modelId` も上書きすること」。repo だけだと構築時に例外になる）。
new LocalEmbeddingProvider({ repo: "your-org/ruri-v3-30m-ONNX", modelId: "ruri-v3-30m-your-org/sym" });

// 置き場所（キャッシュ）を移すだけならこちら。
new LocalEmbeddingProvider({ cacheDir: "/var/lib/mnemora/models" });
```

`modelId` には、そのモデルを名乗る別の id を渡す。既定の重みと同じ出力になることを確かめた私設ミラーだけは、
既定と同じ `DEFAULT_LOCAL_EMBEDDING_MODEL_ID`（`"ruri-v3-30m/sym"`）を渡してよい。

`repo` と `cacheDir` が `createPipeline` へそのまま渡ることは
`src/__tests__/local-embedding-provider.test.ts` で検査している。この節と次の節の `new LocalEmbeddingProvider(...)` が
構築時に例外を投げないことは `src/__tests__/readme-constructor-examples.test.ts` で検査している（ネットワークには出ない）。

#### ネットワークに一切出ずに、手元のファイルだけで動かす

⚠ **2026-09-29 訂正（Issue #1403 の調べで判明）**: この節はこれまで「🔴 **`repo` に絶対パスは渡せない**
（transformers.js はモデル id を `env.localModelPath` からの相対で解決する）」と書いていたが、事実ではなかった。
【実測 2026-09-29、`@huggingface/transformers@4.2.0`】モデルの4ファイルを置いたディレクトリの**絶対パス**を
`repo` に渡し（`modelId` には別の id を渡す）、`env.fetch` を必ず失敗させて `LocalEmbeddingProvider` から
`embed()` すると、ネットワークへの要求は0回で256次元のベクトルが返った。transformers.js は、Hugging Face の
モデル id の形でない値を、ディレクトリのパスとしてそのまま読む（`utils/hub.js` の `buildResourcePaths`）。
mnemora の側にも、絶対パスを拒む検査は無い。⟹ **手元のディレクトリだけで動かすなら、`repo` にその絶対パスを
渡すのがいちばん短い。**この形なら `env` にも触らない。

`env.localModelPath` を使う形（`repo` には、そのディレクトリの下のフォルダ名を渡す）も動く。ただし
`env.localModelPath`・`env.allowRemoteModels` を触る必要があり、それは `createPipeline` を差す仕事になる。
既定の `createPipeline` が触るのは、`pipeline()` を呼んでいる間だけの `env.cacheDir`（上の「`cacheDir` を渡すと、
読み込みの前段の確認もそこを見る」節）と、`revision` を渡したときの `env.remotePathTemplate`（上の「`revision` を
`main` 以外にしたときの置き場所」節）だけであり、`env.localModelPath`・`env.allowRemoteModels` には触れない
（`env` はプロセス全体で共有される大域なので、既定の `createPipeline` は必要な最小限しか触らない設計にしてある）。

**この形が実際に動くことは確かめた**（2026-09-10T00:37Z にこの器で実行。
以下は `LocalEmbeddingPipeline` が**必須 interface**になった後の形——
[ADR 0090](../../docs/decisions/0090-embedding-input-token-limit.md) 決定4の負債1を
[ADR 0205](../../docs/decisions/0205-local-embedding-pipeline-required-interface.md) で塞いだことに伴い、
`createPipeline` が返すものは `(texts) => Promise<number[][]>` という関数**ではなく**、
`{ maxInputTokens, countTokens, embed }` を持つオブジェクトでなければならない。
`buildLocalEmbeddingPipeline(extractor)` に渡せば、この組み立ては自動でやってくれる）:

⚠ この形は `@huggingface/transformers` を**自分のコードから直接 import する**。`@mnemora/local-embedding` の
依存として入るだけでは、pnpm や `npm install --install-strategy=nested` の配置だと自分のコードから解決できない
（`TS2307: Cannot find module '@huggingface/transformers'`）。自分の依存にも足すこと——版は
`@mnemora/local-embedding` の `package.json` の `dependencies` と同じものにする（違う版を足すと2つ入る）。

```ts check
import {
  LocalEmbeddingProvider,
  buildLocalEmbeddingPipeline,
  type CreateLocalEmbeddingPipeline,
} from "@mnemora/local-embedding";

// 再変換した重みを /var/lib/mnemora/models/my-ruri へ置いた、という想定。
// （config.json / tokenizer.json / tokenizer_config.json / onnx/model_quantized.onnx）
const createPipeline: CreateLocalEmbeddingPipeline = async (spec) => {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.localModelPath = "/var/lib/mnemora/models";
  env.allowRemoteModels = false; // ⭐ ネットワークへ出ない
  const extractor = await pipeline("feature-extraction", spec.repo, {
    dtype: spec.dtype,
    session_options: { intraOpNumThreads: spec.numThreads, interOpNumThreads: 1 },
  });
  // ⚠ `extractor.tokenizer.model_max_length` が宣言されていない（`Infinity`）モデルは、
  // ここで `kind: "unknown_input_limit"` を投げて組み立て自体が失敗する——
  // 上限を知らないまま pipeline を作れないようにするための歯である。
  return buildLocalEmbeddingPipeline(extractor);
};

const provider = new LocalEmbeddingProvider({ repo: "my-ruri", modelId: "ruri-v3-30m-my-ruri/sym", createPipeline });
```

⚠ 2026-09-28 追記: 下の「確かめたこと」の実測（2026-09-10）の後、`repo` だけを差し替えると構築時に例外を投げる検査が入った
（Issue #142 / ADR 0247）。そのため、上の例に `modelId` を足した（以前の形 `{ repo: "my-ruri", createPipeline }` は構築で投げる）。

**確かめたこと**: この形で 256 次元のベクトルが返り、
「今日は雨が降っている」と「本日は雨天である」の cos が **0.9482** になった
（この実測は `LocalEmbeddingPipeline` を必須 interface にする前のものであり、
`toVectors` を手で呼ぶ形だった。**インターフェースの形が変わっただけで、
`buildLocalEmbeddingPipeline` の中身は同じ `toVectors` を呼んでいるので、
出るベクトルは変わらないはずである——ただしこの器では再実行して検算していない**）。
`dimensions: 999` を宣言すると**この経路でも次元検査が発火する**ことも確認した
（＝ `createPipeline` を差しても、このパッケージの歯は素通しにならない）。

⚠ **確かめていないこと**: 上の `optimum-cli` の実行（Python 環境を用意していない）。
確かめたのは「**変換済みの重みがディレクトリに在るとき、そこから読めるか**」までである。

---

## テスト

- `src/__tests__/local-embedding-provider.test.ts` / `to-vectors.test.ts` —
  **`createPipeline` を注入して、本物のモデルを落とさずに走る。**CI で必ず走る。
  遅延ロードを1回に畳むこと・失敗後に再試行できること・次元と件数の検査・
  prefix の適用・`warmup()` を測る。

  ⚠ 2026-09-27 追記（文書と実装の照合、main 16976ea）: `embed()` は件数と次元に加えて、成分が有限か（`NaN`・`Infinity` を含まないか）も検査し、含んでいれば次元の検査と同じ素の `Error` を投げる（Issue #992）。この検査も同じテストファイルで測っている。

- `src/__tests__/input-token-limit.test.ts` — **擬似の extractor を注入して、
  上限の受け取りと超過の名乗り方を測る。**CI で必ず走る（ADR 0090）。
  ⚠ **ここでは `8192` という数字は測っていない**——それはモデルが持つ事実であり、
  下の live テストが固定する。
- `src/__tests__/embedding-space-name-budget.test.ts` — **`EmbeddingSpaceId` から導かれる
  Postgres のテーブル名・HNSW 索引名が、切り詰められずに 63 バイトに収まること**を、
  `@mnemora/postgres` の導出関数を import して測る。CI で必ず走る（ADR 0090 §4）。
- `src/__tests__/live.local-embedding.test.ts` — **本物のモデルを落として推論する。**
  `MNEMORA_LIVE_LOCAL_EMBEDDING` が空でない値のときだけ走る（既定では `skipped` と表示される）。

  ```bash
  MNEMORA_LIVE_LOCAL_EMBEDDING=1 pnpm --filter @mnemora/local-embedding test
  ```

  ⚠ opt-in を要求する理由は課金ではない（外部サービスへ繋がないので料金は発生しない）。
  **4ファイル計42MB（うち重み36MB）のダウンロードと peak RSS 362MB の推論が、
  `pnpm run test` を1回打っただけで走ってしまう**からである。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §5.5 — `EmbeddingProvider` の契約
- リポジトリ: https://github.com/takecchi/mnemora
