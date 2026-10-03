# ADR 0611: 09/28 前後にマージされた #1310・#1329・#1350・#1351・#1354・#1355 の確かめ直しで見つかった軽い穴に歯を足す（案内の code 条件と cause の循環・2者版の勝者の綴り・件数の名乗り・較正の借り元・timeZone の受け入れ・claimedBy の空文字）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-52e2aa65）の依頼で、担い手が書いた。歯を書くと決めたのも、範囲を決めたのもクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0608](./0608-merged-0928-recheck-teeth-a.md) などの試験だけの PR と同じ）。
この PR は「PR B」で、PR A（ADR 0608）に入れなかった軽い穴のうち、変異が1つの約束に素直に対応するものを入れた。

## 経緯

マネージャーが、マージ済みの PR を、約束ごとに足りない側の変異を入れて確かめ直し、どの歯にも捕まらない変異を拾った【判断。拾った過程そのものは、この PR の担い手は再現していない。ただし下の「穴」の変異は、すべて担い手が手元で入れ直し、既存の歯がすり抜けるか、新しい歯でだけ赤くなるかを実測した】。

約束の出所は、各 PR の本文（担い手が `gh pr view` で読んだ #1310・#1350・#1351・#1354）と、実装の TSDoC・コメント（【現物】）である。#1329・#1355 は PR 本文を読まず、実装のコメントと TSDoc だけを出所にした。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない（公開の約束を増やすのはオーナーの領分。歯は `__tests__` に置く）。
2. 歯を足す（試験だけ）。出所と置き場は次のとおり。

### #1310（拡張を作る権限が無いときの案内）

出所: PR 本文「案内が付く条件: `code` が `42501` かつ `routine` が `execute_extension_script`」、`isCreateExtensionPermissionDenied` の TSDoc と、関数内のコメント「`cause` の連鎖を辿る（循環は一度見た段で打ち切る）」。置き場: `packages/postgres/src/__tests__/migration-failure-message.test.ts`。

- `routine` は `execute_extension_script` でも `code` が `42501` でない（`42601`・`code` 無し）入力には案内を足さない。
- `cause` を3段たどった先の pg のエラーでも案内を足す（先頭は外側の `message` のまま）。
- `cause` が循環していても止まる（互いを指す2つ・自分自身）。**循環よけが無いと同期の無限ループになり、テストの timeout では止まらない**ので、`cause` を getter にして読み出しを数え、50回を超えたら投げる。赤は「止まらない」ではなく、有限時間の失敗になる。循環の途中に pg のエラーが在る場合は案内が付く（これは循環よけの有無では変わらない。下の「捕まらなかったもの」）。

### #1329（2者版 `resolveContested` の id の綴り）

出所: `resolveWinnerSideId` のコメント（「`winnerId` が片側と大文字小文字だけ違うときは、同じ記憶かを store に聞く。…どちらの側とも大文字小文字を無視しても違う `winnerId` は store を読まずに落とす。`firstId`/`secondId` 自身が大文字小文字だけ違うときも今どおり落とす」）、`classify` のコメント（「相互参照は store が返した相手の id と比べる。相手が見つからないときは、今どおり渡された id と比べる」）、`memoryLookupKeyFor` の TSDoc。置き場: 新しい `packages/core/src/__tests__/resolve-contested-id-spelling.test.ts`（core の Fake の `memoryStore` の口を1つだけ差し替える。群版の `resolve-contested-group.test.ts` と同じ流儀）。

- 片側と大文字小文字だけ違う `winnerId` について store の `get` が別の記憶を返すなら `RangeError`、何も書かない。対照: 同じ記憶と言えば勝者になる。
- `firstId` と `secondId` が同じ記憶の2つの綴りで、`winnerId` が第3の綴りなら、救済せず `RangeError`、store は読まない。
- store が大文字を含む id を返しても、書き込みが競合したときの読み直し（`conflict`）の `observedStatus` が読み直した記憶の status になる。
- 相手が見つからないとき、`contestedWithId` を渡された相手の id と比べる（一致すれば `eligible` のまま。綴りまで同じでなければ `pair_broken`）。

別の commit で、`packages/postgres/src/__tests__/uppercase-uuid-contested-runtime.postgres.test.ts` の死んだ `else` 側を取り除いた。ADR 0521 以降、leg の `caseInsensitive` は両方 `true` で、`false` の側は通らない。印と `else` を消し、期待は `true` の側のまま変えていない（試験の中の掃除だけ。26本、2実装とも緑）。

### #1350（比較関数・件数の名乗り・拡張の行の抽出）

出所: PR 本文の C3・C4・C5・C6 と、`compareScoredCandidates`・`countKindForUnits`・`unitAssemblyShortfall`・`matchCreateExtensionLines` の TSDoc。置き場: `packages/core/src/__tests__/helper-tsdoc-promises-restored.test.ts`（C3・C4）、`packages/postgres/src/__tests__/extension-mode.test.ts`（C5・C6）。

- C4: Invalid Date が id の小さいほうに付いた逆の組（`invalid("a")` と `valid("b")`）でも id の昇順で決まる。既存の歯は `invalid("b")` と `valid("a")` の組だけで、Invalid Date を後ろへ送っても id の順と重なって通っていた。
- C3: 単位に入った異なる id の数が候補数を超える（二重は無い）と、`countKindForUnits` は `'unknown'`、`unitAssemblyShortfall` は `0`。
- C6 の今の振る舞いを固定する3本: `;` の後ろにコメントがあっても一致し、取り除くのは `;` まででコメントは本文に残る／名前の引用符を外さない／1行に2つあれば先頭だけ一致し、後ろは本文に残る。

### #1351（`calibrateRecallFootprint` の傾きが0以下のときの借り）

出所: PR 本文と `calibrateRecallFootprint` の TSDoc（「傾きが0以下なら…既定値から借りて名前で出す。最小二乗の枝では、切片は借りた傾きのもとで標本の平均を通るように決める」「@param fallback 決められなかった係数の借り元」「`totalInScope` が在る標本は構造項を差し引く」）。置き場: `packages/core/src/__tests__/recall-footprint.test.ts`。

- 標本が3件以上（既存の歯は2件だけ）でも、借りた傾きのもとの切片は標本の平均を通る（分母は標本の件数）。
- 借り元は引数の `fallback`（同梱とは違う値を渡す）。最小二乗の傾きが0以下・`memoryCount` が1種類・使える標本が無い、の3つの枝。
- `totalInScope` 付きの標本で、構造項を差し引いたあとの傾きが0以下なら借りる（差し引く前の傾きは正）。

### #1354（`timeZone` の受け入れ・フォールバックの digest の長さ）

出所: `ExtractionContextSchema` の TSDoc（「検査が問うのは `Intl.DateTimeFormat` が受け付けるかだけ。値は正規化せず、渡された文字列のまま保存され、プロンプトにもそのまま入る。検査を IANA の名前だけに絞ると、今は通る入力が例外になる（破壊的）ので、締めていない」）と [ADR 0299](./0299-extraction-context.md) の追記5（【現物】。本文は読み直していない）、`RuntimeConfig.digestFallbackLength` の TSDoc。置き場: `packages/core/src/__tests__/extraction-context.test.ts`、`packages/core/src/__tests__/reflect-blank-digest-and-tags.test.ts`。

- `timeZone` が `JST`・`+09:00`・`asia/tokyo` でも受け付け、保存された payload とプロンプトの `timeZone` は渡された綴りのまま、プロンプトの `observedLocalDate` は UTC+9 の暦日（その値を `Intl` に渡して計算している）。締めること・正規化することを止める歯ではなく、「今の形」を守る歯である。
- `reflect`（空文字の digest）と `consolidate`（digest を省いた応答）のフォールバックの digest は、`config.digestFallbackLength` の長さで切って `…` を付ける。`config` を渡さなければ既定の200字。

### #1355（`claimedBy` の空文字）

出所: `RuntimeConfig.defaultClaimedBy` と `TickOptions.claimedBy` の TSDoc（「空文字は既定に倒れず、そのまま `OutboxStore.claimBatch` に渡る」）。置き場: `packages/core/src/__tests__/runtime-config-defaults-doc.test.ts`（`claimBatch` の呼び出しを見る既存の流儀）。

- `defaultClaimedBy: ""` は既定に倒れず、そのまま渡る。
- `tick` の `opts.claimedBy: ""` は、`defaultClaimedBy` にも既定にも倒れず、そのまま渡る。
- 対照: 空でない値は、`opts.claimedBy` が `defaultClaimedBy` より、`defaultClaimedBy` が既定より優先される。

3. ADR 0347 など、ほかの ADR には追記しない。

## 実測【実測】

PostgreSQL 17（`--encoding=UTF8 --locale=C.UTF-8`、自分専用のインスタンス）。対象ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、緑に戻した。「穴」はマネージャーが挙げた（または担い手が同じ約束から作った）変異、「やりすぎ」は正しい振る舞いまで壊す向きの変異。「既存」は、この PR より前から在った歯。

| 約束 | 変異 | 赤になった歯 |
| --- | --- | --- |
| #1310 | 穴: `code === "42501"` の条件を外す | 新しい歯1本（`code` だけが違う入力） |
| #1310 | 穴: 循環よけ（`seen`）を外す | 新しい歯2本（互いを指す・自分自身）。どちらも `cause was read more than 50 times` で、有限時間で落ちる |
| #1310 | 穴: `cause` を2段目までで止める | 新しい歯1本（3段） |
| #1310 | やりすぎ: 外側のエラーを見ず `cause` から始める | 既存1本（案内が付く基本形） |
| #1329 | 穴: `winner.id === side.id` の確認を外す | 新しい歯1本。既存の `resolve-contested`・`resolve-contested-group`・`fake-uppercase-target-id` は緑のまま |
| #1329 | やりすぎ: `winner.id !== side.id` | 新しい歯2本（別の記憶→RangeError と、同じ記憶→勝者） |
| #1329 | 穴: `candidates.length === 1` を `>= 1` | 新しい歯1本 |
| #1329 | やりすぎ: `candidates.length === 2` | 新しい歯2本 |
| #1329 | 穴: `refetchedById` のキーを `m.id` に戻す（`resolveContested` の側だけ） | 新しい歯1本 |
| #1329 | やりすぎ: 読み直しの `observedStatus` を先頭側だけ常に外す | 新しい歯1本と既存1本 |
| #1329 | 穴: `otherMemory?.id ?? otherId` の右側を `otherId.toLowerCase()` | 新しい歯1本（`pair_broken` の側） |
| #1329 | 穴: 右側を `""` | 新しい歯1本（`eligible` の側） |
| #1329 | やりすぎ: 左側を捨てて常に `otherId` | 既存1本（`fake-uppercase-target-id` の markContested・resolveContested）。新しい歯は緑 |
| #1350 | 穴: `compareScoredCandidates` が Invalid Date を最後尾へ送る | 新しい歯1本（逆の組）。既存の `threshold-partition`・`scored-candidate-tiebreak`・`score-sort-nan`・`recall-pipeline` は緑 |
| #1350 | やりすぎ: Invalid Date を先頭へ送る | 既存1本（新しい逆の組は、この向きとは id の順が重なって緑のまま。対になっている） |
| #1350 | 穴: `unitAssemblyShortfall` を `Math.abs(...)` | 新しい歯1本。既存は緑のまま |
| #1350 | 穴: `countKindForUnits` の `distinct === candidateCount` を `>=` | 新しい歯1本。既存は緑のまま |
| #1350 | やりすぎ: `<=` | 既存3本（`helper-tsdoc-promises-restored` の「抜けだけ」1本ほか。新しい歯は緑） |
| #1350 | C6 を変える: `;` の後ろを行末に限る | 新しい歯2本（コメント・1行に2つ） |
| #1350 | C6 を変える: 名前の引用符を外す | 新しい歯1本 |
| #1350 | C6 を変える: 同じ行の `; ` の後ろからも一致させる | 新しい歯1本（1行に2つ） |
| #1351 | 穴: 借りた傾きのときだけ切片の分母を `2` に固定 | 新しい歯2本（3件の標本・`totalInScope` 付き）。2件だけの既存の歯は緑のまま |
| #1351 | 参考: 切片の分母を常に `2` | 既存4本と新しい歯2本が赤（傾きが正の枝でも使う行なので、既存の歯が捕まえる。穴ではない。上の「借りたときだけ」が穴の形） |
| #1351 | 穴: 借り元を同梱の既定にする（初期値） | 新しい歯4本（3つの枝・`totalInScope`）。既存は緑のまま |
| #1351 | 穴: 構造項を差し引かない | 新しい歯1本と既存2本 |
| #1351 | やりすぎ: 傾きが正でも借りる | 既存8本（新しい歯は「借りる側」を縛るので緑のまま） |
| #1354 | 穴: `refine` を `Intl.supportedValuesOf("timeZone")` の中だけに絞る | 新しい歯3本。既存（`Asia/Tokyo`）は緑のまま |
| #1354 | 穴: `Intl` の解決した名前に正規化して保存する | 新しい歯2本（`JST`・`asia/tokyo`）。`+09:00` は解決しても `+09:00` のままで、この変異は捕まえない |
| #1354 | やりすぎ: 受け付けない値も通す | 既存1本 |
| #1354 | 穴: `reflect` の渡し先を既定値の定数にする | 新しい歯1本（reflect の長さ7） |
| #1354 | 穴: `consolidate` の渡し先を既定値の定数にする | 新しい歯1本（consolidate の長さ7） |
| #1354 | やりすぎ: `consolidate` の渡し先を常に7 | 新しい歯1本（既定の200字）。`reflect` 側へは入れていない |
| #1355 | 穴: `defaultClaimedBy` の `??` を `\|\|` | 新しい歯1本 |
| #1355 | 穴: `opts.claimedBy` の `??` を `\|\|` | 新しい歯1本 |
| #1355 | やりすぎ: `opts.claimedBy` を捨てて常に既定 | 新しい歯2本（空文字・対照） |

`tick-opts-validation.test.ts` は、#1355 のどの変異でも緑のまま（空文字を通す入力は検査しているが、`claimBatch` に渡る値は見ていない）。

## 外したもの

マネージャーの指示による。この PR の担い手は、次の5つを再検証していない【判断】。

- **#1319**: 等価に近い変異で、歯を足しても約束を縛らない。
- **#1354 の全部空の `tags`**: 約束があいまい（落とすのか、拒むのか、TSDoc だけでは決まらない）。
- **#1355 の空の `subjectId`・`tenantId`**: 変更が TSDoc だけで、振る舞いの約束が増えていない。
- **#1310 の再輸出**: 公開 API のスナップショット（`pnpm run api:check`）が捕まえる。
- **#1350 の負の `maxLength`**: ほぼ等価な変異。

## 縛っていないもの

- **`pg_` で始まる名前**: `assertSafeSchemaName` が `pg_` で始まる名前を通すことは縛っていない。#1350 の C5 は、通るが `CREATE SCHEMA` が DB の例外で落ちる、と TSDoc に書いた今の形である。将来、入口で拒む余地を残すため、通すことを歯にすると、その直しが歯を書き換えさせる。C6 の3本も「望ましい形」ではなく今の振る舞いで、締める・広げる直しをしたら、どの入力の結果が変わるかを赤で見えるようにしておくものである（歯のコメントにも書いた）。
- **#1329 の `refetchedById` のキー**: 変異は、store が大文字を含む id を返すときにだけ見える。`@mnemora/postgres` は小文字で返し、`lookupKey` も小文字にするので、Postgres と testkit の fixture の leg では、この変異は捕まらない【判断。Postgres の leg に当てる変異試験はしていない。core の `dist` を作り直していないため】。歯は、大文字を含む id を返す store を core の Fake の口の差し替えで作って縛った。
- **#1329 の Postgres の歯への変異試験**: 掃除した `uppercase-uuid-contested-runtime.postgres.test.ts` は、掃除の前後とも緑（26本）を実測しただけで、`runtime.ts` への変異は当てていない。
- **#1310 の循環の途中に pg のエラーが在る場合**: 新しい歯の3本目は、循環よけを外しても緑のままである（連鎖を回る前に一致して返る）。「案内が付く」ことの歯で、「止まる」ことの歯は1本目・2本目。
- **#1354 の `+09:00`**: 「`Intl` の解決した名前に正規化して保存する」変異では、`+09:00` は変わらない（解決の結果が同じ綴りのため）ので、この値だけを見れば正規化の変異は捕まらない。`JST`・`asia/tokyo` が捕まえる。
- **#1354 の受け入れる値の集合**: 実行環境の `Intl`（ICU）に依存する。歯が縛るのは `JST`・`+09:00`・`asia/tokyo` の3つだけで、ICU がこれらを拒む環境では赤になる（赤は約束が破れたのではなく環境の差）【判断。Node の既定の ICU でだけ走らせた】。
- **#1354 の `reflect` 側の「やりすぎ」**: 渡し先を常に7にする変異は `consolidate` にだけ入れた。`reflect` の既定の200字の歯は在る（変異は入れていない）。
- **#1351 の `totalInScope` 付きの標本**: 構造項の値は、既存の歯が使う独立の数え方（桁上がり）に合わせて作った。`bandChars` などほかの項が0であることは、`memoryCount = totalInScope`（帯が空）で保った。

## これが覆るとしたら

#1310 の案内の条件（`code` と `routine` の両方・`cause` の連鎖）、ADR 0521 以降の id の綴りの扱い（store に従う）、#1350 の C3・C4・C6 の TSDoc、`calibrateRecallFootprint` の「傾きが0以下なら借りる」、ADR 0299 追記5の `timeZone` の今の形（締めると破壊的）、`defaultClaimedBy`・`claimedBy` の「空文字はそのまま渡る」が変わるとき。
