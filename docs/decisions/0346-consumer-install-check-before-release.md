# ADR 0346: 出荷6パッケージを repo の外に入れて確かめる道具を置き、既定の CI ではなくリリース前の手順で打つ

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-27

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> 「壊れたら気づける形で残す」ことはクローン miku（オーナーではない）の依頼。既定の CI に入れるかリリース前の
> 手順に置くかは、依頼の基準（時間が数十秒〜1分台に収まり、揺れないなら CI）に実測を当てて、委譲先が選んだ。

> **追記 2026-10-07**: 決定3・陽性対照の表3は、その後の peer の巻き上げで成り立たなくなった。install の形と表の今の姿は [ADR 0694](./0694-consumer-install-per-package-project.md)。

---

## 文脈

PR #1117 で、`pnpm pack` した6つの tarball を repo の外の空のプロジェクトに入れ、利用者の立場で確かめた。
`@mnemora/*` の型は `moduleResolution` の `node16`・`bundler` の両方で解決し、`@mnemora/testkit/fixtures` も外から
引けた。一方、pnpm の厳格な配置でだけ依存の不足が表に出る形（README の install 行の不足）を見つけた。

既存の道具で外から入れるのは `scripts/north-star-tarball-probe.mjs` だけで、core・testkit の JS から北極星の項目を
観測する（手動の workflow。門ではない）。型・残りの4パッケージ・副入口は見ていなかった。`pack:check`（既定の CI）は
tarball の中身（入口が指すファイルが在るか）までを見る。

## 決めたこと

1. **`scripts/check-consumer-install.mjs`（`pnpm run check:consumer-install`）を置く。**pack → tarball の `exports` と
   利用者が頼ってよい入口の一覧の突き合わせ → OS の一時ディレクトリへ `npm install --ignore-scripts --install-strategy=nested`
   → `node16`・`bundler` での型検査（strict・`skipLibCheck: true`）→ ESM で全入口を import。
2. **入口の一覧は `exports` から導かず、道具の中に独立に持ち、`exports` と両向きで突き合わせる。**導くと、入口を消したときに
   一覧からも消えて黙って通る。
3. **`--install-strategy=nested`（hoist しない）で入れる。**hoist すると、宣言し忘れた依存も別のパッケージの依存として解決でき、
   pnpm の利用者だけが止まる形を見逃す（下の対照3）。
4. **`--ignore-scripts` で入れる。**onnxruntime-node などの install スクリプトは環境によって registry の外（NuGet の CUDA 用
   バイナリなど）へ取りに行く。この検査はネイティブのバイナリを使わない。
5. **既定の CI には入れず、`docs/release-v1.md` の 0.11 として、リリース前に人が打つ。**理由は下の「測ったこと」。
   入口の一覧と作業ツリーの `exports` が揃っていることだけは、ネットワークの要らない単体テスト
   （`scripts/__tests__/check-consumer-install-lib.test.mjs`）で既定の CI でも見る。
6. **北極星の probe（`north-star-tarball-probe`）には足さない。**あちらは北極星の項目を観測する道具で、用途が違う
   （同じ pack の道具 `scripts/pack-publish-targets.mjs` は共有する）。

## 測ったこと

【実測 2026-09-27、main `a4fabfc`、この器】

| 条件 | 合計 | うち pack | うち npm install | 型検査2種 | ESM |
|---|---|---|---|---|---|
| npm のキャッシュが空（4回） | 41〜51秒 | 15〜17秒 | 21〜31秒 | 約3秒 | 約0.6秒 |
| キャッシュが温まっている（4回） | 26〜37秒 | 15〜16秒 | 7〜18秒 | 約3秒 | 約0.6秒 |

- **時間は依頼の基準（数十秒〜1分台）に収まり、この器の10回で落ちたことは無い。**
- **それでも既定の CI に入れない理由**:
  - npm registry から依存を取り直す（キャッシュが空なら約 550MB、大半は onnxruntime-node）。registry の揺れは PR と無関係に赤を作る。
  - ロックファイル無しで範囲を解決するので、上流の新しい版で結果が変わる。**今日すでに CI のロックとずれていた**
    （`zod` 4.6.5 対 ロックの 4.5.4、`vitest` 5.0.2 対 5.0.0）。上流のずれによる赤は PR の変更と関係が無く、
    偽陽性率に上限を置けない（`AGENTS.md`「偽陽性率に上限を置けない検査は門にしない」）。
  - 利用者が実際に受け取る姿（ロックの無い解決）を見るという性質は、出す版をリリースの時点で人が確かめる
    [ADR 0267](./0267-withdraw-the-release-changelog-publish-gate.md) の線に合う。

### 陽性対照（どれも保存した元のファイルから戻し、戻した後に緑へ戻ることを確かめた）

| 変異 | 結果 |
|---|---|
| 1. testkit の `exports` から `./fixtures` を消す | 突き合わせ（`tarball の exports に無い入口: @mnemora/testkit/fixtures`）・型検査2種（TS2307）・ESM（`Package subpath './fixtures' is not defined by "exports"`）の4段が赤。単体テストも赤 |
| 2. core の `exports` の `types` を存在しないファイルに向ける | **赤にならなかった。**TypeScript は `types` の先が無いと次の条件（`default` の `./dist/index.js`）の隣の `index.d.ts` を見つけて解決する——利用者から見て壊れていないので、対照として不適切だった |
| 2′. core の `files` から `.d.ts` を落とす | 型検査2種が赤（TS7016 `Could not find a declaration file for module '@mnemora/core'`）。ESM は緑（型は実行に要らない）。⚠ この形は `pack:check` も捕まえる（入口の指すファイルが tarball に無い）——重なっている |
| 3. core の `dependencies` から `zod` を消す | hoist ありの `npm install` では**全段が緑**（別のパッケージの依存の zod が hoist される）。`--install-strategy=nested` では ESM が赤（`Cannot find package 'zod' imported from …/@mnemora/core/dist/ctx.js`）→ 決めたこと3 |

## 採らなかった案

- **既定の CI の歯にする。**上の理由（registry・上流のずれ）。
- **直接の依存を `overrides` でロックの版に固定して既定の CI に入れる。**上流のずれによる赤は減るが、利用者が受け取る姿とは違う
  ものを見ることになり、推移的な依存のずれは残る。registry への依存も残る。**選び直す余地はある**（下の「覆るとしたら」）。
- **北極星の probe に足す。**決めたこと6。
- **`skipLibCheck: false` でも見る。**drizzle-orm の型定義そのものが約70行のエラーを出す（`packages/postgres/README.md`）ので、
  mnemora 側の変更と無関係に常に赤になる。

## 引き受けた負債

- **既定の CI では、入口の一覧のずれしか見ない。**型の解決・依存の宣言漏れに気づくのはリリースの前である。
- **`skipLibCheck: true` の下では、公開の型定義の中の解決できない import は `any` に落ちるだけで赤にならない。**
  依存の宣言漏れは ESM の段（nested）で捕まえるが、型だけで使う依存（`import type` だけの依存）の漏れは捕まえない。
- **README の例が利用者に要求する依存（#1117 の `zod`・`@mnemora/openai`）は見ない。**例を動かす道具ではない。
- CommonJS からの利用・実行時の振る舞い（DB・実 API）は見ない。

## これが覆るとしたら

- registry の揺れや上流のずれで、リリースの前にこの道具が赤になり、それが利用者に届く壊れ（上流の版が mnemora の型を壊す）だったと
  分かったとき——そのときは、既定の CI で `overrides` なしに見る価値が、偽陽性の費用を上回るかを測り直す。
- リリースの前にしか気づけなかった梱包の壊れが実際に出たとき——`overrides` で固定した形で既定の CI に入れることを検討する。
