# ADR 0676: 09/17 にマージされた15本のうち、Postgres を要さない側（G2・G4・G5・G6・G7）の確かめ直しで見つかった穴に歯を足す（Issue #1812）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1812](https://github.com/takecchi/mnemora/issues/1812)。
これは試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。

## 経緯【実測】

2026-09-17（UTC）にマージされた PR は66本で、対象にしたのは15本。残り51本は、文書だけ 38・試験だけ 7・測定・ベンチの道具 4・撤回済み 2 である。分母（全66本の表）は Issue #1812 の本文にある。変異は main `46d70dbf` の上で、控えを `cp` で取って1本ずつ当て、`cp` で戻して `cmp` で一致を確かめた。

対象15本のうち、この ADR が扱うのは次の11本である（Postgres が要らないまとまり）。

| まとまり | PR | 結果のコメント |
|---|---|---|
| G2 | #517 `Runtime.findCorrectionCandidates` | [コメント](https://github.com/takecchi/mnemora/issues/1812#issuecomment-6024275042) |
| G4 | #446 `LocalEmbeddingPipeline` の必須 interface 化 | [コメント](https://github.com/takecchi/mnemora/issues/1812#issuecomment-6024435440) |
| G7 | #493 compare の turnCount 判定・#513 基準値の鮮度・#469 ADR をアンカーで指す歯 | [コメント](https://github.com/takecchi/mnemora/issues/1812#issuecomment-6024690098) |
| G5 | #450 outbox の同時 claim の適合テスト（in-memory 側）・#514 の testkit 部分（`cassette-recorder.ts`） | [コメント](https://github.com/takecchi/mnemora/issues/1812#issuecomment-6024933662) |
| G6 | #461 ルートの test 門・#462 publish 段の網羅・#478 CI 緑の下限（ADR 0281 込み）・#474 リリース候補の道具 | [コメント](https://github.com/takecchi/mnemora/issues/1812#issuecomment-6025354556) |

どのまとまりも、約束が狭まった・取り下げられた出典は見つからなかった（止める条件に当たらない）。#478 は ADR 0281 が理由の文言を足しただけで、緑の根拠は変えていない。#474 の CI の段（`changelog-candidates-summary.mjs`）は ADR 0293 が削除したが、道具本体の約束は残っている。

## すり抜けと足した歯【実測】

### G2（#517）

穴は8本（`limit` で切ってから除外する・`omitted`／`explain` を落とす・`retrievedVia` を固定値にする・`text` を40字で切る・`limit` に上限5／100を課す・連想枠の候補を落とす）。`packages/core/src/__tests__/correction-candidates-recheck-0917.test.ts` に6本。実バグは無し。

### G4（#446）

穴は16本。`countTokens` の値を縛る歯が、この PR にも後続にも無かった（丸める・常に0・順を逆に・+1ずれる）。ほかに、`detail.characters` にトークン数を入れる・`texts` の順を逆に渡す・`maxInputTokens`／`countTokens` を optional にする（型）・上限値の焼き込み・空文字や65件以上を拒む・provider が `this` 無しで `embed` を呼ぶ・provider が `countTokens`／`maxInputTokens` を読む。`packages/local-embedding/src/__tests__/pipeline-interface-recheck-0917.test.ts` に11本。型の歯（`@ts-expect-error`）は vitest 単独では緑のままで、**`pnpm run typecheck`（local-embedding）が守る**。実バグは無し。

### G7（#493・#513・#469）

変異は127本。`compare-summary-recheck-0917.test.mjs` に27本、`adr-citation-recheck-0917.test.mjs` に14本、`adr-citation.test.mjs` に走査の母集合の確認を1本。穴は、判定の基準（許容幅・基準値側の false を退行とする・reason から件数を落とす）、鮮度（`omitted` しか見ない・並び・注記）、CLI の stderr（判定不能で会話長を名指さない）、`ci.yml` の門の段と `example-chat` ジョブの `continue-on-error`、ADR 検出器の書き方の一族、走査側（集める側が `[]` を返す・`AGENTS.md`／`README.md` を落とす）。**見つかった実バグ**は Issue [#1814](https://github.com/takecchi/mnemora/issues/1814)（`compare-summary.mjs --baseline ""` と値なしの `--baseline` が exit 0 になり、門が黙って外れる）。直していない。

### G5（#450 の in-memory 側・#514 の testkit 部分）

- `outbox-concurrent-claim-conformance-recheck-0917.test.ts`: in-memory は `supportsRealConcurrency` を渡さない（ADR 0206 決定1）ので、並行の `it` は `it.skip` で、既存の試験では**並行の歯が一度も走っていない**。そのため歯は、`describeOutboxStoreConformance` を**変えずに**、本当に await をまたぐ偽の store（正しいもの・check-then-act で必ず二重 claim するもの・10本目のテナントでだけ壊れるもの・8並行でだけ壊れるもの・合計0になりうる正しいもの）へ当てて確かめる形にした。壊れた store には「並行の `it` が落ちること」を期待し、vitest の task に `fails` を実行の直前に立てる。conformance の判定（重複だけを見る）は変えていない。
- `cassette-recorder-recheck-0917.test.ts`（10本）: 後勝ちの上書き・`recordedAt`・配列でない／件数が多い戻りの拒否・複製・`completeStructured` の検証し直しと失敗の後の呼び直し。
- 穴は、conformance 側が K1〜K15・S1〜S5、in-memory が `claimedBy` を書かない1本（X12）、recorder が C10・C11・C18・E5/E6・E8・L6・L18・L12・L21。実バグは無し。

### G6（#461・#462・#478・#474）

変異は約165本。新規の試験は4ファイル（`root-test-gate`・`check-publish-run-coverage`・`ci-green-check`・`release-candidates` の `-recheck-0917.test.mjs`）。既存の歯は、純関数側しか見ておらず、**実行部・CLI を一度も起動していなかった**（#461 の実行部、#478 の CLI、#474 の CLI）。歯は、実物を一時ディレクトリへ複写して `STAGES` や `gh` を偽に差し替えて起動する形にした。ほかに、`ci.yml` の `Test` 段が `continue-on-error`・`|| true` で黄色にされないこと、ADR 0215 の「green の reason を1バイトも変えない」、ADR 0214 の「type も信号も無い commit を母集合から落とさない」、ADR 0209 の「文言の同一性を機械が検査していない」負債を払う歯（`publish.yml` の `echo` の文言を分類にかける）。実バグは無し。

## 等価と判断した根拠【判断】

等価な変異は歯にしない。主なもの:

- G2: `trim()`（`recall()` が `validatedQuery.text?.trim()` を埋め込みの前にどのみち行う）・score の浅い複製（約束は値で、同一参照ではない）・空 digest（`digest: z.string().min(1)` で到達しない）。
- G7: `sort` を外す（昇順は約束に無い。ただし鮮度側の `staleRows` は「昇順」と書かれているので歯にした）・`undefined` キーを消す（検証後は到達しない）・`step` の頭に `set +e`（末尾コマンドの終了コードが step のそれになる）。
- G5: 全 worker が同じ `claimedBy`（二重 claim の判定は `claimedBy` を見ない）・空の節の検査（空間とモデルは記録と必ず同時に入る）・先勝ち／後勝ちの差が出ない空間（同じ値しか通らない）。進行中の応答の複製を2段とも外す変異は、**推論で等価と読んだ**もので、歯では確かめていない。
- G6: ANSI 除去（group の開始行は行頭アンカーで、ANSI 付きの行は除去しても一致しない）・`failed` と `skipped` の判定順（`publish.yml` の `if/elif/else` で排他）・`mergeable_state` の `"null"` 文字列。

約束に無いので歯にしないもの: G5 の `CassetteRecorder`・`Recording*` の `space` の複製（ADR 0452 A-6 が複製を求めるのは `Recorded*`・`Deterministic*`）、G6 の同名 group が複数のときの扱い（lib の docstring が未規定と書いている）。

## 決定【判断】

1. 実装・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験だけである。
2. 上の11ファイル（新規10＋既存の `adr-citation.test.mjs` に1本）を足す。
3. G5 の歯は、conformance の判定を変えずに、conformance を偽の store に当てて確かめる形にする。conformance と fixture のファイルは、一時的な変異にしか使っていない（push する差分に入っていない）。
4. 実バグは Issue #1814 に積み、この PR では直さない。直し方（空値は exit 1）の判断は別である。

## 確かめていないこと

- **G1（#464・#524・#492・#502、Postgres を要する）と G3、#450 の Postgres 側**（`conformance.postgres.test.ts`、`FOR UPDATE`・`SKIP LOCKED`）は、手元に Postgres を立てておらず測っていない。残りとして Issue #1812 に残す（この PR は `Closes` にしない）。
- 偽の `gh`・偽の store で測ったものは、実物（実 CI の run・branch protection・GitHub Release・`pg.Pool`・複数プロセスの同時 claim）との一致を見ていない。偽の store が await をまたぐのは `setImmediate` までで、DB のロックの代わりにはならない。
- `fails` は「何かで落ちれば緑」で、壊れた store の並行の `it` が落ちた**理由**までは見ていない。同じ suite の逐次の `it` が通ることで間接に支えている。
- G4 の公開 API snapshot 門・`check-publish-pack`（全パッケージのビルドが要る）、`live.*.test.ts`（本物のモデル）。
- 外した51本と、`examples/chat` 側（測定・ベンチの道具）。
- G6 の軽微なずれ（直していない）: `findPublishStepName` の docstring は「`- name:` を持たない step なら `null`」と書くが、実装は直近の `- name:` を返す。今の `publish.yml` は全段に名前が付いているので踏んでいない。
- 全テストは流していない。関係するファイルを明示して走らせた。
