# ADR 0138: 六つの門の `pack:check` を、毎PRの `ci.yml` でも走らせる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-15

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ／受け取った前提」を混ぜない。

---

## 問い（[Issue #241](https://github.com/takecchi/mnemora/issues/241)）

`docs/autonomy.md` §2 は、PR を出す条件として**六つの門**（`typecheck` / `lint` / `format:check`
/ `test` / `build` / `pack:check`）が緑であることを要求している。**しかし `pack:check` は、
毎 PR の `ci.yml` では一度も実行されていなかった。**

**【現物】確認した現状**（issue の grep を自分でも実行し、裏取りした）:

```
$ grep -n "pack:check" .github/workflows/*.yml
.github/workflows/publish.yml:150:        run: pnpm run pack:check
```

`.github/workflows/ci.yml` の `build` ジョブ（`name: typecheck / lint / test / build`）は
`Typecheck` / `Lint` / `Format check` / `Test` / `Build` / `check:cjs-parse`（Issue #110）の
6ステップしか持たず、`pack:check` を1度も呼んでいない。`pack:check` は `publish.yml` の
`release` イベント（または `workflow_dispatch` の予行）のときにしか走らない。⟹ 六つの門の
うち1つだけが、**人手の規律にだけ依存していた**——担い手が手元で打ち忘れても CI は緑のまま
通り、壊れたときに初めて気づくのが「publish の瞬間」という、いちばん失敗したくない場所に
なっていた（publish は取り消せない操作、ADR 0066）。

## 決定

**`.github/workflows/ci.yml` の既存の `build` ジョブ（`name: typecheck / lint / test / build`）
に、`pack:check` を1ステップとして足す。** 独立ジョブは作らない。`publish.yml` 側の
`pack:check` は残す。CI 側での `rm -rf packages/*/dist` 相当は入れない。それぞれの理由は
下の3点。

### 1. 独立ジョブではなく、既存の `build` ジョブへのステップ追加にした理由

**`pack:check`（`scripts/check-publish-pack.mjs`）は、直前の `Build` ステップの成果物
（`packages/*/dist`）に依存しない。** 各 publish 対象パッケージの `package.json` は
`"prepack": "pnpm run build"` を持ち、`pnpm pack` を打つたびに `tsc -p tsconfig.build.json`
（＝ルートの `build` script が呼ぶものと同一のコマンド）で自分の `dist` を作り直す
（`scripts/check-publish-pack.mjs` 冒頭のコメント、および `packages/*/package.json` を
自分で読んで確認した——6パッケージすべてが同じ形の `prepack` を持つ）。

⟹ `pack:check` は「`build` ジョブの成果物を再利用する後続ステップ」ではなく、**自己完結した
検査**である。独立ジョブにしても `actions/checkout` → `setup-node` → `corepack enable` →
`pnpm install --frozen-lockfile` を丸ごとやり直すだけで、`build` ジョブとの間で共有できる
成果物は無い。**同じジョブの末尾に1ステップ足すほうが、CI 時間の増分が「`pack:check` 自体の
実行時間」だけで済み、チェックアウト・install の重複コストを払わずに済む。**

**もう1つ、独立ジョブを選ばなかった決定的な理由がある**——**【実測】** branch protection を
自分で確認したところ、

```
$ gh api repos/takecchi/mnemora/branches/main/protection
```

`required_status_checks.contexts` に `"typecheck / lint / test / build"` という**この
ジョブの `name:` の文字列そのもの**が登録されていた。**ジョブ名を変更する・ジョブを
分割するといった変更は、branch protection の required checks 側も合わせて更新しないと
「一致しない required check が居座って main がマージ不能になる」**
（`scripts/__tests__/workflow-name-comment-wiring.test.mjs` の docstring が既に、
job name と required check の文字列一致がどれほど壊れやすいかを実例つきで記録している）。
branch protection の設定変更はオーナー権限の設定変更であり、この PR の範囲外である。
**⟹ ジョブ名を変えない・ジョブを増やさない形（既存ジョブへのステップ追加）を選べば、
branch protection には一切触れずに済む。** これが独立ジョブ案を採らなかった決め手である。

### 2. `publish.yml` 側の `pack:check` は残す

二重に走ることにはなるが、意味が異なる。`ci.yml` 側は「毎 PR」という頻度でこの門を掛け、
`publish.yml` 側は「実際に publish 用の tarball を作る直前」という、より狭い経路の最終防衛線
として掛かる。`publish.yml` は `release` イベント（または `workflow_dispatch`）でしか
走らないため、`ci.yml` とはトリガーが別であり、**`ci.yml` の門を何らかの理由で迂回した
commit（admin による branch protection の bypass 等）から Release を作る経路が理論上
存在する以上、publish 直前にもう一度検査することには独立した価値がある。** 削除する側に
倒すには「`ci.yml` の門を迂回できないことの証明」が要るが、それはこの PR の範囲を超える
——**消すなら安全である証拠が要る、というのがここでの基準であり、その証拠が無いので残す。**

### 3. CI 側で `rm -rf packages/*/dist` 相当は要らない

`docs/autonomy.md` §4 が挙げる「手元の `pack:check` が赤い」原因（`dist/` に古い `.map` が
居残る。`tsc` は `outDir` を掃除しない）は、**同じ `dist/` に対して、異なるソース状態で
複数回 `tsc` を打ち続けたときに積み上がる残骸**である。CI は毎回まっさらな checkout から
始まり（`dist/` は `.gitignore` されており、リポジトリには含まれない）、**同じ commit の
ソースに対して `tsc -p tsconfig.build.json` を（`Build` ステップと `prepack` で）2回
打つだけ**なので、残骸が積み上がる条件（ソースが変わる／複数の異なる状態を同じ `outDir`
に重ねる）が原理的に発生しない。

**【実測】** 上記の推測を、実際に手元で CI と同じ手順を再現して検算した（下記「測ったこと」）。

## 検討して採らなかった案

- **独立ジョブにする。** 却下——上記「決定」1番。branch protection の
  `required_status_checks` を触らずに済む形を優先した。将来 `pack:check` を独立ジョブに
  切り出す価値が出た場合は、その PR で branch protection の更新も一緒に提起すべきである
  （オーナー権限の設定変更を伴うため、単独の技術判断では決められない）。
- **`publish.yml` 側の `pack:check` を削除する（二重実行をやめる）。** 却下——上記「決定」
  2番。削除して安全だという証拠（`ci.yml` の門を迂回する経路が無いことの証明）をこの PR の
  範囲では用意できない。二重実行のコスト（`pack:check` 自体は実測 約28秒、下記「測ったこと」）
  は、publish という取り消せない操作の最終防衛線を失うリスクに見合わない。
- **CI にも `rm -rf packages/*/dist && pnpm run build` を先に打つ防御的なステップを足す。**
  却下——上記「決定」3番。CI は毎回まっさらな checkout であり、`.map` 残骸が起きる条件
  そのものが無い。存在しない問題に対する防御的なステップを足すと、それが「本当は何を
  守っているのか」が読めない死んだコードになる。

## 理由

`pack:check` は publish の梱包物（tarball の中身）を検査する門であり、他の5つの門
（`typecheck` / `lint` / `format:check` / `test` / `build`）と同じ扱いを受けるべきだと
`docs/autonomy.md` §2 は既に定めている。**この PR はその既存の規約を、実際の CI 設定に
一致させる**——新しい規約を作るのではなく、「六つの門が緑」という既存の停止条件が、実際には
5つしか検査されていなかったギャップを埋める。issue が指摘した「壊れたときに気づくのが
publish の瞬間になる」という実害は、この門を毎 PR に前倒しすることで、**publish よりずっと
前、レビューの時点で気づける**ようになる。

## 結果（この決定が招くもの）

- 毎 PR の `build` ジョブの実行時間が、`pack:check` 自体の実行時間（実測 約28秒、
  下記「測ったこと」）だけ伸びる。
- `pack:check` が失敗する PR は、`build` ジョブ全体が赤くなる（同じジョブ内の1ステップの
  失敗はジョブ全体の `conclusion` を `failure` にする）——これは既存の `Typecheck` /
  `Lint` 等と同じ扱いであり、新しい種類の失敗モードを持ち込まない。
- `publish.yml` 側の `pack:check` は変更していないため、publish 経路の挙動は一切変わらない。

## 引き受けた負債

1. **`publish.yml` と `ci.yml` の両方で `pack:check` を走らせる二重実行が残る。** 上記
   「決定」2番のとおり意図的な選択だが、この二重実行を無くせないか（例: `ci.yml` の
   `build` ジョブの conclusion を `publish.yml` が参照して、通っていれば skip する等）は
   検討していない——現状は「両方走らせる」以上の設計をしていない。
2. **`build` ジョブの名前（`typecheck / lint / test / build`）が、実際に含む検査
   （`pack:check` を含む7ステップ）を正確に表さなくなった。** 名前を変えないことを
   branch protection との整合のために優先した結果であり、意図的に受け入れた。
3. **独立ジョブ化する場合に必要な branch protection の更新手順を、この ADR は用意していない。**
   将来切り出す判断が下ったときは、`required_status_checks.contexts` の更新もセットの
   PR にする必要がある——これはオーナー権限の操作であり、この PR の範囲外として明示するに
   留める。

## これが覆るとしたら

- **`build` ジョブの実行時間が、`pack:check` の追加によって許容できないほど伸びたとき。**
  そのときは独立ジョブ化を検討する価値が出るが、その場合は上記の branch protection 更新を
  セットで行う必要がある。
- **`publish.yml` の `pack:check` を削除しても安全だと示せる証拠（`ci.yml` の門を迂回する
  経路が実際には存在しないことの検証）が得られたとき。** そのときは二重実行を1本に減らせる。

## 測ったこと

- **【現物】各 publish 対象パッケージの `prepack`**: `packages/{core,testkit,openai,
  postgres,anthropic,local-embedding}/package.json` の6本すべてに
  `"build": "tsc -p tsconfig.build.json"` と `"prepack": "pnpm run build"` が同じ形で
  入っていることを `grep` で確認した。ルートの `pnpm run build` も
  `pnpm -r --if-present run build`（＝各パッケージの `build` script）を呼ぶので、
  `Build` ステップと `pack:check` の `prepack` は**同じコマンドを同じソースに対して
  2回走らせる**だけであることを確認した。
- **【実測】branch protection の required checks**: `gh api
  repos/takecchi/mnemora/branches/main/protection` を実行し、
  `required_status_checks.contexts` に `"typecheck / lint / test / build"` が
  文字列として登録されていることを確認した（上記「決定」1番の根拠）。
- **【実測】CI と同じ手順（fresh checkout 相当）での通し**:
  ```
  rm -rf packages/*/dist && pnpm run build && pnpm run pack:check
  ```
  を実行し、6パッケージとも `pnpm pack` に成功、`✔ publish 梱包の門を通りました。` で
  終了コード 0 になることを確認した（実測時間 約28秒、`time` で計測）。**`rm -rf` は
  「CI は毎回まっさらな checkout」を模すために打ったものであり、CI の workflow 自体には
  この行を入れていない**——CI は `actions/checkout` の時点で既にまっさらだから。
- **【実測】六つの門すべてを手元で確認**: `pnpm run typecheck` / `pnpm run lint` /
  `pnpm run format:check` / `pnpm run build` / `pnpm run pack:check` がいずれも緑。
  `pnpm run test` は `Test Files 44 passed (44)` 等、全パッケージ緑のうえで
  `⚠ DB テストは実行していません（DATABASE_URL が未設定）` と明示して終了した
  （ADR 0015 のとおり、DB 側は見ていない——この環境に Postgres が無いため）。
- **【実測】変異試験（この PR の歯＝CIの門そのものが実際に嚙むことの手元での確認）**:
  1. `cp packages/core/package.json /tmp/mutation-backup/core-package.json.safe-backup`
     で退避（`docs/autonomy.md` §4 のとおり `git checkout` では戻さない）。
  2. `packages/core/package.json` の `"main": "./dist/index.js"` を
     `"main": "./dist/does-not-exist.js"` に書き換え、`pnpm run pack:check` を実行すると、
     `✗ 違反が 1 件見つかりました` / `[@mnemora/core] tarball 内に実在しないエントリポイント:
     main -> ./dist/does-not-exist.js` で **exit code 1**（赤）になった。
  3. `cp /tmp/mutation-backup/core-package.json.safe-backup packages/core/package.json`
     で復元し、`md5sum` が変異前と一致することを確認したうえで再実行すると、**緑**
     （`✔ publish 梱包の門を通りました。`）に戻った。
  4. **これは「ローカルで `pack:check` 自体が壊れた入力を検出できる」ことの確認である。**
     「この PR が足す `ci.yml` のステップが、実際の GitHub Actions 上で同じ壊れを赤として
     報告するか」は、このセッションの継続作業として、本 PR のブランチへ同じ変異を1コミット
     として push し、`node scripts/ci-green-check.mjs --pr <PR番号>` で実際の CI の
     job 単位の `conclusion` を確認したうえで、復元コミットを重ねて再度緑に戻す形で
     実施する（結果は PR 本文に追記する）。

## 確かめていないこと

- **CI 時間の絶対的な増分**（Issue #241 が明示的に「着手する人が測ってよい」としていた点）
  は、`pack:check` 単体のローカル実行時間（約28秒）を測ったのみで、GitHub Actions の
  runner 上での実測（ネットワーク・キャッシュの有無で変わりうる）はしていない。
- **`publish.yml` 側の `pack:check` が具体的にどの条件（`release` の `published` /
  `workflow_dispatch`）で走るかは `publish.yml` を読んで把握したが、実際に `release` を
  発火させて確認してはいない**（Release の作成はオーナー専権であり、この PR の範囲外）。
- **branch protection の `required_status_checks` を今後もこのジョブ名のまま維持すべきか**
  は、この ADR の範囲では判断していない——「変えるなら別途更新が要る」という制約を
  述べるに留める。
