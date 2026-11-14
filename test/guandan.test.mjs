import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeCards,
  applyAction,
  beats,
  botAction,
  buildDeck,
  classify,
  createTable,
  onTimeout,
  rankValue,
  snapshot,
  startRound,
} from '../lib/games/guandan.js'

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
    { node: 'node-d', nick: '丁' },
  ]
}

test('guandan deck is two full decks (108 cards, 54 distinct)', () => {
  const deck = buildDeck()
  assert.equal(deck.length, 108)
  assert.equal(new Set(deck).size, 54)
})

test('rank order puts the level card below jokers and above A', () => {
  assert.equal(rankValue('A', '2'), 14)
  assert.equal(rankValue('2', '2'), 15)
  assert.equal(rankValue('BJ', '2'), 16)
  assert.equal(rankValue('RJ', '2'), 17)
  assert.equal(rankValue('5', '5'), 15)
  assert.equal(rankValue('2', '5'), 2)
})

test('classify covers the guandan patterns', () => {
  assert.equal(classify(['3S']).type, 'single')
  assert.equal(classify(['3S', '3D']).type, 'pair')
  assert.equal(classify(['3S', '3D', '3H']).type, 'triple')
  assert.equal(classify(['3S', '3D', '3H', '9S', '9D']).type, 'triple-two')
  assert.equal(classify(['3S', '4D', '5H', '6S', '7D']).type, 'straight')
  assert.equal(classify(['3S', '3D', '4S', '4D', '5S', '5D']).type, 'pair-straight')
  assert.equal(classify(['3S', '3D', '3H', '4S', '4D', '4H']).type, 'plane')
  assert.equal(classify(['3S', '4S', '5S', '6S', '7S']).type, 'flush')
  assert.equal(classify(['BJ', 'BJ', 'RJ', 'RJ']).type, 'kings')
  assert.equal(classify(['3S', '3D', '3H', '3C']).type, 'bomb')
  assert.equal(classify(['3S', '3D']).size, 2)
})

test('wild level heart completes combinations but never replaces jokers', () => {
  // Level is 2, so both 2H are wild: three 3s + one wild = bomb of 3s.
  const bomb = classify(['3S', '3D', '3H', '2H'])
  assert.equal(bomb.type, 'bomb')
  assert.equal(bomb.bombPower, 40)
  // A wild can complete a straight or a pair-straight.
  assert.ok(analyzeCards(['3S', '4D', '5H', '6S', '2H'], '2').some((item) => item.type === 'straight'))
  assert.ok(analyzeCards(['3S', '3D', '4S', '4D', '5S', '2H'], '2').some((item) => item.type === 'pair-straight'))
  // A wild cannot stand in for a joker.
  assert.equal(analyzeCards(['BJ', '2H'], '2').length, 0)
})

test('bomb power order: 4-bomb < flush < 5-bomb < kings', () => {
  const four = classify(['3S', '3D', '3H', '3C'])
  const flush = classify(['3S', '4S', '5S', '6S', '7S'])
  const five = classify(['3S', '3D', '3H', '3C', '3S'])
  const kings = classify(['BJ', 'BJ', 'RJ', 'RJ'])
  assert.equal(beats(flush, four), true)
  assert.equal(beats(four, flush), false)
  assert.equal(beats(flush, five), true)
  assert.equal(beats(five, flush), false)
  assert.equal(beats(kings, five), true)
  assert.equal(beats(four, kings), false)
  assert.equal(beats(classify(['4S']), classify(['3S'])), true)
  assert.equal(beats(classify(['3S']), classify(['4S'])), false)
})

test('a full round reaches result with the upgrade formula', () => {
  const state = createTable(seats())
  const started = startRound(state, seeded(21))
  assert.equal(started.ok, true)
  assert.equal(state.phase, 'playing')
  for (const player of state.players) assert.equal(player.hand.length, 27)
  assert.equal(new Set(state.players.map((player) => player.team)).size, 2)

  let guard = 0
  while (state.phase !== 'result' && guard < 4000) {
    guard += 1
    const turn = state.turn
    assert.ok(turn, 'a turn must exist while playing')
    const action = botAction(state, turn) ?? onTimeout(state, turn)
    assert.ok(action !== null, 'bot must always find a move')
    const result = applyAction(state, turn, action)
    assert.equal(result.ok, true, `bot action must be legal: ${JSON.stringify(result)} ${JSON.stringify(action)}`)
  }
  assert.equal(state.phase, 'result')
  const view = snapshot(state, 'node-a', {
    role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000, scores: state.scores,
  })
  assert.equal(view.orders.length, 4)
  assert.equal(new Set(view.orders).size, 4)

  const teams = new Map(view.players.map((player) => [player.node, player.team]))
  const firstTeam = teams.get(view.orders[0])
  const partnerIndex = view.orders.findIndex((node, index) => index > 0 && teams.get(node) === firstTeam)
  const expectedUpgrade = partnerIndex === 1 ? 3 : (partnerIndex === 2 ? 2 : 1)
  assert.equal(view.upgrade, expectedUpgrade)
  assert.equal(view.winnerTeam, firstTeam)
  assert.equal(view.teamLevels.length, 2)
  assert.ok(typeof view.level === 'string')
})

test('snapshot keeps hands private and exposes level state', () => {
  const state = createTable([
    { node: 'node-a', nick: '甲' },
    { node: 'node-b', nick: '乙' },
    { node: 'node-c', nick: '丙' },
    { node: 'node-d', nick: '丁' },
  ])
  startRound(state, seeded(7))
  const meta = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000, scores: state.scores }
  const self = snapshot(state, 'node-a', meta)
  assert.equal(self.game, 'guandan')
  assert.equal(self.myCards.length, 27)
  assert.ok(typeof self.level === 'string')
  assert.equal(self.team, 0)
  const watcher = snapshot(state, 'node-x', { ...meta, role: 'spectator' })
  assert.equal(watcher.myCards.length, 0)
  assert.equal(watcher.team, null)
  assert.equal(watcher.players.every((player) => player.self === false), true)
})

test('second round starts with tribute exchanges and the payer leads', () => {
  const state = createTable(seats())
  const rng = () => 0.42
  startRound(state, rng)
  let guard = 0
  while (state.phase !== 'result' && guard < 4000) {
    guard += 1
    const node = state.turn
    const action = botAction(state, node) ?? onTimeout(state, node)
    assert.equal(applyAction(state, node, action).ok, true)
  }
  assert.equal(state.phase, 'result')

  startRound(state, rng)
  assert.equal(state.phase, 'tribute')
  const meta = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000, scores: state.scores }
  let view = snapshot(state, 'node-a', meta)
  assert.ok(Array.isArray(view.tribute) && view.tribute.length >= 1)
  assert.ok(view.tribute.every((lane) => typeof lane.card === 'string' && lane.card.length >= 2))

  let returns = 0
  while (view.pendingReturn !== null) {
    const node = view.pendingReturn
    const player = state.players.find((entry) => entry.node === node)
    const low = player.hand.find((card) => ['2', '3', '4', '5', '6', '7', '8', '9', '10'].includes(card.slice(0, -1)))
    assert.ok(low, 'a receiver must hold a card <= 10')
    const result = applyAction(state, node, { type: 'tribute-return', card: low })
    assert.equal(result.ok, true, JSON.stringify(result))
    returns += 1
    view = snapshot(state, 'node-a', meta)
  }
  assert.equal(state.phase, 'playing')
  assert.ok(returns >= 1)
  for (const player of state.players) assert.equal(player.hand.length, 27)
  const payers = view.tribute.filter((lane) => lane.skipped !== true).map((lane) => lane.from)
  assert.ok(payers.includes(state.turn), 'a tribute payer must lead the round')
})
