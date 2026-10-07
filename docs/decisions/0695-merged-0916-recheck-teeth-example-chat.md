# ADR 0695: 09/16 にマージされた G5（examples/chat の使用報告・連想枠の既定・correction の CI の段・footprint の余白）4本の確かめ直しで見つかった穴に歯を足す（Issue #1815）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1815](https://github.com/takecchi/mnemora/issues/1815) の G5（最後の群）。
これは試験だけの変更で、実装・`ci.yml`・`package.json`・`*-conformance.ts`・`__fixtures__/` は触らない。変異は一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた。

## 経緯【実測】

#332（`memory_usage` の報告、[ADR 0163](./0163-memory-usage-reporting-example-chat.md)）・#336（連想枠の既定、[ADR 0168](./0168-examples-chat-uses-association.md)）・#384（`correction` を CI の歯に、[ADR 0190](./0190-correction-cli-dispatch-ci-tooth.md)）・#437（footprint の余白、[ADR 0201](./0201-recall-footprint-char-margin-canary.md)）に変異を当てた。examples/chat の DB の試験は共有の Postgres 17 + pgvector（`DATABASE_URL` あり、skip 無しを確認）、`ci.yml` の配線はルートの `scripts/__tests__/ci-yml*` を名指しして走らせた。「前」は既存の試験だけ、「後」は歯を足した後。

| PR                                                                             | 変異                                                                                                        | 穴             | 等価・既に赤・対象外                                                                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #332                                                                           | 12（`reportMemoryUsage` 5・`compare.ts` 4・`cli.ts` の `chat` 4。重複は数えない）                           | 6              | 無し                                                                                                                                                         |
| #336                                                                           | 12（既定値・`null` の転送・`runMnemoraPath`・`compare`・`budget-demo`）                                     | 7              | 既に赤5（`maxCount` を替える・`null` の扱い・budget の転送・既定の key を渡さない形は、渡す値を縛る `mnemora-path.test.ts` などで赤。最後の1本は挙動が同じ） |
| #384                                                                           | 43（`cli.ts` の `runCorrection`・dispatch 10、`correction-demo.ts` 14、`ci.yml`・`package.json` の配線 19） | 33             | 既に赤8（`correction-demo.ts`）、等価2（`kind === "filtered"` の落とし、`if: always()`）                                                                     |
| #437                                                                           | 34（余白の歯への入力・推定器・歯そのもの 16、配線 18）                                                      | 15（配線のみ） | 余白の歯の穴は0。既に赤2（配線）、等価1（`if: always()`）、歯を弱める5本は対象外                                                                             |
| 共有の配線（job・ワークフローの `defaults`・job の `continue-on-error`・`if`） | 6                                                                                                           | 3              | 既に赤3                                                                                                                                                      |

合計107本、穴64本。配線の変異は #384・#437・共有を合わせて43本で、穴36本、既に赤5本（job の `continue-on-error`×2・job の `if: false`・`test:db` の段の `run` を替える×2。どれも `ci-yml-local-embedding-fingerprint-wiring` が段を探せなくなって赤）、等価2本。

## 今の約束に当てたもの（後の ADR での変化）

- #332: [ADR 0163](./0163-memory-usage-reporting-example-chat.md) のとおり。載せる記憶が0件なら `observe()` を呼ばず、`chat` は budget 無しの recall だけを報告する（budget 有りは対象外、同 ADR の負債1）。狭まった約束は見つからなかった。
- #336: [ADR 0337](./0337-recall-association-default-on.md) が core の既定を on（`maxCount=10`）にした。ADR 0168 の「core の既定は変えない」は古くなったが、`examples/chat` が `maxCount=10` を明示して渡す形と `null` で止める脱出口は残っている。このため「既定の key を渡さない」変異は挙動が同じで、渡している値を縛る既存の試験だけが赤にする。歯は渡し方ではなく、記憶が実際に連想で返ること（`retrievedVia === "association"` の件数と `explain` の `association` の段）を見る。
- #384: [ADR 0293](./0293-remove-pr-text-checks-and-release-followup-notice.md) は PR タイトル・本文の CI 検査を消したが、`correction` の段とは別の話で、この約束は撤回されていない。
- #437: ADR 0201 の「ADR 0306 で較正標本が15点になる」後の値に当てた。ADR 0201 の本文にある7点での余白（42行の上側11.15字・FLOOR 7.73字）は、いまの較正では42行の下側9.39字・FLOOR 8.09字である（歯は固定値を持たず、較正から導く）。

## すり抜けと足した歯【実測】

- #332: `chat` が使用報告を呼ばない・budget 有りの recall を報告する・二重に報告する・0件のときの文言を取り違える変異、`compare` が行ごとに二重に報告する変異、載せる記憶が0件の行で `memoryUsageReported` が常に true になる変異が緑だった。既存の試験は `compare` が1回以上報告することしか見ず、`chat` の配線を一切見ていなかった。歯は、`chat` を実プロセスで走らせて報告が1回・budget 無しの recall（`recalls.budget` が NULL）・件数が画面の「memories: N 件返却」と `recall_usages` の行数と一致すること、全ての埋め込みを断る stub で0件のとき観測を書かないこと、`compare` の各行に使用報告の観測が1件・`recalls` が1件・`recall_usages` が返した件数ぶん入ること、偽の Runtime で0件の行が報告せず `false` を返すことを見る。`memory-usage-reporting-recheck-0916.postgres.test.ts`（3本）・`compare-memory-usage-empty-recheck-0916.test.ts`（1本）。
- #336: `runMnemoraPath` が `association`・`budget` を転送しない、`compare` が `association` を転送しない、`associationRows` を 0 や ann で数える、`budget-demo` の片方が連想を止める変異が緑だった。既存の試験は偽の Runtime が受けた query の値か、連想が働かない小さい会話しか見ていなかった。歯は、連想が実際に返る規模（42ターン、スコープ内21件）で、既定・`null`・`{ maxCount: 3 }` の件数と `association` の段の有無を、`compare`・`runMnemoraPath`・`budget-demo` の3経路で見る。`association-default-recheck-0916.postgres.test.ts`（4本）。
- #384: `runCorrection` の `process.exitCode = 1`（2か所）を外す・落ちても「通った」と言い続ける・失敗の閾値を緩める・片方の検査（`checkCorrectionDemo` か `checkCorrectionOmission`）を走査から外す・成功でも 1 にする・dispatch 行を消す変異がすべて緑だった（`cli.ts` の経路を見る試験が無い）。`checkCorrectionDemo` の `markSucceeded`・`resolveSucceeded`・`afterMarkBothPresent`・`afterResolveOriginalAbsent`・`afterResolveCorrectionPresent` を固定の `true` にする変異も緑だった（全欄 true の例と一部の失敗例しか無かった）。`ci.yml` では、`correction` の段への `|| true`・`; true`・`continue-on-error`（引用符つきのキー・文字列の `"true"` を含む）・`if: false`・`if:` の引用符つきキー・`shell:`（握り潰す形・引用符つきキー・`bash {0}`）、段を消す・別の script に替える・二重にする、job・ワークフローの `defaults.run.shell`、`package.json` の `correction` を `|| true` や別のコマンドにする変異が緑だった。歯は、実物の `cli.ts` を DB なしで import して終了コード・標準エラー（失敗した欄の名指し、複数欄、打ち切らないこと）・dispatch・`close()` を見る試験、検査関数の欄ごとの失敗を見る試験、`ci.yml` の段と `package.json` の script を見る試験である。`correction-cli-exit-recheck-0916.test.ts`（12本）・`correction-check-fields-recheck-0916.test.ts`（13本）・`scripts/__tests__/ci-yml-example-chat-required-steps-recheck-0916.test.mjs`（13本）。
- #437: 余白の歯そのものには穴が見つからなかった。`compare-baseline.json` の 42・322・642 行を、誤差の許容内で余白だけ削る値に替える変異と、推定器に +3 字の偏りを入れる変異は、この歯だけが赤にする（推定器が -3・+30 字ずれると他の歯も赤）。穴は配線にあった。`ci.yml` の `test:db` の段（#437 の歯が走る唯一の段）への上の変異と、`package.json` の `test:db`（`|| true`・`--exclude`・ファイル指定・`--passWithNoTests`）・`vitest.config.mts` の `exclude` が緑だった。歯は #384 と同じ配線の試験である。

穴の変異はすべて、足した歯で赤・戻して緑・`cmp` 一致を確かめた。`ci.yml` の変異は、足した試験1本だけで再測しても赤だった。

## 等価と判断した根拠【判断】

- `checkCorrectionOmission` の `o.kind === "filtered"` を落とす変異: `condition` を持つのは `filtered` だけで、他の種類では `undefined === "superseded"` が偽になるので実行時の結果は同じ（`tsc` は赤）。
- `correction`・`test:db` の段に `if: always()` を付ける変異: 段が落ちれば job も落ちる。歯は `always()` だけを許す。
- 余白の歯の 42行の上側を 590 字にする変異: 余白は 13 字で FLOOR（8.09 字）を下回らない。余白を削る値にはなっていなかった。

歯が今の約束より強い縛りになっている点: 段の `shell:` は `bash {0}` のような単行では結果が同じ値も禁じる。値の良し悪しを文字列で選ぶと握り潰す形を見逃すため、api-check の歯（[ADR 0675](./0675-merged-0916-recheck-scripts-ci-group-teeth.md)）と同じ判断にした。`package.json` の `test:db` を `vitest run` と完全一致で縛る点も同じで、これは条文ではなくクローンの判断である。

## 決定【判断】

1. 実装・`ci.yml`・`package.json`・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験6ファイルと、この ADR だけである。
2. 歯は今の約束より強い縛りにしない。上の2点（`shell:` の全面禁止・`test:db` の完全一致）だけが条文でなくクローンの判断で、そう書いた。
3. 余白の歯を弱める変異（FLOOR を 0 にする・片方向だけにする・最小を最大にする・境界の式を替える）は、試験では見られない。歯の中身を試験する試験は足さない。
4. 実バグは見つからなかった。

## 確かめていないこと

- 本物のモデル・実 API（`local` の重み・OpenAI）が要る経路。この群は `deterministic` と `recorded` の範囲である。
- `chat` の budget 有りの recall を報告しないこと（ADR 0163 の負債1）以外の、報告の対象の選び方。
- 本番の会話での使用報告の効き方（reinforce が decay を遅らせる量は既存の試験が見ている範囲のみ）。
- #437 の hold-in 7行（較正標本）の余白、本番の会話パターンへの一般化。
- CI の結果。全テストは流していない。関係するファイルを名指しして走らせた。
