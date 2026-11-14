/**
 * dsh-card-lan 日麻（Japanese mahjong）— milestone ① pure rules engine.
 *
 * M1 scope (PROTOCOL.md 7.18): two modes — `mahjong4` (136 tiles, one red five
 * in m/p/s) and `mahjong3` (108 tiles, 2m-8m removed, red fives in p/s only).
 * Dealer gets 14 tiles, everyone else 13; one dora indicator is shown as-is.
 * Actions are `discard`, `tsumo` (basic winning shapes only: 4 melds + pair,
 * seven pairs, thirteen orphans — no yaku/fu/points yet) and `nuki` (3-player
 * only: put a north tile aside, nuki count +1, draw a replacement from the
 * dead wall, the same player still acts). Exhausting the live wall ends the
 * hand with result 'exhausted'.
 *
 * Exported API (mirrors the other engines):
 *   minPlayers, maxPlayers, createTable, addPlayer, startRound, applyAction,
 *   onTimeout, removePlayer, snapshot, botAction
 * Extra pure helpers: buildWall, parseTile, sortHand, isWinningHand,
 * isSevenPairs, isKokushi, tileBase, isTile.
 * @module dsh-card-lan/games/mahjong
 */

/** Smallest / largest table (3-player mode has 3 seats). */
export const minPlayers = 3
export const maxPlayers = 4

/** Game ids. */
export const MODES = ['mahjong4', 'mahjong3']

/** Dead wall size (kept simple in M1: indicator + replacement draws). */
const DEAD_WALL_SIZE = 14

/** Honor tiles in display/sort order. */
const HONOR_TILES = ['E', 'S', 'W', 'N', 'P', 'F', 'C']

/** Suits in display/sort order. */
const SUITS = ['m', 'p', 's']

/** Thirteen orphans tile set. */
const ORPHANS = ['1m', '9m', '1p', '9p', '1s', '9s', ...HONOR_TILES]

/** One mahjong tile: numbered suit tile (optionally red five) or an honor. */
const TILE_RE = /^(?:[1-9][mps]|5[mps]r|[ESWNPFC])$/

/** Log lines kept in the engine state (snapshot trims further). */
const LOG_LIMIT = 40

/* -------------------------------------------------------------------------- *
 * Tiles
 * -------------------------------------------------------------------------- */

/** True for a syntactically valid M1 tile. */
export function isTile(tile) {
  return typeof tile === 'string' && TILE_RE.test(tile)
}

/** Parse a tile into {tile, honor, suit?, rank?, red}. Returns null if invalid. */
export function parseTile(tile) {
  if (!isTile(tile)) return null
  if (HONOR_TILES.includes(tile)) {
    return { tile, honor: true, suit: undefined, rank: 0, red: false }
  }
  const red = tile.endsWith('r')
  const body = red ? tile.slice(0, -1) : tile
  return {
    tile,
    honor: false,
    suit: body.slice(-1),
    rank: Number(body.slice(0, -1)),
    red,
  }
}

/** Base tile without the red-five marker ('5mr' -> '5m'). */
export function tileBase(tile) {
  const parsed = parseTile(tile)
  if (parsed === null) return undefined
  if (parsed.honor) return parsed.tile
  return String(parsed.rank) + parsed.suit
}

/** Sort key: m/p/s by rank, honors last; red five first among its rank. */
function sortKey(tile) {
  const parsed = parseTile(tile)
  if (parsed === null) return 10_000
  if (parsed.honor) return 5_000 + HONOR_TILES.indexOf(parsed.tile)
  const suitIndex = SUITS.indexOf(parsed.suit)
  return suitIndex * 1_000 + parsed.rank * 10 + (parsed.red ? 0 : 1)
}

/** Deterministic ascending hand order. */
export function sortHand(tiles) {
  if (!Array.isArray(tiles)) return []
  return tiles.slice().sort((a, b) => sortKey(a) - sortKey(b) || String(a).localeCompare(String(b)))
}

/** Normalize a mode id (defaults to four-player). */
export function normalizeMode(mode) {
  return mode === 'mahjong3' || mode === 3 ? 'mahjong3' : 'mahjong4'
}

/**
 * Build the shuffled-order tile pool for a mode.
 * 4-player: 136 tiles with red 5m/5p/5s; 3-player: 108 tiles (2m-8m removed)
 * with red 5p/5s only.
 */
export function buildWall(mode) {
  const safeMode = normalizeMode(mode)
  const three = safeMode === 'mahjong3'
  const tiles = []
  for (const suit of SUITS) {
    const ranks = three && suit === 'm' ? [1, 9] : [1, 2, 3, 4, 5, 6, 7, 8, 9]
    for (const rank of ranks) {
      for (let copy = 0; copy < 4; copy += 1) {
        if (rank === 5) {
          const redAllowed = three ? suit !== 'm' : true
          tiles.push(redAllowed && copy === 0 ? '5' + suit + 'r' : '5' + suit)
        } else {
          tiles.push(String(rank) + suit)
        }
      }
    }
  }
  for (const honor of HONOR_TILES) {
    for (let copy = 0; copy < 4; copy += 1) tiles.push(honor)
  }
  return tiles
}

/** Fisher–Yates shuffle over a copy. */
function shuffle(deck, rng) {
  const cards = deck.slice()
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    const current = cards[index]
    cards[index] = cards[swap]
    cards[swap] = current
  }
  return cards
}

/** Counts of base tiles. */
function countBaseTiles(tiles) {
  const counts = new Map()
  for (const tile of tiles) {
    const base = tileBase(tile)
    if (base === undefined) continue
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  return counts
}

/** True when the remaining counts decompose into melds (triplets/sequences). */
function meldsPossible(counts) {
  const keys = [...counts.keys()]
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .sort((a, b) => sortKey(a) - sortKey(b))
  if (keys.length === 0) return true
  const key = keys[0]
  const count = counts.get(key) ?? 0
  // Triplet.
  if (count >= 3) {
    counts.set(key, count - 3)
    if (meldsPossible(counts)) {
      counts.set(key, count)
      return true
    }
    counts.set(key, count)
  }
  // Sequence (suited only, ranks 1..7).
  const parsed = parseTile(key)
  if (parsed !== null && !parsed.honor && parsed.rank <= 7) {
    const next = String(parsed.rank + 1) + parsed.suit
    const after = String(parsed.rank + 2) + parsed.suit
    if ((counts.get(next) ?? 0) > 0 && (counts.get(after) ?? 0) > 0) {
      counts.set(key, count - 1)
      counts.set(next, counts.get(next) - 1)
      counts.set(after, counts.get(after) - 1)
      if (meldsPossible(counts)) {
        counts.set(key, count)
        counts.set(next, counts.get(next) + 1)
        counts.set(after, counts.get(after) + 1)
        return true
      }
      counts.set(key, count)
      counts.set(next, counts.get(next) + 1)
      counts.set(after, counts.get(after) + 1)
    }
  }
  return false
}

/** True for seven distinct pairs (strict riichi shape; a quad is not two pairs). */
export function isSevenPairs(tiles) {
  if (!Array.isArray(tiles) || tiles.length !== 14 || !tiles.every(isTile)) return false
  const counts = countBaseTiles(tiles)
  if (counts.size !== 7) return false
  for (const count of counts.values()) {
    if (count !== 2) return false
  }
  return true
}

/** True for thirteen orphans (国士无双). */
export function isKokushi(tiles) {
  if (!Array.isArray(tiles) || tiles.length !== 14 || !tiles.every(isTile)) return false
  const counts = countBaseTiles(tiles)
  if (counts.size !== ORPHANS.length) return false
  let doubled = false
  for (const orphan of ORPHANS) {
    const count = counts.get(orphan) ?? 0
    if (count < 1) return false
    if (count > 2) return false
    if (count === 2) {
      if (doubled) return false
      doubled = true
    }
  }
  return doubled
}

/**
 * Basic M1 winning-shape test on exactly 14 tiles:
 * four melds + a pair, seven pairs, or thirteen orphans. No yaku/fu/points.
 */
export function isWinningHand(tiles) {
  if (!Array.isArray(tiles) || tiles.length !== 14 || !tiles.every(isTile)) return false
  const counts = countBaseTiles(tiles)
  for (const count of counts.values()) {
    // A rack can never hold more than four copies of one base tile.
    if (count > 4) return false
  }
  if (isSevenPairs(tiles)) return true
  if (isKokushi(tiles)) return true
  const pairCandidates = [...counts.keys()].filter((key) => (counts.get(key) ?? 0) >= 2)
  for (const pair of pairCandidates) {
    counts.set(pair, counts.get(pair) - 2)
    const ok = meldsPossible(counts)
    counts.set(pair, counts.get(pair) + 2)
    if (ok) return true
  }
  return false
}

/**
 * Winning-shape test that accounts for already-melded sets (M2). `tiles` holds
 * only the concealed hand; the required length is 14 - 3*melds. Seven pairs and
 * thirteen orphans require a fully concealed hand.
 */
export function isWinningShape(tiles, meldCount = 0) {
  if (!Array.isArray(tiles) || !tiles.every(isTile)) return false
  const melds = Number.isInteger(meldCount) && meldCount > 0 ? meldCount : 0
  const expected = 14 - melds * 3
  if (tiles.length !== expected) return false
  if (melds === 0) return isWinningHand(tiles)
  const counts = countBaseTiles(tiles)
  for (const count of counts.values()) {
    if (count > 4) return false
  }
  const pairCandidates = [...counts.keys()].filter((key) => (counts.get(key) ?? 0) >= 2)
  for (const pair of pairCandidates) {
    counts.set(pair, counts.get(pair) - 2)
    const ok = meldsPossible(counts)
    counts.set(pair, counts.get(pair) + 2)
    if (ok) return true
  }
  return false
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

/** Required seat count for a mode. */
function seatsForMode(mode) {
  return normalizeMode(mode) === 'mahjong3' ? 3 : 4
}

/** Live wall tiles still available. */
function wallCount(state) {
  return Math.max(0, state.liveTiles.length - state.wallIndex)
}

/** Fresh player record. */
function makePlayer(raw) {
  return {
    node: typeof raw?.node === 'string' ? raw.node : '',
    nick: text(raw?.nick, 24) ?? '玩家',
    bot: raw?.bot === true,
    hand: [],
    discards: [],
    drawnTile: null,
    melds: [],
    furiten: false,
  }
}

/** End the hand because the live wall is empty. */
function endExhausted(state) {
  if (state.phase === 'result') return
  state.phase = 'result'
  state.result = 'exhausted'
  state.winnerNode = null
  state.turn = null
  log(state, '流局：活牌墙摸完')
}

/** Draw one tile from the live wall into a player's hand. */
function drawTo(state, player) {
  if (state.wallIndex >= state.liveTiles.length) {
    endExhausted(state)
    return false
  }
  const tile = state.liveTiles[state.wallIndex]
  state.wallIndex += 1
  player.hand = sortHand([...player.hand, tile])
  player.drawnTile = tile
  player.furiten = false
  state.wall = wallCount(state)
  return true
}

/** Advance to the next seat, draw, and set the turn. */
function advanceTurn(state) {
  const index = indexOfNode(state, state.turn)
  if (index < 0) return
  const next = state.players[(index + 1) % state.players.length]
  state.turn = next.node
  drawTo(state, next)
}

/* -------------------------------------------------------------------------- *
 * Table lifecycle
 * -------------------------------------------------------------------------- */

/**
 * Build an idle mahjong table. `options.mode` (or the player count) selects
 * `mahjong4` / `mahjong3`; the host passes the game id explicitly.
 */
export function createTable(players = [], options = {}) {
  const rawMode = options !== null && typeof options === 'object' && !Array.isArray(options)
    ? options.mode
    : options
  const mode = rawMode === undefined || rawMode === null
    ? ((Array.isArray(players) && players.length === 3) ? 'mahjong3' : 'mahjong4')
    : normalizeMode(rawMode)
  const state = {
    game: mode,
    mode,
    phase: 'idle',
    round: 0,
    dealer: null,
    turn: null,
    wall: 0,
    doraIndicator: null,
    nuki: 0,
    players: (Array.isArray(players) ? players : []).slice(0, seatsForMode(mode)).map(makePlayer),
    liveTiles: [],
    deadTiles: [],
    wallIndex: 0,
    deadDrawIndex: 1,
    result: null,
    winnerNode: null,
    doras: [],
    lastDiscard: null,
    mustDiscard: false,
    pending: [],
    pendingOrder: [],
    responses: {},
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
  if (state.players.length >= seatsForMode(state.mode)) return { ok: false, error: 'full' }
  state.players.push(player)
  ensureScore(state, player.node)
  return { ok: true }
}

/** Start the next hand: rotate the dealer, build the wall and deal. */
export function startRound(state, rng = Math.random) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const required = seatsForMode(state.mode)
  if (state.players.length !== required) return { ok: false, error: 'no-players' }
  if (state.phase === 'playing' || state.phase === 'calling') return { ok: false, error: 'bad-phase' }

  state.round += 1
  state.phase = 'playing'
  state.log = []
  state.result = null
  state.winnerNode = null
  state.nuki = 0
  state.lastDiscard = null
  state.mustDiscard = false
  state.pending = []
  state.pendingOrder = []
  state.responses = {}
  const previousDealer = state.dealer === null ? -1 : indexOfNode(state, state.dealer)
  const dealerIndex = previousDealer < 0 ? 0 : (previousDealer + 1) % state.players.length
  state.dealer = state.players[dealerIndex].node

  const pool = shuffle(buildWall(state.mode), rng)
  state.deadTiles = pool.slice(pool.length - DEAD_WALL_SIZE)
  state.liveTiles = pool.slice(0, pool.length - DEAD_WALL_SIZE)
  state.wallIndex = 0
  state.deadDrawIndex = 1
  state.doras = state.deadTiles[0] === undefined ? [] : [state.deadTiles[0]]
  state.doraIndicator = state.doras[0] ?? null

  state.players.forEach((player) => {
    player.hand = []
    player.discards = []
    player.drawnTile = null
    player.melds = []
    player.furiten = false
  })
  let cursor = 0
  for (const player of state.players) {
    player.hand = sortHand(state.liveTiles.slice(cursor, cursor + 13))
    cursor += 13
  }
  const dealer = state.players[dealerIndex]
  const extra = state.liveTiles[cursor]
  cursor += 1
  dealer.hand = sortHand([...dealer.hand, extra])
  dealer.drawnTile = extra
  state.wallIndex = cursor
  state.wall = wallCount(state)
  state.turn = dealer.node
  log(state, state.mode === 'mahjong3' ? '日麻三人局开始' : '日麻四人局开始')
  log(state, (dealer.nick ?? '玩家') + ' 坐庄')
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- *
 * Actions (M1 draw/discard + M2 calls / kan / ron)
 * -------------------------------------------------------------------------- */

/** Base-tile occurrence count in a hand. */
function baseCount(hand, base) {
  let count = 0
  for (const tile of hand) {
    if (tileBase(tile) === base) count += 1
  }
  return count
}

/** Remove `count` tiles of one base tile from a hand; returns the actual tiles. */
function removeBaseTiles(hand, base, count) {
  const removed = []
  for (let index = hand.length - 1; index >= 0 && removed.length < count; index -= 1) {
    if (tileBase(hand[index]) === base) removed.push(hand.splice(index, 1)[0])
  }
  if (removed.length !== count) {
    hand.push(...removed)
    return undefined
  }
  return removed
}

/** How many melds a player has already exposed / declared. */
function meldCountOf(player) {
  return Array.isArray(player.melds) ? player.melds.length : 0
}

/** Chi options: pairs of hand tiles that complete a sequence with `discardTile`. */
function chiOptionsFor(hand, discardTile) {
  const parsed = parseTile(discardTile)
  if (parsed === null || parsed.honor) return []
  const { suit, rank } = parsed
  const tileOf = (targetRank) => hand.find((tile) => {
    const info = parseTile(tile)
    return info !== null && !info.honor && info.suit === suit && info.rank === targetRank
  })
  const options = []
  const keys = new Set()
  const push = (low, high) => {
    if (low < 1 || high > 9) return
    const first = tileOf(low)
    const second = tileOf(high)
    if (first === undefined || second === undefined) return
    const key = [tileBase(first), tileBase(second)].sort().join(',')
    if (keys.has(key)) return
    keys.add(key)
    options.push(sortHand([first, second]))
  }
  push(rank - 2, rank - 1)
  push(rank - 1, rank + 1)
  push(rank + 1, rank + 2)
  return options
}

/** Add one new dora indicator from the dead wall (M2: indicator only). */
function addDoraIndicator(state) {
  if (state.deadDrawIndex < state.deadTiles.length) {
    state.doras.push(state.deadTiles[state.deadDrawIndex])
    state.deadDrawIndex += 1
    state.doraIndicator = state.doras[0] ?? null
  }
}

/** Draw a replacement tile from the dead wall (live wall fallback). */
function drawReplacement(state, player) {
  let tile
  if (state.deadDrawIndex < state.deadTiles.length) {
    tile = state.deadTiles[state.deadDrawIndex]
    state.deadDrawIndex += 1
  } else if (state.wallIndex < state.liveTiles.length) {
    tile = state.liveTiles[state.wallIndex]
    state.wallIndex += 1
  } else {
    endExhausted(state)
    return false
  }
  player.hand = sortHand([...player.hand, tile])
  player.drawnTile = tile
  state.wall = wallCount(state)
  return true
}

/** Clear the call window bookkeeping. */
function clearCallState(state) {
  state.pending = []
  state.pendingOrder = []
  state.responses = {}
  state.phase = 'playing'
}

/** Build the call window after a discard; returns true when somebody may act. */
function makeCallWindow(state, discarder, tile) {
  const discarderIndex = indexOfNode(state, discarder.node)
  const base = tileBase(tile)
  const entries = []
  for (let step = 1; step < state.players.length; step += 1) {
    const player = state.players[(discarderIndex + step) % state.players.length]
    const allowed = []
    let chiOptions
    if (player.furiten !== true && isWinningShape([...player.hand, tile], meldCountOf(player))) {
      allowed.push('ron')
    }
    const count = baseCount(player.hand, base)
    if (count >= 2) allowed.push('pon')
    if (count >= 3) allowed.push('kan')
    if (step === 1) {
      const options = chiOptionsFor(player.hand, tile)
      if (options.length > 0) {
        allowed.push('chi')
        chiOptions = options
      }
    }
    if (allowed.length === 0) continue
    const entry = { node: player.node, allowed }
    if (chiOptions !== undefined) entry.chiOptions = chiOptions
    entries.push(entry)
  }
  if (entries.length === 0) return false
  state.phase = 'calling'
  state.pending = entries
  state.pendingOrder = entries.map((entry) => entry.node)
  state.responses = {}
  state.turn = entries[0].node
  log(state, discarder.nick + ' 打出 ' + tile + '，等待响应')
  return true
}

/** Validate one call response payload, returning the hand tiles to take. */
function validateCallTiles(hand, entry, type, discardTile, tiles) {
  const base = tileBase(discardTile)
  const normalized = Array.isArray(tiles) ? tiles.filter(isTile) : []
  if (type === 'pon' || type === 'kan') {
    const wanted = type === 'pon' ? 2 : 3
    if (normalized.length !== wanted || !normalized.every((tile) => tileBase(tile) === base)) {
      return { error: 'bad-call' }
    }
    const remaining = hand.slice()
    const picked = []
    for (const tile of normalized) {
      const index = remaining.indexOf(tile)
      if (index < 0) return { error: 'bad-call' }
      remaining.splice(index, 1)
      picked.push(tile)
    }
    return { handTiles: picked }
  }
  if (type === 'chi') {
    const options = Array.isArray(entry.chiOptions) ? entry.chiOptions : []
    const key = (list) => list.map((tile) => tileBase(tile)).sort().join(',')
    let option
    if (normalized.length === 2) {
      option = options.find((candidate) => key(candidate) === key(normalized))
    } else if (options.length === 1) {
      option = options[0]
    }
    if (option === undefined) return { error: 'bad-call' }
    const remaining = hand.slice()
    const picked = []
    for (const tile of option) {
      const index = remaining.indexOf(tile)
      if (index < 0) return { error: 'bad-call' }
      remaining.splice(index, 1)
      picked.push(tile)
    }
    return { handTiles: picked }
  }
  return { error: 'bad-call' }
}

/** Record one pending player's response; resolve once everyone answered. */
function applyCallResponse(state, player, action) {
  const entry = state.pending.find((candidate) => candidate.node === player.node)
  if (entry === undefined) return { ok: false, error: 'not-pending' }
  if (action.type === 'pass') {
    state.responses[player.node] = { type: 'pass' }
    // Temporary furiten: passing on a winning discard blocks later ron.
    if (entry.allowed.includes('ron')) player.furiten = true
  } else {
    if (!entry.allowed.includes(action.type)) {
      if (action.type === 'ron' && player.furiten === true) return { ok: false, error: 'furiten' }
      return { ok: false, error: 'bad-call' }
    }
    if (action.type === 'ron') {
      state.responses[player.node] = { type: 'ron' }
    } else {
      const validated = validateCallTiles(player.hand, entry, action.type, state.lastDiscard.tile, action.tiles)
      if (validated.error !== undefined) return { ok: false, error: validated.error }
      state.responses[player.node] = { type: action.type, handTiles: validated.handTiles }
    }
  }
  state.pending = state.pending.filter((candidate) => candidate.node !== player.node)
  if (state.pending.length === 0) {
    resolveCalls(state)
    return { ok: true }
  }
  state.turn = state.pending[0].node
  return { ok: true }
}

/** Ron: the winner takes the discard into the hand and the hand ends. */
function applyRon(state, node) {
  const winner = playerOf(state, node)
  const discardInfo = state.lastDiscard
  if (winner === undefined || discardInfo === null) return { ok: false, error: 'bad-call' }
  const discarder = playerOf(state, discardInfo.node)
  if (discarder !== undefined && discarder.discards[discarder.discards.length - 1] === discardInfo.tile) {
    discarder.discards.pop()
  }
  winner.hand = sortHand([...winner.hand, discardInfo.tile])
  clearCallState(state)
  state.phase = 'result'
  state.result = 'ron'
  state.winnerNode = node
  state.turn = null
  state.mustDiscard = false
  for (const entry of state.players) {
    const bucket = ensureScore(state, entry.node)
    if (entry.node === node) bucket.win += 1
    else bucket.lose += 1
  }
  log(state, winner.nick + ' 荣和（里程碑②）')
  return { ok: true }
}

/** Pon / chi / open kan: expose the meld and make the caller discard next. */
function applyCallMeld(state, node, response) {
  const caller = playerOf(state, node)
  const discardInfo = state.lastDiscard
  if (caller === undefined || discardInfo === null) return { ok: false, error: 'bad-call' }
  const discarder = playerOf(state, discardInfo.node)
  if (discarder !== undefined && discarder.discards[discarder.discards.length - 1] === discardInfo.tile) {
    discarder.discards.pop()
  }
  for (const tile of response.handTiles) {
    const index = caller.hand.indexOf(tile)
    if (index < 0) return { ok: false, error: 'bad-call' }
    caller.hand.splice(index, 1)
  }
  const meldTiles = sortHand([...response.handTiles, discardInfo.tile])
  caller.melds.push({ type: response.type, tiles: meldTiles, from: discardInfo.node })
  clearCallState(state)
  state.turn = caller.node
  state.mustDiscard = true
  if (response.type === 'kan') {
    // M2: an open kan is a call — the caller must discard without drawing.
    addDoraIndicator(state)
  }
  log(state, caller.nick + (response.type === 'pon' ? ' 碰 ' : (response.type === 'kan' ? ' 大明杠 ' : ' 吃 '))
    + meldTiles.join(''))
  return { ok: true }
}

/** Resolve the call window by priority: ron > kan/pon > chi (seat order). */
function resolveCalls(state) {
  const order = state.pendingOrder
  const responses = state.responses
  const firstWith = (types) => order.find((node) => {
    const response = responses[node]
    return response !== undefined && types.includes(response.type)
  })
  const ronNode = firstWith(['ron'])
  const meldNode = firstWith(['kan', 'pon'])
  const chiNode = firstWith(['chi'])
  if (ronNode !== undefined) {
    applyRon(state, ronNode)
    return
  }
  if (meldNode !== undefined) {
    applyCallMeld(state, meldNode, responses[meldNode])
    return
  }
  if (chiNode !== undefined) {
    applyCallMeld(state, chiNode, responses[chiNode])
    return
  }
  // Nobody called: the next seat draws.
  const discardInfo = state.lastDiscard
  clearCallState(state)
  if (discardInfo !== null) {
    state.turn = discardInfo.node
    advanceTurn(state)
  } else {
    state.turn = null
  }
}

/** Ankan: four identical concealed tiles, replacement draw + new dora. */
function applyAnkan(state, player, action) {
  const tile = typeof action.tile === 'string' ? action.tile : ''
  if (!isTile(tile)) return { ok: false, error: 'bad-tile' }
  const base = tileBase(tile)
  const picked = removeBaseTiles(player.hand, base, 4)
  if (picked === undefined || picked.length !== 4) return { ok: false, error: 'bad-tile' }
  player.melds.push({ type: 'ankan', tiles: sortHand(picked), from: null })
  if (!drawReplacement(state, player)) return { ok: true }
  addDoraIndicator(state)
  state.mustDiscard = true
  log(state, player.nick + ' 暗杠 ' + base)
  return { ok: true }
}

/** Kakan: add the fourth tile to an existing pon, replacement draw + new dora. */
function applyKakan(state, player, action) {
  const tile = typeof action.tile === 'string' ? action.tile : ''
  if (!isTile(tile)) return { ok: false, error: 'bad-tile' }
  const base = tileBase(tile)
  const meld = player.melds.find((entry) => entry.type === 'pon'
    && Array.isArray(entry.tiles) && entry.tiles.length > 0 && tileBase(entry.tiles[0]) === base)
  if (meld === undefined) return { ok: false, error: 'bad-tile' }
  const index = player.hand.findIndex((candidate) => tileBase(candidate) === base)
  if (index < 0) return { ok: false, error: 'bad-tile' }
  const actual = player.hand.splice(index, 1)[0]
  meld.type = 'kakan'
  meld.tiles = sortHand([...meld.tiles, actual])
  if (!drawReplacement(state, player)) return { ok: true }
  addDoraIndicator(state)
  state.mustDiscard = true
  log(state, player.nick + ' 加杠 ' + base)
  return { ok: true }
}

/** discard: play one tile, then open the call window or move on. */
function applyDiscard(state, player, action) {
  const tile = typeof action.tile === 'string' ? action.tile : ''
  if (!isTile(tile)) return { ok: false, error: 'bad-tile' }
  const index = player.hand.indexOf(tile)
  if (index < 0) return { ok: false, error: 'bad-tile' }
  player.hand.splice(index, 1)
  player.discards.push(tile)
  player.drawnTile = null
  player.furiten = false
  state.lastDiscard = { node: player.node, tile }
  state.mustDiscard = false
  log(state, player.nick + ' 打出 ' + tile)
  // Auto (timeout) discards skip the call window so a timeout-only hand can
  // run to its result without waiting for human call responses.
  if (action.auto === true || !makeCallWindow(state, player, tile)) advanceTurn(state)
  return { ok: true }
}

/** tsumo: declare a win on the current concealed hand (M2 melds allowed). */
function applyTsumo(state, player) {
  if (state.mustDiscard === true) return { ok: false, error: 'bad-action' }
  if (!isWinningShape(player.hand, meldCountOf(player))) return { ok: false, error: 'not-winning' }
  state.phase = 'result'
  state.result = 'tsumo'
  state.winnerNode = player.node
  state.turn = null
  for (const entry of state.players) {
    const bucket = ensureScore(state, entry.node)
    if (entry.node === player.node) bucket.win += 1
    else bucket.lose += 1
  }
  log(state, player.nick + ' 自摸和了（里程碑②）')
  return { ok: true }
}

/** nuki (3-player only): set a north tile aside, draw a dead-wall tile, keep acting. */
function applyNuki(state, player, action) {
  if (state.mode !== 'mahjong3') return { ok: false, error: 'bad-action' }
  const tile = typeof action.tile === 'string' ? action.tile : 'N'
  if (tile !== 'N') return { ok: false, error: 'bad-tile' }
  const index = player.hand.indexOf('N')
  if (index < 0) return { ok: false, error: 'bad-tile' }
  player.hand.splice(index, 1)
  state.nuki += 1
  let replacement
  if (state.deadDrawIndex < state.deadTiles.length) {
    replacement = state.deadTiles[state.deadDrawIndex]
    state.deadDrawIndex += 1
  } else if (state.wallIndex < state.liveTiles.length) {
    replacement = state.liveTiles[state.wallIndex]
    state.wallIndex += 1
  } else {
    endExhausted(state)
    return { ok: true }
  }
  player.hand = sortHand([...player.hand, replacement])
  player.drawnTile = replacement
  state.wall = wallCount(state)
  log(state, player.nick + ' 拔北，补摸 ' + replacement)
  return { ok: true }
}

/** Apply one action from `node` (call responses or the current player's action). */
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
  if (state.phase === 'calling') return applyCallResponse(state, player, action)
  if (state.phase !== 'playing') return { ok: false, error: 'bad-phase' }
  if (state.turn !== node) return { ok: false, error: 'not-your-turn' }
  switch (action.type) {
    case 'discard': return applyDiscard(state, player, action)
    case 'tsumo': return applyTsumo(state, player)
    case 'nuki': return applyNuki(state, player, action)
    case 'ankan': return applyAnkan(state, player, action)
    case 'kakan': return applyKakan(state, player, action)
    default: return { ok: false, error: 'bad-action' }
  }
}

/** Timeout: pass in the call window, otherwise auto-discard the drawn tile. */
export function onTimeout(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (state.phase === 'calling') {
    const pending = state.pending.find((entry) => entry.node === node)
    return pending === undefined ? null : { type: 'pass' }
  }
  if (state.phase !== 'playing' || state.turn !== node) return null
  const player = playerOf(state, node)
  if (player === undefined || player.hand.length === 0) return null
  const tile = player.drawnTile !== null && player.hand.includes(player.drawnTile)
    ? player.drawnTile
    : player.hand[player.hand.length - 1]
  return { type: 'discard', tile, auto: true }
}

/** Bot action: not supported in milestone ②. */
export function botAction() {
  return null
}

/* -------------------------------------------------------------------------- *
 * Leaving / disconnects
 * -------------------------------------------------------------------------- */

/** Remove one player; a mid-hand leave ends the hand as a draw in M2. */
export function removePlayer(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const index = indexOfNode(state, node)
  if (index < 0) return { ok: false, error: 'unknown-player' }
  const leaving = state.players[index]
  if (state.phase === 'idle' || state.phase === 'result') {
    state.players.splice(index, 1)
    if (state.dealer === node) state.dealer = state.players[0]?.node ?? null
    if (state.turn === node) state.turn = null
    return { ok: true }
  }
  if (state.phase === 'calling') {
    const wasDiscarder = state.lastDiscard !== null && state.lastDiscard.node === node
    state.players.splice(index, 1)
    log(state, (leaving.nick ?? '玩家') + ' 离开牌桌')
    if (state.players.length < seatsForMode(state.mode)) {
      endExhausted(state)
      return { ok: true }
    }
    state.pending = state.pending.filter((entry) => entry.node !== node)
    state.pendingOrder = state.pendingOrder.filter((pendingNode) => pendingNode !== node)
    delete state.responses[node]
    if (wasDiscarder) {
      clearCallState(state)
      const next = state.players[index % state.players.length]
      state.turn = next.node
      drawTo(state, next)
      return { ok: true }
    }
    if (state.pending.length === 0) {
      resolveCalls(state)
      return { ok: true }
    }
    state.turn = state.pending[0].node
    return { ok: true }
  }
  state.players.splice(index, 1)
  log(state, (leaving.nick ?? '玩家') + ' 离开牌桌')
  if (state.players.length < seatsForMode(state.mode)) {
    endExhausted(state)
    return { ok: true }
  }
  if (state.dealer === node) state.dealer = state.players[0].node
  if (state.turn === node) {
    const next = state.players[index % state.players.length]
    state.turn = next.node
    drawTo(state, next)
  } else if (state.turn === null) {
    state.turn = state.players[0].node
  }
  return { ok: true }
}

/* -------------------------------------------------------------------------- *
 * Snapshot (per-viewer privacy)
 * -------------------------------------------------------------------------- */

/** Normalize a table node id for the wire (bots/short ids included). */
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

/** Sanitize a hand list. */
function sanitizeTiles(raw, limit = 14) {
  if (!Array.isArray(raw)) return []
  return raw.filter(isTile).slice(0, limit)
}

/** Sanitize one player's exposed melds. */
function sanitizeMelds(raw) {
  if (!Array.isArray(raw)) return []
  const types = new Set(['chi', 'pon', 'kan', 'ankan', 'kakan'])
  return raw.slice(0, 4).map((meld) => ({
    type: types.has(meld?.type) ? meld.type : 'pon',
    tiles: sanitizeTiles(meld?.tiles, 4),
    from: wireNode(meld?.from),
  }))
}

/** Sanitize the pending response list for the wire. */
function sanitizePending(raw) {
  if (!Array.isArray(raw)) return []
  const allowedTypes = new Set(['ron', 'pon', 'kan', 'chi'])
  return raw.slice(0, 4).map((entry) => {
    const view = {
      node: wireNode(entry?.node) ?? '',
      allowed: Array.isArray(entry?.allowed)
        ? entry.allowed.filter((type) => allowedTypes.has(type))
        : [],
    }
    if (Array.isArray(entry?.chiOptions)) {
      view.chiOptions = entry.chiOptions.slice(0, 3).map((option) => sanitizeTiles(option, 2))
    }
    return view
  })
}

/**
 * Build the per-viewer `view.table` / state.table JSON (PROTOCOL.md 7.18/7.20).
 * `myHand` is only ever the viewer's own hand; result reveals every hand.
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
      count: Array.isArray(player.hand) ? player.hand.length : 0,
      discards: Array.isArray(player.discards) ? player.discards.filter(isTile).slice(0, 100) : [],
      melds: sanitizeMelds(player.melds),
      furiten: player.furiten === true,
    }
    if (revealed) entry.hand = sanitizeTiles(player.hand)
    return entry
  })

  const myHand = viewer !== undefined ? sanitizeTiles(viewer.hand) : []
  const staleMs = Number.isInteger(safeMeta.staleMs) ? Math.max(0, safeMeta.staleMs) : 0
  const turnRemaining = Number.isInteger(safeMeta.turnRemainingMs)
    ? Math.min(300_000, Math.max(0, safeMeta.turnRemainingMs))
    : null
  const furiten = {}
  for (const player of nodes) furiten[player.node] = player.furiten === true
  const lastDiscard = state?.lastDiscard !== null && typeof state?.lastDiscard === 'object'
    ? {
        node: wireNode(state.lastDiscard.node) ?? '',
        tile: isTile(state.lastDiscard.tile) ? state.lastDiscard.tile : null,
      }
    : null
  const doras = Array.isArray(state?.doras)
    ? state.doras.filter(isTile).slice(0, 8)
    : (isTile(state?.doraIndicator) ? [state.doraIndicator] : [])

  return {
    game: normalizeMode(state?.mode),
    role,
    hostNode: wireNode(safeMeta.hostNode) ?? '',
    phase: state?.phase === 'playing' || state?.phase === 'calling' || state?.phase === 'result'
      ? state.phase
      : 'idle',
    calling: state?.phase === 'calling',
    round: Number.isInteger(state?.round) ? Math.max(0, state.round) : 0,
    dealer: wireNode(state?.dealer),
    turn: wireNode(state?.turn),
    wall: wallCount(state ?? { liveTiles: [], wallIndex: 0 }),
    doraIndicator: doras.length > 0 ? doras[0] : null,
    doras,
    nuki: Number.isInteger(state?.nuki) ? Math.max(0, state.nuki) : 0,
    discards: players.map((player) => player.discards),
    melds: players.map((player) => player.melds),
    myHand,
    players,
    pending: sanitizePending(state?.pending),
    lastDiscard,
    mustDiscard: state?.mustDiscard === true,
    furiten,
    result: state?.result === 'tsumo' || state?.result === 'ron' || state?.result === 'exhausted'
      ? state.result
      : null,
    winnerNode: wireNode(state?.winnerNode),
    log: Array.isArray(state?.log)
      ? state.log.map((line) => text(line, 80)).filter((line) => line !== undefined).slice(-8)
      : [],
    scores: scoresFor(state, players),
    staleMs,
    turnRemainingMs: turnRemaining,
  }
}
