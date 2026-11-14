import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAction,
  botAction,
  buildDeck,
  classify3,
  compareHands,
  createTable,
  onTimeout,
  snapshot,
  startRound,
} from '../lib/games/zhajinhua.js'

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

function seats(count = 3) {
  return ['node-a', 'node-b', 'node-c', 'node-d', 'node-e', 'node-f']
    .slice(0, count)
    .map((node, index) => ({ node, nick: '鐜╁' + (index + 1) }))
}

test('zhajinhua uses one 52-card deck', () => {
  const deck = buildDeck()
  assert.equal(deck.length, 52)
  assert.equal(new Set(deck).size, 52)
})

test('hand order: leopard > straight flush > flush > straight > pair > high', () => {
  const leopardCards = ['AS', 'AD', 'AH']
  const straightFlushCards = ['9S', '10S', 'JS']
  const flushCards = ['2S', '7S', 'KS']
  const straightCards = ['9S', '10D', 'JH']
  const pairCards = ['AS', 'AD', 'KH']
  const highCards = ['AS', 'KD', '9H']
  assert.deepEqual(
    [leopardCards, straightFlushCards, flushCards, straightCards, pairCards, highCards].map((cards) => classify3(cards).type),
    ['triple', 'straight-flush', 'flush', 'straight', 'pair', 'high'],
  )
  assert.ok(compareHands(leopardCards, straightFlushCards) > 0)
  assert.ok(compareHands(straightFlushCards, flushCards) > 0)
  assert.ok(compareHands(flushCards, straightCards) > 0)
  assert.ok(compareHands(straightCards, pairCards) > 0)
  assert.ok(compareHands(pairCards, highCards) > 0)
  // A23 is the smallest straight; QKA is the largest.
  const a23Cards = ['AS', '2D', '3H']
  assert.equal(classify3(a23Cards).type, 'straight')
  assert.ok(compareHands(['QS', 'KD', 'AH'], a23Cards) > 0)
  assert.ok(compareHands(['2S', '3D', '4H'], a23Cards) > 0)
  // 235 is only high card (no special beat).
  assert.equal(classify3(['2S', '3D', '5H']).type, 'high')
})

test('startRound posts antes and keeps blinds private until look', () => {
  const state = createTable(seats(2))
  const started = startRound(state, seeded(11))
  assert.equal(started.ok, true)
  assert.equal(state.phase, 'bidding')
  assert.equal(state.pot, 20)
  for (const player of state.players) {
    assert.equal(player.hand.length, 3)
    assert.equal(player.chips, 990)
  }
  const meta = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000, scores: state.scores }
  const before = snapshot(state, 'node-a', meta)
  assert.equal(before.myCards.length, 0)
  assert.equal(before.players.every((player) => player.seen === false), true)

  const turn = state.turn
  assert.equal(applyAction(state, turn, { type: 'look' }).ok, true)
  assert.equal(state.turn, turn, 'look must not end the turn')
  const after = snapshot(state, turn, meta)
  assert.equal(after.myCards.length, 3)
  assert.equal(after.players.find((player) => player.self === true).seen, true)
})

test('raise caps at five per hand', () => {
  const state = createTable(seats(2))
  startRound(state, seeded(3))
  let raises = 0
  for (let guard = 0; guard < 40 && state.phase === 'bidding'; guard += 1) {
    const node = state.turn
    const player = state.players.find((entry) => entry.node === node)
    if (player.seen !== true) {
      assert.equal(applyAction(state, node, { type: 'look' }).ok, true)
    }
    const raised = applyAction(state, node, { type: 'raise' })
    if (raised.ok === true) {
      raises += 1
      continue
    }
    assert.equal(raised.error, 'raise-cap')
    assert.equal(raises, 5)
    break
  }
  assert.equal(raises, 5)
  assert.equal(state.currentBet, 10 + 5 * 10)
})

test('compare resolves a two-player hand and conserves chips', () => {
  const state = createTable(seats(2))
  startRound(state, seeded(17))
  let guard = 0
  while (state.phase === 'bidding' && guard < 60) {
    guard += 1
    const node = state.turn
    const player = state.players.find((entry) => entry.node === node)
    if (player.seen !== true) applyAction(state, node, { type: 'look' })
    const result = applyAction(state, node, { type: 'compare' })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  assert.equal(state.phase, 'result')
  assert.ok(typeof state.winnerNode === 'string')
  const total = state.players.reduce((sum, player) => sum + player.chips, 0)
  assert.equal(total, 2000)
})

test('three betting rounds force a showdown for three players', () => {
  const state = createTable(seats(3))
  startRound(state, seeded(29))
  let guard = 0
  while (state.phase === 'bidding' && guard < 30) {
    guard += 1
    const result = applyAction(state, state.turn, { type: 'call' })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  assert.equal(state.phase, 'result')
  assert.equal(guard, 9)
  assert.ok(typeof state.winnerNode === 'string')
  assert.equal(state.players.reduce((sum, player) => sum + player.chips, 0), 3000)
  const view = snapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000, scores: state.scores })
  assert.equal(view.winnerNode, state.winnerNode)
  assert.equal(view.players.every((player) => Array.isArray(player.cards) && player.cards.length === 3), true)
})

test('botAction can drive a full hand and timeout folds', () => {
  const state = createTable(seats(3))
  startRound(state, seeded(41))
  let guard = 0
  while (state.phase === 'bidding' && guard < 200) {
    guard += 1
    const node = state.turn
    const action = botAction(state, node) ?? onTimeout(state, node)
    assert.ok(action !== null)
    assert.equal(applyAction(state, node, action).ok, true)
  }
  assert.equal(state.phase, 'result')
  assert.equal(state.players.reduce((sum, player) => sum + player.chips, 0), 3000)

  const timeoutState = createTable(seats(2))
  startRound(timeoutState, seeded(43))
  const folded = onTimeout(timeoutState, timeoutState.turn)
  assert.equal(folded.type, 'fold')
})





test('special 235 beats leopards but loses to ordinary hands', () => {
  const special = classify3(['2S', '3D', '5H'])
  assert.equal(special.special, true)
  assert.ok(compareHands(['2S', '3D', '5H'], ['AS', 'AD', 'AH']) > 0)
  assert.ok(compareHands(['2S', '3D', '5H'], ['AS', 'AD', 'KH']) < 0)
  assert.equal(compareHands(['2S', '3D', '5H'], ['2D', '3S', '5C']), 0)
  assert.notEqual(classify3(['2S', '3S', '5S']).special, true)
})

