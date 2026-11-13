import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PLAYERS,
  applyAction,
  freshDeck,
  handValue,
  isBlackjack,
  newTable,
  nextRound,
  shuffle,
  startRound,
  visibleDealer,
} from '../lib/engine.js'

/** Deterministic rng (mulberry32) so deals are reproducible. */
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

function lobby() {
  return [
    { node: 'node-a', nick: '甲' },
    { node: 'node-b', nick: '乙' },
  ]
}

test('deck has 52 unique cards', () => {
  const deck = freshDeck()
  assert.equal(deck.length, 52)
  assert.equal(new Set(deck).size, 52)
  assert.ok(deck.includes('AS'))
  assert.ok(deck.includes('10H'))
})

test('shuffle keeps the same cards', () => {
  const shuffled = shuffle(freshDeck(), seeded(7))
  assert.equal(shuffled.length, 52)
  assert.equal(new Set(shuffled).size, 52)
})

test('handValue counts aces as 11 then 1', () => {
  assert.equal(handValue(['AS']), 11)
  assert.equal(handValue(['AS', '9H']), 20)
  assert.equal(handValue(['AS', 'AH', '9H']), 21)
  assert.equal(handValue(['AS', 'AH', 'AH']), 13)
  assert.equal(handValue(['KS', 'QH', 'JD']), 30)
  assert.equal(handValue(['AS', 'AH']), 12)
  assert.equal(handValue([]), 0)
})

test('isBlackjack only for two-card 21', () => {
  assert.equal(isBlackjack(['AS', 'KH']), true)
  assert.equal(isBlackjack(['AS', 'AH', '9H']), false)
  assert.equal(isBlackjack(['KS', 'QH']), false)
})

test('startRound deals two cards to each player and the dealer', () => {
  const table = newTable(lobby())
  const result = startRound(table, seeded(3))
  assert.equal(result.ok, true)
  assert.equal(table.phase, 'playing')
  assert.equal(table.round, 1)
  assert.equal(table.players[0].cards.length, 2)
  assert.equal(table.players[1].cards.length, 2)
  assert.equal(table.dealer.cards.length, 2)
  assert.equal(table.deck.length, 52 - 6)
  assert.ok(table.turn === 'node-a' || table.turn === 'node-b')
})

test('startRound rejects an empty table', () => {
  const result = startRound(newTable([]), seeded(1))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-players')
})

test('only the player on turn may act', () => {
  const table = newTable(lobby())
  startRound(table, seeded(5))
  const acting = table.turn
  const waiting = acting === 'node-a' ? 'node-b' : 'node-a'
  const denied = applyAction(table, waiting, 'hit', seeded(6))
  assert.equal(denied.ok, false)
  assert.equal(denied.error, 'not-your-turn')
})

test('hit busts above 21 and passes the turn', () => {
  const table = newTable(lobby())
  startRound(table, seeded(9))
  const player = table.players[0]
  table.turn = player.node
  player.cards = ['KS', 'QH']
  // draw() pops from the end: the last element is the next card dealt.
  table.deck = ['3D', '2S']
  const result = applyAction(table, player.node, 'hit', seeded(9))
  assert.equal(result.ok, true)
  assert.equal(player.status, 'bust')
  assert.equal(handValue(player.cards), 22)
})

test('dealer draws to 17 and the higher hand wins', () => {
  const table = newTable([{ node: 'solo', nick: '独行' }])
  startRound(table, seeded(2))
  const player = table.players[0]
  table.turn = player.node
  player.cards = ['10S', '9H'] // 19
  table.dealer.cards = ['5S', '6H'] // 11
  table.deck = ['KS', '2D', '7S'] // pop order: 7S -> 18, then stands
  const result = applyAction(table, player.node, 'stand', seeded(2))
  assert.equal(result.ok, true)
  assert.equal(table.phase, 'result')
  assert.equal(handValue(table.dealer.cards), 18)
  assert.equal(player.result, 'win')
})

test('dealer bust pays the player', () => {
  const table = newTable([{ node: 'solo', nick: '独行' }])
  startRound(table, seeded(2))
  const player = table.players[0]
  table.turn = player.node
  player.cards = ['10S', '9H'] // 19
  table.dealer.cards = ['KS', '6H'] // 16
  table.deck = ['2D', '8S'] // pop order: 8S -> 24, bust
  applyAction(table, player.node, 'stand', seeded(2))
  assert.equal(table.phase, 'result')
  assert.equal(handValue(table.dealer.cards) > 21, true)
  assert.equal(player.result, 'win')
})

test('equal totals push', () => {
  const table = newTable([{ node: 'solo', nick: '独行' }])
  startRound(table, seeded(2))
  const player = table.players[0]
  table.turn = player.node
  player.cards = ['10S', '8H'] // 18
  table.dealer.cards = ['10S', '8H'] // 18
  table.deck = ['2D']
  applyAction(table, player.node, 'stand', seeded(2))
  assert.equal(player.result, 'push')
})

test('natural blackjack beats a non-blackjack dealer', () => {
  const table = newTable([{ node: 'bj', nick: '天胡' }])
  startRound(table, seeded(4))
  const player = table.players[0]
  player.cards = ['AS', 'KH']
  player.status = 'blackjack'
  table.turn = null
  table.players.push({ node: 'other', nick: '凡人', cards: ['10S', '8H'], status: 'stand', result: null })
  table.dealer.cards = ['9S', '7H'] // 16 -> draws 10 -> 26 bust
  table.deck = ['10C']
  // Settle runs through the next action of the last active player.
  table.phase = 'playing'
  table.turn = 'other'
  applyAction(table, 'other', 'stand', seeded(4))
  assert.equal(player.result, 'win')
  assert.equal(table.players[1].result, 'win')
})

test('dealer blackjack beats a normal 20', () => {
  const table = newTable([{ node: 'solo', nick: '倒霉' }])
  startRound(table, seeded(2))
  const player = table.players[0]
  player.cards = ['KS', 'QH']
  table.turn = player.node
  table.dealer.cards = ['AS', 'KH'] // natural
  table.deck = ['2D']
  applyAction(table, player.node, 'stand', seeded(2))
  assert.equal(player.result, 'lose')
})

test('nextRound keeps players and resets the table', () => {
  const table = newTable(lobby())
  startRound(table, seeded(11))
  table.players[1].result = 'win'
  const result = nextRound(table, seeded(12))
  assert.equal(result.ok, true)
  assert.equal(table.round, 2)
  assert.equal(table.players.length, 2)
  assert.deepEqual(table.players.map((p) => p.result), [null, null])
  assert.equal(table.players[0].cards.length, 2)
})

test('visibleDealer hides the hole card while playing', () => {
  const table = newTable([{ node: 'solo', nick: '独行' }])
  startRound(table, seeded(8))
  const playing = visibleDealer(table)
  assert.equal(playing.hidden, true)
  assert.equal(playing.cards.length, 1)
  table.phase = 'result'
  const done = visibleDealer(table)
  assert.equal(done.hidden, false)
  assert.equal(done.cards.length, 2)
})

test('MAX_PLAYERS is a sane cap', () => {
  assert.equal(MAX_PLAYERS, 4)
})
