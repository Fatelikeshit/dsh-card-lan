/**
 * dsh-card-lan 炸金花（zhajinhua / three-card poker）— pure rules engine.
 *
 * No IO, no timers, no DSH imports: the host half owns sockets, seats and
 * transport. This module owns the 52-card deck, per-player chips / bets, the
 * betting turn loop, compare/showdown resolution and per-viewer private hands.
 *
 * Rules (PROTOCOL.md 7.14):
 *   - 2..6 players, one deck, three hidden cards each.
 *   - Every player starts with 1000 chips, pays a 10 ante each hand.
 *   - Hand order: triple (豹子) > straight flush (顺金) > flush (金花) >
 *     straight (顺子, A23 lowest / AKQ highest) > pair (对子) > high card.
 *     The "235 beats triple" special case is NOT enabled.
 *   - Actions: look (does not consume the turn), call (currentBet when seen,
 *     ceil(currentBet/2) while blind), raise (seen only, currentBet +10, at
 *     most 5 per hand), fold, compare (only with exactly two active players;
 *     pays the call amount, loser folds, a tie means the initiator loses).
 *   - Every active player acting once is one betting round; after 3 rounds the
 *     remaining players reveal and the best hand wins ("forced showdown").
 *   - Winner takes the pot; a player below 10 chips is topped up to 1000 at the
 *     start of the next hand.
 *
 * Exported API (mirrors the other engines):
 *   minPlayers, maxPlayers, createTable, addPlayer, startRound, applyAction,
 *   onTimeout, removePlayer, snapshot, botAction
 * Extra pure helpers: classify3, compareHands, labelOf, sortHand, buildDeck,
 * rankValue, isCard.
 * @module dsh-card-lan/games/zhajinhua
 */

/** Two to six players. */
export const minPlayers = 2
export const maxPlayers = 6

/** Chips every seat starts with (and is topped up to before a hand). */
export const START_CHIPS = 1000

/** Ante paid by every active player each hand. */
export const ANTE = 10

/** Initial bet per seen player (blind players pay half). */
export const BASE_BET = 10

/** Raise step and per-hand cap. */
export const RAISE_STEP = 10
export const MAX_RAISES = 5

/** Betting rounds before the forced showdown. */
export const MAX_BETTING_ROUNDS = 3

/** Ranks / suits of one standard deck. */
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const SUITS = ['S', 'H', 'D', 'C']

/** Natural rank values (2 lowest, A highest). */
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

/** Display text for ranks. */
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

/** Hand type strength (higher is better). */
const TYPE_STRENGTH = {
  high: 1,
  pair: 2,
  straight: 3,
  flush: 4,
  'straight-flush': 5,
  triple: 6,
}

/** Hand type display text. */
const TYPE_TEXT = {
  high: '单张',
  pair: '对子',
  straight: '顺子',
  flush: '金花',
  'straight-flush': '顺金',
  triple: '豹子',
}

/** One wire card: rank + suit. */
const CARD_RE = /^(?:[2-9]|10|[JQKA])[SHDC]$/

/** Log lines kept in the engine state (snapshot trims further). */
const LOG_LIMIT = 40

/* -------------------------------------------------------------------------- *
 * Cards / hand ranking
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

/**
 * Sequence detection for a 3-card straight. Returns the sequence's comparison
 * top (A23 -> 3 lowest, QKA -> 14 highest) or null when not a straight.
 */
function sequenceTop(values) {
  const [a, b, c] = values
  if (a === b || b === c || a === c) return null
  if (b === a + 1 && c === b + 1) return c
  // A23 wraps around: A counts as 1 for the lowest straight.
  if (a === 2 && b === 3 && c === 14) return 3
  return null
}

/**
 * Classify three cards. Returns
 * { type, strength, seqTop?, pairRank?, kicker?, values, label } or null.
 */
export function classify3(cards) {
  if (!Array.isArray(cards) || cards.length !== 3 || !cards.every(isCard)) return null
  const values = cards.map(cardValue).sort((a, b) => a - b)
  const suits = cards.map(suitOf)
  const sameSuit = suits[0] === suits[1] && suits[1] === suits[2]
  const threeOfKind = values[0] === values[2]
  const seqTop = sequenceTop(values)
  const pairValues = values[1] === values[0] ? values[0] : (values[2] === values[1] ? values[2] : null)
  let type
  if (threeOfKind) type = 'triple'
  else if (sameSuit && seqTop !== null) type = 'straight-flush'
  else if (sameSuit) type = 'flush'
  else if (seqTop !== null) type = 'straight'
  else if (pairValues !== null) type = 'pair'
  else type = 'high'
  const classified = {
    type,
    strength: TYPE_STRENGTH[type],
    values,
    label: '',
  }
  if (type === 'triple') {
    classified.rank = values[0]
  } else if (type === 'straight' || type === 'straight-flush') {
    classified.seqTop = seqTop
  } else if (type === 'pair') {
    classified.pairRank = pairValues
    classified.kicker = values.find((value) => value !== pairValues)
  }
  classified.label = handLabel(classified)
  return classified
}

/** Display label for a classified hand. */
function handLabel(classified) {
  const { type } = classified
  if (type === 'triple') return TYPE_TEXT[type] + ' ' + RANK_TEXT[classified.values[0]]
  if (type === 'pair') {
    return TYPE_TEXT[type] + ' ' + RANK_TEXT[classified.pairRank]
  }
  if (type === 'high') {
    return TYPE_TEXT[type] + ' ' + RANK_TEXT[classified.values[2]]
  }
  const seqTop = classified.seqTop
  if (seqTop === 3) return TYPE_TEXT[type] + ' A23'
  const lowText = RANK_TEXT[seqTop - 2] ?? String(seqTop - 2)
  return TYPE_TEXT[type] + ' ' + lowText + '-' + RANK_TEXT[seqTop]
}

/** Label for three cards (null/invalid -> '无效牌型'). */
export function labelOf(cards) {
  const classified = classify3(cards)
  return classified === null ? '无效牌型' : classified.label
}

/** Compare two classified hands: >0 when a wins, <0 when b wins, 0 tie. */
function compareClassified(a, b) {
  if (a.strength !== b.strength) return a.strength - b.strength
  switch (a.type) {
    case 'triple':
      return a.values[0] - b.values[0]
    case 'straight':
    case 'straight-flush':
      return a.seqTop - b.seqTop
    case 'pair':
      if (a.pairRank !== b.pairRank) return a.pairRank - b.pairRank
      return a.kicker - b.kicker
    default: {
      // flush / high: lexicographic from the highest card down.
      for (let index = 2; index >= 0; index -= 1) {
        if (a.values[index] !== b.values[index]) return a.values[index] - b.values[index]
      }
      return 0
    }
  }
}

/** Compare two three-card hands directly: >0 / <0 / 0. */
export function compareHands(cardsA, cardsB) {
  const a = classify3(cardsA)
  const b = classify3(cardsB)
  if (a === null || b === null) return 0
  return compareClassified(a, b)
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

/** Next active player node. */
function nextActiveNode(state, node) {
  const index = indexOfNode(state, node)
  if (index < 0) return null
  for (let step = 1; step <= state.players.length; step += 1) {
    const candidatePlayer = state.players[(index + step) % state.players.length]
    if (candidatePlayer.status === 'active') return candidatePlayer.node
  }
  return null
}

/** Next active player starting at an array index. */
function nextActiveFromIndex(state, index) {
  if (state.players.length === 0) return null
  for (let step = 0; step < state.players.length; step += 1) {
    const candidatePlayer = state.players[(index + step) % state.players.length]
    if (candidatePlayer.status === 'active') return candidatePlayer.node
  }
  return null
}

/** Active (not folded) players. */
function activePlayers(state) {
  return state.players.filter((player) => player.status === 'active')
}

/** Fresh player record. */
function makePlayer(raw) {
  return {
    node: typeof raw?.node === 'string' ? raw.node : '',
    nick: text(raw?.nick, 24) ?? '玩家',
    bot: raw?.bot === true,
    chips: Number.isInteger(raw?.chips) && raw.chips > 0 ? raw.chips : START_CHIPS,
    hand: [],
    bet: 0,
    status: 'active',
    seen: false,
    result: null,
    acted: false,
  }
}

/** Pay `amount` from a player into the pot (no-chips when too poor). */
function pay(state, player, amount) {
  if (!Number.isInteger(amount) || amount < 0) return { ok: false, error: 'bad-action' }
  if (player.chips < amount) return { ok: false, error: 'no-chips' }
  player.chips -= amount
  player.bet += amount
  state.pot += amount
  return { ok: true }
}

/** Amount this player must pay to call right now. */
function callAmount(state, player) {
  return player.seen ? state.currentBet : Math.ceil(state.currentBet / 2)
}

/* -------------------------------------------------------------------------- *
 * Table lifecycle
 * -------------------------------------------------------------------------- */

/** Build an idle table (2..6 seats). */
export function createTable(players = []) {
  const state = {
    game: 'zhajinhua',
    phase: 'idle',
    round: 0,
    players: (Array.isArray(players) ? players : []).slice(0, maxPlayers).map(makePlayer),
    turn: null,
    pot: 0,
    currentBet: BASE_BET,
    raises: 0,
    bettingRound: 0,
    firstNode: null,
    nextFirst: null,
    winnerNode: null,
    log: [],
    scores: {},
    updatedAt: 0,
  }
  for (const player of state.players) ensureScore(state, player.node)
  state.firstNode = state.players[0]?.node ?? null
  state.nextFirst = state.firstNode
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
  if (state.firstNode === null) {
    state.firstNode = player.node
    state.nextFirst = player.node
  }
  return { ok: true }
}

/** Start the next hand: top-up, deal, antes, first turn. */
export function startRound(state, rng = Math.random) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (state.players.length < minPlayers) return { ok: false, error: 'no-players' }
  if (state.phase === 'bidding') return { ok: false, error: 'bad-phase' }

  state.round += 1
  state.phase = 'bidding'
  state.log = []
  state.pot = 0
  state.currentBet = BASE_BET
  state.raises = 0
  state.bettingRound = 0
  state.winnerNode = null
  const deck = shuffle(buildDeck(), rng)
  state.players.forEach((player, index) => {
    if (!Number.isInteger(player.chips) || player.chips < ANTE) player.chips = START_CHIPS
    player.hand = sortHand(deck.slice(index * 3, index * 3 + 3))
    player.bet = 0
    player.status = 'active'
    player.seen = false
    player.result = null
    player.acted = false
    ensureScore(state, player.node)
  })
  // Antes.
  for (const player of state.players) {
    const ante = Math.min(ANTE, player.chips)
    player.chips -= ante
    player.bet += ante
    state.pot += ante
  }
  // First actor: seat 0 on the first hand, previous winner afterwards.
  const preferred = state.nextFirst !== null
    && state.players.some((player) => player.node === state.nextFirst)
    ? state.nextFirst
    : state.players[0].node
  state.turn = preferred
  state.firstNode = preferred
  log(state, '第 ' + state.round + ' 局开始，底注 ' + ANTE)
  log(state, (playerOf(state, preferred)?.nick ?? '玩家') + ' 先行动')
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------------- */

/** Settle the pot for one winner. */
function settle(state, winnerNode) {
  const winner = playerOf(state, winnerNode)
  state.phase = 'result'
  state.turn = null
  state.winnerNode = winnerNode
  state.nextFirst = winnerNode
  if (winner !== undefined) winner.chips += state.pot
  for (const player of state.players) {
    const win = player.node === winnerNode
    player.result = win ? 'win' : 'lose'
    const bucket = ensureScore(state, player.node)
    if (win) bucket.win += 1
    else bucket.lose += 1
  }
  log(state, (winner?.nick ?? '玩家') + ' 赢下底池 ' + state.pot)
}

/** Reveal remaining hands and pick the best (forced showdown). */
function showdown(state) {
  const active = activePlayers(state)
  if (active.length === 0) return
  let best = active[0]
  let bestHand = classify3(best.hand)
  for (const player of active.slice(1)) {
    const hand = classify3(player.hand)
    if (hand === null) continue
    if (bestHand === null || compareClassified(hand, bestHand) > 0) {
      best = player
      bestHand = hand
    }
  }
  log(state, '3 轮已满，强制摊牌')
  settle(state, best.node)
}

/**
 * Finish the current player's turn: count betting rounds, move on or settle.
 * Used by call / raise / fold (look does not consume the turn).
 */
function completeTurn(state, player) {
  player.acted = true
  const active = activePlayers(state)
  if (active.length <= 1) {
    settle(state, active.length === 1 ? active[0].node : player.node)
    return
  }
  if (active.every((entry) => entry.acted === true)) {
    state.bettingRound += 1
    if (state.bettingRound >= MAX_BETTING_ROUNDS) {
      showdown(state)
      return
    }
    for (const entry of state.players) entry.acted = false
  }
  state.turn = nextActiveNode(state, player.node)
}

/** look: reveal own cards without consuming the turn. */
function applyLook(state, player) {
  if (player.seen === true) return { ok: true }
  player.seen = true
  log(state, player.nick + ' 看牌')
  return { ok: true }
}

/** call: pay the current call amount. */
function applyCall(state, player) {
  const amount = callAmount(state, player)
  const paid = pay(state, player, amount)
  if (!paid.ok) return paid
  log(state, player.nick + ' 跟注 ' + amount)
  completeTurn(state, player)
  return { ok: true }
}

/** raise: seen only, currentBet +10, at most 5 per hand, pays the new bet. */
function applyRaise(state, player) {
  if (player.seen !== true) return { ok: false, error: 'bad-action' }
  if (state.raises >= MAX_RAISES) return { ok: false, error: 'raise-cap' }
  const nextBet = state.currentBet + RAISE_STEP
  const paid = pay(state, player, nextBet)
  if (!paid.ok) return paid
  state.currentBet = nextBet
  state.raises += 1
  log(state, player.nick + ' 加注到 ' + state.currentBet)
  completeTurn(state, player)
  return { ok: true }
}

/** fold: give up the hand. */
function applyFold(state, player) {
  player.status = 'folded'
  log(state, player.nick + ' 弃牌')
  completeTurn(state, player)
  return { ok: true }
}

/** compare: only with two active players; tie means the initiator loses. */
function applyCompare(state, player) {
  const active = activePlayers(state)
  if (active.length !== 2) return { ok: false, error: 'compare-unavailable' }
  const opponent = active.find((entry) => entry.node !== player.node)
  if (opponent === undefined) return { ok: false, error: 'compare-unavailable' }
  const amount = callAmount(state, player)
  const paid = pay(state, player, amount)
  if (!paid.ok) return paid
  const mine = classify3(player.hand)
  const theirs = classify3(opponent.hand)
  const mineWins = mine !== null && (theirs === null || compareClassified(mine, theirs) > 0)
  log(state, player.nick + ' 比牌 ' + (mine === null ? '无效' : mine.label)
    + ' vs ' + (theirs === null ? '无效' : theirs.label))
  if (mineWins) opponent.status = 'folded'
  else player.status = 'folded'
  const remaining = activePlayers(state)
  if (remaining.length <= 1) {
    settle(state, remaining.length === 1 ? remaining[0].node : player.node)
  } else {
    completeTurn(state, player)
  }
  return { ok: true }
}

/** Apply one action from `node`. */
export function applyAction(state, node, action) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (node === undefined || node === null) return { ok: false, error: 'bad-action' }
  const player = playerOf(state, node)
  if (player === undefined) return { ok: false, error: 'not-seated' }
  if (state.phase !== 'bidding') return { ok: false, error: 'bad-phase' }
  if (state.turn !== node) return { ok: false, error: 'not-your-turn' }
  if (player.status !== 'active') return { ok: false, error: 'not-your-turn' }
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, error: 'bad-action' }
  }
  switch (action.type) {
    case 'look': return applyLook(state, player)
    case 'call': return applyCall(state, player)
    case 'raise': return applyRaise(state, player)
    case 'fold': return applyFold(state, player)
    case 'compare': return applyCompare(state, player)
    default: return { ok: false, error: 'bad-action' }
  }
}

/** Timeout move: always fold. */
export function onTimeout(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (state.phase !== 'bidding' || state.turn !== node) return null
  const player = playerOf(state, node)
  if (player === undefined || player.status !== 'active') return null
  return { type: 'fold' }
}

/** Bot move (v8.0 has no zhajinhua bots; exported for parity). */
export function botAction(state, node) {
  return onTimeout(state, node)
}

/* -------------------------------------------------------------------------- *
 * Leaving / disconnects
 * -------------------------------------------------------------------------- */

/** Remove one player; a mid-hand leave folds the seat and may settle. */
export function removePlayer(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const index = indexOfNode(state, node)
  if (index < 0) return { ok: false, error: 'unknown-player' }
  const wasTurn = state.turn === node
  const player = state.players[index]
  if (state.phase === 'idle' || state.phase === 'result') {
    state.players.splice(index, 1)
    if (state.players.length === 0) {
      state.firstNode = null
      state.nextFirst = null
    } else if (state.nextFirst === node) {
      state.nextFirst = state.players[0].node
    }
    return { ok: true }
  }
  // bidding: the leaving player folds and is removed from the seat list.
  player.status = 'folded'
  log(state, player.nick + ' 离开牌桌')
  state.players.splice(index, 1)
  const active = activePlayers(state)
  if (active.length === 0) {
    state.phase = 'idle'
    state.turn = null
    return { ok: true }
  }
  if (active.length === 1) {
    settle(state, active[0].node)
    return { ok: true }
  }
  if (wasTurn) state.turn = nextActiveFromIndex(state, index)
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
 * Build the per-viewer `view.table` / state.table JSON (PROTOCOL.md 7.14).
 * Hands stay hidden until the viewer has looked (or the hand is finished).
 */
export function snapshot(state, viewerNode, meta = {}) {
  const safeMeta = meta !== null && typeof meta === 'object' ? meta : {}
  const role = safeMeta.role === 'spectator' ? 'spectator' : (safeMeta.role === 'host' ? 'host' : 'player')
  const nodes = Array.isArray(state?.players) ? state.players : []
  const viewerIsPlayer = nodes.some((player) => player.node === viewerNode)
  const showSelf = role !== 'spectator' && viewerIsPlayer
  const viewer = showSelf ? playerOf(state, viewerNode) : undefined
  const revealAll = state?.phase === 'result'

  const players = nodes.slice(0, maxPlayers).map((player) => {
    const entry = {
      node: player.node,
      nick: player.nick,
      self: showSelf && player.node === viewerNode,
      chips: Number.isInteger(player.chips) ? Math.max(0, player.chips) : 0,
      bet: Number.isInteger(player.bet) ? Math.max(0, player.bet) : 0,
      status: player.status === 'folded' ? 'folded' : (player.status === 'out' ? 'out' : 'active'),
      seen: player.seen === true,
      result: player.result === 'win' || player.result === 'lose' ? player.result : null,
    }
    if (revealAll) entry.cards = Array.isArray(player.hand) ? player.hand.slice(0, 3) : []
    return entry
  })

  const myCards = (() => {
    if (role === 'spectator' || viewer === undefined) return []
    if (revealAll || viewer.seen === true) return Array.isArray(viewer.hand) ? viewer.hand.slice(0, 3) : []
    return []
  })()

  const staleMs = Number.isInteger(safeMeta.staleMs) ? Math.max(0, safeMeta.staleMs) : 0
  const turnRemaining = Number.isInteger(safeMeta.turnRemainingMs)
    ? Math.min(300_000, Math.max(0, safeMeta.turnRemainingMs))
    : null

  const view = {
    game: 'zhajinhua',
    role,
    hostNode: wireNode(safeMeta.hostNode) ?? '',
    phase: state?.phase === 'bidding' || state?.phase === 'result' ? state.phase : 'idle',
    round: Number.isInteger(state?.round) ? Math.max(0, state.round) : 0,
    turn: wireNode(state?.turn),
    pot: Number.isInteger(state?.pot) ? Math.max(0, state.pot) : 0,
    currentBet: Number.isInteger(state?.currentBet) ? Math.max(0, state.currentBet) : BASE_BET,
    raises: Number.isInteger(state?.raises) ? Math.min(MAX_RAISES, Math.max(0, state.raises)) : 0,
    myCards,
    players,
    log: Array.isArray(state?.log)
      ? state.log.map((line) => text(line, 80)).filter((line) => line !== undefined).slice(-8)
      : [],
    scores: scoresFor(state, players),
    staleMs,
    turnRemainingMs: turnRemaining,
  }
  if (revealAll) view.winnerNode = wireNode(state?.winnerNode)
  return view
}
