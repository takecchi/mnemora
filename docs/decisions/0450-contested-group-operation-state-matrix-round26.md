# ADR 0450: contested の群（`markContestedGroup`・`resolveContestedGroup`）の「操作 × 状態」の行列を当てた（穴探し26巡目。直す線に当たる穴は0件）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー）の委譲先が書いた。**文書だけの ADR で、コードは1行も変えていない。**
目的は、次の担当が同じ面を当て直さずに済むこと。ADR 0447（23巡目。2者の対と単独の口の行列）の続きで、同じ作法で群の口を当てた。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探し26巡目。面は `Runtime.markContestedGroup`・`Runtime.resolveContestedGroup` と、それを受ける `MemoryStore.markContestedGroup?`・`resolveContestedGroup?`（Postgres 実装と testkit のインメモリ実装）の、メンバーの状態 × 操作。
  ADR 0327（決定4: 完全グラフ）・0378・0381・0401・0431 が決めた形と、forget したメンバーで群が解消できなくなる点（0381 決定10）は既知として扱い、**そこは見直さない**（群の大きさや `memory_relations` の行の形を変える直しは、この巡の線の外）。

  【実測】手元の Postgres 17（UTF8、`C.UTF-8`）と testkit のインメモリ実装の両方に、使い捨ての探り棒（vitest 1ファイル。コミットしていない）で当てた。
  各セルで、返り値の `outcome`、操作の前後の各メンバーの `status`・`contestedWithId`・`supersededById`・`purgedAt`、`memory_events` の件数と `meta`、`memory_relations`（`contradicts`）の相手の集合を取った。

  **結論: TSDoc と遷移表がはっきり約束している形から外れたセルは、Runtime の口では0件だった。直す線に当たる穴は無い。**
  材料にとどめるものは、`MemoryStore` の口を直接呼んだときだけ起きる（下の「引き受けた負債」）。

  **陽性対照**（「出なかった」を、事象が無いことの証明にしないため）:
  1. 書き込みが起きるセルで、探り棒は状態・イベント・関係の行の変化を捉えた（例: `markContestedGroup` → 全員 `contested` と関係の行、`resolveContestedGroup` → 関係の行が空）。
  2. 同時実行の検査器（下）は、壊れた状態を**わざと作って**検出できることを確かめた。`updateStatus` を直接呼んで `contested_with_id` の残骸（`STALE`）・対の片側だけ active（`PAIR-BROKEN`）・contested が archived へ辺を持つ（`LEAK`）を作ると、20回の試験で `STALE`=20・`PAIR-BROKEN`=20・`LEAK`=70 と数えた。壊さない実走では、この3種は0件だった。
  3. 競合が実際に重なっていることも数えた（`conflict` の結果が60回中、resolve で59回・forget で59回、など。下の表）。

- **決めたこと**:

  1. **コードも文書の約束も変えない。** 当てた範囲で、Runtime の口は約束どおりだった。
  2. **次の担当は、下の「当てた形」の表の面を当て直さない。** 面を広げるなら、「測っていないこと」から始める。
  3. **材料は「引き受けた負債」に緊急度つきで残す。** どれも新しく断る入力を増やす直しで、オーナーの領分（【判断】）。

- **検討した代替案**:

  1. **探り棒を conformance の歯として足す。** 採らなかった。測った振る舞いは既存の歯（`contested-pair-lock-order-concurrency.postgres.test.ts`、`contested-group-*.postgres.test.ts`、conformance の群の項など）と重なる。実装を変えないので、直す前に赤を見せる作法も満たせない。
  2. **負債を store の口で断る直しにして出す。** 採らなかった。約束が書かれておらず、今は成功して状態が変わる入力を新しく断ることになる。

- **引き受けた負債**（`MemoryStore` を直接呼ぶと起きる。Runtime の口は常に正しい形で渡す。【実測】両実装で同じ）:

  | # | 再現 | 結果 | 緊急度 |
  |---|---|---|---|
  | 1 | `resolveContestedGroup` の `members[]` で `status:'superseded'` に `supersededById` を付けない | `superseded_by_id=NULL` の敗者ができ、`restoreSuperseded` の群に入らず戻せない（23巡目の負債3の群版） | 低。Runtime は常に勝者を渡す |
  | 2 | 同じ口で `supersededById` に自分自身、または群の外の `forgotten` な記憶を指定。`status:'active'` に `supersededById` を付ける | 自己置換、forgotten な勝者への置換、active なのに `superseded_by_id` が残る行ができる（実在しない・別テナントの id は ADR 0439 が断る） | 低 |
  | 3 | 同じ口で型の外の `status:'forgotten'`・`'contested'` を渡す | 通る。`forgotten` はイベントつきで書かれる。`contested` は関係の行が消えた `contestedWithId=NULL` の単独 contested になる | 低。型の外の入力 |
  | 4 | `markContestedGroup`・`resolveContestedGroup` の `members[].event` の `memoryId` を別のメンバーの id にする | イベントはその別のメンバーの監査ログに積まれ、本来のメンバーのログは0件。例: B のイベントとして A のイベントを渡すと、A が2件・B が0件になる | 低。doc は「渡された event をそのまま積む」と明記済み |
  | 5 | `updateStatus(A, 'active')`（`expectedStatus` 省略）を contested な群のメンバー A に直接呼ぶ | A は active のまま `memory_relations` の辺を残し、残りのメンバーは A を相手に contested のまま。残り全員を `resolveContestedGroup` すれば解消できる（A は「今も contested」でないので到達集合に入らない）が、辺は消えず B・C・D に A への行が残る | 低。23巡目の負債1の群版。doc は「省略時は常に更新」 |

  ほかに、既に別の ADR が記録している設計を、探して再確認しただけのもの（新規ではない）:
  - forget・purge したメンバーへの関係の行は消えない（ADR 0381 決定10）。残りを解消しても、解消した側に forgotten なメンバーへの行が残る。
  - 3件の群のメンバーを1人 forget すると、残る2人は `resolveContestedGroup`（3件未満で `RangeError`）でも `resolveContested`（`pair_broken`）でも `resolveOrphanedContested`（`no_contested_with_id`）でも解けない（`resolveOrphanedContested` は `ineligible`。この ADR で測ったのは `ineligible` までで、`eligibility.kind` の中身は読んでいない）。別の active の記憶と3件以上の群へ入れ直す（`markContestedGroup`）ことは受け付けられた（【実測】）。入れ直したあとに解消まで通るかは測っていない（ADR 0381 が既知として記録）。
  - 既存の群の1人（`contestedWithId` が無い contested）を渡した `markContestedGroup` は、その群の他の人が渡す集合に居なくても受け付ける。新しいメンバーと結ばれ、群は辺でつながるが「完全グラフ」にはならない。以後の解消は全員を渡す必要がある（呼び出し側の責務。`MemoryStore.markContestedGroup` の契約3）。
  - `reason`・`actor.id` に NUL・孤立サロゲートを含めると、両操作とも例外を投げ（Postgres は `DrizzleQueryError`、インメモリは `memory_events.… must not contain NUL …`）、何も書かれない（ADR 0446 の `markContested`・`resolveContested` と同じ形）。
  - 大文字小文字だけ違う id を同じ呼び出しに混ぜると、Runtime は `ineligible`（`not_found`）にする（`memoryLookupKeyFor` の doc）。store を直接呼ぶと Postgres は `RangeError: member ids must be unique`（インメモリは `memory not found`）。

- **これが覆るとしたら**:

  - 負債1〜3・5: オーナーが `MemoryStore` の状態書き込みに不変条件の検査を持たせると決めたとき（ADR 0447 の負債1・3・4・5と同じ判断にまとめられる）。
  - 負債4: `NewMemoryEvent` の `memoryId`・`tenantId` を store が引数の id・`ctx` と突き合わせると決めたとき。

- **測ったこと**（【実測】2026-10-01、Postgres 17、UTF8（`C.UTF-8`）、testkit のインメモリ実装）:

  - **測っていないこと**（未測定。次の巡の入口）: 実在する大きな群（数百〜数万メンバー）の書き込み時間と辺の数（ADR 0401・0431 が測った範囲より外）、`observe` の claim key 検出（`detectContested`）から群が結ばれる経路、`recall` の群の同伴取得の段3、複数プロセス・複数接続プール、SQL_ASCII の DB。

- **当てた形**（探して問題が無かった点。Postgres と testkit のインメモリ実装の両方。使い捨ての試験。群のメンバーは A, B, C, D…、他は X, Y, Z）:

  | 面 | 入力 | 結果 |
  |---|---|---|
  | mark × メンバーの状態 | [M, A, B] で M が active／既存の群の一員（他の人は外）／contested の対の片方（相方は外）／同（相方は内）／superseded／archived／forgotten／purged／contested で単独（`contestedWithId` 無し） | active と、既存の群の一員・相方が内の対・単独 contested は `contested_group`（吸収・合併）。相方が外の対・superseded・archived・forgotten・purged は `ineligible`（`status_conflict`）、書き込み0件 |
  | mark × 件数・重複 | 2件、同じ id の重複、`[A, 大文字A, B]`、`[A, 大文字A, B, C]` | Runtime: 2件・重複は `RangeError`、大文字違いは `ineligible`（`not_found`）。書き込み0件 |
  | mark × id | 別テナント、実在しない uuid、uuid でない文字列、NUL 入り、3件全部が大文字（Postgres は `contested_group`、インメモリは `not_found`） | 例外なし（`ineligible` か `contested_group`）、書き込み0件 |
  | mark × 繰り返し・合併 | 同じ群をもう一度、群＋新規 D・E、群の全員＋ D | 2回目は `contested_group` で変化なし。合併・拡張は辺がつながる（完全グラフにはならない） |
  | resolve × メンバーの状態 | 4人の群で A が contested／active／superseded／archived／forgotten／purged × `both_active`・B 勝ち・A 勝ち | contested のときだけ `resolved`（全員 `active`、または勝者以外が `superseded`＋`supersededById`、関係の行が空）。それ以外は `ineligible`（`status_not_contested`）、書き込み0件 |
  | resolve × 部分・欠け | 4人の群の3人だけを渡す／A が forgotten の群の残り3人を渡す／3人の群の A を forget して残り2人を渡す | 欠けた contested が居れば `ineligible`（`missingMembers`）。欠けが forgotten なら `resolved`（forgotten への辺は残る）。2人は `RangeError` |
  | resolve × 勝者 | 群の外の記憶、大文字の勝者、全員の id が大文字 | 群の外は `RangeError`。Postgres は大文字の勝者・全員大文字も同じ記憶として `resolved`、インメモリは `RangeError`・`not_found`（既知の設計） |
  | resolve × 対・群の混在 | 3人の群 ＋ 2人の対（全員5人）／対の2人＋群の1人 | 全員を渡すと `resolved`（対の `contestedWithId` も消える）。対の2人＋群の1人だけでは `ineligible`（`missingMembers`） |
  | resolve × 繰り返し | 同じ群を2回、別テナントの `ctx` | 2回目は `ineligible`（`status_not_contested:active`）。別テナントは `not_found` |
  | resolve → restore | 群を B 勝ちで解いて `restoreSuperseded(B)` | 敗者3人が active に戻る。戻した後に関係の行は無い |
  | 群 × 他の口 | 3人の群の A を forget して `resolveContested(B, C)`／`resolveOrphanedContested(B)`／`markContestedGroup([B, C, D])` | `pair_broken`／`no_contested_with_id`（`ineligible`）／`contested_group`（B・C は D と結ばれる） |
  | forget・purge × 群 | 群の1人を forget、purge して残りを解消 | 解消できる（forgotten・purged への辺は残る）。purged の辺は消えない |
  | 件数 | 3・65535・70000・140000 件の実在しない uuid | バインド上限の崖なし。全員 `not_found` の `ineligible`、例外なし |
  | NUL | `reason`・`actor.id` の NUL・孤立サロゲート | 例外（両実装）、書き込み0件。`markContestedGroup`・`resolveContestedGroup` とも |
  | イベント | reason・actor つきの mark（4人）と resolve（B 勝ち／both_active） | 全員1件ずつ。`meta` は doc どおり（`reason`・`note`・`resolution`・敗者の `supersededById`。`contestedWithId` は無い）。両実装で一致（`supersededById` の綴りだけ id の形が違う）。新規に群へ入ったメンバーにだけ mark のイベント（ADR 0431） |
  | store 直呼び | `markContestedGroup`: 2件／重複／`[A, 大文字A, B]`／実在しない id／別テナント／群の外に `contestedWithId` を持つ メンバー。`resolveContestedGroup`: 2件／`[A, 大文字A, B, C]`／`supersededById` が実在しない・別テナント | 2件・重複は `RangeError`（Postgres は大文字違いも同じ `RangeError`、インメモリは `memory not found`）、実在しない・別テナントは `memory not found`、群の外に相方が居れば `MemoryStatusConflictError`。書き込み0件 |
  | 同時実行 | 9人の記憶（4人の群 + 5人）に、14操作を同時に撃った（`markContestedGroup` を重なる3通り、`resolveContestedGroup` を2通り、forget・purge・`markContested`・`resolveContested`・`sweepArchive`・`restoreSuperseded`）。60回と、20回（わざと壊した陽性対照つき） | 壊さない実走（60回）は例外0、`failed` 0、`contestedWithId` の残骸0、対の片側だけ0、contested が active・archived などへ辺を持つ0、辺の非対称0、勝者の無い superseded 0。`conflict`／`ineligible` が出た（`resolveContestedGroup` の2操作は `conflict` 59・58回、`markContestedGroup` の `[D,E,G]` と `[G,F,E]` は32・33回）。陽性対照（わざと壊した20回）は上のとおり検出した |
