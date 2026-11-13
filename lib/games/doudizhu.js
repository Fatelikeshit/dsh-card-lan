/**
 * dsh-card-lan 斗地主（doudizhu）— pure three-player rules engine.
 *
 * No IO, no timers, no DSH imports: the host half owns sockets and scheduling,
 * this module only owns cards, phases and the turn state machine. Every entry
 * point is deterministic given the injected `rng`, so tests can drive exact
 * hands (mutate `state.players[i].hand` after the deal if needed).
 *
 * Wire card encoding follows the blackjack module's style:
 *   rank + suit 3S..2C, '10H', 'JS', ... ; jokers are 'BJ' (small) and 'RJ' (big).
 * Rank order: 3<4<5<6<7<8<9<10<J<Q<K<A<2<BJ<RJ.
 *
 * Supported combinations (v1):
 *   single / pair / triple / triple + one / triple + pair,
 *   straight (>=5, no 2/jokers), pair straight (>=3 pairs, no 2/jokers),
 *   plane (>=2 consecutive triples, no wings, no 2/jokers),
 *   bomb (four of a kind), rocket (BJ + RJ).
 * Four-with-two and plane-with-wings are rejected with `bad-cards`.
 *
 * Exported API (host contract, PROTOCOL.md 7.3/7.4):
 *   minPlayers, maxPlayers, createTable, addPlayer, startRound, applyAction,
 *   onTimeout, removePlayer, snapshot
 * Extra pure helpers (handy for tests): classify, beats, labelOf, sortHand,
 * buildDeck.
 * @module dsh-card-lan/games/doudizhu
 */

/** Exactly three players in v1. */
export const minPlayers = 3
export const maxPlayers = 3

/** Ranks in ascending order (no jokers). */
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']

/** Suits in deck order. */
const SUITS = ['S', 'H', 'D', 'C']

/** Rank text -> point value (2 = 15, BJ = 16, RJ = 17). */
const RANK_VALUE = {
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
  2: 15,
  BJ: 16,
  RJ: 17,
}

/** Point value -> display text. */
const VALUE_TEXT = {
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
  15: '2',
  16: '小王',
  17: '大王',
}

/** Log lines kept in the engine state (snapshot trims further). */
const LOG_LIMIT = 40

/** One wire card: normal rank+suit, or a joker. */
const CARD_RE = /^(?:(?:[3-9]|10|[JQKA2])[SHDC]|BJ|RJ)$/

/** Highest normal rank usable in straights / pair straights / planes. */
const MAX_STRAIGHT_RANK = 14 // A

/** Lowest rank in the deck (needed for consecutive runs). */
const MIN_RANK = 3

/* -------------------------------------------------------------------------- *
 * Cards
 * -------------------------------------------------------------------------- */

/** True for a syntactically valid wire card. */
export function isCard(card) {
  return typeof card === 'string' && CARD_RE.test(card)
}

/** Point value of one wire card (0 for garbage). */
export function cardValue(card) {
  if (!isCard(card)) return 0
  const rank = card === 'BJ' || card === 'RJ' ? card : card.slice(0, -1)
  return RANK_VALUE[rank] ?? 0
}

/** Ascending sort by rank (suit/secondary order only for stability). */
export function sortHand(cards) {
  if (!Array.isArray(cards)) return []
  return cards.slice().sort((a, b) => {
    const diff = cardValue(a) - cardValue(b)
    if (diff !== 0) return diff
    return String(a).localeCompare(String(b))
  })
}

/** A fresh 54-card deck (3..2 × 4 suits + two jokers). */
export function buildDeck() {
  const deck = []
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit)
  }
  deck.push('BJ', 'RJ')
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

/** True when sorted distinct values are consecutive integers. */
function isConsecutive(values) {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1] + 1) return false
  }
  return true
}

/**
 * Classify one play. Returns null for an invalid / unsupported combination,
 * otherwise { type, size, rank } where `size` is the card count and `rank` is
 * the comparison rank (highest rank for sequences).
 */
export function classify(cards) {
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 20) return null
  if (!cards.every(isCard)) return null
  const values = cards.map(cardValue).sort((a, b) => a - b)
  const n = values.length
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const groups = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value - b.value)

  // Rocket: the only legal two-joker play.
  if (n === 2 && groups.length === 2 && groups[0].value === 16 && groups[1].value === 17) {
    return { type: 'rocket', size: 2, rank: 17 }
  }
  if (n === 1) return { type: 'single', size: 1, rank: values[0] }
  if (n === 2 && groups.length === 1) return { type: 'pair', size: 2, rank: values[0] }
  if (n === 3 && groups.length === 1) return { type: 'triple', size: 3, rank: values[0] }
  if (n === 4 && groups.length === 1) return { type: 'bomb', size: 4, rank: values[0] }
  if (n === 4 && groups.length === 2) {
    const triple = groups.find((group) => group.count === 3)
    const single = groups.find((group) => group.count === 1)
    if (triple !== undefined && single !== undefined) {
      return { type: 'triple-one', size: 4, rank: triple.value }
    }
  }
  if (n === 5 && groups.length === 2) {
    const triple = groups.find((group) => group.count === 3)
    const pair = groups.find((group) => group.count === 2)
    if (triple !== undefined && pair !== undefined) {
      return { type: 'triple-two', size: 5, rank: triple.value }
    }
  }
  // Straight: >=5 singles, consecutive, A high (no 2/jokers).
  if (n >= 5 && groups.every((group) => group.count === 1)) {
    const vs = groups.map((group) => group.value)
    if (vs[vs.length - 1] <= MAX_STRAIGHT_RANK && isConsecutive(vs)) {
      return { type: 'straight', size: n, rank: vs[vs.length - 1] }
    }
  }
  // Pair straight: >=3 consecutive pairs, A high (no 2/jokers).
  if (n >= 6 && n % 2 === 0 && groups.every((group) => group.count === 2)) {
    const vs = groups.map((group) => group.value)
    if (vs.length >= 3 && vs[vs.length - 1] <= MAX_STRAIGHT_RANK && isConsecutive(vs)) {
      return { type: 'pair-straight', size: n, rank: vs[vs.length - 1] }
    }
  }
  // Plane: >=2 consecutive triples, no wings, A high (no 2/jokers).
  if (n >= 6 && n % 3 === 0 && groups.every((group) => group.count === 3)) {
    const vs = groups.map((group) => group.value)
    if (vs.length >= 2 && vs[vs.length - 1] <= MAX_STRAIGHT_RANK && isConsecutive(vs)) {
      return { type: 'plane', size: n, rank: vs[vs.length - 1] }
    }
  }
  return null
}

/** True when `candidate` beats `previous` (both classify() results). */
export function beats(candidate, previous) {
  if (candidate === null || candidate === undefined) return false
  if (previous === null || previous === undefined) return true
  if (candidate.type === 'rocket') return previous.type !== 'rocket'
  if (previous.type === 'rocket') return false
  if (candidate.type === 'bomb') {
    return previous.type === 'bomb' ? candidate.rank > previous.rank : true
  }
  if (previous.type === 'bomb') return false
  if (candidate.type !== previous.type) return false
  if (candidate.size !== previous.size) return false
  return candidate.rank > previous.rank
}

/** Human-readable label, e.g. '对 A', '顺子 3-7', '王炸'. */
export function labelOf(cards) {
  const info = classify(cards)
  if (info === null) return '无效牌型'
  const values = cards.map(cardValue).sort((a, b) => a - b)
  const highest = VALUE_TEXT[info.rank] ?? String(info.rank)
  const lowest = VALUE_TEXT[values[0]] ?? String(values[0])
  switch (info.type) {
    case 'single': return '单 ' + highest
    case 'pair': return '对 ' + highest
    case 'triple': return '三张 ' + highest
    case 'triple-one': return '三带一 ' + highest
    case 'triple-two': return '三带二 ' + highest
    case 'straight': return '顺子 ' + lowest + '-' + highest
    case 'pair-straight': return '双顺 ' + lowest + '-' + highest
    case 'plane': return '飞机 ' + lowest + '-' + highest
    case 'bomb': return '炸弹 ' + highest
    case 'rocket': return '王炸'
    default: return '出牌'
  }
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

/** Append one log line (strings, bounded). */
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

/** Next player node in seat order (all players, used while bidding). */
function nextNode(state, node) {
  const index = indexOfNode(state, node)
  if (index < 0 || state.players.length === 0) return null
  return state.players[(index + 1) % state.players.length].node
}

/** Next player node that still has cards. */
function nextActiveNode(state, node) {
  const index = indexOfNode(state, node)
  if (index < 0) return null
  for (let step = 1; step <= state.players.length; step += 1) {
    const candidate = state.players[(index + step) % state.players.length]
    if (candidate.status === 'playing') return candidate.node
  }
  return null
}

/** Next active player starting at an array index (used after a removal). */
function nextActiveFromIndex(state, index) {
  if (state.players.length === 0) return null
  for (let step = 0; step < state.players.length; step += 1) {
    const candidate = state.players[(index + step) % state.players.length]
    if (candidate.status === 'playing') return candidate.node
  }
  return null
}

/** Fresh player record for the engine state. */
function makePlayer(raw) {
  return {
    node: typeof raw?.node === 'string' ? raw.node : '',
    nick: text(raw?.nick, 24) ?? '玩家',
    bot: raw?.bot === true,
    hand: [],
    status: 'playing',
    role: null,
    result: null,
    bidding: null,
  }
}

/* -------------------------------------------------------------------------- *
 * Table lifecycle
 * -------------------------------------------------------------------------- */

/** Build an idle three-player table around the given seats. */
export function createTable(players = []) {
  const state = {
    game: 'doudizhu',
    phase: 'idle',
    round: 0,
    players: (Array.isArray(players) ? players : []).slice(0, maxPlayers).map(makePlayer),
    turn: null,
    landlord: null,
    bottom: [],
    lastPlay: null,
    lastPlayer: null,
    passes: 0,
    mustPlay: false,
    winner: null,
    log: [],
    scores: {},
    updatedAt: 0,
  }
  for (const player of state.players) ensureScore(state, player.node)
  return state
}

/** Add one seat (host calls this for joins outside an active round). */
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

/**
 * Deal a fresh round. `logLines` are prepended (used by the "everyone passed"
 * redeal). Bidding starts at seat (round-1) % 3.
 */
function dealRound(state, rng, logLines = []) {
  state.round += 1
  state.phase = 'bidding'
  state.landlord = null
  state.turn = null
  state.bottom = []
  state.lastPlay = null
  state.lastPlayer = null
  state.passes = 0
  state.mustPlay = false
  state.winner = null
  state.log = []
  for (const line of logLines) log(state, line)

  const deck = shuffle(buildDeck(), rng)
  state.players.forEach((player, index) => {
    player.hand = sortHand(deck.slice(index * 17, index * 17 + 17))
    player.status = 'playing'
    player.role = null
    player.result = null
    player.bidding = null
    ensureScore(state, player.node)
  })
  state.bottom = deck.slice(51)
  const starter = ((state.round - 1) % state.players.length + state.players.length) % state.players.length
  state.turn = state.players[starter].node
  log(state, '第 ' + state.round + ' 局开始，叫地主')
}

/** Start the next round (host checks phase idle/result before calling). */
export function startRound(state, rng = Math.random) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (state.players.length < minPlayers) return { ok: false, error: 'no-players' }
  if (state.players.length > maxPlayers) return { ok: false, error: 'too-many-players' }
  if (state.phase === 'bidding' || state.phase === 'playing') {
    return { ok: false, error: 'bad-phase' }
  }
  dealRound(state, rng)
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------------- */

/** Reveal roles and settle the round for the current players. */
function settle(state, side, reason) {
  state.phase = 'result'
  state.turn = null
  state.mustPlay = false
  state.passes = 0
  state.winner = side
  // Reveal the bottom cards now that the round is over (snapshot hides them).
  for (const player of state.players) player.bidding = null
  for (const player of state.players) {
    const win = side === 'landlord' ? player.role === 'landlord' : player.role === 'farmer'
    player.result = win ? 'win' : 'lose'
    const bucket = ensureScore(state, player.node)
    if (win) bucket.win += 1
    else bucket.lose += 1
  }
  if (reason !== undefined) log(state, reason)
  log(state, side === 'landlord' ? '地主胜' : '农民胜')
}

/** Bidding branch of applyAction. */
function applyBid(state, player, action) {
  if (state.phase !== 'bidding') return { ok: false, error: 'bad-phase' }
  if (typeof action.bid !== 'boolean') return { ok: false, error: 'bad-action' }
  if (action.bid === true) {
    player.bidding = true
    state.landlord = player.node
    for (const other of state.players) {
      other.role = other.node === player.node ? 'landlord' : 'farmer'
    }
    player.hand = sortHand(player.hand.concat(state.bottom))
    state.bottom = []
    for (const other of state.players) other.bidding = null
    state.phase = 'playing'
    state.turn = player.node
    state.lastPlay = null
    state.lastPlayer = null
    state.passes = 0
    state.mustPlay = true
    log(state, player.nick + ' 叫地主，成为地主')
    return { ok: true }
  }
  player.bidding = false
  log(state, player.nick + ' 不叫')
  if (state.players.every((other) => other.bidding === false)) {
    // Nobody called: redeal (round +1), first bidder rotates.
    dealRound(state, Math.random, ['三家都不叫，重新发牌'])
    return { ok: true }
  }
  state.turn = nextNode(state, player.node)
  return { ok: true }
}

/** Playing branch: play a combination. */
function applyPlay(state, player, action) {
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (!Array.isArray(action.cards) || action.cards.length === 0) {
    return { ok: false, error: 'bad-cards' }
  }
  const cards = action.cards.slice(0, 20)
  if (!cards.every(isCard)) return { ok: false, error: 'bad-cards' }
  // The cards must really be in hand (multiset check).
  const hand = player.hand.slice()
  for (const card of cards) {
    const index = hand.indexOf(card)
    if (index < 0) return { ok: false, error: 'bad-cards' }
    hand.splice(index, 1)
  }
  const info = classify(cards)
  if (info === null) return { ok: false, error: 'bad-cards' }
  if (state.lastPlay !== null && state.lastPlay.node !== player.node) {
    if (!beats(info, state.lastPlay.info)) return { ok: false, error: 'bad-cards' }
  }
  player.hand = hand
  state.lastPlay = { node: player.node, cards: sortHand(cards), label: labelOf(cards), info }
  state.lastPlayer = player.node
  state.passes = 0
  log(state, player.nick + ' 出牌 ' + state.lastPlay.label)
  if (player.hand.length === 0) {
    player.status = 'out'
    const side = player.node === state.landlord ? 'landlord' : 'farmers'
    settle(state, side, player.nick + ' 出完牌')
    return { ok: true }
  }
  state.mustPlay = false
  state.turn = nextActiveNode(state, player.node)
  return { ok: true }
}

/** Playing branch: pass. */
function applyPass(state, player) {
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    return { ok: false, error: 'must-play' }
  }
  state.passes += 1
  log(state, player.nick + ' 不要')
  const active = state.players.filter((other) => other.status === 'playing')
  if (state.passes >= active.length - 1) {
    // Everyone else passed: the last player leads a fresh trick.
    const leader = state.lastPlayer
    state.lastPlay = null
    state.passes = 0
    state.mustPlay = true
    const leaderPlayer = playerOf(state, leader)
    state.turn = leaderPlayer !== undefined && leaderPlayer.status === 'playing'
      ? leaderPlayer.node
      : nextActiveNode(state, player.node)
    if (leaderPlayer !== undefined) log(state, leaderPlayer.nick + ' 获得出牌权')
    return { ok: true }
  }
  state.mustPlay = false
  state.turn = nextActiveNode(state, player.node)
  return { ok: true }
}

/**
 * Apply one action from `node`.
 * Action shapes: { type:'bid', bid:boolean }, { type:'play', cards:[...] },
 * { type:'pass' }.
 */
export function applyAction(state, node, action) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (node === undefined || node === null) return { ok: false, error: 'bad-action' }
  const player = playerOf(state, node)
  if (player === undefined) return { ok: false, error: 'not-seated' }
  if (state.phase !== 'bidding' && state.phase !== 'playing') {
    return { ok: false, error: 'bad-phase' }
  }
  if (state.turn !== node) return { ok: false, error: 'not-your-turn' }
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, error: 'bad-action' }
  }
  if (action.type === 'bid') return applyBid(state, player, action)
  if (action.type === 'play') return applyPlay(state, player, action)
  if (action.type === 'pass') return applyPass(state, player)
  return { ok: false, error: 'bad-action' }
}

/* -------------------------------------------------------------------------- *
 * Bot decisions (PROTOCOL.md 7.8)
 * -------------------------------------------------------------------------- */

/** Group a hand by rank value: Map<value, cards[]> (each list sorted). */
function groupByRank(hand) {
  const groups = new Map()
  for (const card of sortHand(hand)) {
    const value = cardValue(card)
    if (value === 0) continue
    if (!groups.has(value)) groups.set(value, [])
    groups.get(value).push(card)
  }
  return groups
}

/** Ascending rank values present in a group map. */
function sortedValues(groups) {
  return [...groups.keys()].sort((a, b) => a - b)
}

/** Lowest rank with at least one spare card, excluding one rank. */
function lowestKickerRank(groups, exclude) {
  for (const value of sortedValues(groups)) {
    if (value === exclude) continue
    if (groups.get(value).length >= 1) return value
  }
  return 0
}

/** Lowest pair rank that is not `exclude`. */
function lowestPairRank(groups, exclude) {
  for (const value of sortedValues(groups)) {
    if (value === exclude) continue
    if (groups.get(value).length >= 2) return value
  }
  return 0
}

/** Pick one card per rank for `length` consecutive ranks above minHighest. */
function consecutiveRun(groups, perRank, length, minHighest) {
  for (let start = MIN_RANK; start + length - 1 <= MAX_STRAIGHT_RANK; start += 1) {
    const highest = start + length - 1
    if (highest <= minHighest) continue
    let ok = true
    for (let value = start; value <= highest; value += 1) {
      const cards = groups.get(value)
      if (cards === undefined || cards.length < perRank) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const picked = []
    for (let value = start; value <= highest; value += 1) {
      picked.push(...groups.get(value).slice(0, perRank))
    }
    return picked
  }
  return null
}

/**
 * Cheapness-ordered legal reply to `info`, or null when nothing can beat it.
 * Same-type low cards first, then a bomb, then the rocket.
 */
export function findBeatingPlay(hand, info) {
  if (info === null || info === undefined || !Array.isArray(hand)) return null
  const groups = groupByRank(hand)
  const values = sortedValues(groups)
  const rocket = groups.has(16) && groups.has(17)
    ? [groups.get(16)[0], groups.get(17)[0]]
    : null
  if (info.type === 'rocket') return null
  if (info.type === 'bomb') {
    for (const value of values) {
      if (value > info.rank && groups.get(value).length >= 4) return groups.get(value).slice(0, 4)
    }
    return rocket
  }
  switch (info.type) {
    case 'single':
      for (const value of values) if (value > info.rank) return [groups.get(value)[0]]
      break
    case 'pair':
      for (const value of values) {
        if (value > info.rank && groups.get(value).length >= 2) return groups.get(value).slice(0, 2)
      }
      break
    case 'triple':
      for (const value of values) {
        if (value > info.rank && groups.get(value).length >= 3) return groups.get(value).slice(0, 3)
      }
      break
    case 'triple-one':
      for (const value of values) {
        if (value <= info.rank || groups.get(value).length < 3) continue
        const kicker = lowestKickerRank(groups, value)
        if (kicker === 0) continue
        return [...groups.get(value).slice(0, 3), groups.get(kicker)[0]]
      }
      break
    case 'triple-two':
      for (const value of values) {
        if (value <= info.rank || groups.get(value).length < 3) continue
        const pair = lowestPairRank(groups, value)
        if (pair === 0) continue
        return [...groups.get(value).slice(0, 3), ...groups.get(pair).slice(0, 2)]
      }
      break
    case 'straight':
      return consecutiveRun(groups, 1, info.size, info.rank)
    case 'pair-straight':
      return consecutiveRun(groups, 2, info.size / 2, info.rank)
    case 'plane':
      return consecutiveRun(groups, 3, info.size / 3, info.rank)
    default:
      break
  }
  for (const value of values) {
    if (groups.get(value).length >= 4) return groups.get(value).slice(0, 4)
  }
  return rocket
}

/** Rough hand strength used to decide whether a bot calls landlord. */
function handStrength(hand) {
  const groups = groupByRank(hand)
  let score = 0
  for (const [value, cards] of groups) {
    if (value === 17) score += 4
    else if (value === 16) score += 3
    else if (value === 15) score += 2
    else if (value === 14) score += 1
    if (cards.length >= 4) score += 3
  }
  if (groups.has(16) && groups.has(17)) score += 2
  return score
}

/**
 * One bot move (pure). Returns {type:'bid',bid} | {type:'play',cards} |
 * {type:'pass'} | null (not this bot's turn / nothing to do).
 *
 * Bidding uses hand strength, but the last unanswered bidder always calls so
 * "everybody passed" can never redeal forever while a bot is at the table.
 */
export function botAction(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (node === undefined || node === null) return null
  const player = playerOf(state, node)
  if (player === undefined) return null
  if (state.phase === 'bidding') {
    if (state.turn !== node) return null
    const others = state.players.filter((other) => other.node !== node)
    const allOthersPassed = others.length > 0 && others.every((other) => other.bidding === false)
    if (allOthersPassed) return { type: 'bid', bid: true }
    return { type: 'bid', bid: handStrength(player.hand) >= 4 }
  }
  if (state.phase !== 'playing') return null
  if (state.turn !== node) return null
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    if (player.hand.length === 0) return null
    return { type: 'play', cards: [sortHand(player.hand)[0]] }
  }
  const reply = findBeatingPlay(player.hand, state.lastPlay.info)
  return reply === null ? { type: 'pass' } : { type: 'play', cards: reply }
}

/**
 * The host's turn-timeout move: bid false while bidding; lead the smallest
 * single or pass while playing. Returns null when it is not this node's turn.
 */
export function onTimeout(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (state.turn !== node) return null
  if (state.phase === 'bidding') return { type: 'bid', bid: false }
  if (state.phase !== 'playing') return null
  const player = playerOf(state, node)
  if (player === undefined) return null
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    if (player.hand.length === 0) return null
    const cards = sortHand(player.hand)
    return { type: 'play', cards: [cards[0]] }
  }
  return { type: 'pass' }
}

/* -------------------------------------------------------------------------- *
 * Leaving / disconnects (PROTOCOL.md 7.3 "掉线/离开")
 * -------------------------------------------------------------------------- */

/**
 * Remove one player. During an active round this follows the contract:
 * landlord leaving -> farmers win; a farmer leaving while only the landlord
 * remains -> landlord wins; otherwise the round continues with the remaining
 * players. Idle/result seats are simply removed.
 */
export function removePlayer(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const index = indexOfNode(state, node)
  if (index < 0) return { ok: false, error: 'unknown-player' }
  const player = state.players[index]

  if (state.phase === 'idle' || state.phase === 'result') {
    state.players.splice(index, 1)
    return { ok: true }
  }

  if (state.phase === 'bidding') {
    // Losing a seat during bidding cannot continue a three-player deal.
    state.players.splice(index, 1)
    state.phase = 'idle'
    state.turn = null
    state.landlord = null
    state.lastPlay = null
    state.lastPlayer = null
    state.passes = 0
    state.mustPlay = false
    log(state, player.nick + ' 离开牌桌，本局取消')
    return { ok: true }
  }

  // phase === 'playing'
  const wasLandlord = player.node === state.landlord
  const wasLastPlayer = player.node === state.lastPlayer
  const hadLastPlay = state.lastPlay !== null && state.lastPlay.node === player.node
  state.players.splice(index, 1)
  log(state, player.nick + ' 离开牌桌')

  if (wasLandlord) {
    // Farmers win immediately; the departed landlord still takes the loss.
    const landlordNode = player.node
    ensureScore(state, landlordNode).lose += 1
    const side = 'farmers'
    state.phase = 'result'
    state.turn = null
    state.mustPlay = false
    state.passes = 0
    state.winner = side
    for (const other of state.players) {
      other.bidding = null
      const win = other.role === 'farmer'
      other.result = win ? 'win' : 'lose'
      const bucket = ensureScore(state, other.node)
      if (win) bucket.win += 1
      else bucket.lose += 1
    }
    log(state, '地主离开，农民胜')
    return { ok: true }
  }

  // A farmer left.
  if (state.players.length === 0) {
    state.phase = 'idle'
    state.turn = null
    state.lastPlay = null
    state.lastPlayer = null
    state.mustPlay = false
    state.passes = 0
    return { ok: true }
  }
  const active = state.players.filter((other) => other.status === 'playing')
  if (active.length === 0) {
    state.phase = 'idle'
    state.turn = null
    state.lastPlay = null
    state.lastPlayer = null
    state.mustPlay = false
    state.passes = 0
    return { ok: true }
  }
  if (active.length === 1 && active[0].role === 'landlord') {
    // No farmer can continue -> the landlord wins.
    ensureScore(state, player.node).lose += 1
    state.phase = 'result'
    state.turn = null
    state.mustPlay = false
    state.passes = 0
    state.winner = 'landlord'
    for (const other of state.players) {
      other.bidding = null
      const win = other === active[0]
      other.result = win ? 'win' : 'lose'
      const bucket = ensureScore(state, other.node)
      if (win) bucket.win += 1
      else bucket.lose += 1
    }
    log(state, '农民全部离开，地主胜')
    return { ok: true }
  }

  // Continue with the remaining two players.
  if (hadLastPlay) {
    state.lastPlay = null
    state.passes = 0
    state.mustPlay = true
  }
  if (wasLastPlayer) state.lastPlayer = null
  if (state.turn === player.node) {
    state.turn = nextActiveFromIndex(state, index)
  }
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Snapshot (per-viewer privacy)
 * -------------------------------------------------------------------------- */

/** Normalize one table node id for the wire (bots use short ids like bot-1). */
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
 * Build the per-viewer `view.table` / state.table JSON (PROTOCOL.md 7.3).
 * `meta` carries { role, hostNode, staleMs, turnRemainingMs } and is validated
 * here; `myCards` is only ever the viewer's own hand.
 */
export function snapshot(state, viewerNode, meta = {}) {
  const safeMeta = meta !== null && typeof meta === 'object' ? meta : {}
  const role = safeMeta.role === 'spectator' ? 'spectator' : (safeMeta.role === 'host' ? 'host' : 'player')
  const nodes = Array.isArray(state?.players) ? state.players : []
  const viewerIsPlayer = nodes.some((player) => player.node === viewerNode)
  const showSelf = role !== 'spectator' && viewerIsPlayer
  const viewer = showSelf ? playerOf(state, viewerNode) : undefined

  const players = nodes.slice(0, maxPlayers).map((player) => ({
    node: player.node,
    nick: player.nick,
    bot: player.bot === true,
    self: showSelf && player.node === viewerNode,
    count: Array.isArray(player.hand) ? player.hand.length : 0,
    status: player.status === 'out' ? 'out' : 'playing',
    role: player.role === 'landlord' || player.role === 'farmer' ? player.role : null,
    result: player.result === 'win' || player.result === 'lose' ? player.result : null,
    bidding: state.phase === 'bidding' && typeof player.bidding === 'boolean'
      ? player.bidding
      : null,
  }))

  const lastPlay = state?.lastPlay !== null && typeof state?.lastPlay === 'object'
    ? {
        node: wireNode(state.lastPlay.node) ?? '',
        cards: Array.isArray(state.lastPlay.cards)
          ? state.lastPlay.cards.filter(isCard).slice(0, 20)
          : [],
        label: text(state.lastPlay.label, 40) ?? '出牌',
      }
    : null

  const staleMs = Number.isInteger(safeMeta.staleMs) ? Math.max(0, safeMeta.staleMs) : 0
  const turnRemaining = Number.isInteger(safeMeta.turnRemainingMs)
    ? Math.min(300_000, Math.max(0, safeMeta.turnRemainingMs))
    : null

  return {
    game: 'doudizhu',
    role,
    hostNode: wireNode(safeMeta.hostNode) ?? '',
    phase: state?.phase === 'bidding' || state?.phase === 'playing' || state?.phase === 'result'
      ? state.phase
      : 'idle',
    round: Number.isInteger(state?.round) ? Math.max(0, state.round) : 0,
    turn: wireNode(state?.turn),
    landlord: wireNode(state?.landlord),
    myCards: viewer !== undefined && Array.isArray(viewer.hand) ? sortHand(viewer.hand) : [],
    players,
    lastPlay,
    mustPlay: state?.phase === 'playing' && state.mustPlay === true,
    log: Array.isArray(state?.log) ? state.log.map((line) => text(line, 80)).filter((line) => line !== undefined).slice(-8) : [],
    scores: scoresFor(state, players),
    staleMs,
    turnRemainingMs: turnRemaining,
  }
}
