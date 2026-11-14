/**
 * dsh-card-lan rules engine — pure blackjack (21 点) logic.
 *
 * No IO, no timers, no DSH imports: the host half owns sockets, the engine only
 * owns cards and the state machine. Every function here is deterministic given
 * the injected `rng`, so tests can drive exact hands.
 *
 * State model (one table):
 *   phase: 'idle' | 'playing' | 'dealer' | 'result'
 *   players: [{ node, nick, cards, status, result }]
 *     status: 'playing' | 'stand' | 'bust' | 'blackjack'
 *     result: null | 'win' | 'lose' | 'push'
 *   dealer: { cards, hidden }
 *   turn: node of the player to act (null outside 'playing')
 *
 * Card encoding: rank + suit, e.g. 'AS' (A♠), '10H' (10♥), 'KD' (K♦), '7C' (7♣).
 * @module dsh-card-lan/engine
 */

/** Ranks in deck order. */
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

/** Suits in deck order. */
const SUITS = ['S', 'H', 'D', 'C']

/** Hard cap of players at one table (one deck, no reshuffle mid-round). */
export const MAX_PLAYERS = 4

/** Dealer stands on 17 and up (soft 17 also stands — simplest MVP rule). */
const DEALER_STAND = 17

/** Log lines kept for the UI. */
const LOG_LIMIT = 40

/** A fresh, ordered 52-card deck. */
export function freshDeck() {
  const deck = []
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit)
  }
  return deck
}

/** Fisher–Yates shuffle over a copy; `rng` returns [0, 1). */
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

/** Point value of one card with the ace counted as 11. */
export function cardValue(card) {
  if (typeof card !== 'string' || card.length < 2) return 0
  const rank = card.slice(0, -1)
  if (rank === 'A') return 11
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10
  const numeric = Number(rank)
  return Number.isFinite(numeric) ? numeric : 0
}

/** Best (highest not busting) total for a hand. */
export function handValue(cards) {
  let total = 0
  let aces = 0
  for (const card of Array.isArray(cards) ? cards : []) {
    total += cardValue(card)
    if (typeof card === 'string' && card.startsWith('A')) aces += 1
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }
  return total
}

/** Two cards totalling exactly 21 (a natural). */
export function isBlackjack(cards) {
  return Array.isArray(cards) && cards.length === 2 && handValue(cards) === 21
}

/** What the table shows for the dealer: the hole card stays hidden while playing. */
export function visibleDealer(table) {
  if (table === null || table === undefined || table.dealer === undefined) {
    return { cards: [], hidden: false, total: 0 }
  }
  const all = Array.isArray(table.dealer.cards) ? table.dealer.cards : []
  const hidden = table.phase === 'playing'
  const cards = hidden ? all.slice(0, 1) : all.slice()
  return { cards, hidden, total: handValue(cards) }
}

/** Build an empty table (phase 'idle') for the given lobby players. */
export function newTable(players = []) {
  return {
    phase: 'idle',
    round: 0,
    players: (Array.isArray(players) ? players : []).map((player) => ({
      node: player.node,
      nick: player.nick,
      cards: [],
      status: 'playing',
      result: null,
    })),
    dealer: { cards: [], hidden: true },
    turn: null,
    deck: [],
    log: [],
    updatedAt: 0,
  }
}

/** Append one log line and bump the table clock. */
function note(table, text) {
  const now = Date.now()
  table.log.push({ at: now, text })
  if (table.log.length > LOG_LIMIT) table.log.splice(0, table.log.length - LOG_LIMIT)
  table.updatedAt = now
}

/** Draw the top card, rebuilding the deck if it ran dry (MVP: fresh shoe). */
function draw(table) {
  if (!Array.isArray(table.deck) || table.deck.length === 0) {
    table.deck = shuffle(freshDeck(), Math.random)
  }
  return table.deck.pop()
}

/** Move the turn to the next player that still has to act, or run the dealer out. */
function advance(table) {
  const next = table.players.find((player) => player.status === 'playing')
  table.turn = next === undefined ? null : next.node
  if (table.turn === null) finishDealer(table)
}

/** Reveal the hole card, draw to the stand rule and settle the round. */
function finishDealer(table) {
  table.phase = 'dealer'
  table.dealer.hidden = false
  note(table, '庄家亮出底牌')
  while (handValue(table.dealer.cards) < DEALER_STAND) {
    table.dealer.cards.push(draw(table))
    note(table, '庄家补了一张牌')
  }
  settle(table)
}

/** Compare every hand with the dealer and write each player's result. */
function settle(table) {
  const dealerTotal = handValue(table.dealer.cards)
  const dealerBlackjack = isBlackjack(table.dealer.cards)
  for (const player of table.players) {
    const total = handValue(player.cards)
    if (player.status === 'bust') {
      player.result = 'lose'
    } else if (isBlackjack(player.cards)) {
      player.result = dealerBlackjack ? 'push' : 'win'
    } else if (dealerBlackjack) {
      player.result = 'lose'
    } else if (dealerTotal > 21 || total > dealerTotal) {
      player.result = 'win'
    } else if (total < dealerTotal) {
      player.result = 'lose'
    } else {
      player.result = 'push'
    }
  }
  note(table, dealerTotal > 21 ? '庄家爆牌' : '庄家 ' + dealerTotal + ' 点，本局结束')
  table.phase = 'result'
  table.turn = null
}

/**
 * Start a round on the table (also used for "下一局").
 * Re-deals to the same players, keeping their nicknames.
 */
export function startRound(table, rng = Math.random) {
  if (table === null || table === undefined || !Array.isArray(table.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (table.players.length === 0) return { ok: false, error: 'no-players' }
  if (table.players.length > MAX_PLAYERS) return { ok: false, error: 'too-many-players' }
  table.round += 1
  table.deck = shuffle(freshDeck(), rng)
  table.log = []
  table.dealer = { cards: [], hidden: true }
  for (const player of table.players) {
    player.cards = []
    player.status = 'playing'
    player.result = null
  }
  // Deal two passes: every player, then the dealer, twice.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const player of table.players) player.cards.push(draw(table))
    table.dealer.cards.push(draw(table))
  }
  for (const player of table.players) {
    if (isBlackjack(player.cards)) {
      player.status = 'blackjack'
      note(table, player.nick + ' 拿到黑杰克')
    }
  }
  note(table, '第 ' + table.round + ' 局开始')
  table.phase = 'playing'
  advance(table)
  return { ok: true }
}

/**
 * Apply one player action ('hit' | 'stand') to the table.
 * Only the player whose node equals `table.turn` may act.
 */
export function applyAction(table, node, type, rng = Math.random) {
  if (table === null || table === undefined) return { ok: false, error: 'no-table' }
  if (type !== 'hit' && type !== 'stand') return { ok: false, error: 'bad-action' }
  if (table.phase !== 'playing') return { ok: false, error: 'not-playing' }
  if (table.turn !== node) return { ok: false, error: 'not-your-turn' }
  const player = table.players.find((entry) => entry.node === node)
  if (player === undefined) return { ok: false, error: 'unknown-player' }
  if (type === 'hit') {
    player.cards.push(draw(table))
    const total = handValue(player.cards)
    if (total > 21) {
      player.status = 'bust'
      note(table, player.nick + ' 爆牌')
    } else if (total === 21) {
      player.status = 'stand'
      note(table, player.nick + ' 21 点停牌')
    } else {
      note(table, player.nick + ' 要了一张牌')
    }
  } else {
    player.status = 'stand'
    note(table, player.nick + ' 停牌')
  }
  advance(table)
  return { ok: true }
}

/** Start the next round with the same players. */
export function nextRound(table, rng = Math.random) {
  return startRound(table, rng)
}

/**
 * Basic-strategy bot move for one seat (v16): hit below 17, otherwise stand.
 * Returns 'hit' | 'stand', or null when it is not that player's turn.
 */
export function botAction(table, node) {
  if (table === null || table === undefined || !Array.isArray(table.players)) return null
  if (table.phase !== 'playing' || table.turn !== node) return null
  const player = table.players.find((entry) => entry.node === node)
  if (player === undefined || player.status !== 'playing') return null
  const cards = Array.isArray(player.cards) ? player.cards : []
  return handValue(cards) < 17 ? 'hit' : 'stand'
}
