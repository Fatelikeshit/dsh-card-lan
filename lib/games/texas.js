/**
 * dsh-card-lan 德州扑克（texas hold'em）— pure rules engine.
 *
 * No IO, no timers, no DSH imports: the host half owns sockets, seats and
 * transport. This module owns the deck, blinds/button rotation, betting
 * streets, all-in handling, side pots and per-viewer private hole cards.
 *
 * Rules (PROTOCOL.md 7.16):
 *   - 2..6 players, one 52-card deck, two hole cards each + five community.
 *   - Chips: 1000 at seat time; small blind 10 / big blind 20; a player below
 *     20 chips is topped up to 1000 at the start of the next hand.
 *   - Button starts at seat 0 and rotates one seat per hand. Heads-up the
 *     button posts the small blind; with 3+ seats the next two players post
 *     small/big. Preflop action starts after the big blind (heads-up: the
 *     button/SB), later streets from the seat after the button.
 *   - Streets: preflop -> flop(3) -> turn(1) -> river(1). Only active players
 *     (not folded, not all-in) act. A street ends once every active player's
 *     street bet equals currentBet (all-in players are exempt). A raise is
 *     fixed to currentBet+20 (20 when currentBet is 0); short stacks go
 *     all-in automatically.
 *   - Last player standing wins immediately. Otherwise hands are compared as
 *     best 5 of 7 and side pots are layered by each player's total committed
 *     chips; ties split the pot (extra chip to the earlier seat).
 *   - Timeout: check when possible, otherwise fold.
 *
 * Exported API (mirrors the other engines):
 *   minPlayers, maxPlayers, createTable, addPlayer, startRound, applyAction,
 *   onTimeout, removePlayer, snapshot, botAction
 * Extra pure helpers: evaluate7, evaluate5, compareHands, labelOf, sortHand,
 * buildDeck, rankValue, isCard.
 * @module dsh-card-lan/games/texas
 */

/** Two to six players. */
export const minPlayers = 2
export const maxPlayers = 6

/** Stacks / blinds. */
export const START_CHIPS = 1000
export const SMALL_BLIND = 10
export const BIG_BLIND = 20
export const RAISE_SIZE = 20

/** Hands below this are topped up before the next hand. */
const MIN_CHIPS_TO_PLAY = BIG_BLIND

/** Streets in order. */
const STREETS = ['preflop', 'flop', 'turn', 'river']
const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river' }
const REVEAL_COUNT = { preflop: 0, flop: 3, turn: 4, river: 5 }

/** Dealt order of community cards per street transition. */
const BOARD_COUNT = 5

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const SUITS = ['S', 'H', 'D', 'C']

const RANK_VALUE = {
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
}

const RANK_TEXT = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  J: 'J',
  Q: 'Q',
  K: 'K',
  A: 'A',
}

/** Hand categories, highest first (used for ordering). */
const CATEGORY = {
  'straight-flush': 8,
  'four-of-a-kind': 7,
  'full-house': 6,
  flush: 5,
  straight: 4,
  'three-of-a-kind': 3,
  'two-pair': 2,
  pair: 1,
  high: 0,
}

const CATEGORY_TEXT = {
  'straight-flush': '同花顺',
  'four-of-a-kind': '四条',
  'full-house': '葫芦',
  flush: '同花',
  straight: '顺子',
  'three-of-a-kind': '三条',
  'two-pair': '两对',
  pair: '一对',
  high: '高牌',
}

/** One wire card: rank + suit. */
const CARD_RE = /^(?:[2-9]|10|[JQKA])[SHDC]$/

/** Log lines kept in the engine state (snapshot trims further). */
const LOG_LIMIT = 40

/* -------------------------------------------------------------------------- *
 * Cards / hand evaluation
 * -------------------------------------------------------------------------- */

/** True for a syntactically valid wire card. */
export function isCard(card) {
  return typeof card === 'string' && CARD_RE.test(card)
}

/** Rank part of a wire card. */
export function rankOf(card) {
  return isCard(card) ? card.slice(0, -1) : undefined
}

/** Suit part of a wire card. */
export function suitOf(card) {
  return isCard(card) ? card.slice(-1) : undefined
}

/** Natural rank value (2..14). */
export function rankValue(rank) {
  return RANK_VALUE[rank] ?? 0
}

/** Natural-value card value. */
export function cardValue(card) {
  return rankValue(rankOf(card))
}

/** Ascending natural sort. */
export function sortHand(cards) {
  if (!Array.isArray(cards)) return []
  return cards.slice().sort((a, b) => {
    const diff = cardValue(a) - cardValue(b)
    if (diff !== 0) return diff
    return String(a).localeCompare(String(b))
  })
}

/** A fresh 52-card deck. */
export function buildDeck() {
  const deck = []
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit)
  }
  return deck
}

/** Fisher–Yates shuffle over a copy. */
export function shuffle(deck, rng = Math.random) {
  const cards = Array.isArray(deck) ? deck.slice() : []
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    const current = cards[index]
    cards[index] = cards[swap]
    cards[swap] = current
  }
  return cards
}

/** Sorted-descending distinct values of five cards. */
function valuesOf(cards) {
  return cards.map(cardValue).sort((a, b) => b - a)
}

/** Straight high card of five distinct values (wheel returns 5), else null. */
function straightHigh(sortedDesc) {
  const unique = [...new Set(sortedDesc)]
  if (unique.length !== 5) return null
  if (unique[0] - unique[4] === 4) return unique[0]
  // Wheel: A,5,4,3,2 (A plays as 1).
  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
    return 5
  }
  return null
}

/**
 * Evaluate exactly five cards. Returns
 * { category, name, tiebreak:[...], label } (category numeric, higher better).
 */
export function evaluate5(cards) {
  if (!Array.isArray(cards) || cards.length !== 5 || !cards.every(isCard)) return null
  if (new Set(cards).size !== 5) return null
  const values = valuesOf(cards)
  const suits = cards.map(suitOf)
  const flush = suits.every((suit) => suit === suits[0])
  const straight = straightHigh(values)
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const groups = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))
  const byCount = (count) => groups.filter(([, hits]) => hits === count).map(([value]) => value)
  const fours = byCount(4)
  const trips = byCount(3)
  const pairs = byCount(2)
  const singles = groups.filter(([, hits]) => hits === 1).map(([value]) => value)

  let category
  let tiebreak
  if (flush && straight !== null) {
    category = 'straight-flush'
    tiebreak = [straight]
  } else if (fours.length === 1) {
    category = 'four-of-a-kind'
    tiebreak = [fours[0], singles[0]]
  } else if (trips.length === 1 && pairs.length === 1) {
    category = 'full-house'
    tiebreak = [trips[0], pairs[0]]
  } else if (flush) {
    category = 'flush'
    tiebreak = values
  } else if (straight !== null) {
    category = 'straight'
    tiebreak = [straight]
  } else if (trips.length === 1) {
    category = 'three-of-a-kind'
    tiebreak = [trips[0], ...singles]
  } else if (pairs.length === 2) {
    category = 'two-pair'
    tiebreak = [pairs[0], pairs[1], singles[0]]
  } else if (pairs.length === 1) {
    category = 'pair'
    tiebreak = [pairs[0], ...singles]
  } else {
    category = 'high'
    tiebreak = values
  }
  return {
    category: CATEGORY[category],
    name: category,
    tiebreak,
    label: labelFor(category, tiebreak),
    cards: cards.slice(),
  }
}

/** Compare two evaluated hands by category then tiebreakers. */
function compareEvaluated(a, b) {
  if (a === null || b === null) return 0
  if (a.category !== b.category) return a.category - b.category
  const length = Math.max(a.tiebreak.length, b.tiebreak.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.tiebreak[index] ?? 0
    const right = b.tiebreak[index] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

/** All 5-card combinations of 7 cards (21). */
function combinations5(cards) {
  const out = []
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            out.push([cards[a], cards[b], cards[c], cards[d], cards[e]])
          }
        }
      }
    }
  }
  return out
}

/** Evaluate the best five of seven cards. */
export function evaluate7(cards) {
  if (!Array.isArray(cards) || cards.length !== 7 || !cards.every(isCard)) return null
  if (new Set(cards).size !== 7) return null
  let best = null
  for (const combo of combinations5(cards)) {
    const evaluated = evaluate5(combo)
    if (evaluated === null) continue
    if (best === null || compareEvaluated(evaluated, best) > 0) best = evaluated
  }
  return best
}

/** Evaluate 5 or 7 cards into the best hand. */
function evaluateAny(cards) {
  if (!Array.isArray(cards)) return null
  if (cards.length === 5) return evaluate5(cards)
  if (cards.length === 7) return evaluate7(cards)
  return null
}

/** Compare two hands (5 or 7 cards): >0 when a wins, <0 when b wins. */
export function compareHands(cardsA, cardsB) {
  const a = evaluateAny(cardsA)
  const b = evaluateAny(cardsB)
  if (a === null || b === null) return 0
  return compareEvaluated(a, b)
}

/** Human-readable label for 5 or 7 cards. */
export function labelOf(cards) {
  const evaluated = evaluateAny(cards)
  return evaluated === null ? '无效手牌' : evaluated.label
}

/** Detail text for one category. */
function labelFor(category, tiebreak) {
  const top = tiebreak[0]
  if (category === 'straight' || category === 'straight-flush') {
    const high = tiebreak[0]
    if (high === 5) return CATEGORY_TEXT[category] + ' A2345'
    const low = high - 4
    return CATEGORY_TEXT[category] + ' ' + (RANK_TEXT[low] ?? low) + '-' + (RANK_TEXT[high] ?? high)
  }
  if (category === 'high' || category === 'flush') {
    return CATEGORY_TEXT[category] + ' ' + (RANK_TEXT[top] ?? top)
  }
  return CATEGORY_TEXT[category] + ' ' + (RANK_TEXT[top] ?? top)
}

/* -------------------------------------------------------------------------- *
 * State helpers
 * -------------------------------------------------------------------------- */

/** Bounded display text. */
function text(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

/** Append one log line. */
function log(state, line) {
  state.log.push(String(line).slice(0, 80))
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT)
  state.updatedAt = Date.now()
}

/** Ensure the score bucket for one node exists. */
function ensureScore(state, node) {
  if (state.scores === undefined || state.scores === null) state.scores = {}
  if (state.scores[node] === undefined) state.scores[node] = { win: 0, lose: 0 }
  return state.scores[node]
}

/** Find one player by node. */
function playerOf(state, node) {
  if (!Array.isArray(state?.players)) return undefined
  return state.players.find((player) => player.node === node)
}

/** Seat index of a node (-1 when missing). */
function indexOfNode(state, node) {
  return state.players.findIndex((player) => player.node === node)
}

/** True for a player still in the hand (not folded). */
function inHand(player) {
  return player.status === 'folded' || player.left === true ? false : true
}

/** True for a player who may still act. */
function canAct(player) {
  return player.status === 'active' && player.left !== true
}

/** Next index with a player satisfying `predicate`, `count` seats ahead. */
function nextIndex(state, fromIndex, predicate, count = 1) {
  const total = state.players.length
  for (let step = 1; step <= count + total; step += 1) {
    const index = (fromIndex + step) % total
    if (predicate(state.players[index])) return index
  }
  return -1
}

/** Next player who can act after an index. */
function nextActor(state, fromIndex) {
  return nextIndex(state, fromIndex, canAct, 1)
}

/** Fresh player record. */
function makePlayer(raw) {
  return {
    node: typeof raw?.node === 'string' ? raw.node : '',
    nick: text(raw?.nick, 24) ?? '玩家',
    bot: raw?.bot === true,
    chips: Number.isInteger(raw?.chips) && raw.chips > 0 ? raw.chips : START_CHIPS,
    hole: [],
    bet: 0,
    committed: 0,
    status: 'active',
    result: null,
    lastAction: null,
    left: false,
    acted: false,
  }
}

/** Pay `amount` chips from a player into the pot (short stacks pay everything). */
function pay(state, player, amount) {
  const paid = Math.min(Math.max(0, amount), player.chips)
  player.chips -= paid
  player.bet += paid
  player.committed += paid
  state.pot += paid
  return paid
}

/** Build the postflop first actor (seat after the button). */
function postflopActor(state, dealerIndex) {
  return nextActor(state, dealerIndex)
}

/** Reveal the next street and reset the street bets. */
function revealNextStreet(state) {
  const next = NEXT_STREET[state.phase]
  if (next === undefined) return false
  state.phase = next
  state.community = state.board.slice(0, REVEAL_COUNT[next])
  for (const player of state.players) {
    player.bet = 0
    player.acted = false
  }
  state.currentBet = 0
  state.lastRaiseDelta = BIG_BLIND
  log(state, next === 'flop' ? '翻牌 ' + state.community.join(' ') : (next === 'turn' ? '转牌 ' + state.community.slice(-1)[0] : '河牌 ' + state.community.slice(-1)[0]))
  return true
}

/** Deal out the remaining board and settle at showdown (all-in runout). */
function runoutBoard(state) {
  while (state.phase !== 'result' && state.phase !== 'river') revealNextStreet(state)
  showdown(state)
}

/** Settle when only one player is still in the hand. */
function settleSingle(state, winner) {
  if (winner === undefined) return
  const amount = state.pot
  winner.chips += amount
  winner.result = 'win'
  state.phase = 'result'
  state.turn = null
  state.winnerNodes = [winner.node]
  state.pots = [{ amount, winners: [winner.node] }]
  finalizeResults(state, state.winnerNodes)
  log(state, (winner.nick ?? '玩家') + ' 赢下底池 ' + amount)
}

/** Mark winners/losers and scores at the end of a hand. */
function finalizeResults(state, winnerNodes) {
  state.phase = 'result'
  state.turn = null
  state.players = state.players.filter((player) => player.left !== true)
  const winners = new Set(winnerNodes)
  for (const player of state.players) {
    const win = winners.has(player.node)
    player.result = win ? 'win' : 'lose'
    const bucket = ensureScore(state, player.node)
    if (win) bucket.win += 1
    else bucket.lose += 1
  }
}

/** Split `amount` among `winners` (seat order gets the remainder). */
function splitPot(state, amount, winners) {
  const share = Math.floor(amount / winners.length)
  let remainder = amount - share * winners.length
  const ordered = winners.slice().sort((a, b) => indexOfNode(state, a.node) - indexOfNode(state, b.node))
  const parts = []
  for (const winner of ordered) {
    const extra = remainder > 0 ? 1 : 0
    if (extra === 1) remainder -= 1
    winner.chips += share + extra
    parts.push({ node: winner.node, amount: share + extra })
  }
  return parts
}

/** Compare two hands and return the winners among an eligible list. */
function bestOf(players, board) {
  let best = null
  let winners = []
  for (const player of players) {
    const evaluated = evaluate7([...player.hole, ...board])
    if (evaluated === null) continue
    const comparison = best === null ? 1 : compareEvaluated(evaluated, best)
    if (comparison > 0) {
      best = evaluated
      winners = [player]
    } else if (comparison === 0) {
      winners.push(player)
    }
  }
  return winners
}

/** Build and distribute main/side pots from each player's committed chips. */
function settleShowdown(state) {
  const board = state.board.slice(0, BOARD_COUNT)
  const contenders = state.players.filter((player) => inHand(player) && player.hole.length === 2)
  if (contenders.length <= 1) {
    settleSingle(state, contenders[0])
    return
  }
  const levels = [...new Set(state.players.map((player) => player.committed).filter((value) => value > 0))]
    .sort((a, b) => a - b)
  let previousTotal = 0
  let deadAmount = 0
  const pots = []
  for (const level of levels) {
    let totalAtLevel = 0
    for (const player of state.players) totalAtLevel += Math.min(player.committed, level)
    const amount = totalAtLevel - previousTotal
    previousTotal = totalAtLevel
    if (amount <= 0) continue
    const eligible = state.players.filter((player) => inHand(player)
      && player.hole.length === 2 && player.committed >= level)
    if (eligible.length === 0) {
      // Only folded players reached this layer: their chips are dead money.
      deadAmount += amount
      continue
    }
    const winners = bestOf(eligible, board)
    pots.push({ amount, winners, parts: splitPot(state, amount, winners) })
  }
  if (deadAmount > 0) {
    const winners = bestOf(contenders, board)
    pots.push({ amount: deadAmount, winners, parts: splitPot(state, deadAmount, winners) })
  }
  state.pots = pots.map((pot) => ({ amount: pot.amount, winners: pot.winners.map((player) => player.node) }))
  const winnerNodes = [...new Set(state.pots.flatMap((pot) => pot.winners))]
  state.winnerNodes = winnerNodes
  finalizeResults(state, winnerNodes)
  for (const pot of pots) {
    log(state, '边池 ' + pot.amount + ' -> ' + pot.winners.map((player) => player.nick).join('/'))
  }
}

/** Distribute the pot at showdown (or single survivor). */
function showdown(state) {
  if (state.phase === 'result') return
  settleShowdown(state)
}

/** True when every player still in the hand has acted and matched this street. */
function streetComplete(state, contenders) {
  const actors = contenders.filter((player) => canAct(player))
  return actors.every((player) => player.acted === true && player.bet === state.currentBet)
}

/**
 * Continue after one action: settle, advance the street, run out the board or
 * hand the turn to the next active seat.
 */
function continueAfterAction(state, actedIndex) {
  const contenders = state.players.filter((player) => inHand(player))
  if (contenders.length <= 1) {
    settleSingle(state, contenders[0])
    return
  }
  const actors = contenders.filter((player) => canAct(player))
  const complete = streetComplete(state, contenders)
  if (actors.length <= 1 && complete) {
    runoutBoard(state)
    return
  }
  if (!complete) {
    const next = nextActor(state, actedIndex)
    if (next < 0) {
      // No one can act but the street is not complete (should not happen).
      runoutBoard(state)
      return
    }
    state.turn = state.players[next].node
    return
  }
  // Street complete: deal the next one.
  if (state.phase === 'river') {
    showdown(state)
    return
  }
  revealNextStreet(state)
  const after = state.players.filter((player) => inHand(player))
  const actorsAfter = after.filter((player) => canAct(player))
  if (actorsAfter.length <= 1) {
    runoutBoard(state)
    return
  }
  const dealerIndex = indexOfNode(state, state.dealer)
  const next = postflopActor(state, dealerIndex)
  if (next < 0) {
    runoutBoard(state)
    return
  }
  state.turn = state.players[next].node
}

/* -------------------------------------------------------------------------- *
 * Table lifecycle
 * -------------------------------------------------------------------------- */

/** Build an idle table (2..6 seats). */
export function createTable(players = []) {
  const state = {
    game: 'texas',
    phase: 'idle',
    round: 0,
    players: (Array.isArray(players) ? players : []).slice(0, maxPlayers).map(makePlayer),
    dealer: null,
    turn: null,
    pot: 0,
    currentBet: 0,
    lastRaiseDelta: BIG_BLIND,
    community: [],
    board: [],
    winnerNodes: [],
    pots: [],
    log: [],
    scores: {},
    updatedAt: 0,
  }
  for (const player of state.players) ensureScore(state, player.node)
  return state
}

/** Add one seat (host calls this between hands). */
export function addPlayer(state, raw) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const player = makePlayer(raw)
  if (player.node === '') return { ok: false, error: 'bad-player' }
  const existing = playerOf(state, player.node)
  if (existing !== undefined) {
    existing.nick = player.nick
    existing.bot = player.bot
    return { ok: true }
  }
  if (state.players.length >= maxPlayers) return { ok: false, error: 'full' }
  state.players.push(player)
  ensureScore(state, player.node)
  return { ok: true }
}

/** Start the next hand: top up, rotate the button, deal, post blinds. */
export function startRound(state, rng = Math.random) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  state.players = state.players.filter((player) => player.left !== true)
  if (state.players.length < minPlayers) return { ok: false, error: 'no-players' }
  if (state.phase !== 'idle' && state.phase !== 'result') return { ok: false, error: 'bad-phase' }

  state.round += 1
  state.phase = 'preflop'
  state.log = []
  state.pot = 0
  state.currentBet = BIG_BLIND
  state.community = []
  state.winnerNodes = []
  state.pots = []
  const deck = shuffle(buildDeck(), rng)
  state.board = deck.slice(state.players.length * 2, state.players.length * 2 + BOARD_COUNT)
  state.players.forEach((player, index) => {
    if (!Number.isInteger(player.chips) || player.chips < MIN_CHIPS_TO_PLAY) player.chips = START_CHIPS
    player.hole = sortHand(deck.slice(index * 2, index * 2 + 2))
    player.bet = 0
    player.committed = 0
    player.status = 'active'
    player.result = null
    player.lastAction = null
    player.left = false
    player.acted = false
    ensureScore(state, player.node)
  })

  // Button: first hand seat 0, then one seat further each hand.
  const previousIndex = state.dealer === null ? -1 : indexOfNode(state, state.dealer)
  const dealerIndex = (previousIndex + 1) % state.players.length
  state.dealer = state.players[dealerIndex].node
  const count = state.players.length
  const sbIndex = count === 2 ? dealerIndex : (dealerIndex + 1) % count
  const bbIndex = count === 2 ? (dealerIndex + 1) % count : (dealerIndex + 2) % count
  postBlind(state, state.players[sbIndex], SMALL_BLIND, 'small-blind')
  postBlind(state, state.players[bbIndex], BIG_BLIND, 'big-blind')
  state.currentBet = BIG_BLIND
  state.lastRaiseDelta = BIG_BLIND
  const contenders = state.players.filter((player) => inHand(player))
  const actors = contenders.filter((player) => canAct(player))
  if (actors.length === 0) {
    // Everyone is all-in from the blinds: run the board out immediately.
    runoutBoard(state)
    return { ok: true }
  }
  const first = nextActor(state, bbIndex)
  state.turn = first < 0 ? null : state.players[first].node
  log(state, '第 ' + state.round + ' 局开始，按钮 ' + (playerOf(state, state.dealer)?.nick ?? '玩家')
    + '，盲注 ' + SMALL_BLIND + '/' + BIG_BLIND)
  return { ok: true }
}

/** Post one forced blind (short stacks go all-in). */
function postBlind(state, player, amount, actionName) {
  const paid = pay(state, player, amount)
  player.lastAction = actionName
  if (player.chips === 0) player.status = 'allin'
  log(state, player.nick + (actionName === 'small-blind' ? ' 小盲 ' : ' 大盲 ') + paid)
}

/* -------------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------------- */

/** fold: leave the hand. */
function applyFold(state, player) {
  player.status = 'folded'
  player.lastAction = 'fold'
  player.acted = true
  log(state, player.nick + ' 弃牌')
  continueAfterAction(state, indexOfNode(state, player.node))
  return { ok: true }
}

/** check: allowed only when the player already matched the current bet. */
function applyCheck(state, player) {
  if (player.bet !== state.currentBet) return { ok: false, error: 'bad-action' }
  player.lastAction = 'check'
  player.acted = true
  log(state, player.nick + ' 过牌')
  continueAfterAction(state, indexOfNode(state, player.node))
  return { ok: true }
}

/** call: pay up to currentBet; a short stack goes all-in. */
function applyCall(state, player) {
  const needed = state.currentBet - player.bet
  if (needed <= 0) return { ok: false, error: 'bad-action' }
  const paid = pay(state, player, needed)
  if (paid <= 0) return { ok: false, error: 'bad-action' }
  player.acted = true
  if (player.chips === 0) {
    player.status = 'allin'
    player.lastAction = 'allin'
    log(state, player.nick + ' 全下 ' + paid)
  } else {
    player.lastAction = 'call'
    log(state, player.nick + ' 跟注 ' + paid)
  }
  continueAfterAction(state, indexOfNode(state, player.node))
  return { ok: true }
}

/** raise: target amount (total street investment) with a dynamic minimum. */
function applyRaise(state, player, action) {
  const previous = state.currentBet
  const raiseDelta = Number.isInteger(state.lastRaiseDelta) && state.lastRaiseDelta > 0
    ? state.lastRaiseDelta
    : BIG_BLIND
  const minTarget = previous + Math.max(BIG_BLIND, raiseDelta)
  let target = minTarget
  if (action.amount !== undefined) {
    // v10.0: an explicit target must be an integer at or above the minimum.
    if (!Number.isInteger(action.amount) || action.amount < minTarget) {
      return { ok: false, error: 'bad-raise' }
    }
    target = action.amount
  }
  const needed = target - player.bet
  if (needed <= 0) return { ok: false, error: 'bad-raise' }
  // pay() caps at the stack, which is exactly the "overshoot -> all-in" rule.
  const paid = pay(state, player, needed)
  if (paid <= 0) return { ok: false, error: 'bad-raise' }
  player.acted = true
  let raised = false
  if (player.bet > previous) {
    state.currentBet = player.bet
    state.lastRaiseDelta = player.bet - previous
    raised = true
  }
  if (player.chips === 0) {
    player.status = 'allin'
    player.lastAction = 'allin'
    log(state, player.nick + ' 全下 ' + paid + (raised ? '，当前注 ' + state.currentBet : ''))
  } else {
    player.lastAction = 'raise'
    log(state, player.nick + ' 加注到 ' + state.currentBet)
  }
  continueAfterAction(state, indexOfNode(state, player.node))
  return { ok: true }
}

/** Apply one action from `node`. */
export function applyAction(state, node, action) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (node === undefined || node === null) return { ok: false, error: 'bad-action' }
  if (state.phase === 'idle' || state.phase === 'result') return { ok: false, error: 'bad-phase' }
  const player = playerOf(state, node)
  if (player === undefined) return { ok: false, error: 'not-seated' }
  if (state.turn !== node) return { ok: false, error: 'not-your-turn' }
  if (!canAct(player)) return { ok: false, error: 'not-your-turn' }
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, error: 'bad-action' }
  }
  switch (action.type) {
    case 'fold': return applyFold(state, player)
    case 'check': return applyCheck(state, player)
    case 'call': return applyCall(state, player)
    case 'raise': return applyRaise(state, player, action)
    default: return { ok: false, error: 'bad-action' }
  }
}

/** Timeout move: check when possible, otherwise fold. */
export function onTimeout(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (state.phase === 'idle' || state.phase === 'result') return null
  if (state.turn !== node) return null
  const player = playerOf(state, node)
  if (player === undefined || !canAct(player)) return null
  return player.bet === state.currentBet ? { type: 'check' } : { type: 'fold' }
}

/** Bot move (v9.0 has no texas bots; exported for parity). */
export function botAction(state, node) {
  return onTimeout(state, node)
}

/* -------------------------------------------------------------------------- *
 * Leaving / disconnects
 * -------------------------------------------------------------------------- */

/** Remove one player; a mid-hand leave folds the seat until the hand settles. */
export function removePlayer(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const index = indexOfNode(state, node)
  if (index < 0) return { ok: false, error: 'unknown-player' }
  const player = state.players[index]
  if (state.phase === 'idle' || state.phase === 'result') {
    state.players.splice(index, 1)
    if (state.dealer === node) state.dealer = state.players[0]?.node ?? null
    return { ok: true }
  }
  player.status = 'folded'
  player.left = true
  player.lastAction = 'fold'
  log(state, player.nick + ' 离开牌桌')
  if (state.turn === node) {
    const contenders = state.players.filter((entry) => inHand(entry))
    if (contenders.length <= 1) {
      settleSingle(state, contenders[0])
      return { ok: true }
    }
    const next = nextActor(state, index)
    state.turn = next < 0 ? null : state.players[next].node
  }
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Snapshot (per-viewer privacy)
 * -------------------------------------------------------------------------- */

/** Normalize a table node id for the wire. */
function wireNode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null
}

/** Scores as { node: { win, lose } }. */
function scoresFor(state, players) {
  const out = {}
  for (const [node, value] of Object.entries(state.scores ?? {})) {
    if (wireNode(node) === null || value === null || typeof value !== 'object') continue
    out[node] = {
      win: Number.isInteger(value.win) ? Math.max(0, value.win) : 0,
      lose: Number.isInteger(value.lose) ? Math.max(0, value.lose) : 0,
    }
  }
  for (const player of players) {
    if (out[player.node] === undefined) out[player.node] = { win: 0, lose: 0 }
  }
  return out
}

/**
 * Build the per-viewer `view.table` / state.table JSON (PROTOCOL.md 7.16).
 * Hole cards stay private until the hand is over; the viewer always sees its
 * own two cards while in the hand.
 */
export function snapshot(state, viewerNode, meta = {}) {
  const safeMeta = meta !== null && typeof meta === 'object' ? meta : {}
  const role = safeMeta.role === 'spectator' ? 'spectator' : (safeMeta.role === 'host' ? 'host' : 'player')
  const nodes = Array.isArray(state?.players) ? state.players : []
  const viewerIsPlayer = nodes.some((player) => player.node === viewerNode)
  const showSelf = role !== 'spectator' && viewerIsPlayer
  const viewer = showSelf ? playerOf(state, viewerNode) : undefined
  const revealed = state?.phase === 'result'

  const players = nodes.slice(0, maxPlayers).map((player) => {
    const entry = {
      node: player.node,
      nick: player.nick,
      self: showSelf && player.node === viewerNode,
      chips: Number.isInteger(player.chips) ? Math.max(0, player.chips) : 0,
      bet: Number.isInteger(player.bet) ? Math.max(0, player.bet) : 0,
      committed: Number.isInteger(player.committed) ? Math.max(0, player.committed) : 0,
      status: player.status === 'folded' ? 'folded' : (player.status === 'allin' ? 'allin' : 'active'),
      result: player.result === 'win' || player.result === 'lose' ? player.result : null,
      lastAction: typeof player.lastAction === 'string' ? player.lastAction : null,
    }
    if (revealed) entry.cards = Array.isArray(player.hole) ? player.hole.slice(0, 2) : []
    return entry
  })

  const myCards = (() => {
    if (role === 'spectator' || viewer === undefined) return []
    if (viewer.hole.length === 2) return viewer.hole.slice(0, 2)
    return []
  })()

  const staleMs = Number.isInteger(safeMeta.staleMs) ? Math.max(0, safeMeta.staleMs) : 0
  const turnRemaining = Number.isInteger(safeMeta.turnRemainingMs)
    ? Math.min(300_000, Math.max(0, safeMeta.turnRemainingMs))
    : null

  const view = {
    game: 'texas',
    role,
    hostNode: wireNode(safeMeta.hostNode) ?? '',
    phase: state?.phase === 'idle' ? 'idle'
      : (STREETS.includes(state?.phase) || state?.phase === 'result' ? state.phase : 'idle'),
    round: Number.isInteger(state?.round) ? Math.max(0, state.round) : 0,
    dealer: wireNode(state?.dealer),
    turn: wireNode(state?.turn),
    pot: Number.isInteger(state?.pot) ? Math.max(0, state.pot) : 0,
    currentBet: Number.isInteger(state?.currentBet) ? Math.max(0, state.currentBet) : 0,
    community: Array.isArray(state?.community) ? state.community.filter(isCard).slice(0, 5) : [],
    myCards,
    players,
    log: Array.isArray(state?.log)
      ? state.log.map((line) => text(line, 80)).filter((line) => line !== undefined).slice(-8)
      : [],
    scores: scoresFor(state, players),
    staleMs,
    turnRemainingMs: turnRemaining,
  }
  if (revealed) {
    view.board = Array.isArray(state?.board) ? state.board.filter(isCard).slice(0, BOARD_COUNT) : []
    view.winnerNodes = Array.isArray(state?.winnerNodes)
      ? state.winnerNodes.map((node) => wireNode(node)).filter((node) => node !== null)
      : []
    view.pots = Array.isArray(state?.pots)
      ? state.pots.slice(0, 6).map((pot) => ({
          amount: Number.isInteger(pot?.amount) ? Math.max(0, pot.amount) : 0,
          winners: Array.isArray(pot?.winners)
            ? pot.winners.map((node) => wireNode(node)).filter((node) => node !== null)
            : [],
        }))
      : []
  }
  return view
}
