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

function table() {
  const state = createTable([
    { node: 'node-a', nick: '甲' },
    { node: 'node-b', nick: '乙' },
    { node: 'node-c', nick: '丙' },
    { node: 'node-d', nick: '丁' },
  ], { mode: 'mahjong4' })
  startRound(state, seeded(7))
  return state
}

const META = { role: 'player', hostNode: 'node-a', staleMs: 0, turnRemainingMs: 30000 }
const JUNK = ['1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '8s', '9s', 'E', 'S', 'W', 'N', 'P', 'F', 'C']

test('daiminkan draws a replacement tile from the dead wall', () => {
  const state = table()
  state.turn = 'node-a'
  state.mustDiscard = false
  state.players[0].hand = ['5m', ...JUNK.slice(0, 12)]
  state.players[1].hand = ['5m', '5m', '5m', ...JUNK.slice(0, 10)]
  assert.equal(applyAction(state, 'node-a', { type: 'discard', tile: '5m' }).ok, true)
  assert.equal(state.phase, 'calling')
  const dorasBefore = state.doras.length
  assert.equal(applyAction(state, 'node-b', { type: 'kan', tiles: ['5m', '5m', '5m'] }).ok, true)
  assert.equal(state.phase, 'playing')
  assert.equal(state.turn, 'node-b')
  assert.equal(state.players[1].hand.length, 11)
  assert.equal(state.mustDiscard, true)
  assert.equal(state.lastDrawWasRinshan, true)
  assert.equal(state.doras.length, dorasBefore + 1)
  const tile = state.players[1].hand[0]
  assert.equal(applyAction(state, 'node-b', { type: 'discard', tile }).ok, true)
  assert.equal(state.players[1].hand.length, 10)
})

function chankanSetup() {
  const state = table()
  const kanOwner = state.players[0]
  kanOwner.melds = [{ type: 'pon', tiles: ['2m', '2m', '2m'], from: 'node-b' }]
  kanOwner.hand = ['2m', ...JUNK.slice(0, 10)]
  kanOwner.riichi = false
  state.turn = 'node-a'
  state.mustDiscard = false
  const winner = state.players[1]
  winner.hand = ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', 'C', 'C', 'C', '2m']
  winner.furiten = false
  winner.riichi = false
  return { state, kanOwner, winner }
}

test('kakan opens a chankan window and the robbed kan settles a ron', () => {
  const { state, kanOwner, winner } = chankanSetup()
  assert.equal(applyAction(state, 'node-a', { type: 'kakan', tile: '2m' }).ok, true)
  assert.equal(state.phase, 'calling')
  assert.equal(kanOwner.melds[0].type, 'pon')
  const pending = state.pending.find((entry) => entry.node === 'node-b')
  assert.ok(pending && pending.allowed.includes('ron'), JSON.stringify(state.pending))
  assert.equal(applyAction(state, 'node-b', { type: 'ron' }).ok, true)
  assert.equal(state.phase, 'result')
  assert.equal(state.result, 'ron')
  assert.equal(state.winnerNode, 'node-b')
  assert.ok(state.winInfo.yaku.some((entry) => entry.name === '抢杠'))
  assert.equal(winner.hand.includes('2m'), true)
})

test('kakan completes when nobody robs it', () => {
  const { state, kanOwner } = chankanSetup()
  assert.equal(applyAction(state, 'node-a', { type: 'kakan', tile: '2m' }).ok, true)
  assert.equal(state.phase, 'calling')
  const dorasBefore = state.doras.length
  assert.equal(applyAction(state, 'node-b', { type: 'pass' }).ok, true)
  assert.equal(state.phase, 'playing')
  assert.equal(state.turn, 'node-a')
  assert.equal(kanOwner.melds[0].type, 'kakan')
  assert.equal(kanOwner.hand.length, 11)
  assert.equal(state.mustDiscard, true)
  assert.equal(state.doras.length, dorasBefore + 1)
})

function tsumoWin(state, player, hand) {
  player.hand = hand.slice()
  player.drawnTile = hand[0]
  player.melds = []
  player.riichi = false
  state.turn = player.node
  state.mustDiscard = false
  state.doras = []
  state.doraIndicator = 'E'
  return applyAction(state, player.node, { type: 'tsumo' })
}

const WINNING = ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '2p', '3p', '2s', '2s']

test('honba is counted into payments and incremented for renchan', () => {
  const state = table()
  state.honba = 1
  const dealer = state.players[0]
  assert.equal(tsumoWin(state, dealer, WINNING).ok, true)
  assert.equal(state.winInfo.honbaBonus, 300)
  assert.equal(state.players.reduce((sum, player) => sum + player.points, 0), 100000)
  assert.equal(state.renchan, true)
  startRound(state, seeded(9))
  assert.equal(state.honba, 2)
  assert.equal(state.dealer, 'node-a')
  const view = snapshot(state, 'node-a', META)
  assert.equal(view.honba, 2)

  const next = table()
  next.honba = 1
  const other = next.players[1]
  assert.equal(tsumoWin(next, other, WINNING).ok, true)
  assert.equal(next.renchan, false)
  startRound(next, seeded(11))
  assert.equal(next.honba, 0)
  assert.equal(next.dealer, 'node-b')
})
