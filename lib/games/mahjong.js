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


/** Tile types used when enumerating waits for the tenpai test. */
const TENPAI_TILES = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s',
  'E', 'S', 'W', 'N', 'P', 'F', 'C',
]

/** True when a concealed hand (13 - 3*melds) is one tile away from a win. */
export function isTenpaiTiles(tiles, meldCount = 0) {
  if (!Array.isArray(tiles) || !tiles.every(isTile)) return false
  const melds = Number.isInteger(meldCount) && meldCount > 0 ? meldCount : 0
  const need = 13 - melds * 3
  if (tiles.length === need + 1) {
    // Mid-turn hand: tenpai when any discard leaves a ready hand.
    const seen = new Set(tiles.map(tileBase))
    for (const tile of seen) {
      const index = tiles.indexOf(tile)
      if (index < 0) continue
      const rest = tiles.slice()
      rest.splice(index, 1)
      if (isTenpaiTiles(rest, melds)) return true
    }
    return false
  }
  if (tiles.length !== need) return false
  for (const tile of TENPAI_TILES) {
    if (isWinningShape([...tiles, tile], melds)) return true
  }
  return false
}

/** Tenpai test for one engine player (hand + exposed meld count). */
export function isTenpai(player) {
  if (Array.isArray(player)) return isTenpaiTiles(player, 0)
  if (player === null || typeof player !== 'object') return false
  return isTenpaiTiles(player.hand ?? [], (player.melds ?? []).length)
}


/* -------------------------------------------------------------------------- *
 * M3 scoring: yaku / fu / points / dora / riichi helpers
 * -------------------------------------------------------------------------- */

/** Dora indicator order for honors (east→south→west→north→haku→hatsu→chun→east). */
const HONOR_DORA_ORDER = ['E', 'S', 'W', 'N', 'P', 'F', 'C']

/** Honor / terminal base-tile sets. */
const HONOR_SET = new Set(HONOR_TILES)
const TERMINAL_SET = new Set(['1m', '9m', '1p', '9p', '1s', '9s'])
const DRAGON_SET = new Set(['P', 'F', 'C'])
const WIND_SEAT = ['E', 'S', 'W', 'N']

/** Dora tile for one indicator. */
export function doraTile(indicator) {
  const parsed = parseTile(indicator)
  if (parsed === null) return undefined
  if (parsed.honor) {
    const index = HONOR_DORA_ORDER.indexOf(parsed.tile)
    return HONOR_DORA_ORDER[(index + 1) % HONOR_DORA_ORDER.length]
  }
  const rank = parsed.rank === 9 ? 1 : parsed.rank + 1
  return String(rank) + parsed.suit
}

/** Dealer-relative seat wind for a node (3-player mode has no North). */
function seatWindOf(state, node) {
  const dealerIndex = indexOfNode(state, state.dealer)
  const playerIndex = indexOfNode(state, node)
  if (dealerIndex < 0 || playerIndex < 0) return 'E'
  const count = state.players.length
  const winds = count === 3 ? ['E', 'S', 'W'] : WIND_SEAT
  return winds[(playerIndex - dealerIndex + count) % count] ?? 'E'
}

/** Player melds converted to the internal meld shape. */
function internalMelds(player) {
  const source = Array.isArray(player?.melds) ? player.melds : []
  return source.map((meld) => {
    const bases = (Array.isArray(meld?.tiles) ? meld.tiles : []).map(tileBase)
    if (meld?.type === 'chi') return { type: 'shuntsu', tiles: sortHand(bases), concealed: false }
    if (meld?.type === 'pon') return { type: 'koutsu', tiles: bases.slice(0, 3), concealed: false }
    if (meld?.type === 'kan') return { type: 'kantsu', tiles: bases.slice(0, 4), concealed: false }
    if (meld?.type === 'ankan') return { type: 'kantsu', tiles: bases.slice(0, 4), concealed: true }
    if (meld?.type === 'kakan') return { type: 'kantsu', tiles: bases.slice(0, 4), concealed: false }
    return { type: 'koutsu', tiles: bases.slice(0, 3), concealed: false }
  })
}

/** Consume melds from a count map; returns true when `need` melds are formed. */
function fillMelds(counts, need, acc, sortedKeys) {
  if (need === 0) return true
  const key = sortedKeys.find((candidate) => (counts.get(candidate) ?? 0) > 0)
  if (key === undefined) return false
  const count = counts.get(key) ?? 0
  if (count >= 3) {
    counts.set(key, count - 3)
    acc.push({ type: 'koutsu', tiles: [key, key, key], concealed: true })
    if (fillMelds(counts, need - 1, acc, sortedKeys)) return true
    acc.pop()
    counts.set(key, count)
  }
  const parsed = parseTile(key)
  if (parsed !== null && !parsed.honor && parsed.rank <= 7) {
    const second = String(parsed.rank + 1) + parsed.suit
    const third = String(parsed.rank + 2) + parsed.suit
    if ((counts.get(second) ?? 0) > 0 && (counts.get(third) ?? 0) > 0) {
      counts.set(key, count - 1)
      counts.set(second, counts.get(second) - 1)
      counts.set(third, counts.get(third) - 1)
      acc.push({ type: 'shuntsu', tiles: [key, second, third], concealed: true })
      if (fillMelds(counts, need - 1, acc, sortedKeys)) return true
      acc.pop()
      counts.set(key, count)
      counts.set(second, counts.get(second) + 1)
      counts.set(third, counts.get(third) + 1)
    }
  }
  return false
}

/** Decompose concealed tiles into pair + melds (first valid shape). */
function decomposeConcealed(tiles) {
  const bases = tiles.map(tileBase)
  if (bases.length < 2 || (bases.length - 2) % 3 !== 0) return null
  const need = (bases.length - 2) / 3
  const counts = countBaseTiles(bases)
  const sortedKeys = [...counts.keys()].sort((a, b) => sortKey(a) - sortKey(b))
  for (const pair of sortedKeys) {
    if ((counts.get(pair) ?? 0) < 2) continue
    counts.set(pair, counts.get(pair) - 2)
    const melds = []
    const ok = fillMelds(counts, need, melds, sortedKeys)
    counts.set(pair, counts.get(pair) + 2)
    if (ok) return { pair, melds }
  }
  return null
}

/** Analyze a winning hand: special shape or pair + all melds. */
function analyzeHand(tiles, playerMelds) {
  const external = internalMelds({ melds: playerMelds })
  const bases = tiles.map(tileBase)
  if (external.length === 0 && bases.length === 14) {
    if (isSevenPairs(tiles)) return { special: 'chiitoi', pair: null, melds: [] }
    if (isKokushi(tiles)) return { special: 'kokushi', pair: null, melds: [] }
  }
  const decomposed = decomposeConcealed(tiles)
  if (decomposed === null) return null
  return {
    special: null,
    pair: decomposed.pair,
    melds: [...external, ...decomposed.melds],
  }
}

/** Wait fu: 2 for tanki / kanchan / penchan, 0 for ryanmen. */
function waitFuOf(analysis, winBase) {
  if (analysis.pair === winBase) return 2
  for (const meld of analysis.melds) {
    if (meld.type !== 'shuntsu' || !meld.tiles.includes(winBase)) continue
    const ranks = meld.tiles.map((tile) => parseTile(tile)?.rank ?? 0).sort((a, b) => a - b)
    const index = meld.tiles.map(tileBase).indexOf(winBase)
    if (index === 1) return 2 // kanchan
    if (ranks[0] === 1 && winBase === meld.tiles.find((tile) => (parseTile(tile)?.rank ?? 0) === 3)) return 2
    if (ranks[2] === 9 && winBase === meld.tiles.find((tile) => (parseTile(tile)?.rank ?? 0) === 7)) return 2
    return 0
  }
  return 0
}

/** True when a shuntsu / koutsu touches a terminal or honor. */
function meldHasOutside(meld) {
  if (meld.type === 'shuntsu') {
    return meld.tiles.some((tile) => {
      const parsed = parseTile(tile)
      return parsed !== null && (parsed.rank === 1 || parsed.rank === 9)
    })
  }
  return meld.tiles.some((tile) => TERMINAL_SET.has(tile) || HONOR_SET.has(tile))
}

/** True when every tile is a terminal or an honor. */
function allTerminalOrHonor(bases) {
  return bases.every((tile) => TERMINAL_SET.has(tile) || HONOR_SET.has(tile))
}

/** True when every tile is a simple (2-8 suited) tile. */
function allSimples(bases) {
  return bases.every((tile) => {
    const parsed = parseTile(tile)
    return parsed !== null && !parsed.honor && parsed.rank >= 2 && parsed.rank <= 8
  })
}

/** Group melds into yakuman candidates + regular yaku. */
function evaluateYaku(tiles, player, ctx) {
  let analysis = analyzeHand(tiles, player?.melds ?? [])
  if (analysis === null) return []
  // A ryanpeikou hand is also seven-pairs-shaped; prefer the sequence yaku.
  if (analysis.special === 'chiitoi') {
    const alternate = decomposeConcealed(tiles)
    if (alternate !== null) {
      analysis = { special: null, pair: alternate.pair, melds: alternate.melds }
    }
  }
  const concealedBases = tiles.map(tileBase)
  const external = internalMelds(player)
  const melds = [...external, ...analysis.melds]
  const pair = analysis.pair
  const allBases = [...concealedBases, ...melds.flatMap((meld) => meld.tiles)]
  const closed = external.every((meld) => meld.type === 'kantsu' && meld.concealed)
  const yaku = []

  // ---- yakuman ----
  const yakuman = []
  const kantsuCount = melds.filter((meld) => meld.type === 'kantsu').length
  const concealedTriplets = melds.filter((meld) => (meld.type === 'koutsu' || meld.type === 'kantsu') && meld.concealed).length
  const tripletBases = melds
    .filter((meld) => meld.type === 'koutsu' || meld.type === 'kantsu')
    .map((meld) => meld.tiles[0])
  const dragonTriplets = tripletBases.filter((tile) => DRAGON_SET.has(tile))
  const windTriplets = tripletBases.filter((tile) => WIND_SEAT.includes(tile))
  if (analysis.special === 'kokushi') yakuman.push({ name: '国士无双', han: 13 })
  if (concealedTriplets === 4) yakuman.push({ name: '四暗刻', han: 13 })
  if (dragonTriplets.length === 3) yakuman.push({ name: '大三元', han: 13 })
  if (allBases.every((tile) => HONOR_SET.has(tile))) yakuman.push({ name: '字一色', han: 13 })
  const greenSet = new Set(['2s', '3s', '4s', '6s', '8s', 'F'])
  if (allBases.every((tile) => greenSet.has(tile))) yakuman.push({ name: '绿一色', han: 13 })
  if (allBases.every((tile) => TERMINAL_SET.has(tile))) yakuman.push({ name: '清老头', han: 13 })
  if (windTriplets.length === 3 && pair !== null && WIND_SEAT.includes(pair)) yakuman.push({ name: '小四喜', han: 13 })
  if (windTriplets.length === 4) yakuman.push({ name: '大四喜', han: 13 })
  if (kantsuCount === 4) yakuman.push({ name: '四杠子', han: 13 })
  if (closed && typeof pair === 'string' && !allBases.some((tile) => HONOR_SET.has(tile))) {
    const suits = new Set(allBases.map((tile) => parseTile(tile)?.suit).filter(Boolean))
    if (suits.size === 1) {
      const suit = [...suits][0]
      const counts = new Map()
      for (const tile of allBases) counts.set(tile, (counts.get(tile) ?? 0) + 1)
      let ok = true
      for (let rank = 1; rank <= 9; rank += 1) {
        const key = String(rank) + suit
        const count = counts.get(key) ?? 0
        if (rank === 1 || rank === 9) {
          if (count < 3) ok = false
        } else if (count < 1) ok = false
      }
      if (ok) yakuman.push({ name: '九莲宝灯', han: 13 })
    }
  }
  if (yakuman.length > 0) return yakuman

  // ---- 1 han ----
  if (ctx.riichi) yaku.push({ name: '立直', han: 1 })
  if (ctx.riichi && ctx.ippatsu) yaku.push({ name: '一发', han: 1 })
  if (ctx.tsumo && closed) yaku.push({ name: '门前清自摸', han: 1 })
  const seqs = melds.filter((meld) => meld.type === 'shuntsu')
  const waitFu = analysis.special === null && pair !== null ? waitFuOf(analysis, ctx.winTile) : 0
  const pairIsValue = pair !== null && (
    DRAGON_SET.has(pair) || pair === ctx.roundWind || pair === ctx.seatWind
  )
  const pinfu = closed && analysis.special === null && seqs.length === melds.length
    && pair !== null && !pairIsValue && waitFu === 0
  if (pinfu) yaku.push({ name: '平和', han: 1 })
  if (allSimples(allBases)) yaku.push({ name: '断幺九', han: 1 })
  const shuntsuKeys = seqs.map((meld) => (parseTile(meld.tiles[0])?.rank ?? 0) + (parseTile(meld.tiles[0])?.suit ?? ''))
  const shuntsuCount = new Map()
  for (const key of shuntsuKeys) shuntsuCount.set(key, (shuntsuCount.get(key) ?? 0) + 1)
  if (closed && [...shuntsuCount.values()].some((count) => count >= 2)) {
    // Ryanpeikou replaces the single iipeikou yaku.
    const pairs = [...shuntsuCount.values()].filter((count) => count >= 2).length
    if (pairs < 2) yaku.push({ name: '一杯口', han: 1 })
  }
  if (dragonTriplets.includes('P')) yaku.push({ name: '役牌 白', han: 1 })
  if (dragonTriplets.includes('F')) yaku.push({ name: '役牌 發', han: 1 })
  if (dragonTriplets.includes('C')) yaku.push({ name: '役牌 中', han: 1 })
  if (ctx.roundWind && tripletBases.includes(ctx.roundWind)) yaku.push({ name: '场风 东', han: 1 })
  if (ctx.seatWind && tripletBases.includes(ctx.seatWind)) {
    const name = { E: '自风 东', S: '自风 南', W: '自风 西', N: '自风 北' }[ctx.seatWind]
    yaku.push({ name, han: 1 })
  }
  if (ctx.rinshan) yaku.push({ name: '岭上开花', han: 1 })
  if (ctx.haitei) yaku.push({ name: '海底摸月', han: 1 })
  if (ctx.houtei) yaku.push({ name: '河底捞鱼', han: 1 })

  // ---- 2 han ----
  let sanshoku = false
  for (let rank = 1; rank <= 7; rank += 1) {
    const suits = new Set()
    for (const tile of seqs.map((meld) => meld.tiles[0])) {
      const parsed = parseTile(tile)
      if (parsed !== null && parsed.rank === rank) suits.add(parsed.suit)
    }
    if (suits.size === 3) sanshoku = true
  }
  if (sanshoku) yaku.push({ name: '三色同顺', han: closed ? 2 : 1 })
  let ittsu = false
  for (const suit of SUITS) {
    const has = (rank) => seqs.some((meld) => {
      const parsed = parseTile(meld.tiles[0])
      return parsed !== null && parsed.suit === suit && parsed.rank === rank
    })
    if (has(1) && has(4) && has(7)) ittsu = true
  }
  if (ittsu) yaku.push({ name: '一气通贯', han: closed ? 2 : 1 })
  const chanta = melds.every((meld) => meldHasOutside(meld)) && pair !== null
    && (TERMINAL_SET.has(pair) || HONOR_SET.has(pair))
  const junchan = chanta && !allBases.some((tile) => HONOR_SET.has(tile))
  if (junchan) yaku.push({ name: '纯全带幺九', han: closed ? 3 : 2 })
  else if (chanta) yaku.push({ name: '混全带幺九', han: closed ? 2 : 1 })
  if (analysis.special === 'chiitoi') yaku.push({ name: '七对子', han: 2 })
  const allTriplets = melds.length > 0 && melds.every((meld) => meld.type === 'koutsu' || meld.type === 'kantsu')
  if (allTriplets) yaku.push({ name: '对对和', han: 2 })
  if (concealedTriplets >= 3) yaku.push({ name: '三暗刻', han: 2 })
  let sanshokuDoukou = false
  for (let rank = 1; rank <= 9; rank += 1) {
    const suits = new Set()
    for (const tile of tripletBases) {
      const parsed = parseTile(tile)
      if (parsed !== null && !parsed.honor && parsed.rank === rank) suits.add(parsed.suit)
    }
    if (suits.size === 3) sanshokuDoukou = true
  }
  if (sanshokuDoukou) yaku.push({ name: '三色同刻', han: 2 })
  if (kantsuCount >= 3) yaku.push({ name: '三杠子', han: 2 })
  if (dragonTriplets.length === 2 && pair !== null && DRAGON_SET.has(pair)) yaku.push({ name: '小三元', han: 2 })
  if (allTerminalOrHonor(allBases)) yaku.push({ name: '混老头', han: 2 })
  const suits = new Set(allBases.filter((tile) => !HONOR_SET.has(tile)).map((tile) => parseTile(tile)?.suit).filter(Boolean))
  if (suits.size === 1) {
    const hasHonor = allBases.some((tile) => HONOR_SET.has(tile))
    yaku.push(hasHonor
      ? { name: '混一色', han: closed ? 3 : 2 }
      : { name: '清一色', han: closed ? 6 : 5 })
  }
  if (closed && seqs.length === 4) {
    const counts = new Map()
    for (const key of shuntsuKeys) counts.set(key, (counts.get(key) ?? 0) + 1)
    if ([...counts.values()].filter((count) => count >= 2).length >= 2) yaku.push({ name: '二杯口', han: 3 })
  }
  return yaku
}

/** Dora / red / ura han from indicator lists and the winning tiles. */
function countDoraHan(state, actualTiles, wantUra = false) {
  const bases = actualTiles.map(tileBase)
  const doraTiles = (Array.isArray(state.doras) ? state.doras : []).map(doraTile).filter(Boolean)
  let dora = 0
  for (const tile of doraTiles) dora += bases.filter((base) => base === tile).length
  const aka = actualTiles.filter((tile) => typeof tile === 'string' && tile.endsWith('r')).length
  const uraDoras = []
  let ura = 0
  if (wantUra === true) {
    const indicators = state.deadTiles.slice(state.deadDrawIndex, state.deadDrawIndex + (state.doras?.length ?? 0)).filter(isTile)
    for (const tile of indicators) uraDoras.push(tile)
    for (const indicator of indicators) {
      const dora = doraTile(indicator)
      ura += bases.filter((base) => base === dora).length
    }
  }
  return { dora, aka, ura, uraDoras }
}

/** Fu for an analyzed hand. */
function fuOfAnalysis(analysis, ctx, yaku) {
  if (analysis.special === 'chiitoi') return 25
  if (analysis.special === 'kokushi') return 0
  const pinfu = (yaku ?? []).some((entry) => entry.name === '平和')
  if (pinfu && ctx.tsumo) return 20
  let fu = 20
  if (ctx.tsumo) fu += 2
  else if (ctx.closed) fu += 10
  if (analysis.pair !== null) {
    if (DRAGON_SET.has(analysis.pair)) fu += 2
    if (analysis.pair === ctx.roundWind) fu += 2
    if (analysis.pair === ctx.seatWind) fu += 2
  }
  if (analysis.special === null) fu += waitFuOf(analysis, ctx.winTile)
  for (const meld of analysis.melds) {
    if (meld.type === 'shuntsu') continue
    const outside = TERMINAL_SET.has(meld.tiles[0]) || HONOR_SET.has(meld.tiles[0])
    const concealed = meld.concealed === true
    if (meld.type === 'koutsu') fu += concealed ? (outside ? 8 : 4) : (outside ? 4 : 2)
    else fu += concealed ? (outside ? 32 : 16) : (outside ? 16 : 8)
  }
  return Math.ceil(fu / 10) * 10
}

/** Build the winning context object for a player. */
function winContext(state, player, winTile, options) {
  const external = internalMelds(player)
  return {
    tsumo: options.tsumo === true,
    closed: external.every((meld) => meld.type === 'kantsu' && meld.concealed),
    riichi: player.riichi === true,
    ippatsu: player.ippatsu === true && player.riichi === true,
    rinshan: options.tsumo === true && state.lastDrawWasRinshan === true,
    haitei: options.tsumo === true && wallCount(state) === 0,
    houtei: options.tsumo !== true && wallCount(state) === 0,
    seatWind: seatWindOf(state, player.node),
    roundWind: 'E',
    winTile: tileBase(winTile),
  }
}

/** Basic points from han/fu/yakuman count (mangan caps). */
function basicPoints(han, fu, yakumanCount) {
  if (yakumanCount > 0) return 8000 * yakumanCount
  if (han >= 13) return 8000
  if (han >= 11) return 6000
  if (han >= 8) return 4000
  if (han >= 6) return 3000
  if (han >= 5) return 2000
  if (han === 4 && fu >= 40) return 2000
  if (han === 3 && fu >= 70) return 2000
  return fu * (2 ** (2 + han))
}

/** Round up to the next 100 points. */
function ceil100(value) {
  return Math.ceil(value / 100) * 100
}

/**
 * Score a winning hand without mutating the table. Returns
 * {yaku, han, fu, score, doraHan, akaHan, uraHan, uraDoras, yakumanCount,
 *  noYaku} or null when the tiles are not a winning shape.
 */
export function computeWin(state, player, winTile, options = {}) {
  const tsumo = options.tsumo === true
  const meldCount = (player.melds ?? []).length
  let concealed = tsumo ? player.hand.slice() : [...player.hand, winTile]
  if (!isWinningShape(concealed, meldCount)) {
    // Helpers may pass the 13-tile hand plus the winning tile for tsumo, or an
    // already-complete 14-tile hand for ron; both forms are accepted.
    if (!tsumo && isWinningShape(player.hand.slice(), meldCount)) {
      concealed = player.hand.slice()
    } else if (tsumo && isWinningShape([...player.hand, winTile], meldCount)) {
      concealed = [...player.hand, winTile]
    }
  }
  if (!isWinningShape(concealed, meldCount)) return null
  const ctx = winContext(state, player, winTile, { tsumo })
  const yaku = evaluateYaku(concealed, player, ctx)
  if (yaku.length === 0) {
    return {
      noYaku: true, yaku: [], han: 0, fu: 0, score: 0,
      doraHan: 0, akaHan: 0, uraHan: 0, uraDoras: [], yakumanCount: 0,
    }
  }
  const actualTiles = [...concealed, ...((player.melds ?? []).flatMap((meld) => meld.tiles))]
  const dora = countDoraHan(state, actualTiles, player.riichi === true)
  const yakumanCount = yaku.filter((entry) => entry.han >= 13).length
  let han = yaku.reduce((sum, entry) => sum + entry.han, 0) + dora.dora + dora.aka + dora.ura
  let fu = 0
  if (yakumanCount > 0) {
    han = 13 * yakumanCount
  } else {
    const analysis = analyzeHand(concealed, player.melds ?? [])
    fu = fuOfAnalysis(analysis, ctx, yaku)
  }
  const basic = basicPoints(han, fu, yakumanCount)
  const seatDealer = player.node === state.dealer
  let score
  const deltas = {}
  if (tsumo) {
    const winnerDealer = player.node === state.dealer
    let total = 0
    for (const other of state.players) {
      if (other.node === player.node) continue
      const amount = ceil100(basic * (winnerDealer ? 2 : (other.node === state.dealer ? 2 : 1)))
      deltas[other.node] = -amount
      total += amount
    }
    deltas[player.node] = total
    score = total
  } else {
    const amount = ceil100(basic * (seatDealer ? 6 : 4))
    deltas[player.node] = amount
    const discarder = options.discarder ?? undefined
    if (discarder !== undefined) deltas[discarder] = -amount
    score = amount
  }
  return {
    noYaku: false,
    yaku,
    han,
    fu,
    score,
    deltas,
    doraHan: dora.dora,
    akaHan: dora.aka,
    uraHan: dora.ura,
    uraDoras: dora.uraDoras,
    yakumanCount,
  }
}

/** Convenience test helper: yaku list for a winning hand. */
export function yakuOf(state, node, winTile, options = {}) {
  const player = playerOf(state, node)
  if (player === undefined) return []
  const result = computeWin(state, player, winTile, options)
  return result === null || result.noYaku ? [] : result.yaku
}

/** Convenience test helper: fu for a winning hand. */
export function fuOf(state, node, winTile, options = {}) {
  const player = playerOf(state, node)
  if (player === undefined) return 0
  const result = computeWin(state, player, winTile, options)
  return result === null ? 0 : result.fu
}

/** Convenience test helper: table-level score for a winning hand. */
export function scoreHand(state, node, winTile, options = {}) {
  const player = playerOf(state, node)
  if (player === undefined) return null
  return computeWin(state, player, winTile, options)
}


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
    riichi: false,
    ippatsu: false,
    points: 25000,
  }
}

/** End the hand because the live wall is empty. */
function endExhausted(state) {
  if (state.phase === 'result') return
  state.phase = 'result'
  state.result = 'exhausted'
  state.winnerNode = null
  state.turn = null
  // Tenpai penalty: 3000 points from the noten players to the tenpai players.
  const tenpai = {}
  for (const player of state.players) tenpai[player.node] = isTenpai(player)
  state.tenpai = tenpai
  const points = ensurePointMap(state)
  const ready = state.players.filter((player) => tenpai[player.node] === true)
  const notReady = state.players.filter((player) => tenpai[player.node] !== true)
  const deltas = {}
  if (ready.length > 0 && notReady.length > 0) {
    const pay = 3000 / notReady.length
    const receive = 3000 / ready.length
    for (const player of notReady) {
      points[player.node] = (points[player.node] ?? 25000) - pay
      deltas[player.node] = -pay
    }
    for (const player of ready) {
      points[player.node] = (points[player.node] ?? 25000) + receive
      deltas[player.node] = receive
    }
    for (const player of state.players) player.points = points[player.node]
    log(state, '流局：' + ready.length + ' 家听牌，罚符 ' + 3000)
  } else {
    for (const player of state.players) deltas[player.node] = 0
    log(state, '流局：活牌墙摸完（' + (ready.length > 0 ? '全听' : '全不听') + '，无罚符）')
  }
  state.exhaustDeltas = deltas
  for (const player of state.players) {
    const bucket = ensureScore(state, player.node)
    bucket.lose += 1
  }
  state.renchan = tenpai[state.dealer] === true
  updateMatchEnd(state, state.renchan)
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
  state.lastDrawWasRinshan = false
  state.wall = wallCount(state)
  return true
}

/** Advance to the next seat, draw, and set the turn. */
function advanceTurn(state) {
  const index = indexOfNode(state, state.turn)
  if (index < 0) return
  const next = state.players[(index + 1) % state.players.length]
  state.turn = next.node
  if (!drawTo(state, next)) return
  // A declared riichi hand discards automatically: win on the draw or discard it.
  if (next.riichi === true) autoRiichiTurn(state, next)
}

/* -------------------------------------------------------------------------- *
 * M3 settlement / riichi
 * -------------------------------------------------------------------------- */

/** Drop every player's ippatsu window (a call or kan interrupts it). */
function clearIppatsu(state) {
  for (const player of state.players) player.ippatsu = false
}

/** Ensure the points map exists and has one entry per player. */
function ensurePointMap(state) {
  if (state.points === undefined || state.points === null) state.points = {}
  for (const player of state.players) {
    if (!Number.isInteger(state.points[player.node])) state.points[player.node] = 25000
    player.points = state.points[player.node]
  }
  if (state.startPoints === undefined || Object.keys(state.startPoints).length === 0) {
    state.startPoints = { ...state.points }
  }
  return state.points
}

/** Declare riichi: requires a closed hand, >=1000 points and a wall of >=4. */
function applyRiichi(state, player) {
  if (player.riichi === true) return { ok: false, error: 'bad-riichi' }
  if ((player.melds ?? []).length > 0) return { ok: false, error: 'bad-riichi' }
  if (state.mustDiscard === true) return { ok: false, error: 'bad-riichi' }
  if (player.hand.length !== 14) return { ok: false, error: 'bad-riichi' }
  // Riichi requires a ready hand: after discarding some tile the hand must be tenpai.
  if (!isTenpaiTiles(player.hand, (player.melds ?? []).length)) return { ok: false, error: 'bad-riichi' }
  if (wallCount(state) < 4) return { ok: false, error: 'bad-riichi' }
  const points = ensurePointMap(state)
  if ((points[player.node] ?? 0) < 1000) return { ok: false, error: 'bad-riichi' }
  points[player.node] -= 1000
  player.points = points[player.node]
  state.riichiSticks = (state.riichiSticks ?? 0) + 1
  player.riichi = true
  player.ippatsu = true
  log(state, player.nick + ' 立直')
  return { ok: true }
}

/** Apply a winning hand's points, sticks and result fields. */
function settleWin(state, player, winTile, options = {}) {
  const tsumo = options.tsumo === true
  const result = computeWin(state, player, winTile, options)
  if (result === null) return { ok: false, error: 'not-winning' }
  if (result.noYaku === true) return { ok: false, error: 'no-yaku' }
  const points = ensurePointMap(state)
  for (const [node, delta] of Object.entries(result.deltas)) {
    points[node] = (points[node] ?? 25000) + delta
  }
  const sticks = state.riichiSticks ?? 0
  if (sticks > 0) {
    points[player.node] = (points[player.node] ?? 25000) + sticks * 1000
    state.riichiSticks = 0
  }
  for (const entry of state.players) entry.points = points[entry.node]
  const deltas = {}
  for (const entry of state.players) {
    deltas[entry.node] = (points[entry.node] ?? 0) - (state.startPoints?.[entry.node] ?? 25000)
  }
  state.phase = 'result'
  state.result = tsumo ? 'tsumo' : 'ron'
  state.winnerNode = player.node
  state.turn = null
  state.mustDiscard = false
  state.pending = []
  state.pendingOrder = []
  state.responses = {}
  state.uraDoras = Array.isArray(result.uraDoras) ? result.uraDoras : []
  state.winInfo = {
    winnerNode: player.node,
    result: state.result,
    yaku: result.yaku,
    han: result.han,
    fu: result.fu,
    score: result.score,
    deltas,
    doraHan: result.doraHan,
    akaHan: result.akaHan,
    uraHan: result.uraHan,
    uraDoras: state.uraDoras,
    riichiSticksAwarded: sticks,
  }
  for (const entry of state.players) {
    const bucket = ensureScore(state, entry.node)
    if (entry.node === player.node) bucket.win += 1
    else bucket.lose += 1
  }
  updateMatchEnd(state, player.node === state.dealer)
  log(state, player.nick + (tsumo ? ' 自摸' : ' 荣和')
    + ' ' + result.han + ' 番 ' + result.fu + ' 符 ' + result.score + ' 点')
  return { ok: true }
}

/** Riichi hand's automatic draw: win when possible, otherwise discard the draw. */
function autoRiichiTurn(state, player) {
  const tile = player.drawnTile
  if (!isTile(tile)) return
  const result = computeWin(state, player, tile, { tsumo: true })
  const canWin = result !== null && result.noYaku !== true
  player.ippatsu = false
  if (canWin) {
    settleWin(state, player, tile, { tsumo: true })
    return
  }
  if (state.phase !== 'playing') return
  applyDiscard(state, player, { type: 'discard', tile })
}


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
    uraDoras: [],
    lastDiscard: null,
    mustDiscard: false,
    pending: [],
    pendingOrder: [],
    responses: {},
    riichiSticks: 0,
    points: {},
    startPoints: {},
    winInfo: null,
    lastDrawWasRinshan: false,
    tenpai: {},
    matchOver: false,
    finalPoints: null,
    renchan: false,
    log: [],
    scores: {},
    updatedAt: 0,
  }
  for (const player of state.players) {
    ensureScore(state, player.node)
    state.points[player.node] = 25000
  }
  state.startPoints = { ...state.points }
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
  if (state.points === undefined || state.points === null) state.points = {}
  if (state.points[player.node] === undefined) state.points[player.node] = 25000
  return { ok: true }
}

/** Update renchan / final-match state after a settled hand. */
function updateMatchEnd(state, renchan) {
  state.renchan = renchan === true
  if (renchan === true) {
    state.matchOver = false
    state.finalPoints = null
    return
  }
  const maxRounds = seatsForMode(state.mode)
  if (state.round + 1 > maxRounds) {
    state.matchOver = true
    state.finalPoints = finalPointsOf(state)
    log(state, '东风战结束')
  } else {
    state.matchOver = false
    state.finalPoints = null
  }
}

/** Ranked final points for the end of an East-only match. */
function finalPointsOf(state) {
  const entries = state.players.map((player) => ({
    node: player.node,
    nick: player.nick,
    points: Number.isInteger(state.points?.[player.node]) ? state.points[player.node] : 25000,
  }))
  entries.sort((a, b) => b.points - a.points)
  return entries.map((entry, index) => ({ ...entry, rank: index + 1 }))
}

/** Start the next hand: rotate the dealer, build the wall and deal. */
export function startRound(state, rng = Math.random) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) {
    return { ok: false, error: 'no-table' }
  }
  const required = seatsForMode(state.mode)
  if (state.players.length !== required) return { ok: false, error: 'no-players' }
  if (state.phase === 'playing' || state.phase === 'calling') return { ok: false, error: 'bad-phase' }

  // A start after the final result begins a brand-new East-only match.
  if (state.matchOver === true) {
    state.matchOver = false
    state.finalPoints = null
    state.riichiSticks = 0
    state.tenpai = {}
    state.renchan = false
    state.round = 0
    state.dealer = null
    state.points = {}
    state.startPoints = {}
    for (const player of state.players) {
      state.points[player.node] = 25000
      player.points = 25000
    }
  }

  if (state.points === undefined || state.points === null) state.points = {}
  for (const player of state.players) {
    if (!Number.isInteger(state.points[player.node])) state.points[player.node] = 25000
    player.points = state.points[player.node]
  }

  // Renchan: the dealer won, or the dealer was tenpai on an exhaustive draw.
  const maxRounds = seatsForMode(state.mode)
  let renchan = false
  if (state.round === 0 || state.dealer === null) {
    state.round = 1
    state.dealer = state.players[0].node
  } else {
    const previousDealer = state.dealer
    const previousIndex = indexOfNode(state, previousDealer)
    const dealerWasTenpai = state.tenpai !== null && typeof state.tenpai === 'object'
      ? state.tenpai[previousDealer] === true
      : false
    renchan = state.result === 'tsumo' || state.result === 'ron'
      ? state.winnerNode === previousDealer
      : (state.result === 'exhausted' ? dealerWasTenpai : false)
    if (!renchan) {
      const nextIndex = previousIndex < 0 ? 0 : (previousIndex + 1) % state.players.length
      const nextRound = state.round + 1
      if (nextRound > maxRounds) {
        // Final hand without renchan: the East-only match is over.
        state.matchOver = true
        state.phase = 'result'
        state.turn = null
        state.renchan = false
        state.finalPoints = finalPointsOf(state)
        return { ok: true, matchOver: true }
      }
      state.round = nextRound
      state.dealer = state.players[nextIndex].node
    }
  }
  state.renchan = renchan
  state.matchOver = false
  state.finalPoints = null
  state.tenpai = {}
  state.exhaustDeltas = null
  const dealerIndex = indexOfNode(state, state.dealer)

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
  state.uraDoras = []
  state.winInfo = null
  state.lastDrawWasRinshan = false
  state.startPoints = { ...state.points }

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
    player.riichi = false
    player.ippatsu = false
    player.points = state.points[player.node]
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
  state.lastDrawWasRinshan = true
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
    if (player.furiten !== true) {
      const winning = isWinningShape([...player.hand, tile], meldCountOf(player))
      if (winning) {
        const scored = computeWin(state, player, tile, { tsumo: false })
        if (scored !== null && scored.noYaku !== true) allowed.push('ron')
      }
    }
    // A declared riichi hand cannot call (only ron is allowed).
    if (player.riichi !== true) {
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
  const scored = computeWin(state, winner, discardInfo.tile, { tsumo: false, discarder: discardInfo.node })
  if (scored === null) return { ok: false, error: 'not-winning' }
  if (scored.noYaku === true) return { ok: false, error: 'no-yaku' }
  const discarder = playerOf(state, discardInfo.node)
  if (discarder !== undefined && discarder.discards[discarder.discards.length - 1] === discardInfo.tile) {
    discarder.discards.pop()
  }
  winner.hand = sortHand([...winner.hand, discardInfo.tile])
  clearCallState(state)
  const settled = settleWin(state, winner, discardInfo.tile, {
    tsumo: false,
    discarder: discardInfo.node,
  })
  return settled
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
  clearIppatsu(state)
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
  if (player.riichi === true) return { ok: false, error: 'bad-action' }
  const tile = typeof action.tile === 'string' ? action.tile : ''
  if (!isTile(tile)) return { ok: false, error: 'bad-tile' }
  const base = tileBase(tile)
  const picked = removeBaseTiles(player.hand, base, 4)
  if (picked === undefined || picked.length !== 4) return { ok: false, error: 'bad-tile' }
  player.melds.push({ type: 'ankan', tiles: sortHand(picked), from: null })
  if (!drawReplacement(state, player)) return { ok: true }
  addDoraIndicator(state)
  state.mustDiscard = true
  clearIppatsu(state)
  log(state, player.nick + ' 暗杠 ' + base)
  return { ok: true }
}

/** Kakan: add the fourth tile to an existing pon, replacement draw + new dora. */
function applyKakan(state, player, action) {
  if (player.riichi === true) return { ok: false, error: 'bad-action' }
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
  clearIppatsu(state)
  log(state, player.nick + ' 加杠 ' + base)
  return { ok: true }
}

/** discard: play one tile, then open the call window or move on. */
function applyDiscard(state, player, action) {
  const tile = typeof action.tile === 'string' ? action.tile : ''
  if (!isTile(tile)) return { ok: false, error: 'bad-tile' }
  const index = player.hand.indexOf(tile)
  if (index < 0) return { ok: false, error: 'bad-tile' }
  // A riichi hand may only discard a tile that keeps it tenpai.
  if (player.riichi === true) {
    const rest = player.hand.slice()
    rest.splice(index, 1)
    if (!isTenpaiTiles(rest, (player.melds ?? []).length)) return { ok: false, error: 'bad-riichi' }
  }
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

/** tsumo: declare a win on the current concealed hand (M2/M3 scoring). */
function applyTsumo(state, player) {
  if (state.mustDiscard === true) return { ok: false, error: 'bad-action' }
  if (!isWinningShape(player.hand, meldCountOf(player))) return { ok: false, error: 'not-winning' }
  const winTile = isTile(player.drawnTile) ? player.drawnTile : player.hand[player.hand.length - 1]
  return settleWin(state, player, winTile, { tsumo: true })
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
    case 'riichi': return applyRiichi(state, player)
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

/** Isolation score used to pick a discard (higher = more disposable). */
function botDiscardScore(hand, tile) {
  const base = tileBase(tile)
  const same = hand.filter((entry) => tileBase(entry) === base).length
  let score = (4 - same) * 8
  if (base.length === 1) return score + 70
  const rank = Number(base[0])
  const suit = base.slice(-1)
  let neighbours = 0
  for (const delta of [-2, -1, 1, 2]) {
    const other = rank + delta
    if (other < 1 || other > 9) continue
    if (hand.some((entry) => tileBase(entry) === String(other) + suit)) neighbours += 1
  }
  score -= neighbours * 10
  if (rank === 1 || rank === 9) score += 30
  return score
}

/** Unique tile values in hand order (red fives included as actual tiles). */
function botUniqueTiles(hand) {
  return hand.filter((tile, index) => hand.indexOf(tile) === index)
}

/** Best discard; when requireTenpai is set only tenpai-preserving tiles are used. */
function botChooseDiscard(player, requireTenpai) {
  const melds = meldCountOf(player)
  let best = null
  let bestScore = -Infinity
  for (const tile of botUniqueTiles(player.hand)) {
    if (requireTenpai === true) {
      const rest = player.hand.slice()
      rest.splice(rest.indexOf(tile), 1)
      if (!isTenpaiTiles(rest, melds)) continue
    }
    const score = botDiscardScore(player.hand, tile)
    if (score > bestScore) {
      best = tile
      bestScore = score
    }
  }
  return best
}

/**
 * Simple mahjong training bot (v17): nuki, tsumo, keep-tenpai riichi discard,
 * riichi declaration when ready, otherwise discard the most isolated tile.
 * Never calls (chi/pon/kan); at a call window it only ron or passes.
 */
export function botAction(state, node) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.players)) return null
  if (node === undefined || node === null) return null
  const player = playerOf(state, node)
  if (player === undefined) return null
  if (state.phase === 'calling') {
    const entry = Array.isArray(state.pending)
      ? state.pending.find((candidate) => candidate.node === node)
      : undefined
    if (entry === undefined) return null
    if (Array.isArray(entry.allowed) && entry.allowed.includes('ron') && player.furiten !== true) {
      return { type: 'ron' }
    }
    return { type: 'pass' }
  }
  if (state.phase !== 'playing' || state.turn !== node) return null
  if (player.hand.length === 0) return null
  const meldCount = meldCountOf(player)
  const winTile = isTile(player.drawnTile) ? player.drawnTile : player.hand[player.hand.length - 1]
  // 3-player mode: set north tiles aside before choosing a discard.
  if (state.mode === 'mahjong3' && player.riichi !== true
    && state.mustDiscard !== true && player.hand.includes('N')) {
    return { type: 'nuki', tile: 'N' }
  }
  // Win on the drawn tile when the hand has yaku.
  if (state.mustDiscard !== true && isWinningShape(player.hand, meldCount)) {
    const result = computeWin(state, player, winTile, { tsumo: true })
    if (result !== null && result.noYaku !== true) return { type: 'tsumo' }
  }
  if (player.riichi === true) {
    const kept = botChooseDiscard(player, true)
    return { type: 'discard', tile: kept ?? winTile }
  }
  // Declare riichi when a discard can leave a closed tenpai hand.
  if (player.hand.length === 14 && meldCount === 0
    && state.mustDiscard !== true
    && wallCount(state) >= 4
    && (state.points?.[player.node] ?? 0) >= 1000
    && botChooseDiscard(player, true) !== null) {
    return { type: 'riichi' }
  }
  const discard = botChooseDiscard(player, false) ?? winTile
  return { type: 'discard', tile: discard }
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
      bot: player.bot === true,
      self: showSelf && player.node === viewerNode,
      count: Array.isArray(player.hand) ? player.hand.length : 0,
      discards: Array.isArray(player.discards) ? player.discards.filter(isTile).slice(0, 100) : [],
      melds: sanitizeMelds(player.melds),
      furiten: player.furiten === true,
      riichi: player.riichi === true,
      points: Number.isInteger(state?.points?.[player.node]) ? state.points[player.node] : 25000,
      seatWind: seatWindOf(state ?? { dealer: null, players: [] }, player.node),
      tenpai: state?.tenpai?.[player.node] === true,
    }
    if (revealed) entry.hand = sanitizeTiles(player.hand)
    return entry
  })

  const myHand = viewer !== undefined ? sanitizeTiles(viewer.hand) : []
  const viewerPoints = viewer !== undefined && Number.isInteger(state?.points?.[viewer.node])
    ? state.points[viewer.node]
    : 25000
  const canRiichi = viewer !== undefined
    && state?.phase === 'playing'
    && state?.turn === viewer.node
    && viewer.riichi !== true
    && (viewer.melds ?? []).length === 0
    && viewer.hand.length === 14
    && state?.mustDiscard !== true
    && wallCount(state ?? { liveTiles: [], wallIndex: 0 }) >= 4
    && viewerPoints >= 1000
    && isTenpaiTiles(viewer.hand, 0)
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
  const riichi = {}
  for (const player of nodes) riichi[player.node] = player.riichi === true
  const points = {}
  for (const player of nodes) {
    points[player.node] = Number.isInteger(state?.points?.[player.node]) ? state.points[player.node] : 25000
  }
  const winInfo = state?.winInfo !== null && typeof state?.winInfo === 'object' ? state.winInfo : null

  const view = {
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
    riichi,
    riichiSticks: Number.isInteger(state?.riichiSticks) ? Math.max(0, state.riichiSticks) : 0,
    points,
    roundLabel: '东' + (Number.isInteger(state?.round) && state.round > 0 ? state.round : 1) + '局',
    seatWind: Object.fromEntries(players.map((player) => [player.node, player.seatWind])),
    tenpai: Object.fromEntries(players.map((player) => [player.node, player.tenpai === true])),
    matchOver: state?.matchOver === true,
    finalPoints: Array.isArray(state?.finalPoints)
      ? state.finalPoints.slice(0, 6).map((entry) => ({
          node: wireNode(entry?.node) ?? '',
          nick: text(entry?.nick, 24) ?? '玩家',
          points: Number.isInteger(entry?.points) ? entry.points : 0,
          rank: Number.isInteger(entry?.rank) ? entry.rank : 0,
        }))
      : null,
    renchan: state?.renchan === true,
    discards: players.map((player) => player.discards),
    melds: players.map((player) => player.melds),
    myHand,
    canRiichi,
    players,
    pending: sanitizePending(state?.pending),
    lastDiscard,
    mustDiscard: state?.mustDiscard === true,
    furiten,
    uraDoras: Array.isArray(state?.uraDoras) ? state.uraDoras.filter(isTile).slice(0, 8) : [],
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
  if (winInfo !== null) {
    view.yaku = Array.isArray(winInfo.yaku)
      ? winInfo.yaku.map((entry) => ({ name: text(entry?.name, 20) ?? '役', han: Number.isInteger(entry?.han) ? entry.han : 1 }))
      : []
    view.han = Number.isInteger(winInfo.han) ? winInfo.han : 0
    view.fu = Number.isInteger(winInfo.fu) ? winInfo.fu : 0
    view.score = Number.isInteger(winInfo.score) ? winInfo.score : 0
    view.deltas = {}
    if (winInfo.deltas !== null && typeof winInfo.deltas === 'object') {
      for (const [node, value] of Object.entries(winInfo.deltas)) {
        if (wireNode(node) !== null && Number.isInteger(value)) view.deltas[node] = value
      }
    }
    view.doraHan = Number.isInteger(winInfo.doraHan) ? winInfo.doraHan : 0
    view.akaHan = Number.isInteger(winInfo.akaHan) ? winInfo.akaHan : 0
    view.uraHan = Number.isInteger(winInfo.uraHan) ? winInfo.uraHan : 0
    view.riichiSticksAwarded = Number.isInteger(winInfo.riichiSticksAwarded)
      ? winInfo.riichiSticksAwarded
      : 0
  }
  if (state?.result === 'exhausted') {
    view.deltas = {}
    if (state.exhaustDeltas !== null && typeof state.exhaustDeltas === 'object') {
      for (const [node, value] of Object.entries(state.exhaustDeltas)) {
        if (wireNode(node) !== null && Number.isInteger(value)) view.deltas[node] = value
      }
    }
  }
  return view
}
