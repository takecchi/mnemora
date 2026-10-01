# ADR 0447: lifecycle の「操作 × 状態」の行列を当てた（穴探し23巡目。直す線に当たる穴は0件）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー）の委譲先が書いた。**文書だけの ADR で、コードは1行も変えていない。**
目的は、次の担当が同じ面を当て直さずに済むこと。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探し23巡目。面は `docs/memory-model.md` §11 の遷移表の**順路の外側**——各操作を、表に書かれていない出発の状態に当てる。
  2026-09-27 の追記2が各行の順路を当て直して「一致した」としていたので、その外側を測った。
  除外: ADR 0432 の restoreArchived と sweepArchive の重なりの窓、21巡目（ADR 0446）の applyCorrection、22巡目の migrate、14〜21巡目の面（ADR 0434〜0446）。

  【実測】手元の Postgres 17（UTF8、`C.UTF-8`）と testkit のインメモリ実装の両方に、使い捨ての探り棒（vitest 1ファイル。コミットしていない）で当てた。
  各セルで、返り値の `kind`、操作の前後の `status`・`contestedWithId`・`supersededById`・`purgedAt`、`memory_events` の種類と `meta` を取った。

  **結論: TSDoc と遷移表がはっきり約束している形から外れたセルは、0件だった。直す線に当たる穴は無い。**
  材料にとどめる5件（下の「引き受けた負債」）はどれも `MemoryStore` を直接呼んだときだけ起き、Runtime の口からは到達できなかった。

  **陽性対照**（「出なかった」を、事象が無いことの証明にしないため）: 同じ探り棒は、書き込みが起きるセルでは状態の変化とイベントを確かに捉えた。
  例: `forget(active)` → `forgotten` とイベント1件、`restoreSuperseded` → `unsuperseded`、`markContested` → 両側 `updated`、`purge` → `forgotten, purged`。
  さらに「store の口を直接呼ぶ」セル（負債1〜5）では、探り棒が壊れた状態（`contestedWithId` が残る active など）を実際に捉えた。
  したがって、書き込み・イベントが「0件」と書いたセルは、探り棒が見えなかったのではない。

- **決めたこと**:

  1. **コードも文書の約束も変えない。** 当てた範囲で実装は約束どおりだった。
  2. **次の担当は、下の「当てた形」の表の面を当て直さない。** 面を広げるなら、「測っていないこと」から始める。
  3. **材料5件は「引き受けた負債」に緊急度つきで残す。** どれも新しく断る入力を増やす直しで、オーナーの領分（【判断】）。

- **検討した代替案**:

  1. **探り棒を conformance の歯として足す。** 採らなかった。測った振る舞いは既存の歯（`restore-superseded.test.ts`、`contested-pair-lock-order-concurrency.postgres.test.ts`、`resolve-contested-pair-scope-and-concurrency.postgres.test.ts`、`restore-superseded-concurrent-forget.postgres.test.ts` など）と重なる。歯が赤になる実装が先に無いため、直す前に赤を見せる作法も満たせない。
  2. **負債1〜5を、store の口で断る直しにして出す。** 採らなかった。約束が書かれておらず、今は成功して状態が変わる入力を新しく断ることになる。

- **引き受けた負債**（`MemoryStore` を直接呼ぶと起きる。Runtime の口は常に正しい形で渡す。【実測】両実装で同じ）:

  | # | 再現 | 結果 | 緊急度 |
  |---|---|---|---|
  | 1 | `updateStatus(T, 'active')`（`expectedStatus` 省略）を contested の T に。`'superseded'`・`'forgotten'`・`'archived'` も同様 | T は新しい status のまま `contestedWithId=P` が残り、P は contested のまま `contestedWithId=T` | 低。doc は「省略時は常に更新」、ADR 0140 が「contested から離れる側は縛らない」と明記済み |
  | 2 | `updateStatusWithEvent(T, 'active', { expectedStatus: 'forgotten' }, …)` を purged の T に | status は `active`、`content`=`[purged]`、`purgedAt` は非 null。トゥームストーンが active として戻る | **低〜中**。Runtime の restore 系は forgotten を戻さないので Runtime 経由では起きない。`Runtime.purge` の TSDoc の「不可逆」を store の口が守っていない |
  | 3 | `resolveContestedPair` で `status:'superseded'` に `supersededById` を付けない | `superseded_by_id=NULL` の敗者ができ、`restoreSuperseded` の群に入らず戻せない | 低。`Runtime.resolveContested` は常に渡す |
  | 4 | `resolveContestedPair` で `supersededById` に自分自身、または互いを指定 | 自己置換、または T と P が互いに superseded の循環 | 低。Runtime は勝者を検査して渡す |
  | 5 | `updateStatus(T,'superseded',{supersededById:T})`、および `supersededById` 省略 | 自己参照、または勝者の無い superseded | 低 |

  ほかに、既に別の ADR が記録している設計を、探して再確認しただけのもの（新規ではない）:
  - 同じ呼び出しに大文字小文字だけ違う id を混ぜると、渡された文字列どおりに突き合わせ、片方が `not_found` になる（`memoryLookupKeyFor` の doc）。`markContested(T, 大文字のT)` は、実在する記憶を `not_found` と名指す `ineligible` を返す。書き込みは無い。
  - contested の片側を `forget` すると、もう片側は `contestedWithId` が forgotten を指したまま contested で残り、`resolveOrphanedContested` でだけ解ける（ADR 0136・0150）。
  - `reason`・`actor.id` に NUL・孤立サロゲートを含めると、`forget`・`purge`・`restoreArchived` は `failed` を返し、`restoreSuperseded`・`markContested`・`resolveContested`・`resolveOrphanedContested` は例外を投げる。両実装で同じ形で、何も書かれない（ADR 0446 の `applyCorrection` と同じ）。
  - `reinforce` が status を見ない点は `MemoryStore.reinforce` の doc（Issue #840）。

- **これが覆るとしたら**:

  - 負債2: オーナーが「purged の行は status を動かせない」を store の約束にすると決めたとき（`updateStatus*` が `purgedAt` 非 null の行を断る）。
  - 負債1・3・4・5: オーナーが `MemoryStore` の状態書き込みに不変条件の検査を持たせると決めたとき。

- **測ったこと**（【実測】2026-10-01、Postgres 17、UTF8（`C.UTF-8`）、testkit のインメモリ実装）:

  - **測っていないこと**（未測定。次の巡の入口）: contested の群（`markContestedGroup`・`resolveContestedGroup`）の全面の行列（26巡目の面）、`tick` の embed ジョブ × 各状態（purge との競合は `processEmbedJob` の末尾が既に見ている——現物を読んだだけ）、SQL_ASCII の DB、複数プロセス・複数接続プール、`sweepArchive` の `limit`・`now` の境界（ADR 0114・0432）。

- **当てた形**（探して問題が無かった点。Postgres と testkit のインメモリ実装の両方）:

  | 面 | 入力 | 結果 |
  |---|---|---|
  | 状態 × 操作 | 6状態（active・contested・superseded・archived・forgotten・purged）× 13操作（forget、purge、purge dryRun、restoreArchived、restoreSuperseded の T 勝者／P 勝者／dryRun、markContested の (T,P)・(P,T)、resolveContested の both_active／T 勝ち／P 勝ち、sweepArchive） | 両実装で一致（id を伏せた diff が空。sweepArchive は id が違うので状態別に比べた）。表に無い出発では `status_not_forgotten`・`status_not_archived`・`outcomes: []`・`ineligible`（`status_not_active`／`status_not_contested`／`pair_broken`）で、書き込み・イベント0件 |
  | forget | active・contested・superseded・archived／forgotten・purged | `forgotten`（`previousStatus` つき、イベント1件）／`already_forgotten`（0件） |
  | purge | forgotten／purged／dryRun | `purged`／`already_purged`／`would_purge`・`already_purged` |
  | sweepArchive | 各状態 | active と superseded の勝者 P は archived。contested・superseded の T・forgotten・purged は触られない |
  | 対の組 | markContested・resolveContested（both_active／supersede）× first 6状態 × second 6状態 = 216通り | 両実装で一致。書き込みは「active×active の mark」と「相互参照が成立した contested の対の resolve」だけ。ほかは `ineligible`、ev+0 |
  | id の形 | 大文字、`[T,T]`、`[T,大文字T]`、別テナント、混在テナント | Postgres は大文字を同じ記憶として扱い、インメモリは区別する（既知の設計）。重複は2回目が `already_*`／`status_not_*`。別テナントは `not_found`、書き込み無し |
  | 不正な id | `not-a-uuid`・空文字・NUL 入り・5000字・SQL 風・全角数字を、全口と dryRun に | 72セル×2実装で、例外は `resolveContested` の `winnerId` 不正の `RangeError`（TSDoc どおり）だけ |
  | 件数 | 1000・65535・65536・70000・140000 件（実在しない uuid）を forget・purge・purge dryRun・restoreArchived・restoreSuperseded の `onlyMemoryIds` に | バインド上限の崖なし。全件 `not_found`、例外なし |
  | 勝者・敗者の経路 | 敗者を forget／purge してから restoreSuperseded、勝者を forget／archive してから restoreSuperseded、restoreSuperseded を2回 | 敗者は forgotten・purged なら戻さない（dry も `[]`）。勝者が forgotten・archived でも敗者は active に戻る（doc 済み）。2回目は `[]` |
  | 同時実行 | 14操作（restoreSuperseded ×2、mark・resolve の逆順、forget・purge・restoreArchived・sweepArchive）を 40回 | deadlock・例外・片側だけ壊れた対・`contestedWithId` の残骸・勝者の無い superseded が 0件。`conflict`／`conflicted` だけが出た。**陽性対照**: 同じ探り棒は `conflict` を数えている（上の結果）。ただし、競合を検出する「歯」としての陽性対照（壊れた実装で赤になること）は取っていない |
  | イベント | reason・actor つきで forget／purge／restoreArchived／restoreSuperseded／markContested／resolveContested 2種／resolveOrphanedContested | 両実装で一致（jsonb のキー順だけ違う）。doc の表と一致。purge の `digestSnapshot` は上書き前 |
  | NUL | `reason`・`actor.id` に NUL・孤立サロゲート・200万字 | NUL・サロゲートは両実装で同じ形（forget・purge・restoreArchived は `failed`、他は例外。書き込み0件）。200万字は通る |
  | store 直呼び | `markContestedPair`／`resolveContestedPair` に同じ id（大文字違い含む）・存在しない id・uuid でない id、`updateStatus(…'contested')` | Postgres は `RangeError`／`memory not found`／`ContestedWithoutCompanionError` を投げ、書き込み無し。インメモリは大文字違いを別の id として `memory not found` |
