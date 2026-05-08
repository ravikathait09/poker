/**
 * Multi-player PokerHand integration checks (no Mongo / Room).
 * Run: npm run test:multi -w @ganga/realtime
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PokerHand } from "../dist/poker-engine.js";

/** @returns {import('../dist/poker-engine.js').HandPlayer} */
function p(id, seat, chips = 8000) {
  return {
    playerId: id,
    seatIndex: seat,
    chips,
    hole: null,
    folded: false,
    betThisStreet: 0,
    totalCommittedHand: 0,
    allIn: false,
  };
}

test("3 players: each of three acts once per street on limp line", () => {
  const seats = [1, 4, 7];
  const hp = seats.map((s, i) => p(`a${i}`, s));
  const h = new PokerHand(hp, 7, 5, 10, 0, () => 0.33);
  const by = { preflop: [], flop: [], turn: [], river: [] };
  let guard = 0;
  while (!h.handComplete && guard++ < 400) {
    const t = h.toActPlayerId;
    assert.ok(t, "someone to act");
    assert.ok(h.street && by[h.street], `street ${h.street}`);
    by[h.street].push(t);
    h.applySimpleBotAction(t);
  }
  assert.equal(by.preflop.length, 3);
  assert.equal(by.flop.length, 3);
  assert.equal(by.turn.length, 3);
  assert.equal(by.river.length, 3);
  for (const st of ["preflop", "flop", "turn", "river"]) {
    assert.equal(new Set(by[st]).size, 3, `${st}: three distinct actors`);
  }
});

test("3 players: fold leaves 2 — both act each post-flop street", () => {
  const hp = [p("x0", 0), p("x1", 3), p("x2", 6)];
  const h = new PokerHand(hp, 6, 5, 10, 0, () => 0.71);
  const first = h.toActPlayerId;
  h.fold(first);
  assert.ok(!h.handComplete, "hand continues with two players");
  const by = { preflop: [], flop: [], turn: [], river: [] };
  let guard = 0;
  while (!h.handComplete && guard++ < 400) {
    const t = h.toActPlayerId;
    if (!t) break;
    assert.ok(by[h.street], `street ${h.street}`);
    by[h.street].push(t);
    h.applySimpleBotAction(t);
  }
  assert.ok(h.handComplete);
  assert.equal(by.flop.length, 2);
  assert.equal(by.turn.length, 2);
  assert.equal(by.river.length, 2);
  assert.equal(new Set(by.flop).size, 2);
});

test("4 players: UTG raise — three others each respond (call)", () => {
  const hp = [p("q0", 0), p("q1", 2), p("q2", 5), p("q3", 8)];
  const h = new PokerHand(hp, 8, 5, 10, 0, () => 0.55);
  const utg = h.toActPlayerId;
  const pub = h.getPublic();
  const raiseTo = pub.currentBet + pub.minRaise;
  h.raise(utg, raiseTo);
  const responded = new Set();
  let guard = 0;
  while (h.street === "preflop" && h.toActPlayerId && guard++ < 40) {
    const t = h.toActPlayerId;
    if (t === utg) {
      h.check(t);
    } else {
      responded.add(t);
      h.call(t);
    }
  }
  assert.equal(responded.size, 3, "three other seats respond to open");
  assert.equal(h.street, "flop");
});

test("heads-up: button (SB) acts first preflop", () => {
  const hp = [p("h0", 1), p("h1", 5)];
  const btnSeat = 1;
  const h = new PokerHand(hp, btnSeat, 5, 10, 0, () => 0.12);
  assert.equal(h.getPublic().sbSeat, 1);
  assert.equal(h.getPublic().bbSeat, 5);
  assert.equal(h.toActPlayerId, "h0");
  h.applySimpleBotAction("h0");
  assert.equal(h.toActPlayerId, "h1");
});

test("invalid button seat throws", () => {
  const hp = [p("b0", 0), p("b1", 2)];
  assert.throws(
    () => new PokerHand(hp, 99, 5, 10, 0, () => 0.5),
    /bad_button_seat/,
  );
});

test("5 players: orbit — each acts preflop on limp line", () => {
  const seats = [0, 1, 2, 3, 4];
  const hp = seats.map((s, i) => p(`f${i}`, s, 20_000));
  const h = new PokerHand(hp, 3, 5, 10, 0, () => 0.44);
  const pre = [];
  let guard = 0;
  while (h.street === "preflop" && h.toActPlayerId && guard++ < 30) {
    pre.push(h.toActPlayerId);
    h.applySimpleBotAction(h.toActPlayerId);
  }
  assert.equal(pre.length, 5);
  assert.equal(new Set(pre).size, 5);
});
