# ADR 0690: 09/16 にマージされた G2（core の recall ゲート・排他・型）12本の確かめ直しで見つかった穴に歯を足す（Issue #1815）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1815](https://github.com/takecchi/mnemora/issues/1815) の G2。
これは試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない。変異は一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた。

## 経緯【実測】

2026-09-16（UTC）にマージされた PR のうち G2 の12本（#333・#348・#351・#376・#391・#399・#435・#362・#382・#427・#379・#383）に、変異を199本当てた（`recall-runtime.ts`・`recall.ts`・`runtime.ts`・`openai/llm-provider.ts`・`postgres/memory-store.ts`・`postgres/vector-store.ts`・testkit の in-memory fixture。型の PR は `tsc` で見た）。
Postgres は `initdb` で立てた手元の PG17（自分専用ポート）に当てた。

後の ADR で今の約束が変わっていたもの（今の約束に当てた）:

- #391（over_limit の件数）: ADR 0246 決定5 が「席を `類似度 × score.total` で埋める」ので、件数を「窓の外 ＋ 席を競り負けた分」の和に数え直した。
- #399（`ann_unreached`）: ADR 0285（`annReturnedFewerThanReachable`）・0288（`severity`）・0390（除外 kind を分母から引く・`scopeAggregate: "skip"`）が足されたが、発火条件（窓が満杯でも鳴る）は狭まっていない。
- #333（`memory_id` の tie-break）: ADR 0170 が「距離 → `recorded_at` DESC → `memory_id`」の3段にした。
- #435（排他性）: ADR 0203 の後処理が `over_limit`・`score_not_comparable`・`relation` にも広がっている。
- #379（`sweepArchive`）: ADR 0353 が subject 単位カウンタの有無の解決を足した。
- #376・#382: ADR 0288・0390 などで `AnnUnreachedSeverity` 等が足され、parity の組が増えている。

## すり抜けと足した歯【実測】

穴は14本（等価2本を除く）。

- #333: アンカーを `memoryId` の辞書順で処理しても赤くならなかった。`recall-association-recheck-0916.test.ts` が、作る順を入れ替えても `associationOf` がスコア順のアンカーであることを見る。
- #348: 連想用 `search()` の filter から `decayFloorSeqAfter`・`decayFloorSeqUsesSubjectCounters` だけを落としても緑だった（既存の配線の歯は壁時計と validAt だけ）。後置が救うため結果は変わらない。同ファイルに activity・either・subject カウンタの3本を足した。連想の後置で落ちた忘却ゲートを `filtered(decayed)` に二重に数えても緑だった。
- #351: 段1の後置で落ちた忘却ゲートを二重に数えても緑だった。ゲートを無視する adapter を模して、`filtered(decayed)` が1件・`exact` で1回だけであることを段1・連想の両方で見る（同ファイル）。
- #376: `aggregateScope`（Postgres）が `period`・`expired`・`taxonomy` に、直前のゲートで落ちた行まで数える変異3本が、適合テストをすり抜けた。`aggregate-scope-exclusive-filtered-recheck-0916.postgres.test.ts`（3本）が、落ちた理由が1件につき1つであることを見る。
- #399: `ann_unreached` を2回積んでも緑だった。1件だけであることを見る（同ファイル）。
- #382: `NewMemory`・`NewObservation`・`NewMemoryEvent` は `MutualAssignable`（ADR 0181 が弱い形と書いた組）なので、型だけに任意の欄を足しても `tsc` が緑だった。`schema-type-keys-recheck-0916.test.ts` が、この3組と `OutboxJobRecord` のキー集合を `Equals` で突き合わせる。**値の型は弱い形のまま**で、欄の足し引きだけを拾う（ADR 0181 の弱い形を強くするものではない）。
- #379: `sweepArchive` が `opts.usesSubjectActivityCounters` を無視する・`'wall'` でも subject カウンタの有無を読む、の2本（ADR 0353 の解決）。`sweep-archive-recheck-0916.test.ts` が見る。

当てて既存の歯で赤になったもの（#362 の `indexOf >= 0` は `n362-1`〜`3` で、直した assert 自身が赤になることを確かめた。#427 の `ZodError` 固定は12本とも赤。#383 の purge は21本とも赤。#391 は12本とも赤）は歯を足していない。

## 等価と判断した根拠【判断】

- `kPrime > 0` を外す: `kPrime = max(1, …)` なので恒真。
- `returnedMemoryIds` を below_threshold の取り下げ条件から外す: 返る経路は `withinLimit`（閾値を通った側で重ならない）・段3の同伴・段3.5 の連想の3つで、他の項が覆っている。
- #376 の `FilteredOmissionSchema` の `scopeRelation` を緩める変異は、`satisfies z.ZodType<FilteredOmission>` で `tsc` が赤になる（vitest だけでは緑）。
- #362 の `mark-contested.test.ts`・`recall.postgres.test.ts` に足された `>= 0` は、直前の `toContain` が先に落ちるため単独では赤にならない（冗長だが害は無い）。

## 決定【判断】

1. 実装・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験（core 3ファイル・postgres 1ファイル）と、この ADR だけである。
2. #382 のキー集合の歯は、ADR 0181 の弱い形の限界を埋める目的で足す。値の型の比較は強くしない。
3. 実バグは見つからなかった。

## 確かめていないこと

- #333 の Postgres 側の本番規模（HNSW が選ばれる規模）での決定性。
- #383 の「`tick()`・`observe()` に配線しない」約束は、配線を新設する形の変異を当てていない。
- #362 の `stage3-mandatory-companion-mutation.test.ts` は、実装側の変異では動かない（store を包む変異体を自分で持つ）ので、実装への変異で赤になることは見ていない。
- 全テストは流していない。関係するファイルを名指しして走らせた。CI の結果はこの時点では見ていない。
