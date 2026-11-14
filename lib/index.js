/**
 * dsh-card-lan host half — LAN blackjack table service for DSH.
 *
 * One DSH process runs one tiny card-table service:
 *   - a UDP socket bound to 0.0.0.0:<port> (default 41235, SO_REUSEADDR),
 *   - a "hello" discovery datagram broadcast to every interface's broadcast
 *     address (plus 255.255.255.255 and 127.0.0.1) every ~1.5 s,
 *   - a peer table with a 6.5 s TTL,
 *   - unicast join / action (guest -> host) and state / reject (host -> guest),
 *   - the authoritative blackjack rounds, driven by ./engine.js (pure rules),
 *   - three loopback-only JSON routes under /api/card-lan.
 *
 * The browser half (client.js) never talks UDP: it polls GET /api/card-lan and
 * POSTs /action + /config. Everything the two halves share is defined by
 * PROTOCOL.md; this file implements that contract and imports nothing outside
 * ./engine.js and Node built-ins.
 * @module dsh-card-lan
 */

import { createSocket } from 'node:dgram'
import { randomBytes, randomUUID } from 'node:crypto'
import { hostname, homedir, networkInterfaces } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MAX_PLAYERS,
  applyAction,
  handValue,
  newTable,
  startRound,
  visibleDealer,
} from './engine.js'
import * as doudizhu from './games/doudizhu.js'
import * as paodekuai from './games/paodekuai.js'
import * as guandan from './games/guandan.js'
import * as zhajinhua from './games/zhajinhua.js'
import * as texas from './games/texas.js'
import * as mahjong from './games/mahjong.js'

/** Wire version of the UDP datagrams. */
const PROTOCOL = 1

/** Node id shape (UUIDs from randomUUID() fit). */
const NODE_RE = /^[A-Za-z0-9_-]{6,64}$/

/** Table node shape: relaxed so built-in bot seats (bot-1/bot-2) serialize. */
const TABLE_NODE_RE = /^[A-Za-z0-9_-]{1,64}$/

/** One card: rank + suit, e.g. 'AS', '10H', 'KD'. */
const CARD_RE = /^(?:A|[2-9]|10|J|Q|K)[SHDC]$/

/** One doudizhu card: the blackjack shape plus the two jokers. */
const DD_CARD_RE = /^(?:(?:[3-9]|10|[JQKA2])[SHDC]|BJ|RJ)$/

/** One M1 mahjong tile: numbered suit tile (red five as 5mr/5pr/5sr) or honor. */
const MJ_TILE_RE = /^(?:[1-9][mps]|5[mps]r|[ESWNPFC])$/

/** Supported games (PROTOCOL.md 7). */
const GAMES = new Set([
  'blackjack', 'doudizhu', 'paodekuai', 'guandan', 'zhajinhua', 'texas', 'mahjong4', 'mahjong3',
])

/** Engine-backed card games with per-viewer snapshots. */
const GAME_ENGINES = {
  doudizhu, paodekuai, guandan, zhajinhua, texas, mahjong4: mahjong, mahjong3: mahjong,
}
const TRICK_GAMES = new Set([
  'doudizhu', 'paodekuai', 'guandan', 'zhajinhua', 'texas', 'mahjong4', 'mahjong3',
])

/** Games that support built-in bot seats (fillBots / botCount, v15). */
const BOT_GAMES = new Set(['doudizhu', 'paodekuai', 'guandan', 'zhajinhua', 'texas'])

/** Recommended table size used when autoFillBots is on (PROTOCOL.md 7.26). */
const RECOMMENDED_PLAYERS = {
  doudizhu: 3,
  paodekuai: 3,
  guandan: 4,
  zhajinhua: 4,
  texas: 4,
}

/** Cards a single play may carry, per engine game (sanitize bound). */
const GAME_PLAY_CARDS_MAX = { doudizhu: 20, paodekuai: 16, guandan: 27, zhajinhua: 3, texas: 2 }

/** Largest possible table (zhajinhua/texas seat six; the advert clamps here). */
const MAX_TABLE_PLAYERS = 6

/** Built-in bot seats used when config.botCount > 0 (PROTOCOL.md 7.26). */
const BOT_SEATS = [
  { node: 'bot-1', nick: '机器人·小A' },
  { node: 'bot-2', nick: '机器人·小B' },
  { node: 'bot-3', nick: '机器人·小C' },
  { node: 'bot-4', nick: '机器人·小D' },
  { node: 'bot-5', nick: '机器人·小E' },
]

/** Bot thinking delay range (ms). */
const BOT_DELAY_MIN = 600
const BOT_DELAY_MAX = 1000

/** Action types the host itself owns; everything else goes to the game engine. */
const CONTROL_ACTIONS = new Set(['open', 'close', 'join', 'leave', 'start', 'rejoin'])

/** Per-game seat limits (joined tables follow them). */
const GAME_MAX_PLAYERS = {
  blackjack: MAX_PLAYERS,
  doudizhu: doudizhu.maxPlayers,
  paodekuai: paodekuai.maxPlayers,
  guandan: guandan.maxPlayers,
  zhajinhua: zhajinhua.maxPlayers,
  texas: texas.maxPlayers,
  mahjong4: 4,
  mahjong3: 3,
}
const GAME_MIN_PLAYERS = {
  blackjack: 1,
  doudizhu: doudizhu.minPlayers,
  paodekuai: paodekuai.minPlayers,
  guandan: guandan.minPlayers,
  zhajinhua: zhajinhua.minPlayers,
  texas: texas.minPlayers,
  mahjong4: 4,
  mahjong3: 3,
}

/** Table phases produced by the doudizhu engine. */
const DD_PHASES = new Set(['idle', 'bidding', 'playing', 'result'])

/** Table phases produced by the paodekuai engine. */
const PK_PHASES = new Set(['idle', 'playing', 'result'])

/** Table phases produced by the guandan engine. */
const GD_PHASES = new Set(['idle', 'tribute', 'playing', 'result'])

/** Table phases produced by the zhajinhua engine. */
const ZJ_PHASES = new Set(['idle', 'bidding', 'result'])

/** Table phases produced by the texas engine. */
const TX_PHASES = new Set(['idle', 'preflop', 'flop', 'turn', 'river', 'result'])

/** Table phases produced by the mahjong engine. */
const MJ_PHASES = new Set(['idle', 'playing', 'calling', 'result'])

/** Engine phases that own a live turn (countdown / timeout). */
const ACTIVE_TURN_PHASES = new Set([
  'playing', 'bidding', 'tribute', 'calling', 'preflop', 'flop', 'turn', 'river',
])

/** Table phases produced by engine.js. */
const PHASES = new Set(['idle', 'playing', 'dealer', 'result'])

/** Player status/result whitelists. */
const STATUSES = new Set(['playing', 'stand', 'bust', 'blackjack'])
const RESULTS = new Set(['win', 'lose', 'push'])

/** Defaults of the persisted LAN config. */
const DEFAULTS = {
  enabled: true,
  room: 'dsh-card',
  port: 41235,
  game: 'blackjack',
  overlayOpacity: 0.9,
  passwordEnabled: false,
  password: '',
  spectatorEnabled: true,
  overlaySize: 'medium',
  overlayX: null,
  overlayY: null,
  autoFade: true,
  turnTimeout: 45,
  botCount: 0,
  autoFillBots: false,
}

/** Bounds of the local overlay opacity (display-only; never leaves the machine). */
const MIN_OPACITY = 0.25

/** Room password bounds (host-only config; only `passwordEnabled` is broadcast). */
const PASSWORD_MAX = 16

/** Spectator population cap (players keep the engine's cap of 4). */
const MAX_SPECTATORS = 6

/** Overlay size steps offered by the settings page. */
const OVERLAY_SIZES = new Set(['small', 'medium', 'large'])

/** Overlay drag coordinates are clamped into this symmetric pixel range. */
const OVERLAY_POS_LIMIT = 10_000

/** Turn timeout bounds (seconds; 0 disables the auto-stand rule). */
const TURN_TIMEOUT_MAX = 300

/** Largest value reported in turnRemainingMs (a 300 s turn). */
const MAX_TURN_REMAINING_MS = TURN_TIMEOUT_MAX * 1000

/** Guest auto-reconnect rule (PROTOCOL.md 2.5c). */
const RECONNECT_STALE_MS = 5000
const RECONNECT_RETRY_MS = 1000
const RECONNECT_MAX_ATTEMPTS = 5

/** Reject reason -> view.lastError token (PROTOCOL.md 3.3). */
const REJECT_ERRORS = {
  closed: 'join-closed',
  full: 'join-full',
  password: 'join-password',
  'watch-closed': 'join-watch-closed',
  'watch-full': 'join-watch-full',
}

/** Discovery cadence. */
const ANNOUNCE_MS = 1500

/** Host state heartbeat / liveness sweep cadence. */
const HEARTBEAT_MS = 1000

/** Retry-tick cadence for join + action retransmission (400 ms). */
const RETRY_MS = 400

/** A peer that has been silent this long is dropped from the peer table. */
const PEER_TTL_MS = 6500

/** A seated player that has sent no hello for this long is removed. */
const SEAT_TIMEOUT_MS = 12_000

/** Server-side dedupe window for one player's action ids. */
const ACK_WINDOW_MS = 30_000

/** How many applied action ids travel back in one state packet. */
const ACK_KEEP = 8

/** Guest -> host delivery guarantees (mirrors PROTOCOL.md 2.4). */
const JOIN_RETRY_MS = 1000
const JOIN_MAX_ATTEMPTS = 8
const ACTION_RETRY_MS = 400
const ACTION_MAX_ATTEMPTS = 5
const MAX_PENDING_ACTIONS = 8

/**
 * Datagrams larger than this are ignored outright. Four-player mahjong state
 * includes points/seatWind/tenpai/riichi maps plus a late-game river, so the
 * bound allows up to ~5 KB payloads.
 */
const MAX_DATAGRAM = 8192

/** Hard cap on concurrently tracked peers (spoofed-node flood guard). */
const MAX_PEERS = 32

/** Per-IP and global UDP packet budgets (one-second windows). */
const PACKET_WINDOW_MS = 1000
const PACKET_MAX_PER_IP = 40
const PACKET_MAX_TOTAL = 300

/**
 * State datagrams stay inside one bounded UDP payload. Four-player mahjong
 * snapshots (14 own tiles, four rivers, points/seatWind/tenpai/riichi maps,
 * scores, log and ack ids) reach ~3.5–4.5 KB, so the cap allows 5200 bytes:
 * below the 8192-byte receive limit, at the cost of IP fragmentation on a
 * 1500-byte LAN.
 */
const MAX_STATE_BYTES = 5200

/** Log lines kept in a table snapshot (keeps state packets small). */
const LOG_KEEP = 8

/* -------------------------------------------------------------------------- *
 * Small helpers
 * -------------------------------------------------------------------------- */

/** Resolve the config directory: options.home > $DSH_HOME > ~/.dsh. */
function resolveHome(home) {
  if (typeof home === 'string' && home.trim() !== '') return home.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const value = fromEnv.trim()
    return value.startsWith('~') ? join(homedir(), value.slice(1)) : value
  }
  return join(homedir(), '.dsh')
}

/** Trim a string field to a bounded length (undefined when unusable). */
function text(value, max) {
  if (typeof value !== 'string') return undefined
  // Control characters would break layout/logs across the LAN; strip C0, DEL, C1.
  const trimmed = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

/** Whole number clamped into [min, max] (fallback otherwise). */
function clampInt(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** Promise-based timer (used by the send-flush helper). */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Overlay opacity clamped into [MIN_OPACITY, 1] and rounded to two decimals. */
function clampOpacity(value, fallback = DEFAULTS.overlayOpacity) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.round(Math.min(1, Math.max(MIN_OPACITY, numeric)) * 100) / 100
}

/**
 * Overlay drag position: null (default corner) or an integer pixel coordinate
 * clamped into ±OVERLAY_POS_LIMIT. Returns undefined for unusable input.
 */
function clampOverlayPosition(value) {
  if (value === null || value === undefined) return value === null ? null : undefined
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return Math.min(OVERLAY_POS_LIMIT, Math.max(-OVERLAY_POS_LIMIT, Math.round(numeric)))
}

/** Turn timeout clamped into [0, TURN_TIMEOUT_MAX] whole seconds. */
function clampTurnTimeout(value, fallback = DEFAULTS.turnTimeout) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(TURN_TIMEOUT_MAX, Math.max(0, value))
}

/** True when a room password is enabled and the given pw matches it exactly. */
function passwordMatches(config, pw) {
  if (!config.passwordEnabled) return true
  return typeof pw === 'string' && pw === config.password
}

/** Default nickname: the machine hostname, bounded to 24 chars. */
function defaultNick() {
  return text(hostname(), 24) ?? 'DSH 玩家'
}

/** True for a dotted-quad IPv4 address. */
function isIpv4(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Parse a dotted IPv4 into an unsigned 32-bit integer. */
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number)
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

/** Format an unsigned 32-bit integer as dotted IPv4. */
function intToIpv4(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/** The local LAN IPv4 address (fallback loopback). */
function localIpv4() {
  try {
    const interfaces = networkInterfaces()
    for (const list of Object.values(interfaces)) {
      for (const address of list ?? []) {
        if (address.family !== 'IPv4' || address.internal) continue
        if (isIpv4(address.address)) return address.address
      }
    }
  } catch {
    // No interfaces visible: loopback still works for a same-machine table.
  }
  return '127.0.0.1'
}

/**
 * Every destination a hello datagram should reach: the subnet broadcast of
 * each non-internal IPv4 interface, limited broadcast, and loopback (so a
 * second DSH on the same machine is visible too).
 */
function broadcastTargets() {
  const targets = new Set(['255.255.255.255', '127.0.0.1'])
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const address of list ?? []) {
        if (address.family !== 'IPv4' || address.internal) continue
        if (typeof address.address !== 'string' || typeof address.netmask !== 'string') continue
        try {
          const ip = ipv4ToInt(address.address)
          const mask = ipv4ToInt(address.netmask)
          targets.add(intToIpv4((ip | (~mask >>> 0)) >>> 0))
        } catch {
          // A malformed interface entry never blocks discovery on the others.
        }
      }
    }
  } catch {
    // Keep loopback + limited broadcast.
  }
  return [...targets]
}

/** Sanitize a card list (unknown cards are dropped). */
function sanitizeCards(raw) {
  const out = []
  if (!Array.isArray(raw)) return out
  for (const card of raw.slice(0, 12)) {
    if (typeof card === 'string' && CARD_RE.test(card)) out.push(card)
  }
  return out
}

/** Sanitize a log list (engine objects or plain strings) to display strings. */
function sanitizeLog(raw) {
  const out = []
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    const line = typeof entry === 'string'
      ? text(entry, 80)
      : (entry !== null && typeof entry === 'object' ? text(entry.text, 80) : undefined)
    if (line !== undefined) out.push(line)
  }
  return out.slice(-LOG_KEEP)
}

/** Sanitize a scores map keyed by node. */
function normalizeScores(raw, players) {
  const out = {}
  for (const [node, value] of Object.entries(raw ?? {})) {
    if (!NODE_RE.test(node) || value === null || typeof value !== 'object') continue
    out[node] = {
      win: clampInt(value.win, 0, 0, 9999),
      lose: clampInt(value.lose, 0, 0, 9999),
      push: clampInt(value.push, 0, 0, 9999),
    }
  }
  for (const player of players) {
    if (out[player.node] === undefined) out[player.node] = { win: 0, lose: 0, push: 0 }
  }
  return out
}

/** Sanitize the table advert carried by a hello (null when not hosting). */
function sanitizeAdvert(raw) {
  if (raw === null || typeof raw !== 'object') return null
  return {
    open: raw.open === true,
    players: clampInt(raw.players, 0, 0, MAX_TABLE_PLAYERS),
    password: raw.password === true,
    watch: raw.watch === true,
    spectators: clampInt(raw.spectators, 0, 0, MAX_SPECTATORS),
    game: GAMES.has(raw.game) ? raw.game : DEFAULTS.game,
  }
}

/** Sanitize a card list for the engine-backed games (doudizhu has jokers). */
function sanitizeGameCards(raw, limit = 20) {
  const out = []
  if (!Array.isArray(raw)) return out
  for (const card of raw.slice(0, limit)) {
    if (typeof card === 'string' && DD_CARD_RE.test(card)) out.push(card)
  }
  return out
}

/** One valid M1 mahjong tile or undefined. */
function sanitizeMahjongTile(value) {
  return typeof value === 'string' && MJ_TILE_RE.test(value) ? value : undefined
}

/** Sanitize a mahjong hand list. */
function sanitizeMahjongHand(raw, limit = 14) {
  const out = []
  if (!Array.isArray(raw)) return out
  for (const tile of raw.slice(0, limit)) {
    if (typeof tile === 'string' && MJ_TILE_RE.test(tile)) out.push(tile)
  }
  return out
}

/** Sanitize exposed melds for one mahjong player. */
function sanitizeMahjongMelds(raw) {
  if (!Array.isArray(raw)) return []
  const types = new Set(['chi', 'pon', 'kan', 'ankan', 'kakan'])
  return raw.slice(0, 4).map((meld) => ({
    type: types.has(meld?.type) ? meld.type : 'pon',
    tiles: sanitizeMahjongHand(meld?.tiles, 4),
    from: typeof meld?.from === 'string' && TABLE_NODE_RE.test(meld.from) ? meld.from : null,
  }))
}

/** Sanitize the mahjong call-window pending list. */
function sanitizeMahjongPending(raw) {
  if (!Array.isArray(raw)) return []
  const allowedTypes = new Set(['ron', 'pon', 'kan', 'chi'])
  return raw.slice(0, 4).map((entry) => {
    const view = {
      node: typeof entry?.node === 'string' && TABLE_NODE_RE.test(entry.node) ? entry.node : '',
      allowed: Array.isArray(entry?.allowed)
        ? entry.allowed.filter((type) => allowedTypes.has(type))
        : [],
    }
    if (Array.isArray(entry?.chiOptions)) {
      view.chiOptions = entry.chiOptions.slice(0, 3).map((option) => sanitizeMahjongHand(option, 2))
    }
    return view
  })
}

/** Scores as { node: { win, lose } } for the engine-backed games. */
function normalizeTrickScores(raw, players) {
  const out = {}
  for (const [node, value] of Object.entries(raw ?? {})) {
    if (!NODE_RE.test(node) || value === null || typeof value !== 'object') continue
    out[node] = {
      win: clampInt(value.win, 0, 0, 9999),
      lose: clampInt(value.lose, 0, 0, 9999),
    }
  }
  for (const player of players ?? []) {
    if (out[player.node] === undefined) out[player.node] = { win: 0, lose: 0 }
  }
  return out
}

/**
 * Sanitize an engine-backed snapshot (doudizhu / paodekuai / guandan /
 * zhajinhua) a guest received from its host. The host has already applied
 * per-viewer privacy (myCards); this only rebuilds a trusted shape and
 * refreshes the local staleMs.
 */
function trickGuestView(raw, role, staleMs, game) {
  if (raw === null || typeof raw !== 'object') return null
  const isDoudizhu = game === 'doudizhu'
  const isGuandan = game === 'guandan'
  const isZhajinhua = game === 'zhajinhua'
  const isTexas = game === 'texas'
  const isMahjong = game === 'mahjong4' || game === 'mahjong3'
  const engine = GAME_ENGINES[game] ?? doudizhu
  const rawPlayers = Array.isArray(raw.players) ? raw.players.slice(0, engine.maxPlayers) : []
  const maxCards = isDoudizhu ? 20 : (isGuandan ? 27 : (isZhajinhua ? 3 : (isTexas ? 2 : (isMahjong ? 14 : 16))))
  const phases = isDoudizhu
    ? DD_PHASES
    : (isGuandan
      ? GD_PHASES
      : (isZhajinhua ? ZJ_PHASES : (isTexas ? TX_PHASES : (isMahjong ? MJ_PHASES : PK_PHASES))))
  const players = rawPlayers.map((player) => {
    if (isMahjong) {
      const entry = {
        node: typeof player?.node === 'string' ? player.node : '',
        nick: text(player?.nick, 24) ?? '玩家',
        self: role !== 'spectator' && player?.self === true,
        count: clampInt(player?.count, 0, 0, 14),
        discards: sanitizeMahjongHand(player?.discards, 100),
        melds: sanitizeMahjongMelds(player?.melds),
        furiten: player?.furiten === true,
        riichi: player?.riichi === true,
        points: clampInt(player?.points, 25000, 0, 1_000_000_000),
        seatWind: ['E', 'S', 'W', 'N'].includes(player?.seatWind) ? player.seatWind : 'E',
        tenpai: player?.tenpai === true,
      }
      if (raw.phase === 'result') entry.hand = sanitizeMahjongHand(player?.hand, 14)
      return entry
    }
    if (isTexas) {
      const entry = {
        node: typeof player?.node === 'string' ? player.node : '',
        nick: text(player?.nick, 24) ?? '玩家',
        bot: player?.bot === true,
        self: role !== 'spectator' && player?.self === true,
        chips: clampInt(player?.chips, 0, 0, 1_000_000_000),
        bet: clampInt(player?.bet, 0, 0, 1_000_000_000),
        committed: clampInt(player?.committed, 0, 0, 1_000_000_000),
        status: player?.status === 'folded'
          ? 'folded'
          : (player?.status === 'allin' ? 'allin' : 'active'),
        result: player?.result === 'win' || player?.result === 'lose' ? player.result : null,
        lastAction: typeof player?.lastAction === 'string' && player.lastAction.length <= 16
          ? player.lastAction
          : null,
      }
      if (raw.phase === 'result') entry.cards = sanitizeGameCards(player?.cards, 2)
      return entry
    }
    if (isZhajinhua) {
      const entry = {
        node: typeof player?.node === 'string' ? player.node : '',
        nick: text(player?.nick, 24) ?? '玩家',
        self: role !== 'spectator' && player?.self === true,
        bot: player?.bot === true,
        chips: clampInt(player?.chips, 0, 0, 1_000_000_000),
        bet: clampInt(player?.bet, 0, 0, 1_000_000_000),
        status: player?.status === 'folded'
          ? 'folded'
          : (player?.status === 'out' ? 'out' : 'active'),
        seen: player?.seen === true,
        result: player?.result === 'win' || player?.result === 'lose' ? player.result : null,
      }
      if (raw.phase === 'result') entry.cards = sanitizeGameCards(player?.cards, 3)
      return entry
    }
    const entry = {
      node: typeof player?.node === 'string' ? player.node : '',
      nick: text(player?.nick, 24) ?? '玩家',
      bot: player?.bot === true,
      self: role !== 'spectator' && player?.self === true,
      count: clampInt(player?.count, 0, 0, maxCards),
      status: player?.status === 'out' ? 'out' : 'playing',
      result: player?.result === 'win' || player?.result === 'lose' ? player.result : null,
    }
    if (isDoudizhu) {
      entry.role = player?.role === 'landlord' || player?.role === 'farmer' ? player.role : null
      entry.bidding = typeof player?.bidding === 'boolean' ? player.bidding : null
    }
    if (isGuandan) {
      entry.team = player?.team === 1 ? 1 : 0
      entry.order = clampInt(player?.order, null, 1, 4)
    }
    return entry
  })
  const rawLast = raw.lastPlay !== null && typeof raw.lastPlay === 'object' ? raw.lastPlay : null
  const view = {
    game,
    role,
    hostNode: typeof raw.hostNode === 'string' ? raw.hostNode : '',
    phase: phases.has(raw.phase) ? raw.phase : 'idle',
    round: clampInt(raw.round, 0, 0, 999),
    turn: typeof raw.turn === 'string' && TABLE_NODE_RE.test(raw.turn) ? raw.turn : null,
    myCards: role === 'spectator' ? [] : sanitizeGameCards(raw.myCards, maxCards),
    players,
    log: sanitizeLog(raw.log),
    scores: normalizeTrickScores(raw.scores, players),
    staleMs: clampInt(staleMs, 0, 0, 9_999_999),
    turnRemainingMs: clampInt(raw.turnRemainingMs, null, 0, MAX_TURN_REMAINING_MS),
  }
  if (isDoudizhu || isGuandan) {
    view.lastPlay = rawLast === null
      ? null
      : {
          node: typeof rawLast.node === 'string' ? rawLast.node : '',
          cards: sanitizeGameCards(rawLast.cards, maxCards),
          label: text(rawLast.label, 40) ?? '出牌',
        }
    view.mustPlay = raw.mustPlay === true
  }
  if (isDoudizhu) {
    view.landlord = typeof raw.landlord === 'string' && TABLE_NODE_RE.test(raw.landlord)
      ? raw.landlord
      : null
  }
  if (isGuandan) {
    view.level = typeof raw.level === 'string' && raw.level.length <= 2 ? raw.level : '2'
    view.teamLevels = Array.isArray(raw.teamLevels)
      ? raw.teamLevels.slice(0, 2).map((value) => (typeof value === 'string' && value.length <= 2 ? value : '2'))
      : ['2', '2']
    while (view.teamLevels.length < 2) view.teamLevels.push('2')
    view.team = raw.team === 1 ? 1 : (raw.team === 0 ? 0 : null)
    if (raw.phase === 'result') {
      view.winnerTeam = raw.winnerTeam === 1 ? 1 : 0
      view.upgrade = clampInt(raw.upgrade, 0, 0, 3)
      view.orders = Array.isArray(raw.orders)
        ? raw.orders.filter((node) => typeof node === 'string' && TABLE_NODE_RE.test(node)).slice(0, 4)
        : []
      if (raw.matchWon === true) view.matchWon = true
    }
    // v10: tribute/return lanes are public information.
    view.tribute = Array.isArray(raw.tribute)
      ? raw.tribute.slice(0, 2).map((entry) => {
          const card = sanitizeGameCards([entry?.card], 1)[0]
          const gift = sanitizeGameCards([entry?.gift], 1)[0]
          const returned = sanitizeGameCards([entry?.returned], 1)[0]
          return {
            from: typeof entry?.from === 'string' && TABLE_NODE_RE.test(entry.from) ? entry.from : '',
            to: typeof entry?.to === 'string' && TABLE_NODE_RE.test(entry.to) ? entry.to : '',
            card: card ?? null,
            gift: gift ?? null,
            returned: returned ?? null,
            skipped: entry?.skipped === true,
          }
        })
      : []
    view.pendingReturn = typeof raw.pendingReturn === 'string' && TABLE_NODE_RE.test(raw.pendingReturn)
      ? raw.pendingReturn
      : null
  }
  if (isZhajinhua) {
    view.pot = clampInt(raw.pot, 0, 0, 1_000_000_000)
    view.currentBet = clampInt(raw.currentBet, 0, 0, 1_000_000_000)
    view.raises = clampInt(raw.raises, 0, 0, 5)
    if (raw.phase === 'result') {
      view.winnerNode = typeof raw.winnerNode === 'string' && TABLE_NODE_RE.test(raw.winnerNode)
        ? raw.winnerNode
        : null
    }
  }
  if (isTexas) {
    view.dealer = typeof raw.dealer === 'string' && TABLE_NODE_RE.test(raw.dealer) ? raw.dealer : null
    view.pot = clampInt(raw.pot, 0, 0, 1_000_000_000)
    view.currentBet = clampInt(raw.currentBet, 0, 0, 1_000_000_000)
    view.community = sanitizeGameCards(raw.community, 5)
    if (raw.phase === 'result') {
      view.board = sanitizeGameCards(raw.board, 5)
      view.winnerNodes = Array.isArray(raw.winnerNodes)
        ? raw.winnerNodes.filter((node) => typeof node === 'string' && TABLE_NODE_RE.test(node)).slice(0, 6)
        : []
      view.pots = Array.isArray(raw.pots)
        ? raw.pots.slice(0, 6).map((pot) => ({
            amount: clampInt(pot?.amount, 0, 0, 1_000_000_000),
            winners: Array.isArray(pot?.winners)
              ? pot.winners.filter((node) => typeof node === 'string' && TABLE_NODE_RE.test(node)).slice(0, 6)
              : [],
          }))
        : []
    }
  }
  if (isMahjong) {
    // M1/M2: myHand replaces myCards; discards are public; result reveals hands.
    delete view.myCards
    view.myHand = role === 'spectator' ? [] : sanitizeMahjongHand(raw.myHand, 14)
    view.dealer = typeof raw.dealer === 'string' && TABLE_NODE_RE.test(raw.dealer) ? raw.dealer : null
    view.wall = clampInt(raw.wall, 0, 0, 200)
    view.doraIndicator = typeof raw.doraIndicator === 'string' && MJ_TILE_RE.test(raw.doraIndicator)
      ? raw.doraIndicator
      : null
    view.doras = sanitizeMahjongHand(raw.doras, 8)
    view.nuki = clampInt(raw.nuki, 0, 0, 100)
    view.discards = Array.isArray(raw.discards)
      ? raw.discards.slice(0, 4).map((pile) => sanitizeMahjongHand(pile, 100))
      : players.map((player) => player.discards)
    view.melds = players.map((player) => player.melds)
    view.calling = raw.calling === true && raw.phase === 'calling'
    view.pending = sanitizeMahjongPending(raw.pending)
    view.lastDiscard = raw.lastDiscard !== null && typeof raw.lastDiscard === 'object'
      && typeof raw.lastDiscard.node === 'string' && TABLE_NODE_RE.test(raw.lastDiscard.node)
      && typeof raw.lastDiscard.tile === 'string' && MJ_TILE_RE.test(raw.lastDiscard.tile)
      ? { node: raw.lastDiscard.node, tile: raw.lastDiscard.tile }
      : null
    view.mustDiscard = raw.mustDiscard === true
    view.furiten = {}
    if (raw.furiten !== null && typeof raw.furiten === 'object' && !Array.isArray(raw.furiten)) {
      for (const [node, value] of Object.entries(raw.furiten)) {
        if (TABLE_NODE_RE.test(node)) view.furiten[node] = value === true
      }
    }
    view.riichiSticks = clampInt(raw.riichiSticks, 0, 0, 1000)
    view.riichi = {}
    view.points = {}
    for (const player of players) {
      view.riichi[player.node] = player.riichi === true
      view.points[player.node] = player.points
    }
    view.roundLabel = typeof raw.roundLabel === 'string' && /^东[1-9]局$/.test(raw.roundLabel)
      ? raw.roundLabel
      : '东1局'
    view.seatWind = Object.fromEntries(players.map((player) => [player.node, player.seatWind]))
    view.tenpai = Object.fromEntries(players.map((player) => [player.node, player.tenpai === true]))
    view.matchOver = raw.matchOver === true
    view.renchan = raw.renchan === true
    view.finalPoints = Array.isArray(raw.finalPoints)
      ? raw.finalPoints.slice(0, 6).map((entry) => ({
          node: typeof entry?.node === 'string' && TABLE_NODE_RE.test(entry.node) ? entry.node : '',
          nick: text(entry?.nick, 24) ?? '玩家',
          points: clampInt(entry?.points, 0, 0, 1_000_000_000),
          rank: clampInt(entry?.rank, 0, 0, 6),
        }))
      : null
    view.uraDoras = sanitizeMahjongHand(raw.uraDoras, 8)
    view.result = raw.result === 'tsumo' || raw.result === 'ron' || raw.result === 'exhausted'
      ? raw.result
      : null
    if (raw.result === 'tsumo' || raw.result === 'ron') {
      view.yaku = Array.isArray(raw.yaku)
        ? raw.yaku.slice(0, 40).map((entry) => ({
            name: text(entry?.name, 20) ?? '役',
            han: clampInt(entry?.han, 1, 1, 13),
          }))
        : []
      view.han = clampInt(raw.han, 0, 0, 26)
      view.fu = clampInt(raw.fu, 0, 0, 200)
      view.score = clampInt(raw.score, 0, 0, 1_000_000_000)
      view.deltas = {}
      if (raw.deltas !== null && typeof raw.deltas === 'object' && !Array.isArray(raw.deltas)) {
        for (const [node, value] of Object.entries(raw.deltas)) {
          if (TABLE_NODE_RE.test(node)) view.deltas[node] = clampInt(value, 0, -1_000_000_000, 1_000_000_000)
        }
      }
      view.doraHan = clampInt(raw.doraHan, 0, 0, 100)
      view.akaHan = clampInt(raw.akaHan, 0, 0, 100)
      view.uraHan = clampInt(raw.uraHan, 0, 0, 100)
      view.riichiSticksAwarded = clampInt(raw.riichiSticksAwarded, 0, 0, 1000)
    }
    view.winnerNode = typeof raw.winnerNode === 'string' && TABLE_NODE_RE.test(raw.winnerNode)
      ? raw.winnerNode
      : null
    if (raw.result === 'exhausted') {
      view.deltas = {}
      if (raw.deltas !== null && typeof raw.deltas === 'object' && !Array.isArray(raw.deltas)) {
        for (const [node, value] of Object.entries(raw.deltas)) {
          if (TABLE_NODE_RE.test(node)) view.deltas[node] = clampInt(value, 0, -1_000_000_000, 1_000_000_000)
        }
      }
    }
  }
  return view
}

/**
 * One table snapshot shared by HTTP view.table and the UDP state.table.
 * The dealer is always the visible one: the hole card never leaves the host.
 * `turnRemaining` is the host-computed / state-snapshot turn budget in ms.
 */
function tableSnapshot(rawTable, role, hostNode, selfNode, scoreMap, staleMs, turnRemaining = null) {
  const rawPlayers = Array.isArray(rawTable?.players) ? rawTable.players : []
  const players = rawPlayers.slice(0, MAX_PLAYERS).map((player) => {
    const node = typeof player?.node === 'string' ? player.node : ''
    const cards = sanitizeCards(player?.cards)
    return {
      node,
      nick: text(player?.nick, 24) ?? '玩家',
      bot: player?.bot === true,
      cards,
      total: handValue(cards),
      status: STATUSES.has(player?.status) ? player.status : 'playing',
      result: RESULTS.has(player?.result) ? player.result : null,
      self: node !== '' && node === selfNode,
    }
  })
  const dealerView = visibleDealer(rawTable ?? { dealer: { cards: [] }, phase: 'idle' })
  const dealerCards = sanitizeCards(dealerView.cards)
  return {
    game: 'blackjack',
    role,
    hostNode: typeof hostNode === 'string' ? hostNode : '',
    phase: PHASES.has(rawTable?.phase) ? rawTable.phase : 'idle',
    round: clampInt(rawTable?.round, 0, 0, 999),
    turn: typeof rawTable?.turn === 'string' && NODE_RE.test(rawTable.turn) ? rawTable.turn : null,
    players,
    dealer: { cards: dealerCards, hidden: dealerView.hidden === true, total: handValue(dealerCards) },
    log: sanitizeLog(rawTable?.log),
    scores: normalizeScores(scoreMap, players),
    staleMs: clampInt(staleMs, 0, 0, 9_999_999),
    turnRemainingMs: clampInt(turnRemaining, null, 0, MAX_TURN_REMAINING_MS),
  }
}

/** Read the JSON body of a POST request (empty body becomes {}). */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        done(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        done({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        done(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        done(null)
      }
    })
    req.on('error', () => done(null))
  })
}

/** Write one JSON response (never throws; callers are inside route handlers). */
function writeJson(res, status, value) {
  try {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    try {
      res.statusCode = 500
      res.end()
    } catch {
      // The response is gone; nothing left to do.
    }
  }
}

/** True for loopback hostnames used by the DSH web server. */
function isLoopbackHostname(value) {
  const name = value.toLowerCase()
  return name === 'localhost'
    || name === '::1'
    || name === '[::1]'
    || /^127\./.test(name)
}

/**
 * Loopback-only fence for the card-table control routes: loopback socket plus
 * a same-origin Host/Origin check, so another page served from a different
 * local port cannot drive the config/action endpoints.
 */
function fromLoopback(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string') return false
  const loopback = address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
  if (!loopback) return false

  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false

  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const originUrl = new URL(origin)
      if (!isLoopbackHostname(originUrl.hostname) || originUrl.port !== hostUrl.port) return false
    } catch {
      return false
    }
  }
  return true
}

/* -------------------------------------------------------------------------- *
 * Service factory
 * -------------------------------------------------------------------------- */

/**
 * Build one card-table LAN service for a DSH process.
 * @param {object} [options] - { home?, port?, room?, nick?, enabled? }
 *   `home` overrides $DSH_HOME (tests); the other fields seed the first config.
 */
export function createCardLan(options = {}) {
  const homeDir = resolveHome(options.home)
  const configPath = join(homeDir, 'dsh-card-lan.json')

  let config = {
    enabled: DEFAULTS.enabled,
    room: DEFAULTS.room,
    port: DEFAULTS.port,
    game: DEFAULTS.game,
    overlayOpacity: DEFAULTS.overlayOpacity,
    passwordEnabled: DEFAULTS.passwordEnabled,
    password: DEFAULTS.password,
    spectatorEnabled: DEFAULTS.spectatorEnabled,
    overlaySize: DEFAULTS.overlaySize,
    overlayX: DEFAULTS.overlayX,
    overlayY: DEFAULTS.overlayY,
    autoFade: DEFAULTS.autoFade,
    turnTimeout: DEFAULTS.turnTimeout,
    botCount: DEFAULTS.botCount,
    autoFillBots: DEFAULTS.autoFillBots,
    nick: defaultNick(),
    nodeId: randomUUID(),
  }

  let socket
  let boundPort = 0
  /**
   * Guest-side transport socket. Joins/actions leave from this ephemeral port
   * and state/reject come back to it, so two DSH instances on ONE machine that
   * both bind the same config port still have unambiguous unicast (the OS would
   * otherwise deliver every unicast to whichever socket bound the port first).
   * The host records the source port anyway (PROTOCOL.md 2.2), so this stays
   * inside the wire contract.
   */
  let guestSocket
  let guestBoundPort = 0
  let disposed = false
  let started = false
  let lastError = null

  /** Discovered peers, keyed by node. */
  let peers = new Map()
  /** Seated players of the local (host) table, keyed by node. */
  let seats = new Map()
  /** Spectators of the local (host) table, keyed by node. */
  let watchers = new Map()
  /** The local authoritative table (engine table) while hosting. */
  let table
  /** Which game the local table runs: 'blackjack' | 'doudizhu' | 'paodekuai'. */
  let tableGame = DEFAULTS.game
  /** Engine module backing the local table (undefined for blackjack). */
  let tableEngine
  /** True while this process hosts a table. */
  let hostOpen = false
  /** Session scores of the local table, keyed by node. */
  let scores = {}
  /** Highest round already written into `scores`. */
  let scoredRound = 0
  /** Recent applied action ids (attached to state packets). */
  let acks = []
  /** Dedupe window: 'from\naid' -> at. */
  const ackAt = new Map()
  /** State packet sequence counter. */
  let seq = 0

  /** Host: when the current turn started (ms) and which node owns it. */
  let turnStartedAt = 0
  let currentTurnNode

  /** Guest role: the host we joined (node filled in after the first state). */
  let joinedHost
  /** Guest role: the last table/scores seen from the host. */
  let remote
  /** Guest role: in-flight join retransmission. */
  let pendingJoin
  /** Guest role: in-flight actions awaiting acks, keyed by aid. */
  const pendingActions = new Map()
  /** Guest role: remembered host info for auto-reconnect (memory only, no pw on disk). */
  let rejoinTarget
  /** Guest role: auto-reconnect state (PROTOCOL.md 2.5c). */
  let reconnecting = false
  let reconnectAttempts = 0
  let reconnectLastAt = 0
  let reconnectGaveUp = false

  const timers = { announce: undefined, heartbeat: undefined, sweep: undefined, retry: undefined }
  let bindRetry
  /** Pending bot move (single timer) and the table generation guard for it. */
  let botTimer
  let botToken = 0

  const stats = { sent: 0, received: 0, dropped: 0, startedAt: 0 }

  /** Datagrams handed to the kernel but not yet acknowledged by a send callback. */
  let pendingSends = 0

  /** Per-IP / global packet budgets. */
  const packetWindows = new Map()
  let packetTotal = { at: 0, count: 0 }
  /** Deferred repetitions of the guest "leave" datagram (best effort, 3 sends). */
  const leaveTimers = new Set()

  /* ------------------------------------------------------------------ *
   * Config persistence
   * ------------------------------------------------------------------ */

  /** Persist the effective config (atomic replace). */
  async function persistConfig() {
    try {
      await mkdir(homeDir, { recursive: true })
      const tmp = configPath + '.tmp'
      await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
      await rename(tmp, configPath)
    } catch (error) {
      lastError = 'config-write: ' + String(error?.message ?? error)
    }
  }

  /** Seed the config from createCardLan options (tests / manual run). */
  function applyOptionOverrides() {
    if (Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65535) {
      config.port = options.port
    }
    if (typeof options.room === 'string') {
      const room = text(options.room, 32)
      if (room !== undefined) config.room = room
    }
    if (typeof options.nick === 'string') {
      const nick = text(options.nick, 24)
      if (nick !== undefined) config.nick = nick
    }
    if (typeof options.enabled === 'boolean') config.enabled = options.enabled
  }

  /** Load the persisted config, repairing missing/invalid fields. */
  async function loadConfig() {
    let raw = {}
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed
    } catch {
      // Missing or corrupt file: defaults are the supported first-run state.
    }
    // A password that is enabled but empty is meaningless: fall back to off.
    const savedPassword = text(raw.password, PASSWORD_MAX) ?? ''
    // Bot seats: botCount is canonical; migrate the old fillBots boolean.
    let savedBotCount = DEFAULTS.botCount
    if (raw.botCount !== undefined) {
      savedBotCount = Number.isInteger(raw.botCount)
        ? Math.min(5, Math.max(0, raw.botCount))
        : DEFAULTS.botCount
    } else if (raw.fillBots === true) {
      savedBotCount = 2
    }
    // autoFillBots: explicit boolean wins; legacy configs without the field
    // mean "fill to minPlayers" when botCount was set to its maximum (2) or
    // when the v6 fillBots switch was on.
    let savedAutoFillBots = DEFAULTS.autoFillBots
    if (typeof raw.autoFillBots === 'boolean') {
      savedAutoFillBots = raw.autoFillBots
    } else if (raw.autoFillBots === undefined) {
      savedAutoFillBots = raw.fillBots === true || savedBotCount === 2
    }
    config = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      room: text(raw.room, 32) ?? DEFAULTS.room,
      port: clampInt(raw.port, DEFAULTS.port, 1024, 65535),
      game: GAMES.has(raw.game) ? raw.game : DEFAULTS.game,
      overlayOpacity: clampOpacity(raw.overlayOpacity),
      passwordEnabled: raw.passwordEnabled === true && savedPassword !== '',
      password: savedPassword,
      spectatorEnabled: typeof raw.spectatorEnabled === 'boolean'
        ? raw.spectatorEnabled
        : DEFAULTS.spectatorEnabled,
      overlaySize: OVERLAY_SIZES.has(raw.overlaySize) ? raw.overlaySize : DEFAULTS.overlaySize,
      overlayX: clampOverlayPosition(raw.overlayX ?? null) ?? null,
      overlayY: clampOverlayPosition(raw.overlayY ?? null) ?? null,
      autoFade: typeof raw.autoFade === 'boolean' ? raw.autoFade : DEFAULTS.autoFade,
      turnTimeout: clampTurnTimeout(raw.turnTimeout, DEFAULTS.turnTimeout),
      botCount: savedBotCount,
      autoFillBots: savedAutoFillBots,
      nick: text(raw.nick, 24) ?? defaultNick(),
      nodeId: typeof raw.nodeId === 'string' && NODE_RE.test(raw.nodeId) ? raw.nodeId : randomUUID(),
    }
    applyOptionOverrides()
    // Keep the identity stable across restarts so peers do not see a brand-new
    // machine every launch.
    if (raw.nodeId !== config.nodeId) await persistConfig()
  }

  /* ------------------------------------------------------------------ *
   * UDP plumbing
   * ------------------------------------------------------------------ */

  /** Send one pre-encoded body through one socket. */
  function sendRawSocket(target, body, ip, port) {
    if (target === undefined) return false
    try {
      pendingSends += 1
      target.send(body, 0, body.byteLength, port, ip, (error) => {
        pendingSends = Math.max(0, pendingSends - 1)
        // Late send failures must not clobber the reconnect/close outcome the
        // UI is already showing.
        if (error && lastError !== 'reconnect-failed' && lastError !== 'host-closed') {
          lastError = 'send: ' + String(error?.message ?? error)
        }
      })
      stats.sent += 1
      return true
    } catch (error) {
      pendingSends = Math.max(0, pendingSends - 1)
      lastError = 'send: ' + String(error?.message ?? error)
      return false
    }
  }

  /**
   * Wait (bounded) until the socket accepted every queued datagram. Needed
   * before closeSocket(): a UDP close can cancel sends that are still pending,
   * which would lose the "closed" notification.
   */
  async function flushSends(limit = 250) {
    const started = Date.now()
    while (pendingSends > 0 && Date.now() - started < limit) await delay(5)
  }

  /** Send one pre-encoded body on the discovery/broadcast socket. */
  function sendRaw(body, ip, port) {
    if (socket === undefined || boundPort === 0) return false
    return sendRawSocket(socket, body, ip, port)
  }

  /** Send one pre-encoded body on the guest transport socket (fallback: main). */
  function sendGuestRaw(body, ip, port) {
    const target = guestSocket !== undefined && guestBoundPort > 0 ? guestSocket : socket
    if (target === undefined) return false
    if (target === socket && boundPort === 0) return false
    return sendRawSocket(target, body, ip, port)
  }

  /** Encode one JSON packet, refusing anything oversized. */
  function encodeJson(payload) {
    try {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      return body.byteLength > MAX_STATE_BYTES ? undefined : body
    } catch (error) {
      lastError = 'encode: ' + String(error?.message ?? error)
      return undefined
    }
  }

  /** Send one small JSON packet to a unicast destination. */
  function sendJson(payload, ip, port) {
    if (typeof ip !== 'string' || !isIpv4(ip)) return false
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false
    const body = encodeJson(payload)
    if (body === undefined) return false
    return sendRaw(body, ip, port)
  }

  /** Send one guest-role JSON packet (join / action / unicast hello). */
  function sendGuestJson(payload, ip, port) {
    if (typeof ip !== 'string' || !isIpv4(ip)) return false
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false
    const body = encodeJson(payload)
    if (body === undefined) return false
    return sendGuestRaw(body, ip, port)
  }

  /** Broadcast one small JSON packet to every LAN destination. */
  function broadcastJson(payload) {
    if (socket === undefined || boundPort === 0) return
    let body
    try {
      body = Buffer.from(JSON.stringify(payload), 'utf8')
    } catch (error) {
      lastError = 'encode: ' + String(error?.message ?? error)
      return
    }
    if (body.byteLength > MAX_STATE_BYTES) return
    for (const target of broadcastTargets()) sendRaw(body, target, config.port)
  }

  /** The hello datagram this process broadcasts. */
  function helloPayload() {
    return {
      v: PROTOCOL,
      t: 'hello',
      room: config.room,
      node: config.nodeId,
      nick: config.nick,
      port: boundPort || config.port,
      table: hostOpen && table !== undefined
        ? {
            open: true,
            players: table.players.length,
            password: config.passwordEnabled,
            watch: config.spectatorEnabled,
            spectators: watchers.size,
            game: tableGame,
          }
        : null,
      sentAt: Date.now(),
    }
  }

  /** Broadcast hello once (no-op while disabled / before the socket is ready). */
  function announce() {
    if (disposed || !config.enabled) return
    if (socket === undefined || boundPort === 0) return
    const payload = helloPayload()
    broadcastJson(payload)
    // A seated guest also unicasts hello to its host: this keeps the host's
    // 12 s seat-liveness check happy even when the two instances run on one
    // machine with different UDP ports (a same-machine test setup).
    if (joinedHost !== undefined && joinedHost.ip !== '') {
      sendGuestJson({ ...payload, sentAt: Date.now() }, joinedHost.ip, joinedHost.port)
    }
  }

  /** Attach `ctx.effect` friendly socket lifecycle: close whatever is bound. */
  function closeSocket() {
    const current = socket
    socket = undefined
    boundPort = 0
    if (current !== undefined) {
      try {
        current.removeAllListeners()
        current.close()
      } catch {
        // Already closed.
      }
    }
  }

  /** Bind 0.0.0.0:<config.port> and resolve once listening (or failed). */
  function openSocket() {
    if (disposed || !config.enabled) return Promise.resolve()
    closeSocket()
    let next
    try {
      next = createSocket({ type: 'udp4', reuseAddr: true })
    } catch (error) {
      lastError = 'socket: ' + String(error?.message ?? error)
      return Promise.resolve()
    }
    socket = next
    return new Promise((resolve) => {
      let settled = false
      let guard
      const finish = () => {
        if (settled) return
        settled = true
        if (guard !== undefined) clearTimeout(guard)
        resolve()
      }
      guard = setTimeout(() => {
        lastError = 'bind-timeout'
        finish()
      }, 3000)
      guard.unref?.()

      next.on('message', (buffer, address) => {
        try {
          onDatagram(buffer, address)
        } catch (error) {
          lastError = 'udp: ' + String(error?.message ?? error)
        }
      })
      next.on('error', (error) => {
        onSocketError(error)
        finish()
      })
      next.once('listening', () => {
        if (socket !== next) {
          finish()
          return
        }
        try {
          next.setBroadcast(true)
        } catch (error) {
          lastError = 'broadcast: ' + String(error?.message ?? error)
        }
        try {
          boundPort = next.address().port
        } catch {
          boundPort = config.port
        }
        stats.startedAt = stats.startedAt || Date.now()
        lastError = null
        // Never keep the host process alive on behalf of the LAN socket.
        next.unref?.()
        console.log('[dsh-card-lan] udp listening on 0.0.0.0:' + boundPort + ' room=' + config.room)
        finish()
        announce()
        pushState()
      })
      try {
        next.bind(config.port, '0.0.0.0')
      } catch (error) {
        lastError = 'bind: ' + String(error?.message ?? error)
        finish()
      }
    })
  }

  /** Report a socket-level failure (bind failures also schedule a retry). */
  function onSocketError(error) {
    lastError = 'udp: ' + String(error?.message ?? error)
    if (disposed || !config.enabled) return
    if (boundPort === 0 && bindRetry === undefined) {
      bindRetry = setTimeout(() => {
        bindRetry = undefined
        if (!disposed && config.enabled) void openSocket()
      }, 10_000)
      bindRetry.unref?.()
    }
  }

  /** Close the guest transport socket (idempotent). */
  function closeGuestSocket() {
    const current = guestSocket
    guestSocket = undefined
    guestBoundPort = 0
    if (current !== undefined) {
      try {
        current.removeAllListeners()
        current.close()
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * Bind the guest transport socket on an ephemeral port (idempotent).
   * Resolves with the socket, or undefined when it cannot be created.
   */
  function openGuestSocket() {
    if (disposed || !config.enabled) return Promise.resolve(undefined)
    if (guestSocket !== undefined && guestBoundPort > 0) return Promise.resolve(guestSocket)
    closeGuestSocket()
    let next
    try {
      next = createSocket({ type: 'udp4', reuseAddr: true })
    } catch (error) {
      lastError = 'guest-socket: ' + String(error?.message ?? error)
      return Promise.resolve(undefined)
    }
    guestSocket = next
    return new Promise((resolve) => {
      let settled = false
      let guard
      const finish = (value) => {
        if (settled) return
        settled = true
        if (guard !== undefined) clearTimeout(guard)
        resolve(value)
      }
      guard = setTimeout(() => {
        lastError = 'guest-bind-timeout'
        finish(undefined)
      }, 2000)
      guard.unref?.()
      next.on('message', (buffer, address) => {
        try {
          onDatagram(buffer, address)
        } catch (error) {
          lastError = 'udp: ' + String(error?.message ?? error)
        }
      })
      next.on('error', (error) => {
        lastError = 'udp: ' + String(error?.message ?? error)
        if (guestSocket === next) {
          guestSocket = undefined
          guestBoundPort = 0
        }
        finish(undefined)
      })
      next.once('listening', () => {
        if (guestSocket !== next) {
          finish(undefined)
          return
        }
        try {
          guestBoundPort = next.address().port
        } catch {
          guestBoundPort = 0
        }
        next.unref?.()
        finish(next)
      })
      try {
        next.bind(0, '0.0.0.0')
      } catch (error) {
        lastError = 'guest-bind: ' + String(error?.message ?? error)
        finish(undefined)
      }
    })
  }

  /** Per-IP and global packet budget (one-second windows). */
  function allowPacket(ip, now) {
    if (now - packetTotal.at >= PACKET_WINDOW_MS) packetTotal = { at: now, count: 0 }
    if (packetTotal.count >= PACKET_MAX_TOTAL) {
      stats.dropped += 1
      return false
    }
    let bucket = packetWindows.get(ip)
    if (bucket === undefined || now - bucket.at >= PACKET_WINDOW_MS) {
      bucket = { at: now, count: 0 }
      packetWindows.set(ip, bucket)
    }
    if (bucket.count >= PACKET_MAX_PER_IP) {
      stats.dropped += 1
      return false
    }
    bucket.count += 1
    packetTotal.count += 1
    return true
  }

  /* ------------------------------------------------------------------ *
   * Host table (authoritative rounds)
   * ------------------------------------------------------------------ */

  /** Append one log line (engine keeps its own; this mirrors the shape). */
  function pushLog(line) {
    if (table === undefined) return
    // Blackjack's engine log carries { at, text }; the engine-backed games'
    // logs carry plain strings, so host-side lines follow the same shape.
    table.log.push(tableEngine !== undefined
      ? String(line).slice(0, 80)
      : { at: Date.now(), text: line })
    if (table.log.length > 40) table.log.splice(0, table.log.length - 40)
    table.updatedAt = Date.now()
  }

  /** Seat cap of the game the local table runs. */
  function gameMaxPlayers() {
    return GAME_MAX_PLAYERS[tableGame] ?? MAX_PLAYERS
  }

  /** True when the current game has an actionable turn (countdown / timeout). */
  function isTurnActive() {
    if (!hostOpen || table === undefined) return false
    if (typeof table.turn !== 'string' || table.turn === '') return false
    if (tableEngine !== undefined) return ACTIVE_TURN_PHASES.has(table.phase)
    return table.phase === 'playing'
  }

  /** Ensure a score bucket exists for one node. */
  function ensureScore(node) {
    if (scores[node] === undefined) scores[node] = { win: 0, lose: 0, push: 0 }
    return scores[node]
  }

  /** Fold a finished round into scores exactly once (blackjack only). */
  function updateScores() {
    if (!hostOpen || table === undefined) return
    if (tableGame !== 'blackjack') return
    if (table.phase !== 'result') return
    if (table.round <= scoredRound) return
    scoredRound = table.round
    for (const player of table.players) {
      if (!RESULTS.has(player.result)) continue
      // A late joiner who sat this round out (no cards) does not score it.
      if (!Array.isArray(player.cards) || player.cards.length === 0) continue
      ensureScore(player.node)[player.result] += 1
    }
  }

  /** Track when the current player's turn started (resets on every turn change). */
  function syncTurnClock() {
    if (!isTurnActive()) {
      turnStartedAt = 0
      currentTurnNode = undefined
      return
    }
    const node = table.turn
    if (node !== currentTurnNode) {
      currentTurnNode = node
      turnStartedAt = Date.now()
    }
  }

  /** Host-side realtime remaining ms of the current turn (null when n/a). */
  function turnRemainingMs() {
    if (!isTurnActive()) return null
    if (!Number.isInteger(config.turnTimeout) || config.turnTimeout <= 0) return null
    // turnTimeout only applies to humans (PROTOCOL.md 7.8).
    const player = table.players.find((entry) => entry.node === table.turn)
    if (player !== undefined && player.bot === true) return null
    syncTurnClock()
    if (turnStartedAt === 0) return null
    return Math.max(0, config.turnTimeout * 1000 - (Date.now() - turnStartedAt))
  }

  /** The state/scores snapshot sent to guests and served over HTTP. */
  function scoresSnapshot(players) {
    return normalizeScores(scores, players ?? [])
  }

  /** Scores payload for the current game (blackjack has push, engines do not). */
  function gameScoresPayload() {
    if (table === undefined) return {}
    if (tableEngine !== undefined) return normalizeTrickScores(table.scores, table.players)
    return scoresSnapshot(table.players)
  }

  /**
   * Per-viewer table snapshot for the current game. This is the only place the
   * UDP state and the HTTP view learn a table's shape; the engine-backed games
   * hide other players' hands here (myCards goes to the viewer only).
   */
  function snapshotFor(viewerNode, role, staleMs) {
    if (table === undefined) return null
    const remaining = turnRemainingMs()
    if (tableEngine !== undefined) {
      return tableEngine.snapshot(table, viewerNode, {
        role,
        hostNode: config.nodeId,
        staleMs,
        turnRemainingMs: remaining,
        scores: table.scores,
      })
    }
    const selfNode = role === 'spectator' ? '' : viewerNode
    return tableSnapshot(table, role, config.nodeId, selfNode, scores, staleMs, remaining)
  }

  /** Whitelist one client/wire action object for a game. */
  function sanitizeGameAction(action, game) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return undefined
    const type = typeof action.type === 'string' ? action.type.trim() : ''
    if (type === '') return undefined
    if (!TRICK_GAMES.has(game)) return { type }
    if (game === 'doudizhu' && type === 'bid') return { type, bid: action.bid === true }
    if (game === 'guandan' && type === 'tribute-return') {
      // v10: one specific card goes back to the tribute giver.
      const cards = sanitizeGameCards([action.card], 1)
      return cards.length === 1 ? { type, card: cards[0] } : undefined
    }
    if (game === 'mahjong4' || game === 'mahjong3') {
      if (type === 'tsumo' || type === 'pass' || type === 'ron' || type === 'riichi') return { type }
      if (type === 'discard' || type === 'ankan' || type === 'kakan') {
        const tile = sanitizeMahjongTile(action.tile)
        return tile === undefined ? undefined : { type, tile }
      }
      if (type === 'nuki') {
        const tile = action.tile === undefined ? 'N' : sanitizeMahjongTile(action.tile)
        return tile === undefined ? undefined : { type, tile }
      }
      if (type === 'pon' || type === 'kan' || type === 'chi') {
        return { type, tiles: sanitizeMahjongHand(action.tiles, 4) }
      }
      return undefined
    }
    if (game === 'zhajinhua') {
      // 炸金花 has no card payload: only these five host-authoritative actions.
      return ['look', 'call', 'raise', 'fold', 'compare'].includes(type) ? { type } : undefined
    }
    if (game === 'texas') {
      // 德州 too: fold / check / call / raise only (no free-form amounts).
      if (!['fold', 'check', 'call', 'raise'].includes(type)) return undefined
      if (type === 'raise' && action.amount !== undefined) {
        return Number.isInteger(action.amount) ? { type, amount: action.amount } : { type }
      }
      return { type }
    }
    if (type === 'play') {
      const limit = GAME_PLAY_CARDS_MAX[game] ?? 20
      return { type, cards: sanitizeGameCards(action.cards, limit) }
    }
    if (type === 'pass') return { type }
    return undefined
  }

  /** Run one action through the current game engine. */
  function applyGameAction(node, action) {
    if (table === undefined) return { ok: false, error: 'table-closed' }
    if (tableEngine !== undefined) return tableEngine.applyAction(table, node, action)
    return applyAction(table, node, typeof action?.type === 'string' ? action.type : '')
  }

  /** Send one state datagram to one seated guest or spectator. */
  function sendStateTo(recipient, role = 'player') {
    if (!hostOpen || table === undefined || socket === undefined || boundPort === 0) return
    const payload = {
      v: PROTOCOL,
      t: 'state',
      room: config.room,
      host: config.nodeId,
      seq,
      acks: acks.slice(-ACK_KEEP),
      table: snapshotFor(recipient.node, role, 0),
      scores: gameScoresPayload(),
      sentAt: Date.now(),
    }
    let body
    try {
      body = Buffer.from(JSON.stringify(payload), 'utf8')
    } catch (error) {
      lastError = 'encode: ' + String(error?.message ?? error)
      return
    }
    // Shed log lines before anything gameplay-related if the packet gets big.
    while (body.byteLength > MAX_STATE_BYTES && payload.table.log.length > 0) {
      payload.table.log.splice(0, Math.ceil(payload.table.log.length / 2))
      body = Buffer.from(JSON.stringify(payload), 'utf8')
    }
    if (body.byteLength > MAX_STATE_BYTES) return
    sendRaw(body, recipient.ip, recipient.port)
  }

  /** Push the table state to every seated guest + spectator and bump the sequence. */
  function pushState() {
    if (!hostOpen || table === undefined) return
    syncTurnClock()
    updateScores()
    seq += 1
    for (const seat of seats.values()) {
      if (seat.node === config.nodeId) continue
      sendStateTo(seat, 'player')
    }
    for (const watcher of watchers.values()) sendStateTo(watcher, 'spectator')
    scheduleBotTurn()
  }

  /** Cancel the pending bot move (idempotent). */
  function cancelBotTimer() {
    if (botTimer !== undefined) clearTimeout(botTimer)
    botTimer = undefined
  }

  /**
   * How many bots the table should hold (PROTOCOL.md 7.8):
   *   needed = max(0, minPlayers - humans)
   *   target = autoFillBots ? needed : min(botCount, needed)
   */
  function targetBotCount() {
    if (tableEngine === undefined || table === undefined) return 0
    if (!BOT_GAMES.has(tableGame)) return 0
    const humans = table.players.filter((player) => player.bot !== true).length
    const maxPlayers = gameMaxPlayers()
    const maxBots = Math.max(0, maxPlayers - humans)
    const recommended = RECOMMENDED_PLAYERS[tableGame]
      ?? GAME_MIN_PLAYERS[tableGame]
      ?? tableEngine.minPlayers
    const desired = config.autoFillBots
      ? recommended
      : humans + (config.botCount > 0 ? config.botCount : 0)
    return Math.min(Math.max(0, desired - humans), maxBots)
  }

  /** Grow/shrink bot seats to targetBotCount(); only between rounds (7.8). */
  function rebalanceBots() {
    if (tableEngine === undefined || table === undefined) return
    if (table.phase !== 'idle' && table.phase !== 'result') return
    const target = targetBotCount()
    const bots = table.players.filter((player) => player.bot === true)
    if (bots.length > target) {
      // Drop the last bots first so the stable bot-1 seat survives.
      for (const bot of bots.slice(target).reverse()) tableEngine.removePlayer(table, bot.node)
      return
    }
    if (bots.length >= target) return
    const used = new Set(table.players.map((player) => player.node))
    for (const seat of BOT_SEATS) {
      if (table.players.filter((player) => player.bot === true).length >= target) break
      if (used.has(seat.node)) continue
      const result = tableEngine.addPlayer(table, { node: seat.node, nick: seat.nick, bot: true })
      if (result.ok === true) used.add(seat.node)
    }
  }

  /** Node id of the last seated bot (humans take its seat first, PROTOCOL.md 7.8). */
  function lastBotNode() {
    if (table === undefined || tableEngine === undefined) return undefined
    for (let index = table.players.length - 1; index >= 0; index -= 1) {
      const player = table.players[index]
      if (player.bot === true) return player.node
    }
    return undefined
  }

  /**
   * If it is a bot's turn, play it after 600–1000 ms. Only one timer may exist;
   * the table generation token makes stale timers no-ops after close/reopen.
   */
  function scheduleBotTurn() {
    if (disposed || botTimer !== undefined) return
    if (!hostOpen || table === undefined || tableEngine === undefined) return
    if (!['playing', 'bidding', 'preflop', 'flop', 'turn', 'river'].includes(table.phase)) return
    const node = table.turn
    if (typeof node !== 'string' || node === '') return
    const player = table.players.find((entry) => entry.node === node)
    if (player === undefined || player.bot !== true) return
    const token = botToken
    const wait = BOT_DELAY_MIN + Math.floor(Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN + 1))
    botTimer = setTimeout(() => {
      botTimer = undefined
      if (disposed || token !== botToken || !hostOpen) return
      if (table === undefined || tableEngine === undefined) return
      if (table.turn !== node) {
        scheduleBotTurn()
        return
      }
      let action = null
      try {
        action = tableEngine.botAction(table, node)
      } catch (error) {
        lastError = 'bot: ' + String(error?.message ?? error)
        return
      }
      if (action === null || action === undefined) {
        // Safety net: a bot turn must never stall the table.
        action = tableEngine.onTimeout(table, node)
      }
      if (action === null || action === undefined) return
      const result = tableEngine.applyAction(table, node, action)
      if (result.ok !== true) {
        lastError = 'bot: ' + String(result.error)
        return
      }
      updateScores()
      pushState()
    }, wait)
    botTimer.unref?.()
  }

  /** Send one reject datagram back to a refused joiner. */
  function sendReject(rinfo, to, reason) {
    const ip = typeof rinfo?.address === 'string' ? rinfo.address : ''
    if (!isIpv4(ip)) return
    const port = clampInt(rinfo?.port, 0, 0, 65535)
    if (port === 0) return
    sendJson({
      v: PROTOCOL,
      t: 'reject',
      room: config.room,
      to,
      reason,
      sentAt: Date.now(),
    }, ip, port)
  }

  /** Remove one seated player (left / timed out) and advance the round. */
  function removeSeat(node) {
    const seat = seats.get(node)
    if (seat === undefined) return
    seats.delete(node)
    if (node === config.nodeId) return
    if (table !== undefined) {
      if (tableEngine !== undefined) {
        // The game engine owns the in-round leave rules.
        const player = table.players.find((entry) => entry.node === node)
        const nickname = text(player?.nick, 24) ?? '玩家'
        tableEngine.removePlayer(table, node)
        pushLog(nickname + ' 离开牌桌')
        if (table.players.length === 0) {
          table.phase = 'idle'
          table.turn = null
          table.lastPlay = null
          table.lastPlayer = null
          table.mustPlay = false
        }
      } else {
        if (table.phase === 'playing') {
          // Standing the player out lets engine.advance() move the turn on.
          applyAction(table, node, 'stand')
        }
        const index = table.players.findIndex((player) => player.node === node)
        if (index >= 0) {
          const nickname = text(table.players[index].nick, 24) ?? '玩家'
          table.players.splice(index, 1)
          pushLog(nickname + ' 离开牌桌')
        }
        if (table.players.length === 0) {
          table.phase = 'idle'
          table.turn = null
          table.dealer = { cards: [], hidden: true }
          table.deck = []
          pushLog('所有玩家已离开，牌桌回到空闲')
        }
      }
    }
    // A human seat disappeared: re-fill bots per the configured count.
    rebalanceBots()
    updateScores()
    announce()
    pushState()
  }

  /** Remove one spectator (left / timed out) and refresh the advert. */
  function removeWatcher(node) {
    const watcher = watchers.get(node)
    if (watcher === undefined) return
    watchers.delete(node)
    if (table !== undefined) {
      const nickname = text(watcher.nick, 24) ?? '观众'
      pushLog(nickname + ' 结束观战')
    }
    announce()
    pushState()
  }

  /** Open the local table (idempotent). */
  function openTable() {
    if (hostOpen) return
    clearGuest()
    hostOpen = true
    // A new table starts a new bot generation: stale timers become no-ops.
    cancelBotTimer()
    botToken += 1
    tableGame = GAMES.has(config.game) ? config.game : DEFAULTS.game
    tableEngine = GAME_ENGINES[tableGame]
    table = tableEngine !== undefined
      ? tableEngine.createTable([{ node: config.nodeId, nick: config.nick }], { mode: tableGame })
      : newTable([{ node: config.nodeId, nick: config.nick }])
    scores = {}
    scoredRound = 0
    acks = []
    ackAt.clear()
    seats = new Map()
    watchers = new Map()
    turnStartedAt = 0
    currentTurnNode = undefined
    seats.set(config.nodeId, {
      node: config.nodeId,
      nick: config.nick,
      ip: localIpv4(),
      port: boundPort || config.port,
      lastSeen: Date.now(),
    })
    // Human-first seating: an engine table opens already filled with bots.
    rebalanceBots()
    pushLog('牌桌已创建，等待其他玩家加入')
    announce()
  }

  /** Tell every seated player and spectator that this table is closing. */
  function notifyClosed() {
    if (socket === undefined || boundPort === 0) return
    if (seats.size === 0 && watchers.size === 0) return
    const payload = {
      v: PROTOCOL,
      t: 'closed',
      room: config.room,
      host: config.nodeId,
      reason: 'closed',
      sentAt: Date.now(),
    }
    for (const seat of seats.values()) {
      if (seat.node === config.nodeId) continue
      sendJson(payload, seat.ip, seat.port)
    }
    for (const watcher of watchers.values()) sendJson(payload, watcher.ip, watcher.port)
  }

  /** Clear the host table without broadcasting a new hello (config transitions). */
  function closeTableSilently() {
    // PROTOCOL.md 2.5b: guests hear about it before the seats disappear.
    notifyClosed()
    cancelBotTimer()
    botToken += 1
    hostOpen = false
    seats = new Map()
    watchers = new Map()
    table = undefined
    tableEngine = undefined
    turnStartedAt = 0
    currentTurnNode = undefined
  }

  /** Close the local table and tell the LAN it is no longer open. */
  function closeTable() {
    if (!hostOpen) return
    closeTableSilently()
    announce()
  }

  /** Cancel deferred "leave" retransmissions (a fresh join supersedes them). */
  function cancelLeaveTimers() {
    for (const timer of leaveTimers) clearTimeout(timer)
    leaveTimers.clear()
  }

  /** Forget the guest role and any in-flight guest traffic. */
  function clearGuest() {
    cancelLeaveTimers()
    joinedHost = undefined
    remote = undefined
    pendingJoin = undefined
    pendingActions.clear()
    rejoinTarget = undefined
    reconnecting = false
    reconnectAttempts = 0
    reconnectLastAt = 0
    reconnectGaveUp = false
    closeGuestSocket()
  }

  /** Milliseconds since the last state arrived from the host (guest role). */
  function guestStaleMs() {
    if (remote === undefined || remote.lastStateAt === 0) return 0
    return Math.max(0, Date.now() - remote.lastStateAt)
  }

  /** The table served by view() (host table, guest mirror, or null). */
  function localTable() {
    if (hostOpen && table !== undefined) {
      syncTurnClock()
      updateScores()
      return snapshotFor(config.nodeId, 'host', 0)
    }
    if (remote !== undefined && remote.table !== null && typeof remote.table === 'object') {
      const role = remote.role === 'spectator' ? 'spectator' : 'player'
      if (TRICK_GAMES.has(remote.table.game)) {
        const view = trickGuestView(remote.table, role, guestStaleMs(), remote.table.game)
        if (view !== null && view.hostNode === '') view.hostNode = remote.host ?? joinedHost?.node ?? ''
        return view
      }
      // Guests display the turn budget snapshot carried by the last state.
      const snapshot = typeof remote.table.turnRemainingMs === 'number'
        ? remote.table.turnRemainingMs
        : null
      return tableSnapshot(
        remote.table,
        role,
        remote.host ?? joinedHost?.node ?? '',
        role === 'player' ? config.nodeId : '',
        remote.scores,
        guestStaleMs(),
        snapshot,
      )
    }
    return null
  }

  /* ------------------------------------------------------------------ *
   * UDP receive paths
   * ------------------------------------------------------------------ */

  /** Handle one hello (discovery) datagram. */
  function onHello(message, rinfo, now) {
    const node = typeof message.node === 'string' && NODE_RE.test(message.node) ? message.node : undefined
    if (node === undefined) return
    if (node === config.nodeId) return
    const ip = typeof rinfo?.address === 'string' && rinfo.address !== '' ? rinfo.address : '0.0.0.0'
    const port = clampInt(message.port, config.port, 1, 65535)
    const advert = sanitizeAdvert(message.table)
    const existing = peers.get(node)
    if (existing === undefined && peers.size >= MAX_PEERS) {
      stats.dropped += 1
      return
    }
    const nick = text(message.nick, 24) ?? text(existing?.nick, 24) ?? '玩家'
    peers.set(node, { node, nick, ip, port, lastSeen: now, table: advert })
    if (seats.has(node)) {
      const seat = seats.get(node)
      seat.lastSeen = now
    }
    if (watchers.has(node)) {
      const watcher = watchers.get(node)
      watcher.lastSeen = now
    }
    // A joined host keeps its identity; hello only refreshes the address.
    if (joinedHost !== undefined && joinedHost.node === node) {
      joinedHost.ip = ip
      joinedHost.port = port
      if (rejoinTarget !== undefined) {
        rejoinTarget.ip = ip
        rejoinTarget.port = port
      }
    }
  }

  /** Handle one join request (guest -> host; role player or spectator). */
  function onJoin(message, rinfo, now) {
    const to = typeof message.to === 'string' ? message.to : ''
    // An empty `to` means "the host this unicast reached" (manual IP join).
    if (to !== '' && to !== config.nodeId) return
    const from = typeof message.from === 'string' && NODE_RE.test(message.from) ? message.from : undefined
    if (from === undefined || from === config.nodeId) return
    if (!hostOpen || table === undefined) {
      sendReject(rinfo, from, 'closed')
      return
    }
    const ip = typeof rinfo?.address === 'string' && isIpv4(rinfo.address) ? rinfo.address : ''
    if (ip === '') return
    const port = clampInt(rinfo?.port, 0, 0, 65535)
    if (port === 0) return

    // The room password guards players and spectators alike.
    if (!passwordMatches(config, message.pw)) {
      sendReject(rinfo, from, 'password')
      return
    }
    const role = message.role === 'spectator' ? 'spectator' : 'player'
    const nick = text(message.nick, 24) ?? text(peers.get(from)?.nick, 24) ?? '玩家'

    if (role === 'spectator') {
      // Watching must be allowed when the join arrives — checked before the
      // idempotent resync so a "left, then rejoined while watching was turned
      // off" attempt is rejected instead of receiving a stale state.
      if (!config.spectatorEnabled) {
        sendReject(rinfo, from, 'watch-closed')
        return
      }
      const watching = watchers.get(from)
      if (watching !== undefined) {
        // Duplicate join: idempotent, resend state so the spectator settles.
        watching.lastSeen = now
        watching.ip = ip
        watching.port = port
        sendStateTo(watching, 'spectator')
        return
      }
      if (seats.has(from)) {
        // A seated player cannot silently become a spectator; resync instead.
        sendStateTo(seats.get(from), 'player')
        return
      }
      if (watchers.size >= MAX_SPECTATORS) {
        sendReject(rinfo, from, 'watch-full')
        return
      }
      watchers.set(from, { node: from, nick, ip, port, lastSeen: now })
      pushLog(nick + ' 开始观战')
      announce()
      pushState()
      return
    }

    const seated = seats.get(from)
    if (seated !== undefined) {
      // Duplicate join: idempotent, just resend state so the guest settles.
      seated.lastSeen = now
      seated.ip = ip
      seated.port = port
      sendStateTo(seated, 'player')
      return
    }
    if (tableEngine !== undefined) {
      // Engine-backed tables only fill seats between rounds; a human who joins
      // while a bot is seated takes that bot's seat (humans always win).
      if (table.phase !== 'idle' && table.phase !== 'result') {
        sendReject(rinfo, from, 'full')
        return
      }
      if (table.players.length >= gameMaxPlayers()) {
        const botNode = lastBotNode()
        if (botNode === undefined) {
          sendReject(rinfo, from, 'full')
          return
        }
        tableEngine.removePlayer(table, botNode)
      }
      // A spectator may take a seat: it is a role change, not a second identity.
      if (watchers.has(from)) watchers.delete(from)
      seats.set(from, { node: from, nick, ip, port, lastSeen: now })
      tableEngine.addPlayer(table, { node: from, nick })
      // Keep the configured bot count exact after a human took a seat.
      rebalanceBots()
      pushLog(nick + ' 入座')
      announce()
      pushState()
      return
    }
    if (table.players.length >= gameMaxPlayers()) {
      sendReject(rinfo, from, 'full')
      return
    }
    // A spectator may take a seat: it is a role change, not a second identity.
    if (watchers.has(from)) watchers.delete(from)
    seats.set(from, { node: from, nick, ip, port, lastSeen: now })
    const midRound = table.phase === 'playing'
    table.players.push({
      node: from,
      nick,
      cards: [],
      status: midRound ? 'stand' : 'playing',
      result: null,
    })
    ensureScore(from)
    pushLog(nick + (midRound ? ' 入座（本局旁观）' : ' 入座'))
    announce()
    pushState()
  }

  /** Handle one action from a seated guest. */
  function onRemoteAction(message, rinfo, now) {
    if (!hostOpen || table === undefined) return
    const to = typeof message.to === 'string' ? message.to : ''
    if (to !== '' && to !== config.nodeId) return
    const from = typeof message.from === 'string' && NODE_RE.test(message.from) ? message.from : undefined
    if (from === undefined || from === config.nodeId) return
    const seat = seats.get(from)
    if (seat === undefined) return
    // Any traffic from a seated guest also proves the process is alive.
    seat.lastSeen = now
    if (typeof rinfo?.address === 'string' && isIpv4(rinfo.address)) seat.ip = rinfo.address
    if (Number.isInteger(rinfo?.port) && rinfo.port >= 1 && rinfo.port <= 65535) seat.port = rinfo.port

    const aid = typeof message.aid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(message.aid)
      ? message.aid
      : undefined
    if (aid === undefined) return
    const action = message.action
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return
    const type = typeof action.type === 'string' ? action.type.trim() : ''
    // Host-control verbs are never accepted over UDP from a guest.
    if (type === '' || CONTROL_ACTIONS.has(type)) return
    const gameAction = sanitizeGameAction(action, tableGame)
    if (gameAction === undefined) return

    const key = from + '\n' + aid
    const seen = ackAt.get(key)
    if (seen !== undefined && now - seen <= ACK_WINDOW_MS) {
      // Duplicate (client retransmission): idempotent, reply with state anyway.
      pushState()
      return
    }
    const result = applyGameAction(from, gameAction)
    if (result.ok === true) {
      ackAt.set(key, now)
      acks.push(aid)
      if (acks.length > ACK_KEEP) acks.splice(0, acks.length - ACK_KEEP)
      updateScores()
    }
    pushState()
  }

  /** Handle one state datagram (host -> guest). */
  function onRemoteState(message, now) {
    if (joinedHost === undefined) return
    const hostNode = typeof message.host === 'string' && NODE_RE.test(message.host)
      ? message.host
      : undefined
    if (hostNode === undefined) return
    if (joinedHost.node !== '' && joinedHost.node !== hostNode) return
    const rawTable = message.table
    if (rawTable === null || typeof rawTable !== 'object' || !Array.isArray(rawTable.players)) return

    joinedHost.node = hostNode
    pendingJoin = undefined
    // Any state means we are (re)connected: reset the reconnect state machine.
    reconnecting = false
    reconnectAttempts = 0
    reconnectLastAt = 0
    reconnectGaveUp = false
    // A state proves the join succeeded: drop the previous join/reconnect reason.
    if (typeof lastError === 'string'
      && (lastError.startsWith('join-') || lastError === 'reconnect-failed' || lastError === 'host-closed')) {
      lastError = null
    }
    if (Array.isArray(message.acks)) {
      for (const aid of message.acks) {
        if (typeof aid === 'string') pendingActions.delete(aid)
      }
    }
    remote = {
      host: hostNode,
      table: rawTable,
      // The host labels spectator state explicitly; anything else is a seat.
      role: rawTable.role === 'spectator' ? 'spectator' : 'player',
      scores: message.scores !== null && typeof message.scores === 'object' ? message.scores : {},
      seq: clampInt(message.seq, 0, 0, Number.MAX_SAFE_INTEGER),
      lastStateAt: now,
    }
    // Keep the remembered target aligned with what the host told us.
    if (rejoinTarget !== undefined) {
      rejoinTarget.node = hostNode
      rejoinTarget.ip = joinedHost.ip
      rejoinTarget.port = joinedHost.port
      rejoinTarget.role = remote.role
    }
  }

  /** Handle one reject datagram (host -> refused guest; also reconnect rejects). */
  function onRemoteReject(message) {
    if (pendingJoin === undefined && joinedHost === undefined && rejoinTarget === undefined) return
    if (typeof message.to === 'string' && message.to !== '' && message.to !== config.nodeId) return
    const reason = typeof message.reason === 'string' ? message.reason : 'closed'
    pendingJoin = undefined
    joinedHost = undefined
    remote = undefined
    rejoinTarget = undefined
    reconnecting = false
    reconnectAttempts = 0
    reconnectLastAt = 0
    reconnectGaveUp = false
    lastError = REJECT_ERRORS[reason] ?? REJECT_ERRORS.closed
  }

  /** Handle one closed datagram (host -> guest, PROTOCOL.md 2.5b). */
  function onHostClosed(message) {
    if (hostOpen) return
    if (joinedHost === undefined && rejoinTarget === undefined) return
    if (typeof message.host === 'string' && message.host !== '') {
      const expected = joinedHost?.node ?? rejoinTarget?.node ?? ''
      if (expected !== '' && message.host !== expected) return
    }
    clearGuest()
    lastError = 'host-closed'
  }

  /** Handle one leave datagram (guest -> host, PROTOCOL.md 2.2b). */
  function onLeave(message) {
    if (!hostOpen || table === undefined) return
    const to = typeof message.to === 'string' ? message.to : ''
    if (to !== '' && to !== config.nodeId) return
    const from = typeof message.from === 'string' && NODE_RE.test(message.from)
      ? message.from
      : undefined
    if (from === undefined || from === config.nodeId) return
    if (seats.has(from)) {
      removeSeat(from)
      pushState()
      return
    }
    if (watchers.has(from)) removeWatcher(from)
  }

  /** Handle one incoming datagram (size / version / room / rate gates first). */
  function onDatagram(buffer, rinfo) {
    if (disposed) return
    if (!Buffer.isBuffer(buffer)) return
    if (buffer.byteLength > MAX_DATAGRAM) {
      stats.dropped += 1
      return
    }
    const now = Date.now()
    const fromIp = typeof rinfo?.address === 'string' ? rinfo.address : ''
    if (!allowPacket(fromIp, now)) return
    let message
    try {
      message = JSON.parse(buffer.toString('utf8'))
    } catch {
      stats.dropped += 1
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      stats.dropped += 1
      return
    }
    if (message.v !== PROTOCOL) {
      stats.dropped += 1
      return
    }
    if (message.room !== config.room) {
      stats.dropped += 1
      return
    }
    stats.received += 1
    try {
      if (message.t === 'hello') onHello(message, rinfo, now)
      else if (message.t === 'join') onJoin(message, rinfo, now)
      else if (message.t === 'action') onRemoteAction(message, rinfo, now)
      else if (message.t === 'state') onRemoteState(message, now)
      else if (message.t === 'reject') onRemoteReject(message)
      else if (message.t === 'leave') onLeave(message)
      else if (message.t === 'closed') onHostClosed(message)
    } catch (error) {
      lastError = 'udp: ' + String(error?.message ?? error)
    }
  }

  /* ------------------------------------------------------------------ *
   * Timers: announce, heartbeat, sweep, retransmission
   * ------------------------------------------------------------------ */

  /** Auto-play the current player when the turn budget expires (PROTOCOL.md §1/§7). */
  function applyTurnTimeout(now) {
    if (!isTurnActive()) return
    if (!Number.isInteger(config.turnTimeout) || config.turnTimeout <= 0) return
    syncTurnClock()
    if (turnStartedAt === 0) return
    if (now - turnStartedAt < config.turnTimeout * 1000) return
    const node = table.turn
    const player = table.players.find((entry) => entry.node === node)
    // Bot turns are driven by scheduleBotTurn; they never consume human timeout.
    if (player !== undefined && player.bot === true) return
    const nickname = text(player?.nick, 24) ?? '玩家'
    let result
    if (tableEngine !== undefined) {
      const action = tableEngine.onTimeout(table, node)
      if (action === null || action === undefined) {
        syncTurnClock()
        return
      }
      const verb = {
        bid: '不叫',
        play: '出牌',
        pass: '不要',
        fold: '弃牌',
        check: '过牌',
        call: '跟注',
        raise: '加注',
        compare: '比牌',
        look: '看牌',
        'tribute-return': '还贡',
        discard: '打出',
        tsumo: '自摸',
        nuki: '拔北',
        pass: '过',
        ron: '荣和',
        pon: '碰',
        kan: '杠',
        chi: '吃',
        ankan: '暗杠',
        kakan: '加杠',
        riichi: '立直',
      }[action.type] ?? '行动'
      pushLog(nickname + ' 超时，自动' + verb)
      result = tableEngine.applyAction(table, node, action)
    } else {
      pushLog(nickname + ' 超时，自动停牌')
      result = applyAction(table, node, 'stand')
    }
    if (result.ok !== true) {
      // The turn moved for another reason between checks; just resync.
      syncTurnClock()
      return
    }
    updateScores()
    pushState()
  }

  /** Periodically forget silent peers and seated players that stopped helloing. */
  function sweep() {
    if (disposed) return
    const now = Date.now()
    for (const [node, peer] of peers) {
      if (now - peer.lastSeen > PEER_TTL_MS) peers.delete(node)
    }
    if (hostOpen && table !== undefined) {
      for (const [node, seat] of [...seats]) {
        if (node === config.nodeId) continue
        if (now - seat.lastSeen <= SEAT_TIMEOUT_MS) continue
        removeSeat(node)
      }
      for (const [node, watcher] of [...watchers]) {
        if (now - watcher.lastSeen <= SEAT_TIMEOUT_MS) continue
        removeWatcher(node)
      }
      applyTurnTimeout(now)
    }
    for (const [key, at] of ackAt) {
      if (now - at > ACK_WINDOW_MS) ackAt.delete(key)
    }
    if (ackAt.size > 512) ackAt.clear()
    for (const [ip, bucket] of packetWindows) {
      if (now - bucket.at > 60_000) packetWindows.delete(ip)
    }
    if (packetWindows.size > 512) packetWindows.clear()
  }

  /** Join datagram used by automatic reconnection (carries the remembered pw). */
  function sendReconnectJoin(now) {
    if (rejoinTarget === undefined) return
    sendGuestJson({
      v: PROTOCOL,
      t: 'join',
      room: config.room,
      to: rejoinTarget.node === '' ? '' : rejoinTarget.node,
      from: config.nodeId,
      nick: config.nick,
      pw: typeof rejoinTarget.pw === 'string' ? rejoinTarget.pw : '',
      role: rejoinTarget.role === 'spectator' ? 'spectator' : 'player',
      sentAt: now,
    }, rejoinTarget.ip, rejoinTarget.port)
  }

  /**
   * Guest auto-reconnect (PROTOCOL.md 2.5c): when state has been silent for
   * >5 s and we still remember the host, retry join up to 5 times (1 s apart).
   * A received state resets the machine; 5 failures stop it and expose
   * action {type:'rejoin'} as the manual escape hatch.
   */
  function tickReconnect(now) {
    if (disposed || !config.enabled) return
    if (reconnecting) {
      if (now - reconnectLastAt < RECONNECT_RETRY_MS) return
      if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        reconnecting = false
        reconnectGaveUp = true
        lastError = 'reconnect-failed'
        return
      }
      reconnectAttempts += 1
      reconnectLastAt = now
      sendReconnectJoin(now)
      return
    }
    if (reconnectGaveUp) return
    if (joinedHost === undefined || rejoinTarget === undefined || remote === undefined) return
    if (guestStaleMs() <= RECONNECT_STALE_MS) return
    reconnecting = true
    reconnectAttempts = 1
    reconnectLastAt = now
    sendReconnectJoin(now)
  }

  /** Build and send one join datagram (always carries pw + role). */
  function sendJoinOnce(join, now) {
    sendGuestJson({
      v: PROTOCOL,
      t: 'join',
      room: config.room,
      to: join.hostNode === '' ? '' : join.hostNode,
      from: config.nodeId,
      nick: config.nick,
      pw: typeof join.pw === 'string' ? join.pw : '',
      role: join.role === 'spectator' ? 'spectator' : 'player',
      sentAt: now,
    }, join.ip, join.port)
  }

  /** Guest-side reliable delivery: join (8 tries / 1 s) and actions (5 / 400 ms). */
  function tickRetries(now) {
    if (disposed) return
    if (pendingJoin !== undefined) {
      const join = pendingJoin
      if (join.sentAt !== 0 && now - join.sentAt < JOIN_RETRY_MS) {
        // Waiting for the next retry slot.
      } else if (join.attempts >= JOIN_MAX_ATTEMPTS) {
        pendingJoin = undefined
        joinedHost = undefined
        lastError = 'join-timeout'
      } else {
        join.attempts += 1
        join.sentAt = now
        sendJoinOnce(join, now)
      }
    }
    for (const [aid, entry] of pendingActions) {
      if (now - entry.sentAt < ACTION_RETRY_MS) continue
      if (entry.attempts >= ACTION_MAX_ATTEMPTS) {
        pendingActions.delete(aid)
        continue
      }
      entry.attempts += 1
      entry.sentAt = now
      sendGuestJson(entry.payload, entry.ip, entry.port)
    }
    tickReconnect(now)
  }

  /* ------------------------------------------------------------------ *
   * Local actions (HTTP + tests)
   * ------------------------------------------------------------------ */

  /** Host: one game action from its own seat (hit/stand, bid/play/pass). */
  function doHostAction(action) {
    if (!hostOpen || table === undefined) return { ok: false, error: 'not-host' }
    if (tableGame === 'blackjack') {
      const type = typeof action?.type === 'string' ? action.type : ''
      if (table.phase !== 'playing') return { ok: false, error: 'not-playing' }
      if (table.turn !== config.nodeId) return { ok: false, error: 'not-your-turn' }
      const result = applyAction(table, config.nodeId, type)
      if (result.ok !== true) {
        return { ok: false, error: typeof result.error === 'string' ? result.error : 'not-playing' }
      }
    } else {
      const gameAction = sanitizeGameAction(action, tableGame)
      if (gameAction === undefined) return { ok: false, error: 'bad-action' }
      const result = tableEngine.applyAction(table, config.nodeId, gameAction)
      if (result.ok !== true) {
        return { ok: false, error: typeof result.error === 'string' ? result.error : 'bad-action' }
      }
    }
    updateScores()
    pushState()
    return { ok: true }
  }

  /** Host: start the next round (both engines validate the player count). */
  function doStart() {
    if (!hostOpen || table === undefined) return { ok: false, error: 'not-host' }
    if (table.phase !== 'idle' && table.phase !== 'result') {
      return { ok: false, error: 'not-playing' }
    }
    rebalanceBots()
    const result = tableEngine !== undefined ? tableEngine.startRound(table) : startRound(table)
    if (result.ok !== true) {
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'no-players' }
    }
    updateScores()
    pushState()
    return { ok: true }
  }

  /** Guest: send one game action with retransmission + ack dedupe. */
  function doGuestAction(action) {
    if (socket === undefined || boundPort === 0) return { ok: false, error: 'udp-offline' }
    if (joinedHost === undefined) return { ok: false, error: 'table-closed' }
    if (remote === undefined || remote.table === null || typeof remote.table !== 'object') {
      return { ok: false, error: 'table-closed' }
    }
    // Spectators have no hand: they never send game actions.
    if (remote.role === 'spectator') return { ok: false, error: 'not-playing' }
    const remoteGame = remote.table.game
    const engineGame = TRICK_GAMES.has(remoteGame) ? remoteGame : undefined
    let gameAction
    if (engineGame !== undefined) {
      // Per-game actionable phases: zhajinhua bets during 'bidding', guandan
      // tribute/playing, texas betting streets, mahjong playing + call window.
      const activePhases = engineGame === 'doudizhu'
        ? ['bidding', 'playing']
        : (engineGame === 'zhajinhua'
          ? ['bidding']
          : (engineGame === 'texas'
            ? ['preflop', 'flop', 'turn', 'river']
            : (engineGame === 'guandan'
              ? ['tribute', 'playing']
              : ((engineGame === 'mahjong4' || engineGame === 'mahjong3')
                ? ['playing', 'calling']
                : ['playing']))))
      if (!activePhases.includes(remote.table.phase)) {
        return { ok: false, error: 'bad-phase' }
      }
      if (engineGame === 'mahjong4' || engineGame === 'mahjong3') {
        if (remote.table.phase === 'calling') {
          // Any pending player may respond, not only the first in seat order.
          const pendingList = Array.isArray(remote.table.pending) ? remote.table.pending : []
          if (!pendingList.some((entry) => entry.node === config.nodeId)) {
            return { ok: false, error: 'not-pending' }
          }
        } else if (remote.table.turn !== config.nodeId) {
          return { ok: false, error: 'not-your-turn' }
        }
      } else if (remote.table.turn !== config.nodeId) {
        return { ok: false, error: 'not-your-turn' }
      }
      gameAction = sanitizeGameAction(action, engineGame)
      if (gameAction === undefined) return { ok: false, error: 'bad-action' }
    } else {
      if (remote.table.phase !== 'playing') return { ok: false, error: 'not-playing' }
      if (remote.table.turn !== config.nodeId) return { ok: false, error: 'not-your-turn' }
      gameAction = { type: typeof action?.type === 'string' ? action.type : '' }
    }

    const now = Date.now()
    const aid = randomBytes(6).toString('hex')
    const payload = {
      v: PROTOCOL,
      t: 'action',
      room: config.room,
      to: joinedHost.node,
      from: config.nodeId,
      aid,
      action: gameAction,
      sentAt: now,
    }
    while (pendingActions.size >= MAX_PENDING_ACTIONS) {
      const oldest = pendingActions.keys().next().value
      pendingActions.delete(oldest)
    }
    pendingActions.set(aid, {
      payload,
      ip: joinedHost.ip,
      port: joinedHost.port,
      attempts: 1,
      sentAt: now,
    })
    sendGuestJson(payload, joinedHost.ip, joinedHost.port)
    return { ok: true }
  }

  /** Join a table by discovered node, or by manual IP:port. */
  async function doJoin(body) {
    if (socket === undefined || boundPort === 0 || !config.enabled) {
      return { ok: false, error: 'udp-offline' }
    }
    // A previous leave may still have staggered retransmissions queued; they
    // must not hit the host after we take a new seat (it would remove us).
    cancelLeaveTimers()
    if (hostOpen) return { ok: false, error: 'already-seated' }
    if (joinedHost !== undefined) {
      // A manual join overrides a stale / reconnect-failed session (2.5c: a
      // manual join clears the remembered host).
      const overridable = reconnecting || lastError === 'reconnect-failed' || guestStaleMs() > 4000
      if (!overridable) return { ok: false, error: 'already-seated' }
      clearGuest()
    }

    const requested = typeof body.hostNode === 'string' ? body.hostNode.trim() : ''
    let ip
    let port
    let hostNode = ''
    if (requested !== '') {
      if (!NODE_RE.test(requested)) return { ok: false, error: 'unknown-peer' }
      const peer = peers.get(requested)
      if (peer === undefined) return { ok: false, error: 'unknown-peer' }
      if (peer.table === null || peer.table.open !== true) return { ok: false, error: 'table-closed' }
      ip = peer.ip
      port = peer.port
      hostNode = peer.node
    } else {
      const rawIp = typeof body.hostIp === 'string' ? body.hostIp.trim() : ''
      const rawPort = Number(body.hostPort)
      if (!isIpv4(rawIp)) return { ok: false, error: 'unknown-peer' }
      if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
        return { ok: false, error: 'unknown-peer' }
      }
      ip = rawIp
      port = rawPort
    }

    // Join/action/state unicast travels over the guest transport socket, so two
    // DSH instances on ONE machine that share the config port stay unambiguous.
    await openGuestSocket()
    // view.lastError is the join feedback channel: a fresh attempt supersedes
    // the previous join failure/reconnect reason so pollers do not read stale text.
    if (typeof lastError === 'string'
      && (lastError.startsWith('join-') || lastError === 'reconnect-failed' || lastError === 'host-closed')) {
      lastError = null
    }
    // The host decides whether the password/role is acceptable; pw and role are
    // carried on every retransmission and reported back through view.lastError.
    const role = body.role === 'spectator' ? 'spectator' : 'player'
    const pw = typeof body.pw === 'string' ? body.pw.slice(0, 64) : ''
    joinedHost = { node: hostNode, ip, port }
    remote = undefined
    pendingJoin = { ip, port, hostNode, pw, role, attempts: 0, sentAt: 0 }
    // Remember the target (in memory only) so a dropped host can be rejoined.
    rejoinTarget = { node: hostNode, ip, port, pw, role }
    reconnecting = false
    reconnectAttempts = 0
    reconnectLastAt = 0
    reconnectGaveUp = false
    tickRetries(Date.now())
    return { ok: true }
  }

  /** Leave the table (host closes, guest tells the host then forgets the seat). */
  function doLeave() {
    if (hostOpen) {
      // Host leaving == closing the table; no leave datagram is sent.
      closeTable()
      return { ok: true }
    }
    if (joinedHost !== undefined || remote !== undefined) {
      const host = joinedHost === undefined
        ? undefined
        : { node: joinedHost.node, ip: joinedHost.ip, port: joinedHost.port }
      if (host !== undefined) {
        // PROTOCOL.md 2.2b: send leave three times (~100 ms apart) so a lost
        // datagram cannot leave us seated until the 12 s liveness sweep.
        const payload = {
          v: PROTOCOL,
          t: 'leave',
          room: config.room,
          to: host.node,
          from: config.nodeId,
          sentAt: Date.now(),
        }
        // The first send happens while the guest transport socket is still up.
        sendGuestJson(payload, host.ip, host.port)
        clearGuest()
        for (const delay of [100, 200]) {
          const timer = setTimeout(() => {
            leaveTimers.delete(timer)
            if (disposed || !config.enabled) return
            sendGuestJson({ ...payload, sentAt: Date.now() }, host.ip, host.port)
          }, delay)
          timer.unref?.()
          leaveTimers.add(timer)
        }
      } else {
        clearGuest()
      }
      // Leaving clears any reconnect/join failure text from the lobby status line.
      if (typeof lastError === 'string'
        && (lastError.startsWith('join-') || lastError === 'reconnect-failed' || lastError === 'host-closed')) {
        lastError = null
      }
      return { ok: true }
    }
    return { ok: true }
  }

  /** Manually retry the last host after a failed auto-reconnect (PROTOCOL.md 2.5c). */
  function doRejoin() {
    if (socket === undefined || boundPort === 0 || !config.enabled) {
      return { ok: false, error: 'udp-offline' }
    }
    if (rejoinTarget === undefined) return { ok: false, error: 'no-target' }
    cancelLeaveTimers()
    const now = Date.now()
    joinedHost = { node: rejoinTarget.node, ip: rejoinTarget.ip, port: rejoinTarget.port }
    reconnecting = true
    reconnectAttempts = 1
    reconnectLastAt = now
    reconnectGaveUp = false
    if (typeof lastError === 'string'
      && (lastError.startsWith('join-') || lastError === 'reconnect-failed' || lastError === 'host-closed')) {
      lastError = null
    }
    sendReconnectJoin(now)
    return { ok: true }
  }

  /* ------------------------------------------------------------------ *
   * Public API: view / setConfig / action / routes / start / dispose
   * ------------------------------------------------------------------ */

  /** The view served to the browser half (PROTOCOL.md 3.1). */
  function view() {
    return {
      ok: true,
      version: PROTOCOL,
      enabled: config.enabled,
      config: {
        enabled: config.enabled,
        room: config.room,
        port: config.port,
        game: config.game,
        overlayOpacity: config.overlayOpacity,
        passwordEnabled: config.passwordEnabled,
        password: config.password,
        spectatorEnabled: config.spectatorEnabled,
        overlaySize: config.overlaySize,
        overlayX: config.overlayX,
        overlayY: config.overlayY,
        autoFade: config.autoFade,
        turnTimeout: config.turnTimeout,
        botCount: config.botCount,
        fillBots: config.botCount > 0,
        autoFillBots: config.autoFillBots,
        nick: config.nick,
        nodeId: config.nodeId,
      },
      udpReady: socket !== undefined && boundPort > 0,
      boundPort,
      lastError: lastError ?? null,
      reconnecting: reconnecting === true,
      host: hostOpen
        ? { node: config.nodeId, ip: localIpv4(), port: boundPort || config.port, open: true }
        : null,
      peers: [...peers.values()]
        .filter((peer) => peer.node !== config.nodeId)
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .map((peer) => ({
          node: peer.node,
          nick: peer.nick,
          ip: peer.ip,
          port: peer.port,
          lastSeen: peer.lastSeen,
          table: peer.table,
        })),
      table: localTable(),
      stats: {
        sent: stats.sent,
        received: stats.received,
        dropped: stats.dropped,
        startedAt: stats.startedAt,
      },
    }
  }

  /** Keep the local seat's nickname in sync after a nick change. */
  function updateSelfNick() {
    if (!hostOpen || table === undefined) return
    for (const player of table.players) {
      if (player.node === config.nodeId) player.nick = config.nick
    }
    const seat = seats.get(config.nodeId)
    if (seat !== undefined) seat.nick = config.nick
  }

  /** Apply a config patch from the settings page (PROTOCOL.md 3.2). */
  async function setConfig(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'invalid-body' }
    }
    const next = { ...config }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (Object.prototype.hasOwnProperty.call(patch, 'room')) {
      const room = text(patch.room, 32)
      if (room === undefined) return { ok: false, error: 'invalid-room' }
      next.room = room
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'port')) {
      if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535) {
        return { ok: false, error: 'invalid-port' }
      }
      next.port = patch.port
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'game')) {
      if (typeof patch.game !== 'string' || !GAMES.has(patch.game)) {
        return { ok: false, error: 'invalid-game' }
      }
      next.game = patch.game
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'nick')) {
      const nick = text(patch.nick, 24)
      if (nick === undefined) return { ok: false, error: 'invalid-nick' }
      next.nick = nick
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'overlayOpacity')) {
      if (!Number.isFinite(Number(patch.overlayOpacity))) {
        return { ok: false, error: 'invalid-opacity' }
      }
      next.overlayOpacity = clampOpacity(patch.overlayOpacity)
    }
    if (typeof patch.passwordEnabled === 'boolean') next.passwordEnabled = patch.passwordEnabled
    if (typeof patch.spectatorEnabled === 'boolean') next.spectatorEnabled = patch.spectatorEnabled
    if (Object.prototype.hasOwnProperty.call(patch, 'password')) {
      if (patch.password !== null && typeof patch.password !== 'string') {
        return { ok: false, error: 'invalid-password' }
      }
      next.password = text(patch.password, PASSWORD_MAX) ?? ''
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'overlaySize')) {
      if (!OVERLAY_SIZES.has(patch.overlaySize)) {
        return { ok: false, error: 'invalid-overlay-size' }
      }
      next.overlaySize = patch.overlaySize
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'overlayX')) {
      const position = clampOverlayPosition(patch.overlayX)
      if (position === undefined) return { ok: false, error: 'invalid-overlay-position' }
      next.overlayX = position
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'overlayY')) {
      const position = clampOverlayPosition(patch.overlayY)
      if (position === undefined) return { ok: false, error: 'invalid-overlay-position' }
      next.overlayY = position
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'autoFade')) {
      if (typeof patch.autoFade !== 'boolean') return { ok: false, error: 'invalid-autofade' }
      next.autoFade = patch.autoFade
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'turnTimeout')) {
      if (!Number.isInteger(patch.turnTimeout)
        || patch.turnTimeout < 0
        || patch.turnTimeout > TURN_TIMEOUT_MAX) {
        return { ok: false, error: 'invalid-turn-timeout' }
      }
      next.turnTimeout = patch.turnTimeout
    }
    const hasBotCount = Object.prototype.hasOwnProperty.call(patch, 'botCount')
    if (hasBotCount) {
      if (!Number.isInteger(patch.botCount) || patch.botCount < 0 || patch.botCount > 5) {
        return { ok: false, error: 'invalid-botcount' }
      }
      next.botCount = patch.botCount
    } else if (Object.prototype.hasOwnProperty.call(patch, 'fillBots')) {
      // Legacy alias: fillBots true means up to two bots.
      if (typeof patch.fillBots !== 'boolean') return { ok: false, error: 'invalid-fillbots' }
      next.botCount = patch.fillBots ? 2 : 0
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'autoFillBots')) {
      if (typeof patch.autoFillBots !== 'boolean') {
        return { ok: false, error: 'invalid-autofillbots' }
      }
      next.autoFillBots = patch.autoFillBots
    }
    // Turning the room password on without a stored/supplied password is invalid.
    if (next.passwordEnabled && next.password === '') {
      return { ok: false, error: 'invalid-password' }
    }

    const roomChanged = next.room !== config.room
    const portChanged = next.port !== config.port
    const wasEnabled = config.enabled
    const willDisable = wasEnabled && next.enabled === false
    const botCountChanged = next.botCount !== config.botCount
      || next.autoFillBots !== config.autoFillBots

    // PROTOCOL.md 2.5b: close the existing table (notifying its guests) while the
    // OLD room/port is still live, so the "closed" datagram can reach them.
    if (roomChanged || portChanged || willDisable) {
      closeTableSilently()
      // Let the "closed" datagrams leave before any socket close/rebind below.
      await flushSends()
      clearGuest()
    }
    config = next
    if (roomChanged || portChanged) peers = new Map()
    if (willDisable) closeSocket()
    await persistConfig()
    updateSelfNick()
    if (config.enabled && (!wasEnabled || portChanged)) {
      await openSocket()
    }
    // A botCount / autoFillBots change re-balances the seats when the table is
    // between rounds (PROTOCOL.md 7.8); mid-round changes apply on the next start.
    if (botCountChanged && hostOpen && tableEngine !== undefined && table !== undefined
      && (table.phase === 'idle' || table.phase === 'result')) {
      rebalanceBots()
    }
    announce()
    pushState()
    return { ok: true, config: { ...config } }
  }

  /** Run one local action from the browser half / tests (PROTOCOL.md 3.3/7.2). */
  async function action(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'invalid-body' }
    }
    const type = typeof body.type === 'string' ? body.type.trim() : ''
    if (type === 'open') {
      if (body.game !== undefined) {
        if (typeof body.game !== 'string' || !GAMES.has(body.game)) {
          return { ok: false, error: 'invalid-game' }
        }
        // The chosen game is remembered for the next table too (7.1).
        if (config.game !== body.game) {
          config.game = body.game
          await persistConfig()
        }
      }
      openTable()
      return { ok: true }
    }
    if (type === 'close') {
      if (!hostOpen) return { ok: false, error: 'not-host' }
      closeTable()
      return { ok: true }
    }
    if (type === 'join') return doJoin(body)
    if (type === 'rejoin') return doRejoin()
    if (type === 'leave') return doLeave()
    if (type === 'start') return doStart()
    if (type === '') return { ok: false, error: 'bad-action' }
    // Every other verb belongs to the current game engine (7.2 pass-through):
    // blackjack hit/stand, doudizhu bid/play/pass. The engine validates it.
    if (hostOpen) return doHostAction(body)
    if (joinedHost !== undefined) return doGuestAction(body)
    return { ok: false, error: 'table-closed' }
  }

  /** The route family registered on ctx.webServer. */
  function routes() {
    const guard = (req, res) => {
      if (fromLoopback(req)) return true
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return false
    }
    const post = (path, run) => ({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        readJsonBody(req).then(async (body) => {
          if (body === null) {
            writeJson(res, 400, { ok: false, error: 'invalid-body' })
            return
          }
          try {
            const result = await run(body)
            writeJson(res, result.ok === true ? 200 : 400, result)
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }).catch((error) => {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        })
      },
    })

    return [
      {
        kind: 'exact',
        path: '/api/card-lan',
        handler: (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          try {
            writeJson(res, 200, view())
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      post('/api/card-lan/config', (body) => setConfig(body)),
      post('/api/card-lan/action', (body) => action(body)),
    ]
  }

  /** Start the service (config load, socket, timers). Idempotent. */
  async function start() {
    if (disposed || started) return
    started = true
    await loadConfig()
    if (disposed) return
    stats.startedAt = Date.now()
    if (config.enabled) await openSocket()
    if (disposed) return
    timers.announce = setInterval(() => {
      try {
        announce()
      } catch (error) {
        lastError = 'announce: ' + String(error?.message ?? error)
      }
    }, ANNOUNCE_MS)
    timers.heartbeat = setInterval(() => {
      try {
        pushState()
      } catch (error) {
        lastError = 'heartbeat: ' + String(error?.message ?? error)
      }
    }, HEARTBEAT_MS)
    timers.sweep = setInterval(() => {
      try {
        sweep()
      } catch (error) {
        lastError = 'sweep: ' + String(error?.message ?? error)
      }
    }, 1000)
    timers.retry = setInterval(() => {
      try {
        tickRetries(Date.now())
      } catch (error) {
        lastError = 'retry: ' + String(error?.message ?? error)
      }
    }, RETRY_MS)
    for (const timer of Object.values(timers)) timer?.unref?.()
  }

  /** Release the socket and every timer. Idempotent. */
  function dispose() {
    if (disposed) return
    disposed = true
    cancelBotTimer()
    botToken += 1
    for (const key of Object.keys(timers)) {
      if (timers[key] !== undefined) clearInterval(timers[key])
      timers[key] = undefined
    }
    if (bindRetry !== undefined) {
      clearTimeout(bindRetry)
      bindRetry = undefined
    }
    closeSocket()
    closeGuestSocket()
    for (const timer of leaveTimers) clearTimeout(timer)
    leaveTimers.clear()
    peers = new Map()
    seats = new Map()
    watchers = new Map()
    pendingActions.clear()
    pendingJoin = undefined
    joinedHost = undefined
    remote = undefined
    rejoinTarget = undefined
    reconnecting = false
    reconnectAttempts = 0
    reconnectLastAt = 0
    reconnectGaveUp = false
    turnStartedAt = 0
    currentTurnNode = undefined
    table = undefined
    tableGame = DEFAULTS.game
    tableEngine = undefined
    hostOpen = false
    ackAt.clear()
  }

  return { start, dispose, routes, view, setConfig, action }
}

/** Stable cordis plugin name (matches the bundle patch row). */
export const name = 'dsh-card-lan'

/** Services required before the card-table routes can mount. */
export const inject = ['webServer']

/**
 * Mount the LAN card-table service and its JSON routes.
 * @param ctx - host context.
 */
export function apply(ctx) {
  const lan = createCardLan()
  ctx.effect(() => {
    void lan.start()
    return () => lan.dispose()
  }, 'dsh-card-lan: table service')

  ctx.effect(() => {
    const disposers = lan.routes().map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-card-lan: routes')
}
