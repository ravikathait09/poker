import {
  type Card,
  cardToString,
  evaluate7,
  freshDeck,
  shuffle,
} from "@ganga/shared";

export type Street = "preflop" | "flop" | "turn" | "river";
export type RunItTwiceMode = "off" | "always" | "ask";

export interface HandPlayer {
  playerId: string;
  seatIndex: number;
  chips: number;
  hole: [Card, Card] | null;
  folded: boolean;
  betThisStreet: number;
  totalCommittedHand: number;
  allIn: boolean;
}

export interface SidePotDisplay {
  amount: number;
  eligiblePlayerIds: string[];
}

export interface HandPublic {
  street: Street | null;
  board: string[];
  /** Second board when the hand was run twice; empty otherwise. */
  secondBoard: string[];
  /**
   * Community cards that would have been dealt after a fold-win (rabbit hunt).
   * Empty unless the hand ended early with an incomplete board.
   */
  rabbitBoard: string[];
  pot: number;
  sidePots: SidePotDisplay[];
  currentBet: number;
  toActPlayerId: string | null;
  buttonSeat: number;
  sbSeat: number;
  bbSeat: number;
  minRaise: number;
  actingOrderPlayerIds: string[];
  lastAction?: { playerId: string; action: string; amount?: number };
  winners: { playerId: string; amount: number; hand?: string }[] | null;
  handComplete: boolean;
  /** Chips put in pot this betting street, for felt display */
  seatBets: { seatIndex: number; amount: number }[];
  /** True while contestants are deciding whether to run it twice. */
  runItTwicePending?: boolean;
  runItTwiceEligible?: string[];
  runItTwiceVotes?: { playerId: string; yes: boolean }[];
}

export interface HandSummaryPlayer {
  playerId: string;
  seatIndex: number;
  hole: [string, string] | null;
  totalIn: number;
  won: number;
  net: number;
  folded: boolean;
  handLabel: string | null;
}

export interface HandSummary {
  startedAt: Date;
  endedAt: Date;
  board: string[];
  secondBoard: string[];
  /** Undealt community cards peeked on fold-win (may be empty). */
  rabbitBoard: string[];
  pot: number;
  endedByFold: boolean;
  players: HandSummaryPlayer[];
  winners: { playerId: string; amount: number; hand?: string }[];
}

export class PokerHand {
  private deck: Card[];
  private players: Map<string, HandPlayer>;
  private order: string[];
  buttonSeat: number;
  private sbSeat: number;
  private bbSeat: number;
  private smallBlind: number;
  private bigBlind: number;
  private antePerPlayer: number;
  street: Street | null = null;
  board: Card[] = [];
  private currentBet = 0;
  private lastRaiseIncrement: number;
  private actedThisRound = new Set<string>();
  /** Index in `order` of first actor when a street begins (UTG preflop, SB post-flop, …). */
  private roundStartIdx = 0;
  /**
   * Index in `order` where we start scanning for the next player to act.
   * Must advance clockwise after each action; otherwise action "jumps back" to
   * street start and only a subset of players keep getting picked.
   */
  private actionSearchStart = 0;
  toActPlayerId: string | null = null;
  private lastAction?: { playerId: string; action: string; amount?: number };
  winners: { playerId: string; amount: number; hand?: string }[] | null = null;
  handComplete = false;
  /** Peeked remaining board after fold-win; does not affect the pot. */
  private rabbitBoard: Card[] = [];
  private secondBoard: Card[] = [];
  private runItTwiceMode: RunItTwiceMode = "off";
  private ritPending = false;
  private ritEligible: string[] = [];
  private ritVotes = new Map<string, boolean>();
  private startedAt: Date = new Date();
  private summary: HandSummary | null = null;

  constructor(
    seatPlayers: HandPlayer[],
    buttonSeat: number,
    smallBlind: number,
    bigBlind: number,
    anteAmount: number = 0,
    rng: () => number = Math.random,
    runItTwiceMode: RunItTwiceMode = "off",
  ) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.antePerPlayer = Math.max(0, Math.floor(anteAmount));
    this.lastRaiseIncrement = bigBlind;
    this.buttonSeat = buttonSeat;
    this.runItTwiceMode = runItTwiceMode;
    const occ = [...seatPlayers].sort((a, b) => a.seatIndex - b.seatIndex);
    if (occ.length < 2) throw new Error("need 2+ players");
    this.players = new Map();
    for (const p of occ) {
      this.players.set(p.playerId, {
        ...p,
        hole: null,
        folded: false,
        betThisStreet: 0,
        totalCommittedHand: 0,
        allIn: false,
      });
    }
    this.deck = shuffle(freshDeck(), rng);
    const btnSeat = Number(buttonSeat);
    const idxBtn = occ.findIndex((p) => Number(p.seatIndex) === btnSeat);
    if (idxBtn < 0) {
      throw new Error("bad_button_seat");
    }
    const n = occ.length;
    /** Heads-up: dealer posts SB and acts first preflop; other seat is BB. */
    let sbIdx: number;
    let bbIdx: number;
    if (n === 2) {
      sbIdx = idxBtn;
      bbIdx = (idxBtn + 1) % n;
    } else {
      sbIdx = (idxBtn + 1) % n;
      bbIdx = (idxBtn + 2) % n;
    }
    this.sbSeat = occ[sbIdx]!.seatIndex;
    this.bbSeat = occ[bbIdx]!.seatIndex;
    this.order = occ.map((p) => p.playerId);

    for (const id of this.order) {
      const pl = this.players.get(id)!;
      const c1 = this.deck.pop();
      const c2 = this.deck.pop();
      if (!c1 || !c2) throw new Error("deck");
      pl.hole = [c1, c2];
    }

    if (this.antePerPlayer > 0) {
      for (const o of occ) {
        this.commitChips(o.playerId, this.antePerPlayer);
      }
    }

    this.postBlinds(sbIdx, bbIdx, occ);
    this.street = "preflop";
    this.currentBet = this.bigBlind;
    this.roundStartIdx = (bbIdx + 1) % n;
    this.actionSearchStart = this.roundStartIdx;
    this.startBettingRound();
  }

  private postBlinds(
    sbIdx: number,
    bbIdx: number,
    occ: HandPlayer[],
  ): void {
    const sbId = occ[sbIdx]!.playerId;
    const bbId = occ[bbIdx]!.playerId;
    this.commitChips(sbId, this.smallBlind);
    this.commitChips(bbId, this.bigBlind);
  }

  private commitChips(playerId: string, want: number): number {
    const p = this.players.get(playerId);
    if (!p || p.folded) return 0;
    const pay = Math.min(p.chips, want);
    p.chips -= pay;
    p.betThisStreet += pay;
    p.totalCommittedHand += pay;
    if (p.chips === 0) p.allIn = true;
    return pay;
  }

  private startBettingRound(): void {
    const contenders = this.activeInHand();
    if (contenders.length <= 1) {
      this.finishHand();
      return;
    }
    if (this.allMatchedOrAllIn()) {
      this.advanceStreet();
      return;
    }
    const n = this.order.length;
    const start = ((this.actionSearchStart % n) + n) % n;
    for (let k = 0; k < n; k++) {
      const id = this.order[(start + k) % n]!;
      const p = this.players.get(id);
      if (!p || p.folded || p.allIn) continue;
      const toCall = this.currentBet - p.betThisStreet;
      if (toCall === 0 && this.actedThisRound.has(id)) continue;
      this.toActPlayerId = id;
      return;
    }
    this.advanceStreet();
  }

  /** Clockwise from actor: next index in `order` for an in-hand, not-all-in seat. */
  private setActionSearchAfter(actorId: string): void {
    const n = this.order.length;
    const at = this.order.indexOf(actorId);
    if (at < 0) return;
    for (let step = 1; step <= n; step++) {
      const j = (at + step) % n;
      const p = this.players.get(this.order[j]!);
      if (p !== undefined && !p.folded && !p.allIn) {
        this.actionSearchStart = j;
        return;
      }
    }
    this.actionSearchStart = (at + 1) % n;
  }

  private activeInHand(): HandPlayer[] {
    return [...this.players.values()].filter((p) => !p.folded);
  }

  private aliveCount(): number {
    return this.activeInHand().length;
  }

  private allMatchedOrAllIn(): boolean {
    const live = this.activeInHand();
    if (live.length === 0) return true;
    const unfrozen = live.filter((p) => !p.allIn);
    if (unfrozen.length === 0) return true;
    const bet = Math.max(...unfrozen.map((p) => p.betThisStreet));
    for (const p of live) {
      if (p.allIn) continue;
      if (p.betThisStreet < bet) return false;
    }
    for (const p of unfrozen) {
      if (!this.actedThisRound.has(p.playerId)) return false;
    }
    return true;
  }

  private advanceStreet(): void {
    if (this.handComplete || this.ritPending) return;
    for (const p of this.players.values()) {
      p.betThisStreet = 0;
    }
    this.currentBet = 0;
    this.lastRaiseIncrement = this.bigBlind;
    const live = this.activeInHand();
    if (live.length <= 1) {
      this.finishHand();
      return;
    }
    /** At most one seat can still bet — run out (optionally twice). */
    if (this.bettingIsDead(live)) {
      this.beginBoardRunOut();
      return;
    }
    if (!this.street) {
      this.finishHand();
      return;
    }
    if (this.street === "preflop") {
      this.dealBoardChunk();
      this.street = "flop";
    } else if (this.street === "flop") {
      this.dealBoardChunk();
      this.street = "turn";
    } else if (this.street === "turn") {
      this.dealBoardChunk();
      this.street = "river";
    } else {
      this.beginBoardRunOut();
      return;
    }
    const n = this.order.length;
    const btnSeat = Number(this.buttonSeat);
    const btnIdx = this.order.findIndex((id) => {
      const p = this.players.get(id);
      return p !== undefined && Number(p.seatIndex) === btnSeat;
    });
    let roundStart = -1;
    if (btnIdx >= 0) {
      for (let step = 1; step <= n; step++) {
        const j = (btnIdx + step) % n;
        const p = this.players.get(this.order[j]!);
        if (p !== undefined && !p.folded && !p.allIn) {
          roundStart = j;
          break;
        }
      }
    }
    if (roundStart < 0) {
      roundStart = this.order.findIndex((id) => {
        const p = this.players.get(id);
        return p !== undefined && !p.folded && !p.allIn;
      });
    }
    if (roundStart < 0) {
      roundStart = this.order.findIndex((id) => {
        const p = this.players.get(id);
        return p !== undefined && !p.folded;
      });
    }
    this.roundStartIdx = roundStart >= 0 ? roundStart : 0;
    this.actionSearchStart = this.roundStartIdx;
    this.actedThisRound.clear();
    this.startBettingRound();
  }

  private dealBoardChunk(): void {
    const _burn = this.deck.pop();
    void _burn;
    const n = this.board.length === 0 ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const c = this.deck.pop();
      if (c) this.board.push(c);
    }
  }

  /**
   * Cards that would be dealt next (with burns), without mutating the live deck
   * or board. Used for rabbit hunting after a fold ends the hand early.
   */
  private peekRemainingBoardCards(): Card[] {
    if (this.board.length >= 5) return [];
    const deck = this.deck.slice();
    const out: Card[] = [];
    let len = this.board.length;
    while (len < 5) {
      deck.pop(); // burn
      const n = len === 0 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const c = deck.pop();
        if (!c) return out;
        out.push(c);
        len += 1;
      }
    }
    return out;
  }

  /** True when ≥2 contestants remain but ≤1 can still put chips in. */
  private bettingIsDead(live: HandPlayer[]): boolean {
    if (live.length < 2) return false;
    const canBet = live.filter((p) => !p.allIn);
    return canBet.length <= 1;
  }

  /** Deal remaining streets onto `target` from the live deck (with burns). */
  private dealRemainingOnto(target: Card[]): void {
    while (target.length < 5) {
      this.deck.pop(); // burn
      const n = target.length === 0 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const c = this.deck.pop();
        if (c) target.push(c);
      }
    }
  }

  private beginBoardRunOut(): void {
    if (this.handComplete || this.ritPending) return;
    this.toActPlayerId = null;
    if (this.board.length >= 5) {
      this.showdown();
      return;
    }
    if (this.runItTwiceMode === "always") {
      this.showdownTwice();
      return;
    }
    if (this.runItTwiceMode === "ask") {
      this.ritPending = true;
      this.ritEligible = this.activeInHand().map((p) => p.playerId);
      this.ritVotes.clear();
      this.lastAction = { playerId: "system", action: "run_it_twice_ask" };
      return;
    }
    while (this.board.length < 5) this.dealBoardChunk();
    this.street = "river";
    this.showdown();
  }

  isAwaitingRunItTwiceVote(): boolean {
    return this.ritPending;
  }

  getRunItTwiceEligible(): string[] {
    return this.ritPending ? [...this.ritEligible] : [];
  }

  /**
   * Contestant vote for run-it-twice. Any "no" ends the vote as single run;
   * unanimous "yes" runs twice. Returns true when the vote resolved the hand.
   */
  voteRunItTwice(playerId: string, yes: boolean): boolean {
    if (!this.ritPending) throw new Error("no_rit_vote");
    if (!this.ritEligible.includes(playerId)) throw new Error("not_eligible");
    this.ritVotes.set(playerId, yes);
    if (!yes) {
      this.finishRunItTwiceVote(false);
      return true;
    }
    if (this.ritEligible.every((id) => this.ritVotes.get(id) === true)) {
      this.finishRunItTwiceVote(true);
      return true;
    }
    return false;
  }

  /** Ask-mode timeout (or host force): default to a single board. */
  forceRunItTwiceTimeout(): void {
    if (!this.ritPending) return;
    this.finishRunItTwiceVote(false);
  }

  private finishRunItTwiceVote(runTwice: boolean): void {
    this.ritPending = false;
    if (runTwice) {
      this.showdownTwice();
      return;
    }
    while (this.board.length < 5) this.dealBoardChunk();
    this.street = "river";
    this.showdown();
  }

  private showdownTwice(): void {
    const sharedLen = this.board.length;
    const board1 = this.board.slice();
    this.dealRemainingOnto(board1);
    const board2 = this.board.slice(0, sharedLen);
    this.dealRemainingOnto(board2);
    this.board = board1;
    this.secondBoard = board2;
    this.street = "river";
    const playerRows = [...this.players.values()].map((p) => ({
      id: p.playerId,
      committed: p.totalCommittedHand,
      folded: p.folded,
      hole: p.hole!,
    }));
    const payouts = resolveSidePotsTwice(playerRows, board1, board2);
    this.winners = payouts.map((x) => ({
      playerId: x.playerId,
      amount: x.amount,
      hand: x.handLabel,
    }));
    for (const w of payouts) {
      const pl = this.players.get(w.playerId);
      if (pl) pl.chips += w.amount;
    }
    this.recordSummary(false, payouts);
    for (const p of this.players.values()) {
      p.totalCommittedHand = 0;
    }
    this.handComplete = true;
    this.toActPlayerId = null;
  }

  fold(playerId: string): void {
    this.ensureActor(playerId);
    const p = this.players.get(playerId)!;
    p.folded = true;
    this.lastAction = { playerId, action: "fold" };
    this.actedThisRound.add(playerId);
    this.toActPlayerId = null;
    this.setActionSearchAfter(playerId);
    if (this.aliveCount() <= 1) {
      this.finishHand();
      return;
    }
    this.startBettingRound();
  }

  check(playerId: string): void {
    this.ensureActor(playerId);
    const p = this.players.get(playerId)!;
    const toCall = this.currentBet - p.betThisStreet;
    if (toCall > 0) throw new Error("cannot_check");
    this.lastAction = { playerId, action: "check" };
    this.actedThisRound.add(playerId);
    this.toActPlayerId = null;
    this.setActionSearchAfter(playerId);
    this.afterAction();
  }

  call(playerId: string): void {
    this.ensureActor(playerId);
    const p = this.players.get(playerId)!;
    const toCall = this.currentBet - p.betThisStreet;
    const paid = this.commitChips(playerId, toCall);
    this.lastAction = { playerId, action: "call", amount: paid };
    this.actedThisRound.add(playerId);
    this.toActPlayerId = null;
    this.setActionSearchAfter(playerId);
    this.afterAction();
  }

  raise(playerId: string, raiseTo: number): void {
    this.ensureActor(playerId);
    const p = this.players.get(playerId)!;
    const minTotal = this.currentBet + this.minRaiseTotal();
    const maxTotal = p.betThisStreet + p.chips;
    const totalTarget = Math.min(raiseTo, maxTotal);
    if (totalTarget < minTotal && totalTarget < maxTotal) {
      throw new Error("raise_too_small");
    }
    const need = totalTarget - p.betThisStreet;
    const pay = this.commitChips(playerId, need);
    if (pay < need && !p.allIn) throw new Error("not_enough_chips");
    const prevBet = this.currentBet;
    this.currentBet = Math.max(
      this.currentBet,
      ...[...this.players.values()].map((x) => x.betThisStreet),
    );
    const inc = this.currentBet - prevBet;
    if (inc > 0) {
      this.lastRaiseIncrement = Math.max(this.bigBlind, inc);
    }
    this.lastAction = { playerId, action: "raise", amount: pay };
    this.actedThisRound.clear();
    this.actedThisRound.add(playerId);
    this.toActPlayerId = null;
    /** Re-open action: first responder is clockwise from the raiser. */
    this.setActionSearchAfter(playerId);
    this.afterAction();
  }

  private minRaiseTotal(): number {
    if (this.currentBet === 0) return this.bigBlind;
    return this.lastRaiseIncrement;
  }

  private ensureActor(playerId: string): void {
    if (this.handComplete) throw new Error("hand_over");
    if (this.ritPending) throw new Error("awaiting_run_it_twice");
    if (this.toActPlayerId !== playerId) throw new Error("not_your_turn");
  }

  private afterAction(): void {
    if (this.allMatchedOrAllIn()) {
      this.advanceStreet();
      return;
    }
    this.startBettingRound();
  }

  getPotTotal(): number {
    return [...this.players.values()].reduce(
      (s, p) => s + p.totalCommittedHand,
      0,
    );
  }

  private finishHand(): void {
    const live = this.activeInHand();
    if (live.length === 1) {
      const w = live[0]!;
      const pot = this.getPotTotal();
      this.winners = [{ playerId: w.playerId, amount: pot }];
      w.chips += pot;
      if (this.board.length < 5) {
        this.rabbitBoard = this.peekRemainingBoardCards();
      }
      this.recordSummary(true, []);
      for (const p of this.players.values()) {
        p.totalCommittedHand = 0;
      }
      this.handComplete = true;
      this.toActPlayerId = null;
      return;
    }
    this.beginBoardRunOut();
  }

  private showdown(): void {
    const payouts = resolveSidePots(
      [...this.players.values()].map((p) => ({
        id: p.playerId,
        committed: p.totalCommittedHand,
        folded: p.folded,
        hole: p.hole!,
      })),
      this.board,
    );
    this.winners = payouts.map((x) => ({
      playerId: x.playerId,
      amount: x.amount,
      hand: x.handLabel,
    }));
    for (const w of payouts) {
      const pl = this.players.get(w.playerId);
      if (pl) pl.chips += w.amount;
    }
    this.recordSummary(false, payouts);
    for (const p of this.players.values()) {
      p.totalCommittedHand = 0;
    }
    this.handComplete = true;
    this.toActPlayerId = null;
  }

  private recordSummary(
    endedByFold: boolean,
    payouts: { playerId: string; amount: number; handLabel?: string }[],
  ): void {
    const winnerLabelByPlayer = new Map<string, string>();
    for (const p of payouts) {
      if (p.handLabel) winnerLabelByPlayer.set(p.playerId, p.handLabel);
    }
    const winnerWonByPlayer = new Map<string, number>();
    for (const w of this.winners ?? []) {
      winnerWonByPlayer.set(
        w.playerId,
        (winnerWonByPlayer.get(w.playerId) ?? 0) + w.amount,
      );
    }
    const players: HandSummaryPlayer[] = [...this.players.values()].map(
      (p) => {
        const won = winnerWonByPlayer.get(p.playerId) ?? 0;
        const showAtShowdown = !endedByFold && !p.folded && p.hole !== null;
        const hole: [string, string] | null = showAtShowdown
          ? [cardToString(p.hole![0]), cardToString(p.hole![1])]
          : null;
        return {
          playerId: p.playerId,
          seatIndex: p.seatIndex,
          hole,
          totalIn: p.totalCommittedHand,
          won,
          net: won - p.totalCommittedHand,
          folded: p.folded,
          handLabel: winnerLabelByPlayer.get(p.playerId) ?? null,
        };
      },
    );
    this.summary = {
      startedAt: this.startedAt,
      endedAt: new Date(),
      board: this.board.map(cardToString),
      secondBoard: this.secondBoard.map(cardToString),
      rabbitBoard: this.rabbitBoard.map(cardToString),
      pot: this.getPotTotal(),
      endedByFold,
      players,
      winners: (this.winners ?? []).map((w) => ({
        playerId: w.playerId,
        amount: w.amount,
        hand: w.hand,
      })),
    };
  }

  getSummary(): HandSummary | null {
    return this.summary;
  }

  getPublic(): HandPublic {
    const actingOrder = this.computeActingOrder();
    return {
      street: this.street,
      board: this.board.map(cardToString),
      secondBoard: this.secondBoard.map(cardToString),
      rabbitBoard: this.rabbitBoard.map(cardToString),
      pot: this.getPotTotal(),
      sidePots: snapshotSidePots(this.players, this.board),
      currentBet: this.currentBet,
      toActPlayerId: this.toActPlayerId,
      buttonSeat: this.buttonSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      minRaise: this.minRaiseTotal(),
      actingOrderPlayerIds: actingOrder,
      lastAction: this.lastAction,
      winners: this.winners,
      handComplete: this.handComplete,
      seatBets: [...this.players.values()]
        .filter((p) => p.betThisStreet > 0)
        .map((p) => ({ seatIndex: p.seatIndex, amount: p.betThisStreet })),
      runItTwicePending: this.ritPending || undefined,
      runItTwiceEligible: this.ritPending ? [...this.ritEligible] : undefined,
      runItTwiceVotes: this.ritPending
        ? [...this.ritVotes.entries()].map(([playerId, yes]) => ({
            playerId,
            yes,
          }))
        : undefined,
    };
  }

  private computeActingOrder(): string[] {
    const n = this.order.length;
    const start = this.order.findIndex((id) => {
      const p = this.players.get(id);
      return p && !p.folded;
    });
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = this.order[(start + i) % n]!;
      const p = this.players.get(id);
      if (p && !p.folded) out.push(id);
    }
    return out;
  }

  syncChipsFromRoom(updates: { playerId: string; chips: number }[]): void {
    for (const u of updates) {
      const p = this.players.get(u.playerId);
      if (p) p.chips = u.chips;
    }
  }

  exportChipTotals(): { playerId: string; chips: number }[] {
    return [...this.players.values()].map((p) => ({
      playerId: p.playerId,
      chips: p.chips,
    }));
  }

  isContesting(playerId: string): boolean {
    const p = this.players.get(playerId);
    return !!p && !p.folded;
  }

  getHoleCards(playerId: string): [string, string] | null {
    const p = this.players.get(playerId);
    if (!p?.hole) return null;
    return [cardToString(p.hole[0]), cardToString(p.hole[1])];
  }

  /** CPU: check if free, otherwise call (or fold if no chips — should be rare). */
  applySimpleBotAction(playerId: string): void {
    this.ensureActor(playerId);
    const p = this.players.get(playerId)!;
    const toCall = this.currentBet - p.betThisStreet;
    if (toCall <= 0) {
      this.check(playerId);
    } else if (p.chips <= 0) {
      this.fold(playerId);
    } else {
      this.call(playerId);
    }
  }

  /**
   * Human action clock: never stall the table — check if no bet to match, else fold.
   */
  applyTurnTimeoutAction(playerId: string): void {
    this.ensureActor(playerId);
    const p = this.players.get(playerId)!;
    const toCall = this.currentBet - p.betThisStreet;
    if (toCall <= 0) {
      this.check(playerId);
    } else {
      this.fold(playerId);
    }
  }
}

function snapshotSidePots(
  players: Map<string, HandPlayer>,
  board: Card[],
): SidePotDisplay[] {
  const list = [...players.values()].map((p) => ({
    id: p.playerId,
    committed: p.totalCommittedHand,
    folded: p.folded,
    hole: p.hole!,
  }));
  return computeSidePotLayers(list, board).map((l) => ({
    amount: l.amount,
    eligiblePlayerIds: [...l.eligible],
  }));
}

interface PotLayer {
  amount: number;
  eligible: Set<string>;
}

function computeSidePotLayers(
  players: {
    id: string;
    committed: number;
    folded: boolean;
    hole: [Card, Card];
  }[],
  _board: Card[],
): PotLayer[] {
  void _board;
  const positive = players.filter((p) => p.committed > 0);
  if (positive.length === 0) return [];
  const levels = [...new Set(positive.map((p) => p.committed))].sort(
    (a, b) => a - b,
  );
  const layers: PotLayer[] = [];
  let prev = 0;
  for (const L of levels) {
    let amount = 0;
    for (const p of positive) {
      const prevContrib = Math.min(p.committed, prev);
      const curContrib = Math.min(p.committed, L);
      amount += curContrib - prevContrib;
    }
    if (amount <= 0) {
      prev = L;
      continue;
    }
    const eligible = positive.filter((p) => !p.folded && p.committed >= L);
    const eligibleIds = new Set(eligible.map((p) => p.id));
    layers.push({ amount, eligible: eligibleIds });
    prev = L;
  }
  return layers;
}

function resolveSidePots(
  players: {
    id: string;
    committed: number;
    folded: boolean;
    hole: [Card, Card];
  }[],
  board: Card[],
): { playerId: string; amount: number; handLabel: string }[] {
  const layers = computeSidePotLayers(players, board);
  const payouts: { playerId: string; amount: number; handLabel: string }[] =
    [];
  for (const layer of layers) {
    payouts.push(...awardLayer(players, board, layer));
  }
  return mergePayouts(payouts);
}

/**
 * Run-it-twice: multi-eligible side-pot layers split 50/50 across two boards.
 * Sole-eligible layers pay in full once (board-independent).
 * Odd chip (if any) goes to the first board.
 */
function resolveSidePotsTwice(
  players: {
    id: string;
    committed: number;
    folded: boolean;
    hole: [Card, Card];
  }[],
  board1: Card[],
  board2: Card[],
): { playerId: string; amount: number; handLabel: string }[] {
  const layers = computeSidePotLayers(players, board1);
  const payouts: { playerId: string; amount: number; handLabel: string }[] =
    [];
  for (const layer of layers) {
    if (layer.eligible.size <= 1) {
      payouts.push(...awardLayer(players, board1, layer));
      continue;
    }
    const half1 = Math.floor(layer.amount / 2);
    const half2 = layer.amount - half1;
    payouts.push(
      ...awardLayer(players, board1, { amount: half1, eligible: layer.eligible }),
    );
    payouts.push(
      ...awardLayer(players, board2, { amount: half2, eligible: layer.eligible }),
    );
  }
  return mergePayouts(payouts);
}

function awardLayer(
  players: {
    id: string;
    committed: number;
    folded: boolean;
    hole: [Card, Card];
  }[],
  board: Card[],
  layer: PotLayer,
): { playerId: string; amount: number; handLabel: string }[] {
  const elig = [...layer.eligible];
  if (elig.length === 0 || layer.amount <= 0) return [];
  let best: string[] = [];
  let bestScore = -1;
  for (const id of elig) {
    const p = players.find((x) => x.id === id)!;
    const v = handValue(p.hole, board);
    if (v > bestScore) {
      bestScore = v;
      best = [id];
    } else if (v === bestScore) {
      best.push(id);
    }
  }
  const share = layer.amount / best.length;
  return best.map((id) => {
    const p = players.find((x) => x.id === id)!;
    return {
      playerId: id,
      amount: share,
      handLabel: handCategoryLabel(p.hole, board),
    };
  });
}

function mergePayouts(
  payouts: { playerId: string; amount: number; handLabel: string }[],
): { playerId: string; amount: number; handLabel: string }[] {
  const byId = new Map<
    string,
    { playerId: string; amount: number; handLabel: string }
  >();
  for (const p of payouts) {
    const cur = byId.get(p.playerId);
    if (!cur) {
      byId.set(p.playerId, { ...p });
    } else {
      cur.amount += p.amount;
      if (p.handLabel) cur.handLabel = p.handLabel;
    }
  }
  return [...byId.values()];
}

function handValue(hole: [Card, Card], board: Card[]): number {
  const e = evaluate7(hole, board);
  const order = [
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
  let v = order.indexOf(e.category) * 1e9;
  for (const k of e.kickers) v = v * 15 + k;
  return v;
}

function handCategoryLabel(hole: [Card, Card], board: Card[]): string {
  const e = evaluate7(hole, board);
  return e.category;
}
