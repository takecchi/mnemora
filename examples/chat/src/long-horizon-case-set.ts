/**
 * `long-horizon` ベンチのケース集合: 半年分の時間軸の上に、植える事実（gold）・同じ話題の紛らわしい記憶（distractor）・
 * 雑談（filler）を並べる。`new Date()` も実行ごとに変わる乱数も混ぜない（同じコードからは同じ時間軸が出る）。
 *
 * ⚠ ここにある事実・問い・雑談は、このベンチのために書いた合成データであり、実運用の会話の分布ではない。
 */

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

/**
 * 時間軸の起点。⚠ 実時刻より十分前に置く: 埋め込みの outbox は DB の `now()` を読むので、ベンチは埋め込みを処理する間だけ
 * `Clock` を実時刻へ進める（`embed-drain.ts`）。模擬期間の終わりが実時刻より未来だと、その往復で時刻が逆行する。
 */
export const LONG_HORIZON_T0 = new Date("2026-01-05T00:00:00.000Z");

export const LONG_HORIZON_DAYS = 180;

/** 測る時点（起点からの日数）。各日の正午に問う。 */
export const LONG_HORIZON_CHECKPOINT_DAYS: readonly number[] = [7, 30, 45, 60, 90, 120, 150, 180];

export const LONG_HORIZON_FILLERS_PER_DAY = 15;

/** 訂正の新しい側を植える日。 */
export const LONG_HORIZON_CORRECTION_DAY = 90;

/** 常用の事実が話題に出る間隔（日）。 */
export const LONG_HORIZON_HABITUAL_INTERVAL_DAYS = 7;

export function atDay(day: number, hour = 0): Date {
  return new Date(LONG_HORIZON_T0.getTime() + day * MS_PER_DAY + hour * MS_PER_HOUR);
}

/**
 * - `habitual`: 定期的に話題に出る（使用報告ありの条件では、出るたびに recall して載せた記憶を報告する）。
 * - `dormant`: 植えた後は一度も話題に出ない。
 * - `correction`: 0日目に古い値、{@link LONG_HORIZON_CORRECTION_DAY} 日目に新しい値を植える。gold は新しい側。
 */
export type LongHorizonFactClass = "habitual" | "dormant" | "correction";

export interface LongHorizonFact {
  id: string;
  factClass: LongHorizonFactClass;
  /** gold。`correction` では新しい側。 */
  content: string;
  /** `correction` だけが持つ、0日目に植える古い側。 */
  supersededContent?: string;
  question: string;
  /** 同じ話題で値が違う記憶。 */
  distractor: string;
  distractorDay: number;
}

export const LONG_HORIZON_FACTS: readonly LongHorizonFact[] = [
  // --- 常用 ---
  {
    id: "habitual-daughter-name",
    factClass: "habitual",
    content: "この人の娘の名前は「さくら」で、小学三年生だ。",
    question: "娘さんの名前は何でしたっけ？",
    distractor: "同僚の娘さんは「ひなた」という名前らしい。",
    distractorDay: 23,
  },
  {
    id: "habitual-cat-name",
    factClass: "habitual",
    content: "飼っている猫の名前は「モチ」。白い雄猫で五歳。",
    question: "飼っている猫の名前は？",
    distractor: "隣の家の犬は「ハチ」という柴犬だ。",
    distractorDay: 41,
  },
  {
    id: "habitual-workplace",
    factClass: "habitual",
    content: "横浜の物流会社に勤めていて、倉庫の在庫管理を担当している。",
    question: "どこで何の仕事をしているんでしたっけ？",
    distractor: "大学時代の友人は東京の広告代理店で営業をしている。",
    distractorDay: 57,
  },
  {
    id: "habitual-morning-run",
    factClass: "habitual",
    content: "毎朝、近所の川沿いを5キロ走るのが日課になっている。",
    question: "毎朝の運動の習慣は何ですか？",
    distractor: "妻は週末だけヨガ教室に通っている。",
    distractorDay: 74,
  },
  {
    id: "habitual-favorite-author",
    factClass: "habitual",
    content: "好きな作家は宮部みゆきで、新刊が出ると必ず買う。",
    question: "好きな作家は誰でしたっけ？",
    distractor: "書店の店員に東野圭吾の新刊を勧められた。",
    distractorDay: 96,
  },
  {
    id: "habitual-car",
    factClass: "habitual",
    content: "乗っている車は青いフォレスターで、キャンプに使っている。",
    question: "乗っている車は何ですか？",
    distractor: "義理の兄が白いプリウスに買い替えた。",
    distractorDay: 113,
  },
  {
    id: "habitual-tomato",
    factClass: "habitual",
    content: "趣味はベランダでのミニトマト栽培で、毎年夏に収穫している。",
    question: "家でやっている趣味の栽培は何でしたっけ？",
    distractor: "母は庭でバラを育てている。",
    distractorDay: 131,
  },
  {
    id: "habitual-mother-sapporo",
    factClass: "habitual",
    content: "母親は札幌で一人暮らしをしていて、毎週日曜に電話している。",
    question: "お母さんはどこに住んでいますか？",
    distractor: "叔母は仙台の老人ホームに入居した。",
    distractorDay: 148,
  },
  // --- 休眠 ---
  {
    id: "dormant-shellfish-allergy",
    factClass: "dormant",
    content: "エビやカニなど甲殻類のアレルギーがあり、食べると蕁麻疹が出る。",
    question: "食べられない食材やアレルギーはありますか？",
    distractor: "息子の友達は卵アレルギーだと聞いた。",
    distractorDay: 19,
  },
  {
    id: "dormant-blood-type",
    factClass: "dormant",
    content: "血液型はAB型。",
    question: "血液型は何型でしたっけ？",
    distractor: "健康診断の結果、妻はO型だと分かった。",
    distractorDay: 37,
  },
  {
    id: "dormant-anniversary",
    factClass: "dormant",
    content: "結婚記念日は11月3日で、毎年小さな旅行をする。",
    question: "結婚記念日はいつですか？",
    distractor: "友人夫婦の結婚記念日は6月だそうだ。",
    distractorDay: 52,
  },
  {
    id: "dormant-trombone",
    factClass: "dormant",
    content: "高校時代は吹奏楽部でトロンボーンを吹いていた。",
    question: "学生時代の部活では何の楽器をやっていましたか？",
    distractor: "甥っ子が中学でサックスを始めた。",
    distractorDay: 68,
  },
  {
    id: "dormant-acrophobia",
    factClass: "dormant",
    content: "高所恐怖症で、観覧車やロープウェイには乗れない。",
    question: "苦手なもの、怖いものはありますか？",
    distractor: "娘は暗いところが怖いと言っている。",
    distractorDay: 87,
  },
  {
    id: "dormant-passport",
    factClass: "dormant",
    content: "パスポートの有効期限は2029年3月まで。",
    question: "パスポートの有効期限はいつまででしたっけ？",
    distractor: "運転免許の更新のお知らせが届いた。",
    distractorDay: 104,
  },
  {
    id: "dormant-left-handed",
    factClass: "dormant",
    content: "左利きで、ハサミは左利き用を使っている。",
    question: "利き手はどちらですか？",
    distractor: "娘は右利きで、箸の持ち方を練習中だ。",
    distractorDay: 122,
  },
  {
    id: "dormant-shrine",
    factClass: "dormant",
    content: "実家の近くの神社は白山神社で、初詣は毎年そこに行く。",
    question: "初詣にはどこの神社に行くんでしたっけ？",
    distractor: "会社の近くに八幡神社がある。",
    distractorDay: 139,
  },
  // --- 訂正 ---
  {
    id: "correction-residence",
    factClass: "correction",
    supersededContent: "川崎市の中原区に住んでいる。",
    content: "川崎から福岡市に引っ越した。今は福岡市の博多区に住んでいる。",
    question: "今はどこに住んでいますか？",
    distractor: "弟は大阪市に住んでいる。",
    distractorDay: 33,
  },
  {
    id: "correction-phone",
    factClass: "correction",
    supersededContent: "スマホはiPhoneを使っている。",
    content: "スマホをiPhoneからPixelに替えた。今はPixelを使っている。",
    question: "今使っているスマホは何ですか？",
    distractor: "父は今でもガラケーを使っている。",
    distractorDay: 61,
  },
  {
    id: "correction-gym",
    factClass: "correction",
    supersededContent: "駅前のスポーツジムに週二回通っている。",
    content: "駅前のジムは退会して、今は市民プールで週二回泳いでいる。",
    question: "今、運動はどこでしていますか？",
    distractor: "妹はボクシングジムに通い始めた。",
    distractorDay: 79,
  },
  {
    id: "correction-project",
    factClass: "correction",
    supersededContent: "仕事では在庫システムの刷新プロジェクトを担当している。",
    content: "在庫システムの刷新は終わり、今は新しい倉庫の立ち上げを担当している。",
    question: "仕事で今担当しているプロジェクトは何ですか？",
    distractor: "隣の部署は経理システムの移行で忙しいらしい。",
    distractorDay: 101,
  },
  {
    id: "correction-drink",
    factClass: "correction",
    supersededContent: "朝は必ずブラックコーヒーを飲む。",
    content: "カフェインを控えることにして、朝はコーヒーをやめて緑茶にした。",
    question: "朝は何を飲んでいますか？",
    distractor: "職場の自販機に新しい紅茶が入った。",
    distractorDay: 118,
  },
  {
    id: "correction-lesson",
    factClass: "correction",
    supersededContent: "週末は陶芸教室に通っている。",
    content: "陶芸教室はやめて、週末はボルダリングジムに通っている。",
    question: "週末の習い事は何ですか？",
    distractor: "娘がピアノ教室に通い始めた。",
    distractorDay: 157,
  },
];

const FILLER_TIME_PHRASES = [
  "今朝",
  "昼休みに",
  "夕方",
  "仕事帰りに",
  "夜",
  "さっき",
  "出がけに",
  "帰り道に",
  "午前中",
  "寝る前に",
];

const FILLER_ACTIVITIES = [
  "コンビニでおにぎりを買った",
  "雨が降ってきて傘を買った",
  "駅のホームで電車が遅れていた",
  "スーパーで特売の卵を買った",
  "テレビで天気予報を見た",
  "洗濯物を取り込んだ",
  "郵便受けにチラシが入っていた",
  "ラーメン屋の行列を見かけた",
  "クリーニングを受け取った",
  "コンビニのコーヒーを飲んだ",
  "ニュースで為替の話をしていた",
  "電球が切れたので交換した",
  "部屋の掃除機をかけた",
  "バスが満員で一本見送った",
  "パン屋で食パンを買った",
  "近所で工事の音がしていた",
  "宅配便の不在票が入っていた",
  "ドラッグストアで歯磨き粉を買った",
  "公園で桜のつぼみを見た",
  "銀行のATMに並んだ",
  "冷蔵庫の中身を整理した",
  "会議の資料を印刷した",
  "スマホの充電が切れかけた",
  "ゴミ出しの日を間違えかけた",
  "駐輪場が混んでいた",
  "カレーを作り置きした",
  "図書館の返却期限を確認した",
  "靴ひもがほどけた",
  "エアコンのフィルターを掃除した",
  "道で落とし物を拾って交番に届けた",
];

const FILLER_COMMENTS = [
  "特に何もない一日だった。",
  "少し疲れた。",
  "まあまあ順調だった。",
  "いつも通りだった。",
  "思ったより時間がかかった。",
  "ちょっと面倒だった。",
  "意外とすぐ済んだ。",
  "天気は曇りだった。",
  "風が強かった。",
  "少し寒かった。",
  "なんだか眠かった。",
  "気分は悪くなかった。",
  "明日も同じ感じだろう。",
  "特に感想はない。",
  "あっという間に終わった。",
  "肩がこった。",
  "のんびりできた。",
  "少し蒸し暑かった。",
  "混んでいて疲れた。",
  "静かな日だった。",
];

/** 雑談の組み合わせの総数。模擬期間の雑談の件数がこれを超えると同じ文が繰り返す。 */
export const FILLER_COMBINATION_COUNT =
  FILLER_TIME_PHRASES.length * FILLER_ACTIVITIES.length * FILLER_COMMENTS.length;

/**
 * `index` 番目の雑談。組み合わせの空間を `FILLER_COMBINATION_COUNT` と互いに素な歩幅で巡るので、
 * 隣り合う番号が同じ活動・同じ感想に偏らず、`FILLER_COMBINATION_COUNT` 件までは重複しない。
 */
export function fillerContent(index: number): string {
  const stride = 2_347; // 6,000 と互いに素
  const k = (index * stride) % FILLER_COMBINATION_COUNT;
  const time = FILLER_TIME_PHRASES[k % FILLER_TIME_PHRASES.length]!;
  const rest = Math.floor(k / FILLER_TIME_PHRASES.length);
  const activity = FILLER_ACTIVITIES[rest % FILLER_ACTIVITIES.length]!;
  const comment = FILLER_COMMENTS[Math.floor(rest / FILLER_ACTIVITIES.length)]!;
  return `${time}${activity}。${comment}`;
}

export type LongHorizonMemoryRole = "gold" | "superseded" | "distractor" | "filler";

export interface LongHorizonMemorySeed {
  localId: string;
  role: LongHorizonMemoryRole;
  /** filler は `null`。 */
  factId: string | null;
  content: string;
  recordedAt: Date;
}

/** 模擬期間に書く記憶の全部を、記録時刻の昇順で返す。 */
export function buildLongHorizonMemorySeeds(
  facts: readonly LongHorizonFact[] = LONG_HORIZON_FACTS,
  days: number = LONG_HORIZON_DAYS,
  fillersPerDay: number = LONG_HORIZON_FILLERS_PER_DAY,
): LongHorizonMemorySeed[] {
  const seeds: LongHorizonMemorySeed[] = [];
  for (const fact of facts) {
    if (fact.factClass === "correction") {
      if (fact.supersededContent === undefined) {
        throw new Error(`buildLongHorizonMemorySeeds: 訂正の事実 "${fact.id}" に古い側が無い。`);
      }
      seeds.push({
        localId: `${fact.id}:superseded`,
        role: "superseded",
        factId: fact.id,
        content: fact.supersededContent,
        recordedAt: atDay(0, 9),
      });
      seeds.push({
        localId: `${fact.id}:gold`,
        role: "gold",
        factId: fact.id,
        content: fact.content,
        recordedAt: atDay(LONG_HORIZON_CORRECTION_DAY, 9),
      });
    } else {
      seeds.push({
        localId: `${fact.id}:gold`,
        role: "gold",
        factId: fact.id,
        content: fact.content,
        recordedAt: atDay(0, 9),
      });
    }
    seeds.push({
      localId: `${fact.id}:distractor`,
      role: "distractor",
      factId: fact.id,
      content: fact.distractor,
      recordedAt: atDay(fact.distractorDay, 10),
    });
  }
  let fillerIndex = 0;
  for (let day = 0; day < days; day += 1) {
    for (let i = 0; i < fillersPerDay; i += 1) {
      // 8時から22時のあいだに均等に散らす。
      const hour = 8 + (14 * (i + 0.5)) / fillersPerDay;
      seeds.push({
        localId: `filler:${fillerIndex}`,
        role: "filler",
        factId: null,
        content: fillerContent(fillerIndex),
        recordedAt: atDay(day, hour),
      });
      fillerIndex += 1;
    }
  }
  seeds.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  return seeds;
}

/** 常用の事実が話題に出る時刻（{@link LONG_HORIZON_HABITUAL_INTERVAL_DAYS} 日ごとの20時。0日目は除く）。 */
export function habitualMentionTimes(days: number = LONG_HORIZON_DAYS): Date[] {
  const times: Date[] = [];
  for (
    let day = LONG_HORIZON_HABITUAL_INTERVAL_DAYS;
    day <= days;
    day += LONG_HORIZON_HABITUAL_INTERVAL_DAYS
  ) {
    times.push(atDay(day, 20));
  }
  return times;
}

export function checkpointTime(day: number): Date {
  return atDay(day, 12);
}
