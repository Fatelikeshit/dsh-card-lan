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

    /** Card suits: spades/clubs ink, hearts/diamonds red (engine.js encoding). */
    const SUIT_GLYPHS = { S: '♠', H: '♥', D: '♦', C: '♣' }
    const RED_SUITS = { H: true, D: true }

    /** Host-authoritative enums (engine.js state model). */
    const PHASES = { idle: '等待开始', playing: '玩家行动', dealer: '庄家行动', result: '本局结束' }
    const STATUSES = { playing: '要牌中', stand: '停牌', bust: '爆牌', blackjack: '黑杰克' }
    const RESULTS = { win: '赢', lose: '输', push: '平' }

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
      leave: '离开',
      staleTitle: '房主失联，等待重连…',
      staleDetail: '{s} 秒没有收到房主状态',
      yourTurn: '轮到你了',
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
      spectatorBadge: '观战中',
      spectatorHint: '观战中，不参与出牌',
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
     * Decode one engine card code: rank + suit, suit is the last character
     * ('AS' → A♠, '10H' → 10♥, 'KD' → K♦, '7C' → 7♣). Unknown shapes fall
     * back to the raw string so a bad payload can never throw.
     */
    function readCard(card) {
      const raw = typeof card === 'string' ? card.trim() : ''
      if (raw.length < 2) return { text: raw === '' ? '?' : raw, red: false }
      const suit = raw.slice(-1).toUpperCase()
      const rank = raw.slice(0, -1).toUpperCase()
      const glyph = SUIT_GLYPHS[suit]
      if (glyph === undefined || rank === '') return { text: raw, red: false }
      return { text: rank + glyph, red: RED_SUITS[suit] === true }
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
    function errorText(error) {
      if (error === null || error === undefined) return ''
      const code = typeof error === 'string'
        ? error
        : (typeof error.message === 'string' ? error.message : String(error))
      const trimmed = code.trim()
      if (trimmed === '') return ''
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
      const effectiveOpacity = opacityDraft !== null ? opacityDraft : configOpacity
      const effectiveSize = sizeDraft !== null ? sizeDraft : configSize
      const effectiveAutoFade = autoFadeDraft !== null ? autoFadeDraft : configAutoFade

      useEffect(() => {
        setOpacityDraft(null)
      }, [configOpacity])

      useEffect(() => {
        setSizeDraft(null)
      }, [configSize])

      useEffect(() => {
        setAutoFadeDraft(null)
      }, [configAutoFade])

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

      const resetOverlayPosition = () => {
        void applyDisplay({ overlayX: null, overlayY: null }, zh.resetPositionDone)
      }

      const act = async (body, successText) => {
        setBusy(true)
        showNotice('')
        const result = await store.action(body)
        setBusy(false)
        if (result.ok === true) showNotice(successText === undefined ? '' : successText, false)
        else showNotice(errorText(result.error) || zh.actionFailed, true)
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
        lastError !== null && lastError !== undefined
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
          role !== null
            ? h('span', { key: 'phase', className: 'dsh-card-lan-tag is-' + phase },
              PHASES[phase] !== undefined ? PHASES[phase] : phase)
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
          ? h('button', {
            key: 'open',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-primary',
            disabled: busy || !enabled,
            onClick: () => void act({ type: 'open' }, zh.noticeOpen),
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
          }, phase === 'result' ? zh.nextRound : zh.startRound)
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
        // Open tables always show their head count; join/watch buttons are added
        // next to it when this node has no seat yet (PROTOCOL §5).
        const children = [
          h('div', { key: 'main', className: 'dsh-card-lan-peer-main' }, [
            h('div', { key: 'name', className: 'dsh-card-lan-peer-name' }, peerNick),
            h('div', { key: 'meta', className: 'dsh-card-lan-peer-meta' },
              fmt(zh.peerMeta, { ip, port: port > 0 ? port : '?', s: age })
              + (spectators > 0 ? ' · ' + fmt(zh.spectatorCount, { n: spectators }) : '')),
          ]),
        ]
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
      }, [])

      const table = data !== null ? asObject(data.table) : null
      if (table === null || hidden) return null

      const tableRole = asString(table.role, 'player')
      const role = tableRole === 'host' ? 'host' : (tableRole === 'spectator' ? 'spectator' : 'player')
      const isSpectator = role === 'spectator'
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
      const phaseLabel = PHASES[phase] !== undefined ? PHASES[phase] : phase
      const myResult = me !== undefined ? asString(me.result, '') : ''
      const scoreMap = asObject(table.scores) !== null
        ? asObject(table.scores)
        : (data !== null ? asObject(data.scores) : null)
      const logLines = asArray(table.log)
        .map(logText)
        .filter((line) => line !== '')
        .slice(-3)

      const showNotice = (text, isError) => {
        setNotice(text === undefined || text === null || text === '' ? null : { text, error: isError === true })
      }

      const act = async (body, successText) => {
        setBusy(true)
        showNotice('')
        const result = await store.action(body)
        setBusy(false)
        if (result.ok === true) showNotice(successText === undefined ? '' : successText, false)
        else showNotice(errorText(result.error) || zh.actionFailed, true)
        return result.ok === true
      }

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
      const startDrag = (event) => {
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
        }
        state.detach = detach
        dragState.current = state
        setDragging(true)
        setHovered(true)
        if (typeof event.preventDefault === 'function') event.preventDefault()
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

      let hint = ''
      if (isSpectator) {
        hint = zh.spectatorHint
      } else if (phase === 'playing') {
        hint = myTurn ? zh.yourTurn : (turnNick !== '' ? fmt(zh.waitOthers, { name: turnNick }) : zh.waitHost)
      } else if (phase === 'idle') {
        hint = role === 'host' ? zh.idleHostHint : zh.waitHostStart
      } else if (phase === 'dealer') {
        hint = zh.dealerRunning
      } else if (phase === 'result') {
        hint = role === 'host' ? zh.resultHostHint : zh.waitHostNext
      }

      if (minimized) {
        return h('div', {
          className: 'dsh-card-lan-capsule',
          style: overlayStyle,
          role: 'button',
          tabIndex: 0,
          title: zh.expand,
          onClick: () => setMinimized(false),
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
          h('span', { key: 'dot', className: 'dsh-card-lan-capsule-dot' + (stale ? ' is-stale' : '') }),
          h('span', { key: 'text' }, round > 0 ? fmt(zh.capsule, { n: round }) : zh.capsuleIdle),
          h('span', { key: 'phase', className: 'dsh-card-lan-capsule-phase' }, phaseLabel),
          stale ? h('span', { key: 'stale', className: 'dsh-card-lan-capsule-stale' }, zh.capsuleStale) : null,
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
          }, round > 0 ? fmt(zh.tableTitle, { n: round }) : zh.tableTitleIdle),
          h('span', { key: 'phase', className: 'dsh-card-lan-pill is-' + phase }, phaseLabel),
          isSpectator
            ? h('span', { key: 'spectator', className: 'dsh-card-lan-pill is-spectator' }, zh.spectatorBadge)
            : null,
          h('div', { key: 'tools', className: 'dsh-card-lan-head-tools' }, [
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

      const staleBanner = stale
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

      const resultBanner = phase === 'result'
        ? h('div', {
          key: 'result',
          className: 'dsh-card-lan-banner is-' + (myResult !== '' ? myResult : 'none'),
          role: 'status',
        }, myResult === 'win'
          ? zh.resultWin
          : myResult === 'lose' ? zh.resultLose : myResult === 'push' ? zh.resultPush : zh.resultOver)
        : null

      const actionNodes = []
      if (canStart) {
        actionNodes.push(h('button', {
          key: 'start',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy,
          onClick: () => void act({ type: 'start' }, zh.noticeStart),
        }, phase === 'result' ? zh.nextRound : zh.startRound))
      }
      // Spectators never see seat actions (PROTOCOL.md §5 overlay 8).
      if (phase === 'playing' && me !== undefined && !isSpectator) {
        actionNodes.push(h('button', {
          key: 'hit',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy || !myTurn,
          onClick: () => void act({ type: 'hit' }),
        }, zh.hit))
        actionNodes.push(h('button', {
          key: 'stand',
          type: 'button',
          className: 'dsh-card-lan-button',
          disabled: busy || !myTurn,
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

      const bodyChildren = [dealerBlock]
      for (const row of rows) bodyChildren.push(row)
      if (resultBanner !== null) bodyChildren.push(resultBanner)
      if (actionNodes.length > 0) {
        bodyChildren.push(h('div', { key: 'actions', className: 'dsh-card-lan-actions' }, actionNodes))
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
        staleBanner,
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
      '.dsh-card-lan-status{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.4));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-card-lan-status-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-card-lan-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block;',
      'background:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-dot.is-on{background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 3px rgba(34,197,94,.16)}',
      '.dsh-card-lan-dot.is-off{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dsh-card-lan-error{margin:0;color:var(--dsw-alias-state-error-primary,#f87171);font-size:12px;word-break:break-word}',
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
      'align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:8px 14px;border-radius:999px;cursor:pointer;',
      'background:var(--dsw-alias-bg-overlay,rgba(15,23,42,.94));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'box-shadow:0 10px 28px rgba(2,6,23,.4);color:var(--dsw-alias-label-primary,#e2e8f0);font-size:12px;line-height:1.5;',
      'backdrop-filter:blur(10px);pointer-events:auto;user-select:none;-webkit-user-select:none;',
      'opacity:var(--dsh-card-lan-opacity,1);transition:opacity .18s ease}',
      '.dsh-card-lan-capsule:hover{border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.65))}',
      '.dsh-card-lan-capsule:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}',
      '.dsh-card-lan-button:focus-visible,.dsh-card-lan-input:focus-visible,.dsh-card-lan-range:focus-visible{',
      'outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      '.dsh-card-lan-capsule-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:0 0 auto}',
      '.dsh-card-lan-capsule-dot.is-stale{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dsh-card-lan-capsule-phase{color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-capsule-stale{color:var(--dsw-alias-state-error-primary,#f87171);font-weight:600}',
      '.dsh-card-lan-capsule-hint{color:var(--dsw-alias-label-secondary,#94a3b8);opacity:.75}',
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
