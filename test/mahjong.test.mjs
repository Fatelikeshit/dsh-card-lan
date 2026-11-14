import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAction,
  buildWall,
  createTable,
  isKokushi,
  isSevenPairs,
  isWinningHand,
  onTimeout,
  snapshot,
  startRound,
} from '../lib/games/mahjong.js'

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

const FOUR = [
  { node: 'node-a', nick: '甲' },
  { node: 'node-b', nick: '乙' },
  { node: 'node-c', nick: '丙' },
  { node: 'node-d', nick: '丁' },
]
const THREE = FOUR.slice(0, 3)

function table(mode) {
  return createTable(mode === 'mahjong3' ? THREE : FOUR, { mode })
}

test('mahjong walls match 4-player and 3-player modes', () => {
  const wall4 = buildWall('mahjong4')
  const wall3 = buildWall('mahjong3')
  assert.equal(wall4.length, 136)
  assert.equal(wall3.length, 108)
  assert.equal(wall4.filter((tile) => tile === '5mr').length, 1)
  assert.equal(wall4.filter((tile) => tile === '5pr').length, 1)
  assert.equal(wall4.filter((tile) => tile === '5sr').length, 1)
  assert.equal(wall3.includes('5mr'), false)
  assert.equal(wall3.includes('2m'), false)
  assert.equal(wall3.includes('8m'), false)
})

test('deal gives the dealer 14 tiles and the others 13', () => {
  const state = table('mahjong4')
  assert.equal(startRound(state, seeded(11)).ok, true)
  assert.equal(state.phase, 'playing')
  assert.equal(state.dealer, 'node-a')
  const counts = state.players.map((player) => player.hand.length)
  assert.deepEqual(counts, [14, 13, 13, 13])
  assert.equal(state.wall, 69)
  assert.ok(typeof state.doraIndicator === 'string' && state.doraIndicator.length >= 2)

  const three = table('mahjong3')
  assert.equal(startRound(three, seeded(11)).ok, true)
  assert.deepEqual(three.players.map((player) => player.hand.length), [14, 13, 13])
  assert.equal(three.wall, 54)
})

test('discard advances the turn and draws for the next player', () => {
  const state = table('mahjong4')
  startRound(state, seeded(13))
  const dealer = state.players.find((player) => player.node === state.turn)
  const tile = dealer.hand[0]
  assert.equal(applyAction(state, state.turn, { type: 'discard', tile }).ok, true)
  assert.equal(state.turn, 'node-b')
  assert.equal(state.wall, 68)
  const view = snapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(view.discards.length, 4)
  assert.equal(view.discards[0].length, 1)
})

test('basic agari detection covers standard, seven pairs and kokushi', () => {
  assert.equal(isWinningHand(['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', 'E', 'E']), true)
  assert.equal(isSevenPairs(['1m', '1m', '2p', '2p', '3s', '3s', '4m', '4m', '5p', '5p', '6s', '6s', 'E', 'E']), true)
  assert.equal(isKokushi(['1m', '9m', '1p', '9p', '1s', '9s', 'E', 'S', 'W', 'N', 'P', 'F', 'C', 'E']), true)
  assert.equal(isWinningHand(['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '4p', 'E', 'E']), false)
})

test('3-player mode peels north and redraws from the dead wall', () => {
  for (let seed = 1; seed < 80; seed += 1) {
    const state = table('mahjong3')
    startRound(state, seeded(seed))
    const dealer = state.players.find((player) => player.node === state.turn)
    if (!dealer.hand.includes('N')) continue
    const before = dealer.hand.length
    const result = applyAction(state, state.turn, { type: 'nuki', tile: 'N' })
    assert.equal(result.ok, true)
    assert.equal(state.nuki, 1)
    assert.equal(dealer.hand.length, before, 'peel north removes one and draws one')
    assert.equal(state.turn, dealer.node, 'peeling keeps the same turn')
    return
  }
  assert.fail('no seed dealt north to the dealer')
})

test('4-player mode rejects peeling north', () => {
  const state = table('mahjong4')
  startRound(state, seeded(5))
  const result = applyAction(state, state.turn, { type: 'nuki', tile: 'N' })
  assert.equal(result.ok, false)
})

test('timed-out play exhausts the wall and reaches an exhausted result', () => {
  const state = table('mahjong4')
  startRound(state, seeded(17))
  let guard = 0
  while (state.phase === 'playing' && guard < 400) {
    guard += 1
    const action = onTimeout(state, state.turn)
    if (action === null) break
    assert.equal(applyAction(state, state.turn, action).ok, true)
  }
  assert.equal(state.phase, 'result')
  assert.ok(state.result === 'exhausted' || state.result === 'tsumo')
  const view = snapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(view.result, state.result)
  assert.equal(view.players.every((player) => Array.isArray(player.hand)), true)
})

test('hands stay private in the snapshot', () => {
  const state = table('mahjong4')
  startRound(state, seeded(19))
  const self = snapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(self.myHand.length, 14)
  assert.equal(self.players.every((player) => player.hand === undefined), true)
  const watcher = snapshot(state, 'node-x', { role: 'spectator', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(watcher.myHand.length, 0)
  assert.equal(watcher.players.every((player) => player.hand === undefined), true)
})
