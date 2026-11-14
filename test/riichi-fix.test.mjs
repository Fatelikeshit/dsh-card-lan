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

test('riichi is rejected when the hand is not tenpai', () => {
  const { state } = setup(['1m', '1m', '4m', '7m', '1p', '1p', '4p', '7p', '1s', '1s', '4s', '7s', 'E', 'S'])
  const view = snapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(view.canRiichi, false)
  const result = applyAction(state, 'node-a', { type: 'riichi' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad-riichi')
})

test('riichi is accepted for a tenpai hand and the declaration discard must keep it tenpai', () => {
  // Tenpai 13 tiles + one useless tile: only the useless tile may be discarded.
  const hand = ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '2p', '3p', '2s', 'E']
  const { state } = setup(hand)
  const view = snapshot(state, 'node-a', { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 })
  assert.equal(view.canRiichi, true)
  assert.equal(applyAction(state, 'node-a', { type: 'riichi' }).ok, true)
  // Breaking the 123m run leaves a 13-tile hand that is not tenpai.
  const bad = applyAction(state, 'node-a', { type: 'discard', tile: '1m' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad-riichi')
  // Discarding the useless east tile keeps the hand ready.
  assert.equal(applyAction(state, 'node-a', { type: 'discard', tile: 'E' }).ok, true)
})
