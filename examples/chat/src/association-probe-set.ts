import type { ProbeUtterance } from "./probe-set.js";

/**
 * 連想枠専用の probe set。三角形（`query ≈ anchor` / `anchor ≈ gold` / `query ≉ gold`）で、query だけでは gold に届かず、
 * アンカーの近傍を辿れば届く状況を作る。`hit@10` は連想枠の効果を測れない（gold は11位以降に現れる）ので、
 * `goldReturned`/`goldRank`/`mrr` を見る。
 *
 * `ASSOCIATION_PROBES` の中身は逐語で、1文字も変えない。三角形の条件を実測した対象そのものだから。
 * `name-meeting` は `maxCount=10` でも gold を返さない。原因は確かめていない。
 * 場を弱める方向の変更（recallLimit を下げる等）はしない。
 */
export interface AssociationProbe {
  id: string;
  category: "ascii-id" | "proper-noun" | "common-noun";
  bridge: string;
  query: string;
  anchor: string;
  gold: string;
  distractor: string;
}

export const ASSOCIATION_PROBES: AssociationProbe[] = [
  {
    id: "ascii-project",
    category: "ascii-id",
    bridge: "PROJ-1234",
    query: "いま担当している案件の資料を、取引先へ共有してよいか確認したいです。",
    anchor: "いま担当している案件は PROJ-1234 です。",
    gold: "PROJ-1234 には顧客名を伏せる守秘義務が付いています。",
    distractor: "取引先とのやりとりは必ずCCに上長を入れます。",
  },
  {
    id: "ascii-printer",
    category: "ascii-id",
    bridge: "EP-880A",
    query: "自宅のプリンタで年賀状を刷る準備をしています。何が要りますか?",
    anchor: "自宅のプリンタは EP-880A です。",
    gold: "EP-880A に通せるのは厚さ0.3mmまでです。",
    distractor: "年賀状の宛名は毎年おなじ名簿から作っています。",
  },
  {
    id: "ascii-camera",
    category: "ascii-id",
    bridge: "SDXC",
    query: "運動会で使うカメラの準備で、買い足すものはありますか?",
    anchor: "使っているカメラの記録媒体は SDXC です。",
    gold: "SDXC は exFAT なので古い機器では読めないことがあります。",
    distractor: "運動会は来月の第2土曜です。",
  },
  {
    id: "ascii-router",
    category: "ascii-id",
    bridge: "WXR-5950",
    query: "自宅のネットが夜だけ遅くなります。心当たりはありますか?",
    anchor: "自宅のルーターは WXR-5950 です。",
    gold: "WXR-5950 の2.4GHz帯は近隣の無線と干渉しやすいです。",
    distractor: "自宅の回線は光の1ギガ契約です。",
  },
  {
    id: "name-meeting",
    category: "proper-noun",
    bridge: "田中さん",
    query: "来週火曜の打ち合わせに向けて、準備しておくことはありますか?",
    anchor: "来週の火曜日、田中さんと新規案件の打ち合わせがあります。",
    gold: "田中さんは甲殻類アレルギーがあります。",
    distractor: "打ち合わせの議事録は共有ドライブに置く決まりです。",
  },
  {
    id: "name-trip",
    category: "proper-noun",
    bridge: "シンガポール",
    query: "今月末の出張の準備で、残っている手続きはありますか?",
    anchor: "今月末にシンガポールへ出張します。",
    gold: "シンガポールは入国時点で残存有効期間が6か月ないと入れません。",
    distractor: "出張の精算は帰着から2週間以内に出します。",
  },
  {
    id: "name-bank",
    category: "proper-noun",
    bridge: "ひまわり銀行",
    query: "来月の家賃の引き落としについて確認しておきたいです。",
    anchor: "家賃はひまわり銀行の口座から引き落としています。",
    gold: "ひまわり銀行は月末が土日だと翌営業日の処理になります。",
    distractor: "家賃は毎月8万円です。",
  },
  {
    id: "name-gift",
    category: "proper-noun",
    bridge: "佐野さん",
    query: "上司の退職祝いに何を贈るか決めたいです。",
    anchor: "退職される上司は佐野さんです。",
    gold: "佐野さんは3年前からお酒を断っています。",
    distractor: "退職祝いは部署の全員でお金を出し合います。",
  },
  {
    id: "noun-car",
    category: "common-noun",
    bridge: "父の車",
    query: "週末に実家へ帰ります。何か気をつけることはありますか?",
    anchor: "実家へ帰るときは父の車を借りています。",
    gold: "父の車は高さ制限のある立体駐車場に入りません。",
    distractor: "実家には週末しか誰もいません。",
  },
  {
    id: "noun-medicine",
    category: "common-noun",
    bridge: "カルシウム拮抗薬",
    query: "毎朝の習慣で、見直したほうがよい点はありますか?",
    anchor: "毎朝、カルシウム拮抗薬を飲んでいます。",
    gold: "カルシウム拮抗薬はグレープフルーツで効きが強くなります。",
    distractor: "毎朝6時に起きて犬の散歩へ行きます。",
  },
  {
    id: "noun-laptop",
    category: "common-noun",
    bridge: "会社支給のノートPC",
    query: "出先で仕事をするとき、持ち物で足りないものはありますか?",
    anchor: "仕事では会社支給のノートPCを持ち歩いています。",
    gold: "会社支給のノートPCはUSB-Cで65W以上ないと充電できません。",
    distractor: "出先では社内網へVPNで入る決まりです。",
  },
  {
    id: "noun-apartment",
    category: "common-noun",
    bridge: "木造アパート",
    query: "引っ越してから、近所付き合いで気をつけることはありますか?",
    anchor: "先月、木造アパートの2階へ引っ越しました。",
    gold: "木造アパートは床の遮音等級が低い造りです。",
    distractor: "引っ越しの段ボールがまだ半分残っています。",
  },
];

export interface AssociationBridgeViolation {
  index: number;
  text: string;
  bridge: string;
  probeId: string;
}

/**
 * 各 probe の `bridge` が、その probe の anchor と gold にだけ現れることを検査する。
 * 他の発話に漏れると gold が別経路で引けてしまい、「連想枠が効いた」のではなく「設計が漏れていた」ことになる。
 * 文字列ではなく `ProbeUtterance` を受け取るのは、どの発話がどの probe の anchor/gold かを構造で判定するため。
 */
export function findAssociationBridgeViolations(
  utterances: readonly ProbeUtterance[],
): AssociationBridgeViolation[] {
  const violations: AssociationBridgeViolation[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    utterances.forEach((utterance, index) => {
      const isOwnAnchorOrGold =
        utterance.probeId === probe.id &&
        (utterance.kind === "anchor" || utterance.kind === "gold");
      if (isOwnAnchorOrGold) {
        return;
      }
      if (utterance.text.includes(probe.bridge)) {
        violations.push({ index, text: utterance.text, bridge: probe.bridge, probeId: probe.id });
      }
    });
  }
  return violations;
}

/**
 * probe ごとに人手で拾った query の内容語（3〜5語）。`ASSOCIATION_PROBES` から自動導出しない。
 * 部分文字列一致にすると助詞・助動詞まで混じり、検査として機能しなくなる。probe を足したらここにも足すこと。
 */
export const ASSOCIATION_QUERY_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "ascii-project": ["担当", "案件", "資料", "取引先", "共有"],
  "ascii-printer": ["自宅", "プリンタ", "年賀状", "準備"],
  "ascii-camera": ["運動会", "カメラ", "準備", "買い足す"],
  "ascii-router": ["自宅", "ネット", "夜", "遅く"],
  "name-meeting": ["来週", "火曜", "打ち合わせ", "準備"],
  "name-trip": ["今月末", "出張", "準備", "手続き"],
  "name-bank": ["来月", "家賃", "引き落とし", "確認"],
  "name-gift": ["上司", "退職祝い", "贈る"],
  "noun-car": ["週末", "実家", "気をつける"],
  "noun-medicine": ["毎朝", "習慣", "見直し"],
  "noun-laptop": ["出先", "仕事", "持ち物", "足りない"],
  "noun-apartment": ["引っ越し", "近所付き合い", "気をつける"],
};

export interface AssociationQueryLeakViolation {
  probeId: string;
  keyword: string;
  gold: string;
}

export function findAssociationQueryLeakViolations(): AssociationQueryLeakViolation[] {
  const violations: AssociationQueryLeakViolation[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    const keywords = ASSOCIATION_QUERY_KEYWORDS[probe.id] ?? [];
    for (const keyword of keywords) {
      if (probe.gold.includes(keyword)) {
        violations.push({ probeId: probe.id, keyword, gold: probe.gold });
      }
    }
  }
  return violations;
}

export function associationGoldExternalId(probeId: string): string {
  return `assoc-gold-${probeId}`;
}

export function associationAnchorExternalId(probeId: string): string {
  return `assoc-anchor-${probeId}`;
}

export function associationDistractorExternalId(probeId: string): string {
  return `assoc-distractor-${probeId}`;
}

export function associationHaystackExternalId(index: number): string {
  return `assoc-filler-${String(index).padStart(4, "0")}`;
}

/**
 * この probe 集合専用の haystack（60件）。`./probe-set.js` の `buildHaystackUtterance` を使わない。
 * テンプレート生成の60文は互いに極めて似た1つの密なクラスタになり（cos 中央値 0.854）、連想枠が
 * アンカー近傍をプールするとき、haystack がプールを埋め尽くして設計した anchor→gold の枝を押し出す。
 * 既存の4 probe 集合は近傍をプールしないので、`buildHaystackUtterance` を使い続ける。
 */
export const ASSOCIATION_HAYSTACK: readonly string[] = [
  "冷蔵庫の製氷機の水を週に一度替えている。",
  "定期券の期限は三月末までだ。",
  "図書館で借りた本は二週間後に返す。",
  "妹が四月から大学院に進む。",
  "日曜の朝にシーツを洗う。",
  "玄関の電球が切れかけている。",
  "去年の健康診断で特に指摘はなかった。",
  "母はラジオ体操に通っている。",
  "傘立てに傘が三本ある。",
  "コーヒー豆は近所の焙煎所で買う。",
  "町内会の当番は半年ごとに回ってくる。",
  "包丁を年に一度研ぎに出す。",
  "空気入れは物置にしまってある。",
  "テレビをほとんど見なくなった。",
  "弟が来年から名古屋に住む。",
  "洗濯は夜のうちに回して朝に干す。",
  "近所のパン屋は水曜が定休日だ。",
  "小学校の学芸会は秋にある。",
  "父は将棋の教室に通っている。",
  "庭のミントが増えすぎて困っている。",
  "年末に窓を全部拭く。",
  "郵便受けの鍵をひとつ失くした。",
  "旅行の写真を整理しないまま溜めている。",
  "髪は二か月に一度切りに行く。",
  "換気扇の掃除が苦手だ。",
  "駅前の書店が先月閉まった。",
  "目覚ましは六時に鳴らす。",
  "ゴミ出しは月曜と木曜だ。",
  "祖母は手紙を書くのが好きだ。",
  "夏は麦茶を作り置きする。",
  "押し入れの布団を春に干した。",
  "近くの公園に大きな桜がある。",
  "靴下ばかり片方なくなる。",
  "味噌汁の出汁は煮干しでとる。",
  "自転車の鍵を二重にかけている。",
  "去年の冬は一度も雪が積もらなかった。",
  "風呂の追い焚きをよく使う。",
  "観葉植物に水をやりすぎて枯らした。",
  "眼鏡のつるが緩んできた。",
  "好きな作家の新刊が来月出る。",
  "弁当箱は食洗機に入れられない。",
  "手すりに埃が溜まりやすい。",
  "山登りの靴を十年使っている。",
  "電池は単三ばかり買い置きしている。",
  "飼っている金魚が三匹いる。",
  "味の濃い料理が苦手になった。",
  "玄関マットを新しくした。",
  "定規をどこに置いたか忘れた。",
  "紅茶はミルクを入れずに飲む。",
  "掃除機の紙パックを月初に替える。",
  "手帳は毎年同じ型を使う。",
  "隣町の温泉に年に二度行く。",
  "鍋の焦げ付きを重曹で落とす。",
  "パスワードを紙に書かないようにしている。",
  "折りたたみ傘をよく車内に忘れる。",
  "実験的な料理をして家族に不評だった。",
  "早起きしても二度寝することが多い。",
  "新聞紙は月末にまとめて出す。",
  "窓際に置いた本が日に焼けた。",
  "靴の修理を商店街の店に頼んだ。",

  // 以下の2文は、該当 probe の query と話題が近く、その probe の bridge 語を持たない。境界にいた gold を11位以降へ押し下げる。
  // 大量には足さない。haystack が連想枠のプールを占領する再発を避けるため、押し下げる最小限に留める。
  "担当している別件の見積もりをまだ作成していません。", // ascii-project の query(案件)と話題が近い。bridge(PROJ-1234)は含まない。
  "来週、大阪への出張の日程を変更しました。", // name-trip の query(出張)と話題が近い。bridge(シンガポール)は含まない。
];

export const ASSOCIATION_HAYSTACK_SIZE = ASSOCIATION_HAYSTACK.length;

export function buildAssociationProbeSetConversation(
  haystackSize: number = ASSOCIATION_HAYSTACK_SIZE,
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    utterances.push({
      externalId: associationAnchorExternalId(probe.id),
      text: probe.anchor,
      kind: "anchor",
      probeId: probe.id,
    });
    utterances.push({
      externalId: associationGoldExternalId(probe.id),
      text: probe.gold,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: associationDistractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const haystackUtterances: ProbeUtterance[] = [];
  for (let i = 0; i < haystackSize; i += 1) {
    haystackUtterances.push({
      externalId: associationHaystackExternalId(i),
      text: ASSOCIATION_HAYSTACK[i % ASSOCIATION_HAYSTACK.length]!,
      kind: "haystack",
    });
  }

  const bridgeViolations = findAssociationBridgeViolations([...utterances, ...haystackUtterances]);
  if (bridgeViolations.length > 0) {
    throw new Error(
      "buildAssociationProbeSetConversation: bridge が anchor/gold の外へ漏れている" +
        `(${bridgeViolations.length}件): ${JSON.stringify(bridgeViolations.slice(0, 5))}`,
    );
  }

  const queryLeakViolations = findAssociationQueryLeakViolations();
  if (queryLeakViolations.length > 0) {
    throw new Error(
      "buildAssociationProbeSetConversation: query の内容語が gold に漏れている" +
        `(${queryLeakViolations.length}件): ${JSON.stringify(queryLeakViolations.slice(0, 5))}`,
    );
  }

  utterances.push(...haystackUtterances);
  return utterances;
}
