# ADR 0666: 09/20〜21 にマージされた重みの指紋の門（#563・#588・#590・#592）とモデルキャッシュの鍵（#595）の確かめ直しで見つかった穴に歯を足す（Issue #1784）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1784](https://github.com/takecchi/mnemora/issues/1784)。
これは試験だけの変更で、`scripts/*.mjs`・`.github/workflows/ci.yml`・実装は触らない。

## 経緯【実測】

対象は、重みの指紋の門（`scripts/check-local-embedding-fingerprint{,-lib}.mjs`、`ci.yml` の「⭐ 門」ステップ、[ADR 0253](./0253-local-embedding-weights-fingerprint-gate.md) と追記）と、モデルキャッシュの鍵（`scripts/print-local-embedding-cache-key{,-lib}.mjs`、`ci.yml` の鍵を決める段と `actions/cache` 段、[ADR 0263](./0263-cache-key-carries-the-model-revision.md) と Issue #597 案(a)）。main `d645a1f6` で、門を外す変異と、やりすぎの変異を、`cp` で控えを取って当てた。

先の #1778・#1782（[ADR 0663](./0663-merged-0923-recheck-teeth.md)・[ADR 0664](./0664-merged-0922-recheck-publish-changelog-gate-stays-withdrawn.md)）が見つけた形がここでも出た。**ある文字列がファイルのどこかに在ること**しか見ない歯は、同じ門を別の書き方で外す変異を通す。

素通りしたもの（歯を足す前。全部、`embedding` / `ci-yml` を名前に含む試験が全部緑のままだった）:

- 指紋の門の配線（`ci.yml`）
  - 門のステップに `if: false`（`github.event_name != 'pull_request'` の形も）
  - `example-chat` ジョブに `continue-on-error: true`
  - 既存の歯が `^\s*continue-on-error:` で見ていたので、`"continue-on-error": true`（キーを引用符で囲む）
- 指紋の lib / CLI
  - 手元の hash と期待値を、全桁でなく先頭8桁だけ比べる（`compareFingerprints`）
  - 宣言の repo が読めないのを、赤でなく保留（exit 2）にする
  - `main().catch` を exit 3 でなく exit 0 にする
  - 読めなかったファイルがあっても一致なら exit 0（C4。Issue のコメントのとおり、先の回で歯を足した）
- キャッシュの鍵の配線（`ci.yml`）。8か所のうちの1か所、または全部に当てた
  - 鍵を決める段を `echo "key=…"` の手書きの鍵に置き換える（#601 の K2 と同じ形。文字列 `print-local-embedding-cache-key.mjs` が yml のどこかに1つ在れば通った）
  - `>> "$GITHUB_OUTPUT"` を外す／`if: false` を付ける／`id` を改名する／cache 段の後ろへ動かす（どれも、鍵の参照が空になる）
  - `outputs.key` を `outputs.keyx` にする（`toContain` が部分一致）
  - 鍵に `-${{github.run_id}}` を足す（毎回外れ、cache が実質無くなる）
  - cache 段に `restore-keys:` を足す
- キャッシュの鍵の CLI
  - 空文字の `sha` を受ける（K-d。前の回の WIP の歯を実測した）
  - `sha` が文字列でない（配列）ときに落ちる／repo・dtype の片方が読めないのを通す／宣言が揃っているのに警告する／起動時に HF へ `fetch` する

これらを除いた変異（ci.yml の `CODE=$?`・`|| true`・`| tee`・`set +e`・`case` の分岐、lib の優先順・revision 根・hash の種類、CLI の再試行・tree の形、鍵の材料の欠落など）は、既存の歯で赤になった。表は Issue #1784 のコメントにある。

## 決定【判断】

1. `scripts/*.mjs`・`ci.yml`・実装は変えない。足すのは試験だけである。
2. 指紋の門（`ci-yml-local-embedding-fingerprint-wiring.test.mjs`）
   - 引用符つきのキーも含めて `continue-on-error` を禁じる。
   - 門のステップに `if:` を許さない。
   - `example-chat` のジョブ直下に `continue-on-error` も `if:` も許さない（ジョブの `if:` が偽なら skipped になり、required check は skipped を緑として通す）。
3. 指紋の lib / CLI
   - lib: hash は末尾1桁の食い違いでも不一致。
   - CLI: 宣言の repo が読めないのは赤（exit 1）で、HF を叩かない。CLI は宣言を自分の位置から相対で読むので、CLI と lib を一時の木へ写して宣言の側だけ差し替える。キャッシュの repo の位置がファイルなら ENOTDIR で exit 3。
4. キャッシュの鍵（`local-embedding-cache-key.test.mjs`）
   - CLI: `sha` が空・文字列でないとき／repo・dtype が読めないときにフォールバックして警告する（exit 0）。宣言が揃っていれば警告しない。`fetch` と socket の `connect` を差し替えた子で走らせ、呼ばないこと（陰性対照: 同じ差し替えで `fetch` を呼ぶ子は印を残す）。
   - ci.yml: コメントを潰したうえで、ジョブごとに段を切り出し、鍵を決める段が cache 段より前にちょうど1つ在ること、その `run:` が `node scripts/print-local-embedding-cache-key.mjs >> "$GITHUB_OUTPUT"` の1行そのものであること、`if:` も `continue-on-error` も無いこと、cache 段の `key:` が `local-embedding-${{steps.local-embedding-cache-key.outputs.key}}` の1行そのものであること、`restore-keys` が無いことを見る。
5. `restore-keys` を禁じるのは、鍵に revision を入れて取り直させる ADR 0263 の目的に照らしたクローンの判断である。前方一致の復元を許す方針なら、その1本だけ外す（`restore-keys` が当たった重みは、鍵が変わっても古い revision のものを新しい鍵で保存し直す）。
6. 等価な変異は歯にしない。次の2つである。
   - `node ./scripts/check-local-embedding-fingerprint.mjs`（パス表記の変更）と、ステップに `shell: sh`。実行するものも終了コードも同じ。
   - 固定 revision の `length > 0` を外す変異（指紋の CLI 側の `readPinnedRevisionForCacheLayout`）。`cacheRepoDirs` と `normalizeActualPath` は真偽値で見るので、空文字の `sha` は「無い」と同じ。違うのは印字の1行だけ。
   - 前の回の L3（hash の種類を見ずに値だけ比べる）も、手元の hash は期待値と同じ種類で計算するので等価だった。

当てた変異は全部、赤になること・戻して緑になること・`cmp` で控えと一致することを確かめた。

## 確かめていないこと

- GitHub が `if:`・`continue-on-error`・`restore-keys` を本当にそう評価するか（既存の wiring 歯と同じ。YAML は構造として解析せず、文字列で見ている）。ステップは6桁の `- ` で始まり、その続きが8桁、という既存の歯と同じ見立てに乗っている。
- `if:` を持たない、という禁止は、今は `if:` を使う正当な理由が無い、という見立てである。正当な理由で付けるなら、ADR を積んでこの歯を直す。
- 鍵を `hashFiles` のような別の式に置き換える変異は、`key:` の1行そのものを固定したので赤になる。ただし、式の中身が正しい revision を指しているかは見ていない（それは鍵を決める CLI の歯が見る）。
- HF の tree の実物に対する門の判定（実モデルに対する実行）は、依頼者が手元で行った変異試験（ADR 0253）に任せている。
