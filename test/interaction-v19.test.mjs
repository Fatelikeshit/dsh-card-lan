import test from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createTable, snapshot, startRound } from '../lib/games/mahjong.js'

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

function setup(hand) {
  const state = createTable([
    { node: 'node-a', nick: '甲' },
    { node: 'node-b', nick: '乙' },
    { node: 'node-c', nick: '丙' },
    { node: 'node-d', nick: '丁' },
  ], { mode: 'mahjong4' })
  startRound(state, seeded(3))
  state.turn = 'node-a'
  state.mustDiscard = false
  const player = state.players[0]
  player.melds = []
  player.riichi = false
  player.hand = hand.slice()
  player.drawnTile = hand[0]
  return { state, player }
}

const META = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 }

test('snapshot exposes riichi tiles and canTsumo', () => {
  const { state, player } = setup(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '2p', '3p', '2s', 'E'])
  const view = snapshot(state, 'node-a', META)
  assert.equal(view.canRiichi, true)
  assert.ok(Array.isArray(view.riichiTiles))
  assert.ok(view.riichiTiles.includes('E'), JSON.stringify(view.riichiTiles))
  assert.equal(view.canTsumo, false)

  player.hand = ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '2p', '3p', '2s', '2s']
  const winning = snapshot(state, 'node-a', META)
  assert.equal(winning.canTsumo, true)
})

test('riichi accepts a tile and performs the declaration and discard atomically', () => {
  const { state, player } = setup(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '2p', '3p', '2s', 'E'])
  const pointsBefore = state.points['node-a']
  const result = applyAction(state, 'node-a', { type: 'riichi', tile: 'E' })
  assert.equal(result.ok, true)
  assert.equal(player.riichi, true)
  assert.equal(player.hand.includes('E'), false)
  assert.equal(player.discards[player.discards.length - 1], 'E')
  assert.equal(state.riichiSticks, 1)
  assert.equal(state.points['node-a'], pointsBefore - 1000)
  assert.equal(state.lastDiscard.tile, 'E')
})

test('riichi rejects a tile that would break tenpai and changes nothing', () => {
  const { state, player } = setup(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '2p', '3p', '2s', 'E'])
  const pointsBefore = state.points['node-a']
  const handBefore = player.hand.slice()
  const bad = applyAction(state, 'node-a', { type: 'riichi', tile: '1m' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad-riichi')
  assert.equal(player.riichi, false)
  assert.equal(state.points['node-a'], pointsBefore)
  assert.deepEqual(player.hand, handBefore)
})
