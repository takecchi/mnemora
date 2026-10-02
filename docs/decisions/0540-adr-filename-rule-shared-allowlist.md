# ADR 0540: ADR のファイル名の規則を生成器と renumber で共有し、`docs/decisions/` の直下の ADR でない `.md` は許す一覧（README.md・TEMPLATE.md）だけにする

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・文書の直し・前例のある同種の穴）の内側で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。[ADR 0537](./0537-adr-index-rejects-malformed-adr-filename.md) が負債に残した2つを塞ぐ。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 直す前の赤【実測】

1. **`adr-renumber.mjs` が形の外れた名前を黙って対象から外す**: 一時の git リポジトリ（`origin/main` 相当の ref 付き）に、番号が衝突する `0001-b.md` と、`adr-0538-x.md`（または `0538-x.1.md`）を足して `--check` を走らせると、`0001-b.md` の衝突だけを報告して exit 1。形の外れたファイルには何も言わない（renumber は `isAdrFilename` で絞っていた）。書き換えるモードも同じ `buildPlan`（形の外れた名前を `isAdrFilename` で捨てる）を通るので、同じ扱いになる【現物】（書き換えるモードそのものは、直す前のスクリプトでは走らせていない）。
2. **`adr-0538-x.md` のように番号で始まらない名前を拾えない**: ADR 0537 の検出は「4桁の数字で始まる `.md`」だけだった。`docs/decisions/` に置いて `generate-adr-index.mjs --check` を走らせると、`adr-0538-x.md`・`538-x.md`・`ADR-0538-x.md` は exit 0・「最新です」で素通り（`0538_x.md`・`05380-x.md` は 0537 の規則で落ちる）。

直した後の歯を直す前のスクリプトに当てると、新しい renumber の歯 10 本のうち 9 本が赤（陰性対照の1本だけ緑）。

## 決定

1. **拾い方は「許す側の一覧」にした**。`docs/decisions/` の直下の `.md` は、(1) ADR のファイル名の形（`ADR_FILENAME_RE`）か、(2) 許す一覧 `ALLOWED_NON_ADR_MARKDOWN`（`README.md`・`TEMPLATE.md`）のどちらかでなければ、例外で落とす。`.md` 以外のファイルと、サブディレクトリの中は対象外。
   - 理由【判断】: 「ADR らしさ」で拾う形（数字を含む・`adr` で始まる・3桁/5桁…）は、拾い漏れる形がまた出る（ADR 0537 がまさにそれだった）。許す側を数えれば、ADR でない `.md` を置きたいときは一覧に足すという1か所の判断になり、漏れが無い。
   - 代償: `docs/decisions/` に `notes.md` のような `.md` を置くと落ちる。【実測】いまの `docs/decisions/` の全ファイルは、ADR の形でないのは `README.md` だけで、全ファイルがこの規則を通る（`generate-adr-index.mjs --check` が exit 0。ADR 501 本）。`TEMPLATE.md` は今は無いが、ADR 0128 が将来ありうる例として挙げているので、一覧に入れた。
   - 置き場所: `scripts/generate-adr-index-lib.mjs` の `ALLOWED_NON_ADR_MARKDOWN`。README の手引き（ADR 0537 で足した段落の続き）に、この一覧と、足すときは一緒に直すことを書いた。
2. **生成器と renumber で規則を1か所にまとめた**（共有）。`ADR_FILENAME_RE` を export して、`adr-renumber-lib.mjs` の `FILENAME_RE` がそのまま使う。以前は2つの正規表現が別々に在り、同じ形を書き写していた。形の外れた名前の検出（`findMalformedAdrFilenames`・`assertWellFormedAdrFilenames`）も `generate-adr-index-lib.mjs` に置き、`buildAdrEntries` と `adr-renumber.mjs` の両方がこれを呼ぶ。
   - 別々のまま一致を歯で縛る案は採らなかった。歯が緑でも、片方だけ直したときに初めて気づく。1か所なら、ずれようがない。
   - 共有の副作用: `ADR_FILENAME_RE` の slug に捕獲グループを足した（`generate-adr-index-lib.mjs` の他の使い方は番号の第1グループだけを見るので影響しない）。
3. **renumber は書き換える・改名する前に落ちる**。`buildPlan`（`--check` も既定の書き換えも最初に通る）の中で、`origin/main` にあるファイル名（`strict`）と、このブランチが追加したファイル名を検査する。`git mv` や書き換えより前なので、途中まで直して落ちる形にならない。他のリモートブランチの名前を見る `--next` の分は strict にしない（他の枝の持ち主の責任で、関係ない枝のせいで `--next` が落ちるのを避ける）。

## 歯と変異試験【実測】

- `scripts/__tests__/generate-adr-index-lib.test.mjs`: 拾う形（`adr-0538-x.md`・`ADR-0538-x.md`・`538-x.md`・`05380-x.md`・`0538_x.md`・`0538.md`・`0538-X.md`・`notes.md`・`README.MD`）と、拾わない形（`README.md`・`TEMPLATE.md`・`notes.txt`・`0002-x.txt`・`adr-0538-x.txt`・`diagram.png`、ディレクトリ名）の両方。`parseAdrFilename` と `isAdrFilename` が同じ形を受けること（共有の歯）。
- `scripts/__tests__/adr-renumber-malformed-filename.test.mjs`（新規。一時ディレクトリの git リポジトリに本物のスクリプトを写して子プロセスで走らせる）: 追加された8通りの形の外れた名前（`adr-0538-x.md`・`ADR-0538-x.md`・`538-x.md`・`05380-x.md`・`0538_x.md`・`0538.md`・`0534-changelog-1.3.0-x.md`・`notes.md`）で、既定モードも `--check` も非 0 で終わり、**ファイル一覧・内容・`git status` が実行の前後で変わらない**。`origin/main` 側にある形の外れた名前でも同じ。陰性対照として、`TEMPLATE.md`・`notes.txt`・サブディレクトリの中の `.md` があっても、形が正しければ衝突した ADR を付け替えて exit 0。
- 変異（元に戻して `git status` に差が無いことを確認）: renumber の追加分の検査を外す → 8 本赤。`origin/main` 側の `strict` を外す → 1 本赤。生成器の検査を外す → 4 本赤。renumber の正規表現を別物にする（共有を崩す）→ 1 本赤。許す一覧に `notes.md` を足す → 2 本赤。

## 検討した代替案

1. **ADR らしさで拾う**（数字を含む・`adr` で始まるなど）。上のとおり採らなかった。
2. **別々の正規表現のまま歯で一致を縛る**。上のとおり採らなかった。
3. **renumber が形の外れたファイルを無視して続ける**。採らなかった。renumber は書き込む道具で、取り残された名前が衝突の見落としになる。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | `docs/decisions/` に ADR でない `.md` を置けなくなった（一覧に足す必要がある） | 低 |
| 2 | `.md` 以外（`.MD` の大文字拡張子は `.md` として見ている）や、サブディレクトリの中の `.md` は検査しない | 低 |

## これが覆るとしたら

`docs/decisions/` に ADR でない `.md` を置く運用が増えたとき（許す一覧の見直し）。ADR のファイル名にドット等を許すと決めたとき（`ADR_FILENAME_RE` の1か所を変える）。
