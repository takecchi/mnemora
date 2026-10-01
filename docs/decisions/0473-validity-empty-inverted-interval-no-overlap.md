# ADR 0473: 空の区間・逆転した区間の記憶を、claim key の「有効期間が重なる」から外す・有効期間と見る口の境界を当てた記録（穴探し44巡目）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-3a4ae979）の委譲先が書いた。面は「記憶の有効期間（`validFrom`/`validUntil`）と、それを見る口の境界」で、クローン miku が「面はマネージャーが選んでよい」とした。直し方は担い手が前例（ADR 0381 の「実際に重なる組」）に当てて決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。材料に回したものは「材料」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  有効期間の境界（左端は含む、右端は含まない）を、`recall()` の門（core の `classifyValidity`）・Postgres の SQL・testkit の InMemory・core の Fake の4者が同じ側に倒すかを当てた。あわせて、区間どうしの重なり（`findActiveByClaimKey?`・`findContestedByClaimKey?`）を、空の区間・逆転した区間で当てた。

  避けた面: 今日の 0441〜0472 の面と、指示に挙がった面（CHANGELOG・migration-v1 の棚卸し、複数プロセス、テナント境界、孤立サロゲート、conformance の約束、footprint、digest、構造化出力、`subjectId` とプロトタイプのキー名、timestamptz の範囲外を型付き例外に包む話＝ADR 0456 の M2）。開いている PR（#1576・#1577・#1579・#1580）の面とも重ならない。

  手元の PostgreSQL 17（UTF8、`C.UTF-8`、ポート 56260）に、使い捨ての探り棒（vitest。`zz-` で始まる名前で、commit していない）を当てた。

- **当てた形と結果**（【実測】2026-10-01）:

  | 形 | 当てた場所 | 結果 |
  | --- | --- | --- |
  | 区間の重なり: 普通・空（`[5,5)`）・逆転（`[9,1)`）の保存済みの行 × 普通・空・逆転・両端 null・片端 null の問い合わせ | `findActiveByClaimKey?` を Postgres と testkit の InMemory に | **穴あり（H1）**。2実装とも同じ結果 |
  | 同じ形を `Runtime.observe`（`claimKey: { detectContested: true }`）から | core の Fake | **穴あり（H1）**。有効な1件目と、空・逆転した区間の2件目の両方が `contested` になった |
  | 境界: `validFrom === at`・`validFrom = at+1ms`・`validUntil === at`・`validUntil = at±1ms`・空（`at`,`at`）・逆転・両端 null | `recall()`（`channels` を `ann` のみ・`lexical` のみ）を Postgres と InMemory に、`validAt` を5通り（`at`・年60・紀元前50年・西暦10000年・省略＝今）で。記憶13件 | **2実装が、返る記憶の集合も `omitted` の `expired`/`not_yet_valid` の件数も同じ**。陽性対照: `validAt = at` で `validFrom === at` は返り、`validUntil === at` と `validUntil = at-1ms` は返らず、`validUntil = at+1ms` は返る（探り棒は境界の左右を分けて見えている） |
  | 年0〜99・紀元前・西暦10000年 | 上の表の同じ探り棒（`validFrom`/`validUntil` に年50・年99・紀元前100年・西暦10000年を入れた記憶を作り、`recall()` の絞りを見る） | 2実装が同じ。読み戻した値そのものは比べていない（絞りの結果が同じだった、という範囲）。`validAt` に年60・紀元前50年・西暦10000年を渡した絞りも同じ |
  | `findActiveByClaimKey?` の重なりの式 | Postgres・InMemory・Fake の3か所の式を読む | 3か所とも同じ式（`a1 < b2 AND a2 < b1`、null は ∓∞） |
  | 抽出で LLM が返す `validFrom`/`validUntil` | `extraction.ts`・`@mnemora/openai`・`@mnemora/anthropic` を `validFrom`/`valid_` で grep | **LLM は期間を返さない**【現物】。`ExtractedMemoryCandidateSchema` に欄が無く、`extraction.ts` は `observation.validFrom ?? null` を写すだけ。「日付だけ・タイムゾーン無し・不正な文字列」の形はこの面に存在しない（呼び出し側が `Date` で渡す。`z.date()` が Invalid Date を弾くことは既存の `observation-invalid-date.postgres.test.ts` が縛る） |
  | `validAt` の既定（今）と明示 | `recall-runtime.ts` の `validAt ?? now`、`recall-validity.test.ts` を走らせた | 既定は `clock.now()`。既存の歯は緑 |
  | consolidate・reflect の積 | `validity.ts` の `intersectValidity`、`consolidate-reflect-validity-intersection.test.ts`・`consolidate-validity-gate.test.ts`・`reflect-validity-gate.test.ts` を走らせた | 読みと既存の歯が緑。TSDoc の「空の積は起こらない」は、`classifyValidity` を通った材料だけを渡す呼び出し側の契約の下で成り立つ（読んで確かめた。壊す入力は作れなかった）。**当たった範囲での結果であり、断定ではない** |

- **見つけた穴と、決めたこと**:

  1. **H1: 空の区間（`validFrom === validUntil`）・逆転した区間（`validFrom > validUntil`）の記憶が、同じ claim key の有効な記憶と「有効期間が重なる」として矛盾（`contested`）を作る。**
     【現物】interface の doc（`findActiveByClaimKey?`）は「半開区間 `[validFrom, validUntil)` として扱い、重ならない行は返さない」と約束している。3実装の式 `a1 < b2 AND a2 < b1` は、両方の区間が空でないときだけ半開区間の重なりと一致する。空・逆転した区間（点を1つも含まない集合）には、何とでも「重なる」と答える。
     【実測】（Postgres・InMemory、claim key が同じ3行: 普通 `[2020,2030)`・空 `[2025,2025)`・逆転 `[2029,2021)`）直す前は、問い合わせが空の区間（`[2025,2025)`）でも普通の行が返り、保存済みの空・逆転した行は、両端 null の問い合わせにも普通の区間の問い合わせにも返った。Runtime では、両端 null の有効な1件目の後に、逆転した区間（`2029`〜`2021`）・空の区間（`2025`〜`2025`）の2件目を `observe` すると、**どちらも `contested` になった**（1件目の `status` が `active` → `contested`、`contestedWithId` は2件目）。陽性対照: 普通の区間の2件目は、直す前も直した後も `contested` になる。
     **直し**: 3か所（`packages/postgres/src/memory-store.ts` の2つの口、testkit の InMemory の2つの口、core の Fake の2つの口）に、問い合わせの区間と保存済みの行の区間の両方が「空でない（`from === null || until === null || from < until`）」を足した。
     **線**: 【判断】前例のある同種の穴＝約束（interface の doc の「半開区間として扱い、重ならない行は返さない」と、ADR 0381 決定1・ADR 0324 決定4の「実際に重なる組・重なりは矛盾の必要条件」）に実装を戻す直し。**断る入力は増えない**（空・逆転した区間の `observe` は、Issue #1042 のとおり拒まない）。`contested` になる組が減る向きだけに効く。保存済みのデータは書き換えない。
     `markContestedGroup?` が群の中の組に行を張る判定（ADR 0381。`memory-store.ts` の自己結合・InMemory の `overlaps`・Fake の `overlaps`）は**変えていない**。理由: 呼び出し側（`Runtime`）が群に渡すのは、直した `findActiveByClaimKey?` が返した行と、いま作った記憶（空でないと、1件でも返った時点で分かる）だけなので、空・逆転した区間は群に入らない。一方、store を直接呼んで空・逆転した区間を群に入れると、同じ条件を足した場合は組が張れず、`contested` なのに対の行が無い記憶ができうる（`is-contested-without-companion` が見る形。**これは式を読んだ推測で、実測していない**）。今のままなら、その入力にも対の行が張られる。

- **材料（オーナーの領分。直していない）**:

  - **M1: マイクロ秒の精度の `valid_until` を持つ行が、`recall()` で黙って落ちる。**【実測】（Postgres 17、`valid_until` を生の SQL で `validAt` の0.5ms後・0.999ms後にした1件。`validAt` を渡して `recall`、ann・lexical の両チャンネル）`PostgresVectorStore`・`PostgresLexicalStore` の SQL（`valid_until > validAt`、マイクロ秒のまま比べる）は通すが、`parsePgTimestamp` が小数秒を3桁に切り捨てるので、core の `survivesValidityGate` が読む `validUntil` は `validAt` と等しくなり、`validUntil <= validAt` で落とす。**返る記憶は0件で、`omitted` も空（`expired` に数えられない）**。陽性対照: 1.5ms 後は返る（切り捨てた値が `validAt` の1ms後で、`validAt` より後）。ちょうど `validAt` は `omitted` に `filtered(expired)` が1件立つ（SQL の集計と一致）。
    到達できる入力: mnemora の書き込み口は `Date`（ミリ秒）しか書かない（ADR 0427 の前提）ので、**mnemora の外から行を書く経路（直接の SQL・別のクライアント）だけが当たる**。直し方の候補は、SQL 側を `date_trunc('milliseconds', valid_until)` で比べる（保存済みのデータの読み方が変わる）・`parsePgTimestamp` を切り上げる（他の列の比較の意味まで変わる、ADR 0427 の代替案2が退けた形）・`omitted` に数える。どれも保存済みのデータの読み方か件数の意味が変わるので、直していない。`valid_from` の側は、SQL が先に落とすので黙って減る形は作れなかった（確かめたのは `valid_until` だけで、`valid_from` のマイクロ秒は測っていない）。
  - **M2: `RecallQuery.validAt` の TSDoc の「実質非破壊」（この欄を足した PR の時点の話）が、今は事実と合わない。**今は `observe()` が `validFrom`/`validUntil` を書くので、既定（`now`）でも期限切れの記憶が落ちる。**これは文書だけの直しで、この PR で直した**（TSDoc に ⚠ の追記。元の文は残した）。
  - **M3: 空・逆転した区間を `observe` の入力の段で拒む案**は採っていない（Issue #1042 の判断のまま。新しい種類の入力を断る方針はオーナーの領分）。H1 は、拒まないまま矛盾を作らなくするだけの直しである。

- **歯と、赤→緑の実測**（【実測】2026-10-01。`DATABASE_URL` は手元の Postgres 17）:

  | 歯 | 直す前（直した3つの実装ファイルを `git show HEAD:<path>` の版に置き換えて実行） | 直した後 |
  | --- | --- | --- |
  | `packages/postgres/src/__tests__/claim-key-empty-interval-no-overlap.postgres.test.ts`（20本。Postgres と InMemory の2実装 × active/contested の2口 × 5本） | 16本が赤（問い合わせ側が空・逆転、保存済みの行が空・逆転、の各4本 × 4）。陽性対照の4本は緑 | 20本緑 |
  | `packages/core/src/__tests__/claim-key-empty-interval-not-contested.test.ts`（3本。core の Fake を通した `Runtime.observe`） | 2本が赤（空の区間・逆転した区間の2件目）。陽性対照（普通の区間の2件目が `contested`）は緑 | 3本緑 |

  赤の確認のあと、`cp` で退避しておいた直した版へ戻し、同じ歯が緑に戻ることまで見た（`git checkout` は使っていない）。

  直した後に走らせた既存の歯（すべて緑）: `packages/postgres/src/__tests__/conformance.postgres.test.ts` を `-t "findActiveByClaimKey|findContestedByClaimKey|markContestedGroup|有効期間|validFrom|validAt"` に絞って23本（616本は skipped）、`mapping-valid-from-until.test.ts`・`mapping-observation-valid-from-until.test.ts`・`observation-invalid-date.postgres.test.ts` の14本、core の `recall-validity`・`consolidate-reflect-validity-intersection`・`consolidate-validity-gate`・`reflect-validity-gate`・`fake-memory-store-valid-from-until` の各 test の35本、testkit の `in-memory-fixtures-invalid-date`・`in-memory-query-invalid-values` の18本。
  **走らせていないもの**: core の claim key 系の既存の歯（`claim-key-*.test.ts` など）と、testkit の conformance を InMemory に当てる歯。名指しされたファイルの外なので走らせなかった（`runtime-fakes.ts` の Fake を直したので、CI がそれらを走らせる）。

- **検討した代替案**:

  1. **`markContestedGroup?` の組の判定にも同じ条件を足す。**採らなかった。上のとおり、直接呼びでは対の行の無い `contested` を作りうる。`Runtime` の経路では、直した `find` が空・逆転した区間を群に入れない。
  2. **空・逆転した区間を `observe` の入力で拒む。**採らなかった（M3）。
  3. **保存済みの空・逆転した行の `contested` を戻す（`resolveOrphanedContested` のような掃除）。**採らなかった。保存済みのデータの書き換えで、オーナーの領分。この直しの前に作られた `contested` の対は、そのまま残る。

- **引き受けた負債**:

  - この直しの前に、空・逆転した区間の記憶との間で作られた `contested` の対は残る（遡って戻さない）。`resolveContested` で解く道は今までどおり。
  - `markContestedGroup?` の組の判定の式と、`find*` の式が、空・逆転した区間について食い違ったままになる（上の理由。直接呼びだけの食い違い）。
  - M1（マイクロ秒の `valid_until`）は直していない。

- **これが覆るとしたら**:

  - オーナーが「空・逆転した区間の記憶も、期間の外側にあるだけで、同じ claim key の相手とは矛盾しうる」と決めたとき。H1 を戻す。
  - オーナーが空・逆転した区間を入力の段で拒む（M3）と決めたとき。H1 の直しは、その手前で重なるだけで害は無い。
