# ADR 0664: 09/22 にマージされた #601（publish の CHANGELOG 門の撤回）の確かめ直しで見つかった穴に歯を足す（Issue #1782）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1782](https://github.com/takecchi/mnemora/issues/1782)。門を撤回したこと自体は、オーナーの決定である（[ADR 0267](./0267-withdraw-the-release-changelog-publish-gate.md)）。この ADR はそれを動かさない。
これは試験だけの変更で、`publish.yml`・実装・CHANGELOG は触らない。

## 経緯【実測】

#601 は、出す版の節が `CHANGELOG.md` に在るかの publish の門を外し、`scripts/__tests__/publish-yml-changelog-gate-wiring.test.mjs` の向きを反転させて「門が配線されていないこと」を縛った。その歯は、撤回前の配線の文字列（道具の名前・`git show origin/main:CHANGELOG.md`・`RELEASE_PRERELEASE:`）だけを探す。

main `2561b514` の `publish.yml` に「門を戻す」変異を2つ当てた。
- 撤回前の段をそのまま戻すと、3本が赤になった。
- **同じ門を別の書き方で戻すと（道具も `git show` も使わず、`grep` で `CHANGELOG.md` の released の節を見て、無ければ `exit 1`）、`scripts/__tests__` 全体（2146本）を素通りした。**

`publish.yml` は required の check を持たない（`release` の引き金でしか走らない）ので、戻っても PR は緑のままになる（同じ歯のコメントがそう書いている）。

## 決定【判断】

1. `publish.yml` は変えない。
2. 同じ歯のファイルに it を1本足す。コメントを除いた `publish.yml` の本文に `CHANGELOG`（大文字小文字を問わない）が1つも出ないこと。いまの `publish.yml` は、コメントを除くと `CHANGELOG` を1か所も読まない【実測】ので、読み始めたら書き方によらず赤になる。上の変異で赤、戻して緑を確かめた。
3. 門以外の正当な理由で `publish.yml` が `CHANGELOG` を読むことになったら、ADR を積んでこの it を直す。

## 確かめていないこと

- `CHANGELOG` という語を使わずに節を読む書き方（別名のファイルを経由する、など）は捕まえない。
- `if:` の式を GitHub が本当にそう評価するか（元の歯と同じ）。
