export type Suit = "c" | "d" | "h" | "s";
export type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "T"
  | "J"
  | "Q"
  | "K"
  | "A";

export interface Card {
  rank: Rank;
  suit: Suit;
}

export function cardToString(c: Card): string {
  return `${c.rank}${c.suit}`;
}

export function parseCard(s: string): Card {
  if (s.length !== 2) throw new Error(`bad card: ${s}`);
  const rank = s[0]!.toUpperCase() as Rank;
  const suit = s[1]!.toLowerCase() as Suit;
  if (!"cdhs".includes(suit)) throw new Error(`bad suit: ${s}`);
  return { rank, suit };
}

const RANK_ORDER: Record<Rank, number> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

export type HandCategory =
  | "high_card"
  | "pair"
  | "two_pair"
  | "trips"
  | "straight"
  | "flush"
  | "full_house"
  | "quads"
  | "straight_flush";

export interface HandScore {
  category: HandCategory;
  /** Tiebreaker kickers, highest first */
  kickers: number[];
}

function sortRanksDesc(ranks: number[]): number[] {
  return [...ranks].sort((a, b) => b - a);
}

/** Best 5-card score from exactly 7 cards */
export function evaluate7(hole: [Card, Card], board: Card[]): HandScore {
  const all = [...hole, ...board];
  if (all.length !== 7) {
    throw new Error("evaluate7 requires 7 cards");
  }
  let best: HandScore | null = null;
  const indices = [
    [0, 1, 2, 3, 4],
    [0, 1, 2, 3, 5],
    [0, 1, 2, 3, 6],
    [0, 1, 2, 4, 5],
    [0, 1, 2, 4, 6],
    [0, 1, 2, 5, 6],
    [0, 1, 3, 4, 5],
    [0, 1, 3, 4, 6],
    [0, 1, 3, 5, 6],
    [0, 1, 4, 5, 6],
    [0, 2, 3, 4, 5],
    [0, 2, 3, 4, 6],
    [0, 2, 3, 5, 6],
    [0, 2, 4, 5, 6],
    [0, 3, 4, 5, 6],
    [1, 2, 3, 4, 5],
    [1, 2, 3, 4, 6],
    [1, 2, 3, 5, 6],
    [1, 2, 4, 5, 6],
    [1, 3, 4, 5, 6],
    [2, 3, 4, 5, 6],
  ];
  for (const idx of indices) {
    const five = idx.map((i) => all[i]!);
    const s = evaluate5(five);
    if (!best || compareHandScore(s, best) > 0) best = s;
  }
  return best!;
}

function compareHandScore(a: HandScore, b: HandScore): number {
  const catOrder: HandCategory[] = [
    "high_card",
    "pair",
    "two_pair",
    "trips",
    "straight",
    "flush",
    "full_house",
    "quads",
    "straight_flush",
  ];
  const ca = catOrder.indexOf(a.category);
  const cb = catOrder.indexOf(b.category);
  if (ca !== cb) return ca - cb;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const ka = a.kickers[i] ?? 0;
    const kb = b.kickers[i] ?? 0;
    if (ka !== kb) return ka - kb;
  }
  return 0;
}

function generate5Combinations(n: number): number[][] {
  if (n < 5) return [];
  const out: number[][] = [];
  const pick: number[] = [];
  function dfs(start: number) {
    if (pick.length === 5) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(i);
      dfs(i + 1);
      pick.pop();
    }
  }
  dfs(0);
  return out;
}

/**
 * Best 5-card Hold'em hand from hole + community (any board length ≥ 3; needs ≥5 cards total).
 */
export function bestHandFromHoleBoard(
  hole: [Card, Card],
  board: Card[],
): HandScore | null {
  const all = [...hole, ...board];
  if (all.length < 5) return null;
  let best: HandScore | null = null;
  for (const comb of generate5Combinations(all.length)) {
    const five = comb.map((i) => all[i]!);
    const s = evaluate5(five);
    if (!best || compareHandScore(s, best) > 0) best = s;
  }
  return best;
}

const RANK_NUM_TO_LABEL: Record<number, string> = {
  14: "A",
  13: "K",
  12: "Q",
  11: "J",
  10: "10",
  9: "9",
  8: "8",
  7: "7",
  6: "6",
  5: "5",
  4: "4",
  3: "3",
  2: "2",
};

function rankLabel(n: number): string {
  return RANK_NUM_TO_LABEL[n] ?? "?";
}

/** Short label for a Made hand chip (e.g. Poker Now-style). */
export function formatHandShortLabel(score: HandScore): string {
  switch (score.category) {
    case "high_card":
      return "HIGH CARD";
    case "pair":
      return `PAIR (${rankLabel(score.kickers[0]!)})`;
    case "two_pair":
      return "TWO PAIR";
    case "trips":
      return `TRIPS (${rankLabel(score.kickers[0]!)})`;
    case "straight":
      return "STRAIGHT";
    case "flush":
      return "FLUSH";
    case "full_house":
      return "FULL HOUSE";
    case "quads":
      return "QUADS";
    case "straight_flush":
      return "STRAIGHT FLUSH";
    default:
      return "HAND";
  }
}

export function compare7(
  h1: [Card, Card],
  b: Card[],
  h2: [Card, Card],
): number {
  return compareHandScore(evaluate7(h1, b), evaluate7(h2, b));
}

function evaluate5(cards: Card[]): HandScore {
  const ranks = cards.map((c) => RANK_ORDER[c.rank]);
  const sortedRanks = sortRanksDesc(ranks);
  const bySuit: Record<Suit, Card[]> = { c: [], d: [], h: [], s: [] };
  for (const c of cards) bySuit[c.suit].push(c);
  let flushSuit: Suit | null = null;
  for (const s of Object.keys(bySuit) as Suit[]) {
    if (bySuit[s].length >= 5) flushSuit = s;
  }
  const rankCounts = countMap(ranks);
  const uniqueRanks = sortRanksDesc([...new Set(ranks)]);

  const straightHigh = bestStraightHigh(uniqueRanks);

  if (flushSuit) {
    const flushRanks = sortRanksDesc(
      bySuit[flushSuit].map((c) => RANK_ORDER[c.rank]),
    );
    const sfHigh = bestStraightHigh(flushRanks);
    if (sfHigh !== null) {
      return { category: "straight_flush", kickers: [sfHigh] };
    }
  }

  const quads = [...rankCounts.entries()]
    .filter(([, n]) => n === 4)
    .map(([r]) => r);
  if (quads.length) {
    const k = quads[0]!;
    const kicker = sortedRanks.find((r) => r !== k) ?? 0;
    return { category: "quads", kickers: [k, kicker] };
  }

  const trips = [...rankCounts.entries()]
    .filter(([, n]) => n === 3)
    .map(([r]) => r);
  const pairs = [...rankCounts.entries()]
    .filter(([, n]) => n === 2)
    .map(([r]) => r);
  if (trips.length && pairs.length) {
    const t = Math.max(...trips);
    const p = Math.max(...pairs.filter((r) => r !== t));
    return { category: "full_house", kickers: [t, p] };
  }

  if (flushSuit) {
    const flushRanks = sortRanksDesc(
      bySuit[flushSuit].map((c) => RANK_ORDER[c.rank]),
    );
    const top5 = flushRanks.slice(0, 5);
    return { category: "flush", kickers: top5 };
  }

  if (straightHigh !== null) {
    return { category: "straight", kickers: [straightHigh] };
  }

  if (trips.length === 2) {
    const hi = Math.max(...trips);
    const lo = Math.min(...trips);
    return {
      category: "full_house",
      kickers: [Math.max(hi, lo), Math.min(hi, lo)],
    };
  }

  if (trips.length) {
    const t = trips[0]!;
    const k = sortedRanks.filter((r) => r !== t).slice(0, 2);
    return { category: "trips", kickers: [t, ...k] };
  }

  if (pairs.length >= 2) {
    const ps = sortRanksDesc(pairs);
    const p1 = ps[0]!;
    const p2 = ps[1]!;
    const kicker = sortedRanks.find((r) => r !== p1 && r !== p2) ?? 0;
    return { category: "two_pair", kickers: [p1, p2, kicker] };
  }

  if (pairs.length === 1) {
    const p = pairs[0]!;
    const kickers = sortedRanks.filter((r) => r !== p).slice(0, 3);
    return { category: "pair", kickers: [p, ...kickers] };
  }

  return { category: "high_card", kickers: sortedRanks.slice(0, 5) };
}

function countMap(ranks: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of ranks) m.set(r, (m.get(r) ?? 0) + 1);
  return m;
}

/** Returns high card of straight (wheel = 5) or null */
function bestStraightHigh(uniqueSortedDesc: number[]): number | null {
  const ranks = [...new Set(uniqueSortedDesc)].sort((a, b) => b - a);
  if (ranks.includes(14)) ranks.push(1);
  for (let i = 0; i <= ranks.length - 5; i++) {
    const window = ranks.slice(i, i + 5);
    let ok = true;
    for (let j = 1; j < 5; j++) {
      if (window[j - 1]! - window[j]! !== 1) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const high = window[0]!;
      if (high === 14 && window[4] === 2) return 5;
      return high;
    }
  }
  return null;
}

const SUITS: Suit[] = ["c", "d", "h", "s"];
const RANKS: Rank[] = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
];

export function freshDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return d;
}

export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
