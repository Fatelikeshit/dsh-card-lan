import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAction,
  beats,
  buildDeck,
  classify,
  createTable,
  labelOf,
  onTimeout,
  snapshot,
  sortHand,
  startRound,
} from '../lib/games/doudizhu.js'

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

test('deck has 54 unique cards including jokers', () => {
  const deck = buildDeck()
  assert.equal(deck.length, 54)
  assert.equal(new Set(deck).size, 54)
  assert.ok(deck.includes('BJ'))
  assert.ok(deck.includes('RJ'))
  assert.ok(deck.includes('2S'))
})

test('classify recognizes every supported pattern', () => {
  assert.equal(classify(['3S']).type, 'single')
  assert.equal(classify(['3S', '3D']).type, 'pair')
  assert.equal(classify(['3S', '3D', '3H']).type, 'triple')
  assert.equal(classify(['3S', '3D', '3H', '9S']).type, 'triple-one')
  assert.equal(classify(['3S', '3D', '3H', '9S', '9D']).type, 'triple-two')
  assert.equal(classify(['3S', '4S', '5S', '6S', '7S']).type, 'straight')
  assert.equal(classify(['3S', '3D', '4S', '4D', '5S', '5D']).type, 'pair-straight')
  assert.equal(classify(['3S', '3D', '3H', '4S', '4D', '4H']).type, 'plane')
  assert.equal(classify(['3S', '3D', '3H', '3C']).type, 'bomb')
  assert.equal(classify(['BJ', 'RJ']).type, 'rocket')
})

test('classify rejects unsupported or malformed plays', () => {
  assert.equal(classify([]), null)
  assert.equal(classify(['3S', '4S']), null)
  assert.equal(classify(['3S', '4S', '5S', '6S']), null) // straight needs 5
  assert.equal(classify(['3S', '4S', '5S', '6S', '7S', '2S']), null) // no 2 in a straight
  assert.equal(classify(['3S', '3D', '3H', '4S', '5D']), null) // four-with-two / bad attach
  assert.equal(classify(['3S', '3D', '3H', '4S', '4D', '4H', '5S']), null) // plane with wing
})

test('beats follows the comparison rules', () => {
  const three = classify(['3S'])
  const four = classify(['4S'])
  assert.equal(beats(four, three), true)
  assert.equal(beats(three, four), false)
  const bomb = classify(['3S', '3D', '3H', '3C'])
  assert.equal(beats(bomb, four), true)
  assert.equal(beats(classify(['4S', '4D', '4H', '4C']), bomb), true)
  assert.equal(beats(classify(['BJ', 'RJ']), bomb), true)
  assert.equal(beats(bomb, classify(['BJ', 'RJ'])), false)
  assert.equal(beats(classify(['5S', '5D']), classify(['4S', '4D'])), true)
  assert.equal(beats(null, four), false)
})

test('labelOf renders readable labels', () => {
  assert.equal(labelOf(['AS', 'AH']), '对 A')
  assert.equal(labelOf(['BJ', 'RJ']), '王炸')
  assert.equal(labelOf(['3S', '4S', '5S', '6S', '7S']), '顺子 3-7')
  assert.equal(labelOf(['3S', '4S']), '无效牌型')
})

test('a three-player round can be driven to settlement', () => {
  const state = table()
  const started = startRound(state, seeded(7))
  assert.equal(started.ok, true)
  assert.equal(state.phase, 'bidding')
  assert.equal(state.players.length, 3)
  for (const player of state.players) assert.equal(player.hand.length, 17)
  assert.equal(state.bottom.length, 3)

  const firstBid = applyAction(state, state.turn, { type: 'bid', bid: true })
  assert.equal(firstBid.ok, true)
  assert.equal(state.phase, 'playing')
  const landlord = state.players.find((player) => player.node === state.landlord)
  assert.equal(landlord.hand.length, 20)

  let guard = 0
  while (state.phase === 'playing' && guard < 400) {
    guard += 1
    const player = state.players.find((entry) => entry.node === state.turn)
    assert.ok(player, 'turn should point at a player')
    if (state.mustPlay) {
      const card = sortHand(player.hand)[0]
      assert.equal(applyAction(state, state.turn, { type: 'play', cards: [card] }).ok, true)
    } else {
      assert.equal(applyAction(state, state.turn, { type: 'pass' }).ok, true)
    }
  }
  assert.equal(state.phase, 'result')
  assert.ok(state.winner === 'landlord' || state.winner === 'farmers')
  assert.equal(Object.keys(state.scores).length, 3)
  for (const score of Object.values(state.scores)) {
    assert.equal(score.win + score.lose, 1)
  }
  assert.equal(state.players.every((player) => player.result === 'win' || player.result === 'lose'), true)
})

test('turn timeout hands out a legal automatic action', () => {
  const bidding = table()
  startRound(bidding, seeded(11))
  const bidAction = onTimeout(bidding, bidding.turn)
  assert.equal(bidAction.type, 'bid')
  assert.equal(bidAction.bid, false)

  const playing = table()
  startRound(playing, seeded(11))
  applyAction(playing, playing.turn, { type: 'bid', bid: true })
  const lead = onTimeout(playing, playing.turn)
  assert.equal(lead.type, 'play')
  assert.ok(Array.isArray(lead.cards) && lead.cards.length > 0)

  const following = table()
  startRound(following, seeded(5))
  applyAction(following, following.turn, { type: 'bid', bid: true })
  const leader = following.turn
  const landlord = following.players.find((player) => player.node === leader)
  const single = sortHand(landlord.hand)[0]
  assert.equal(applyAction(following, leader, { type: 'play', cards: [single] }).ok, true)
  const passAction = onTimeout(following, following.turn)
  assert.equal(passAction.type, 'pass')
})

test('snapshot hides other hands and marks self correctly', () => {
  const state = table()
  startRound(state, seeded(3))
  const meta = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000, scores: state.scores }

  const viewA = snapshot(state, 'node-a', meta)
  assert.equal(viewA.game, 'doudizhu')
  assert.equal(viewA.phase, 'bidding')
  assert.equal(viewA.myCards.length, 17)
  assert.equal(viewA.players.find((player) => player.self).node, 'node-a')

  const viewB = snapshot(state, 'node-b', meta)
  assert.equal(viewB.myCards.length, 17)
  assert.equal(viewB.players.find((player) => player.self).node, 'node-b')

  const watcher = snapshot(state, 'node-x', { ...meta, role: 'spectator' })
  assert.equal(watcher.myCards.length, 0)
  assert.equal(watcher.players.every((player) => player.self === false), true)
})
