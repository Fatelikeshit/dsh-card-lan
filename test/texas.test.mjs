import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAction,
  botAction,
  buildDeck,
  compareHands,
  createTable,
  evaluate7,
  onTimeout,
  snapshot,
  startRound,
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

function seats(count = 2) {
  return ['node-a', 'node-b', 'node-c', 'node-d', 'node-e', 'node-f']
    .slice(0, count)
    .map((node, index) => ({ node, nick: '鐜╁' + (index + 1) }))
}

const META = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 }

test('texas uses one 52-card deck', () => {
  const deck = buildDeck()
  assert.equal(deck.length, 52)
  assert.equal(new Set(deck).size, 52)
})

test('evaluate7 ranks all nine categories in order', () => {
  const hands = {
    high: ['AS', 'KD', '9H', '7C', '2S', '4D', '6H'],
    pair: ['AS', 'AD', '9H', '7C', '2S', '4D', '6H'],
    twoPair: ['AS', 'AD', '9H', '9C', '7S', '4D', '2H'],
    trips: ['AS', 'AD', 'AH', '9C', '7S', '4D', '2H'],
    straight: ['AS', '2D', '3H', '4C', '5S', '9D', 'KD'],
    flush: ['AS', '9S', '7S', '4S', '2S', 'KD', 'QH'],
    fullHouse: ['AS', 'AD', 'AH', '9C', '9S', '4D', '2H'],
    quads: ['AS', 'AD', 'AH', 'AC', '9S', '4D', '2H'],
    straightFlush: ['AS', 'KS', 'QS', 'JS', '10S', '2D', '3H'],
  }
  const order = ['high', 'pair', 'twoPair', 'trips', 'straight', 'flush', 'fullHouse', 'quads', 'straightFlush']
  const categories = order.map((key) => evaluate7(hands[key]).category)
  assert.deepEqual(categories, [0, 1, 2, 3, 4, 5, 6, 7, 8])
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(compareHands(hands[order[index]], hands[order[index - 1]]) > 0, order[index] + ' must beat ' + order[index - 1])
  }
})

test('wheel straight is the lowest straight', () => {
  const wheel = ['AS', '2D', '3H', '4C', '5S', '9D', 'KH']
  const six = ['2S', '3D', '4H', '5C', '6S', '9D', 'KH']
  assert.equal(evaluate7(wheel).category, 4)
  assert.ok(compareHands(wheel, six) < 0)
  assert.ok(compareHands(six, wheel) > 0)
})

test('heads-up start posts blinds with the button as small blind', () => {
  const state = createTable(seats(2))
  const started = startRound(state, seeded(5))
  assert.equal(started.ok, true)
  assert.equal(state.phase, 'preflop')
  assert.equal(state.pot, 30)
  assert.equal(state.dealer, 'node-a')
  for (const player of state.players) assert.equal(player.hole.length, 2)
  const button = state.players.find((player) => player.node === 'node-a')
  const other = state.players.find((player) => player.node === 'node-b')
  assert.equal(button.chips, 990)
  assert.equal(other.chips, 980)
})

test('a full heads-up hand reaches result and conserves chips', () => {
  const state = createTable(seats(2))
  startRound(state, seeded(13))
  let guard = 0
  while (state.phase !== 'result' && guard < 500) {
    guard += 1
    const node = state.turn
    assert.ok(node, 'a turn must exist')
    const action = botAction(state, node) ?? onTimeout(state, node)
    assert.ok(action !== null)
    const result = applyAction(state, node, action)
    assert.equal(result.ok, true, JSON.stringify(result) + ' ' + JSON.stringify(action))
  }
  assert.equal(state.phase, 'result')
  assert.ok(Array.isArray(state.winnerNodes) && state.winnerNodes.length >= 1)
  const total = state.players.reduce((sum, player) => sum + player.chips, 0)
  assert.equal(total, 2000)
  assert.ok(Array.isArray(state.board))
  assert.equal(Array.isArray(state.players[0].hole), true)
})

test('an all-in short stack produces side-pot bookkeeping and chip conservation', () => {
  const state = createTable(seats(3))
  state.players[0].chips = 30
  state.players[1].chips = 1000
  state.players[2].chips = 1000
  startRound(state, seeded(21))
  assert.equal(state.phase, 'preflop')
  let guard = 0
  while (state.phase !== 'result' && guard < 800) {
    guard += 1
    const node = state.turn
    const action = botAction(state, node) ?? onTimeout(state, node)
    assert.ok(action !== null)
    const result = applyAction(state, node, action)
    assert.equal(result.ok, true, JSON.stringify(result) + ' ' + JSON.stringify(action))
  }
  assert.equal(state.phase, 'result')
  const total = state.players.reduce((sum, player) => sum + player.chips, 0)
  assert.equal(total, 2030)
})

test('snapshot keeps hole cards private until showdown', () => {
  const state = createTable(seats(2))
  startRound(state, seeded(31))
  const self = snapshot(state, 'node-a', META)
  assert.equal(self.game, 'texas')
  assert.equal(self.myCards.length, 2)
  assert.equal(self.players.some((player) => Array.isArray(player.cards) && player.cards.length > 0), false)
  const watcher = snapshot(state, 'node-x', { ...META, role: 'spectator' })
  assert.equal(watcher.myCards.length, 0)
  assert.equal(watcher.players.every((player) => player.self === false), true)
})



test('raise accepts a free amount with min-raise validation', () => {
  const state = createTable(seats(2))
  startRound(state, seeded(3))
  const first = state.turn
  const tooSmall = applyAction(state, first, { type: 'raise', amount: 30 })
  assert.equal(tooSmall.ok, false)
  assert.equal(tooSmall.error, 'bad-raise')
  const raised = applyAction(state, first, { type: 'raise', amount: 60 })
  assert.equal(raised.ok, true)
  assert.equal(state.currentBet, 60)
  assert.ok(state.lastRaiseDelta >= 40)
})

test('oversized raise clamps to an all-in', () => {
  const state = createTable(seats(2))
  state.players[0].chips = 100
  startRound(state, seeded(7))
  const first = state.turn
  const result = applyAction(state, first, { type: 'raise', amount: 500 })
  assert.equal(result.ok, true)
  const player = state.players.find((entry) => entry.node === first)
  assert.equal(player.chips, 0)
  assert.equal(player.status, 'allin')
})
