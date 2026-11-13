/**
 * dsh-card-lan browser half — the LAN blackjack lobby and the floating table.
 *
 * Two surfaces read one polled view (`GET /api/card-lan`, PROTOCOL.md §3.1):
 * `settings.section` owns the knobs and discovery, `shell.overlay` paints the
 * live table in the bottom-right corner and nothing at all while the local
 * node has no seat. The host half (lib/index.js) is authoritative: this half
 * never guesses table state, it only renders what the view says and POSTs
 * actions/config back. Cards are rendered as plain text glyphs, so the plugin
 * ships zero images and zero font assets.
 *
 * v2 adds room passwords, spectator seats and per-machine display preferences
 * (overlay size/position, auto-fade, opacity, Ctrl+Shift+H hide). Every one of
 * those lives in the same view config: the lobby PATCHes it, the overlay reads
 * it — there is no second source of truth.
 *
 * v3 adds the connection story: auto-reconnect / rejoin-failed / host-closed
 * banners (lobby + overlay), the host-driven turn timeout setting, and the
 * per-turn countdown hint. Guests always render their player/spectator view
 * while reconnecting; only actions are disabled until the link is back.
 *
 * v4 adds games: the lobby picks 21 点 or 斗地主 when creating a table, and the
 * overlay branches on `view.table.game` — blackjack keeps the v1 renderer,
 * while Dou Dizhu gets its own seats/last-play/hand/bid-play-pass table. The
 * shared shell (drag, size, fade, opacity, hide shortcut, reconnect banners)
 * is identical for both.
 *
 * v5 adds 跑得快: same card-table layout as Dou Dizhu minus bidding/landlord,
 * with the stricter "must beat it if you can" pass rule reported through the
 * shared `must-play` error code.
 *
 * @module dsh-card-lan/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-card-lan',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState, useSyncExternalStore } = React

    /** HTTP contract surface (PROTOCOL.md §3). */
    const VIEW_URL = '/api/card-lan'
    const ACTION_URL = '/api/card-lan/action'
    const CONFIG_URL = '/api/card-lan/config'

    /** Contract-mandated poll cadence; one store feeds both surfaces. */
    const POLL_MS = 900

    /** A guest is out of sync after this much host silence (PROTOCOL §2.4). */
    const STALE_MS = 4000

    /** Overlay opacity bounds (mirrors PROTOCOL.md 3.1 config.overlayOpacity). */
    const MIN_OPACITY = 0.25
    const DEFAULT_OPACITY = 0.9

    /** Auto-fade: idle overlay settles to this fraction of the base opacity. */
    const AUTO_FADE_FACTOR = 0.55

    /** Overlay width per size preset (PROTOCOL.md 3.2 config.overlaySize). */
    const OVERLAY_WIDTHS = { small: 320, medium: 380, large: 460 }
    const OVERLAY_SIZES = ['small', 'medium', 'large']
    const DEFAULT_SIZE = 'medium'

    /** Default anchor (bottom-right, above the composer) and drag save delay. */
    const DEFAULT_EDGE = 16
    const POSITION_SAVE_MS = 260

    /** Turn timeout bounds (PROTOCOL.md §3.2 config.turnTimeout). */
    const DEFAULT_TURN_TIMEOUT = 45
    const MAX_TURN_TIMEOUT = 300

    /** Bot back-fill bounds (PROTOCOL.md §7.8 config.botCount): 0..2. */
    const MAX_BOT_COUNT = 2

    /** Card suits: spades/clubs ink, hearts/diamonds red (engine.js encoding). */
    const SUIT_GLYPHS = { S: '♠', H: '♥', D: '♦', C: '♣' }
    const RED_SUITS = { H: true, D: true }

    /** Host-authoritative enums (engine.js state model). */
    const PHASES = { idle: '等待开始', playing: '玩家行动', dealer: '庄家行动', result: '本局结束' }
    const STATUSES = { playing: '要牌中', stand: '停牌', bust: '爆牌', blackjack: '黑杰克' }
    const RESULTS = { win: '赢', lose: '输', push: '平' }

    /** Game kinds (PROTOCOL §7.1/§7.7); anything unknown falls back to blackjack. */
    const GAME_LABELS = { blackjack: '21 点', doudizhu: '斗地主', paodekuai: '跑得快' }
    const GAME_ORDER = ['blackjack', 'doudizhu', 'paodekuai']
    const DEFAULT_GAME = 'blackjack'

    /** Dou Dizhu phases (PROTOCOL §7.3): idle is the pre-deal table state. */
    const DDZ_PHASES = { idle: '等待开始', bidding: '叫地主中', playing: '出牌中', result: '本局结束' }

    /** Pao De Kuai phases (PROTOCOL §7.6): no bidding, no landlord. */
    const PDK_PHASES = { idle: '等待开始', playing: '出牌中', result: '本局结束' }

    /** Dou Dizhu rank order: 3 < 4 < … < 2 < 小王 < 大王. */
    const DDZ_RANK_ORDER = {
      3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10,
      J: 11, Q: 12, K: 13, A: 14, 2: 15, BJ: 16, RJ: 17,
    }
    const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 }

    /** Host error codes (PROTOCOL §3.2/§3.3) in plain Chinese. */
    const ERROR_TEXT = {
      'udp-offline': '联机没开着，或 UDP 端口没有监听成功；先保存设置并确认端口可用。',
      'table-closed': '这张牌桌已经关了。',
      'not-your-turn': '还没轮到你行动。',
      'not-playing': '现在不是出牌阶段。',
      'unknown-peer': '找不到这个对端，对方可能已经下线。',
      'no-players': '牌桌上还没有玩家。',
      'not-host': '只有房主能做这个操作。',
      'already-seated': '你已经在这张牌桌上了。',
      'send-failed': '动作没发出去，对方可能断线了。',
      'invalid-room': '房间名不合法：需要 1–32 个字符。',
      'invalid-port': '端口不合法：需要 1024–65535 之间的整数。',
      'invalid-nick': '昵称不合法：需要 1–24 个字符。',
      'no-table': '本机还没有牌桌。',
      'too-many-players': '一张牌桌最多 4 个人。',
      'unknown-player': '牌桌上没有这个玩家。',
      'bad-action': '不认识的动作。',
      'invalid-body': '请求格式不对，请再试一次。',
      'method-not-allowed': '这个接口不支持该操作。',
      'invalid-password': '房间密码不合法：开启时必须填写 1–16 个字符。',
      'invalid-overlay-size': '浮层大小不合法：只能是 small / medium / large。',
      'invalid-overlay-position': '浮层位置不合法：需要整数坐标或恢复默认。',
      'invalid-autofade': '自动变淡开关不合法。',
      'join-password': '房间密码不对，请核对后重试。',
      'join-watch-closed': '房主没有开启观战。',
      'join-watch-full': '观战位已经满了。',
      'join-full': '牌桌已经坐满 4 个人了。',
      'join-closed': '房主已经关掉牌桌了。',
      'join-timeout': '入座请求超时，对方可能没有响应。',
      'invalid-opacity': '透明度不合法：需要 0.25–1 之间的数值。',
      'host-closed': '房主已关闭牌桌。',
      'reconnect-failed': '与房主的连接已断开，重连失败；可以点「重新连接」再试一次。',
      'no-target': '没有可重连的房主信息，请重新加入牌桌。',
      'invalid-turn-timeout': '回合超时必须是 0–300 的整数秒。',
      'invalid-botcount': '机器人数量不合法：只能是 0、1 或 2。',
      'invalid-fillbots': '人机补位开关必须是一个布尔值。',
      'bad-cards': '牌型不合法，或者压不过上家；换一手再试。',
      'must-play': '轮到你领出，必须出牌，不能不要。',
      'bad-phase': '现在不是这个阶段，做不了这个操作。',
      'invalid-game': '不认识的玩法，只支持 21 点和斗地主。',
      'not-seated': '你不在牌桌上（可能已经离开）。',
      'bad-player': '玩家状态不对，请重试。',
      'full': '牌桌已经满了。',
    }

    /** All user-visible copy; this plugin ships Chinese only. */
    const zh = {
      nav: '牌桌联机',
      loading: '正在读取联机状态…',
      unavailable: '联机状态不可用',
      readFailedReason: '读取状态失败：{reason}',
      retry: '重试',
      actionFailed: '操作失败',
      actionFailedWith: '操作失败：{reason}',
      hint: '同一 Wi-Fi / 局域网内自动发现牌桌。房间名和 UDP 端口要一致；首次运行 Windows 可能弹防火墙提示，需要允许“专用网络”的 UDP 入站。',
      enabled: '开启局域网联机',
      room: '房间名',
      roomHint: '只有房间名相同的电脑才能互相发现；改房间名会清空发现列表并关闭牌桌。',
      port: 'UDP 端口',
      portHint: '两台电脑必须一致（默认 41235）；改端口会重新监听。',
      nick: '我的昵称',
      nickHint: '牌桌上别人看到的名字，1–24 个字符。',
      roomSettingsLabel: '房间设置（开桌时生效）',
      passwordEnabled: '启用房间密码',
      passwordLabel: '房间密码',
      passwordHint: '1–16 个字符；开启后入座和观战都要输入。密码只存在本机，不会以明文广播。',
      passwordRequired: '开启房间密码时必须填写密码（1–16 个字符）。',
      spectatorEnabled: '允许观战',
      spectatorEnabledHint: '开启后别人可以不占座位、只看牌局。',
      botCount: '机器人数量',
      botCountNone: '不补',
      botCountOne: '1 个',
      botCountTwo: '2 个',
      botCountHint: '最多补几个机器人（斗地主/跑得快需要 3 人）；后加入的真人会顶掉机器人；21 点不受影响。',
      noPlayersCard: '人数不足：斗地主/跑得快需要 3 人',
      botTag: '🤖 机器人',
      turnTimeout: '回合超时（秒）',
      turnTimeoutHint: '0–300 秒，0 表示关闭；超时房主会自动替当前玩家停牌。默认 45。',
      turnTimeoutInvalid: '回合超时必须是 0–300 的整数秒。',
      opacity: '牌桌透明度',
      opacityHint: '调低后牌桌更不显眼，文字也会一起变淡；鼠标移到牌桌上会临时恢复不透明。',
      opacityValue: '{n}%',
      displayLabel: '浮层显示设置',
      sizeLabel: '浮层大小',
      sizeSmall: '小',
      sizeMedium: '中',
      sizeLarge: '大',
      sizeHint: '改大小立即生效。',
      autoFadeLabel: '自动变淡',
      autoFadeHint: '鼠标离开浮层后自动变淡，移回或聚焦时恢复；关闭则一直保持上面的透明度。',
      resetPosition: '重置位置',
      resetPositionDone: '浮层位置已重置到右下角。',
      overlaySettings: '牌桌设置',
      overlaySettingsHint: '更多设置见 设置 → 牌桌联机。',
      done: '完成',
      hideOverlay: '隐藏浮层',
      showOverlay: '显示浮层',
      overlayHiddenHint: '牌桌浮层已隐藏，按 Ctrl+Shift+H 或点「显示浮层」恢复。',
      dragHint: '拖动标题栏可以移动浮层；快捷键 Ctrl+Shift+H 隐藏/显示浮层。',
      save: '保存',
      saved: '已保存，联机设置立即生效。',
      saveFailed: '保存失败',
      refresh: '刷新',
      udpOnline: 'UDP 已监听',
      udpOffline: 'UDP 未监听',
      boundPort: '端口 {port}',
      peerCount: '发现 {n} 个对端',
      noPeers: '还没发现同房间的电脑。确认对方也开了「牌桌联机」、连着同一个 Wi-Fi，并且房间名和端口一致。',
      lastError: '最近错误',
      reconnecting: '正在重连房主…',
      reconnectFailed: '重连失败',
      reconnectFailedDetail: '自动重连多次都失败了，可以手动再试一次。',
      rejoin: '重新连接',
      noticeRejoin: '正在重新连接房主…',
      hostClosed: '房主已关闭牌桌',
      hostClosedDetail: '牌桌已经结束，你已回到未入座状态。',
      disabledHint: '联机已关闭：本机不会广播，也看不到别人的牌桌。',
      stats: '已发 {sent} 包 · 已收 {received} 包 · 丢弃 {dropped} 包',
      createTable: '创建牌桌',
      closeTable: '关闭牌桌',
      startRound: '开始本局',
      nextRound: '下一局',
      leaveTable: '离开牌桌',
      join: '加入',
      online: '在线',
      playersN: '{n} 人',
      seatedHere: '已入座',
      foundTables: '局域网里的牌桌',
      roleHost: '我是房主',
      rolePlayer: '我在 {name} 的牌桌',
      roleNone: '未入座',
      roleHostHint: '把房间名和端口告诉朋友，他们出现在下面就能加入。',
      rolePlayerHint: '等房主开始本局，牌桌浮层会出现在右下角。',
      roleSpectator: '我在观战：{name} 的牌桌',
      roleSpectatorHint: '观战中，不参与出牌；牌桌浮层会显示在右下角。',
      roleNoneHint: '创建一张牌桌当房主，或加入下面发现的牌桌。',
      tableLabel: '我的牌桌',
      peerMeta: '{ip}:{port} · {s} 秒前在线',
      manualTitle: '手动加入（跨网段兜底）',
      ipPlaceholder: '对方 IP，例如 192.168.1.7',
      needIp: '请先填写对方 IP。',
      needPort: '端口需要 1024–65535 之间的整数。',
      manualBusyHint: '已经在牌桌上时不能加入别的牌桌。',
      peerPasswordPlaceholder: '房间密码',
      joinPasswordRequired: '这张牌桌需要密码，请先填写房间密码。',
      passwordTag: '密码',
      watch: '观战',
      spectatorCount: '观战 {n}',
      noticeJoinWatch: '已发送观战请求，等房主确认…',
      noticeOpen: '牌桌已创建，把房间名和端口告诉朋友。',
      noticeClose: '牌桌已关闭。',
      noticeStart: '本局开始。',
      noticeLeave: '已离开牌桌。',
      noticeJoin: '已发送入座请求，等房主确认…',
      tableTitle: '牌桌 · 第 {n} 局',
      tableTitleIdle: '牌桌 · 未开局',
      hostLabel: '房主',
      dealer: '庄家',
      noCards: '未发牌',
      hiddenCard: '盖牌',
      dealerTotal: '{total} 点',
      dealerHiddenTotal: '{total} + ?',
      points: '{n} 点',
      meSuffix: '（我）',
      acting: '行动中',
      scores: '胜 {win} · 负 {lose} · 平 {push}',
      hit: '要牌',
      stand: '停牌',
      minimize: '最小化',
      expand: '展开',
      capsuleDragHint: '拖动移动 · 点击展开',
      leave: '离开',
      staleTitle: '房主失联，等待重连…',
      staleDetail: '{s} 秒没有收到房主状态',
      yourTurn: '轮到你了',
      turnCountdown: '轮到你了 · 剩 {n} 秒（超时自动停牌）',
      waitOthers: '等待 {name} 行动…',
      waitHost: '等待房主的状态同步…',
      idleHostHint: '朋友加入后点「开始本局」。',
      waitHostStart: '等待房主开始本局…',
      dealerRunning: '庄家在补牌…',
      resultHostHint: '本局结束，点「下一局」再来一局。',
      waitHostNext: '本局结束，等房主开下一局。',
      resultWin: '本局你赢了',
      resultLose: '本局你输了',
      resultPush: '本局平局',
      resultOver: '本局结束',
      logTitle: '牌局记录',
      capsule: '21 点 · 第 {n} 局',
      capsuleIdle: '21 点 · 未开局',
      capsuleStale: '失联',
      capsuleReconnecting: '重连中',
      spectatorBadge: '观战中',
      spectatorHint: '观战中，不参与出牌',
      gameLabel: '玩法',
      ddzTitle: '斗地主 · 第 {n} 局',
      ddzTitleIdle: '斗地主 · 未开局',
      ddzCapsule: '斗地主 · 第 {n} 局',
      ddzCapsuleIdle: '斗地主 · 未开局',
      ddzLandlord: '地主',
      ddzFarmer: '农民',
      ddzLandlordMark: '地主：{name}',
      ddzCount: '剩 {n} 张',
      ddzNoCards: '未发牌',
      ddzOut: '已出完',
      ddzBid: '叫地主',
      ddzPassBid: '不叫',
      ddzPlay: '出牌',
      ddzPass: '不要',
      ddzStart: '开始本局',
      ddzNextRound: '开始下一局',
      ddzNewTrick: '新一墩',
      ddzLastPlayBy: '{name} 出了',
      ddzMustPlay: '轮到你领出（必须出牌）',
      ddzYourBid: '轮到你叫地主',
      ddzWaitBid: '等待 {name} 叫地主…',
      ddzYourPlay: '轮到你出牌',
      ddzWaitPlay: '等待 {name} 出牌…',
      ddzIdleHost: '点「开始本局」发牌。',
      ddzWaitStart: '等待房主开始本局…',
      ddzResultHost: '本局结束，点「开始下一局」再来一局。',
      ddzWaitNext: '本局结束，等房主开下一局。',
      ddzLandlordWin: '地主胜',
      ddzFarmerWin: '农民胜',
      ddzRoundOver: '本局结束',
      ddzIWin: '你赢了',
      ddzILose: '你输了',
      ddzMyHand: '我的手牌（{n} 张）',
      ddzSelected: '已选 {n} 张',
      ddzScores: '胜 {win} · 负 {lose}',
      ddzCountdown: '剩 {n} 秒',
      ddzWaitHostState: '等待房主的状态同步…',
      pkTitle: '跑得快 · 第 {n} 局',
      pkTitleIdle: '跑得快 · 未开局',
      pkCapsule: '跑得快 · 第 {n} 局',
      pkCapsuleIdle: '跑得快 · 未开局',
      pkMustPlay: '这手必须管上，不能不要',
    }

    /** Tiny `{name}` interpolator for the copy above. */
    function fmt(template, params) {
      const text = typeof template === 'string' ? template : ''
      if (params === undefined || params === null) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (
        params[name] === undefined ? match : String(params[name])
      ))
    }

    /* ------------------------------------------------------------------ *
     * Defensive readers: the view comes from another process, so every field
     * is treated as untrusted until checked.
     * ------------------------------------------------------------------ */

    /** An array or an empty one. */
    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    /** A non-array object or null. */
    function asObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    }

    /** A non-empty string or `fallback` (default ''). */
    function asString(value, fallback) {
      if (typeof value === 'string' && value !== '') return value
      return fallback === undefined ? '' : fallback
    }

    /** A finite number or `fallback`. */
    function asNumber(value, fallback) {
      return Number.isFinite(value) ? value : fallback
    }

    /* ------------------------------------------------------------------ *
     * Transport
     * ------------------------------------------------------------------ */

    /** POST JSON and always resolve to a parsed object (never throws). */
    async function postJson(path, body) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const parsed = await response.json().catch(() => null)
        if (parsed !== null && typeof parsed === 'object') return parsed
        return { ok: false, error: 'HTTP ' + response.status }
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }

    /* ------------------------------------------------------------------ *
     * Cards and table vocabulary
     * ------------------------------------------------------------------ */

    /**
     * Decode one card code: rank + suit, suit is the last character
     * ('AS' → A♠, '10H' → 10♥, 'KD' → K♦, '7C' → 7♣). Dou Dizhu jokers are
     * the whole code ('BJ' → 小王, 'RJ' → 大王). Unknown shapes fall back to
     * the raw string so a bad payload can never throw.
     */
    function readCard(card) {
      const raw = typeof card === 'string' ? card.trim() : ''
      if (raw.length < 2) return { text: raw === '' ? '?' : raw, red: false }
      const upper = raw.toUpperCase()
      if (upper === 'BJ') return { text: '小王', red: false }
      if (upper === 'RJ') return { text: '大王', red: true }
      const suit = upper.slice(-1)
      const rank = upper.slice(0, -1)
      const glyph = SUIT_GLYPHS[suit]
      if (glyph === undefined || rank === '') return { text: raw, red: false }
      return { text: rank + glyph, red: RED_SUITS[suit] === true }
    }

    /** Normalize an untrusted game id (PROTOCOL §7.1/§7.7). */
    function gameOf(value) {
      return value === 'doudizhu' || value === 'paodekuai' ? value : DEFAULT_GAME
    }

    /** Human label for one game id. */
    function gameLabelOf(value) {
      return GAME_LABELS[gameOf(value)]
    }

    /** True for the two card-game tables that share the Doudizhu-style layout. */
    function isCardGameId(game) {
      return game === 'doudizhu' || game === 'paodekuai'
    }

    /** Phase label for the active game. */
    function phaseLabelFor(game, phase) {
      const labels = game === 'doudizhu' ? DDZ_PHASES : (game === 'paodekuai' ? PDK_PHASES : PHASES)
      return labels[phase] !== undefined ? labels[phase] : phase
    }

    /** Overlay title for the active game ("21 点 · 第 2 局" etc.). */
    function gameTitleOf(game, round) {
      if (game === 'doudizhu') return round > 0 ? fmt(zh.ddzTitle, { n: round }) : zh.ddzTitleIdle
      if (game === 'paodekuai') return round > 0 ? fmt(zh.pkTitle, { n: round }) : zh.pkTitleIdle
      return round > 0 ? fmt(zh.tableTitle, { n: round }) : zh.tableTitleIdle
    }

    /** Minimised-capsule title for the active game. */
    function gameCapsuleTitleOf(game, round) {
      if (game === 'doudizhu') return round > 0 ? fmt(zh.ddzCapsule, { n: round }) : zh.ddzCapsuleIdle
      if (game === 'paodekuai') return round > 0 ? fmt(zh.pkCapsule, { n: round }) : zh.pkCapsuleIdle
      return round > 0 ? fmt(zh.capsule, { n: round }) : zh.capsuleIdle
    }

    /** Rank order of one Dou Dizhu card code (unknown codes sort first). */
    function ddzRankValue(card) {
      const raw = typeof card === 'string' ? card.trim().toUpperCase() : ''
      if (DDZ_RANK_ORDER[raw] !== undefined) return DDZ_RANK_ORDER[raw]
      const rank = raw.slice(0, -1)
      return DDZ_RANK_ORDER[rank] !== undefined ? DDZ_RANK_ORDER[rank] : 0
    }

    /** Hand order for display: by rank, then suit. */
    function sortDdzCards(cards) {
      return asArray(cards)
        .filter((card) => typeof card === 'string' && card !== '')
        .slice()
        .sort((left, right) => {
          const delta = ddzRankValue(left) - ddzRankValue(right)
          if (delta !== 0) return delta
          return asNumber(SUIT_ORDER[String(left).slice(-1).toUpperCase()], 9)
            - asNumber(SUIT_ORDER[String(right).slice(-1).toUpperCase()], 9)
        })
    }

    /**
     * Best (not busting) total — a UI-side mirror of `engine.handValue`, used
     * only when a player row arrives without a usable `total`.
     */
    function handTotal(cards) {
      let total = 0
      let aces = 0
      for (const card of asArray(cards)) {
        const raw = typeof card === 'string' ? card.trim().toUpperCase() : ''
        if (raw.length < 2) continue
        const rank = raw.slice(0, -1)
        if (rank === 'A') {
          total += 11
          aces += 1
        } else if (rank === 'J' || rank === 'Q' || rank === 'K') {
          total += 10
        } else {
          const value = Number(rank)
          if (Number.isFinite(value)) total += value
        }
      }
      while (total > 21 && aces > 0) {
        total -= 10
        aces -= 1
      }
      return total
    }

    /** Engine log entries are `{ at, text }`; older hosts may send strings. */
    function logText(entry) {
      if (typeof entry === 'string') return entry
      const record = asObject(entry)
      return record === null ? '' : asString(record.text, '')
    }

    /** The host's nickname as the table view knows it. */
    function hostNickOf(table) {
      const record = asObject(table)
      if (record === null) return '房主'
      const hostNode = asString(record.hostNode, '')
      for (const slot of asArray(record.players)) {
        const player = asObject(slot)
        if (player === null) continue
        if (hostNode !== '' && asString(player.node, '') === hostNode) return asString(player.nick, '房主')
      }
      return '房主'
    }

    /**
     * Turn a host error code into readable Chinese; unknown codes and network
     * failures are shown verbatim after a human prefix, never swallowed.
     */
    function errorText(error, game) {
      if (error === null || error === undefined) return ''
      const code = typeof error === 'string'
        ? error
        : (typeof error.message === 'string' ? error.message : String(error))
      const trimmed = code.trim()
      if (trimmed === '') return ''
      // Pao De Kuai's must-play rule reads differently from Doudizhu's: there
      // it means "you can beat this, so you must" (PROTOCOL §7.6).
      if (trimmed === 'must-play' && game === 'paodekuai') return zh.pkMustPlay
      // Dou Dizhu / Pao De Kuai need 3 seats; short tables report `no-players`.
      if (trimmed === 'no-players' && isCardGameId(game)) return zh.noPlayersCard
      return ERROR_TEXT[trimmed] !== undefined ? ERROR_TEXT[trimmed] : fmt(zh.actionFailedWith, { reason: trimmed })
    }

    /**
     * `view.lastError` carries host-side codes too (config rejections and
     * join-rejection reasons such as `join-password`). Known codes become
     * readable Chinese; unknown ones are shown verbatim so a failed join is
     * never silent.
     */
    function lastErrorText(error) {
      if (error === null || error === undefined) return ''
      const raw = typeof error === 'string' ? error : String(error)
      const mapped = ERROR_TEXT[raw.trim()]
      return mapped !== undefined ? mapped : raw
    }

    /** Overlay size preset from the (untrusted) config value. */
    function overlaySizeOf(config) {
      const record = asObject(config)
      const size = record !== null ? record.overlaySize : undefined
      return typeof size === 'string' && OVERLAY_WIDTHS[size] !== undefined ? size : DEFAULT_SIZE
    }

    /** Saved overlay position from config, or null for the default corner. */
    function overlayPositionOf(config) {
      const record = asObject(config)
      if (record === null) return null
      if (!Number.isFinite(record.overlayX) || !Number.isFinite(record.overlayY)) return null
      return { x: Number(record.overlayX), y: Number(record.overlayY) }
    }

    /** Clamp a floating-overlay position into the viewport (title bar always visible). */
    function clampOverlayPosition(x, y, width, height) {
      const viewportW = asNumber(window.innerWidth, 1280)
      const viewportH = asNumber(window.innerHeight, 800)
      const panelWidth = Math.max(160, Math.min(
        asNumber(width, OVERLAY_WIDTHS[DEFAULT_SIZE]),
        viewportW - 2 * DEFAULT_EDGE,
      ))
      const panelHeight = asNumber(height, 0)
      const minX = 8
      const minY = 8
      const maxX = Math.max(minX, viewportW - panelWidth - 8)
      // Prefer keeping the whole panel on screen; fall back to title-bar reach
      // when the panel is taller than the viewport.
      const maxY = panelHeight > 0 && panelHeight < viewportH - 2 * minY
        ? Math.max(minY, viewportH - panelHeight - 8)
        : Math.max(minY, viewportH - 88)
      return {
        x: Math.round(Math.min(maxX, Math.max(minX, asNumber(x, minX)))),
        y: Math.round(Math.min(maxY, Math.max(minY, asNumber(y, minY)))),
      }
    }

    /* ------------------------------------------------------------------ *
     * One shared polling store: the overlay and the settings page read the
     * same snapshot, so two visible surfaces never double the request rate.
     * ------------------------------------------------------------------ */

    function createCardLanStore() {
      let state = { data: null, error: null }
      const listeners = new Set()
      let timer = null
      let inflight = false

      const publish = (next) => {
        state = next
        for (const listener of [...listeners]) listener()
      }

      const tick = async () => {
        if (inflight) return
        inflight = true
        try {
          const response = await fetch(VIEW_URL, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const data = await response.json()
          publish({ data: asObject(data), error: null })
        } catch (error) {
          // Keep the last good view on screen; surface the reason instead.
          publish({ data: state.data, error: String(error && error.message ? error.message : error) })
        } finally {
          inflight = false
        }
      }

      const onVisibility = () => {
        if (document.visibilityState === 'visible') void tick()
      }

      const start = () => {
        if (timer !== null) return
        void tick()
        timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void tick()
        }, POLL_MS)
        document.addEventListener('visibilitychange', onVisibility)
      }

      const stop = () => {
        if (timer === null) return
        window.clearInterval(timer)
        timer = null
        document.removeEventListener('visibilitychange', onVisibility)
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          start()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
        getSnapshot() {
          return state
        },
        refresh: tick,
        async action(body) {
          const result = await postJson(ACTION_URL, body)
          await tick()
          return result
        },
        async configure(patch) {
          const result = await postJson(CONFIG_URL, patch)
          await tick()
          return result
        },
      }
    }

    const store = createCardLanStore()
    // Keep polling alive independently of the surfaces: the overlay returns
    // null while seatless, and React may unmount the settings page entirely.
    const releaseStore = store.subscribe(() => {})

    /**
     * Preview override for the table overlay opacity: the lobby slider writes
     * here so the floating table updates before the host round-trip lands.
     * `null` means "follow the host config".
     */
    const opacityStore = (() => {
      let value = null
      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return value
        },
        set(next) {
          if (next === null || next === undefined) {
            value = null
          } else {
            const numeric = Number(next)
            value = Number.isFinite(numeric) ? Math.min(1, Math.max(MIN_OPACITY, numeric)) : value
          }
          publish()
        },
      }
    })()

    /**
     * Hidden/shown state of the floating table (Ctrl+Shift+H). Lives outside
     * React so the shortcut registered in `apply` can drive it even while the
     * overlay is unmounted, and so the lobby can mirror a hide/show button.
     */
    const overlayVisibility = (() => {
      let hidden = false
      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return hidden
        },
        set(next) {
          const value = next === true
          if (value === hidden) return
          hidden = value
          publish()
        },
        toggle() {
          hidden = !hidden
          publish()
        },
      }
    })()

    /* ------------------------------------------------------------------ *
     * Small presentational pieces
     * ------------------------------------------------------------------ */

    /** One playing card: text glyph only, red for hearts and diamonds. */
    function CardChip(props) {
      if (props.hidden === true) {
        return h('span', {
          className: 'dsh-card-lan-card is-back',
          title: zh.hiddenCard,
          'aria-label': zh.hiddenCard,
        })
      }
      const card = readCard(props.card)
      return h('span', {
        className: 'dsh-card-lan-card' + (card.red ? ' is-red' : ''),
        title: card.text,
        'aria-label': card.text,
      }, card.text)
    }

    /** A hand of cards; `hidden` appends the face-down hole card. */
    function Hand(props) {
      const cards = asArray(props.cards)
      const hidden = props.hidden === true
      if (cards.length === 0 && !hidden) {
        return h('span', { className: 'dsh-card-lan-empty' }, zh.noCards)
      }
      const nodes = []
      for (let index = 0; index < cards.length; index += 1) {
        nodes.push(h(CardChip, { key: 'card' + index, card: cards[index] }))
      }
      if (hidden) nodes.push(h(CardChip, { key: 'back', hidden: true }))
      return h('div', { className: 'dsh-card-lan-hand' }, nodes)
    }

    /** One Dou Dizhu card; when `onClick` is given the card is selectable. */
    function ddzCardNode(card, key, selected, onClick) {
      const face = readCard(card)
      const props = {
        key,
        className: 'dsh-card-lan-card dsh-card-lan-ddz-card'
          + (face.red ? ' is-red' : '')
          + (selected === true ? ' is-selected' : ''),
        title: face.text,
        'aria-label': face.text,
      }
      if (onClick !== null && onClick !== undefined) {
        props.role = 'button'
        props.tabIndex = 0
        props['aria-pressed'] = selected === true
        props.onClick = () => onClick(card)
        props.onKeyDown = (event) => {
          if (event === null || event === undefined) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick(card)
          }
        }
      }
      return h('span', props, face.text)
    }

    /**
     * Card-table body shared by Dou Dizhu (PROTOCOL §7.3) and Pao De Kuai
     * (§7.6): seats + last play + hand + play/pass. `props.game` switches the
     * game-specific extras (bidding + landlord only exist in Dou Dizhu).
     * A pure renderer: every value comes from the polled view, every write
     * goes back through a callback.
     */
    function buildCardGameContent(props) {
      const game = props.game === 'paodekuai' ? 'paodekuai' : 'doudizhu'
      const isPdk = game === 'paodekuai'
      const role = props.role
      const isSpectator = props.isSpectator === true
      const phase = props.phase
      const players = props.players
      const me = props.me
      const turnNode = asString(props.turnNode, '')
      const myNode = asString(props.myNode, '')
      const myCards = props.myCards
      const selectedCards = props.selectedCards
      const lastPlay = props.lastPlay
      const mustPlay = props.mustPlay === true
      const landlordPlayer = props.landlordPlayer
      const busy = props.busy === true
      const connectionBroken = props.connectionBroken === true
      const turnRemainingMs = asNumber(props.turnRemainingMs, -1)
      const activeTurn = !isSpectator && turnNode !== '' && turnNode === myNode

      const playerByNode = (node) => {
        const target = asString(node, '')
        for (const slot of players) {
          if (asString(slot.node, '') === target) return slot
        }
        return undefined
      }

      /* ---------- header extras: game pill, landlord (DDZ), countdown ---------- */
      const headExtras = [
        h('span', { key: 'game', className: 'dsh-card-lan-pill is-game-' + game }, GAME_LABELS[game]),
      ]
      if (!isPdk && landlordPlayer !== undefined) {
        headExtras.push(h('span', { key: 'landlord', className: 'dsh-card-lan-tag is-landlord' },
          fmt(zh.ddzLandlordMark, { name: asString(landlordPlayer.nick, zh.ddzLandlord) })))
      }
      if ((phase === 'bidding' || phase === 'playing') && turnRemainingMs >= 0) {
        headExtras.push(h('span', { key: 'countdown', className: 'dsh-card-lan-tag is-turn' },
          fmt(zh.ddzCountdown, { n: Math.max(0, Math.ceil(turnRemainingMs / 1000)) })))
      }

      /* ---------- hint line ---------- */
      let hint = ''
      if (isSpectator) {
        hint = zh.spectatorHint
      } else if (phase === 'idle') {
        hint = role === 'host' ? zh.ddzIdleHost : zh.ddzWaitStart
      } else if (phase === 'bidding') {
        if (activeTurn) hint = zh.ddzYourBid
        else hint = props.turnNick !== '' ? fmt(zh.ddzWaitBid, { name: props.turnNick }) : zh.ddzWaitHostState
      } else if (phase === 'playing') {
        if (activeTurn) hint = zh.ddzYourPlay
        else hint = props.turnNick !== '' ? fmt(zh.ddzWaitPlay, { name: props.turnNick }) : zh.ddzWaitHostState
      } else if (phase === 'result') {
        hint = role === 'host' ? zh.ddzResultHost : zh.ddzWaitNext
      }

      const bodyNodes = []

      /* ---------- other seats: role, remaining cards, turn, out ---------- */
      const others = players.filter((slot) => slot !== me)
      for (const slot of others) {
        const node = asString(slot.node, '')
        const nick = asString(slot.nick, '玩家')
        const rawSeatRole = asString(slot.role, '')
        const seatRole = rawSeatRole === 'landlord' ? 'landlord' : 'farmer'
        const status = asString(slot.status, 'playing')
        const count = Math.max(0, asNumber(slot.count, 0))
        const isTurn = (phase === 'bidding' || phase === 'playing') && node !== '' && node === turnNode
        const bidding = slot.bidding
        const seatResult = asString(slot.result, '')
        const classes = ['dsh-card-lan-row', 'dsh-card-lan-ddz-seat']
        if (isTurn) classes.push('is-turn')
        if (status === 'out') classes.push('is-out')
        const tags = []
        // Machine seats are labelled next to the nickname (PROTOCOL §7.9);
        // their hand stays hidden behind the usual remaining-card counter.
        if (slot.bot === true) {
          tags.push(h('span', { key: 'bot', className: 'dsh-card-lan-bot-tag', title: zh.botTag }, zh.botTag))
        }
        // Before the landlord is decided every seat has role null; showing a
        // random 农民 tag there would be a lie.
        if (rawSeatRole === 'landlord' || rawSeatRole === 'farmer') {
          tags.push(h('span', {
            key: 'role',
            className: 'dsh-card-lan-tag is-ddz-role ' + (seatRole === 'landlord' ? 'is-landlord' : 'is-farmer'),
          }, seatRole === 'landlord' ? zh.ddzLandlord : zh.ddzFarmer))
        }
        tags.push(h('span', { key: 'count', className: 'dsh-card-lan-tag' },
          phase === 'idle'
            ? zh.ddzNoCards
            : (status === 'out' ? zh.ddzOut : fmt(zh.ddzCount, { n: count }))))
        if (isTurn) tags.push(h('span', { key: 'turn', className: 'dsh-card-lan-tag is-turn' }, zh.acting))
        if (phase === 'bidding' && bidding === true) {
          tags.push(h('span', { key: 'bid', className: 'dsh-card-lan-tag is-bid' }, zh.ddzBid))
        } else if (phase === 'bidding' && bidding === false) {
          tags.push(h('span', { key: 'bid', className: 'dsh-card-lan-tag' }, zh.ddzPassBid))
        }
        if (seatResult === 'win') {
          tags.push(h('span', { key: 'result', className: 'dsh-card-lan-tag is-result-win' }, RESULTS.win))
        } else if (seatResult === 'lose') {
          tags.push(h('span', { key: 'result', className: 'dsh-card-lan-tag is-result-lose' }, RESULTS.lose))
        }
        bodyNodes.push(h('div', {
          key: 'seat:' + (node !== '' ? node : nick),
          className: classes.join(' '),
        }, [
          h('div', { key: 'head', className: 'dsh-card-lan-row-head' }, [
            h('span', { key: 'name', className: 'dsh-card-lan-name' },
              nick + (slot.self === true ? zh.meSuffix : '')),
            ...tags,
          ]),
        ]))
      }

      /* ---------- middle: last play / new trick (nothing before the deal) ---------- */
      if (phase !== 'idle' && lastPlay !== null && lastPlay !== undefined) {
        const lastCards = asArray(lastPlay.cards)
        const lastPlayer = playerByNode(lastPlay.node)
        const lastNick = lastPlayer !== undefined ? asString(lastPlayer.nick, '玩家') : '玩家'
        const label = asString(lastPlay.label, '')
        bodyNodes.push(h('div', { key: 'lastPlay', className: 'dsh-card-lan-ddz-play' }, [
          h('span', { key: 'who', className: 'dsh-card-lan-ddz-who' }, fmt(zh.ddzLastPlayBy, { name: lastNick })),
          ...lastCards.map((card, index) => h(CardChip, { key: 'lp' + index, card })),
          label !== '' ? h('span', { key: 'label', className: 'dsh-card-lan-tag' }, label) : null,
        ]))
      } else if (phase !== 'idle') {
        bodyNodes.push(h('div', { key: 'lastPlay', className: 'dsh-card-lan-ddz-play is-new' }, [
          h('span', { key: 'text', className: 'dsh-card-lan-ddz-who' }, zh.ddzNewTrick),
        ]))
      }
      if (mustPlay && activeTurn) {
        bodyNodes.push(h('p', { key: 'mustPlay', className: 'dsh-card-lan-ddz-must' }, zh.ddzMustPlay))
      }

      /* ---------- my hand (players only; spectators never see hands) ---------- */
      if (!isSpectator && me !== undefined && phase !== 'idle') {
        const canSelect = phase === 'playing' && !busy && !connectionBroken
        const handHead = [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, fmt(zh.ddzMyHand, { n: myCards.length })),
          selectedCards.length > 0
            ? h('span', { key: 'sel', className: 'dsh-card-lan-tag is-turn' },
              fmt(zh.ddzSelected, { n: selectedCards.length }))
            : null,
          activeTurn ? h('span', { key: 'turn', className: 'dsh-card-lan-tag is-turn' }, zh.acting) : null,
          props.myScore !== null && props.myScore !== undefined
            ? h('span', { key: 'score', className: 'dsh-card-lan-muted dsh-card-lan-tiny' }, fmt(zh.ddzScores, {
              win: asNumber(props.myScore.win, 0),
              lose: asNumber(props.myScore.lose, 0),
            }))
            : null,
        ]
        bodyNodes.push(h('div', { key: 'myHand', className: 'dsh-card-lan-ddz-hand-area' }, [
          h('div', { key: 'head', className: 'dsh-card-lan-row-head' }, handHead),
          myCards.length > 0
            ? h('div', { key: 'cards', className: 'dsh-card-lan-ddz-hand' }, myCards.map((card) => ddzCardNode(
              card,
              'hand:' + card,
              selectedCards.indexOf(card) !== -1,
              canSelect ? props.toggleCard : null,
            )))
            : h('span', { key: 'empty', className: 'dsh-card-lan-empty' }, zh.ddzOut),
        ]))
      }

      /* ---------- result banner: landlord/farmer side (DDZ) or my win/lose ---------- */
      if (phase === 'result') {
        const mine = me !== undefined ? asString(me.result, '') : ''
        const mineText = mine === 'win' ? zh.ddzIWin : (mine === 'lose' ? zh.ddzILose : '')
        const bannerClass = 'dsh-card-lan-banner '
          + (mine === 'win' ? 'is-win' : (mine === 'lose' ? 'is-lose' : 'is-none'))
        if (isPdk) {
          // Pao De Kuai has no landlord: only my own win/lose is meaningful.
          bodyNodes.push(h('div', { key: 'result', className: bannerClass, role: 'status' }, [
            h('span', { key: 'mine' }, mineText !== '' ? mineText : zh.ddzRoundOver),
          ]))
        } else {
          const landlordWon = landlordPlayer !== undefined && asString(landlordPlayer.result, '') === 'win'
          const sideText = landlordPlayer === undefined
            ? zh.ddzRoundOver
            : (landlordWon ? zh.ddzLandlordWin : zh.ddzFarmerWin)
          bodyNodes.push(h('div', { key: 'result', className: bannerClass, role: 'status' }, [
            h('span', { key: 'side' }, sideText),
            mineText !== '' ? h('span', { key: 'mine', className: 'dsh-card-lan-ddz-result-mine' }, mineText) : null,
          ]))
        }
      }

      /* ---------- buttons ---------- */
      const actionNodes = []
      if (!isPdk && phase === 'bidding' && activeTurn) {
        actionNodes.push(h('button', {
          key: 'bid',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy || connectionBroken,
          onClick: () => props.bidTurn(true),
        }, zh.ddzBid))
        actionNodes.push(h('button', {
          key: 'passBid',
          type: 'button',
          className: 'dsh-card-lan-button',
          disabled: busy || connectionBroken,
          onClick: () => props.bidTurn(false),
        }, zh.ddzPassBid))
      } else if (phase === 'playing' && activeTurn) {
        actionNodes.push(h('button', {
          key: 'play',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy || connectionBroken || selectedCards.length === 0,
          onClick: () => void props.playSelected(),
        }, zh.ddzPlay))
        actionNodes.push(h('button', {
          key: 'pass',
          type: 'button',
          className: 'dsh-card-lan-button',
          disabled: busy || connectionBroken || mustPlay,
          onClick: () => props.passTurn(),
        }, zh.ddzPass))
      }
      if (role === 'host' && (phase === 'idle' || phase === 'result')) {
        actionNodes.push(h('button', {
          key: 'start',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy || connectionBroken,
          onClick: () => void props.startRound(),
        }, phase === 'result' ? zh.ddzNextRound : zh.ddzStart))
      }

      return { headExtras, hint, bodyNodes, actionNodes }
    }

    /** One seat in the table overlay: cards, total, status, result, score. */
    function PlayerRow(props) {
      const player = props.player
      const cards = asArray(player.cards)
      const total = Number.isFinite(player.total) ? player.total : handTotal(cards)
      const status = asString(player.status, 'playing')
      const result = asString(player.result, '')
      // Spectator views never carry a "(我)" badge (PROTOCOL.md §5 overlay 8).
      const isSelf = props.showSelf !== false && player.self === true
      const isTurn = props.isTurn === true
      const score = asObject(props.score)
      const classes = ['dsh-card-lan-row']
      if (isSelf) classes.push('is-self')
      if (isTurn) classes.push('is-turn')
      if (result !== '') classes.push('is-' + result)

      const head = h('div', { key: 'head', className: 'dsh-card-lan-row-head' }, [
        h('span', { key: 'name', className: 'dsh-card-lan-name' },
          asString(player.nick, '玩家') + (isSelf ? zh.meSuffix : '')),
        h('span', { key: 'status', className: 'dsh-card-lan-tag is-' + status },
          (STATUSES[status] !== undefined ? STATUSES[status] : status)
          + (cards.length > 0 ? ' · ' + fmt(zh.points, { n: total }) : '')),
        result !== '' ? h('span', {
          key: 'result',
          className: 'dsh-card-lan-tag is-result-' + result,
        }, RESULTS[result] !== undefined ? RESULTS[result] : result) : null,
        isTurn ? h('span', { key: 'turn', className: 'dsh-card-lan-tag is-turn' }, zh.acting) : null,
        score !== null ? h('span', { key: 'score', className: 'dsh-card-lan-muted dsh-card-lan-tiny' }, fmt(zh.scores, {
          win: asNumber(score.win, 0),
          lose: asNumber(score.lose, 0),
          push: asNumber(score.push, 0),
        })) : null,
      ])

      return h('div', { className: classes.join(' ') }, [
        head,
        h(Hand, { key: 'hand', cards }),
      ])
    }

    /* ------------------------------------------------------------------ *
     * settings.section: the lobby
     * ------------------------------------------------------------------ */

    /**
     * The settings page: LAN knobs, live discovery and the local seat.
     * Every value comes from the polled view — a failed poll keeps the last
     * good view and shows the reason.
     */
    function LobbySection() {
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const hiddenOverlay = useSyncExternalStore(overlayVisibility.subscribe, overlayVisibility.getSnapshot)
      const data = snapshot.data
      const [form, setForm] = useState(null)
      const [manual, setManual] = useState({ ip: '', port: '41235', password: '' })
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [peerPasswords, setPeerPasswords] = useState({})
      const [opacityDraft, setOpacityDraft] = useState(null)
      const [sizeDraft, setSizeDraft] = useState(null)
      const [autoFadeDraft, setAutoFadeDraft] = useState(null)
      const [botCountDraft, setBotCountDraft] = useState(null)
      const [gameDraft, setGameDraft] = useState(null)
      const opacityTimer = useRef(null)
      const seeded = useRef(false)

      // Seed the editable form from the first good view only: a poll must never
      // clobber what the user is currently typing.
      useEffect(() => {
        if (seeded.current || data === null || data.ok === false) return
        const config = asObject(data.config)
        if (config === null) return
        seeded.current = true
        const port = asNumber(config.port, 41235)
        setForm({
          enabled: config.enabled !== false,
          room: asString(config.room, 'dsh-card'),
          port,
          nick: asString(config.nick, ''),
          passwordEnabled: config.passwordEnabled === true,
          password: asString(config.password, ''),
          spectatorEnabled: config.spectatorEnabled !== false,
          turnTimeout: Number.isFinite(config.turnTimeout)
            ? Math.min(MAX_TURN_TIMEOUT, Math.max(0, Math.round(config.turnTimeout)))
            : DEFAULT_TURN_TIMEOUT,
        })
        setManual({ ip: '', port: String(port), password: '' })
      }, [data])

      // Display preferences draft locally; the host value wins once the save
      // round-trip lands in the polled view. Nothing here paints a guess: the
      // drafts only mask the sub-second gap while a PATCH is in flight.
      const previewConfig = data !== null && data.ok !== false ? asObject(data.config) : null
      const configOpacity = previewConfig !== null && Number.isFinite(previewConfig.overlayOpacity)
        ? Math.min(1, Math.max(MIN_OPACITY, Number(previewConfig.overlayOpacity)))
        : DEFAULT_OPACITY
      const configSize = overlaySizeOf(previewConfig)
      const configAutoFade = previewConfig !== null ? previewConfig.autoFade !== false : true
      // Bot back-fill count (PROTOCOL §7.8): 0..2, migrated from the old boolean
      // `fillBots` (true → 2, false → 0) when an older host only exposes that.
      const configBotCount = previewConfig === null
        ? 0
        : (Number.isInteger(previewConfig.botCount)
          ? Math.min(MAX_BOT_COUNT, Math.max(0, previewConfig.botCount))
          : (previewConfig.fillBots === true ? MAX_BOT_COUNT : 0))
      const effectiveOpacity = opacityDraft !== null ? opacityDraft : configOpacity
      const effectiveSize = sizeDraft !== null ? sizeDraft : configSize
      const effectiveAutoFade = autoFadeDraft !== null ? autoFadeDraft : configAutoFade
      const effectiveBotCount = botCountDraft !== null ? botCountDraft : configBotCount
      // Game picker for the next 创建牌桌 (PROTOCOL §7.1): defaults to the
      // host's persisted config.game, not saved with the rest of the form.
      const configGame = gameOf(previewConfig !== null ? previewConfig.game : DEFAULT_GAME)
      const effectiveGame = gameDraft !== null ? gameDraft : configGame

      useEffect(() => {
        setOpacityDraft(null)
      }, [configOpacity])

      useEffect(() => {
        setSizeDraft(null)
      }, [configSize])

      useEffect(() => {
        setAutoFadeDraft(null)
      }, [configAutoFade])

      useEffect(() => {
        setBotCountDraft(null)
      }, [configBotCount])

      useEffect(() => {
        setGameDraft(null)
      }, [configGame])

      useEffect(() => () => {
        if (opacityTimer.current !== null) window.clearTimeout(opacityTimer.current)
      }, [])

      const showNotice = (text, isError) => {
        setNotice(text === undefined || text === null || text === '' ? null : { text, error: isError === true })
      }

      const save = async () => {
        if (form === null) return
        // Password is required exactly when the host turns it on (PROTOCOL §3.2).
        if (form.passwordEnabled === true && String(form.password).trim() === '') {
          showNotice(zh.passwordRequired, true)
          return
        }
        // Turn timeout is integer seconds in [0, 300]; 0 disables it.
        const turnTimeout = Number(form.turnTimeout)
        if (!Number.isInteger(turnTimeout) || turnTimeout < 0 || turnTimeout > MAX_TURN_TIMEOUT) {
          showNotice(zh.turnTimeoutInvalid, true)
          return
        }
        setBusy(true)
        showNotice('')
        const result = await store.configure({
          enabled: form.enabled,
          room: form.room,
          port: form.port,
          nick: form.nick,
          passwordEnabled: form.passwordEnabled === true,
          password: form.passwordEnabled === true ? form.password : '',
          spectatorEnabled: form.spectatorEnabled === true,
          turnTimeout,
        })
        setBusy(false)
        if (result.ok === true) showNotice(zh.saved, false)
        else showNotice(errorText(result.error) || zh.saveFailed, true)
      }

      /** Slider commit: preview immediately, persist after a short pause. */
      const changeOpacity = (percent) => {
        const next = Math.min(1, Math.max(MIN_OPACITY, Number(percent) / 100))
        setOpacityDraft(next)
        opacityStore.set(next)
        if (opacityTimer.current !== null) window.clearTimeout(opacityTimer.current)
        opacityTimer.current = window.setTimeout(() => {
          opacityTimer.current = null
          void store.configure({ overlayOpacity: next }).then((result) => {
            if (result.ok !== true) {
              showNotice(errorText(result.error) || zh.saveFailed, true)
              return
            }
            const saved = result.config !== undefined && result.config !== null
              ? Number(result.config.overlayOpacity)
              : Number.NaN
            if (Number.isFinite(saved)) opacityStore.set(null)
          })
        }, 350)
      }

      /** Display prefs apply immediately; there is no need to press 保存. */
      const applyDisplay = async (patch, okText) => {
        const result = await store.configure(patch)
        if (result.ok === true) {
          if (okText !== undefined && okText !== '') showNotice(okText, false)
          return true
        }
        showNotice(errorText(result.error) || zh.saveFailed, true)
        return false
      }

      const changeSize = (next) => {
        const size = typeof next === 'string' && OVERLAY_WIDTHS[next] !== undefined ? next : DEFAULT_SIZE
        setSizeDraft(size)
        void applyDisplay({ overlaySize: size }).then((saved) => {
          if (!saved) setSizeDraft(null)
        })
      }

      const changeAutoFade = (checked) => {
        const value = checked === true
        setAutoFadeDraft(value)
        void applyDisplay({ autoFade: value }).then((saved) => {
          if (!saved) setAutoFadeDraft(null)
        })
      }

      /** Bot back-fill count (PROTOCOL §7.8): host-only, Dou Dizhu/Paodekuai. */
      const changeBotCount = (next) => {
        const numeric = Number(next)
        const value = Number.isInteger(numeric)
          ? Math.min(MAX_BOT_COUNT, Math.max(0, numeric))
          : 0
        setBotCountDraft(value)
        void applyDisplay({ botCount: value }).then((saved) => {
          // Failure: drop the optimistic draft so the select snaps back to the
          // host value; the notice from applyDisplay explains why.
          if (!saved) setBotCountDraft(null)
        })
      }

      const resetOverlayPosition = () => {
        void applyDisplay({ overlayX: null, overlayY: null }, zh.resetPositionDone)
      }

      /** Game context of the local table, for game-specific error wording. */
      const currentTableGame = () => {
        const tableNow = data !== null ? asObject(data.table) : null
        return tableNow !== null ? gameOf(tableNow.game) : DEFAULT_GAME
      }

      const act = async (body, successText) => {
        setBusy(true)
        showNotice('')
        const result = await store.action(body)
        setBusy(false)
        if (result.ok === true) showNotice(successText === undefined ? '' : successText, false)
        else showNotice(errorText(result.error, currentTableGame()) || zh.actionFailed, true)
        return result.ok === true
      }

      const joinManual = async () => {
        const ip = manual.ip.trim()
        const port = Number(manual.port)
        if (ip === '') {
          showNotice(zh.needIp, true)
          return
        }
        if (!Number.isFinite(port) || port < 1024 || port > 65535 || Math.round(port) !== port) {
          showNotice(zh.needPort, true)
          return
        }
        const body = { type: 'join', hostIp: ip, hostPort: port, role: 'player' }
        const password = String(manual.password).trim()
        if (password !== '') body.pw = password
        await act(body, zh.noticeJoin)
      }

      const head = h('div', { key: 'head', className: 'dsh-card-lan-lobby-head' }, [
        h('h3', { key: 'title', className: 'dsh-card-lan-title' }, zh.nav),
        h('p', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.hint),
      ])

      const config = data !== null ? asObject(data.config) : null
      const failed = data !== null && (data.ok === false || config === null)

      if (data === null || failed) {
        const message = data === null
          ? (snapshot.error !== null ? fmt(zh.readFailedReason, { reason: snapshot.error }) : zh.loading)
          : (errorText(data.error) || zh.unavailable)
        return h('div', { className: 'dsh-card-lan-section' }, [
          head,
          h('p', { key: 'state', className: 'dsh-card-lan-muted' }, message),
          h('button', {
            key: 'retry',
            type: 'button',
            className: 'dsh-card-lan-button',
            onClick: () => void store.refresh(),
          }, zh.retry),
        ])
      }

      const peers = asArray(data.peers)
      const hostRecord = asObject(data.host)
      const hostOpen = hostRecord !== null && hostRecord.open === true
      const table = asObject(data.table)
      const tableRole = table !== null ? asString(table.role, 'player') : ''
      const role = table === null ? null : (tableRole === 'host' ? 'host' : (tableRole === 'spectator' ? 'spectator' : 'player'))
      const tableGame = table !== null ? gameOf(table.game) : null
      const phase = table !== null ? asString(table.phase, 'idle') : ''
      const players = table !== null
        ? asArray(table.players).filter((slot) => asObject(slot) !== null)
        : []
      const canStart = role === 'host' && (phase === 'idle' || phase === 'result')
      const hostNick = role === 'player' || role === 'spectator' ? hostNickOf(table) : asString(config.nick, '房主')
      const enabled = data.enabled !== false
      const udpReady = data.udpReady === true
      const boundPort = asNumber(data.boundPort, 0)
      const lastError = data.lastError
      const stats = asObject(data.stats)
      const now = Date.now()
      // Connection state (PROTOCOL §2.5b/§2.5c, §3.1): dedicated UI, not just
      // another line in the error log.
      const reconnecting = data.reconnecting === true
      const lastErrorCode = lastError !== null && lastError !== undefined ? String(lastError) : ''
      const reconnectFailed = lastErrorCode === 'reconnect-failed'
      const hostClosedCode = lastErrorCode === 'host-closed'
      // These two get their own banner (the rejoin button lives there), so the
      // generic "最近错误" line would only duplicate them.
      const genericLastError = lastErrorCode !== '' && !reconnectFailed && !hostClosedCode
      // A stale `host-closed` can linger on the host side (creating a new table
      // does not clear it), so only treat it as current while we really are
      // seatless; otherwise the banner would lie about a healthy table.
      const hostClosed = hostClosedCode && role === null

      const fields = h('div', { key: 'fields', className: 'dsh-card-lan-fields' }, [
        h('label', { key: 'enabled', className: 'dsh-card-lan-check' }, [
          h('input', {
            key: 'input',
            type: 'checkbox',
            checked: form !== null && form.enabled === true,
            disabled: form === null || busy,
            onChange: (event) => setForm((current) => (
              current === null ? current : { ...current, enabled: event.target.checked }
            )),
          }),
          h('span', { key: 'label' }, zh.enabled),
        ]),
        h('label', { key: 'room', className: 'dsh-card-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.room),
          h('input', {
            key: 'input',
            className: 'dsh-card-lan-input',
            type: 'text',
            maxLength: 32,
            value: form !== null ? form.room : '',
            disabled: form === null || busy,
            onChange: (event) => setForm((current) => (
              current === null ? current : { ...current, room: event.target.value }
            )),
          }),
          h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.roomHint),
        ]),
        h('label', { key: 'port', className: 'dsh-card-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.port),
          h('input', {
            key: 'input',
            className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
            type: 'number',
            min: 1024,
            max: 65535,
            step: 1,
            value: form !== null ? form.port : '',
            disabled: form === null || busy,
            onChange: (event) => setForm((current) => (
              current === null ? current : { ...current, port: Number(event.target.value) }
            )),
          }),
          h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.portHint),
        ]),
        h('label', { key: 'nick', className: 'dsh-card-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.nick),
          h('input', {
            key: 'input',
            className: 'dsh-card-lan-input',
            type: 'text',
            maxLength: 24,
            value: form !== null ? form.nick : '',
            disabled: form === null || busy,
            onChange: (event) => setForm((current) => (
              current === null ? current : { ...current, nick: event.target.value }
            )),
          }),
          h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.nickHint),
        ]),
        h('div', { key: 'roomSettings', className: 'dsh-card-lan-field dsh-card-lan-settings-block' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.roomSettingsLabel),
          h('label', { key: 'passwordEnabled', className: 'dsh-card-lan-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              'aria-label': zh.passwordEnabled,
              checked: form !== null && form.passwordEnabled === true,
              disabled: form === null || busy,
              onChange: (event) => setForm((current) => (
                current === null ? current : { ...current, passwordEnabled: event.target.checked }
              )),
            }),
            h('span', { key: 'label' }, zh.passwordEnabled),
          ]),
          form !== null && form.passwordEnabled
            ? h('input', {
              key: 'password',
              className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
              type: 'text',
              maxLength: 16,
              'aria-label': zh.passwordLabel,
              placeholder: zh.passwordLabel,
              value: form.password,
              disabled: busy,
              onChange: (event) => setForm((current) => (
                current === null ? current : { ...current, password: event.target.value }
              )),
            })
            : null,
          h('span', { key: 'passwordHint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.passwordHint),
          h('label', { key: 'spectatorEnabled', className: 'dsh-card-lan-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              'aria-label': zh.spectatorEnabled,
              checked: form !== null && form.spectatorEnabled === true,
              disabled: form === null || busy,
              onChange: (event) => setForm((current) => (
                current === null ? current : { ...current, spectatorEnabled: event.target.checked }
              )),
            }),
            h('span', { key: 'label' }, zh.spectatorEnabled),
          ]),
          h('span', { key: 'spectatorHint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.spectatorEnabledHint),
          h('label', { key: 'botCount', className: 'dsh-card-lan-field' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.botCount),
            h('select', {
              key: 'select',
              className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
              'aria-label': zh.botCount,
              value: String(effectiveBotCount),
              disabled: busy,
              onChange: (event) => changeBotCount(Number(event.target.value)),
            }, [
              h('option', { key: '0', value: '0' }, zh.botCountNone),
              h('option', { key: '1', value: '1' }, zh.botCountOne),
              h('option', { key: '2', value: '2' }, zh.botCountTwo),
            ]),
            h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.botCountHint),
          ]),
          h('label', { key: 'turnTimeout', className: 'dsh-card-lan-field' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.turnTimeout),
            h('input', {
              key: 'input',
              className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
              type: 'number',
              min: 0,
              max: MAX_TURN_TIMEOUT,
              step: 1,
              'aria-label': zh.turnTimeout,
              value: form !== null ? form.turnTimeout : '',
              disabled: form === null || busy,
              onChange: (event) => setForm((current) => (
                current === null ? current : { ...current, turnTimeout: Number(event.target.value) }
              )),
            }),
            h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.turnTimeoutHint),
          ]),
        ]),
        h('div', { key: 'display', className: 'dsh-card-lan-field dsh-card-lan-settings-block' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.displayLabel),
          h('label', { key: 'opacity', className: 'dsh-card-lan-field' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.opacity),
            h('div', { key: 'row', className: 'dsh-card-lan-range-row' }, [
              h('input', {
                key: 'range',
                className: 'dsh-card-lan-range',
                type: 'range',
                'aria-label': zh.opacity,
                min: 25,
                max: 100,
                step: 5,
                value: Math.round(effectiveOpacity * 100),
                disabled: busy,
                onChange: (event) => changeOpacity(Number(event.target.value)),
              }),
              h('span', { key: 'value', className: 'dsh-card-lan-muted dsh-card-lan-small' },
                fmt(zh.opacityValue, { n: Math.round(effectiveOpacity * 100) })),
            ]),
            h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.opacityHint),
          ]),
          h('label', { key: 'size', className: 'dsh-card-lan-field' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.sizeLabel),
            h('select', {
              key: 'select',
              className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
              'aria-label': zh.sizeLabel,
              value: effectiveSize,
              disabled: busy,
              onChange: (event) => changeSize(event.target.value),
            }, [
              ...OVERLAY_SIZES.map((size) => h('option', { key: size, value: size },
                size === 'small' ? zh.sizeSmall : (size === 'medium' ? zh.sizeMedium : zh.sizeLarge))),
            ]),
            h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.sizeHint),
          ]),
          h('div', { key: 'autoFade', className: 'dsh-card-lan-field' }, [
            h('label', { key: 'check', className: 'dsh-card-lan-check' }, [
              h('input', {
                key: 'input',
                type: 'checkbox',
                'aria-label': zh.autoFadeLabel,
                checked: effectiveAutoFade,
                disabled: busy,
                onChange: (event) => changeAutoFade(event.target.checked),
              }),
              h('span', { key: 'label' }, zh.autoFadeLabel),
            ]),
            h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.autoFadeHint),
          ]),
          h('div', { key: 'actions', className: 'dsh-card-lan-actions' }, [
            h('button', {
              key: 'resetPosition',
              type: 'button',
              className: 'dsh-card-lan-button',
              disabled: busy,
              onClick: () => resetOverlayPosition(),
            }, zh.resetPosition),
            h('button', {
              key: 'hideOverlay',
              type: 'button',
              className: 'dsh-card-lan-button',
              disabled: busy,
              onClick: () => overlayVisibility.set(!hiddenOverlay),
            }, hiddenOverlay ? zh.showOverlay : zh.hideOverlay),
          ]),
          hiddenOverlay
            ? h('p', { key: 'hiddenHint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.overlayHiddenHint)
            : null,
          h('span', { key: 'dragHint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.dragHint),
        ]),
        h('div', { key: 'actions', className: 'dsh-card-lan-actions' }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-primary',
            disabled: form === null || busy,
            onClick: () => void save(),
          }, zh.save),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy,
            onClick: () => void store.refresh(),
          }, zh.refresh),
        ]),
      ])

      const noticeNode = notice !== null
        ? h('p', {
          key: 'notice',
          className: 'dsh-card-lan-notice' + (notice.error ? ' is-error' : ''),
          role: 'status',
        }, notice.text)
        : null

      const status = h('div', { key: 'status', className: 'dsh-card-lan-status' }, [
        h('div', { key: 'line', className: 'dsh-card-lan-status-line' }, [
          h('span', { key: 'dot', className: 'dsh-card-lan-dot' + (udpReady ? ' is-on' : ' is-off') }),
          h('span', { key: 'udp' }, udpReady ? zh.udpOnline : zh.udpOffline),
          boundPort > 0
            ? h('span', { key: 'port', className: 'dsh-card-lan-muted' }, fmt(zh.boundPort, { port: boundPort }))
            : null,
          h('span', { key: 'peers', className: 'dsh-card-lan-muted' }, fmt(zh.peerCount, { n: peers.length })),
        ]),
        enabled ? null : h('p', { key: 'off', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.disabledHint),
        reconnecting
          ? h('p', { key: 'reconnecting', className: 'dsh-card-lan-reconnect', role: 'status' }, [
            h('span', { key: 'dot', className: 'dsh-card-lan-pulse-dot' }),
            h('span', { key: 'text' }, zh.reconnecting),
          ])
          : null,
        reconnectFailed
          ? h('div', { key: 'reconnectFailed', className: 'dsh-card-lan-banner is-stale', role: 'status' }, [
            h('span', { key: 'dot', className: 'dsh-card-lan-pulse-dot' }),
            h('span', { key: 'text' }, zh.reconnectFailed),
            h('span', { key: 'detail', className: 'dsh-card-lan-tiny' }, zh.reconnectFailedDetail),
            h('button', {
              key: 'rejoin',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-small',
              disabled: busy,
              onClick: () => void act({ type: 'rejoin' }, zh.noticeRejoin),
            }, zh.rejoin),
          ])
          : null,
        hostClosed
          ? h('div', { key: 'hostClosed', className: 'dsh-card-lan-banner is-stale', role: 'status' }, [
            h('span', { key: 'text' }, zh.hostClosed),
            h('span', { key: 'detail', className: 'dsh-card-lan-tiny' }, zh.hostClosedDetail),
          ])
          : null,
        genericLastError
          ? h('p', { key: 'error', className: 'dsh-card-lan-error' }, zh.lastError + '：' + lastErrorText(lastError))
          : null,
        snapshot.error !== null
          ? h('p', { key: 'readError', className: 'dsh-card-lan-error' },
            fmt(zh.readFailedReason, { reason: snapshot.error }))
          : null,
        stats !== null
          ? h('p', { key: 'stats', className: 'dsh-card-lan-muted dsh-card-lan-tiny' }, fmt(zh.stats, {
            sent: asNumber(stats.sent, 0),
            received: asNumber(stats.received, 0),
            dropped: asNumber(stats.dropped, 0),
          }))
          : null,
      ])

      const identityText = role === 'host'
        ? zh.roleHost
        : role === 'spectator'
          ? fmt(zh.roleSpectator, { name: hostNick })
          : role === 'player' ? fmt(zh.rolePlayer, { name: hostNick }) : zh.roleNone
      const identityHint = role === 'host'
        ? zh.roleHostHint
        : role === 'spectator'
          ? zh.roleSpectatorHint
          : role === 'player' ? zh.rolePlayerHint : zh.roleNoneHint
      const identity = h('div', { key: 'identity', className: 'dsh-card-lan-identity' }, [
        h('div', { key: 'line', className: 'dsh-card-lan-status-line' }, [
          h('span', { key: 'role', className: 'dsh-card-lan-identity-role' }, identityText),
          role !== null && tableGame !== null
            ? h('span', { key: 'game', className: 'dsh-card-lan-tag is-game-' + tableGame },
              gameLabelOf(tableGame))
            : null,
          role !== null
            ? h('span', { key: 'phase', className: 'dsh-card-lan-tag is-' + phase },
              phaseLabelFor(tableGame, phase))
            : null,
          role !== null
            ? h('span', { key: 'count', className: 'dsh-card-lan-muted dsh-card-lan-small' },
              fmt(zh.playersN, { n: players.length }))
            : null,
        ]),
        h('p', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, identityHint),
      ])

      const tableActions = h('div', { key: 'tableActions', className: 'dsh-card-lan-actions' }, [
        !hostOpen && role === null
          ? h('select', {
            key: 'game',
            className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
            'aria-label': zh.gameLabel,
            value: effectiveGame,
            disabled: busy || !enabled,
            onChange: (event) => setGameDraft(gameOf(event.target.value)),
          }, [
            ...GAME_ORDER.map((id) => h('option', { key: id, value: id }, GAME_LABELS[id])),
          ])
          : null,
        !hostOpen && role === null
          ? h('button', {
            key: 'open',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-primary',
            disabled: busy || !enabled,
            onClick: () => void act({ type: 'open', game: effectiveGame }, zh.noticeOpen),
          }, zh.createTable)
          : null,
        hostOpen
          ? h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-danger',
            disabled: busy,
            onClick: () => void act({ type: 'close' }, zh.noticeClose),
          }, zh.closeTable)
          : null,
        canStart
          ? h('button', {
            key: 'start',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy,
            onClick: () => void act({ type: 'start' }, zh.noticeStart),
          }, phase === 'result'
            ? (tableGame === 'doudizhu' ? zh.ddzNextRound : zh.nextRound)
            : (tableGame === 'doudizhu' ? zh.ddzStart : zh.startRound))
          : null,
        role === 'player' || role === 'spectator'
          ? h('button', {
            key: 'leave',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy,
            onClick: () => void act({ type: 'leave' }, zh.noticeLeave),
          }, zh.leaveTable)
          : null,
      ])

      const peerNodes = peers.map((slot, index) => {
        const peer = asObject(slot)
        if (peer === null) return null
        const peerNode = asString(peer.node, '')
        const peerNick = asString(peer.nick, '未命名')
        const peerTable = asObject(peer.table)
        const open = peerTable !== null && peerTable.open === true
        const count = open ? asNumber(peerTable.players, 0) : 0
        const spectators = open ? asNumber(peerTable.spectators, 0) : 0
        const passwordRequired = open && peerTable.password === true
        const watchable = open && peerTable.watch === true
        const ip = asString(peer.ip, '?')
        const port = asNumber(peer.port, 0)
        const lastSeen = asNumber(peer.lastSeen, now)
        const age = Math.max(0, Math.round((now - lastSeen) / 1000))
        const seatedHere = (role === 'player' || role === 'spectator')
          && table !== null && asString(table.hostNode, '') === peerNode
        const canJoin = open && role === null && enabled && !busy
        const passwordValue = peerPasswords[peerNode] !== undefined ? peerPasswords[peerNode] : ''
        const joinPeer = (spectator) => {
          // The room password also guards spectating (PROTOCOL §2.2).
          if (passwordRequired && String(passwordValue).trim() === '') {
            showNotice(zh.joinPasswordRequired, true)
            return
          }
          const body = { type: 'join', hostNode: peerNode, role: spectator ? 'spectator' : 'player' }
          const password = String(passwordValue).trim()
          if (password !== '') body.pw = password
          void act(body, spectator ? zh.noticeJoinWatch : zh.noticeJoin)
        }
        // Open tables always show their head count and game kind; join/watch
        // buttons are added when this node has no seat yet (PROTOCOL §5/§7.5).
        const children = [
          h('div', { key: 'main', className: 'dsh-card-lan-peer-main' }, [
            h('div', { key: 'name', className: 'dsh-card-lan-peer-name' }, peerNick),
            h('div', { key: 'meta', className: 'dsh-card-lan-peer-meta' },
              fmt(zh.peerMeta, { ip, port: port > 0 ? port : '?', s: age })
              + (spectators > 0 ? ' · ' + fmt(zh.spectatorCount, { n: spectators }) : '')),
          ]),
        ]
        if (open) {
          const peerGame = gameOf(peerTable.game)
          children.push(h('span', { key: 'game', className: 'dsh-card-lan-tag is-game-' + peerGame },
            gameLabelOf(peerGame)))
        }
        if (passwordRequired) {
          children.push(h('span', { key: 'passwordTag', className: 'dsh-card-lan-tag' }, zh.passwordTag))
        }
        if (passwordRequired && canJoin) {
          children.push(h('input', {
            key: 'password',
            className: 'dsh-card-lan-input dsh-card-lan-input-pw',
            type: 'text',
            maxLength: 16,
            name: 'peer-password',
            'aria-label': zh.peerPasswordPlaceholder,
            placeholder: zh.peerPasswordPlaceholder,
            value: passwordValue,
            disabled: busy,
            onChange: (event) => {
              const value = event.target.value
              setPeerPasswords((current) => ({ ...current, [peerNode]: value }))
            },
          }))
        }
        children.push(h('span', { key: 'state', className: 'dsh-card-lan-tag' },
          open ? (seatedHere ? zh.seatedHere : fmt(zh.playersN, { n: count })) : zh.online))
        if (canJoin) {
          children.push(h('button', {
            key: 'join',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-small dsh-card-lan-button-primary',
            onClick: () => joinPeer(false),
          }, zh.join))
          if (watchable) {
            children.push(h('button', {
              key: 'watch',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-small',
              onClick: () => joinPeer(true),
            }, zh.watch))
          }
        }
        return h('div', {
          key: peerNode !== '' ? peerNode : 'peer' + index,
          className: 'dsh-card-lan-peer',
        }, children)
      }).filter((node) => node !== null)

      const manualBlock = h('div', { key: 'manual', className: 'dsh-card-lan-manual' }, [
        h('div', { key: 'label', className: 'dsh-card-lan-label' }, zh.manualTitle),
        h('div', { key: 'row', className: 'dsh-card-lan-manual-row' }, [
          h('input', {
            key: 'ip',
            className: 'dsh-card-lan-input dsh-card-lan-input-ip',
            type: 'text',
            placeholder: zh.ipPlaceholder,
            value: manual.ip,
            disabled: busy,
            onChange: (event) => setManual((current) => ({ ...current, ip: event.target.value })),
          }),
          h('input', {
            key: 'port',
            className: 'dsh-card-lan-input dsh-card-lan-input-port',
            type: 'number',
            min: 1024,
            max: 65535,
            step: 1,
            value: manual.port,
            disabled: busy,
            onChange: (event) => setManual((current) => ({ ...current, port: event.target.value })),
          }),
          h('input', {
            key: 'password',
            className: 'dsh-card-lan-input dsh-card-lan-input-pw',
            type: 'text',
            maxLength: 16,
            name: 'manual-password',
            'aria-label': zh.peerPasswordPlaceholder,
            placeholder: zh.peerPasswordPlaceholder,
            value: manual.password,
            disabled: busy,
            onChange: (event) => setManual((current) => ({ ...current, password: event.target.value })),
          }),
          h('button', {
            key: 'join',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy || !enabled || role !== null,
            onClick: () => void joinManual(),
          }, zh.join),
        ]),
        role !== null
          ? h('p', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.manualBusyHint)
          : null,
      ])

      return h('div', { className: 'dsh-card-lan-section' }, [
        head,
        fields,
        noticeNode,
        status,
        h('div', { key: 'table', className: 'dsh-card-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.tableLabel),
          identity,
          tableActions,
        ]),
        h('div', { key: 'peers', className: 'dsh-card-lan-peers' }, [
          h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.foundTables),
          peerNodes.length === 0
            ? h('p', { key: 'empty', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.noPeers)
            : null,
          ...peerNodes,
        ]),
        manualBlock,
      ])
    }

    /* ------------------------------------------------------------------ *
     * shell.overlay: the floating table
     * ------------------------------------------------------------------ */

    /**
     * Frame-wide floating table. Renders nothing until the view carries a
     * table, so an idle plugin adds no chrome to the shell.
     */
    function TableOverlay() {
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const data = snapshot.data
      const hidden = useSyncExternalStore(overlayVisibility.subscribe, overlayVisibility.getSnapshot)
      const previewOpacity = useSyncExternalStore(opacityStore.subscribe, opacityStore.getSnapshot)
      const [minimized, setMinimized] = useState(false)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [hovered, setHovered] = useState(false)
      const [focused, setFocused] = useState(false)
      const [dragging, setDragging] = useState(false)
      const [dragPos, setDragPos] = useState(null)
      const dragState = useRef(null)
      const saveTimer = useRef(null)
      const [selectedCards, setSelectedCards] = useState([])
      const [showSettings, setShowSettings] = useState(false)
      const settingsTimer = useRef(null)
      // A drag that ends over the capsule must not also expand it.
      const suppressCapsuleClick = useRef(false)

      // The local Dou Dizhu selection is invalidated whenever the board, the
      // turn or my hand changes (a play landed, the round moved on, re-deal).
      const tableRecord = data !== null ? asObject(data.table) : null
      const boardKey = tableRecord === null ? '' : [
        asString(tableRecord.game, DEFAULT_GAME),
        asString(tableRecord.phase, ''),
        asString(tableRecord.turn, ''),
        asArray(tableRecord.myCards).join(','),
      ].join('|')
      useEffect(() => {
        setSelectedCards([])
      }, [boardKey])

      const configRecord = data !== null ? asObject(data.config) : null
      const sizeWidth = OVERLAY_WIDTHS[overlaySizeOf(configRecord)]
      const savedPosition = overlayPositionOf(configRecord)
      const savedX = savedPosition !== null ? savedPosition.x : null
      const savedY = savedPosition !== null ? savedPosition.y : null

      // A host-side position change (重置位置, another window's drag) wins over
      // the local drag preview.
      useEffect(() => {
        setDragPos(null)
      }, [savedX, savedY])

      // Never leave pointer listeners or a save timer behind when the overlay
      // unmounts mid-gesture (Ctrl+Shift+H, plugin reload).
      useEffect(() => () => {
        const active = dragState.current
        if (active !== null && typeof active.detach === 'function') active.detach()
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
        if (settingsTimer.current !== null) window.clearTimeout(settingsTimer.current)
      }, [])

      const table = tableRecord
      if (table === null || hidden) return null

      const tableRole = asString(table.role, 'player')
      const role = tableRole === 'host' ? 'host' : (tableRole === 'spectator' ? 'spectator' : 'player')
      const isSpectator = role === 'spectator'
      const game = gameOf(table.game)
      const isDdz = game === 'doudizhu'
      const isPdk = game === 'paodekuai'
      const isCardGame = isCardGameId(game)
      const phase = asString(table.phase, 'idle')
      const round = Math.max(0, asNumber(table.round, 0))
      const players = asArray(table.players).filter((slot) => asObject(slot) !== null)
      const dealer = asObject(table.dealer)
      const dealerCards = dealer !== null ? asArray(dealer.cards) : []
      const dealerHidden = dealer !== null && dealer.hidden === true
      const dealerTotal = dealer !== null && Number.isFinite(dealer.total)
        ? dealer.total
        : handTotal(dealerCards)
      const turnNode = asString(table.turn, '')
      const me = players.find((slot) => slot.self === true)
      const myNode = me !== undefined ? asString(me.node, '') : ''
      const myTurn = phase === 'playing' && myNode !== '' && turnNode === myNode
      const hostNick = hostNickOf(table)
      const staleMs = Math.max(0, asNumber(table.staleMs, 0))
      // Spectators track host liveness exactly like seated players (PROTOCOL §3.1).
      const stale = (role === 'player' || role === 'spectator') && staleMs > STALE_MS
      // Auto-reconnect state (PROTOCOL §2.5c): a guest may be actively retrying
      // or may have exhausted its retries and be waiting for a manual rejoin.
      const reconnecting = data !== null && data.reconnecting === true
      const overlayLastError = data !== null ? data.lastError : null
      const overlayLastErrorCode = overlayLastError !== null && overlayLastError !== undefined
        ? String(overlayLastError)
        : ''
      const reconnectFailed = overlayLastErrorCode === 'reconnect-failed'
      const connectionBroken = reconnecting || reconnectFailed
      // Per-turn countdown from the host heartbeat; -1 means "not applicable".
      const turnRemainingMs = asNumber(table.turnRemainingMs, -1)
      const hostOpacity = configRecord !== null && Number.isFinite(configRecord.overlayOpacity)
        ? Math.min(1, Math.max(MIN_OPACITY, Number(configRecord.overlayOpacity)))
        : DEFAULT_OPACITY
      const autoFade = configRecord !== null ? configRecord.autoFade !== false : true
      const baseOpacity = previewOpacity !== null ? previewOpacity : hostOpacity
      // Auto-fade is JS-driven so it composes with the opacity preference:
      // hover / keyboard focus / dragging settles back to the full base value.
      const faded = autoFade && !hovered && !focused && !dragging
      const overlayOpacity = faded ? Math.max(MIN_OPACITY, baseOpacity * AUTO_FADE_FACTOR) : baseOpacity
      const position = dragPos !== null
        ? dragPos
        : (savedPosition !== null ? clampOverlayPosition(savedPosition.x, savedPosition.y, sizeWidth) : null)
      const overlayStyle = {
        '--dsh-card-lan-opacity': String(overlayOpacity),
        '--dsh-card-lan-width': sizeWidth + 'px',
      }
      if (position !== null) {
        overlayStyle.left = position.x + 'px'
        overlayStyle.top = position.y + 'px'
        overlayStyle.right = 'auto'
        overlayStyle.bottom = 'auto'
      }
      const phaseLabel = phaseLabelFor(game, phase)
      const myResult = me !== undefined ? asString(me.result, '') : ''
      const scoreMap = asObject(table.scores) !== null
        ? asObject(table.scores)
        : (data !== null ? asObject(data.scores) : null)
      const logLines = asArray(table.log)
        .map(logText)
        .filter((line) => line !== '')
        .slice(-3)

      // Card-game view fields (PROTOCOL §7.3/§7.6); ignored for blackjack.
      const landlordNode = isDdz ? asString(table.landlord, '') : ''
      const landlordPlayer = isDdz && landlordNode !== ''
        ? players.find((slot) => asString(slot.node, '') === landlordNode)
        : undefined
      const cardMyCards = isCardGame ? sortDdzCards(asArray(table.myCards)) : []
      const cardLastPlay = isCardGame ? asObject(table.lastPlay) : null
      const cardMustPlay = isCardGame && table.mustPlay === true
      const myScore = myNode !== '' && scoreMap !== null ? scoreMap[myNode] : null

      const showNotice = (text, isError) => {
        setNotice(text === undefined || text === null || text === '' ? null : { text, error: isError === true })
      }

      const act = async (body, successText) => {
        setBusy(true)
        showNotice('')
        const result = await store.action(body)
        setBusy(false)
        if (result.ok === true) showNotice(successText === undefined ? '' : successText, false)
        else showNotice(errorText(result.error, game) || zh.actionFailed, true)
        return result.ok === true
      }

      /** Overlay-embedded display settings: same config as the 大厅, applied live. */
      const applyOverlayConfig = async (patch, okText) => {
        const result = await store.configure(patch)
        if (result.ok === true) {
          showNotice(okText === undefined ? '' : okText, false)
          return true
        }
        showNotice(errorText(result.error, game) || zh.saveFailed, true)
        return false
      }

      /** Slider: preview instantly, persist once the drag pauses. */
      const previewOverlayOpacity = (percent) => {
        const next = Math.min(1, Math.max(MIN_OPACITY, Number(percent) / 100))
        opacityStore.set(next)
        if (settingsTimer.current !== null) window.clearTimeout(settingsTimer.current)
        settingsTimer.current = window.setTimeout(() => {
          settingsTimer.current = null
          void store.configure({ overlayOpacity: next }).then((result) => {
            opacityStore.set(null)
            if (result.ok !== true) showNotice(errorText(result.error, game) || zh.saveFailed, true)
          })
        }, 300)
      }

      const changeOverlaySize = (next) => {
        const size = typeof next === 'string' && OVERLAY_WIDTHS[next] !== undefined ? next : DEFAULT_SIZE
        void applyOverlayConfig({ overlaySize: size })
      }

      const changeOverlayAutoFade = (checked) => {
        void applyOverlayConfig({ autoFade: checked === true })
      }

      const resetOverlayPosition = () => {
        void applyOverlayConfig({ overlayX: null, overlayY: null }, zh.resetPositionDone)
      }

      /** Card-game writes (PROTOCOL §7.3/§7.6): bid / play / pass / start. */
      const toggleCard = (card) => {
        setSelectedCards((current) => (current.indexOf(card) === -1
          ? current.concat([card])
          : current.filter((item) => item !== card)))
      }
      const playSelected = async () => {
        if (selectedCards.length === 0) return
        const saved = await act({ type: 'play', cards: selectedCards })
        if (saved) setSelectedCards([])
      }
      const passTurn = () => void act({ type: 'pass' })
      const bidTurn = (value) => void act({ type: 'bid', bid: value })
      const startRound = () => void act({ type: 'start' }, zh.noticeStart)

      /* ---------------- display prefs: auto-fade + title-bar drag ---------------- */

      const onEnter = () => setHovered(true)
      const onLeave = () => setHovered(false)
      const onFocusIn = () => setFocused(true)
      const onFocusOut = (event) => {
        const next = event !== null && event !== undefined ? event.relatedTarget : undefined
        const current = event !== null && event !== undefined ? event.currentTarget : undefined
        const inside = next !== null && next !== undefined && current !== null && current !== undefined
          && typeof current.contains === 'function' && current.contains(next)
        if (!inside) setFocused(false)
      }

      /** Persist the dragged position once the gesture settles (PROTOCOL §5.7). */
      const schedulePositionSave = (x, y) => {
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null
          void store.configure({ overlayX: Math.round(x), overlayY: Math.round(y) }).then((result) => {
            if (result.ok === true) {
              // The polled config is authoritative now: drop the local preview.
              setDragPos(null)
            } else {
              showNotice(errorText(result.error) || zh.saveFailed, true)
            }
          })
        }, POSITION_SAVE_MS)
      }

      /** Title-bar drag: pointer events, clamped to the viewport. */
      const startDrag = (event, options = {}) => {
        if (event === null || event === undefined) return
        if (event.button !== undefined && event.button !== 0) return
        const target = event.target
        if (target !== null && target !== undefined && typeof target.closest === 'function'
          && target.closest('button') !== null) return
        const node = event.currentTarget
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return
        // A missed pointerup must not leave the previous gesture listening.
        const previous = dragState.current
        if (previous !== null && typeof previous.detach === 'function') previous.detach()
        const rect = node.getBoundingClientRect()
        const state = {
          pointerId: event.pointerId,
          startX: asNumber(event.clientX, rect.left),
          startY: asNumber(event.clientY, rect.top),
          originX: rect.left,
          originY: rect.top,
          width: asNumber(rect.width, sizeWidth),
          height: asNumber(rect.height, 0),
          moved: false,
          lastX: rect.left,
          lastY: rect.top,
          detached: false,
          detach: null,
        }
        const move = (moveEvent) => {
          if (moveEvent === null || moveEvent === undefined) return
          if (state.pointerId !== undefined && moveEvent.pointerId !== undefined
            && moveEvent.pointerId !== state.pointerId) return
          const nextX = state.originX + (asNumber(moveEvent.clientX, state.startX) - state.startX)
          const nextY = state.originY + (asNumber(moveEvent.clientY, state.startY) - state.startY)
          const clamped = clampOverlayPosition(nextX, nextY, state.width, state.height)
          state.moved = true
          state.lastX = clamped.x
          state.lastY = clamped.y
          setDragPos(clamped)
        }
        const detach = () => {
          if (state.detached) return
          state.detached = true
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
        }
        const up = (upEvent) => {
          if (upEvent !== null && upEvent !== undefined && state.pointerId !== undefined
            && upEvent.pointerId !== undefined && upEvent.pointerId !== state.pointerId) return
          detach()
          dragState.current = null
          setDragging(false)
          if (state.moved) schedulePositionSave(state.lastX, state.lastY)
          suppressCapsuleClick.current = state.moved
        }
        state.detach = detach
        dragState.current = state
        setDragging(true)
        setHovered(true)
        // The capsule also expands on click, so it must keep its compatibility
        // click events (only the title bar cancels the default gesture).
        if (options.preventDefault !== false && typeof event.preventDefault === 'function') event.preventDefault()
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }

      const canStart = role === 'host' && (phase === 'idle' || phase === 'result')
      const turnNick = (() => {
        for (const slot of players) {
          if (asString(slot.node, '') === turnNode) return asString(slot.nick, '玩家')
        }
        return ''
      })()

      const cardGame = isCardGame
        ? buildCardGameContent({
          game,
          role,
          isSpectator,
          phase,
          players,
          me,
          turnNode,
          myNode,
          turnNick,
          lastPlay: cardLastPlay,
          mustPlay: cardMustPlay,
          myCards: cardMyCards,
          selectedCards,
          toggleCard,
          landlordPlayer,
          myScore,
          busy,
          connectionBroken,
          turnRemainingMs,
          playSelected,
          passTurn,
          bidTurn,
          startRound,
        })
        : null

      let hint = ''
      if (isCardGame) {
        hint = cardGame.hint
      } else if (isSpectator) {
        hint = zh.spectatorHint
      } else if (phase === 'playing') {
        if (myTurn) {
          // The host refreshes turnRemainingMs on every heartbeat; the number
          // ticks down in place without remounting anything.
          hint = turnRemainingMs >= 0
            ? fmt(zh.turnCountdown, { n: Math.max(0, Math.ceil(turnRemainingMs / 1000)) })
            : zh.yourTurn
        } else {
          hint = turnNick !== '' ? fmt(zh.waitOthers, { name: turnNick }) : zh.waitHost
        }
      } else if (phase === 'idle') {
        hint = role === 'host' ? zh.idleHostHint : zh.waitHostStart
      } else if (phase === 'dealer') {
        hint = zh.dealerRunning
      } else if (phase === 'result') {
        hint = role === 'host' ? zh.resultHostHint : zh.waitHostNext
      }

      if (minimized) {
        return h('div', {
          className: 'dsh-card-lan-capsule' + (dragging ? ' is-dragging' : ''),
          style: overlayStyle,
          role: 'button',
          tabIndex: 0,
          title: zh.capsuleDragHint,
          onPointerDown: (event) => startDrag(event, { preventDefault: false }),
          onClick: () => {
            const suppressed = suppressCapsuleClick.current
            suppressCapsuleClick.current = false
            if (suppressed) return
            setMinimized(false)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setMinimized(false)
            }
          },
          onPointerEnter: onEnter,
          onPointerLeave: onLeave,
          onFocus: onFocusIn,
          onBlur: onFocusOut,
        }, [
          h('span', { key: 'dot', className: 'dsh-card-lan-capsule-dot' + (stale || reconnecting || reconnectFailed ? ' is-stale' : '') }),
          h('span', { key: 'text' }, gameCapsuleTitleOf(game, round)),
          h('span', { key: 'phase', className: 'dsh-card-lan-capsule-phase' }, phaseLabel),
          reconnecting
            ? h('span', { key: 'reconnect', className: 'dsh-card-lan-capsule-stale' }, zh.capsuleReconnecting)
            : (reconnectFailed
              ? h('span', { key: 'reconnectFailed', className: 'dsh-card-lan-capsule-stale' }, zh.reconnectFailed)
              : (stale ? h('span', { key: 'stale', className: 'dsh-card-lan-capsule-stale' }, zh.capsuleStale) : null)),
          h('span', { key: 'expand', className: 'dsh-card-lan-capsule-hint' }, zh.expand),
        ])
      }

      const head = h('div', {
        key: 'head',
        className: 'dsh-card-lan-overlay-head is-draggable',
        title: zh.dragHint,
        onPointerDown: startDrag,
      }, [
        h('div', { key: 'row', className: 'dsh-card-lan-head-row' }, [
          h('span', {
            key: 'title',
            className: 'dsh-card-lan-title',
          }, gameTitleOf(game, round)),
          h('span', { key: 'phase', className: 'dsh-card-lan-pill is-' + phase }, phaseLabel),
          ...(isCardGame ? cardGame.headExtras : []),
          isSpectator
            ? h('span', { key: 'spectator', className: 'dsh-card-lan-pill is-spectator' }, zh.spectatorBadge)
            : null,
          h('div', { key: 'tools', className: 'dsh-card-lan-head-tools' }, [
            h('button', {
              key: 'settings',
              type: 'button',
              className: 'dsh-card-lan-icon-button' + (showSettings ? ' is-active' : ''),
              title: zh.overlaySettings,
              'aria-label': zh.overlaySettings,
              'aria-expanded': showSettings,
              onClick: () => setShowSettings((value) => !value),
            }, '⚙'),
            h('button', {
              key: 'min',
              type: 'button',
              className: 'dsh-card-lan-icon-button',
              title: zh.minimize,
              'aria-label': zh.minimize,
              onClick: () => setMinimized(true),
            }, '—'),
            role === 'host'
              ? h('button', {
                key: 'close',
                type: 'button',
                className: 'dsh-card-lan-button dsh-card-lan-button-small dsh-card-lan-button-danger',
                disabled: busy,
                onClick: () => void act({ type: 'close' }, zh.noticeClose),
              }, zh.closeTable)
              : h('button', {
                key: 'leave',
                type: 'button',
                className: 'dsh-card-lan-button dsh-card-lan-button-small',
                disabled: busy,
                onClick: () => void act({ type: 'leave' }, zh.noticeLeave),
              }, zh.leave),
          ]),
        ]),
        h('div', { key: 'sub', className: 'dsh-card-lan-head-sub' }, [
          h('span', { key: 'host', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.hostLabel + '：' + hostNick),
          h('span', { key: 'count', className: 'dsh-card-lan-muted dsh-card-lan-small' }, fmt(zh.playersN, { n: players.length })),
        ]),
      ])

      const settingsPanel = showSettings
        ? h('div', {
          key: 'settings',
          className: 'dsh-card-lan-overlay-settings',
          role: 'group',
          'aria-label': zh.overlaySettings,
        }, [
          h('div', { key: 'opacity', className: 'dsh-card-lan-settings-row' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.opacity),
            h('input', {
              key: 'range',
              type: 'range',
              className: 'dsh-card-lan-settings-range',
              min: String(Math.round(MIN_OPACITY * 100)),
              max: '100',
              step: '5',
              value: String(Math.round(baseOpacity * 100)),
              'aria-label': zh.opacity,
              onChange: (event) => previewOverlayOpacity(Number(event.target.value)),
            }),
            h('span', { key: 'value', className: 'dsh-card-lan-settings-value' },
              fmt(zh.opacityValue, { n: Math.round(baseOpacity * 100) })),
          ]),
          h('div', { key: 'size', className: 'dsh-card-lan-settings-row' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.sizeLabel),
            h('select', {
              key: 'select',
              className: 'dsh-card-lan-settings-select',
              value: overlaySizeOf(configRecord),
              'aria-label': zh.sizeLabel,
              onChange: (event) => changeOverlaySize(String(event.target.value)),
            }, ['small', 'medium', 'large'].map((value) => h('option', {
              key: value,
              value,
            }, value === 'small' ? zh.sizeSmall : (value === 'medium' ? zh.sizeMedium : zh.sizeLarge)))),
          ]),
          h('label', { key: 'fade', className: 'dsh-card-lan-check dsh-card-lan-settings-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: autoFade,
              onChange: (event) => changeOverlayAutoFade(event.target.checked === true),
            }),
            h('span', { key: 'text' }, zh.autoFadeLabel),
          ]),
          h('div', { key: 'actions', className: 'dsh-card-lan-settings-actions' }, [
            h('button', {
              key: 'reset',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-small',
              onClick: resetOverlayPosition,
            }, zh.resetPosition),
            h('button', {
              key: 'done',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-small dsh-card-lan-button-primary',
              onClick: () => setShowSettings(false),
            }, zh.done),
          ]),
          h('p', { key: 'hint', className: 'dsh-card-lan-settings-hint' }, zh.overlaySettingsHint),
        ])
        : null

      // One connection banner, highest priority first: retrying > failed > stale.
      const connectionBanner = reconnecting
        ? h('div', { key: 'reconnecting', className: 'dsh-card-lan-banner is-stale', role: 'status' }, [
          h('span', { key: 'dot', className: 'dsh-card-lan-pulse-dot' }),
          h('span', { key: 'text' }, zh.reconnecting),
        ])
        : reconnectFailed
          ? h('div', { key: 'reconnectFailed', className: 'dsh-card-lan-banner is-stale', role: 'status' }, [
            h('span', { key: 'dot', className: 'dsh-card-lan-pulse-dot' }),
            h('span', { key: 'text' }, zh.reconnectFailed),
            h('span', { key: 'detail', className: 'dsh-card-lan-tiny' },
              stale ? fmt(zh.staleDetail, { s: Math.round(staleMs / 1000) }) : zh.reconnectFailedDetail),
            h('button', {
              key: 'rejoin',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-small',
              disabled: busy,
              onClick: () => void act({ type: 'rejoin' }, zh.noticeRejoin),
            }, zh.rejoin),
          ])
          : stale
            ? h('div', { key: 'stale', className: 'dsh-card-lan-banner is-stale', role: 'status' }, [
              h('span', { key: 'dot', className: 'dsh-card-lan-pulse-dot' }),
              h('span', { key: 'text' }, zh.staleTitle),
              h('span', { key: 'detail', className: 'dsh-card-lan-tiny' }, fmt(zh.staleDetail, { s: Math.round(staleMs / 1000) })),
            ])
            : null

      const dealerBlock = h('div', { key: 'dealer', className: 'dsh-card-lan-dealer' }, [
        h('div', { key: 'head', className: 'dsh-card-lan-row-head' }, [
          h('span', { key: 'name', className: 'dsh-card-lan-name' }, zh.dealer),
          h('span', { key: 'total', className: 'dsh-card-lan-tag' }, dealerCards.length === 0
            ? zh.noCards
            : (dealerHidden ? fmt(zh.dealerHiddenTotal, { total: dealerTotal }) : fmt(zh.dealerTotal, { total: dealerTotal }))),
        ]),
        h(Hand, { key: 'hand', cards: dealerCards, hidden: dealerHidden }),
      ])

      const rows = players.map((slot, index) => h(PlayerRow, {
        key: asString(slot.node, 'seat' + index),
        player: slot,
        showSelf: !isSpectator,
        isTurn: phase === 'playing' && turnNode !== '' && asString(slot.node, '') === turnNode,
        score: scoreMap !== null ? scoreMap[asString(slot.node, '')] : null,
      }))

      const bjResultBanner = phase === 'result'
        ? h('div', {
          key: 'result',
          className: 'dsh-card-lan-banner is-' + (myResult !== '' ? myResult : 'none'),
          role: 'status',
        }, myResult === 'win'
          ? zh.resultWin
          : myResult === 'lose' ? zh.resultLose : myResult === 'push' ? zh.resultPush : zh.resultOver)
        : null

      const bjActionNodes = []
      if (canStart) {
        bjActionNodes.push(h('button', {
          key: 'start',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy,
          onClick: () => void act({ type: 'start' }, zh.noticeStart),
        }, phase === 'result' ? zh.nextRound : zh.startRound))
      }
      // Spectators never see seat actions (PROTOCOL.md §5 overlay 8).
      if (phase === 'playing' && me !== undefined && !isSpectator) {
        bjActionNodes.push(h('button', {
          key: 'hit',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy || !myTurn || connectionBroken,
          onClick: () => void act({ type: 'hit' }),
        }, zh.hit))
        bjActionNodes.push(h('button', {
          key: 'stand',
          type: 'button',
          className: 'dsh-card-lan-button',
          disabled: busy || !myTurn || connectionBroken,
          onClick: () => void act({ type: 'stand' }),
        }, zh.stand))
      }

      const noticeNode = notice !== null
        ? h('p', {
          key: 'notice',
          className: 'dsh-card-lan-notice' + (notice.error ? ' is-error' : ''),
          role: 'status',
        }, notice.text)
        : null

      const bodyChildren = []
      if (isCardGame) {
        for (const node of cardGame.bodyNodes) bodyChildren.push(node)
      } else {
        bodyChildren.push(dealerBlock)
        for (const row of rows) bodyChildren.push(row)
        if (bjResultBanner !== null) bodyChildren.push(bjResultBanner)
      }
      const finalActions = isCardGame ? cardGame.actionNodes : bjActionNodes
      if (finalActions.length > 0) {
        bodyChildren.push(h('div', { key: 'actions', className: 'dsh-card-lan-actions' }, finalActions))
      }
      if (hint !== '') bodyChildren.push(h('p', { key: 'hint', className: 'dsh-card-lan-hint' }, hint))
      if (logLines.length > 0) {
        bodyChildren.push(h('div', { key: 'log', className: 'dsh-card-lan-log' }, [
          h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.logTitle),
          ...logLines.map((line, index) => h('div', {
            key: 'line' + index,
            className: 'dsh-card-lan-log-line',
          }, line)),
        ]))
      }

      return h('div', {
        className: 'dsh-card-lan-overlay' + (dragging ? ' is-dragging' : ''),
        style: overlayStyle,
        role: 'dialog',
        'aria-label': zh.nav,
        onPointerEnter: onEnter,
        onPointerLeave: onLeave,
        onFocus: onFocusIn,
        onBlur: onFocusOut,
      }, [
        head,
        settingsPanel,
        connectionBanner,
        h('div', { key: 'body', className: 'dsh-card-lan-body' }, bodyChildren),
        noticeNode,
        snapshot.error !== null
          ? h('p', { key: 'readError', className: 'dsh-card-lan-error' },
            fmt(zh.readFailedReason, { reason: snapshot.error }))
          : null,
      ])
    }

    /* ------------------------------------------------------------------ *
     * Styles: injected once, dark-theme friendly, no images or fonts.
     * ------------------------------------------------------------------ */

    const CSS = [
      '.dsh-card-lan-section{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-lobby-head{display:flex;flex-direction:column;gap:6px}',
      '.dsh-card-lan-title{margin:0;font-size:16px;font-weight:650;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-muted{margin:0;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-tiny{font-size:11px;line-height:1.5}',
      '.dsh-card-lan-small{font-size:12px}',
      '.dsh-card-lan-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-fields{display:flex;flex-direction:column;gap:14px;max-width:520px}',
      '.dsh-card-lan-field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-card-lan-check{display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer}',
      '.dsh-card-lan-check input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-card-lan-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;font:inherit;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.6));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'color:var(--dsw-alias-label-primary,#e2e8f0);outline:none}',
      '.dsh-card-lan-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-card-lan-input:disabled{opacity:.55;cursor:not-allowed}',
      '.dsh-card-lan-input-narrow{max-width:170px}',
      '.dsh-card-lan-input-ip{flex:1 1 170px;min-width:0}',
      '.dsh-card-lan-input-port{flex:0 0 100px;width:100px}',
      '.dsh-card-lan-range-row{display:flex;align-items:center;gap:10px;max-width:420px}',
      '.dsh-card-lan-range{flex:1 1 auto;min-width:120px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}',
      '.dsh-card-lan-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-card-lan-button{font:inherit;font-size:12px;line-height:1.4;padding:6px 14px;border-radius:8px;cursor:pointer;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.7));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.4));',
      'color:var(--dsw-alias-label-primary,#e2e8f0);transition:border-color .15s ease,background .15s ease,opacity .15s ease}',
      '.dsh-card-lan-button:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.7))}',
      '.dsh-card-lan-button:disabled{opacity:.45;cursor:not-allowed}',
      '.dsh-card-lan-button-primary{background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.7));',
      'border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.55));color:var(--dsw-alias-label-primary,#e2e8f0);font-weight:600}',
      '.dsh-card-lan-button-primary:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4d6bfe);filter:none}',
      '.dsh-card-lan-button-small{padding:3px 10px}',
      '.dsh-card-lan-button-danger{color:var(--dsw-alias-state-error-primary,#f87171)}',
      '.dsh-card-lan-icon-button{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;',
      'padding:0;border-radius:6px;cursor:pointer;font:inherit;font-size:14px;line-height:1;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.7));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-icon-button:hover{border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.7))}',
      '.dsh-card-lan-icon-button.is-active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-overlay-settings{position:absolute;top:52px;right:12px;z-index:8;width:236px;box-sizing:border-box;',
      'display:flex;flex-direction:column;gap:9px;padding:12px;border-radius:12px;pointer-events:auto;',
      'background:var(--dsw-alias-bg-overlay,rgba(15,23,42,.96));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'box-shadow:0 12px 32px rgba(2,6,23,.5)}',
      '.dsh-card-lan-settings-row{display:flex;align-items:center;gap:8px}',
      '.dsh-card-lan-settings-range{flex:1 1 auto;min-width:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-card-lan-settings-value{flex:0 0 auto;min-width:34px;text-align:right;color:var(--dsw-alias-label-secondary,#94a3b8);font-variant-numeric:tabular-nums}',
      '.dsh-card-lan-settings-select{flex:1 1 auto;min-width:0;padding:5px 8px;border-radius:8px;font:inherit;font-size:12px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.7));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-settings-check{font-size:12px;gap:6px}',
      '.dsh-card-lan-settings-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dsh-card-lan-settings-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-status{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.4));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-card-lan-status-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-card-lan-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block;',
      'background:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-dot.is-on{background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 3px rgba(34,197,94,.16)}',
      '.dsh-card-lan-dot.is-off{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dsh-card-lan-error{margin:0;color:var(--dsw-alias-state-error-primary,#f87171);font-size:12px;word-break:break-word}',
      '.dsh-card-lan-reconnect{margin:0;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#fbbf24}',
      '.dsh-card-lan-banner .dsh-card-lan-button{margin-left:auto}',
      '.dsh-card-lan-notice{margin:0;color:var(--dsw-alias-label-secondary,#94a3b8);font-size:12px;word-break:break-word}',
      '.dsh-card-lan-notice.is-error{color:var(--dsw-alias-state-error-primary,#f87171)}',
      '.dsh-card-lan-identity{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.4));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-card-lan-identity-role{font-weight:600;color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-peers{display:flex;flex-direction:column;gap:8px;max-width:640px}',
      '.dsh-card-lan-peer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.35));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.22))}',
      '.dsh-card-lan-peer-main{flex:1 1 auto;min-width:0}',
      '.dsh-card-lan-peer-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-card-lan-peer-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#94a3b8);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-card-lan-manual{display:flex;flex-direction:column;gap:6px;max-width:640px}',
      '.dsh-card-lan-manual-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-card-lan-input-pw{width:130px;flex:0 0 auto}',
      '.dsh-card-lan-settings-block{gap:10px;padding:10px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.3));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-settings-block .dsh-card-lan-check,.dsh-card-lan-settings-block .dsh-card-lan-check span{font-weight:500}',
      // Sits above the composer, bottom-right: the input area must stay usable.
      '.dsh-card-lan-overlay{position:fixed;right:16px;bottom:96px;z-index:2147482200;',
      'width:var(--dsh-card-lan-width,380px);',
      'max-width:calc(100vw - 32px);max-height:min(74vh,640px);display:flex;flex-direction:column;gap:10px;',
      'padding:14px;box-sizing:border-box;border-radius:16px;overflow:auto;overscroll-behavior:contain;pointer-events:auto;',
      'background:radial-gradient(120% 90% at 50% 0%,rgba(34,197,94,.10),transparent 60%),var(--dsw-alias-bg-overlay,rgba(15,23,42,.94));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));box-shadow:0 18px 48px rgba(2,6,23,.45);',
      'color:var(--dsw-alias-label-primary,#e2e8f0);font-size:13px;line-height:1.5;backdrop-filter:blur(14px);',
      'opacity:var(--dsh-card-lan-opacity,1);transition:opacity .18s ease}',
      // Auto-fade is JS-controlled (PROTOCOL §5.7); no :hover opacity override.
      '.dsh-card-lan-overlay-head.is-draggable{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}',
      '.dsh-card-lan-overlay.is-dragging{cursor:grabbing;user-select:none;-webkit-user-select:none}',
      '.dsh-card-lan-overlay.is-dragging .dsh-card-lan-overlay-head{cursor:grabbing}',
      '.dsh-card-lan-overlay-head{display:flex;flex-direction:column;gap:4px}',
      '.dsh-card-lan-head-row{display:flex;align-items:center;gap:8px}',
      '.dsh-card-lan-head-row .dsh-card-lan-title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-card-lan-head-tools{margin-left:auto;display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.dsh-card-lan-head-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-card-lan-body{display:flex;flex-direction:column;gap:8px}',
      '.dsh-card-lan-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;',
      'line-height:1.7;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.7));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.3));color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-pill.is-playing{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.4);color:#4ade80}',
      '.dsh-card-lan-pill.is-dealer{background:rgba(245,158,11,.16);border-color:rgba(245,158,11,.4);color:#fbbf24}',
      '.dsh-card-lan-pill.is-result{background:rgba(77,107,254,.16);border-color:rgba(77,107,254,.4);color:#93a4ff}',
      '.dsh-card-lan-pill.is-spectator{background:rgba(148,163,184,.18);border-color:rgba(148,163,184,.45);color:#cbd5e1}',
      '.dsh-card-lan-tag{display:inline-flex;align-items:center;gap:4px;padding:0 7px;border-radius:6px;font-size:11px;',
      'line-height:1.7;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.65));',
      'border:1px solid transparent;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-tag.is-stand{color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-tag.is-bust{background:rgba(239,68,68,.16);color:var(--dsw-alias-state-error-primary,#f87171)}',
      '.dsh-card-lan-tag.is-blackjack{background:rgba(234,179,8,.18);color:#eab308}',
      '.dsh-card-lan-tag.is-turn{background:rgba(77,107,254,.2);color:#93a4ff}',
      '.dsh-card-lan-tag.is-result-win{background:rgba(34,197,94,.18);color:#4ade80}',
      '.dsh-card-lan-tag.is-result-lose{background:rgba(239,68,68,.16);color:#f87171}',
      '.dsh-card-lan-tag.is-result-push{background:rgba(148,163,184,.18);color:#cbd5e1}',
      '.dsh-card-lan-dealer,.dsh-card-lan-row{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.45));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2));',
      'transition:border-color .15s ease,background .15s ease}',
      '.dsh-card-lan-row.is-self{background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.55))}',
      '.dsh-card-lan-row.is-turn{border-color:var(--dsw-alias-brand-primary,#4d6bfe);',
      'box-shadow:inset 0 0 0 1px rgba(77,107,254,.35),0 0 14px rgba(77,107,254,.18)}',
      '.dsh-card-lan-row.is-win{border-left:3px solid rgba(34,197,94,.7)}',
      '.dsh-card-lan-row.is-lose{border-left:3px solid rgba(239,68,68,.7)}',
      '.dsh-card-lan-row.is-push{border-left:3px solid rgba(148,163,184,.7)}',
      '.dsh-card-lan-row-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh-card-lan-name{font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-card-lan-hand{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:40px}',
      '.dsh-card-lan-card{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;',
      'min-width:29px;height:40px;padding:0 5px;border-radius:6px;background:#f6f3ea;color:#1b1f27;',
      'font-size:15px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;',
      'box-shadow:0 2px 6px rgba(2,6,23,.35),inset 0 0 0 1px rgba(15,23,42,.10);user-select:none;-webkit-user-select:none}',
      '.dsh-card-lan-card.is-red{color:#cc2f26}',
      '.dsh-card-lan-card.is-back{background:repeating-linear-gradient(135deg,#3b5b8f 0 5px,#27436f 5px 10px);',
      'box-shadow:0 2px 6px rgba(2,6,23,.35),inset 0 0 0 1px rgba(255,255,255,.18)}',
      '.dsh-card-lan-empty{font-size:11px;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-radius:10px;',
      'font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.6));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.3));color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-banner.is-win{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.45);color:#4ade80}',
      '.dsh-card-lan-banner.is-lose{background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.42);color:#f87171}',
      '.dsh-card-lan-banner.is-push{background:rgba(148,163,184,.16);border-color:rgba(148,163,184,.42);color:#cbd5e1}',
      '.dsh-card-lan-banner.is-stale{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.45);color:#fbbf24}',
      '.dsh-card-lan-banner.is-none{font-weight:600}',
      '.dsh-card-lan-pulse-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 auto;',
      'animation:dsh-card-lan-pulse 1.4s ease-in-out infinite}',
      '@keyframes dsh-card-lan-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '.dsh-card-lan-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-log{display:flex;flex-direction:column;gap:2px;padding-top:4px;',
      'border-top:1px dashed var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-card-lan-log .dsh-card-lan-label{font-size:11px}',
      '.dsh-card-lan-log-line{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#94a3b8);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-card-lan-capsule{position:fixed;right:16px;bottom:96px;z-index:2147482200;display:inline-flex;',
      'align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:8px 14px;border-radius:999px;cursor:grab;touch-action:none;',
      'background:var(--dsw-alias-bg-overlay,rgba(15,23,42,.94));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'box-shadow:0 10px 28px rgba(2,6,23,.4);color:var(--dsw-alias-label-primary,#e2e8f0);font-size:12px;line-height:1.5;',
      'backdrop-filter:blur(10px);pointer-events:auto;user-select:none;-webkit-user-select:none;',
      'opacity:var(--dsh-card-lan-opacity,1);transition:opacity .18s ease}',
      '.dsh-card-lan-capsule:hover{border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.65))}',
      '.dsh-card-lan-capsule.is-dragging{cursor:grabbing}',
      '.dsh-card-lan-capsule:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}',
      '.dsh-card-lan-button:focus-visible,.dsh-card-lan-input:focus-visible,.dsh-card-lan-range:focus-visible{',
      'outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      '.dsh-card-lan-capsule-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:0 0 auto}',
      '.dsh-card-lan-capsule-dot.is-stale{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dsh-card-lan-capsule-phase{color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-capsule-stale{color:var(--dsw-alias-state-error-primary,#f87171);font-weight:600}',
      '.dsh-card-lan-capsule-hint{color:var(--dsw-alias-label-secondary,#94a3b8);opacity:.75}',
      '.dsh-card-lan-tag.is-game-doudizhu{background:rgba(245,158,11,.16);border-color:rgba(245,158,11,.4);color:#fbbf24}',
      '.dsh-card-lan-tag.is-game-paodekuai{background:rgba(34,211,238,.14);border-color:rgba(34,211,238,.4);color:#22d3ee}',
      '.dsh-card-lan-pill.is-game-paodekuai{background:rgba(34,211,238,.14);border-color:rgba(34,211,238,.45);color:#22d3ee}',
      '.dsh-card-lan-tag.is-game-blackjack{background:rgba(148,163,184,.14);border-color:rgba(148,163,184,.3);',
      'color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-pill.is-game-doudizhu{background:rgba(245,158,11,.16);border-color:rgba(245,158,11,.45);color:#fbbf24}',
      '.dsh-card-lan-tag.is-landlord{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.4);color:#f87171}',
      '.dsh-card-lan-tag.is-farmer{background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.35);color:#4ade80}',
      '.dsh-card-lan-tag.is-bid{background:rgba(245,158,11,.16);color:#fbbf24}',
      '.dsh-card-lan-bot-tag{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:999px;',
      'font-size:10px;line-height:1.7;white-space:nowrap;background:rgba(56,189,248,.16);',
      'border:1px solid rgba(56,189,248,.4);color:#7dd3fc}',
      '.dsh-card-lan-row.is-out{opacity:.55}',
      '.dsh-card-lan-ddz-play{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.4));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-card-lan-ddz-play.is-new{border-style:dashed}',
      '.dsh-card-lan-ddz-who{font-size:11px;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-ddz-must{margin:0;font-size:12px;font-weight:600;color:#fbbf24}',
      '.dsh-card-lan-ddz-hand-area{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.45));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-ddz-hand{display:flex;flex-wrap:wrap;gap:4px;align-items:flex-end;padding:4px 0 8px;min-height:38px}',
      '.dsh-card-lan-ddz-card{min-width:24px;height:34px;padding:0 3px;font-size:12px;border:2px solid transparent;',
      'cursor:pointer;transition:transform .12s ease,border-color .12s ease}',
      '.dsh-card-lan-ddz-card:hover{transform:translateY(-3px)}',
      '.dsh-card-lan-ddz-card.is-selected{transform:translateY(-6px);border-color:var(--dsw-alias-brand-primary,#4d6bfe);',
      'box-shadow:0 6px 12px rgba(77,107,254,.35)}',
      '.dsh-card-lan-ddz-result-mine{font-weight:700}',
      '@media (prefers-reduced-motion: reduce){.dsh-card-lan-pulse-dot{animation:none}',
      '.dsh-card-lan-overlay,.dsh-card-lan-capsule{transition:none}}',
    ].join('\n')

    /** Insert the plugin stylesheet once and return its remover. */
    function installStyles() {
      const existing = document.querySelector('style[data-plugin-css="dsh-card-lan/style.css"]')
      if (existing !== null) existing.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-card-lan'
      tag.dataset.pluginCss = 'dsh-card-lan/style.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposeStyles = installStyles()
        ctx.effect(() => () => disposeStyles(), 'dsh-card-lan: styles')
        ctx.effect(() => releaseStore, 'dsh-card-lan: polling keepalive')

        // Ctrl+Shift+H hides/shows the floating table from anywhere — including
        // while the composer or a settings input has focus (PROTOCOL §5.7).
        ctx.effect(() => {
          const onKeyDown = (event) => {
            if (event === null || typeof event !== 'object') return
            if (event.ctrlKey !== true && event.metaKey !== true) return
            if (event.shiftKey !== true) return
            const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
            if (key !== 'h') return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            overlayVisibility.toggle()
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, 'dsh-card-lan: overlay shortcut')

        // The table floats above the shell in the bottom-right corner; it
        // renders nothing until the local node actually has a seat.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'card-lan-table',
          order: 1002,
        }, function CardLanTableOverlay() {
          return h(TableOverlay, {})
        }))

        // One settings page: the LAN knobs, discovery and the local seat.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'card-lan',
          order: 136,
          label: () => '牌桌联机',
        }, function CardLanSettings() {
          return h(LobbySection, {})
        }))
      },
    }
  },
})
