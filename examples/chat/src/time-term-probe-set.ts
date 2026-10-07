/**
 * ペアの2件の本文を厳密に同一にし、`similarity` を構成上ぴったり同じにして、順位差を `freshness` 由来としか説明できない状況を作る。
 * 既存 `probe-set.ts` とは逆に、`fact` と `query` の語彙をわざと重ねる（ペアの2件が確実に recall に返ることが要で、どう引けたかは測る対象ではない）。
 */
export interface TimeProbe {
  id: string;
  fact: string;
  query: string;
  newerDaysAgo: number | null;
  olderDaysAgo: number | null;
  newerRecordedDaysAgo?: number;
  olderRecordedDaysAgo?: number;
}

/** 8件の probe。`fact` は先頭40字が probe 間で衝突しないようにする（`DeterministicLLMProvider` が digest を先頭40字で切るため）。 */
export const TIME_PROBES: TimeProbe[] = [
  {
    id: "half-life",
    fact: "毎週日曜の朝、ベランダの多肉植物に水をやることにしています。",
    query: "ベランダの多肉植物への水やりはどれくらいの頻度でしていますか?",
    newerDaysAgo: 0,
    olderDaysAgo: 30,
  },
  {
    id: "realistic",
    fact: "通勤電車の中で英単語アプリを開いて毎日十個ずつ覚えています。",
    query: "通勤電車での英単語アプリの勉強はどんな感じですか?",
    newerDaysAgo: 1,
    olderDaysAgo: 4,
  },
  {
    id: "same-occurred-at",
    fact: "週末は近所のジムでキックボクシングのクラスに参加しています。",
    query: "近所のジムのキックボクシングのクラスにはどれくらい通っていますか?",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
  },
  {
    id: "absent",
    fact: "自宅の本棚を整理してミステリー小説だけを一段にまとめました。",
    query: "自宅の本棚のミステリー小説はどんな風に並べていますか?",
    newerDaysAgo: null,
    olderDaysAgo: null,
  },
  {
    id: "far-past",
    fact: "毎朝出勤前にベランダで育てているハーブの葉を摘んでいます。",
    query: "ベランダで育てているハーブについて教えてください。",
    newerDaysAgo: 1,
    olderDaysAgo: 365,
  },
  // `decay` の起点は `occurredAt` を読まないので、`occurredAt` は newer/older で揃え、`freshness` をペア内で厳密に同じにする。
  {
    id: "decay-half-life",
    fact: "週に一度、水槽の熱帯魚に専用のエサを多めにあげています。",
    query: "水槽の熱帯魚へのエサやりの頻度を教えてください。",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
    newerRecordedDaysAgo: 0,
    olderRecordedDaysAgo: 30,
  },
  {
    id: "decay-realistic",
    fact: "毎晩お風呂上がりに白い毛糸でマフラーを編んでいます。",
    query: "白い毛糸で編んでいるマフラーの進み具合はどうですか?",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
    newerRecordedDaysAgo: 1,
    olderRecordedDaysAgo: 4,
  },
  {
    id: "decay-same-recorded-at",
    fact: "週末の午後に習字教室で楷書の練習をしています。",
    query: "習字教室での楷書の練習はどれくらい続けていますか?",
    newerDaysAgo: 7,
    olderDaysAgo: 7,
    newerRecordedDaysAgo: 1,
    olderRecordedDaysAgo: 1,
  },
];

export function newerExternalId(probeId: string): string {
  return `newer-${probeId}`;
}

export function olderExternalId(probeId: string): string {
  return `older-${probeId}`;
}

export interface TimeProbeUtterance {
  externalId: string;
  text: string;
  probeId: string;
  member: "newer" | "older";
  occurredAt: Date | null;
  recordedAt: Date | null;
}

const MS_PER_DAY = 86_400_000;

function daysAgoToDate(now: Date, daysAgo: number | null | undefined): Date | null {
  if (daysAgo === null || daysAgo === undefined) {
    return null;
  }
  return new Date(now.getTime() - daysAgo * MS_PER_DAY);
}

export function buildTimeTermConversation(probe: TimeProbe, now: Date): TimeProbeUtterance[] {
  return [
    {
      externalId: newerExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "newer",
      occurredAt: daysAgoToDate(now, probe.newerDaysAgo),
      recordedAt: daysAgoToDate(now, probe.newerRecordedDaysAgo),
    },
    {
      externalId: olderExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "older",
      occurredAt: daysAgoToDate(now, probe.olderDaysAgo),
      recordedAt: daysAgoToDate(now, probe.olderRecordedDaysAgo),
    },
  ];
}
