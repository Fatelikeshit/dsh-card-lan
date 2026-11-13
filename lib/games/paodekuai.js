/**
 * dsh-card-lan 跑得快（paodekuai）— pure three-player rules engine.
 *
 * No IO, no timers, no DSH imports: the host half owns sockets and scheduling,
 * this module only owns cards, phases and the turn state machine.
 *
 * Deck: 48 cards, 3..A × 4 suits (no 2s, no jokers). Deal 16 cards each; the
 * holder of 3S (spade 3) leads the first trick. A is the highest rank.
 *
 * Combinations (PROTOCOL.md 7.6): single / pair / triple / triple + pair /
 * straight (>=5, A high) / pair straight (>=2 consecutive pairs) / plane
 * (>=2 consecutive triples, no wings) / bomb (four of a kind). Four-with-two
 * and plane-with-wings are rejected with `bad-cards`.
 *
 * "Must beat" rule: when a player can beat the current lastPlay they MUST play;
 * `pass` is only legal when no beating combination exists. When every other
 * player passes, lastPlay clears and the last player leads again.
 *
 * Exported API (host contract, mirrors lib/games/doudizhu.js):
 *   minPlayers, maxPlayers, createTable, addPlayer, startRound, applyAction,
 *   onTimeout, removePlayer, snapshot
 * Extra pure helpers (handy for tests): classify, beats, labelOf, sortHand,
 * buildDeck, cardValue, isCard, canBeat.
 * @module dsh-card-lan/games/paodekuai
 */

/** Exactly three players. */
export const minPlayers = 3
export const maxPlayers = 3

/** Ranks in ascending order (no 2, no jokers). */
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

/** Suits in deck order. */
const SUITS = ['S', 'H', 'D', 'C']

/** Rank text -> point value (A = 14 is the highest). */
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
}

/** Log lines kept in the engine state (snapshot trims further). */
const LOG_LIMIT = 40

/** One wire card: rank + suit, no 2 / jokers. */
const CARD_RE = /^(?:[3-9]|10|[JQKA])[SHDC]$/

/** Highest rank usable in straights / pair straights / planes. */
const MAX_STRAIGHT_RANK = 14 // A

/** Smallest rank in the deck (needed for consecutive runs). */
const MIN_RANK = 3

/* -------------------------------------------------------------------------- *
 * Cards
 * -------------------------------------------------------------------------- */

/** True for a syntactically valid paodekuai wire card. */
export function isCard(card) {
  return typeof card === 'string' && CARD_RE.test(card)
}

/** Point value of one wire card (0 for garbage). */
export function cardValue(card) {
  if (!isCard(card)) return 0
  return RANK_VALUE[card.slice(0, -1)] ?? 0
}

/** Ascending sort by rank (suit order only for stability). */
export function sortHand(cards) {
  if (!Array.isArray(cards)) return []
  return cards.slice().sort((a, b) => {
    const diff = cardValue(a) - cardValue(b)
    if (diff !== 0) return diff
    return String(a).localeCompare(String(b))
  })
}

/** A fresh 48-card deck (3..A × 4 suits). */
export function buildDeck() {
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
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 16) return null
  if (!cards.every(isCard)) return null
  const values = cards.map(cardValue).sort((a, b) => a - b)
  const n = values.length
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const groups = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value - b.value)

  if (n === 1) return { type: 'single', size: 1, rank: values[0] }
  if (n === 2 && groups.length === 1) return { type: 'pair', size: 2, rank: values[0] }
  if (n === 3 && groups.length === 1) return { type: 'triple', size: 3, rank: values[0] }
  if (n === 4 && groups.length === 1) return { type: 'bomb', size: 4, rank: values[0] }
  if (n === 5 && groups.length === 2) {
    const triple = groups.find((group) => group.count === 3)
    const pair = groups.find((group) => group.count === 2)
    if (triple !== undefined && pair !== undefined) {
      return { type: 'triple-two', size: 5, rank: triple.value }
    }
  }
  // Straight: >=5 singles, consecutive, A high.
  if (n >= 5 && groups.every((group) => group.count === 1)) {
    const vs = groups.map((group) => group.value)
    if (vs[vs.length - 1] <= MAX_STRAIGHT_RANK && isConsecutive(vs)) {
      return { type: 'straight', size: n, rank: vs[vs.length - 1] }
    }
  }
  // Pair straight: >=2 consecutive pairs.
  if (n >= 4 && n % 2 === 0 && groups.every((group) => group.count === 2)) {
    const vs = groups.map((group) => group.value)
    if (vs.length >= 2 && vs[vs.length - 1] <= MAX_STRAIGHT_RANK && isConsecutive(vs)) {
      return { type: 'pair-straight', size: n, rank: vs[vs.length - 1] }
    }
  }
  // Plane: >=2 consecutive triples, no wings.
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
  if (candidate.type === 'bomb') {
    return previous.type === 'bomb' ? candidate.rank > previous.rank : true
  }
  if (previous.type === 'bomb') return false
  if (candidate.type !== previous.type) return false
  if (candidate.size !== previous.size) return false
  return candidate.rank > previous.rank
}

/** Human-readable label, e.g. '对 A', '顺子 3-7', '炸弹 9'. */
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
    case 'triple-two': return '三带二 ' + highest
    case 'straight': return '顺子 ' + lowest + '-' + highest
    case 'pair-straight': return '连对 ' + lowest + '-' + highest
    case 'plane': return '飞机 ' + lowest + '-' + highest
    case 'bomb': return '炸弹 ' + highest
    default: return '出牌'
  }
}

/* -------------------------------------------------------------------------- *
 * Hand helpers (must-beat detection)
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

/** Lowest pair rank that is not `exclude`. */
function lowestPair(groups, exclude) {
  for (const value of sortedValues(groups)) {
    if (value === exclude) continue
    if (groups.get(value).length >= 2) return value
  }
  return 0
}

/** Pick cards of consecutive ranks (one per rank) with the lowest possible run. */
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
 * The cheapest legal play that beats `info`, or null when nothing can.
 * prefers a same-type combination over spending a bomb.
 */
export function findBeatingPlay(hand, info) {
  if (info === null || info === undefined) return null
  if (!Array.isArray(hand)) return null
  const groups = groupByRank(hand)
  const values = sortedValues(groups)
  if (info.type === 'bomb') {
    for (const value of values) {
      if (value > info.rank && groups.get(value).length >= 4) return groups.get(value).slice(0, 4)
    }
    return null
  }
  // Same type + same size, lowest rank that still beats the previous play.
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
    case 'triple-two':
      for (const value of values) {
        if (value <= info.rank || groups.get(value).length < 3) continue
        const pairValue = lowestPair(groups, value)
        if (pairValue === 0) continue
        return [...groups.get(value).slice(0, 3), ...groups.get(pairValue).slice(0, 2)]
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
  // A bomb beats any non-bomb play.
  for (const value of values) {
    if (groups.get(value).length >= 4) return groups.get(value).slice(0, 4)
  }
  return null
}

/** True when the hand holds some legal reply to `info`. */
export function canBeat(hand, info) {
  return findBeatingPlay(hand, info) !== null
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
    result: null,
  }
}

/** Winner settlement: first player out wins, everyone else loses. */
function settle(state, winnerNode, reason) {
  state.phase = 'result'
  state.turn = null
  state.mustPlay = false
  state.passes = 0
  const winner = playerOf(state, winnerNode)
  for (const player of state.players) {
    const win = player.node === winnerNode
    player.result = win ? 'win' : 'lose'
    const bucket = ensureScore(state, player.node)
    if (win) bucket.win += 1
    else bucket.lose += 1
  }
  if (reason !== undefined) log(state, reason)
  log(state, (winner === undefined ? '玩家' : winner.nick) + ' 先出完，赢下本局')
}

/* -------------------------------------------------------------------------- *
 * Table lifecycle
 * -------------------------------------------------------------------------- */

/** Build an idle three-player table around the given seats. */
export function createTable(players = []) {
  const state = {
    game: 'paodekuai',
    phase: 'idle',
    round: 0,
    players: (Array.isArray(players) ? players : []).slice(0, maxPlayers).map(makePlayer),
    turn: null,
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

/** Start the next round (host checks phase idle/result before calling). */
export function startRound(state, rng = Math.random) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (state.players.length < minPlayers) return { ok: false, error: 'no-players' }
  if (state.players.length > maxPlayers) return { ok: false, error: 'too-many-players' }
  if (state.phase === 'playing') return { ok: false, error: 'bad-phase' }

  const deck = shuffle(buildDeck(), rng)
  state.round += 1
  state.phase = 'playing'
  state.log = []
  state.lastPlay = null
  state.lastPlayer = null
  state.passes = 0
  state.mustPlay = true
  state.winner = null
  state.players.forEach((player, index) => {
    player.hand = sortHand(deck.slice(index * 16, index * 16 + 16))
    player.status = 'playing'
    player.result = null
    ensureScore(state, player.node)
  })
  // The holder of spade 3 leads the very first trick.
  const starter = state.players.find((player) => player.hand.includes('3S'))
  state.turn = starter === undefined ? state.players[0].node : starter.node
  log(state, '第 ' + state.round + ' 局开始')
  log(state, (starter === undefined ? state.players[0].nick : starter.nick) + ' 持黑桃3先出')
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------------- */

/** Playing branch: play a combination. */
function applyPlay(state, player, action) {
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (!Array.isArray(action.cards) || action.cards.length === 0) {
    return { ok: false, error: 'bad-cards' }
  }
  const cards = action.cards.slice(0, 16)
  if (!cards.every(isCard)) return { ok: false, error: 'bad-cards' }
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
    settle(state, player.node, player.nick + ' 出完了手牌')
    return { ok: true }
  }
  state.mustPlay = false
  state.turn = nextActiveNode(state, player.node)
  return { ok: true }
}

/** Playing branch: pass (only legal when nothing can beat the lastPlay). */
function applyPass(state, player) {
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    return { ok: false, error: 'must-play' }
  }
  // "必须管上": having a legal reply makes passing illegal.
  if (findBeatingPlay(player.hand, state.lastPlay.info) !== null) {
    return { ok: false, error: 'must-play' }
  }
  state.passes += 1
  log(state, player.nick + ' 不要')
  const active = state.players.filter((other) => other.status === 'playing')
  if (state.passes >= active.length - 1) {
    const leader = playerOf(state, state.lastPlayer)
    state.lastPlay = null
    state.passes = 0
    state.mustPlay = true
    if (leader !== undefined && leader.status === 'playing') {
      state.turn = leader.node
      log(state, leader.nick + ' 获得出牌权')
    } else {
      state.turn = nextActiveNode(state, player.node)
    }
    return { ok: true }
  }
  state.mustPlay = false
  state.turn = nextActiveNode(state, player.node)
  return { ok: true }
}

/**
 * Apply one action from `node`.
 * Action shapes: { type:'play', cards:[...] } | { type:'pass' }.
 * Error codes: not-your-turn / bad-phase / bad-cards / must-play.
 */
export function applyAction(state, node, action) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (node === undefined || node === null) return { ok: false, error: 'bad-action' }
  const player = playerOf(state, node)
  if (player === undefined) return { ok: false, error: 'not-seated' }
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (state.turn !== node) return { ok: false, error: 'not-your-turn' }
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, error: 'bad-action' }
  }
  if (action.type === 'play') return applyPlay(state, player, action)
  if (action.type === 'pass') return applyPass(state, player)
  return { ok: false, error: 'bad-action' }
}

/**
 * The host's turn-timeout move: lead the smallest single; when a reply is
 * required play the cheapest combination that beats the lastPlay, or pass when
 * nothing can beat it. Returns null when it is not this node's turn.
 */
export function onTimeout(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (state.turn !== node || state.phase !== 'playing') return null
  const player = playerOf(state, node)
  if (player === undefined) return null
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    if (player.hand.length === 0) return null
    return { type: 'play', cards: [sortHand(player.hand)[0]] }
  }
  const reply = findBeatingPlay(player.hand, state.lastPlay.info)
  if (reply !== null) return { type: 'play', cards: reply }
  return { type: 'pass' }
}

/**
 * One bot move (pure, PROTOCOL.md 7.8). Returns {type:'play',cards} |
 * {type:'pass'} | null (not this bot's turn). Leads the smallest single and
 * follows with the cheapest legal reply; passing only when nothing beats the
 * lastPlay, so the must-beat rule is respected.
 */
export function botAction(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (node === undefined || node === null) return null
  const player = playerOf(state, node)
  if (player === undefined) return null
  if (state.phase !== 'playing' || state.turn !== node) return null
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    if (player.hand.length === 0) return null
    return { type: 'play', cards: [sortHand(player.hand)[0]] }
  }
  const reply = findBeatingPlay(player.hand, state.lastPlay.info)
  return reply === null ? { type: 'pass' } : { type: 'play', cards: reply }
}

/* -------------------------------------------------------------------------- *
 * Leaving / disconnects (PROTOCOL.md 7.6)
 * -------------------------------------------------------------------------- */

/**
 * Remove one player. During a round the hand is discarded and the player is
 * removed; when only one player is left that player wins immediately. With two
 * players left the round continues (turn/bookkeeping fixed up). Idle/result
 * seats are simply removed.
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

  state.players.splice(index, 1)
  log(state, player.nick + ' 离开牌桌')

  if (state.players.length === 0) {
    state.phase = 'idle'
    state.turn = null
    state.lastPlay = null
    state.lastPlayer = null
    state.mustPlay = false
    state.passes = 0
    return { ok: true }
  }
  if (state.players.length === 1) {
    // Only one player is left: that player wins immediately.
    const survivor = state.players[0]
    survivor.status = 'playing'
    ensureScore(state, player.node).lose += 1
    settle(state, survivor.node, '只剩一人，本局结束')
    return { ok: true }
  }

  // Two players remain: keep playing, fixing turn/trick bookkeeping.
  state.passes = 0
  if (state.lastPlay !== null && state.lastPlay.node === player.node) {
    state.lastPlay = null
    state.mustPlay = true
  }
  if (state.lastPlayer === player.node) state.lastPlayer = null
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
 * Build the per-viewer `view.table` / state.table JSON (PROTOCOL.md 7.6).
 * `meta` carries { role, hostNode, staleMs, turnRemainingMs }; `myCards` is
 * only ever the viewer's own hand.
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
    result: player.result === 'win' || player.result === 'lose' ? player.result : null,
  }))

  const lastPlay = state?.lastPlay !== null && typeof state?.lastPlay === 'object'
    ? {
        node: wireNode(state.lastPlay.node) ?? '',
        cards: Array.isArray(state.lastPlay.cards)
          ? state.lastPlay.cards.filter(isCard).slice(0, 16)
          : [],
        label: text(state.lastPlay.label, 40) ?? '出牌',
      }
    : null

  const staleMs = Number.isInteger(safeMeta.staleMs) ? Math.max(0, safeMeta.staleMs) : 0
  const turnRemaining = Number.isInteger(safeMeta.turnRemainingMs)
    ? Math.min(300_000, Math.max(0, safeMeta.turnRemainingMs))
    : null

  return {
    game: 'paodekuai',
    role,
    hostNode: wireNode(safeMeta.hostNode) ?? '',
    phase: state?.phase === 'playing' || state?.phase === 'result' ? state.phase : 'idle',
    round: Number.isInteger(state?.round) ? Math.max(0, state.round) : 0,
    turn: wireNode(state?.turn),
    myCards: viewer !== undefined && Array.isArray(viewer.hand) ? sortHand(viewer.hand) : [],
    players,
    lastPlay,
    mustPlay: state?.phase === 'playing' && state.mustPlay === true,
    log: Array.isArray(state?.log)
      ? state.log.map((line) => text(line, 80)).filter((line) => line !== undefined).slice(-8)
      : [],
    scores: scoresFor(state, players),
    staleMs,
    turnRemainingMs: turnRemaining,
  }
}
