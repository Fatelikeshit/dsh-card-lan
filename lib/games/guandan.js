/**
 * dsh-card-lan 掼蛋（guandan）— pure four-player rules engine.
 *
 * No IO, no timers, no DSH imports: the host half owns sockets, timers and
 * per-viewer transport. This module owns two decks, the wild-card (逢人配)
 * analysis, trick state and the level-up / pass-A scoring.
 *
 * Cards: two standard decks (108 including 4 jokers). Encoding is rank+suit
 * ('2S'..'AS', duplicates allowed because two decks are in play); jokers are
 * 'BJ' (small) and 'RJ' (big). Seats 0/2 (team 0) play against seats 1/3
 * (team 1); each player gets 27 cards.
 *
 * Level & ordering (PROTOCOL.md 7.12): `level` is the rank being played
 * (2..A); the heart card of that rank is a wild card (逢人配) that can stand in
 * for any non-joker card. Card order is 2<3<…<A<level<BJ<RJ for singles,
 * pairs, triples and bombs; sequences compare by their natural top rank.
 *
 * Patterns: single / pair / triple / triple + pair / straight (5, A may act as
 * 1 for A2345) / pair straight (3 consecutive pairs) / plane (2 consecutive
 * triples) / bomb (4+ of a kind) / straight flush (5 same-suit straight) /
 * four kings (2 BJ + 2 RJ). Bomb strength: 4-bomb < 5-bomb < straight flush <
 * 6-bomb < 7-bomb < 8-bomb < four kings.
 *
 * Exported API (mirrors lib/games/doudizhu.js):
 *   minPlayers, maxPlayers, createTable, addPlayer, startRound, applyAction,
 *   onTimeout, removePlayer, snapshot, botAction
 * Extra pure helpers for tests: classify, analyzeCards, beats, labelOf,
 * sortHand, buildDeck, cardValue, isCard, rankValue.
 * @module dsh-card-lan/games/guandan
 */

/** Four seats: two teams of two (0/2 vs 1/3). */
export const minPlayers = 4
export const maxPlayers = 4

/** Level progression. */
const PROGRESS_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

/** Suits in deck order. */
const SUITS = ['S', 'H', 'D', 'C']

/** Natural rank values (2 lowest, A highest). */
const BASE_VALUE = {
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
  BJ: '小王',
  RJ: '大王',
}

/** Natural value -> rank text used by sequences (1 = A low). */
const VALUE_RANK = {
  1: 'A',
  2: '2',
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

/** One wire card: rank+suit, or a joker. */
const CARD_RE = /^(?:(?:[2-9]|10|[JQKA])[SHDC]|BJ|RJ)$/

/** Log lines kept in the engine state (snapshot trims further). */
const LOG_LIMIT = 40

/** Bomb order keys (PROTOCOL.md 7.12). */
const BOMB_POWER = {
  bomb4: 40,
  bomb5: 50,
  flush: 55,
  bomb6: 60,
  bomb7: 70,
  bomb8: 80,
  kings: 1000,
}

/** Pattern display names. */
const TYPE_TEXT = {
  single: '单',
  pair: '对',
  triple: '三张',
  'triple-two': '三带二',
  straight: '顺子',
  'pair-straight': '连对',
  plane: '钢板',
  bomb: '炸弹',
  flush: '同花顺',
  kings: '四大天王',
}

/* -------------------------------------------------------------------------- *
 * Cards
 * -------------------------------------------------------------------------- */

/** True for a syntactically valid wire card. */
export function isCard(card) {
  return typeof card === 'string' && CARD_RE.test(card)
}

/** Rank part of a wire card ('BJ'/'RJ' stayed as-is). */
export function rankOfCard(card) {
  if (!isCard(card)) return undefined
  if (card === 'BJ' || card === 'RJ') return card
  return card.slice(0, -1)
}

/** Suit part of a wire card (undefined for jokers). */
export function suitOfCard(card) {
  if (!isCard(card)) return undefined
  if (card === 'BJ' || card === 'RJ') return undefined
  return card.slice(-1)
}

/** Natural card value (2..14, BJ=16, RJ=17). */
export function cardValue(card) {
  const rank = rankOfCard(card)
  if (rank === undefined) return 0
  if (rank === 'BJ') return 16
  if (rank === 'RJ') return 17
  return BASE_VALUE[rank] ?? 0
}

/** Strength used for singles/pairs/triples/bombs at the current level. */
export function rankValue(rank, level = '2') {
  if (rank === undefined || rank === null) return 0
  if (rank === 'BJ') return 16
  if (rank === 'RJ') return 17
  if (rank === level) return 15
  return BASE_VALUE[rank] ?? 0
}

/** Normalize a level string into 2..A. */
export function normalizeLevel(level) {
  return typeof level === 'string' && PROGRESS_RANKS.includes(level) ? level : '2'
}

/** Ascending natural sort (level cards keep their natural rank). */
export function sortHand(cards) {
  if (!Array.isArray(cards)) return []
  return cards.slice().sort((a, b) => {
    const diff = cardValue(a) - cardValue(b)
    if (diff !== 0) return diff
    return String(a).localeCompare(String(b))
  })
}

/** Two full decks (108 cards). */
export function buildDeck() {
  const deck = []
  for (let copy = 0; copy < 2; copy += 1) {
    for (const suit of SUITS) {
      for (const rank of PROGRESS_RANKS) deck.push(rank + suit)
    }
    deck.push('BJ')
    deck.push('RJ')
  }
  return deck
}

/** Fisher–Yates shuffle over a copy; `rng` returns [0,1). */
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

/* -------------------------------------------------------------------------- *
 * Pattern analysis (including wild cards)
 * -------------------------------------------------------------------------- */

/** Split a play into normal cards and wild (heart level) cards. */
function splitPlay(cards, level) {
  const normals = []
  const wilds = []
  for (const card of cards) {
    if (rankOfCard(card) === level && suitOfCard(card) === 'H') wilds.push(card)
    else normals.push(card)
  }
  return { normals, wilds }
}

/** Count normal cards by rank. */
function countRanks(cards) {
  const counts = new Map()
  for (const card of cards) {
    const rank = rankOfCard(card)
    counts.set(rank, (counts.get(rank) ?? 0) + 1)
  }
  return counts
}

/**
 * Try to satisfy `slots` ([{rank,need}]) with the normal cards + wild cards.
 * Wild cards may not stand in for jokers.
 */
function fits(normals, wildCount, slots) {
  const need = new Map()
  for (const slot of slots) need.set(slot.rank, (need.get(slot.rank) ?? 0) + slot.need)
  const have = countRanks(normals)
  let deficits = 0
  for (const [rank, count] of need) {
    const got = have.get(rank) ?? 0
    if (got > count) return false
    const missing = count - got
    if (missing > 0) {
      if (rank === 'BJ' || rank === 'RJ') return false
      deficits += missing
    }
  }
  for (const rank of have.keys()) {
    if (!need.has(rank)) return false
  }
  return deficits === wildCount
}

/** Build a candidate record. */
function candidate(type, size, rankKey, extra = {}) {
  return {
    type,
    size,
    rankKey,
    cls: extra.cls ?? 'normal',
    bombPower: extra.bombPower ?? 0,
  }
}

/** All legal interpretations of a play at the given level. */
export function analyzeCards(cards, level = '2') {
  const safeLevel = normalizeLevel(level)
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > 27) return []
  if (!cards.every(isCard)) return []
  const { normals, wilds } = splitPlay(cards, safeLevel)
  const wildCount = wilds.length
  const total = cards.length
  const out = []

  const normalRanks = [...new Set(normals.map((card) => rankOfCard(card)))]
  const pushIf = (type, size, rankKey, extra) => {
    out.push(candidate(type, size, rankKey, extra))
  }

  // 四大天王: exactly two small + two big jokers.
  if (total === 4 && wildCount === 0) {
    const counts = countRanks(normals)
    if (counts.get('BJ') === 2 && counts.get('RJ') === 2) {
      pushIf('kings', 4, 0, { cls: 'bomb', bombPower: BOMB_POWER.kings })
      return out
    }
  }

  // Single.
  if (total === 1) {
    if (wildCount === 1) {
      pushIf('single', 1, rankValue(safeLevel, safeLevel))
    } else {
      const rank = rankOfCard(cards[0])
      pushIf('single', 1, rankValue(rank, safeLevel))
    }
  }

  // Pair.
  if (total === 2) {
    const rank = normalRanks.length > 0 ? normalRanks[0] : safeLevel
    if (fits(normals, wildCount, [{ rank, need: 2 }])) {
      pushIf('pair', 2, rankValue(rank, safeLevel))
    }
  }

  // Triple.
  if (total === 3) {
    const rank = normalRanks.length > 0 ? normalRanks[0] : safeLevel
    if (fits(normals, wildCount, [{ rank, need: 3 }])) {
      pushIf('triple', 3, rankValue(rank, safeLevel))
    }
  }

  // Bomb: >=4 of one kind (jokers only as four kings above).
  if (total >= 4) {
    const nonJokerNormals = normals.filter((card) => {
      const rank = rankOfCard(card)
      return rank !== 'BJ' && rank !== 'RJ'
    })
    const jokerNormals = normals.length - nonJokerNormals.length
    if (jokerNormals === 0) {
      const ranks = [...new Set(nonJokerNormals.map((card) => rankOfCard(card)))]
      if (ranks.length <= 1 && wildCount + nonJokerNormals.length === total) {
        const rank = ranks.length === 1 ? ranks[0] : safeLevel
        if (fits(nonJokerNormals, wildCount, [{ rank, need: total }])) {
          const power = total >= 8 ? BOMB_POWER.bomb8
            : (total === 7 ? BOMB_POWER.bomb7
              : (total === 6 ? BOMB_POWER.bomb6
                : (total === 5 ? BOMB_POWER.bomb5 : BOMB_POWER.bomb4)))
          pushIf('bomb', total, rankValue(rank, safeLevel), { cls: 'bomb', bombPower: power })
        }
      }
    }
  }

  // Three with two.
  if (total === 5) {
    const tripleRanks = normalRanks.filter((rank) => rank !== 'BJ' && rank !== 'RJ')
    if (tripleRanks.length === 0) tripleRanks.push(safeLevel)
    for (const tripleRank of tripleRanks) {
      const pairCandidates = new Set([...normalRanks, safeLevel])
      for (const pairRank of pairCandidates) {
        if (pairRank === tripleRank) continue
        if (fits(normals, wildCount, [{ rank: tripleRank, need: 3 }, { rank: pairRank, need: 2 }])) {
          pushIf('triple-two', 5, rankValue(tripleRank, safeLevel))
        }
      }
    }
  }

  // Straights: 5 consecutive natural ranks (A may be 1 or 14).
  if (total === 5) {
    for (let start = 1; start + 4 <= 14; start += 1) {
      const slots = []
      for (let step = 0; step < 5; step += 1) slots.push({ rank: VALUE_RANK[start + step], need: 1 })
      if (fits(normals, wildCount, slots)) {
        pushIf('straight', 5, start + 4)
      }
    }
  }

  // Pair straight: 3 consecutive pairs.
  if (total === 6) {
    for (let start = 1; start + 2 <= 14; start += 1) {
      const slots = []
      for (let step = 0; step < 3; step += 1) slots.push({ rank: VALUE_RANK[start + step], need: 2 })
      if (fits(normals, wildCount, slots)) {
        pushIf('pair-straight', 6, start + 2)
      }
    }
  }

  // Plane: 2 consecutive triples.
  if (total === 6) {
    for (let start = 1; start + 1 <= 14; start += 1) {
      const slots = []
      for (let step = 0; step < 2; step += 1) slots.push({ rank: VALUE_RANK[start + step], need: 3 })
      if (fits(normals, wildCount, slots)) {
        pushIf('plane', 6, start + 1)
      }
    }
  }

  // Straight flush: 5 same-suit consecutive cards (bomb class).
  if (total === 5 && normals.length > 0) {
    const suits = new Set(normals.map((card) => suitOfCard(card)))
    if (!suits.has(undefined) && suits.size === 1) {
      const [suit] = [...suits]
      for (let start = 1; start + 4 <= 14; start += 1) {
        const slots = []
        for (let step = 0; step < 5; step += 1) slots.push({ rank: VALUE_RANK[start + step], need: 1 })
        if (fits(normals, wildCount, slots)) {
          pushIf('flush', 5, start + 4, { cls: 'bomb', bombPower: BOMB_POWER.flush })
        }
      }
    }
  }

  // Strongest / most specific first.
  out.sort((a, b) => {
    const powerA = a.cls === 'bomb' ? a.bombPower : 0
    const powerB = b.cls === 'bomb' ? b.bombPower : 0
    if (powerA !== powerB) return powerA - powerB
    return a.rankKey - b.rankKey
  })
  return out
}

/** The representative interpretation of a play (strongest candidate). */
export function classify(cards, level = '2') {
  const candidates = analyzeCards(cards, level)
  return candidates.length === 0 ? null : candidates[candidates.length - 1]
}

/** True when `candidate` beats `previous` (both from analyzeCards/classify). */
export function beats(candidate, previous) {
  if (candidate === null || candidate === undefined) return false
  if (previous === null || previous === undefined) return true
  const candidateBomb = candidate.cls === 'bomb'
  const previousBomb = previous.cls === 'bomb'
  if (candidateBomb || previousBomb) {
    if (!candidateBomb) return false
    if (!previousBomb) return true
    if (candidate.bombPower !== previous.bombPower) return candidate.bombPower > previous.bombPower
    return candidate.rankKey > previous.rankKey
  }
  if (candidate.type !== previous.type) return false
  if (candidate.size !== previous.size) return false
  return candidate.rankKey > previous.rankKey
}

/** Human-readable label, e.g. '对 A', '顺子 3-7', '同花顺 5-9', '四大天王'. */
export function labelOf(cards, level = '2') {
  const info = classify(cards, level)
  if (info === null) return '无效牌型'
  if (info.type === 'kings') return '四大天王'
  if (info.type === 'flush') {
    const values = cards.map(cardValue).sort((a, b) => a - b)
    return '同花顺 ' + (RANK_TEXT[VALUE_RANK[values[0]]] ?? values[0])
      + '-' + (RANK_TEXT[VALUE_RANK[values[values.length - 1]]] ?? values[values.length - 1])
  }
  if (info.type === 'straight' || info.type === 'pair-straight' || info.type === 'plane') {
    const top = VALUE_RANK[info.rankKey]
    const span = info.type === 'straight' ? 5 : (info.type === 'pair-straight' ? 3 : 2)
    const low = info.type === 'plane' ? info.rankKey - 1 : info.rankKey - (span - 1)
    return TYPE_TEXT[info.type] + ' ' + (RANK_TEXT[VALUE_RANK[low]] ?? low) + '-' + (RANK_TEXT[top] ?? top)
  }
  return TYPE_TEXT[info.type] + ' ' + rankTextOfKey(info.rankKey, level)
}

/** Best-effort rank text for a numeric strength key. */
function rankTextOfKey(key, level) {
  if (key === 17) return '大王'
  if (key === 16) return '小王'
  if (key === 15) return RANK_TEXT[normalizeLevel(level)]
  for (const [rank, value] of Object.entries(BASE_VALUE)) {
    if (value === key) return RANK_TEXT[rank]
  }
  return String(key)
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

/** Next active (still playing) player node. */
function nextActiveNode(state, node) {
  const index = indexOfNode(state, node)
  if (index < 0) return null
  for (let step = 1; step <= state.players.length; step += 1) {
    const candidatePlayer = state.players[(index + step) % state.players.length]
    if (candidatePlayer.status === 'playing') return candidatePlayer.node
  }
  return null
}

/** Next active player starting at an array index (after removals). */
function nextActiveFromIndex(state, index) {
  if (state.players.length === 0) return null
  for (let step = 0; step < state.players.length; step += 1) {
    const candidatePlayer = state.players[(index + step) % state.players.length]
    if (candidatePlayer.status === 'playing') return candidatePlayer.node
  }
  return null
}

/** Active seat count. */
function activeCount(state) {
  return state.players.filter((player) => player.status === 'playing').length
}

/** Fresh player record. */
function makePlayer(raw) {
  return {
    node: typeof raw?.node === 'string' ? raw.node : '',
    nick: text(raw?.nick, 24) ?? '玩家',
    bot: raw?.bot === true,
    hand: [],
    status: 'playing',
    team: 0,
    result: null,
    order: null,
  }
}

/** Remove one card from a hand (multiset-safe). */
function removeFromHand(hand, cards) {
  const copy = hand.slice()
  for (const card of cards) {
    const index = copy.indexOf(card)
    if (index < 0) return undefined
    copy.splice(index, 1)
  }
  return copy
}

/** Level advance by upgrade amount, capped at A. */
function advancedLevel(level, upgrade) {
  const index = PROGRESS_RANKS.indexOf(normalizeLevel(level))
  const next = Math.min(PROGRESS_RANKS.length - 1, Math.max(0, index) + upgrade)
  return PROGRESS_RANKS[next]
}

/* -------------------------------------------------------------------------- *
 * Table lifecycle
 * -------------------------------------------------------------------------- */

/** Build an idle four-player table. */
export function createTable(players = []) {
  const state = {
    game: 'guandan',
    phase: 'idle',
    round: 0,
    level: '2',
    teamLevels: ['2', '2'],
    players: (Array.isArray(players) ? players : []).slice(0, maxPlayers).map(makePlayer),
    turn: null,
    lastPlay: null,
    lastPlayer: null,
    passes: 0,
    mustPlay: false,
    finished: [],
    firstNode: null,
    resultInfo: null,
    winnerTeam: null,
    winner: null,
    lastOrders: null,
    lastTeams: null,
    tributes: [],
    pendingReturn: null,
    pendingReturns: [],
    log: [],
    scores: {},
    updatedAt: 0,
  }
  state.players.forEach((player, index) => {
    player.team = index % 2
    ensureScore(state, player.node)
  })
  state.firstNode = state.players[0]?.node ?? null
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
  player.team = state.players.length % 2
  state.players.push(player)
  ensureScore(state, player.node)
  if (state.firstNode === null) state.firstNode = player.node
  return { ok: true }
}

/** Natural point of a card (jokers never qualify for a return). */
function naturalPoint(card) {
  const rank = rankOfCard(card)
  if (rank === undefined || rank === 'BJ' || rank === 'RJ') return 99
  return BASE_VALUE[rank] ?? 99
}

/** True for the heart level card (逢人配 / wild card). */
function isWildCard(card, level) {
  return rankOfCard(card) === level && suitOfCard(card) === 'H'
}

/** Suit order used to make automatic choices deterministic. */
const SUIT_ORDER = ['S', 'H', 'D', 'C']

/** Suit rank for deterministic tie-breaks. */
function suitRank(card) {
  const index = SUIT_ORDER.indexOf(suitOfCard(card))
  return index < 0 ? SUIT_ORDER.length : index
}

/** Largest ordinary card of a hand (wild cards and jokers never tribute). */
function chooseTributeCard(hand, level) {
  let best
  for (const card of hand) {
    const rank = rankOfCard(card)
    if (rank === 'BJ' || rank === 'RJ') continue
    if (isWildCard(card, level)) continue
    const strength = rankValue(rank, level)
    if (best === undefined || strength > best.strength
      || (strength === best.strength && suitRank(card) < best.suit)) {
      best = { card, strength, suit: suitRank(card) }
    }
  }
  return best?.card
}

/** True when a card may be returned (point 2..10, heart level cards allowed). */
function isReturnEligible(card) {
  return isCard(card) && naturalPoint(card) <= 10
}

/** Smallest eligible return card, or the smallest card when none qualifies. */
function chooseReturnCard(hand, level) {
  let best
  for (const card of hand) {
    if (!isReturnEligible(card)) continue
    const point = naturalPoint(card)
    if (best === undefined || point < best.point
      || (point === best.point && suitRank(card) < best.suit)) {
      best = { card, point, suit: suitRank(card) }
    }
  }
  if (best !== undefined) return best.card
  return sortHand(hand)[0]
}

/** Finish the tribute phase and choose the first player of the round. */
function finishTribute(state, fallbackFirst) {
  state.phase = 'playing'
  state.pendingReturn = null
  state.pendingReturns = []
  state.lastPlay = null
  state.lastPlayer = null
  state.passes = 0
  state.mustPlay = true
  const actual = state.tributes.filter((entry) => entry.skipped !== true)
  let first
  if (actual.length > 0) {
    const lastGiver = actual.find((entry) => entry.from === state.lastOrders?.[3])
    first = lastGiver !== undefined ? lastGiver.from : actual[0].from
  } else {
    first = state.lastOrders?.[0] ?? fallbackFirst
  }
  const candidate = first !== undefined && playerOf(state, first) !== undefined
    ? first
    : (state.players[0]?.node ?? null)
  state.turn = candidate
  log(state, (playerOf(state, candidate)?.nick ?? '玩家') + ' 先出')
}

/**
 * Set up v10 tribute: automatic gift cards are moved, then the receivers owe
 * one return card each (phase 'tribute'). Double-down (top two same team)
 * creates two tribute lanes; otherwise only the last place tributes the winner.
 */
function setupTribute(state, previousOrders, previousTeams) {
  const orders = Array.isArray(previousOrders)
    ? previousOrders.filter((node) => playerOf(state, node) !== undefined)
    : []
  state.tributes = []
  state.pendingReturn = null
  state.pendingReturns = []
  if (orders.length < 2) {
    finishTribute(state, orders[0])
    return
  }
  const teams = previousTeams !== null && typeof previousTeams === 'object' ? previousTeams : {}
  const teamOf = (node) => (Number.isInteger(teams[node]) ? teams[node] : (playerOf(state, node)?.team ?? 0))
  const top = orders[0]
  const second = orders[1]
  const third = orders[2]
  const last = orders[orders.length - 1]
  const doubleDown = orders.length >= 4 && teamOf(top) === teamOf(second)
  const pairs = []
  if (doubleDown) {
    pairs.push({ from: last, to: top })
    pairs.push({ from: third, to: second })
  } else {
    pairs.push({ from: last, to: top })
  }
  for (const pair of pairs) {
    const giver = playerOf(state, pair.from)
    const receiver = playerOf(state, pair.to)
    if (giver === undefined || receiver === undefined) continue
    const bigJokers = giver.hand.filter((card) => rankOfCard(card) === 'RJ').length
    if (bigJokers >= 2) {
      state.tributes.push({
        from: pair.from, to: pair.to, card: null, gift: null, returned: null, skipped: true,
      })
      log(state, giver.nick + ' 两张大王抗贡')
      continue
    }
    const gift = chooseTributeCard(giver.hand, state.level)
    if (gift === undefined) {
      state.tributes.push({
        from: pair.from, to: pair.to, card: null, gift: null, returned: null, skipped: true,
      })
      continue
    }
    giver.hand = removeFromHand(giver.hand, [gift])
    receiver.hand = sortHand([...receiver.hand, gift])
    state.tributes.push({ from: pair.from, to: pair.to, card: gift, gift, returned: null, skipped: false })
    state.pendingReturns.push({ from: pair.to, to: pair.from, record: state.tributes.length - 1 })
    log(state, giver.nick + ' 进贡 ' + gift + ' 给 ' + receiver.nick)
  }
  if (state.pendingReturns.length > 0) {
    state.phase = 'tribute'
    state.pendingReturn = state.pendingReturns[0].from
    state.turn = state.pendingReturn
    log(state, (playerOf(state, state.turn)?.nick ?? '玩家') + ' 待还贡')
  } else {
    finishTribute(state, orders[0])
  }
}

/** Return one card (tribute phase action): swap it back to the giver. */
function applyTributeReturn(state, player, action) {
  if (state.pendingReturn !== player.node) return { ok: false, error: 'not-your-turn' }
  const card = typeof action.card === 'string' ? action.card : ''
  if (!isCard(card)) return { ok: false, error: 'bad-cards' }
  if (!isReturnEligible(card)) return { ok: false, error: 'bad-cards' }
  const hand = removeFromHand(player.hand, [card])
  if (hand === undefined) return { ok: false, error: 'bad-cards' }
  player.hand = hand
  const pending = state.pendingReturns.shift()
  if (pending === undefined) return { ok: false, error: 'bad-phase' }
  const record = state.tributes[pending.record]
  const giver = playerOf(state, pending.to)
  if (giver !== undefined) giver.hand = sortHand([...giver.hand, card])
  if (record !== undefined) record.returned = card
  log(state, player.nick + ' 还贡 ' + card + ' 给 ' + (giver?.nick ?? '玩家'))
  if (state.pendingReturns.length > 0) {
    state.pendingReturn = state.pendingReturns[0].from
    state.turn = state.pendingReturn
    log(state, (playerOf(state, state.turn)?.nick ?? '玩家') + ' 待还贡')
  } else {
    finishTribute(state, state.lastOrders?.[0])
  }
  return { ok: true }
}

/** Start the next round (host checks phase idle/result first). */
export function startRound(state, rng = Math.random) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (state.players.length < minPlayers) return { ok: false, error: 'no-players' }
  if (state.phase === 'playing') return { ok: false, error: 'bad-phase' }

  state.round += 1
  state.level = normalizeLevel(state.level)
  state.phase = 'playing'
  state.log = []
  state.finished = []
  state.lastPlay = null
  state.lastPlayer = null
  state.passes = 0
  state.mustPlay = true
  state.resultInfo = null
  state.winnerTeam = null
  state.winner = null
  state.tributes = []
  state.pendingReturn = null
  state.pendingReturns = []
  const deck = shuffle(buildDeck(), rng)
  state.players.forEach((player, index) => {
    player.team = index % 2
    player.hand = sortHand(deck.slice(index * 27, index * 27 + 27))
    player.status = 'playing'
    player.result = null
    player.order = null
    ensureScore(state, player.node)
  })
  log(state, '第 ' + state.round + ' 局开始，打 ' + state.level)
  const previousOrders = Array.isArray(state.lastOrders) ? state.lastOrders.slice() : null
  if (state.round >= 2 && previousOrders !== null && previousOrders.length >= 2) {
    // v10: every hand after the first starts with tribute / return.
    setupTribute(state, previousOrders, state.lastTeams)
    return { ok: true }
  }
  const starter = state.firstNode !== null && state.players.some((player) => player.node === state.firstNode)
    ? state.firstNode
    : state.players[0].node
  state.turn = starter
  log(state, (playerOf(state, starter)?.nick ?? '玩家') + ' 先出')
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------------- */

/** Mark a player finished (头游→末游) and settle when three are out. */
function finishPlayer(state, player) {
  player.status = 'out'
  player.order = state.finished.length + 1
  state.finished.push(player.node)
  log(state, player.nick + ' 出完，第 ' + player.order + ' 游')
  if (state.players.length >= 4 && state.finished.length === 3) {
    const last = state.players.find((other) => other.status === 'playing')
    if (last !== undefined) {
      last.status = 'out'
      last.order = 4
      state.finished.push(last.node)
      log(state, last.nick + ' 末游')
    }
    settleRound(state)
    return true
  }
  if (activeCount(state) <= 1) {
    const last = state.players.find((other) => other.status === 'playing')
    if (last !== undefined) {
      last.status = 'out'
      last.order = state.finished.length + 1
      state.finished.push(last.node)
    }
    settleRound(state)
    return true
  }
  return false
}

/** Settle the round, apply the upgrade and move to the next level. */
function settleRound(state) {
  state.phase = 'result'
  state.turn = null
  state.mustPlay = false
  state.passes = 0
  const orders = state.finished.slice()
  state.lastOrders = orders.slice()
  state.lastTeams = {}
  for (const player of state.players) state.lastTeams[player.node] = player.team
  const winnerNode = orders[0]
  const winnerPlayer = playerOf(state, winnerNode)
  const winnerTeam = winnerPlayer === undefined ? 0 : winnerPlayer.team
  const partner = state.players.find((player) => player.team === winnerTeam && player.node !== winnerNode)
  const partnerOrder = partner === undefined ? 4 : (orders.indexOf(partner.node) + 1 || 4)
  const upgrade = partnerOrder === 2 ? 3 : (partnerOrder === 3 ? 2 : 1)
  const winnerLevel = normalizeLevel(state.teamLevels[winnerTeam])

  let matchWon = false
  if (winnerLevel === 'A' && state.level === 'A') {
    matchWon = true
  } else {
    state.teamLevels[winnerTeam] = advancedLevel(winnerLevel, upgrade)
    state.level = state.teamLevels[winnerTeam]
  }
  state.winnerTeam = winnerTeam
  state.winner = state.level
  state.resultInfo = {
    winnerTeam,
    upgrade,
    orders: orders.slice(),
    matchWon,
  }
  state.firstNode = winnerNode ?? state.firstNode
  for (const player of state.players) {
    const win = player.team === winnerTeam
    player.result = win ? 'win' : 'lose'
    const bucket = ensureScore(state, player.node)
    if (win) bucket.win += 1
    else bucket.lose += 1
  }
  log(state, winnerTeam === 0 ? '0/2 队赢下本局' : '1/3 队赢下本局')
  log(state, matchWon ? '过 A，赢下整场' : '升级 +' + upgrade + '，下局打 ' + state.level)
}

/** Playing branch: play a combination. */
function applyPlay(state, player, action) {
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (!Array.isArray(action.cards) || action.cards.length === 0) {
    return { ok: false, error: 'bad-cards' }
  }
  const cards = action.cards.slice(0, 27)
  if (!cards.every(isCard)) return { ok: false, error: 'bad-cards' }
  const hand = removeFromHand(player.hand, cards)
  if (hand === undefined) return { ok: false, error: 'bad-cards' }
  const analysis = analyzeCards(cards, state.level)
  if (analysis.length === 0) return { ok: false, error: 'bad-cards' }
  let chosen
  if (state.lastPlay !== null && state.lastPlay.node !== player.node) {
    chosen = analysis.find((candidateInfo) => beats(candidateInfo, state.lastPlay.info))
    if (chosen === undefined) return { ok: false, error: 'bad-cards' }
  } else {
    // Leading: use the strongest interpretation of the selected cards.
    chosen = analysis[analysis.length - 1]
  }
  player.hand = hand
  state.lastPlay = {
    node: player.node,
    cards: sortHand(cards),
    label: labelOf(cards, state.level),
    info: chosen,
  }
  state.lastPlayer = player.node
  state.passes = 0
  log(state, player.nick + ' 出牌 ' + state.lastPlay.label)
  if (player.hand.length === 0) {
    const settled = finishPlayer(state, player)
    if (!settled) {
      state.mustPlay = false
      state.turn = nextActiveNode(state, player.node)
    }
    return { ok: true }
  }
  state.mustPlay = false
  state.turn = nextActiveNode(state, player.node)
  return { ok: true }
}

/** Playing branch: pass (only illegal when leading the trick). */
function applyPass(state, player) {
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    return { ok: false, error: 'must-play' }
  }
  state.passes += 1
  log(state, player.nick + ' 不要')
  if (state.passes >= activeCount(state) - 1) {
    const leader = playerOf(state, state.lastPlayer)
    state.lastPlay = null
    state.passes = 0
    state.mustPlay = true
    state.turn = leader !== undefined && leader.status === 'playing'
      ? leader.node
      : nextActiveNode(state, player.node)
    if (leader !== undefined) log(state, leader.nick + ' 获得出牌权')
    return { ok: true }
  }
  state.mustPlay = false
  state.turn = nextActiveNode(state, player.node)
  return { ok: true }
}

/** Apply one action from `node`: play/pass, or tribute-return in tribute phase. */
export function applyAction(state, node, action) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  if (node === undefined || node === null) return { ok: false, error: 'bad-action' }
  const player = playerOf(state, node)
  if (player === undefined) return { ok: false, error: 'not-seated' }
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, error: 'bad-action' }
  }
  if (state.phase === 'tribute') {
    if (state.turn !== node) return { ok: false, error: 'not-your-turn' }
    if (action.type !== 'tribute-return') return { ok: false, error: 'bad-action' }
    return applyTributeReturn(state, player, action)
  }
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (state.turn !== node) return { ok: false, error: 'not-your-turn' }
  if (action.type === 'play') return applyPlay(state, player, action)
  if (action.type === 'pass') return applyPass(state, player)
  return { ok: false, error: 'bad-action' }
}

/** Best simple reply for timeouts/bots: single, pair, triple, triple-two or bomb. */
function findBeatingPlay(hand, info, level) {
  if (info === null || info === undefined) return null
  const counts = countRanks(hand)
  const strength = (rank) => rankValue(rank, level)
  if (info.cls !== 'bomb') {
    if (info.type === 'single') {
      const cards = sortHand(hand).filter((card) => strength(rankOfCard(card)) > info.rankKey)
      if (cards.length > 0) return [cards[0]]
    }
    if (info.type === 'pair' || info.type === 'triple') {
      const need = info.type === 'pair' ? 2 : 3
      const ranks = [...counts.keys()]
        .filter((rank) => rank !== 'BJ' && rank !== 'RJ' && counts.get(rank) >= need && strength(rank) > info.rankKey)
        .sort((a, b) => strength(a) - strength(b))
      if (ranks.length > 0) {
        return hand.filter((card) => rankOfCard(card) === ranks[0]).slice(0, need)
      }
    }
    if (info.type === 'triple-two') {
      const tripleRanks = [...counts.keys()]
        .filter((rank) => rank !== 'BJ' && rank !== 'RJ' && counts.get(rank) >= 3 && strength(rank) > info.rankKey)
        .sort((a, b) => strength(a) - strength(b))
      for (const tripleRank of tripleRanks) {
        const pairRank = [...counts.keys()]
          .filter((rank) => rank !== tripleRank && rank !== 'BJ' && rank !== 'RJ' && counts.get(rank) >= 2)
          .sort((a, b) => strength(a) - strength(b))[0]
        if (pairRank !== undefined) {
          return [
            ...hand.filter((card) => rankOfCard(card) === tripleRank).slice(0, 3),
            ...hand.filter((card) => rankOfCard(card) === pairRank).slice(0, 2),
          ]
        }
      }
    }
  }
  // Fall back to the smallest bomb that beats the previous play.
  const bombRanks = [...counts.keys()]
    .filter((rank) => rank !== 'BJ' && rank !== 'RJ' && counts.get(rank) >= 4)
    .sort((a, b) => strength(a) - strength(b))
  for (const rank of bombRanks) {
    const cards = hand.filter((card) => rankOfCard(card) === rank)
    const bombInfo = analyzeCards(cards, level).find((entry) => entry.cls === 'bomb')
    if (bombInfo !== undefined && beats(bombInfo, info)) return cards.slice(0, Math.min(cards.length, 8))
  }
  return null
}

/**
 * Host timeout move: lead the smallest single, otherwise play the cheapest
 * legal reply and pass only when nothing can beat the lastPlay.
 */
export function onTimeout(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (state.turn !== node) return null
  const player = playerOf(state, node)
  if (player === undefined) return null
  if (state.phase === 'tribute') {
    // Timeout during tribute: return the smallest card of at most ten points.
    if (state.pendingReturn !== node) return null
    return { type: 'tribute-return', card: chooseReturnCard(player.hand, state.level) }
  }
  if (state.phase !== 'playing') return null
  if (state.lastPlay === null || state.lastPlay.node === player.node) {
    if (player.hand.length === 0) return null
    return { type: 'play', cards: [sortHand(player.hand)[0]] }
  }
  const reply = findBeatingPlay(player.hand, state.lastPlay.info, state.level)
  return reply === null ? { type: 'pass' } : { type: 'play', cards: reply }
}

/** Bot move (v7.0 has no guandan bots, exported for parity/tests). */
export function botAction(state, node) {
  return onTimeout(state, node)
}

/* -------------------------------------------------------------------------- *
 * Leaving / disconnects
 * -------------------------------------------------------------------------- */

/** Remove one player; a mid-round leave discards the hand and finishes the seat. */
export function removePlayer(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const index = indexOfNode(state, node)
  if (index < 0) return { ok: false, error: 'unknown-player' }
  const player = state.players[index]

  if (state.phase === 'tribute') {
    // Auto-resolve a pending return for the leaving player, then drop the seat.
    if (state.pendingReturn === node) {
      const auto = chooseReturnCard(player.hand, state.level)
      if (auto !== undefined) applyTributeReturn(state, player, { type: 'tribute-return', card: auto })
    }
    if (state.phase === 'tribute') {
      state.players.splice(index, 1)
      log(state, player.nick + ' 离开牌桌')
      state.pendingReturns = state.pendingReturns.filter((entry) => entry.from !== node && entry.to !== node)
      if (state.pendingReturns.length > 0) {
        state.pendingReturn = state.pendingReturns[0].from
        state.turn = state.pendingReturn
      } else {
        finishTribute(state, state.lastOrders?.[0])
      }
      return { ok: true }
    }
  }

  if (state.phase === 'idle' || state.phase === 'result') {
    state.players.splice(index, 1)
    state.players.forEach((entry, seat) => { entry.team = seat % 2 })
    if (state.firstNode === node) state.firstNode = state.players[0]?.node ?? null
    return { ok: true }
  }

  state.players.splice(index, 1)
  log(state, player.nick + ' 离开牌桌')
  if (!state.finished.includes(node)) {
    player.status = 'out'
    player.order = state.finished.length + 1
    state.finished.push(node)
  }
  if (state.players.length === 0) {
    state.phase = 'idle'
    state.turn = null
    state.lastPlay = null
    state.lastPlayer = null
    state.mustPlay = false
    state.passes = 0
    return { ok: true }
  }
  if (activeCount(state) <= 1) {
    const last = state.players.find((entry) => entry.status === 'playing')
    if (last !== undefined) {
      last.status = 'out'
      last.order = state.finished.length + 1
      state.finished.push(last.node)
    }
    settleRound(state)
    return { ok: true }
  }
  // Continue with the remaining players.
  if (state.lastPlay !== null && state.lastPlay.node === node) {
    state.lastPlay = null
    state.passes = 0
    state.mustPlay = true
  }
  if (state.lastPlayer === node) state.lastPlayer = null
  if (state.turn === node) state.turn = nextActiveFromIndex(state, index)
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Snapshot (per-viewer privacy)
 * -------------------------------------------------------------------------- */

/** Normalize a table node id for the wire (bots/short ids included). */
function wireNode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null
}

/** Normalize a level string into 2..A. */
function wireLevel(value) {
  return PROGRESS_RANKS.includes(value) ? value : '2'
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
 * Build the per-viewer `view.table` / state.table JSON (PROTOCOL.md 7.12).
 * `myCards` is only ever the viewer's own hand.
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
    self: showSelf && player.node === viewerNode,
    team: player.team === 1 ? 1 : 0,
    count: Array.isArray(player.hand) ? player.hand.length : 0,
    status: player.status === 'out' ? 'out' : 'playing',
    result: player.result === 'win' || player.result === 'lose' ? player.result : null,
    order: Number.isInteger(player.order) ? player.order : null,
    bot: player.bot === true,
  }))

  const lastPlay = state?.lastPlay !== null && typeof state?.lastPlay === 'object'
    ? {
        node: wireNode(state.lastPlay.node) ?? '',
        cards: Array.isArray(state.lastPlay.cards)
          ? state.lastPlay.cards.filter(isCard).slice(0, 27)
          : [],
        label: text(state.lastPlay.label, 40) ?? '出牌',
      }
    : null

  const staleMs = Number.isInteger(safeMeta.staleMs) ? Math.max(0, safeMeta.staleMs) : 0
  const turnRemaining = Number.isInteger(safeMeta.turnRemainingMs)
    ? Math.min(300_000, Math.max(0, safeMeta.turnRemainingMs))
    : null

  const tribute = Array.isArray(state?.tributes)
    ? state.tributes.slice(0, 2).map((entry) => ({
        from: wireNode(entry?.from) ?? '',
        to: wireNode(entry?.to) ?? '',
        card: isCard(entry?.card) ? entry.card : null,
        gift: isCard(entry?.gift) ? entry.gift : null,
        returned: isCard(entry?.returned) ? entry.returned : null,
        skipped: entry?.skipped === true,
      }))
    : []

  const view = {
    game: 'guandan',
    role,
    hostNode: wireNode(safeMeta.hostNode) ?? '',
    phase: state?.phase === 'playing' || state?.phase === 'tribute' || state?.phase === 'result'
      ? state.phase
      : 'idle',
    round: Number.isInteger(state?.round) ? Math.max(0, state.round) : 0,
    level: wireLevel(state?.level),
    teamLevels: [
      wireLevel(state?.teamLevels?.[0]),
      wireLevel(state?.teamLevels?.[1]),
    ],
    team: role === 'spectator' || viewer === undefined ? null : (viewer.team === 1 ? 1 : 0),
    turn: wireNode(state?.turn),
    myCards: viewer !== undefined && Array.isArray(viewer.hand) ? sortHand(viewer.hand) : [],
    players,
    lastPlay,
    mustPlay: state?.phase === 'playing' && state.mustPlay === true,
    tribute,
    pendingReturn: wireNode(state?.pendingReturn),
    log: Array.isArray(state?.log)
      ? state.log.map((line) => text(line, 80)).filter((line) => line !== undefined).slice(-8)
      : [],
    scores: scoresFor(state, players),
    staleMs,
    turnRemainingMs: turnRemaining,
  }
  if (state?.phase === 'result') {
    const info = state.resultInfo !== null && typeof state.resultInfo === 'object' ? state.resultInfo : {}
    view.winnerTeam = info.winnerTeam === 1 ? 1 : 0
    view.upgrade = Number.isInteger(info.upgrade) ? Math.min(3, Math.max(0, info.upgrade)) : 0
    view.orders = Array.isArray(info.orders)
      ? info.orders.map((node) => wireNode(node)).filter((node) => node !== null)
      : []
    view.matchWon = info.matchWon === true
  }
  return view
}
