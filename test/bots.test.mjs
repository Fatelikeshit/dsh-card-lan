import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAction as applyDdz,
  botAction as ddzBotAction,
  createTable as ddzCreateTable,
  snapshot as ddzSnapshot,
  startRound as ddzStartRound,
} from '../lib/games/doudizhu.js'
import {
  applyAction as applyPdk,
  botAction as pdkBotAction,
  createTable as pdkCreateTable,
  snapshot as pdkSnapshot,
  startRound as pdkStartRound,
} from '../lib/games/paodekuai.js'
import {
  applyAction as applyGd,
  botAction as gdBotAction,
  createTable as gdCreateTable,
  onTimeout as gdOnTimeout,
  snapshot as gdSnapshot,
  startRound as gdStartRound,
} from '../lib/games/guandan.js'
import {
  applyAction as applyZjh,
  botAction as zjhBotAction,
  createTable as zjhCreateTable,
  startRound as zjhStartRound,
} from '../lib/games/zhajinhua.js'
import {
  applyAction as applyTx,
  botAction as txBotAction,
  createTable as txCreateTable,
  startRound as txStartRound,
} from '../lib/games/texas.js'

/** Deterministic rng (mulberry32). */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seats() {
  return [
    { node: 'node-a', nick: '甲' },
    { node: 'node-b', nick: '乙' },
    { node: 'node-c', nick: '丙' },
  ]
}

test('doudizhu botAction bids and plays a whole round on its own', () => {
  const state = ddzCreateTable(seats())
  assert.equal(ddzStartRound(state, seeded(11)).ok, true)
  const seenBid = { yes: 0, no: 0 }
  let guard = 0
  while (state.phase !== 'result' && guard < 600) {
    guard += 1
    const turn = state.turn
    assert.ok(turn, 'a turn must exist while the round runs')
    const action = ddzBotAction(state, turn)
    assert.ok(action !== null, 'botAction must decide for every turn')
    if (action.type === 'bid') seenBid[action.bid === true ? 'yes' : 'no'] += 1
    const result = applyDdz(state, turn, action)
    assert.equal(result.ok, true, `bot action must be legal: ${JSON.stringify(result)} ${JSON.stringify(action)}`)
  }
  assert.equal(state.phase, 'result')
  assert.ok(seenBid.yes >= 1, 'at least one bot must call landlord')
  const scores = Object.values(state.scores)
  assert.equal(scores.length, 3)
  assert.ok(scores.some((score) => score.win === 1), 'a winning side must be recorded')
})

test('doudizhu snapshot exposes the bot flag to players and spectators', () => {
  const state = ddzCreateTable([
    { node: 'node-a', nick: '甲' },
    { node: 'bot-1', nick: '机器人·小A', bot: true },
    { node: 'bot-2', nick: '机器人·小B', bot: true },
  ])
  ddzStartRound(state, seeded(3))
  const viewer = ddzSnapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  const bots = viewer.players.filter((player) => player.bot === true)
  assert.equal(bots.length, 2)
  assert.equal(viewer.players.find((player) => player.self === true).bot, false)

  const watcher = ddzSnapshot(state, 'node-x', { role: 'spectator', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(watcher.players.filter((player) => player.bot === true).length, 2)
  assert.equal(watcher.myCards.length, 0)
})

test('paodekuai botAction plays a whole round and never breaks must-play', () => {
  const state = pdkCreateTable(seats())
  assert.equal(pdkStartRound(state, seeded(17)).ok, true)
  let guard = 0
  while (state.phase !== 'result' && guard < 600) {
    guard += 1
    const turn = state.turn
    assert.ok(turn, 'a turn must exist while the round runs')
    const action = pdkBotAction(state, turn)
    assert.ok(action !== null, 'botAction must decide for every turn')
    const result = applyPdk(state, turn, action)
    assert.equal(result.ok, true, `bot action must be legal: ${JSON.stringify(result)} ${JSON.stringify(action)}`)
  }
  assert.equal(state.phase, 'result')
  assert.equal(state.players.filter((player) => player.result === 'win').length, 1)
  assert.equal(state.players.filter((player) => player.result === 'lose').length, 2)
})

test('paodekuai snapshot exposes the bot flag', () => {
  const state = pdkCreateTable([
    { node: 'node-a', nick: '甲' },
    { node: 'bot-1', nick: '机器人·小A', bot: true },
    { node: 'bot-2', nick: '机器人·小B', bot: true },
  ])
  pdkStartRound(state, seeded(5))
  const viewer = pdkSnapshot(state, 'bot-1', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(viewer.players.find((player) => player.self === true).bot, true)
})

function seatsN(count) {
  return ['node-a', 'node-b', 'node-c', 'node-d', 'node-e', 'node-f']
    .slice(0, count)
    .map((node, index) => ({ node, nick: '机器人' + (index + 1) }))
}

test('guandan bots play a whole round with legal actions', () => {
  const state = gdCreateTable(seatsN(4))
  assert.equal(gdStartRound(state, seeded(5)).ok, true)
  let guard = 0
  while (state.phase !== 'result' && guard < 4000) {
    guard += 1
    const node = state.turn
    assert.ok(node)
    const action = gdBotAction(state, node) ?? gdOnTimeout(state, node)
    assert.ok(action !== null)
    const result = applyGd(state, node, action)
    assert.equal(result.ok, true, JSON.stringify(result) + ' ' + JSON.stringify(action))
  }
  assert.equal(state.phase, 'result')
  const view = gdSnapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(view.orders.length, 4)
})

test('zhajinhua bots bet, call and settle a whole hand', () => {
  const state = zjhCreateTable(seatsN(3))
  assert.equal(zjhStartRound(state, seeded(7)).ok, true)
  let guard = 0
  while (state.phase !== 'result' && guard < 600) {
    guard += 1
    const node = state.turn
    assert.ok(node)
    const action = zjhBotAction(state, node)
    assert.ok(action !== null)
    const result = applyZjh(state, node, action)
    assert.equal(result.ok, true, JSON.stringify(result) + ' ' + JSON.stringify(action))
  }
  assert.equal(state.phase, 'result')
  assert.equal(state.players.reduce((sum, player) => sum + player.chips, 0), 3000)
})

test('texas bots play streets and settle a whole hand', () => {
  const state = txCreateTable(seatsN(3))
  assert.equal(txStartRound(state, seeded(9)).ok, true)
  let guard = 0
  while (state.phase !== 'result' && guard < 800) {
    guard += 1
    const node = state.turn
    assert.ok(node)
    const action = txBotAction(state, node)
    assert.ok(action !== null)
    const result = applyTx(state, node, action)
    assert.equal(result.ok, true, JSON.stringify(result) + ' ' + JSON.stringify(action))
  }
  assert.equal(state.phase, 'result')
  assert.equal(state.players.reduce((sum, player) => sum + player.chips, 0), 3000)
})
