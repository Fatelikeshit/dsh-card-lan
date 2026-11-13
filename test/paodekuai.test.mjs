import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAction,
  beats,
  buildDeck,
  canBeat,
  classify,
  createTable,
  labelOf,
  onTimeout,
  snapshot,
  sortHand,
  startRound,
} from '../lib/games/paodekuai.js'

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

function table() {
  return createTable([
    { node: 'node-a', nick: '甲' },
    { node: 'node-b', nick: '乙' },
    { node: 'node-c', nick: '丙' },
  ])
}

test('deck is 48 cards without 2 or jokers', () => {
  const deck = buildDeck()
  assert.equal(deck.length, 48)
  assert.equal(new Set(deck).size, 48)
  assert.equal(deck.some((card) => card.startsWith('2')), false)
  assert.equal(deck.includes('BJ'), false)
  assert.equal(deck.includes('RJ'), false)
})

test('classify supports paodekuai patterns', () => {
  assert.equal(classify(['3S']).type, 'single')
  assert.equal(classify(['3S', '3D']).type, 'pair')
  assert.equal(classify(['3S', '3D', '3H']).type, 'triple')
  assert.equal(classify(['3S', '3D', '3H', '9S', '9D']).type, 'triple-two')
  assert.equal(classify(['3S', '4S', '5S', '6S', '7S']).type, 'straight')
  assert.equal(classify(['3S', '3D', '4S', '4D']).type, 'pair-straight')
  assert.equal(classify(['3S', '3D', '3H', '4S', '4D', '4H']).type, 'plane')
  assert.equal(classify(['3S', '3D', '3H', '3C']).type, 'bomb')
})

test('classify rejects unsupported patterns', () => {
  assert.equal(classify([]), null)
  assert.equal(classify(['3S', '4S', '5S', '6S']), null) // straight needs 5
  assert.equal(classify(['3S', '3D', '3H', '9S']), null) // triple + single not allowed
  assert.equal(classify(['3S', '4S', '5S', '6S', '8S']), null) // gap is not a straight
})

test('beats compares same shape and bombs', () => {
  assert.equal(beats(classify(['4S']), classify(['3S'])), true)
  assert.equal(beats(classify(['3S']), classify(['4S'])), false)
  const bomb = classify(['3S', '3D', '3H', '3C'])
  assert.equal(beats(bomb, classify(['AS'])), true)
  assert.equal(beats(classify(['4S', '4D', '4H', '4C']), bomb), true)
  assert.equal(beats(classify(['4S', '4D']), classify(['3S'])), false)
  assert.equal(labelOf(['AS', 'AH']), '对 A')
})

test('startRound deals 16 each and the 3S holder leads', () => {
  const state = table()
  const started = startRound(state, seeded(5))
  assert.equal(started.ok, true)
  assert.equal(state.phase, 'playing')
  for (const player of state.players) assert.equal(player.hand.length, 16)
  const spade3 = state.players.find((player) => player.hand.includes('3S'))
  assert.ok(spade3, 'one player must hold 3S')
  assert.equal(state.turn, spade3.node)
  assert.equal(state.mustPlay, true)
})

test('must-beat rule rejects a pass when the player can beat', () => {
  const state = table()
  startRound(state, seeded(9))
  const leader = state.players.find((player) => player.node === state.turn)
  const single = sortHand(leader.hand)[0]
  assert.equal(applyAction(state, leader.node, { type: 'play', cards: [single] }).ok, true)

  const next = state.players.find((player) => player.node === state.turn)
  const info = classify([single])
  const can = canBeat(next.hand, info)
  const passed = applyAction(state, next.node, { type: 'pass' })
  if (can) {
    assert.equal(passed.ok, false)
    assert.equal(passed.error, 'must-play')
  } else {
    assert.equal(passed.ok, true)
  }
})

test('a round can be driven to settlement through timeout actions', () => {
  const state = table()
  startRound(state, seeded(13))
  let guard = 0
  while (state.phase === 'playing' && guard < 500) {
    guard += 1
    const action = onTimeout(state, state.turn)
    assert.ok(action && typeof action.type === 'string')
    const result = applyAction(state, state.turn, action)
    assert.equal(result.ok, true, `timeout action should be legal: ${JSON.stringify(result)}`)
  }
  assert.equal(state.phase, 'result')
  assert.equal(state.players.filter((player) => player.result === 'win').length, 1)
  assert.equal(state.players.filter((player) => player.result === 'lose').length, 2)
  assert.equal(Object.keys(state.scores).length, 3)
  const wins = Object.values(state.scores).filter((score) => score.win === 1).length
  const loses = Object.values(state.scores).filter((score) => score.lose === 1).length
  assert.equal(wins, 1)
  assert.equal(loses, 2)
})

test('snapshot keeps hands private per viewer', () => {
  const state = table()
  startRound(state, seeded(3))
  const meta = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000, scores: state.scores }

  const viewA = snapshot(state, 'node-a', meta)
  assert.equal(viewA.game, 'paodekuai')
  assert.equal(viewA.myCards.length, 16)
  assert.equal(viewA.players.find((player) => player.self).node, 'node-a')

  const watcher = snapshot(state, 'node-x', { ...meta, role: 'spectator' })
  assert.equal(watcher.myCards.length, 0)
  assert.equal(watcher.players.every((player) => player.self === false), true)
})
