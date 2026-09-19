# ADR 0247: `repo` だけの差し替えが `modelId` を伴わないとき、コンストラクタで落とす（Issue #142）

- **状態**: 草案（`docs/decisions/README.md` は触っていない——ADR 0137 決定2。索引はマージする側が直前に再生成する）
- **日付**: 2026-09-19

> **⚠ この判定は、自動化された担い手（クローンのマネージャーのセッション）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: クローンの署名は repo 上では `takecchi` になり、**オーナー本人と区別が付かない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が
> 要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0244 / 0245 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】は `origin/main` = `420e0f4`（本 ADR の作業を始めた時点）の木で、
2026-09-19 に行った。

---

## 文脈

[Issue #142](https://github.com/takecchi/mnemora/issues/142) は、適合テストが
「実際にどのモデルを読み込んでいるかを見ていない」ことを報告した節の末尾で、逐語こう書いていた:

> ⛔ **どれを採るかは、まず「この穴が実際に踏まれうるか」を測ってから決めるべきである**
> （`repo` を差し替える運用が実在するのか）。⛔ **測る前に歯を足さないこと。**

⟹ **測った。**

【現物】`packages/local-embedding/src/local-embedding-provider.ts` のコンストラクタ:

```ts
this.space = Object.freeze({
  provider: LOCAL_EMBEDDING_PROVIDER_ID,
  model: options.modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  dimensions: options.dimensions ?? DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
});
```

**`space.model` は `options.modelId` からしか作られず、`options.repo` は一度も効かない。**

【現物】`packages/local-embedding/src/local-embedding-provider.ts` の
`LocalEmbeddingProviderOptions`（公開型）は `repo` と `modelId` の**両方**を独立に持つ
（それぞれ `repo?: string;` / `modelId?: string;`）。【現物】
`scripts/__snapshots__/public-api/local-embedding.d.ts` にも両方が出荷済みの公開面として
記録されている。

⟹ **これは変異試験でしか届かない穴ではない。**採用者が `new LocalEmbeddingProvider({ repo })`
を `modelId` 無しで呼べば、コード上いつでも踏める、**既に出荷済みの公開面に開いている**穴である。

---

## 既にこの規律の先例が同じファイルに在る

【現物】`embed()` の次元検査（同ファイル）の doc コメント逐語:

> ⭐ 宣言した次元と実物の食い違いを、ここで落とす。
>
> `interfaces/embedding-provider.ts` の「次元をモデルに応じて動的に変える実装は
> 許容しない」を**実行時に守らせる歯**である。repo を差し替えた・dtype を変えたら
> 次元が違った、を**黙って通すと、宣言と中身が食い違ったまま DB へ入る**
> （`EmbeddingSpaceId` はテーブル名スラグの導出元なので、後から気づいても
> 混ざったものは分けられない）。

⟹ **本 ADR はその延長であり、新しい規律ではない。**両方とも「宣言と実物（または宣言どうし）の
食い違いを、DB へ入る前に落とす」という同じ発想に立つ。

⭐ **違いは、あちらが「次元が変わったとき」しか鳴らないのに対し、こちらは「次元が同じまま
重みだけ入れ替わる」場合を宣言の時点で落とすことである。**既存の次元検査は `embed()` の内側
（初回推論後）でしか鳴らない——`repo` だけ差し替えて `dimensions` も `modelId` も変えなければ、
次元は変わらないままなので、あちらは一度も鳴らない。本 ADR の guard はそれより手前、
`new` した瞬間に落ちる。

---

## 形の根拠

【現物】`packages/local-embedding/README.md`「`space` の形」節の逐語:

> `/sym` を持たせておけば、切り替えた実装は `ruri-v3-30m/asym` を名乗ることになり、
> **別 space ⟹ 再インデックスが強制される。**静かに壊れる代わりに、うるさく作り直させる。

⟹ **正典の側の選好は「うるさく」である。**throw はその最も騒がしい形——コンパイル時ではなく
実行時だが、**モデルの読み込みを待たず、`new` した瞬間に、最初の1回で**止める。

---

## 決定

### 決定1. コンストラクタで落とす

`options.repo` が指定され、かつ `DEFAULT_LOCAL_EMBEDDING_REPO` と異なり、かつ
`options.modelId` が `undefined` のとき、コンストラクタが `throw new Error(...)` する。

### 決定2. 型は変えない

`LocalEmbeddingProviderOptions` は1バイトも動かさない。【実測】
`pnpm run build && pnpm run api:check` を通し、`@mnemora/local-embedding` を含む6パッケージ
すべてで「差分なし」であることを確認した（下の「測ったこと」節）。

### 決定3. 逃げ道を残す — `modelId` を明示すれば通る

**「何を名乗るか」を宣言させる契約である。**同じ重みの私設ミラー（`repo` だけ変え、
モデルの実体は同じ）を使いたい人は、既定と同じ `modelId`
（`DEFAULT_LOCAL_EMBEDDING_MODEL_ID`）を明示的に渡せば通る。別のモデルを使う人は、
そのモデルを名乗る別の `modelId` を渡すことになる——**どちらの場合も、「何を名乗るか」を
選ばせている**のであって、`repo` を読んで自動で決めてはいない（採らなかった案1を見ること）。

### 決定4. `LocalEmbeddingProviderErrorKind` の union は増やさない

それ自体が公開 API の破壊的変更を1つ増やす。**plain な `Error` を投げる**——同ファイルの
既存2つの guard（件数検査・次元検査）と同じ形。`kind` の付いたエラー
（`LocalEmbeddingProviderError`）は入力・設定の問題を表す語彙であり、本 guard が扱う
「宣言そのものの食い違い」はその語彙の外にある。

### 決定5. 歯は `packages/local-embedding/src/__tests__/` に置き、DB も実 API も42MBの取得も要らない形にする

`repo-model-id-declaration-guard.test.ts`。guard はコンストラクタで同期に鳴るので、
`createPipeline`（pipeline 経路）を一切読まない。⟹ required CI（`typecheck / lint / test /
build`）に素直に乗る。⛔ 新しい CI ジョブは足さない。

---

## 採らなかった案

### 1. `space.model` を `repo` から導出する

⛔ **`repo` を上書きしていた既存の利用者のテーブルスラグが黙って変わり、既存データが
別 space 扱いになって届かなくなる。**⟹ 上の「静かに壊れる代わりに、うるさく」に
真っ向から反する。**これ自体が「静かに壊す」側である**——`repo` を差し替えるだけで
動いていたコードが、次の起動から別 space を読み書きし始め、しかも例外もログも出ない。

### 2. 型で強制する（`repo` を渡すなら `modelId` も必須にする union）

最も強い形だが、`LocalEmbeddingProviderOptions` の形が変わり、公開 API スナップショット
（`scripts/__snapshots__/public-api/local-embedding.d.ts`）が動く。**throw で同じ穴が
塞げるなら、型まで動かす必要はない**——型を動かすことは、それ自体が公開面の破壊的変更を
1つ増やす決定であり、この PR の範囲（Issue #142 が名指しした穴を塞ぐこと）を超える。

### 3. README に書くだけ

⛔ **規律に頼る対処は穴を塞がない。機械が止めないものは、次の担い手が越える。**README には
保険として節を足したが（`packages/local-embedding/README.md`「`repo` を上書きするなら
`modelId` も上書きすること」）、**止めているのは実装側の guard であって README ではない**
——README 側にもその旨を明記した。

---

## ⛔ この guard が塞いでいないもの

⚠ **検査が存在することは、それが何を保証するかを何も言っていない。**この節を消さないこと。

1. 🔴 **実際に読み込まれた重みが `modelId` の名乗りと合っているかは、依然として誰も
   見ていない。**縛ったのは**宣言どうしの整合**（`repo` を変えたら `modelId` も変えたか）
   だけである。⟹ **Issue #142 の本体**（本物の指紋照合——既知の入力に対するベクトルの
   一致を確かめる。42MB のモデル取得が要る）**は残る。**
2. 🔴 **`dtype` を変えた場合は鳴らない。**量子化が変わればベクトルは変わりうるが、
   この guard は `dtype` を一切見ない。この PR の範囲外の負債として引き受ける。
3. 🔴 **既定の `repo` と `modelId` の組そのものが正しいことは、何も言っていない。**
   既定値自体が間違っている可能性は、この guard の射程の外にある。

⭐ **⟹ この guard が実際に止めるのは、`repo` だけを既定から差し替え `modelId` を
明示しないまま `new LocalEmbeddingProvider(...)` が呼ばれること、1つだけである。**
⛔ **それ以上のことは主張しない。**

---

## 引き受けた負債

- **`dtype` は対象外。**量子化が変わってもこの guard は鳴らない（決定4直下・上記1参照）。
- **本物の指紋照合は未着手。**Issue #142 の本体はこの PR では塞がっていない。
- **既存テスト2箇所（`local-embedding-provider.test.ts`）が、この guard の影響で
  `modelId` を明示するよう書き換わっている**（「差し替えた値がそのまま渡る」「実際に
  使った repo 名が入る（既定値ではなく）」）——guard を入れる直接の結果であり、
  テストの意図（repo が配線されること／メッセージに実際の repo 名が入ること）は
  変えていない。

## これが覆るとしたら何が起きたときか

- `modelId` を `repo` から導出する設計へ移ると決まったとき（⟹ 採らなかった案1を
  取り消し、既存データの移行計画を別途立てる必要がある）。
- 指紋照合（Issue #142 本体）が入り、宣言どうしの整合という弱い保証がもう要らなくなったとき。
- `dtype` も含めた、より広い宣言食い違い検査へ広げる判断が下ったとき（この PR は
  意図してその判断を含めていない）。

---

## 測ったこと / 確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

#### 🔴 ⭐ **ADR 0212 の歯が、この PR の初稿を止めた**【実測 2026-09-19】

**初稿は、歯のファイルの docstring に「42MB のダウンロード」「42MB のモデル取得」と書いていた。**
⟹ CI の `typecheck / lint / test / build` が赤くなった。落ちたのは
[ADR 0212](./0212-local-embedding-size-noun-correspondence-tooth.md) の歯
（`scripts/__tests__/local-embedding-size-noun-correspondence.test.mjs`）で、逐語:

```
AssertionError: packages/local-embedding/src/__tests__/repo-model-id-declaration-guard.test.ts:16
  — "42MB" が「重み」文脈(期待値 36MB)に付いている
```

⭐ **あの歯は「値の一致」ではなく「向き」を見る**——「一式＝42 / 重み＝36」の対応である。
「モデル取得」「ダウンロード」という語の近くに `42MB` を置いたため、**重み文脈と読まれた。**

⟹ **直し方は「数字を書き換える」ではなく「数字を書かない」**
（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。docstring から MB の数字を落とし、
**サイズの正本は ADR 0212 とその歯が持つ**と書くだけにした。

⚠ **この ADR 本文に残っている MB の記述は、そのままにしてある**——
ADR 0212 の歯は `docs/decisions/` を走査対象から除外している（ADR 本文は書き換えない規律のため）。
⛔ **「歯が見ていないから書いてよい」ではない。**ここに残すのは、**何が起きたかの記録**だからである。

⭐ **副産物**: Issue #455 は「既に判定が着地した台帳」として意図的に開いているが、
**その歯はいまも生きて噛む**ことが、この PR で実測された。

- 【現物】`local-embedding-provider.ts` の `this.space = Object.freeze(...)` が
  `options.modelId` からしか `model` を作らないこと。
- 【現物】`LocalEmbeddingProviderOptions` が `repo` / `modelId` を独立した公開オプション
  として持つこと。`scripts/__snapshots__/public-api/local-embedding.d.ts` に両方が
  出荷済みの公開面として記録されていること。
- 【現物】既存の次元検査（`embed()` 内）の doc コメント逐語（上記「既にこの規律の
  先例が同じファイルに在る」節）。
- 【現物】`packages/local-embedding/README.md`「`space` の形」節の逐語
  （「静かに壊れる代わりに、うるさく作り直させる」）。
- 【実測】`pnpm --filter @mnemora/local-embedding exec vitest run
src/__tests__/repo-model-id-declaration-guard.test.ts` — 5 tests、全緑。
- 【実測】`pnpm --filter @mnemora/core run build && pnpm --filter @mnemora/local-embedding
run build` — 成功。
- 【実測】`pnpm run build && pnpm run api:check` — 対象6パッケージすべて「差分なし」
  （`LocalEmbeddingProviderOptions` を含め、型は1バイトも動いていないことの実測）。
- 【実測】`pnpm exec eslint packages/local-embedding/src/local-embedding-provider.ts
packages/local-embedding/src/__tests__/repo-model-id-declaration-guard.test.ts
packages/local-embedding/src/__tests__/local-embedding-provider.test.ts` — エラー無し。
- 【実測】**変異試験（3本。`cp` で退避・復元。`git checkout` は使っていない）**:
  - **変異A（guard の throw を無効化。`if (false && ...)`）**:
    `it` **「repo だけ差し替えると落ちる」だけ**が赤くなった（4 passed / 1 failed）。
    失敗メッセージ: `AssertionError: expected [Function] to throw an error`。
    **他の4本は道連れで赤くならなかった。**`cp` で復元後、`diff` で元ファイルと
    一致することを確認し、5 tests 全緑に戻ることを実測した。
  - **変異B（条件を「`repo` が渡されたら常に throw」へ広げる。
    `options.repo !== DEFAULT_LOCAL_EMBEDDING_REPO` を落とす）**:
    `it` **「既定と同じ repo を明示しても落ちない（誤検出しない）」だけ**が赤くなった
    （4 passed / 1 failed）。失敗メッセージ:
    `AssertionError: expected [Function] to not throw an error but 'Error: LocalEmbeddingProvider: repo に…' was thrown`。
    **他の4本は道連れで赤くならなかった。**`cp` で復元後、`diff` で一致を確認し、
    5 tests 全緑に戻ることを実測した。
  - **変異C（逃げ道を壊す。`options.modelId === undefined` の節を落とす）**:
    `it` **「repo を差し替えても modelId を明示すれば通る（逃げ道が効く）」だけ**が
    赤くなった（4 passed / 1 failed）。失敗メッセージ:
    `Error: LocalEmbeddingProvider: repo に既定（sirasagi62/ruri-v3-30m-ONNX）と異なる値
（sirasagi62/ruri-v3-30m-ONNX-OTHER）が渡されたが、modelId は指定されていない…`
    （guard がそのまま throw した）。**他の4本は道連れで赤くならなかった。**`cp` で
    復元後、`diff` で一致を確認し、5 tests 全緑に戻ることを実測した。

### 確かめていないこと

- ⛔ **ルートの `pnpm run test`（全体）は走らせていない**（依頼元の指示どおり、
  新規テストファイル1本だけを走らせた）。
- ⛔ **`packages/postgres` の DB テスト・実 API を通した経路は確認していない**——
  本 PR の変更は `packages/local-embedding` と ADR 文書・README のみであり、DB・LLM の
  いずれにも触れていない。
- ⛔ **本物のモデルを読み込む live テスト（42MB のダウンロードが要る）は走らせていない。**
  この guard 自体、本物のモデルを一切読まずに鳴る設計であるため、意図して不要である。
- ⛔ **オーナー本人の確認は取っていない**（冒頭のバナーのとおり、これはクローンの
  判定である）。
- ⛔ **他パッケージ（`packages/core` 等）に同じ形の「宣言が2つの独立したオプションに
  分裂している」穴が無いかは掃いていない**（Issue #142 のスコープが
  `@mnemora/local-embedding` だったため、対象もそれに揃えた）。

---

## 未計上であることの明記

**この変更は `CHANGELOG.md` / `docs/migration-v1.md` へ未計上である。**`v0.4.0` への
世代表の追随（別 PR）が着地した後に、新しい世代の破壊的変更として載せる。**載せるまで
この負債は残る。**

⚠ 番号（項目18 など）はここには書かない。世代表が `v0.4.0` へ追随した後に決まる。
**新しい世代の最初の破壊的変更になる見込み**とだけ書く。
