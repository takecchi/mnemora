/** ペアの2件の本文を厳密に同一にし、recall の結果の違いが `validAt` ゲート由来だとしか説明できない状況を作る（`time-term-probe-set.ts` と同じ設計）。`daysAgo` は正で過去、負で未来、`null` でその境界を持たない。 */
export interface ValidityProbe {
  id: string;
  fact: string;
  query: string;
  currentValidFromDaysAgo: number | null;
  currentValidUntilDaysAgo: number | null;
  otherValidFromDaysAgo: number | null;
  otherValidUntilDaysAgo: number | null;
  otherReason: "expired" | "not_yet_valid";
  /** 過去の `validAt`（daysAgo）。その時刻では `other` が真で `current` がまだ真でないよう選ぶ。`expired` の probe だけが持つ（`not_yet_valid` に同じ検査を重複させない）。 */
  historicalValidAtDaysAgo?: number;
}

/** `fact` は先頭40字が probe 間で衝突しないようにする（`time-term-probe-set.ts` と同じ理由）。 */
export const VALIDITY_PROBES: ValidityProbe[] = [
  {
    id: "address",
    fact: "引っ越し先の郵便番号は123-4567、最寄り駅は花園町駅です。",
    query: "いまの郵便番号と最寄り駅を教えてください。",
    currentValidFromDaysAgo: 30,
    currentValidUntilDaysAgo: null,
    otherValidFromDaysAgo: 365,
    otherValidUntilDaysAgo: 30,
    otherReason: "expired",
    historicalValidAtDaysAgo: 100,
  },
  {
    id: "subscription-plan",
    fact: "有料プランはストレージ容量が500ギガバイトまで使えるプランです。",
    query: "いまの有料プランのストレージ容量はどれくらいですか?",
    currentValidFromDaysAgo: 10,
    currentValidUntilDaysAgo: null,
    otherValidFromDaysAgo: -30,
    otherValidUntilDaysAgo: null,
    otherReason: "not_yet_valid",
  },
];

export function currentExternalId(probeId: string): string {
  return `current-${probeId}`;
}

export function otherExternalId(probeId: string): string {
  return `other-${probeId}`;
}

export interface ValidityProbeUtterance {
  externalId: string;
  text: string;
  probeId: string;
  member: "current" | "other";
  validFrom: Date | undefined;
  validUntil: Date | undefined;
}

const MS_PER_DAY = 86_400_000;

function daysAgoToDate(now: Date, daysAgo: number | null | undefined): Date | undefined {
  if (daysAgo === null || daysAgo === undefined) {
    return undefined;
  }
  return new Date(now.getTime() - daysAgo * MS_PER_DAY);
}

export function buildValidityConversation(
  probe: ValidityProbe,
  now: Date,
): ValidityProbeUtterance[] {
  return [
    {
      externalId: currentExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "current",
      validFrom: daysAgoToDate(now, probe.currentValidFromDaysAgo),
      validUntil: daysAgoToDate(now, probe.currentValidUntilDaysAgo),
    },
    {
      externalId: otherExternalId(probe.id),
      text: probe.fact,
      probeId: probe.id,
      member: "other",
      validFrom: daysAgoToDate(now, probe.otherValidFromDaysAgo),
      validUntil: daysAgoToDate(now, probe.otherValidUntilDaysAgo),
    },
  ];
}

export function historicalValidAt(probe: ValidityProbe, now: Date): Date | undefined {
  return daysAgoToDate(now, probe.historicalValidAtDaysAgo);
}
