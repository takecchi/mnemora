# ADR 0453: embed ジョブと reinforce の「操作 × 状態」の行列を当てた（穴探し27巡目。直す線に当たる穴は0件）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先の委譲先が書いた。**文書だけの ADR で、本番のコードは1行も変えていない。**
目的は、次の担当が同じ面を当て直さずに済むこと。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**:

  穴探し27巡目。[ADR 0447](./0447-lifecycle-operation-state-matrix-round23.md)（23巡目）が「測っていないこと」に残した
  `tick` の embed ジョブ × 各状態を入口にした。あわせて、遷移表（`docs/memory-model.md` §11）の行3（embed）と行4（reinforced）を、
  active 以外の出発に当てた。この2行は `packages/core/src/__tests__/lifecycle-transition-table.ts` が
  「状態もイベントも動かず、結ぶ先の観測が無い」としてマスから外していた。ADR 0447 の13操作にも `reinforce` は無い。

  除外: 26巡目（ADR 0450。contested の群）、24巡目（testkit の provider・savepoint）、open PR #1558（ADR 0449。bullmq）、
  20巡目・ADR 0428 の abort、ADR 0447 が当てた13操作。
  contested は**1行の状態としてだけ**扱った（`markContested(T, P)` で対を作り、T にだけ embed・reinforce を当てる。
  `resolveContested`・群の操作・片側の forget には触れない）。

  【実測】手元の Postgres 17（UTF8、`C.UTF-8`）と testkit のインメモリ実装の**両方**に、使い捨ての探り棒（vitest 4ファイル（testkit 2・postgres 1・local-embedding 1）。
  コミットしていない）で、同じ行列を当てた。各セルで、返り値、操作の前後の `status`・`purgedAt`・`content`・`embeddingStatus`・
  `lastReinforcedAt`・`decayFloorAt`、vector の行（`VectorStore.getVectors`）、`memory_events`・`recall_usages` の件数、
  outbox のジョブの終端、provider に渡った文字列を取った。時刻の絶対値を伏せた diff は、**79セルで両実装が一致した**。

  **結論: 約束がはっきり書かれているのに外れたセルは、0件だった。直す線に当たる穴は無い。**
  材料にとどめる件は、下の「引き受けた負債」の7件。どれも、直すと今は成功している入力・結果を変える。

  **陽性対照**（「出なかった」を、事象が無いことの証明にしないため）:

  - 探り棒は、書き込みが起きるセルで変化を確かに捉えた。例: active の reinforce は `lastReinforcedAt`・`decayFloorAt` が動き、
    embed ジョブは `pending → ready` と vector 1行を書く。forgotten の embed も同じ形で書く（これが下の負債1）。
  - **変異試験**: `processEmbedJob` の末尾の「purge 済みなら書いた埋め込みを消す」（`deps.vectorStore.delete`。#1035 / ADR 0124 追記）を
    `cp` で退避してから消して core を build し直すと、割り込みのセルのうち `purge` を `get` の前・provider の中・upsert の入口に
    当てた3つが **vector 1行を残して赤く**なり（`ready` の書き込みの前・読み直しの前は、purge 自身の削除が後に来るので0行のまま）、
    purged の記憶へ走る embed ジョブの4セルも1行残した。既存の歯 `purge-during-embed-job.postgres.test.ts` も2件とも赤くなった。
    戻して build し直すと、同じ歯の2件は緑に戻った。
  - したがって、purge の10セルが「vector 0行」と出たのは、探り棒が見えなかったからではない。

- **決めたこと**:

  1. **コードも文書の約束も変えない。** 当てた範囲で実装は約束どおりだった。
  2. **次の担当は、下の「当てた形」の表の面を当て直さない。** 面を広げるなら、「測っていないこと」から始める。
  3. **材料7件は「引き受けた負債」に緊急度つきで残す。** どれも「今は成功する入力を新しく断る」か「データの扱いを遡って決める」直しで、
     オーナーの領分（【判断】）。
  4. **探り棒は歯として足さない。** 測った振る舞いは既存の歯（`purge-during-embed-job.postgres.test.ts`、
     `erase-tenant-during-embed-job.postgres.test.ts`、`reinforce-*`、`record-usage-and-reinforce.postgres.test.ts`、
     `requeue-embed-jobs-atomicity.postgres.test.ts` など）と重なる。歯が赤になる実装が先に無く、直す前に赤を見せる作法を満たせない。

- **検討した代替案**:

  1. **forgotten の記憶の embed ジョブを、provider を呼ばずに完了させる。** 採らなかった。今は成功して `ready` と vector を書く入力の結果を変える。
     さらに、すでに `forgotten` のまま `ready`・vector 1行の記憶（遡ったデータ）をどうするかが絡む。
  2. **reinforce を active・contested に絞る。** 採らなかった。#840 が「絞らない」で閉じた判断を覆す。
     `Runtime.observe({kind:'memory_usage'})` が今は成功を返す入力を断るか、無言で落とすことになる。
  3. **dispose の後は、読み込みの再試行を打ち切る。** 採らなかった（(Q) の件。負債7）。`warmup()` が成功で返っていた場合が失敗に変わる。

- **引き受けた負債**（再現はどれも `Runtime`・store の公開の口だけで起こせる）:

  | # | 再現 | 結果 | 緊急度 |
  | --- | --- | --- | --- |
  | 1 | 記憶を `forget` した後（purge 前）に、積まれたままの embed ジョブを `tick` する。forget の前に始まっていても、後に始まっても同じ | provider が forgotten の本文を埋め込み、vector 1行と `embeddingStatus: ready` を書く。ジョブは完了。**recall には出ない**（forgotten の4セルすべて、recall は0件。段1・段3.5 の status の絞りと後置検査）。`purge` すれば行は消える（`forget → tick → purge` で vector 1 → 0）。archived・superseded でも同じ形で、約束は書かれていない | 下の「被害の形」を見ること。**低〜中**（【判断】） |
  | 2 | `purge` の後に、積まれたままの embed ジョブを `tick` する | `get` が返すのはトゥームストーン（`content` = `[purged]`）で、provider（と `embeddingInput` フック）にその文字列が渡る。upsert の後、読み直しで purged を見て vector を消す。`embeddingStatus` は `ready` になる。残るものは無い。外へ出る文字列はトゥームストーンだけ | 低。ただし provider への呼び出しは1回無駄になる |
  | 3 | `reinforce`・`reinforceMany`・`recordUsageAndReinforce`・`Runtime.observe({kind:'memory_usage'})` を、purged の記憶に当てる | 4つの口とも `lastReinforcedAt`・`decayFloorAt` を書き換える（`status` は `forgotten` のまま、`purgedAt`・`content` は不変、`memory_events` は0件）。`MemoryStore.reinforce` の TSDoc（#840）は active・contested・archived・superseded・forgotten を書くが、**purged は書いていない**（forgotten と同じ形で読める） | 低。`recall` の結果は変わらない（忘却ゲートは forgotten の列を読まない）。読めるのは `get` で直接読んだときだけ |
  | 4 | embed ジョブ（`pending` で積まれた）が残っている active・contested の記憶に `reembed({statuses:['pending']})` | 2本目の embed ジョブが積まれる（`jobsAdded: 1`）。2本とも走れば provider を2回呼ぶ。upsert は上書きなので結果は同じ | 低。`reembed` の TSDoc は「積み直すだけ」と書いており、重複の抑止は約束していない |
  | 5 | `failed`（または `skipped`）の記憶を archived・superseded にして、`restoreArchived`・`restoreSuperseded` で active に戻す | 戻った記憶は `embeddingStatus` が `failed` のまま。embed ジョブは増えず、`tick` は何もしない（`processed: 0`）。`reembed({statuses:['failed']})` が active の間だけ拾う（out の間は拾わない。ADR 0079 の約束）。`recall` は `not_indexed`・`reason: "failed"`・`countKind: "exact"` と名乗るので、黙ってはいない | 低 |
  | 6 | embed ジョブが `fail` した後の状態は、`reembed` を呼ぶまで戻らない（既知。`processEmbedJob` の TSDoc） | 上の5と同じ | 既出。新規ではない |
  | 7 | (Q) `LocalEmbeddingProvider.warmup()` の読み込みが再試行の待ちの最中・2回目の試行の最中のときに `dispose()` を呼ぶ | `dispose()` は読み込みの決着まで返らず、**dispose の要求の後にも残りの試行が走る**（`createPipeline` が2回目・3回目で呼ばれる。実モデルなら取得が走る）。最後に成功すれば、1回だけ解放される（漏れない）。`warmup()` は成功で返る。全試行が失敗すれば、`dispose()` は reject せず、`warmup()` が reject する | 低。ADR 0419 の約束（「読み込み中なら終わるのを待つ」）には反しない |

  **被害の形（負債1。forgotten の記憶でも embed して vector と ready を書く）**

  【実測】forgotten の4セル（出発の `embeddingStatus` が pending・failed・ready・skipped）と、`forget` を割り込ませた5セル
  （`get` の前・provider の中・upsert の入口・`ready` の書き込みの前・読み直しの前）の、両実装の結果:

  | 見る場所 | 結果 |
  | --- | --- |
  | **recall** | 出ない。vector 1行がある状態でも、`recall` は forgotten を返さなかった（active は同じ問いで返った。これが対照） |
  | **export** | **この名前の公開の口は、`@mnemora/core` にも `@mnemora/postgres` にも無い**（`grep -rn "exportMemories\|exportTenant" packages/core/src packages/postgres/src` で当たらなかった。網羅の主張はしない）。読み出しの口は `MemoryStore.get`・`getMany` で、forgotten の行は embed と無関係に、`purge` されるまで `content` ごと読める。embed が足すのは `embeddingStatus: ready` と vector の行だけ |
  | **索引（vector）** | 行が1つ残る。`VectorStore.getVectors` が返し、`VectorStore.search` は `filter.status` を省くと当てる（archived・superseded も同じ）。`Runtime.recall` は status で絞るので出ない |
  | **索引（lexical・trigram）** | 影響しない。どちらも `memories` の列（tsvector・trigram）を読み、embed の結果を持たない（`grep -n memory_embeddings packages/postgres/src/lexical-store.ts packages/postgres/src/trigram-lexical-store.ts` は0件） |
  | **provider** | **一番大きいのはここ**。`forget` の後に始まった embed ジョブは、forgotten の本文を外部の provider（OpenAI など）へ送る。`purge` しても外へ出たものは戻らない。実測で、`get` の前に forget を割り込ませたセルも、provider へ本文（`marker`）が渡った |
  | **戻し** | `Runtime` の口に、forgotten を active へ戻すものは無い（`restoreArchived` は `status_not_archived`。ADR 0447）。したがって vector が残ることで、戻したときに索引が既にある、という得は今は無い |

  緊急度は **低〜中**（【判断】）。理由: recall・既存の読み出しの口には出ず、`purge` で行は消えるので、保存データの面は小さい。
  **provider への送出は取り消せない**ので、「forget した内容を外部に送らない」を利用者が期待しているなら、約束と実装の間に隙が在る。
  その期待が約束かどうかは文書に無い（【未確認】`forget` の TSDoc・ADR 0087 の本文は、この件のためには読み直していない）。
  直すなら、forgotten・purged の記憶の embed ジョブを、provider を呼ばずに完了させる形になる。**断る入力は増えない**が、
  遡ったデータ（`forgotten` のまま `ready` の行と vector）の扱いと、`embeddingStatus` を `pending` のまま残すのかという意味の決めが要る。
  **データ保持の判断なのでオーナーの領分。**

- **これが覆るとしたら**:

  - 負債1・2: オーナーが「forgotten・purged の記憶には embed しない」を約束にすると決めたとき。
  - 負債3: オーナーが「`MemoryStore.reinforce` は active・contested だけ書く」「purged 行は書かない」を store の約束にすると決めたとき（ADR 0447 負債2 と同じ線）。
  - 負債4: `reembed` が既に pending のジョブを持つ記憶を飛ばすと決めたとき。
  - 負債5: restore が `embeddingStatus` を見て embed ジョブを積み直すと決めたとき。
  - 負債7: dispose の後は読み込みを打ち切ると決め、`warmup()` が reject してよいと決めたとき。

- **測ったこと**（【実測】2026-10-01、Postgres 17、UTF8（`C.UTF-8`）、testkit のインメモリ実装。時刻の絶対値を伏せた diff は79セルで空）:

  - **測っていないこと**（未測定。次の巡の入口）: `embeddingProvider` の space を替えた後の embed（別の space の行）、
    複数プロセスが同じジョブを取るときの embed（ADR 0142 の CAS は `complete`・`fail` 側。embed の upsert の重複は冪等のはず）、
    `tenant_settings.decay_clock` が `activity`・`either` のときの reinforce（`nowSeq`・`addOwnSubjectSeq` の軸。`reinforce-many-equivalence.postgres.test.ts` が見ている）、
    SQL_ASCII の DB、実モデル（`live.*`）での `LocalEmbeddingProvider`、`processEmbedJob` の `ready` の書き込みが失敗した後の状態
    （`embed-job-ready-write-fails.test.ts` が見ている）、`reembed` の `limit` の境界（ADR 0433）。

- **当てた形**（探して問題が無かった点。Postgres と testkit のインメモリ実装の両方）:

  | 面 | 入力 | 結果 |
  | --- | --- | --- |
  | embed ジョブ × 状態 × 出発の `embeddingStatus`（B。24セル） | 6状態（active・contested・superseded・archived・forgotten・purged）× 出発（pending・failed・ready・skipped）。ジョブは積まれたまま、状態を変えてから `tick(kinds:['embed'])` | 全セルでジョブは `done`、`failed: 0`。`embeddingStatus` は `ready`。vector は purged 以外で1行、purged で0行（読み直しで消す）。`memory_events` は0件。recall に出るのは active・contested だけ。purged は provider にトゥームストーンを渡す（負債2） |
  | embed ジョブの最中の forget・purge（C。10セル） | 止める地点5（`get` の前・provider の中・upsert の入口・`ready` の書き込みの前・読み直しの前）× {forget、forget → purge} | 全セルでジョブは `done`。forget は vector 1行が残る（負債1）。purge は全地点で vector 0行。`embeddingStatus` は `ready`（purge は触らない。ADR 0124 追記の約束どおり） |
  | forget → tick → purge（E。1セル） | forgotten の間に書かれた vector | purge で 1 → 0 |
  | reinforce の4つの口 × 状態（A。24セル） | `reinforce`・`reinforceMany`・`recordUsageAndReinforce`・`Runtime.observe(memory_usage)` × 6状態 | 全24セルで `lastReinforcedAt`・`decayFloorAt` が動く。`status`・`purgedAt`・`content` は不変、`memory_events` は0件。`recall_usages` は `recordUsageAndReinforce`・`observe` だけが1行を書く。#840・ADR 0303 決定2・ADR 0041 と一致（purged は負債3） |
  | `reembed` × 状態 × 出発（D。18セル） | 6状態 × {pending、failed、skipped}。failed は実際にジョブを落として作った | active・contested だけ積み直される（`embeddingStatus` が `pending` に戻り、ジョブが1本増える）。superseded・archived・forgotten・purged は0件（ADR 0079 決定のとおり）。pending は負債4 |
  | restore の後の索引（R1。2セル） | `failed` のまま archived・superseded → `restoreArchived`・`restoreSuperseded` | 負債5 |
  | (Q) `LocalEmbeddingProvider` の外縁 | 再試行の待ち・2回目の試行・全試行失敗の最中の `dispose()`、上流の `dispose` の reject、別インスタンスの並行の初回、`createPipeline` と `options.sleep` の注入（実モデルは取っていない） | 解放は1回だけで漏れない。上流の `dispose` の reject は、2回目の `dispose()` も同じ reject を返し、以後の `embed` は断る。別インスタンスは、それぞれ1回ずつ読み込む。残りは負債7 |

  **注意（探り棒の限界）**: セルは1回ずつ走らせた。同時実行の繰り返し（0447 の「40回」のような）は、C の割り込みを障壁で止めた決定的な形にして、代えた。
  競合を検出する歯としての陽性対照は、上の変異（読み直しの delete を消す）で取った。その窓の外（複数プロセス）は測っていない。
