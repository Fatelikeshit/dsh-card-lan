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
    const GAME_LABELS = {
      blackjack: '21 点',
      doudizhu: '斗地主',
      paodekuai: '跑得快',
      guandan: '掼蛋',
      zhajinhua: '炸金花',
      texas: '德州扑克',
      mahjong4: '日麻·四人',
      mahjong3: '日麻·三人',
    }
    const GAME_ORDER = [
      'blackjack', 'doudizhu', 'paodekuai', 'guandan', 'zhajinhua', 'texas', 'mahjong4', 'mahjong3',
    ]
    const DEFAULT_GAME = 'blackjack'

    /** Dou Dizhu phases (PROTOCOL §7.3): idle is the pre-deal table state. */
    const DDZ_PHASES = { idle: '等待开始', bidding: '叫地主中', playing: '出牌中', result: '本局结束' }

    /** Pao De Kuai phases (PROTOCOL §7.6): no bidding, no landlord. */
    const PDK_PHASES = { idle: '等待开始', playing: '出牌中', result: '本局结束' }

    /** Guandan phases (PROTOCOL §7.12): v10 adds the tribute exchange phase. */
    const GD_PHASES = { idle: '等待开始', tribute: '进贡还贡', playing: '出牌中', result: '本局结束' }

    /** Guandan finishing labels, first out → last out. */
    const GD_ORDER_LABELS = ['头游', '二游', '三游', '末游']

    /** Guandan needs a wider panel so 27 cards wrap into readable rows. */
    const GUANDAN_MIN_WIDTH = 420

    /** Zhajinhua phases (PROTOCOL §7.14): betting round, then result. */
    const ZJH_PHASES = { idle: '等待开始', bidding: '下注中', result: '本局结束' }

    /** Zhajinhua caps the number of raises per round (PROTOCOL §7.14). */
    const ZJH_MAX_RAISES = 5

    /** Texas Hold'em phases and fixed blind/raise sizing (PROTOCOL §7.16). */
    const TX_PHASES = {
      idle: '等待开始',
      preflop: '翻前',
      flop: '翻牌',
      turn: '转牌',
      river: '河牌',
      result: '本局结束',
    }
    const TX_SMALL_BLIND = 10
    const TX_BIG_BLIND = 20
    const TX_RAISE_STEP = 20

    /** Japanese Mahjong (PROTOCOL §7.18): 4-player and 3-player variants. */
    const MJ_PHASES = { idle: '等待开始', playing: '对局中', calling: '鸣牌中', result: '本局结束' }
    const MJ_WIDTH = 740
    const MJ_SUIT_TEXT = { m: '萬', p: '筒', s: '索' }
    const MJ_HONOR_TEXT = { E: '東', S: '南', W: '西', N: '北', P: '白', F: '發', C: '中' }

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
      'invalid-autofillbots': '自动补齐开关不合法：需要布尔值。',
      'invalid-fillbots': '人机补位开关必须是一个布尔值。',
      'bad-cards': '牌型不合法，或者压不过上家；换一手再试。',
      'no-chips': '筹码不足，跟不了这一注。',
      'compare-unavailable': '现在不能比牌：场上还有不止 2 个人没弃牌。',
      'raise-cap': '本局加注次数已用完（最多 5 次）。',
      'bad-raise': '加注额不合法：不满足最低加注或筹码不足。',
      'bad-tile': '这张牌不在你的手牌里，换一张再试。',
      'not-winning': '现在的牌型不能和了。',
      'not-pending': '现在没有需要你响应的鸣牌。',
      'bad-call': '这个鸣牌动作不合法，或不能这样吃碰杠。',
      'furiten': '振听中，不能荣和。',
      'bad-riichi': '现在不能立直（需要门清、至少 1000 点且牌墙足够）。',
      'no-yaku': '无役，不能和了。',
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
      tabRoom: '房间',
      tabSettings: '设置',
      tabsLabel: '牌桌联机页签',
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
      inviteLabel: '邀请朋友',
      inviteCode: '邀请码',
      copyInvite: '复制房间名+端口',
      inviteCopied: '已复制邀请：{code}',
      inviteCopyFailed: '复制失败，请手动复制：{code}',
      invitePlaceholder: '粘贴朋友发来的邀请',
      applyInvite: '应用',
      inviteApplied: '已应用邀请：房间「{room}」、端口 {port}（已保存）',
      inviteApplyFailed: '{error}；已填入表单，可到「设置」页签修正后保存。',
      inviteInvalid: '无法识别的邀请，需要包含房间名和端口（1024–65535）。',
      inviteHint: '复制出的格式是 DSH-CARD-LAN|房间名|端口；粘贴后点「应用」会直接保存，无需再去设置页保存。',
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
      autoFillBots: '自动补齐',
      autoFillBotsHint: '人数不足时自动补满 3 人',
      botCountHint: '自动补齐：人数不足时自动补满 3 人；关闭后按「机器人数量」补位（最多 2 个）；后加入的真人会顶掉机器人；21 点不受影响。',
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
      gdTitle: '掼蛋 · 第 {n} 局',
      gdTitleIdle: '掼蛋 · 未开局',
      gdCapsule: '掼蛋 · 第 {n} 局',
      gdCapsuleIdle: '掼蛋 · 未开局',
      gdLevelInfo: '打 {level} · 我方 {ours} / 对方 {theirs}',
      gdLevelInfoSpectator: '打 {level} · 队伍1 {a} / 队伍2 {b}',
      gdTeamOurs: '我方',
      gdTeamTheirs: '对方',
      gdTeamPartner: '我方·对家',
      gdTeamOne: '队伍1',
      gdTeamTwo: '队伍2',
      gdWild: '配',
      gdUpgradeOurs: '本局 +{n} 级（我们）',
      gdUpgradeTheirs: '本局 +{n} 级（对方）',
      gdUpgradeTeam: '本局 +{n} 级（队伍{team}）',
      gdVictory: '过 A，胜利',
      gdRoundOver: '本局结束',
      gdOrdersTitle: '名次',
      noPlayersGuandan: '人数不足：掼蛋需要 4 人',
      gdTributeTitle: '进贡 / 还贡',
      gdTributeSkipped: '抗贡',
      gdTributeGift: '贡 {card}',
      gdTributeReturned: '还 {card}',
      gdTributePending: '待还贡',
      gdTributeDone: '已还贡',
      gdTributePrompt: '请选一张 ≤10 的牌还贡',
      gdTributeSelectHint: '只能选 ≤10 的牌或红桃级牌还贡',
      gdTributeSubmit: '还贡',
      gdTributeWaiting: '等待 {name} 还贡…',
      gdTributeWaitAll: '等待进贡 / 还贡完成…',
      zjhTitle: '炸金花 · 第 {n} 局',
      zjhTitleIdle: '炸金花 · 未开局',
      zjhCapsule: '炸金花 · 第 {n} 局',
      zjhCapsuleIdle: '炸金花 · 未开局',
      zjhPot: '底池 {n}',
      zjhCurrentBet: '当前注 {n}',
      zjhRaises: '加注 {n}/{max}',
      zjhChips: '筹码 {n}',
      zjhBet: '本局 {n}',
      zjhBlind: '闷牌',
      zjhSeen: '已看牌',
      zjhFolded: '弃牌',
      zjhWinTag: '赢',
      zjhMyArea: '我的牌',
      zjhLook: '看牌',
      zjhCall: '跟注 {n}',
      zjhCallBlind: '跟注 {n}（闷）',
      zjhRaise: '加注',
      zjhFold: '弃牌',
      zjhCompare: '比牌',
      zjhWin: '你赢了 +{pot}',
      zjhLose: '你输了',
      zjhWinner: '赢家：{name}',
      zjhRoundOver: '本局结束',
      zjhHintSeen: '轮到你行动',
      zjhHintBlind: '轮到你行动（闷牌，可先看牌）',
      zjhWait: '等待 {name} 行动…',
      zjhHandsTitle: '所有人手牌',
      zjhUnseen: '未亮牌',
      zjhLabel235: '235（吃豹子）',
      noPlayersZjh: '人数不足：炸金花需要 2 人',
      txTitle: '德州扑克 · 第 {n} 局',
      txTitleIdle: '德州扑克 · 未开局',
      txCapsule: '德州扑克 · 第 {n} 局',
      txCapsuleIdle: '德州扑克 · 未开局',
      txPot: '底池 {n}',
      txCurrentBet: '当前注 {n}',
      txBlinds: '盲注 {sb}/{bb}',
      txChips: '筹码 {n}',
      txStreetBet: '本街 {n}',
      txCommitted: '本局 {n}',
      txDealerMark: 'D',
      txSbMark: 'SB',
      txBbMark: 'BB',
      txStatusActive: '行动中',
      txStatusFolded: '弃牌',
      txStatusAllin: '全下',
      txCommunity: '公共牌',
      txMyCards: '我的底牌',
      txFold: '弃牌',
      txCheck: '过牌',
      txCall: '跟注 {n}',
      txAllin: '全下 {n}',
      txRaiseTo: '加注到 {n}',
      txRaise: '加注',
      txRaiseTarget: '加注到 {n}（本街投入）',
      txRaiseAmount: '加注金额',
      txRaiseAmountNum: '加注金额（数字）',
      txMinRaise: '最小加注',
      txAllInBtn: '全下',
      txCancelRaise: '取消',
      txWin: '你赢了 +{n}',
      txLose: '你输了',
      txWinner: '赢家：{name}',
      txRoundOver: '本局结束',
      txWinTag: '赢',
      txWinnersTitle: '赢家手牌',
      txPotsTitle: '底池分配',
      txPotLine: '池 {amount}：{names}',
      txWait: '等待 {name} 行动…',
      txYourTurn: '轮到你行动',
      txEmptySlot: '空位',
      noPlayersTexas: '人数不足：德州扑克需要 2 人',
      noPlayersMahjong4: '人数不足：日麻·四人需要 4 人',
      noPlayersMahjong3: '人数不足：日麻·三人需要 3 人',
      mj4Title: '日麻·四人 · 第 {n} 局',
      mj4TitleIdle: '日麻·四人 · 未开局',
      mj4Capsule: '日麻·四人 · 第 {n} 局',
      mj4CapsuleIdle: '日麻·四人 · 未开局',
      mj3Title: '日麻·三人 · 第 {n} 局',
      mj3TitleIdle: '日麻·三人 · 未开局',
      mj3Capsule: '日麻·三人 · 第 {n} 局',
      mj3CapsuleIdle: '日麻·三人 · 未开局',
      mjDealerMark: '莊',
      mjDoras: '宝牌',
      mjWall: '剩 {n} 张',
      mjNuki: '拔北 {n}',
      mjHandCount: '手牌 {n} 张',
      mjRiver: '牌河',
      mjEmptyRiver: '牌河为空',
      mjMyHand: '我的手牌（{n} 张）',
      mjDiscard: '打出',
      mjNukiBtn: '拔北',
      mjTsumo: '自摸和了',
      mjWin: '和了（里程碑①）',
      mjExhausted: '流局',
      mjRoundOver: '本局结束',
      mjWinner: '和了者：{name}',
      mjReveal: '所有人手牌',
      mjHintYourTurn: '轮到你摸打',
      mjHintWait: '等待 {name} 出手…',
      mjSelectHint: '请选择要打出的牌',
      mjSelected: '已选 {n} 张',
      mjDoras: '宝牌',
      mjCallBar: '{name} 打出 {tile}',
      mjCallWait: '等待其他玩家响应…',
      mjRon: '荣和',
      mjPon: '碰',
      mjKan: '杠',
      mjChi: '吃',
      mjPass: '过',
      mjChiChoice: '选择吃法',
      mjChiOption: '吃 {a}+{b}',
      mjMeldChi: '吃',
      mjMeldPon: '碰',
      mjMeldKan: '明杠',
      mjMeldAnkan: '暗杠',
      mjMeldKakan: '加杠',
      mjMelds: '副露',
      mjAnkanButton: '暗杠 {tile}',
      mjKakanButton: '加杠 {tile}',
      mjFuriten: '振听中（不能荣和）',
      mjPoints: '点数',
      mjPointValue: '{n} 点',
      mjRiichi: '立直',
      mjRiichiDone: '已立直',
      mjRiichiAuto: '立直中：自动摸切',
      mjRiichiSticks: '立直棒 {n}',
      mjRiichiStickLine: '立直棒 {n} 根归和了者',
      mjYakuTitle: '役种',
      mjYakuLine: '{name}（{han} 番）',
      mjWinnerLine: '和了者：{name}（{type}）',
      mjTsumoType: '自摸',
      mjRonType: '荣和',
      mjFuLine: '{fu} 符',
      mjHanLine: '{han} 番',
      mjScoreLine: '{n} 点',
      mjDorasTitle: '宝牌',
      mjUraTitle: '里宝',
      mjAkaTitle: '赤宝 {n}',
      mjDoraHanLine: '宝牌 {n} 番',
      mjUraHanLine: '里宝 {n} 番',
      mjDeltasTitle: '点数变化',
      mjDeltaLine: '{name} {delta}',
      mjRoundDealer: '東 {n} 局 · 庄家 {name}',
      mjDealerName: '庄家 {name}',
      mjDealerRepeat: '连庄',
      mjMatchOver: '东风战结束',
      mjNewMatch: '开始新东风战',
      mjFinalRanking: '最终排名',
      mjRankLine: '{rank}. {name} {points} 点',
      mjTenpaiTitle: '流局结算',
      mjTenpai: '听牌',
      mjNoten: '不听',
      mjRiichiKept: '立直棒保留（{n} 根）',
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
     * Invite sharing (PROTOCOL §7.10): pure client-side room+port exchange.
     * ------------------------------------------------------------------ */

    /** Max room-name length for an invite (mirrors PROTOCOL §1). */
    const INVITE_ROOM_MAX = 32

    /** Build the shareable invite code for the lobby form values. */
    function inviteCodeOf(room, port) {
      const name = room === undefined || room === null ? '' : String(room).trim()
      return 'DSH-CARD-LAN|' + name + '|' + String(port)
    }

    /**
     * Copy one string to the clipboard: the async Clipboard API first, then a
     * throwaway textarea + execCommand('copy') for insecure contexts/blocks.
     * Resolves true only when something actually copied.
     */
    async function copyText(text) {
      const value = typeof text === 'string' ? text : String(text)
      try {
        if (typeof navigator !== 'undefined' && navigator !== null
          && navigator.clipboard !== undefined && navigator.clipboard !== null
          && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (error) {
        // Permission/secure-context failures fall through to the legacy path.
      }
      try {
        if (typeof document === 'undefined' || document === null) return false
        const area = document.createElement('textarea')
        area.value = value
        if (typeof area.setAttribute === 'function') area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        if (document.body !== undefined && document.body !== null) document.body.appendChild(area)
        if (typeof area.select === 'function') area.select()
        if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, value.length)
        const copied = typeof document.execCommand === 'function' && document.execCommand('copy') === true
        if (area.parentNode !== null && area.parentNode !== undefined
          && typeof area.parentNode.removeChild === 'function') {
          area.parentNode.removeChild(area)
        }
        return copied
      } catch (error) {
        return false
      }
    }

    /**
     * Parse a pasted invite. Accepts `DSH-CARD-LAN|room|port` plus looser
     * `room port`, `room,port`, `room；port`, `room|port` spellings; the port is
     * the only 1024–65535 integer token, everything else is the room name.
     * Returns { room, port } or null when the payload is unusable.
     */
    function parseInvite(raw) {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text === '') return null
      let room = ''
      let port = Number.NaN
      const prefix = 'DSH-CARD-LAN|'
      if (text.slice(0, prefix.length).toUpperCase() === prefix) {
        const parts = text.split('|')
        room = (parts[1] !== undefined ? parts[1] : '').trim()
        port = Number((parts[2] !== undefined ? parts[2] : '').trim())
      } else {
        const tokens = text.split(/[|,，;；\t ]+/).filter((token) => token !== '')
        const rooms = []
        const ports = []
        for (const token of tokens) {
          const numeric = Number(token)
          if (/^\d+$/.test(token) && Number.isInteger(numeric) && numeric >= 1024 && numeric <= 65535) {
            ports.push(numeric)
          } else {
            rooms.push(token)
          }
        }
        if (ports.length === 1) {
          port = ports[0]
          room = rooms.join(' ').trim()
        }
      }
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
      if (room === '' || room.length > INVITE_ROOM_MAX) return null
      if (/[\u0000-\u001f\u007f]/.test(room)) return null
      return { room, port }
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
      return value === 'doudizhu' || value === 'paodekuai' || value === 'guandan'
        || value === 'zhajinhua' || value === 'texas'
        || value === 'mahjong4' || value === 'mahjong3'
        ? value
        : DEFAULT_GAME
    }

    /** Human label for one game id. */
    function gameLabelOf(value) {
      return GAME_LABELS[gameOf(value)]
    }

    /** True for the card-game tables that share the Doudizhu-style layout. */
    function isCardGameId(game) {
      return game === 'doudizhu' || game === 'paodekuai' || game === 'guandan'
    }

    /** True for the two Japanese Mahjong game ids (PROTOCOL §7.18). */
    function isMahjongId(game) {
      return game === 'mahjong4' || game === 'mahjong3'
    }

    /** True when the id is a 3-player Mahjong table (three-player rules). */
    function isMahjongThree(game) {
      return game === 'mahjong3'
    }

    /**
     * Decode one Mahjong tile (`1m`..`9s`, honors `E/S/W/N/P/F/C`, red `5m r`).
     * Returns the text glyphs plus a tone ('red' for 中/赤5, 'green' for 發).
     */
    function readMahjongTile(tile) {
      const raw = typeof tile === 'string' ? tile.trim() : ''
      if (raw === '') return { text: '?', tone: '' }
      const honor = MJ_HONOR_TEXT[raw]
      if (honor !== undefined) {
        const tone = raw === 'C' ? 'red' : (raw === 'F' ? 'green' : '')
        return { text: honor, tone }
      }
      const isRed = raw.length >= 3 && raw.slice(-1) === 'r'
      const base = isRed ? raw.slice(0, -1) : raw
      const suit = base.slice(-1)
      const rank = base.slice(0, -1)
      const suitText = MJ_SUIT_TEXT[suit]
      if (suitText === undefined || !/^[1-9]$/.test(rank)) return { text: raw, tone: '' }
      return { text: (isRed ? '赤' : '') + rank + suitText, tone: isRed ? 'red' : '' }
    }

    /** Phase label for the active game. */
    function phaseLabelFor(game, phase) {
      const labels = game === 'doudizhu'
        ? DDZ_PHASES
        : (game === 'paodekuai'
          ? PDK_PHASES
          : (game === 'guandan'
            ? GD_PHASES
            : (game === 'zhajinhua'
              ? ZJH_PHASES
              : (game === 'texas' ? TX_PHASES : (isMahjongId(game) ? MJ_PHASES : PHASES)))))
      return labels[phase] !== undefined ? labels[phase] : phase
    }

    /** Overlay title for the active game ("21 点 · 第 2 局" etc.). */
    function gameTitleOf(game, round) {
      if (game === 'doudizhu') return round > 0 ? fmt(zh.ddzTitle, { n: round }) : zh.ddzTitleIdle
      if (game === 'paodekuai') return round > 0 ? fmt(zh.pkTitle, { n: round }) : zh.pkTitleIdle
      if (game === 'guandan') return round > 0 ? fmt(zh.gdTitle, { n: round }) : zh.gdTitleIdle
      if (game === 'zhajinhua') return round > 0 ? fmt(zh.zjhTitle, { n: round }) : zh.zjhTitleIdle
      if (game === 'texas') return round > 0 ? fmt(zh.txTitle, { n: round }) : zh.txTitleIdle
      if (game === 'mahjong4') return round > 0 ? fmt(zh.mj4Title, { n: round }) : zh.mj4TitleIdle
      if (game === 'mahjong3') return round > 0 ? fmt(zh.mj3Title, { n: round }) : zh.mj3TitleIdle
      return round > 0 ? fmt(zh.tableTitle, { n: round }) : zh.tableTitleIdle
    }

    /** Minimised-capsule title for the active game. */
    function gameCapsuleTitleOf(game, round) {
      if (game === 'doudizhu') return round > 0 ? fmt(zh.ddzCapsule, { n: round }) : zh.ddzCapsuleIdle
      if (game === 'paodekuai') return round > 0 ? fmt(zh.pkCapsule, { n: round }) : zh.pkCapsuleIdle
      if (game === 'guandan') return round > 0 ? fmt(zh.gdCapsule, { n: round }) : zh.gdCapsuleIdle
      if (game === 'zhajinhua') return round > 0 ? fmt(zh.zjhCapsule, { n: round }) : zh.zjhCapsuleIdle
      if (game === 'texas') return round > 0 ? fmt(zh.txCapsule, { n: round }) : zh.txCapsuleIdle
      if (game === 'mahjong4') return round > 0 ? fmt(zh.mj4Capsule, { n: round }) : zh.mj4CapsuleIdle
      if (game === 'mahjong3') return round > 0 ? fmt(zh.mj3Capsule, { n: round }) : zh.mj3CapsuleIdle
      return round > 0 ? fmt(zh.capsule, { n: round }) : zh.capsuleIdle
    }

    /**
     * True when the cards form Zhajinhua's special 235 (2/3/5, all different
     * suits) — PROTOCOL §7.14 v10: it beats any 豹子.
     */
    function isZjh235(cards) {
      const list = asArray(cards).filter((card) => typeof card === 'string' && card !== '')
      if (list.length !== 3) return false
      const ranks = []
      const suits = []
      for (const card of list) {
        const raw = card.trim().toUpperCase()
        if (raw.length < 2) return false
        ranks.push(raw.slice(0, -1))
        suits.push(raw.slice(-1))
      }
      if (ranks.slice().sort().join(',') !== '2,3,5') return false
      return new Set(suits).size === 3
    }

    /** Team index from an untrusted value (0/1) or null. */
    function teamIndexOf(value, fallback) {
      if (value !== null && value !== undefined && value !== '' && typeof value !== 'boolean') {
        const numeric = Number(value)
        if (Number.isInteger(numeric) && (numeric === 0 || numeric === 1)) return numeric
      }
      if (fallback !== undefined) return teamIndexOf(fallback)
      return null
    }

    /** True when the card is the heart level card (Guandan wild card, 「配」). */
    function isGuandanWild(card, level) {
      const rank = typeof card === 'string' ? card.trim().toUpperCase() : ''
      const levelRank = typeof level === 'string' ? level.trim().toUpperCase() : ''
      if (rank.length < 2 || levelRank === '') return false
      return rank.slice(-1) === 'H' && rank.slice(0, -1) === levelRank
    }

    /**
     * True when the card may be returned as tribute (PROTOCOL §7.12): natural
     * point ≤ 10 (2–10). The host engine rejects anything else with `bad-cards`.
     */
    function isGuandanTributeCard(card, level) {
      const raw = typeof card === 'string' ? card.trim().toUpperCase() : ''
      if (raw === '' || raw === 'BJ' || raw === 'RJ') return false
      const rank = raw.slice(0, -1)
      if (rank === '10') return true
      if (rank.length === 1) {
        const numeric = Number(rank)
        return Number.isInteger(numeric) && numeric >= 2 && numeric <= 9
      }
      return false
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
      if (trimmed === 'must-play' && (game === 'paodekuai' || game === 'guandan')) return zh.pkMustPlay
      // Dou Dizhu / Pao De Kuai need 3 seats (Guandan 4, Zhajinhua 2); short
      // tables report `no-players`.
      if (trimmed === 'no-players') {
        if (game === 'guandan') return zh.noPlayersGuandan
        if (game === 'zhajinhua') return zh.noPlayersZjh
        if (game === 'texas') return zh.noPlayersTexas
        if (game === 'mahjong4') return zh.noPlayersMahjong4
        if (game === 'mahjong3') return zh.noPlayersMahjong3
        if (isCardGameId(game)) return zh.noPlayersCard
      }
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

    /**
     * One hand card; `onToggle` (when given) makes it selectable. `badge`
     * renders a tiny corner marker (Guandan's 「配」 wild card); `disabledHint`
     * marks a non-selectable card (Guandan tribute return, rank > 10).
     */
    function ddzCardNode(card, key, selected, onToggle, badge, disabledHint) {
      const face = readCard(card)
      const props = {
        key,
        className: 'dsh-card-lan-card dsh-card-lan-ddz-card'
          + (face.red ? ' is-red' : '')
          + (selected === true ? ' is-selected' : '')
          + (disabledHint !== undefined && disabledHint !== null && disabledHint !== ''
            ? ' is-disabled'
            : ''),
        title: disabledHint !== undefined && disabledHint !== null && disabledHint !== ''
          ? disabledHint
          : face.text,
        'aria-label': face.text,
      }
      if (disabledHint !== undefined && disabledHint !== null && disabledHint !== '') {
        props['aria-disabled'] = true
      }
      if (onToggle !== null && onToggle !== undefined) {
        props.role = 'button'
        props.tabIndex = 0
        props['aria-pressed'] = selected === true
        props.onClick = () => onToggle()
        props.onKeyDown = (event) => {
          if (event === null || event === undefined) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle()
          }
        }
      }
      const children = [face.text]
      if (badge !== undefined && badge !== null && badge !== '') {
        children.push(h('span', { key: 'badge', className: 'dsh-card-lan-ddz-badge' }, badge))
      }
      return h('span', props, children)
    }

    /**
     * Card-table body shared by Dou Dizhu (PROTOCOL §7.3), Pao De Kuai (§7.6)
     * and Guandan (§7.12): seats + last play + hand + play/pass. `props.game`
     * switches the game-specific extras (bidding/landlord only in Dou Dizhu,
     * teams/levels/orders only in Guandan).
     * A pure renderer: every value comes from the polled view, every write
     * goes back through a callback.
     */
    function buildCardGameContent(props) {
      const game = isCardGameId(props.game) ? props.game : 'doudizhu'
      const isDdz = game === 'doudizhu'
      const isPdk = game === 'paodekuai'
      const isGd = game === 'guandan'
      const gd = isGd ? asObject(props.guandan) : null
      const role = props.role
      const isSpectator = props.isSpectator === true
      const phase = props.phase
      const players = props.players
      const me = props.me
      const turnNode = asString(props.turnNode, '')
      const myNode = asString(props.myNode, '')
      const myCards = props.myCards
      // Selection is by hand index: Guandan plays with two decks, so the same
      // card code can appear twice in one hand.
      const selectedIndexes = asArray(props.selectedIndexes)
      const lastPlay = props.lastPlay
      const mustPlay = props.mustPlay === true
      const landlordPlayer = props.landlordPlayer
      const busy = props.busy === true
      const connectionBroken = props.connectionBroken === true
      const turnRemainingMs = asNumber(props.turnRemainingMs, -1)
      const activeTurn = !isSpectator && turnNode !== '' && turnNode === myNode
      const gdMyTeam = gd !== null ? gd.myTeam : null
      const mySeatIndex = isGd ? players.indexOf(me) : -1
      // Guandan v10 tribute exchange (PROTOCOL §7.12): pendingReturn asks one
      // receiver to pick a rank-≤10 card back.
      const gdTribute = isGd ? asArray(props.tribute) : []
      const pendingReturnNode = isGd ? asString(props.pendingReturn, '') : ''
      const tributeReturnMode = isGd && phase === 'tribute' && !isSpectator
        && myNode !== '' && pendingReturnNode === myNode

      const playerByNode = (node) => {
        const target = asString(node, '')
        for (const slot of players) {
          if (asString(slot.node, '') === target) return slot
        }
        return undefined
      }

      /* ---------- header extras: game pill, landlord (DDZ), levels (GD) ---------- */
      const headExtras = [
        h('span', { key: 'game', className: 'dsh-card-lan-pill is-game-' + game }, GAME_LABELS[game]),
      ]
      if (isDdz && landlordPlayer !== undefined) {
        headExtras.push(h('span', { key: 'landlord', className: 'dsh-card-lan-tag is-landlord' },
          fmt(zh.ddzLandlordMark, { name: asString(landlordPlayer.nick, zh.ddzLandlord) })))
      }
      if (isGd && gd !== null) {
        const level = asString(gd.level, '2')
        const levels = asArray(gd.teamLevels)
        const first = asString(levels[0], '2')
        const second = asString(levels[1], '2')
        const levelText = gdMyTeam !== null
          ? fmt(zh.gdLevelInfo, {
            level,
            ours: gdMyTeam === 0 ? first : second,
            theirs: gdMyTeam === 0 ? second : first,
          })
          : fmt(zh.gdLevelInfoSpectator, { level, a: first, b: second })
        headExtras.push(h('span', { key: 'level', className: 'dsh-card-lan-tag is-level' }, levelText))
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
      } else if (phase === 'tribute') {
        if (tributeReturnMode) {
          hint = zh.gdTributePrompt
        } else {
          const pendingPlayer = playerByNode(pendingReturnNode)
          const pendingNick = pendingPlayer !== undefined ? asString(pendingPlayer.nick, '') : ''
          hint = pendingNick !== '' ? fmt(zh.gdTributeWaiting, { name: pendingNick }) : zh.gdTributeWaitAll
        }
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

      /* ---------- Guandan tribute exchange (PROTOCOL §7.12, v10) ---------- */
      if (isGd && phase === 'tribute' && gdTribute.length > 0) {
        const tributeLines = gdTribute.map((entry, index) => {
          const fromPlayer = playerByNode(entry.from)
          const toPlayer = playerByNode(entry.to)
          const fromNick = fromPlayer !== undefined ? asString(fromPlayer.nick, '玩家') : '玩家'
          const toNick = toPlayer !== undefined ? asString(toPlayer.nick, '玩家') : '玩家'
          const skipped = entry.skipped === true
          const giftCard = asString(entry.card, '')
          // `returned` is the return card once the receiver picked one (the host
          // mirrors the tribute card into `gift`, so it must not be used here).
          const returnCard = asString(entry.returned, '')
          const returnDone = returnCard !== '' || entry.returned === true
          const isMyPending = !skipped && !returnDone && !isSpectator
            && myNode !== '' && asString(entry.to, '') === myNode
          const tags = []
          if (skipped) {
            tags.push(h('span', { key: 'skip', className: 'dsh-card-lan-tag is-tribute-skip' }, zh.gdTributeSkipped))
          } else {
            if (giftCard !== '') {
              tags.push(h('span', { key: 'gift', className: 'dsh-card-lan-tag is-tribute-gift' },
                fmt(zh.gdTributeGift, { card: readCard(giftCard).text })))
            }
            if (returnCard !== '') {
              tags.push(h('span', { key: 'returned', className: 'dsh-card-lan-tag is-tribute-return' },
                fmt(zh.gdTributeReturned, { card: readCard(returnCard).text })))
            } else if (returnDone) {
              tags.push(h('span', { key: 'done', className: 'dsh-card-lan-tag' }, zh.gdTributeDone))
            } else {
              tags.push(h('span', {
                key: 'pending',
                className: 'dsh-card-lan-tag is-tribute-pending' + (isMyPending ? ' is-turn' : ''),
              }, zh.gdTributePending))
            }
          }
          return h('div', {
            key: 'tribute:' + index,
            className: 'dsh-card-lan-gd-tributeline' + (isMyPending ? ' is-my-pending' : ''),
          }, [
            h('span', { key: 'names', className: 'dsh-card-lan-gd-tributenames' }, fromNick + ' → ' + toNick),
            ...tags,
          ])
        })
        bodyNodes.push(h('div', { key: 'tribute', className: 'dsh-card-lan-gd-tribute' }, [
          h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.gdTributeTitle),
          ...tributeLines,
        ]))
      }

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
        // Guandan seats carry a team badge (ours/theirs, partner = 对家).
        if (isGd) {
          const slotTeam = teamIndexOf(slot.team)
          const slotIndex = players.indexOf(slot)
          const isPartner = mySeatIndex >= 0 && players.length === 4
            && slotIndex === (mySeatIndex + 2) % 4
          let teamText = ''
          let teamClass = 'is-team-neutral'
          if (slotTeam !== null) {
            if (gdMyTeam !== null) {
              if (slotTeam === gdMyTeam) {
                teamText = isPartner ? zh.gdTeamPartner : zh.gdTeamOurs
                teamClass = 'is-team-ours'
              } else {
                teamText = zh.gdTeamTheirs
                teamClass = 'is-team-theirs'
              }
            } else {
              teamText = slotTeam === 0 ? zh.gdTeamOne : zh.gdTeamTwo
              teamClass = slotTeam === 0 ? 'is-team-ours' : 'is-team-theirs'
            }
          }
          if (teamText !== '') {
            tags.push(h('span', {
              key: 'team',
              className: 'dsh-card-lan-tag is-team ' + teamClass,
            }, teamText))
          }
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
        if (isDdz && phase === 'bidding' && bidding === true) {
          tags.push(h('span', { key: 'bid', className: 'dsh-card-lan-tag is-bid' }, zh.ddzBid))
        } else if (isDdz && phase === 'bidding' && bidding === false) {
          tags.push(h('span', { key: 'bid', className: 'dsh-card-lan-tag' }, zh.ddzPassBid))
        }
        // Guandan shows the finishing order (头游 → 末游) once the round is over.
        if (isGd && phase === 'result') {
          const orderList = gd !== null ? asArray(gd.orders) : []
          let orderIndex = orderList.indexOf(node)
          if (orderIndex === -1) {
            const numericOrder = asNumber(slot.order, -1)
            if (numericOrder >= 1 && numericOrder <= 4) orderIndex = numericOrder - 1
            else if (numericOrder >= 0 && numericOrder <= 3) orderIndex = numericOrder
          }
          if (orderIndex >= 0 && orderIndex < GD_ORDER_LABELS.length) {
            tags.push(h('span', { key: 'order', className: 'dsh-card-lan-tag is-order' },
              GD_ORDER_LABELS[orderIndex]))
          }
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
        const tributeSelectable = tributeReturnMode && !busy && !connectionBroken
        const handHead = [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, fmt(zh.ddzMyHand, { n: myCards.length })),
          selectedIndexes.length > 0
            ? h('span', { key: 'sel', className: 'dsh-card-lan-tag is-turn' },
              fmt(zh.ddzSelected, { n: selectedIndexes.length }))
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
            ? h('div', {
              key: 'cards',
              className: 'dsh-card-lan-ddz-hand' + (isGd ? ' is-guandan' : ''),
            }, myCards.map((card, index) => {
              const wild = isGd && gd !== null && isGuandanWild(card, gd.level)
              if (tributeReturnMode) {
                const allowed = isGd && gd !== null && isGuandanTributeCard(card, gd.level)
                return ddzCardNode(
                  card,
                  'hand:' + index + ':' + card,
                  selectedIndexes.indexOf(index) !== -1,
                  tributeSelectable && allowed ? () => props.toggleCard(index) : null,
                  wild ? zh.gdWild : '',
                  allowed ? '' : zh.gdTributeSelectHint,
                )
              }
              return ddzCardNode(
                card,
                'hand:' + index + ':' + card,
                selectedIndexes.indexOf(index) !== -1,
                canSelect ? () => props.toggleCard(index) : null,
                wild ? zh.gdWild : '',
              )
            }))
            : h('span', { key: 'empty', className: 'dsh-card-lan-empty' }, zh.ddzOut),
        ]))
      }

      /* ---------- result banner: side/upgrade for each game ---------- */
      if (phase === 'result') {
        const mine = me !== undefined ? asString(me.result, '') : ''
        const mineText = mine === 'win' ? zh.ddzIWin : (mine === 'lose' ? zh.ddzILose : '')
        const bannerClass = 'dsh-card-lan-banner '
          + (mine === 'win' ? 'is-win' : (mine === 'lose' ? 'is-lose' : 'is-none'))
        if (isGd) {
          // Guandan: team upgrade / passing A, plus the 头游→末游 order.
          const upgrade = gd !== null ? asNumber(gd.upgrade, -1) : -1
          const winnerTeam = gd !== null ? gd.winnerTeam : null
          let sideText = zh.gdRoundOver
          if (gd !== null && gd.victory === true) {
            sideText = zh.gdVictory
          } else if (upgrade >= 0 && winnerTeam !== null) {
            sideText = gdMyTeam !== null
              ? fmt(winnerTeam === gdMyTeam ? zh.gdUpgradeOurs : zh.gdUpgradeTheirs, { n: upgrade })
              : fmt(zh.gdUpgradeTeam, { n: upgrade, team: winnerTeam + 1 })
          }
          bodyNodes.push(h('div', { key: 'result', className: bannerClass, role: 'status' }, [
            h('span', { key: 'side' }, sideText),
          ]))
          const orderList = gd !== null ? asArray(gd.orders) : []
          if (orderList.length > 0) {
            const orderLines = orderList.map((orderNode, index) => {
              const orderPlayer = playerByNode(orderNode)
              const orderNick = orderPlayer !== undefined ? asString(orderPlayer.nick, '玩家') : '玩家'
              return h('div', { key: 'order' + index, className: 'dsh-card-lan-ddz-order-line' },
                GD_ORDER_LABELS[index] + '：' + orderNick)
            })
            bodyNodes.push(h('div', { key: 'orders', className: 'dsh-card-lan-ddz-orders' }, [
              h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.gdOrdersTitle),
              ...orderLines,
            ]))
          }
        } else if (isPdk) {
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
      if (tributeReturnMode) {
        const selectedTributeCard = selectedIndexes.length === 1 && myCards[selectedIndexes[0]] !== undefined
          ? myCards[selectedIndexes[0]]
          : ''
        actionNodes.push(h('button', {
          key: 'tributeReturn',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy || connectionBroken || selectedTributeCard === '',
          onClick: () => void props.submitTribute(selectedTributeCard),
        }, zh.gdTributeSubmit))
      }
      if (isDdz && phase === 'bidding' && activeTurn) {
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
          disabled: busy || connectionBroken || selectedIndexes.length === 0,
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

    /**
     * Zhajinhua table body (PROTOCOL §7.14/§7.15): 2–6 seats, 3 hole cards,
     * a betting round (pot/currentBet/raises) and a public showdown.
     * A pure renderer like buildCardGameContent: writes go through callbacks.
     */
    function buildZhajinhuaContent(props) {
      const role = props.role
      const isSpectator = props.isSpectator === true
      const phase = props.phase
      const players = props.players
      const me = props.me
      const myNode = asString(props.myNode, '')
      const turnNode = asString(props.turnNode, '')
      const turnNick = asString(props.turnNick, '')
      const myCards = asArray(props.myCards).filter((card) => typeof card === 'string')
      const pot = Math.max(0, asNumber(props.pot, 0))
      const currentBet = Math.max(0, asNumber(props.currentBet, 0))
      const raises = Math.max(0, asNumber(props.raises, 0))
      const maxRaises = Math.max(1, asNumber(props.maxRaises, ZJH_MAX_RAISES))
      const busy = props.busy === true
      const connectionBroken = props.connectionBroken === true
      const turnRemainingMs = asNumber(props.turnRemainingMs, -1)
      const winnerNode = asString(props.winnerNode, '')
      const meSeen = me !== undefined && me.seen === true
      const meStatus = me !== undefined ? asString(me.status, 'active') : 'active'
      const activeTurn = !isSpectator && myNode !== '' && turnNode === myNode
      const myChips = me !== undefined ? Math.max(0, asNumber(me.chips, 0)) : 0
      const myBet = me !== undefined ? Math.max(0, asNumber(me.bet, 0)) : 0
      // `call` costs the current bet when seen; blind players pay half (rounded up).
      const callAmount = meSeen ? currentBet : Math.ceil(currentBet / 2)
      const aliveCount = players.filter((slot) => {
        const status = asString(slot.status, 'active')
        return status !== 'folded' && status !== 'out'
      }).length
      const canCompare = !isSpectator && activeTurn && meStatus !== 'folded'
        && meStatus !== 'out' && aliveCount === 2

      /* ---------- header extras: game pill, pot, current bet, raises ---------- */
      const headExtras = [
        h('span', { key: 'game', className: 'dsh-card-lan-pill is-game-zhajinhua' }, GAME_LABELS.zhajinhua),
        h('span', { key: 'pot', className: 'dsh-card-lan-tag is-pot' }, fmt(zh.zjhPot, { n: pot })),
        h('span', { key: 'bet', className: 'dsh-card-lan-tag' }, fmt(zh.zjhCurrentBet, { n: currentBet })),
        h('span', { key: 'raises', className: 'dsh-card-lan-tag is-raises' },
          fmt(zh.zjhRaises, { n: raises, max: maxRaises })),
      ]
      if (phase === 'bidding' && turnRemainingMs >= 0) {
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
        if (activeTurn) hint = meSeen ? zh.zjhHintSeen : zh.zjhHintBlind
        else hint = turnNick !== '' ? fmt(zh.zjhWait, { name: turnNick }) : zh.ddzWaitHostState
      } else if (phase === 'result') {
        hint = role === 'host' ? zh.ddzResultHost : zh.ddzWaitNext
      }

      const bodyNodes = []

      /* ---------- other seats: chips / round bet / status / turn ---------- */
      const others = players.filter((slot) => slot !== me)
      for (const slot of others) {
        const node = asString(slot.node, '')
        const nick = asString(slot.nick, '玩家')
        const chips = Math.max(0, asNumber(slot.chips, 0))
        const bet = Math.max(0, asNumber(slot.bet, 0))
        const status = asString(slot.status, 'active')
        const folded = status === 'folded' || status === 'out'
        const seen = slot.seen === true
        const won = phase === 'result' && winnerNode !== '' && node === winnerNode
        const isTurn = phase === 'bidding' && node !== '' && node === turnNode
        const classes = ['dsh-card-lan-row', 'dsh-card-lan-zjh-seat']
        if (isTurn) classes.push('is-turn')
        if (folded) classes.push('is-out')
        if (won) classes.push('is-winner')
        const tags = [
          h('span', { key: 'chips', className: 'dsh-card-lan-tag' }, fmt(zh.zjhChips, { n: chips })),
          h('span', { key: 'bet', className: 'dsh-card-lan-tag' }, fmt(zh.zjhBet, { n: bet })),
        ]
        if (won) {
          tags.push(h('span', { key: 'win', className: 'dsh-card-lan-tag is-result-win' }, zh.zjhWinTag))
        } else if (folded) {
          tags.push(h('span', { key: 'folded', className: 'dsh-card-lan-tag' }, zh.zjhFolded))
        } else if (phase === 'bidding') {
          tags.push(h('span', {
            key: 'seen',
            className: 'dsh-card-lan-tag' + (seen ? ' is-seen' : ''),
          }, seen ? zh.zjhSeen : zh.zjhBlind))
        }
        if (isTurn) tags.push(h('span', { key: 'turn', className: 'dsh-card-lan-tag is-turn' }, zh.acting))
        bodyNodes.push(h('div', { key: 'seat:' + node + ':' + nick, className: classes.join(' ') }, [
          h('span', { key: 'nick', className: 'dsh-card-lan-name' }, nick),
          ...tags,
        ]))
      }

      /* ---------- my area: 3 cards (backs until seen; faces at result) ---------- */
      // Spectators never see hole cards (not even backs) during the hand;
      // the showdown block below reveals everyone once the round is over.
      if (!isSpectator) {
        const showFaces = phase === 'result' || meSeen
        const myCardNodes = []
        for (let index = 0; index < 3; index += 1) {
          const card = myCards[index]
          if (showFaces && typeof card === 'string' && card !== '') {
            myCardNodes.push(h(CardChip, { key: 'my:' + index, card }))
          } else {
            myCardNodes.push(h(CardChip, { key: 'my:' + index, hidden: true }))
          }
        }
        bodyNodes.push(h('div', { key: 'mySeat', className: 'dsh-card-lan-zjh-me' }, [
          h('div', { key: 'head', className: 'dsh-card-lan-row-head' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.zjhMyArea),
            h('span', { key: 'chips', className: 'dsh-card-lan-tag' }, fmt(zh.zjhChips, { n: myChips })),
            h('span', { key: 'bet', className: 'dsh-card-lan-tag' }, fmt(zh.zjhBet, { n: myBet })),
            meSeen ? h('span', { key: 'seen', className: 'dsh-card-lan-tag is-seen' }, zh.zjhSeen) : null,
            phase !== 'result' && meSeen && isZjh235(myCards)
              ? h('span', { key: 'special', className: 'dsh-card-lan-tag is-zjh-235' }, zh.zjhLabel235)
              : null,
            activeTurn ? h('span', { key: 'turn', className: 'dsh-card-lan-tag is-turn' }, zh.acting) : null,
          ]),
          h('div', { key: 'cards', className: 'dsh-card-lan-hand dsh-card-lan-zjh-hand' }, myCardNodes),
        ]))
      }

      /* ---------- result: banner + everyone's revealed hands ---------- */
      if (phase === 'result') {
        const winner = players.find((slot) => asString(slot.node, '') === winnerNode)
        const winnerNick = winner !== undefined ? asString(winner.nick, '玩家') : ''
        let bannerText = zh.zjhRoundOver
        let bannerClass = 'dsh-card-lan-banner is-none'
        if (isSpectator) {
          if (winnerNick !== '') bannerText = fmt(zh.zjhWinner, { name: winnerNick })
        } else if (myNode !== '' && winnerNode !== '' && myNode === winnerNode) {
          bannerText = fmt(zh.zjhWin, { pot })
          bannerClass = 'dsh-card-lan-banner is-win'
        } else if (winnerNode !== '') {
          bannerText = zh.zjhLose
          bannerClass = 'dsh-card-lan-banner is-lose'
        }
        bodyNodes.push(h('div', { key: 'result', className: bannerClass, role: 'status' }, bannerText))

        const handLines = []
        for (let index = 0; index < players.length; index += 1) {
          const slot = players[index]
          const node = asString(slot.node, '')
          const nick = asString(slot.nick, '玩家')
          let cards = asArray(slot.cards).filter((card) => typeof card === 'string' && card !== '')
          if (cards.length === 0 && slot === me) cards = myCards
          const won = node !== '' && node === winnerNode
          const status = asString(slot.status, 'active')
          const folded = status === 'folded' || status === 'out'
          const lineClass = 'dsh-card-lan-zjh-handline'
            + (won ? ' is-winner' : '')
            + (folded ? ' is-out' : '')
          const engineLabel = asString(slot.label, asString(slot.handLabel, ''))
          const special235 = isZjh235(cards) || engineLabel.indexOf('235') !== -1
          const handTag = special235
            ? h('span', { key: 'special', className: 'dsh-card-lan-tag is-zjh-235' }, zh.zjhLabel235)
            : (engineLabel !== ''
              ? h('span', { key: 'label', className: 'dsh-card-lan-tag is-hand-label' }, engineLabel)
              : null)
          const cardNodes = cards.length > 0
            ? cards.map((card, cardIndex) => h(CardChip, { key: 'c' + cardIndex, card }))
            : [h('span', { key: 'empty', className: 'dsh-card-lan-empty' }, zh.zjhUnseen)]
          handLines.push(h('div', { key: 'hand:' + index + ':' + node, className: lineClass }, [
            h('span', { key: 'nick', className: 'dsh-card-lan-zjh-handnick' }, nick),
            h('span', { key: 'cards', className: 'dsh-card-lan-hand' }, cardNodes),
            handTag,
            won ? h('span', { key: 'win', className: 'dsh-card-lan-tag is-result-win' }, zh.zjhWinTag) : null,
          ]))
        }
        bodyNodes.push(h('div', { key: 'hands', className: 'dsh-card-lan-zjh-hands' }, [
          h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.zjhHandsTitle),
          ...handLines,
        ]))
      }

      /* ---------- actions: look / call / raise / fold / compare / start ---------- */
      const actionNodes = []
      if (phase === 'bidding' && activeTurn && !isSpectator) {
        if (!meSeen) {
          actionNodes.push(h('button', {
            key: 'look',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-primary',
            disabled: busy || connectionBroken,
            onClick: () => void props.lookCards(),
          }, zh.zjhLook))
          actionNodes.push(h('button', {
            key: 'call',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy || connectionBroken,
            onClick: () => void props.callBet(),
          }, fmt(zh.zjhCallBlind, { n: callAmount })))
        } else {
          actionNodes.push(h('button', {
            key: 'call',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-primary',
            disabled: busy || connectionBroken,
            onClick: () => void props.callBet(),
          }, fmt(zh.zjhCall, { n: callAmount })))
          actionNodes.push(h('button', {
            key: 'raise',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy || connectionBroken,
            onClick: () => void props.raiseBet(),
          }, zh.zjhRaise))
        }
        actionNodes.push(h('button', {
          key: 'fold',
          type: 'button',
          className: 'dsh-card-lan-button',
          disabled: busy || connectionBroken,
          onClick: () => void props.foldHand(),
        }, zh.zjhFold))
        if (canCompare) {
          actionNodes.push(h('button', {
            key: 'compare',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy || connectionBroken,
            onClick: () => void props.compareHand(),
          }, zh.zjhCompare))
        }
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

    /**
     * Texas Hold'em table body (PROTOCOL §7.16/§7.17): 2–6 seats, 2 hole cards,
     * 5 community cards and fixed-size betting (blinds 10/20, raise +20).
     * Pure renderer like the other table bodies; writes go through callbacks.
     */
    function buildTexasContent(props) {
      const role = props.role
      const isSpectator = props.isSpectator === true
      const phase = props.phase
      const players = props.players
      const me = props.me
      const myNode = asString(props.myNode, '')
      const turnNode = asString(props.turnNode, '')
      const turnNick = asString(props.turnNick, '')
      const myCards = asArray(props.myCards).filter((card) => typeof card === 'string' && card !== '')
      const community = asArray(props.community).filter((card) => typeof card === 'string' && card !== '')
      const pot = Math.max(0, asNumber(props.pot, 0))
      const currentBet = Math.max(0, asNumber(props.currentBet, 0))
      const dealerNode = asString(props.dealerNode, '')
      const busy = props.busy === true
      const connectionBroken = props.connectionBroken === true
      const turnRemainingMs = asNumber(props.turnRemainingMs, -1)
      const winnerNodes = asArray(props.winnerNodes).map((node) => asString(node, '')).filter((node) => node !== '')
      const pots = asArray(props.pots).filter((entry) => asObject(entry) !== null)
      const activeTurn = !isSpectator && myNode !== '' && turnNode === myNode
      const meStatus = me !== undefined ? asString(me.status, 'active') : 'active'
      const meChips = me !== undefined ? Math.max(0, asNumber(me.chips, 0)) : 0
      const meStreetBet = me !== undefined ? Math.max(0, asNumber(me.bet, 0)) : 0
      const myCommitted = me !== undefined ? Math.max(0, asNumber(me.committed, 0)) : 0
      const myTurn = activeTurn && me !== undefined && meStatus !== 'folded' && meStatus !== 'allin'
        && phase !== 'idle' && phase !== 'result'
      const callGap = Math.max(0, currentBet - meStreetBet)
      const canCheck = callGap === 0
      const raiseTo = currentBet + TX_RAISE_STEP
      const raiseGap = Math.max(0, raiseTo - meStreetBet)
      // Seat order (the players array is wire order) decides the D/SB/BB marks.
      const dealerIndex = dealerNode === '' ? -1 : players.findIndex((slot) => asString(slot.node, '') === dealerNode)
      const seatCount = players.length
      let sbNode = ''
      let bbNode = ''
      if (dealerIndex >= 0 && seatCount >= 2) {
        const sbIndex = seatCount === 2 ? dealerIndex : (dealerIndex + 1) % seatCount
        const bbIndex = seatCount === 2 ? (dealerIndex + 1) % seatCount : (dealerIndex + 2) % seatCount
        sbNode = asString(players[sbIndex] !== undefined ? players[sbIndex].node : '', '')
        bbNode = asString(players[bbIndex] !== undefined ? players[bbIndex].node : '', '')
      }

      /* ---------- header extras: game pill, pot, current bet, blinds ---------- */
      const headExtras = [
        h('span', { key: 'game', className: 'dsh-card-lan-pill is-game-texas' }, GAME_LABELS.texas),
        h('span', { key: 'pot', className: 'dsh-card-lan-tag is-pot' }, fmt(zh.txPot, { n: pot })),
        h('span', { key: 'bet', className: 'dsh-card-lan-tag' }, fmt(zh.txCurrentBet, { n: currentBet })),
        h('span', { key: 'blinds', className: 'dsh-card-lan-tag' },
          fmt(zh.txBlinds, { sb: TX_SMALL_BLIND, bb: TX_BIG_BLIND })),
      ]
      if (phase !== 'idle' && phase !== 'result' && turnRemainingMs >= 0) {
        headExtras.push(h('span', { key: 'countdown', className: 'dsh-card-lan-tag is-turn' },
          fmt(zh.ddzCountdown, { n: Math.max(0, Math.ceil(turnRemainingMs / 1000)) })))
      }

      /* ---------- hint line ---------- */
      let hint = ''
      if (isSpectator) {
        hint = zh.spectatorHint
      } else if (phase === 'idle') {
        hint = role === 'host' ? zh.ddzIdleHost : zh.ddzWaitStart
      } else if (phase === 'result') {
        hint = role === 'host' ? zh.ddzResultHost : zh.ddzWaitNext
      } else if (myTurn) {
        hint = zh.txYourTurn
      } else {
        hint = turnNick !== '' ? fmt(zh.txWait, { name: turnNick }) : zh.ddzWaitHostState
      }

      const bodyNodes = []

      /* ---------- other seats: chips / street bet / D-SB-BB / status ---------- */
      const others = players.filter((slot) => slot !== me)
      for (const slot of others) {
        const node = asString(slot.node, '')
        const nick = asString(slot.nick, '玩家')
        const chips = Math.max(0, asNumber(slot.chips, 0))
        const bet = Math.max(0, asNumber(slot.bet, 0))
        const status = asString(slot.status, 'active')
        const isTurn = phase !== 'idle' && phase !== 'result' && node !== '' && node === turnNode
        const won = phase === 'result' && winnerNodes.indexOf(node) !== -1
        const classes = ['dsh-card-lan-row', 'dsh-card-lan-tx-seat']
        if (isTurn) classes.push('is-turn')
        if (status === 'folded') classes.push('is-out')
        if (won) classes.push('is-winner')
        const tags = [
          h('span', { key: 'chips', className: 'dsh-card-lan-tag' }, fmt(zh.txChips, { n: chips })),
          h('span', { key: 'bet', className: 'dsh-card-lan-tag' }, fmt(zh.txStreetBet, { n: bet })),
        ]
        if (node !== '' && node === dealerNode) {
          tags.push(h('span', { key: 'dealer', className: 'dsh-card-lan-tag is-tx-d', title: 'dealer' }, zh.txDealerMark))
        }
        if (node !== '' && node === sbNode) {
          tags.push(h('span', { key: 'sb', className: 'dsh-card-lan-tag is-tx-sb' }, zh.txSbMark))
        }
        if (node !== '' && node === bbNode) {
          tags.push(h('span', { key: 'bb', className: 'dsh-card-lan-tag is-tx-bb' }, zh.txBbMark))
        }
        if (status === 'folded') {
          tags.push(h('span', { key: 'status', className: 'dsh-card-lan-tag' }, zh.txStatusFolded))
        } else if (status === 'allin') {
          tags.push(h('span', { key: 'status', className: 'dsh-card-lan-tag is-tx-allin' }, zh.txStatusAllin))
        } else {
          tags.push(h('span', { key: 'status', className: 'dsh-card-lan-tag' + (isTurn ? ' is-turn' : '') },
            zh.txStatusActive))
        }
        if (won) {
          tags.push(h('span', { key: 'win', className: 'dsh-card-lan-tag is-result-win' }, zh.txWinTag))
        }
        bodyNodes.push(h('div', { key: 'seat:' + node + ':' + nick, className: classes.join(' ') }, [
          h('span', { key: 'nick', className: 'dsh-card-lan-name' }, nick),
          ...tags,
        ]))
      }

      /* ---------- community: exactly 5 slots, empty until dealt ---------- */
      const communityNodes = []
      for (let index = 0; index < 5; index += 1) {
        const card = community[index]
        if (typeof card === 'string' && card !== '') {
          communityNodes.push(h(CardChip, { key: 'cc:' + index, card }))
        } else {
          communityNodes.push(h('span', { key: 'cc:' + index, className: 'dsh-card-lan-tx-slot' }, zh.txEmptySlot))
        }
      }
      bodyNodes.push(h('div', { key: 'community', className: 'dsh-card-lan-tx-community' }, [
        h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.txCommunity),
        h('div', { key: 'cards', className: 'dsh-card-lan-hand dsh-card-lan-tx-board' }, communityNodes),
      ]))

      /* ---------- my area: 2 hole cards (always visible to me) ---------- */
      if (!isSpectator) {
        const holeNodes = []
        for (let index = 0; index < 2; index += 1) {
          const card = myCards[index]
          if (typeof card === 'string' && card !== '') {
            holeNodes.push(h(CardChip, { key: 'hole:' + index, card }))
          } else {
            holeNodes.push(h(CardChip, { key: 'hole:' + index, hidden: true }))
          }
        }
        bodyNodes.push(h('div', { key: 'mySeat', className: 'dsh-card-lan-tx-me' }, [
          h('div', { key: 'head', className: 'dsh-card-lan-row-head' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.txMyCards),
            h('span', { key: 'chips', className: 'dsh-card-lan-tag' }, fmt(zh.txChips, { n: meChips })),
            h('span', { key: 'bet', className: 'dsh-card-lan-tag' }, fmt(zh.txStreetBet, { n: meStreetBet })),
            h('span', { key: 'committed', className: 'dsh-card-lan-tag' }, fmt(zh.txCommitted, { n: myCommitted })),
            myTurn ? h('span', { key: 'turn', className: 'dsh-card-lan-tag is-turn' }, zh.txYourTurn) : null,
          ]),
          h('div', { key: 'cards', className: 'dsh-card-lan-hand dsh-card-lan-tx-hole' }, holeNodes),
        ]))
      }

      /* ---------- result: banner + pots + winner hole cards ---------- */
      if (phase === 'result') {
        const winners = players.filter((slot) => winnerNodes.indexOf(asString(slot.node, '')) !== -1)
        const winnerNicks = winners.map((slot) => asString(slot.nick, '玩家'))
        let myWin = 0
        for (const entry of pots) {
          const amount = Math.max(0, asNumber(entry.amount, asNumber(entry.value, 0)))
          const entryWinners = asArray(entry.winners).map((value) => asString(value, ''))
          const singleWinner = asString(entry.winnerNode, '')
          if (myNode !== '' && (entryWinners.indexOf(myNode) !== -1 || singleWinner === myNode)) {
            myWin += amount
          }
        }
        if (myWin === 0 && winnerNodes.indexOf(myNode) !== -1) myWin = pot
        let bannerText = zh.txRoundOver
        let bannerClass = 'dsh-card-lan-banner is-none'
        if (isSpectator) {
          bannerText = winnerNicks.length > 0 ? fmt(zh.txWinner, { name: winnerNicks.join('、') }) : zh.txRoundOver
        } else if (myNode !== '' && winnerNodes.indexOf(myNode) !== -1) {
          bannerText = fmt(zh.txWin, { n: myWin })
          bannerClass = 'dsh-card-lan-banner is-win'
        } else if (winnerNodes.length > 0) {
          bannerText = zh.txLose
          bannerClass = 'dsh-card-lan-banner is-lose'
        }
        bodyNodes.push(h('div', { key: 'result', className: bannerClass, role: 'status' }, bannerText))

        if (pots.length > 0) {
          const potLines = pots.map((entry, index) => {
            const amount = Math.max(0, asNumber(entry.amount, asNumber(entry.value, 0)))
            const entryWinners = asArray(entry.winners).map((value) => asString(value, ''))
            const names = entryWinners.map((winnerNode) => {
              const player = players.find((slot) => asString(slot.node, '') === winnerNode)
              return player !== undefined ? asString(player.nick, '玩家') : '玩家'
            })
            return h('div', { key: 'pot:' + index, className: 'dsh-card-lan-tx-potline' },
              fmt(zh.txPotLine, { amount, names: names.length > 0 ? names.join('、') : '—' }))
          })
          bodyNodes.push(h('div', { key: 'pots', className: 'dsh-card-lan-tx-pots' }, [
            h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.txPotsTitle),
            ...potLines,
          ]))
        }

        if (winners.length > 0) {
          const winnerLines = winners.map((slot, index) => {
            const cards = asArray(slot.cards).filter((card) => typeof card === 'string' && card !== '')
            const cardNodes = cards.length > 0
              ? cards.map((card, cardIndex) => h(CardChip, { key: 'wc:' + cardIndex, card }))
              : [h('span', { key: 'empty', className: 'dsh-card-lan-empty' }, zh.zjhUnseen)]
            return h('div', { key: 'winner:' + index, className: 'dsh-card-lan-tx-winner' }, [
              h('span', { key: 'nick', className: 'dsh-card-lan-name' }, asString(slot.nick, '玩家')),
              h('span', { key: 'cards', className: 'dsh-card-lan-hand' }, cardNodes),
            ])
          })
          bodyNodes.push(h('div', { key: 'winners', className: 'dsh-card-lan-tx-winners' }, [
            h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.txWinnersTitle),
            ...winnerLines,
          ]))
        }
      }

      /* ---------- actions: fold / check-or-call / raise ---------- */
      const actionNodes = []
      if (myTurn) {
        actionNodes.push(h('button', {
          key: 'fold',
          type: 'button',
          className: 'dsh-card-lan-button',
          disabled: busy || connectionBroken,
          onClick: () => void props.foldHand(),
        }, zh.txFold))
        if (meChips > 0) {
          if (canCheck) {
            actionNodes.push(h('button', {
              key: 'check',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-primary',
              disabled: busy || connectionBroken,
              onClick: () => void props.checkBet(),
            }, zh.txCheck))
          } else if (callGap >= meChips) {
            actionNodes.push(h('button', {
              key: 'allin',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-primary',
              disabled: busy || connectionBroken,
              onClick: () => void props.callBet(),
            }, fmt(zh.txAllin, { n: meChips })))
          } else {
            actionNodes.push(h('button', {
              key: 'call',
              type: 'button',
              className: 'dsh-card-lan-button dsh-card-lan-button-primary',
              disabled: busy || connectionBroken,
              onClick: () => void props.callBet(),
            }, fmt(zh.txCall, { n: callGap })))
          }
          actionNodes.push(h('button', {
            key: 'raiseToggle',
            type: 'button',
            className: 'dsh-card-lan-button' + (props.raiseOpen === true ? ' is-active' : ''),
            disabled: busy || connectionBroken,
            'aria-expanded': props.raiseOpen === true,
            onClick: () => props.toggleRaise(),
          }, zh.txRaise))
          if (props.raiseOpen === true) {
            const raiseMin = Math.max(0, asNumber(props.raiseMin, raiseTo))
            const allInTarget = Math.max(0, asNumber(props.raiseMax, meStreetBet + meChips))
            const raiseMax = Math.max(raiseMin, allInTarget)
            const targetValue = Math.min(raiseMax, Math.max(raiseMin, asNumber(props.raiseTarget, raiseMin)))
            const targetIsAllIn = targetValue >= raiseMax
            actionNodes.push(h('div', { key: 'raisePanel', className: 'dsh-card-lan-tx-raise' }, [
              h('div', { key: 'label', className: 'dsh-card-lan-label' },
                fmt(zh.txRaiseTarget, { n: targetValue })),
              h('input', {
                key: 'range',
                className: 'dsh-card-lan-tx-range',
                type: 'range',
                min: raiseMin,
                max: raiseMax,
                step: 10,
                value: String(targetValue),
                'aria-label': zh.txRaiseAmount,
                disabled: busy || connectionBroken,
                onChange: (event) => props.setRaiseTarget(Number(event.target.value)),
              }),
              h('div', { key: 'row', className: 'dsh-card-lan-actions' }, [
                h('input', {
                  key: 'number',
                  className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
                  type: 'number',
                  min: raiseMin,
                  max: raiseMax,
                  step: 10,
                  value: String(targetValue),
                  'aria-label': zh.txRaiseAmountNum,
                  disabled: busy || connectionBroken,
                  onChange: (event) => props.setRaiseTarget(Number(event.target.value)),
                }),
                h('button', {
                  key: 'minRaise',
                  type: 'button',
                  className: 'dsh-card-lan-button dsh-card-lan-button-small',
                  disabled: busy || connectionBroken,
                  onClick: () => props.setRaiseTarget(raiseMin),
                }, zh.txMinRaise),
                h('button', {
                  key: 'allInRaise',
                  type: 'button',
                  className: 'dsh-card-lan-button dsh-card-lan-button-small',
                  disabled: busy || connectionBroken,
                  onClick: () => props.setRaiseTarget(raiseMax),
                }, zh.txAllInBtn),
                h('button', {
                  key: 'confirmRaise',
                  type: 'button',
                  className: 'dsh-card-lan-button dsh-card-lan-button-primary dsh-card-lan-button-small',
                  disabled: busy || connectionBroken,
                  onClick: () => props.submitRaise(targetValue),
                }, targetIsAllIn ? fmt(zh.txAllin, { n: targetValue }) : fmt(zh.txRaiseTo, { n: targetValue })),
                h('button', {
                  key: 'cancelRaise',
                  type: 'button',
                  className: 'dsh-card-lan-button dsh-card-lan-button-small',
                  disabled: busy || connectionBroken,
                  onClick: () => props.toggleRaise(),
                }, zh.txCancelRaise),
              ]),
            ]))
          }
        }
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

    /** One Mahjong text tile; `small` is the river size, `onClick` selects. */
    function mahjongTileNode(tile, key, selected, onClick, small) {
      const face = readMahjongTile(tile)
      const classes = ['dsh-card-lan-mj-tile']
      if (small === true) classes.push('is-small')
      if (face.tone !== '') classes.push('is-' + face.tone)
      if (selected === true) classes.push('is-selected')
      const props = {
        key,
        className: classes.join(' '),
        title: face.text,
        'aria-label': face.text,
      }
      if (onClick !== null && onClick !== undefined) {
        props.role = 'button'
        props.tabIndex = 0
        props['aria-pressed'] = selected === true
        props.onClick = () => onClick()
        props.onKeyDown = (event) => {
          if (event === null || event === undefined) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        }
      }
      return h('span', props, face.text)
    }

    /**
     * Japanese Mahjong table body (PROTOCOL §7.18/§7.19, milestone ①): round /
     * dealer / dora indicator / wall, other players' rivers, my 13-14 text
     * tiles and discard / nuki / tsumo actions. Pure renderer.
     */
    function buildMahjongContent(props) {
      const game = isMahjongId(props.game) ? props.game : 'mahjong4'
      const isThree = isMahjongThree(game)
      const role = props.role
      const isSpectator = props.isSpectator === true
      const phase = props.phase
      const players = props.players
      const me = props.me
      const myNode = asString(props.myNode, '')
      const turnNode = asString(props.turnNode, '')
      const turnNick = asString(props.turnNick, '')
      const myHand = asArray(props.myHand).filter((tile) => typeof tile === 'string' && tile !== '')
      const round = Math.max(0, asNumber(props.round, 0))
      const dealerNode = asString(props.dealerNode, '')
      const wall = Math.max(0, asNumber(props.wall, 0))
      const nuki = Math.max(0, asNumber(props.nuki, 0))
      const doraIndicator = asString(props.doraIndicator, '')
      // Milestone ②: full dora indicator list, call window, melds, furiten.
      const doras = asArray(props.doras).filter((tile) => typeof tile === 'string' && tile !== '')
      const pendingEntry = asObject(props.pendingEntry)
      const lastDiscard = asObject(props.lastDiscard)
      const lastDiscardTile = lastDiscard !== null ? asString(lastDiscard.tile, '') : ''
      const lastDiscardFrom = lastDiscard !== null ? asString(lastDiscard.node, '') : ''
      const myFuriten = props.myFuriten === true
      const mustDiscard = props.mustDiscard === true
      const chiOptions = asArray(props.chiOptions)
        .map((option) => asArray(option).filter((tile) => typeof tile === 'string' && tile !== ''))
        .filter((tiles) => tiles.length === 2)
      const meldsFor = typeof props.meldsFor === 'function' ? props.meldsFor : () => []
      const callAllowed = (name) => pendingEntry !== null
        && asArray(pendingEntry.allowed).map((value) => asString(value, '')).indexOf(name) !== -1
      const callable = pendingEntry !== null
        && (callAllowed('ron') || callAllowed('pon') || callAllowed('kan') || callAllowed('chi'))
      const lastDiscardNick = (() => {
        if (lastDiscardFrom === '') return '玩家'
        for (const slot of players) {
          if (asString(slot.node, '') === lastDiscardFrom) return asString(slot.nick, '玩家')
        }
        return '玩家'
      })()
      const result = asString(props.result, '')
      const winnerNode = asString(props.winnerNode, '')
      // Milestone ③: points / riichi / yaku settlement.
      const pointsMap = asObject(props.points)
      const riichiMapIn = asObject(props.riichiMap)
      const riichiSticks = Math.max(0, asNumber(props.riichiSticks, 0))
      const autoDiscard = props.autoDiscard === true
      const yakuList = asArray(props.yaku)
      const totalHan = asNumber(props.han, -1)
      const totalFu = asNumber(props.fu, -1)
      const totalScore = asNumber(props.score, -1)
      const deltasMap = asObject(props.deltas)
      const uraDoras = asArray(props.uraDoras).filter((tile) => typeof tile === 'string' && tile !== '')
      // Optional dora-han breakdowns (the host may expose them; otherwise the
      // indicator tiles + aka count are still shown).
      const doraHan = asNumber(props.doraHan, -1)
      const akaHan = asNumber(props.akaHan, -1)
      const uraHan = asNumber(props.uraHan, -1)
      const sticksAwarded = Math.max(0, asNumber(props.sticksAwarded, riichiSticks))
      // Milestone ④: seat winds / tenpai / match end.
      const seatWindMap = asObject(props.seatWindMap)
      const tenpaiMap = asObject(props.tenpaiMap)
      const matchOver = props.matchOver === true
      const finalPoints = asArray(props.finalPoints)
      const roundLabel = asString(props.roundLabel, '')
      const dealerRepeat = props.dealerRepeat === true
      const seatWindOf = (node, slot) => {
        if (seatWindMap !== null && typeof seatWindMap[node] === 'string' && seatWindMap[node] !== '') {
          return seatWindMap[node]
        }
        if (slot !== undefined && typeof slot.seatWind === 'string' && slot.seatWind !== '') return slot.seatWind
        return ''
      }
      const tenpaiOf = (node, slot) => {
        if (tenpaiMap !== null && typeof tenpaiMap[node] === 'boolean') return tenpaiMap[node]
        if (slot !== undefined && typeof slot.tenpai === 'boolean') return slot.tenpai
        return null
      }
      const windTextOf = (wind) => (wind === '' ? '' : readMahjongTile(wind).text)
      const dealerNick = (() => {
        for (const slot of players) {
          if (asString(slot.node, '') === dealerNode) return asString(slot.nick, '玩家')
        }
        return '玩家'
      })()
      const rankingEntries = (() => {
        if (!matchOver) return []
        const rows = []
        if (Array.isArray(finalPoints)) {
          for (let index = 0; index < finalPoints.length; index += 1) {
            const entry = finalPoints[index]
            if (typeof entry === 'string') {
              rows.push({ node: entry, rank: index + 1, nick: undefined, points: null })
              continue
            }
            const record = asObject(entry)
            if (record === null) continue
            const rank = Number.isInteger(record.rank)
              ? record.rank
              : (Number.isInteger(record.place) ? record.place : index + 1)
            const points = Number.isFinite(record.points)
              ? Math.round(record.points)
              : (Number.isFinite(record.score) ? Math.round(record.score) : null)
            rows.push({
              node: asString(record.node, ''),
              rank,
              nick: asString(record.nick, asString(record.name, '')),
              points,
            })
          }
        } else {
          const map = asObject(finalPoints)
          if (map !== null) {
            const entries = Object.keys(map)
              .filter((node) => Number.isFinite(map[node]))
              .map((node) => ({ node, points: Math.round(map[node]) }))
            entries.sort((a, b) => b.points - a.points)
            for (let index = 0; index < entries.length; index += 1) {
              rows.push({ node: entries[index].node, rank: index + 1, nick: undefined, points: entries[index].points })
            }
          }
        }
        return rows.map((row) => {
          const slot = players.find((candidate) => asString(candidate.node, '') === row.node)
          const nick = row.nick !== undefined && row.nick !== ''
            ? row.nick
            : (slot !== undefined ? asString(slot.nick, '玩家') : '玩家')
          const points = row.points !== null && row.points !== undefined
            ? row.points
            : (row.node !== '' ? pointOf(row.node) : 0)
          return { rank: row.rank, nick, points }
        })
      })()
      const riichiOf = (node) => {
        if (riichiMapIn !== null && riichiMapIn[node] === true) return true
        for (const slot of players) {
          if (asString(slot.node, '') === node && slot.riichi === true) return true
        }
        return false
      }
      const pointOf = (node) => {
        if (pointsMap !== null && Number.isFinite(pointsMap[node])) return Math.round(pointsMap[node])
        return 25000
      }
      const myPoints = myNode !== '' ? pointOf(myNode) : 25000
      const myRiichi = myNode !== '' && riichiOf(myNode)
      const discardsFor = typeof props.discardsFor === 'function' ? props.discardsFor : () => []
      const busy = props.busy === true
      const connectionBroken = props.connectionBroken === true
      const turnRemainingMs = asNumber(props.turnRemainingMs, -1)
      const selectedIndexes = asArray(props.selectedIndexes)
      const myTurn = !isSpectator && phase === 'playing' && myNode !== '' && turnNode === myNode
      const hasNorth = myHand.indexOf('N') !== -1
      const canSelect = myTurn && !busy && !connectionBroken
      const selectedTile = selectedIndexes.length === 1 && myHand[selectedIndexes[0]] !== undefined
        ? myHand[selectedIndexes[0]]
        : ''
      // Own-turn kan candidates (M2): four-of-a-kind in hand, or a pon + 4th.
      const tileCounts = {}
      for (const tile of myHand) tileCounts[tile] = (tileCounts[tile] || 0) + 1
      const ankanOptions = Object.keys(tileCounts).filter((tile) => tileCounts[tile] >= 4)
      const myMelds = me !== undefined ? asArray(meldsFor(me)) : []
      const closedHand = myMelds.length === 0
      const canRiichi = myTurn && !myRiichi && closedHand && !mustDiscard
        && myHand.length === 14 && myPoints >= 1000 && wall >= 4
        && !busy && !connectionBroken
      const kakanOptions = []
      for (const meld of myMelds) {
        const entry = asObject(meld)
        if (entry === null || asString(entry.type, '') !== 'pon') continue
        const tiles = asArray(entry.tiles).filter((tile) => typeof tile === 'string' && tile !== '')
        if (tiles.length < 3) continue
        const tile = tiles[0]
        if (tile !== undefined && myHand.indexOf(tile) !== -1 && kakanOptions.indexOf(tile) === -1) {
          kakanOptions.push(tile)
        }
      }

      /** One meld as small tiles plus a type mark (ankan shows backs). */
      const meldNode = (meld, keyPrefix, index) => {
        const entry = asObject(meld)
        if (entry === null) return null
        const type = asString(entry.type, '')
        const tiles = asArray(entry.tiles).filter((tile) => typeof tile === 'string' && tile !== '')
        if (tiles.length === 0) return null
        const labels = {
          chi: zh.mjMeldChi,
          pon: zh.mjMeldPon,
          kan: zh.mjMeldKan,
          ankan: zh.mjMeldAnkan,
          kakan: zh.mjMeldKakan,
        }
        const label = labels[type] !== undefined ? labels[type] : type
        const tileNodes = type === 'ankan'
          ? [0, 1, 2, 3].map((backIndex) => h('span', {
            key: 'b:' + backIndex,
            className: 'dsh-card-lan-mj-tile is-small is-back',
            title: zh.mjMeldAnkan,
            'aria-label': zh.mjMeldAnkan,
          }))
          : tiles.map((tile, tileIndex) => mahjongTileNode(tile, 'm:' + tileIndex, null, null, true))
        return h('div', { key: keyPrefix + ':' + index, className: 'dsh-card-lan-mj-meld' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-mj-meldlabel' }, label),
          ...tileNodes,
        ])
      }

      /* ---------- header extras: round/dealer, doras, wall, nuki, timer ---------- */
      const headExtras = [
        h('span', { key: 'game', className: 'dsh-card-lan-pill is-game-' + game }, GAME_LABELS[game]),
        h('span', { key: 'round', className: 'dsh-card-lan-tag is-mj-round' },
          roundLabel !== ''
            ? roundLabel + ' · ' + fmt(zh.mjDealerName, { name: dealerNick })
            : fmt(zh.mjRoundDealer, { n: Math.max(1, round), name: dealerNick })),
      ]
      if (dealerRepeat) {
        headExtras.push(h('span', { key: 'repeat', className: 'dsh-card-lan-tag is-mj-repeat' }, zh.mjDealerRepeat))
      }
      // All dora indicators (M2 may expose several after kans).
      const doraTiles = doras.length > 0 ? doras : (doraIndicator !== '' ? [doraIndicator] : [])
      headExtras.push(h('span', { key: 'dora', className: 'dsh-card-lan-tag is-mj-dora' }, [
        h('span', { key: 'label' }, zh.mjDoras + '：'),
        ...(doraTiles.length > 0
          ? doraTiles.map((tile, index) => mahjongTileNode(tile, 'indicator:' + index, null, null, true))
          : [h('span', { key: 'none' }, '—')]),
      ]))
      headExtras.push(h('span', { key: 'wall', className: 'dsh-card-lan-tag' }, fmt(zh.mjWall, { n: wall })))
      if (isThree) {
        headExtras.push(h('span', { key: 'nuki', className: 'dsh-card-lan-tag' }, fmt(zh.mjNuki, { n: nuki })))
      }
      if (dealerNode !== '') {
        headExtras.push(h('span', { key: 'dealer', className: 'dsh-card-lan-tag is-mj-dealer' }, zh.mjDealerMark))
      }
      if (myFuriten) {
        headExtras.push(h('span', { key: 'furiten', className: 'dsh-card-lan-tag is-mj-furiten' }, zh.mjFuriten))
      }
      if (myRiichi) {
        headExtras.push(h('span', { key: 'riichi', className: 'dsh-card-lan-tag is-mj-riichi' }, zh.mjRiichiDone))
      }
      if (riichiSticks > 0) {
        headExtras.push(h('span', { key: 'sticks', className: 'dsh-card-lan-tag is-mj-stick' },
          fmt(zh.mjRiichiSticks, { n: riichiSticks })))
      }
      if ((phase === 'playing' || phase === 'calling') && turnRemainingMs >= 0) {
        headExtras.push(h('span', { key: 'countdown', className: 'dsh-card-lan-tag is-turn' },
          fmt(zh.ddzCountdown, { n: Math.max(0, Math.ceil(turnRemainingMs / 1000)) })))
      }

      /* ---------- hint line ---------- */
      let hint = ''
      if (isSpectator) {
        hint = zh.spectatorHint
      } else if (phase === 'idle') {
        hint = role === 'host' ? zh.ddzIdleHost : zh.ddzWaitStart
      } else if (phase === 'result') {
        hint = role === 'host' ? zh.ddzResultHost : zh.ddzWaitNext
      } else if (phase === 'calling') {
        hint = callable ? zh.mjCallBar : zh.mjCallWait
      } else if (myTurn && myRiichi) {
        hint = zh.mjRiichiAuto
      } else if (myTurn) {
        hint = zh.mjHintYourTurn
      } else {
        hint = turnNick !== '' ? fmt(zh.mjHintWait, { name: turnNick }) : zh.ddzWaitHostState
      }

      const bodyNodes = []

      /* ---------- points bar (milestone ③): every player's points ---------- */
      if (pointsMap !== null && players.length > 0) {
        const pointChips = []
        for (let index = 0; index < players.length; index += 1) {
          const slot = players[index]
          const node = asString(slot.node, '')
          const nick = asString(slot.nick, '玩家')
          const isDealerSeat = node !== '' && node === dealerNode
          const windText = windTextOf(seatWindOf(node, slot))
          pointChips.push(h('span', {
            key: 'pt:' + index,
            className: 'dsh-card-lan-mj-point'
              + (node !== '' && node === myNode ? ' is-self' : '')
              + (isDealerSeat ? ' is-dealer' : ''),
          }, (windText !== '' ? windText + ' ' : '') + nick + ' ' + fmt(zh.mjPointValue, { n: pointOf(node) })))
        }
        bodyNodes.push(h('div', { key: 'points', className: 'dsh-card-lan-mj-points' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-mj-riverlabel' }, zh.mjPoints),
          ...pointChips,
        ]))
      }

      /* ---------- call window: who discarded what + pending player's options ---------- */
      if (phase === 'calling') {
        bodyNodes.push(h('div', { key: 'calling', className: 'dsh-card-lan-mj-call' }, [
          h('span', { key: 'text', className: 'dsh-card-lan-mj-calltext' },
            lastDiscardTile !== ''
              ? fmt(zh.mjCallBar, {
                name: lastDiscardNick,
                tile: readMahjongTile(lastDiscardTile).text,
              })
              : zh.mjCallWait),
          turnRemainingMs >= 0
            ? h('span', { key: 'timer', className: 'dsh-card-lan-tag is-turn' },
              fmt(zh.ddzCountdown, { n: Math.max(0, Math.ceil(turnRemainingMs / 1000)) }))
            : null,
        ]))
      }

      /* ---------- other seats: nickname, hand count, river, turn ---------- */
      const others = players.filter((slot) => slot !== me)
      for (let index = 0; index < others.length; index += 1) {
        const slot = others[index]
        const node = asString(slot.node, '')
        const nick = asString(slot.nick, '玩家')
        const seatIndex = players.indexOf(slot)
        const rawCount = Number.isInteger(slot.handCount)
          ? slot.handCount
          : (Number.isInteger(slot.count) ? slot.count : asArray(slot.hand).length)
        const handCount = Math.max(0, rawCount)
        const isTurn = phase === 'playing' && node !== '' && node === turnNode
        const winning = phase === 'result' && winnerNode !== '' && node === winnerNode
        const classes = ['dsh-card-lan-row', 'dsh-card-lan-mj-seat']
        if (isTurn) classes.push('is-turn')
        if (winning) classes.push('is-winner')
        const seatWindText = windTextOf(seatWindOf(node, slot))
        const seatTenpai = tenpaiOf(node, slot)
        const tags = []
        if (seatWindText !== '') {
          tags.push(h('span', { key: 'wind', className: 'dsh-card-lan-tag is-mj-wind' }, seatWindText))
        }
        tags.push(h('span', { key: 'count', className: 'dsh-card-lan-tag' }, fmt(zh.mjHandCount, { n: handCount })))
        if (seatTenpai !== null && phase === 'result') {
          tags.push(h('span', {
            key: 'tenpai',
            className: 'dsh-card-lan-tag' + (seatTenpai ? ' is-mj-tenpai' : ''),
          }, seatTenpai ? zh.mjTenpai : zh.mjNoten))
        }
        if (pointsMap !== null) {
          tags.push(h('span', { key: 'points', className: 'dsh-card-lan-tag is-mj-pointtag' },
            fmt(zh.mjPointValue, { n: pointOf(node) })))
        }
        if (riichiOf(node)) {
          tags.push(h('span', { key: 'riichi', className: 'dsh-card-lan-tag is-mj-riichi' }, zh.mjRiichiDone))
        }
        if (node !== '' && node === dealerNode) {
          tags.push(h('span', { key: 'dealer', className: 'dsh-card-lan-tag is-mj-dealer' }, zh.mjDealerMark))
        }
        if (winning) {
          tags.push(h('span', { key: 'win', className: 'dsh-card-lan-tag is-result-win' }, zh.mjWin))
        }
        const river = asArray(discardsFor(slot, seatIndex)).filter((tile) => typeof tile === 'string' && tile !== '')
        const riverNodes = river.length > 0
          ? river.map((tile, riverIndex) => mahjongTileNode(tile, 'r:' + riverIndex, null, null, true))
          : [h('span', { key: 'empty', className: 'dsh-card-lan-empty' }, zh.mjEmptyRiver)]
        const seatMelds = asArray(meldsFor(slot))
        const meldNodes = seatMelds
          .map((meld, meldIndex) => meldNode(meld, 'seatMelds', meldIndex))
          .filter((node) => node !== null)
        bodyNodes.push(h('div', { key: 'seat:' + node + ':' + index, className: classes.join(' ') }, [
          h('div', { key: 'headline', className: 'dsh-card-lan-row-head' }, [
            h('span', { key: 'nick', className: 'dsh-card-lan-name' }, nick),
            ...tags,
          ]),
          h('div', { key: 'river', className: 'dsh-card-lan-mj-river' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-mj-riverlabel' }, zh.mjRiver),
            ...riverNodes,
          ]),
          meldNodes.length > 0
            ? h('div', { key: 'melds', className: 'dsh-card-lan-mj-melds' }, [
              h('span', { key: 'label', className: 'dsh-card-lan-mj-riverlabel' }, zh.mjMelds),
              ...meldNodes,
            ])
            : null,
        ]))
      }

      /* ---------- my hand: 13/14 text tiles, single-select ---------- */
      if (!isSpectator) {
        const handHead = [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, fmt(zh.mjMyHand, { n: myHand.length })),
          windTextOf(seatWindOf(myNode, me)) !== ''
            ? h('span', { key: 'wind', className: 'dsh-card-lan-tag is-mj-wind' }, windTextOf(seatWindOf(myNode, me)))
            : null,
          tenpaiOf(myNode, me) !== null && phase === 'result'
            ? h('span', {
              key: 'tenpai',
              className: 'dsh-card-lan-tag' + (tenpaiOf(myNode, me) ? ' is-mj-tenpai' : ''),
            }, tenpaiOf(myNode, me) ? zh.mjTenpai : zh.mjNoten)
            : null,
          selectedIndexes.length > 0
            ? h('span', { key: 'sel', className: 'dsh-card-lan-tag is-turn' },
              fmt(zh.mjSelected, { n: selectedIndexes.length }))
            : null,
          myTurn ? h('span', { key: 'turn', className: 'dsh-card-lan-tag is-turn' }, zh.mjHintYourTurn) : null,
        ]
        const handNodes = myHand.map((tile, index) => mahjongTileNode(
          tile,
          'hand:' + index + ':' + tile,
          selectedIndexes.indexOf(index) !== -1,
          canSelect ? () => props.toggleCard(index) : null,
          false,
        ))
        bodyNodes.push(h('div', { key: 'myHand', className: 'dsh-card-lan-mj-hand-area' }, [
          h('div', { key: 'head', className: 'dsh-card-lan-row-head' }, handHead),
          (() => {
            const ownMelds = myMelds
              .map((meld, meldIndex) => meldNode(meld, 'ownMelds', meldIndex))
              .filter((node) => node !== null)
            return ownMelds.length > 0
              ? h('div', { key: 'melds', className: 'dsh-card-lan-mj-melds' }, [
                h('span', { key: 'label', className: 'dsh-card-lan-mj-riverlabel' }, zh.mjMelds),
                ...ownMelds,
              ])
              : null
          })(),
          handNodes.length > 0
            ? h('div', { key: 'tiles', className: 'dsh-card-lan-mj-hand' }, handNodes)
            : h('span', { key: 'empty', className: 'dsh-card-lan-empty' }, zh.mjSelectHint),
        ]))
      }

      /* ---------- result: win / draw + reveal all hands ---------- */
      if (phase === 'result') {
        const winner = players.find((slot) => asString(slot.node, '') === winnerNode)
        const winnerNick = winner !== undefined ? asString(winner.nick, '玩家') : ''
        const exhausted = result === 'exhausted'
        let bannerText = zh.mjRoundOver
        let bannerClass = 'dsh-card-lan-banner is-none'
        if (exhausted) {
          bannerText = zh.mjExhausted
        } else if (result === 'tsumo' || result === 'ron' || result === 'win' || winnerNode !== '') {
          bannerText = zh.mjWin + (winnerNick !== '' ? ' · ' + fmt(zh.mjWinner, { name: winnerNick }) : '')
          bannerClass = 'dsh-card-lan-banner is-win'
        }
        if (matchOver) {
          bannerText = zh.mjMatchOver
          bannerClass = 'dsh-card-lan-banner is-win'
        }
        bodyNodes.push(h('div', { key: 'result', className: bannerClass, role: 'status' }, bannerText))

        // Milestone ③ settlement panel: winner / yaku / fu-han-score / dora / riichi / deltas.
        const detailChildren = []
        if (!exhausted) {
          const winnerType = result === 'tsumo' ? zh.mjTsumoType : zh.mjRonType
          detailChildren.push(h('div', { key: 'winner', className: 'dsh-card-lan-mj-resultline' },
            fmt(zh.mjWinnerLine, { name: winnerNick !== '' ? winnerNick : '玩家', type: winnerType })))
          const yakuRows = []
          for (let index = 0; index < yakuList.length; index += 1) {
            const entry = yakuList[index]
            let name = ''
            let han = null
            if (typeof entry === 'string') {
              name = entry
            } else {
              const record = asObject(entry)
              if (record !== null) {
                name = asString(record.name, asString(record.label, asString(record.yaku, '')))
                if (Number.isFinite(record.han)) han = Math.round(record.han)
                else if (Number.isFinite(record.value)) han = Math.round(record.value)
              }
            }
            if (name === '') continue
            yakuRows.push(h('div', { key: 'yaku:' + index, className: 'dsh-card-lan-mj-yakuline' },
              han !== null ? fmt(zh.mjYakuLine, { name, han }) : name))
          }
          if (yakuRows.length > 0) {
            detailChildren.push(h('div', { key: 'yaku', className: 'dsh-card-lan-mj-yaku' }, [
              h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.mjYakuTitle),
              ...yakuRows,
            ]))
          }
          const stats = []
          if (totalFu >= 0) stats.push(fmt(zh.mjFuLine, { fu: totalFu }))
          if (totalHan >= 0) stats.push(fmt(zh.mjHanLine, { han: totalHan }))
          if (totalScore >= 0) stats.push(fmt(zh.mjScoreLine, { n: totalScore }))
          if (stats.length > 0) {
            detailChildren.push(h('div', { key: 'stats', className: 'dsh-card-lan-mj-resultline' }, stats.join(' · ')))
          }
          const doraRow = []
          if (doraTiles.length > 0) {
            doraRow.push(h('span', { key: 'dlabel', className: 'dsh-card-lan-mj-riverlabel' }, zh.mjDorasTitle + '：'))
            for (let index = 0; index < doraTiles.length; index += 1) {
              doraRow.push(mahjongTileNode(doraTiles[index], 'rd:' + index, null, null, true))
            }
          }
          if (uraDoras.length > 0) {
            doraRow.push(h('span', { key: 'ulabel', className: 'dsh-card-lan-mj-riverlabel' }, zh.mjUraTitle + '：'))
            for (let index = 0; index < uraDoras.length; index += 1) {
              doraRow.push(mahjongTileNode(uraDoras[index], 'ru:' + index, null, null, true))
            }
          }
          let winnerTiles = winner !== undefined
            ? asArray(winner.hand).filter((tile) => typeof tile === 'string' && tile !== '')
            : []
          if (winnerTiles.length === 0 && winner === me) winnerTiles = myHand
          const winnerMelds = winner !== undefined ? asArray(meldsFor(winner)) : []
          const winnerAllTiles = winnerTiles.slice()
          for (const meld of winnerMelds) {
            const meldRecord = asObject(meld)
            if (meldRecord === null) continue
            for (const tile of asArray(meldRecord.tiles)) {
              if (typeof tile === 'string') winnerAllTiles.push(tile)
            }
          }
          let akaCount = 0
          for (const tile of winnerAllTiles) {
            if (tile.length >= 3 && tile.slice(-1) === 'r') akaCount += 1
          }
          doraRow.push(h('span', { key: 'aka', className: 'dsh-card-lan-tag is-mj-aka' },
            fmt(zh.mjAkaTitle, { n: akaHan >= 0 ? akaHan : akaCount })))
          if (doraHan >= 0) {
            doraRow.push(h('span', { key: 'dorahan', className: 'dsh-card-lan-tag is-mj-dora' },
              fmt(zh.mjDoraHanLine, { n: doraHan })))
          }
          if (uraHan >= 0) {
            doraRow.push(h('span', { key: 'urahan', className: 'dsh-card-lan-tag' },
              fmt(zh.mjUraHanLine, { n: uraHan })))
          }
          detailChildren.push(h('div', { key: 'dora', className: 'dsh-card-lan-mj-resultline' }, doraRow))
          if (sticksAwarded > 0) {
            detailChildren.push(h('div', { key: 'sticks', className: 'dsh-card-lan-mj-resultline' },
              fmt(zh.mjRiichiStickLine, { n: sticksAwarded })))
          }
        }
        if (deltasMap !== null) {
          const deltaLines = []
          for (let index = 0; index < players.length; index += 1) {
            const slot = players[index]
            const node = asString(slot.node, '')
            const rawDelta = deltasMap[node]
            if (!Number.isFinite(rawDelta)) continue
            const delta = Math.round(rawDelta)
            deltaLines.push(h('div', {
              key: 'delta:' + index,
              className: 'dsh-card-lan-mj-deltaline'
                + (delta > 0 ? ' is-plus' : (delta < 0 ? ' is-minus' : '')),
            }, fmt(zh.mjDeltaLine, {
              name: asString(slot.nick, '玩家'),
              delta: delta > 0 ? '+' + delta : String(delta),
            })))
          }
          if (deltaLines.length > 0) {
            detailChildren.push(h('div', { key: 'deltas', className: 'dsh-card-lan-mj-deltas' }, [
              h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.mjDeltasTitle),
              ...deltaLines,
            ]))
          }
        }
        if (detailChildren.length > 0) {
          bodyNodes.push(h('div', { key: 'detail', className: 'dsh-card-lan-mj-resultpanel' }, detailChildren))
        }

        // Milestone ④: exhausted tenpai / noten penalty rows (when the host
        // exposes per-player tenpai flags).
        if (exhausted) {
          const tenpaiLines = []
          for (let index = 0; index < players.length; index += 1) {
            const slot = players[index]
            const node = asString(slot.node, '')
            const tenpaiState = tenpaiOf(node, slot)
            if (tenpaiState === null) continue
            const rawDelta = deltasMap !== null ? deltasMap[node] : undefined
            const deltaText = Number.isFinite(rawDelta)
              ? (Math.round(rawDelta) > 0 ? '+' + Math.round(rawDelta) : String(Math.round(rawDelta)))
              : ''
            tenpaiLines.push(h('div', {
              key: 'tp:' + index,
              className: 'dsh-card-lan-mj-tenpairow' + (tenpaiState ? ' is-tenpai' : ''),
            }, [
              h('span', { key: 'nick', className: 'dsh-card-lan-name' }, asString(slot.nick, '玩家')),
              h('span', {
                key: 'tag',
                className: 'dsh-card-lan-tag' + (tenpaiState ? ' is-mj-tenpai' : ''),
              }, tenpaiState ? zh.mjTenpai : zh.mjNoten),
              deltaText !== ''
                ? h('span', { key: 'delta', className: 'dsh-card-lan-mj-deltaline' }, deltaText)
                : null,
            ]))
          }
          if (tenpaiLines.length > 0) {
            bodyNodes.push(h('div', { key: 'tenpai', className: 'dsh-card-lan-mj-tenpais' }, [
              h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.mjTenpaiTitle),
              ...tenpaiLines,
            ]))
          }
          if (riichiSticks > 0) {
            bodyNodes.push(h('div', { key: 'sticksKept', className: 'dsh-card-lan-mj-resultline' },
              fmt(zh.mjRiichiKept, { n: riichiSticks })))
          }
        }

        // Milestone ④: final ranking when the east-round match is over.
        if (matchOver) {
          const rankLines = rankingEntries.map((row, index) => h('div', {
            key: 'rank:' + index,
            className: 'dsh-card-lan-mj-rankline',
          }, fmt(zh.mjRankLine, { rank: row.rank, name: row.nick, points: row.points })))
          if (rankLines.length > 0) {
            bodyNodes.push(h('div', { key: 'ranking', className: 'dsh-card-lan-mj-ranking' }, [
              h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.mjFinalRanking),
              ...rankLines,
            ]))
          }
        }

        const revealLines = []
        for (let index = 0; index < players.length; index += 1) {
          const slot = players[index]
          const node = asString(slot.node, '')
          const nick = asString(slot.nick, '玩家')
          let hand = asArray(slot.hand).filter((tile) => typeof tile === 'string' && tile !== '')
          if (hand.length === 0) hand = asArray(slot.cards).filter((tile) => typeof tile === 'string' && tile !== '')
          if (hand.length === 0 && slot === me) hand = myHand
          const won = node !== '' && node === winnerNode
          const tileNodes = hand.length > 0
            ? hand.map((tile, tileIndex) => mahjongTileNode(tile, 'x:' + tileIndex, null, null, true))
            : [h('span', { key: 'empty', className: 'dsh-card-lan-empty' }, '—')]
          revealLines.push(h('div', {
            key: 'reveal:' + index + ':' + node,
            className: 'dsh-card-lan-mj-revealline' + (won ? ' is-winner' : ''),
          }, [
            h('span', { key: 'nick', className: 'dsh-card-lan-name' }, nick),
            ...tileNodes,
          ]))
        }
        bodyNodes.push(h('div', { key: 'reveal', className: 'dsh-card-lan-mj-reveal' }, [
          h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.mjReveal),
          ...revealLines,
        ]))
      }

      /* ---------- actions: calls (calling) / discard / nuki / tsumo / kans / start ---------- */
      const actionNodes = []
      const callDisabled = busy || connectionBroken
      if (phase === 'calling' && pendingEntry !== null) {
        if (callAllowed('ron')) {
          actionNodes.push(h('button', {
            key: 'ron',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-primary',
            disabled: callDisabled || myFuriten,
            onClick: () => void props.ronCall(),
          }, zh.mjRon))
        }
        if (callAllowed('pon')) {
          actionNodes.push(h('button', {
            key: 'pon',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: callDisabled || lastDiscardTile === '',
            onClick: () => void props.ponCall(),
          }, zh.mjPon))
        }
        if (callAllowed('kan')) {
          actionNodes.push(h('button', {
            key: 'kan',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: callDisabled || lastDiscardTile === '',
            onClick: () => void props.kanCall(),
          }, zh.mjKan))
        }
        if (callAllowed('chi')) {
          if (chiOptions.length > 1) {
            actionNodes.push(h('span', { key: 'chiLabel', className: 'dsh-card-lan-mj-calltext' }, zh.mjChiChoice))
            for (let index = 0; index < chiOptions.length; index += 1) {
              const option = chiOptions[index]
              actionNodes.push(h('button', {
                key: 'chi:' + index,
                type: 'button',
                className: 'dsh-card-lan-button dsh-card-lan-button-small',
                disabled: callDisabled,
                onClick: () => void props.chiCall(option),
              }, fmt(zh.mjChiOption, {
                a: readMahjongTile(option[0]).text,
                b: readMahjongTile(option[1]).text,
              })))
            }
          } else {
            actionNodes.push(h('button', {
              key: 'chi',
              type: 'button',
              className: 'dsh-card-lan-button',
              disabled: callDisabled,
              onClick: () => void props.chiCall(chiOptions.length > 0 ? chiOptions[0] : []),
            }, zh.mjChi))
          }
        }
        actionNodes.push(h('button', {
          key: 'callPass',
          type: 'button',
          className: 'dsh-card-lan-button',
          disabled: callDisabled,
          onClick: () => void props.passCall(),
        }, zh.mjPass))
      }
      if (myTurn) {
        if (canRiichi) {
          actionNodes.push(h('button', {
            key: 'riichi',
            type: 'button',
            className: 'dsh-card-lan-button dsh-card-lan-button-primary',
            disabled: busy || connectionBroken,
            onClick: () => void props.riichiCall(),
          }, zh.mjRiichi))
        }
        // After riichi the engine forces discarding the drawn tile; when the view
        // marks `autoDiscard` the server handles it and no discard button is shown.
        if (!(myRiichi && autoDiscard)) {
          actionNodes.push(h('button', {
            key: 'discard',
            type: 'button',
            className: 'dsh-card-lan-button' + (canRiichi ? '' : ' dsh-card-lan-button-primary'),
            disabled: busy || selectedTile === '',
            onClick: () => void props.discardSelected(),
          }, zh.mjDiscard))
        }
        // mustDiscard (after a call/kan) only offers discard-type actions.
        if (!mustDiscard) {
          if (isThree && hasNorth) {
            actionNodes.push(h('button', {
              key: 'nuki',
              type: 'button',
              className: 'dsh-card-lan-button',
              disabled: busy || connectionBroken,
              onClick: () => void props.nukiTile(),
            }, zh.mjNukiBtn))
          }
          actionNodes.push(h('button', {
            key: 'tsumo',
            type: 'button',
            className: 'dsh-card-lan-button',
            disabled: busy || connectionBroken,
            onClick: () => void props.tsumoWin(),
          }, zh.mjTsumo))
          // Riichi forbids kans (M3 simplification).
          if (!myRiichi) {
            for (let index = 0; index < ankanOptions.length; index += 1) {
              const tile = ankanOptions[index]
              actionNodes.push(h('button', {
                key: 'ankan:' + index,
                type: 'button',
                className: 'dsh-card-lan-button dsh-card-lan-button-small',
                disabled: busy || connectionBroken,
                onClick: () => void props.ankanCall(tile),
              }, fmt(zh.mjAnkanButton, { tile: readMahjongTile(tile).text })))
            }
            for (let index = 0; index < kakanOptions.length; index += 1) {
              const tile = kakanOptions[index]
              actionNodes.push(h('button', {
                key: 'kakan:' + index,
                type: 'button',
                className: 'dsh-card-lan-button dsh-card-lan-button-small',
                disabled: busy || connectionBroken,
                onClick: () => void props.kakanCall(tile),
              }, fmt(zh.mjKakanButton, { tile: readMahjongTile(tile).text })))
            }
          }
        }
      }
      if (role === 'host' && (phase === 'idle' || phase === 'result')) {
        actionNodes.push(h('button', {
          key: 'start',
          type: 'button',
          className: 'dsh-card-lan-button dsh-card-lan-button-primary',
          disabled: busy || connectionBroken,
          onClick: () => void props.startRound(),
        }, phase === 'result'
          ? (matchOver ? zh.mjNewMatch : zh.ddzNextRound)
          : zh.ddzStart))
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
      const [invitePaste, setInvitePaste] = useState('')
      const [tab, setTab] = useState('room')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [peerPasswords, setPeerPasswords] = useState({})
      const [opacityDraft, setOpacityDraft] = useState(null)
      const [sizeDraft, setSizeDraft] = useState(null)
      const [autoFadeDraft, setAutoFadeDraft] = useState(null)
      const [botCountDraft, setBotCountDraft] = useState(null)
      const [autoFillDraft, setAutoFillDraft] = useState(null)
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
      // Auto-fill (PROTOCOL §7.8): when on, the host ignores botCount and fills
      // the table to minPlayers, so the count select becomes read-only.
      const configAutoFillBots = previewConfig !== null ? previewConfig.autoFillBots === true : false
      const effectiveOpacity = opacityDraft !== null ? opacityDraft : configOpacity
      const effectiveSize = sizeDraft !== null ? sizeDraft : configSize
      const effectiveAutoFade = autoFadeDraft !== null ? autoFadeDraft : configAutoFade
      const effectiveBotCount = botCountDraft !== null ? botCountDraft : configBotCount
      const effectiveAutoFillBots = autoFillDraft !== null ? autoFillDraft : configAutoFillBots
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
        setAutoFillDraft(null)
      }, [configAutoFillBots])

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

      /** Auto-fill toggle (PROTOCOL §7.8): when on, the host fills to 3 seats. */
      const changeAutoFillBots = (checked) => {
        const value = checked === true
        setAutoFillDraft(value)
        void applyDisplay({ autoFillBots: value }).then((saved) => {
          // Failure: drop the optimistic draft so the checkbox snaps back to
          // the host value; the notice from applyDisplay explains why.
          if (!saved) setAutoFillDraft(null)
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

      /** Invite helpers (PROTOCOL §7.10): copy the code, or apply+save it. */
      const inviteCode = inviteCodeOf(form !== null ? form.room : '', form !== null ? form.port : '')

      const copyInvite = async () => {
        if (form === null) return
        const code = inviteCodeOf(form.room, form.port)
        const copied = await copyText(code)
        if (copied) showNotice(fmt(zh.inviteCopied, { code }), false)
        else showNotice(fmt(zh.inviteCopyFailed, { code }), true)
      }

      /**
       * Apply one pasted invite: fill the form first, then PATCH only
       * { room, port } so other unsaved drafts are never committed by accident.
       */
      const applyInvite = async () => {
        if (form === null) return
        const parsed = parseInvite(invitePaste)
        if (parsed === null) {
          showNotice(zh.inviteInvalid, true)
          return
        }
        setForm((current) => (current === null ? current : { ...current, room: parsed.room, port: parsed.port }))
        setManual((current) => ({ ...current, port: String(parsed.port) }))
        setBusy(true)
        showNotice('')
        const result = await store.configure({ room: parsed.room, port: parsed.port })
        setBusy(false)
        if (result.ok !== true) {
          // Keep the filled draft so the user can fix it on the 设置 tab.
          showNotice(fmt(zh.inviteApplyFailed, { error: errorText(result.error) || zh.saveFailed }), true)
          return
        }
        // Converge on whatever the host accepted (it may normalise values).
        const savedConfig = result.config !== undefined && result.config !== null
          ? asObject(result.config)
          : null
        const finalRoom = savedConfig !== null ? asString(savedConfig.room, parsed.room) : parsed.room
        const finalPort = savedConfig !== null ? asNumber(savedConfig.port, parsed.port) : parsed.port
        setForm((current) => (current === null ? current : { ...current, room: finalRoom, port: finalPort }))
        setManual((current) => ({ ...current, port: String(finalPort) }))
        showNotice(fmt(zh.inviteApplied, { room: finalRoom, port: finalPort }), false)
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

      // Lobby tabs (PROTOCOL §7.11): the same field nodes are grouped into the
      // 房间/设置 panels below, so no input loses its state on a tab switch.
      const fieldNodes = [
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
        h('div', { key: 'invite', className: 'dsh-card-lan-field dsh-card-lan-settings-block' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.inviteLabel),
          h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.inviteHint),
          h('div', { key: 'copyRow', className: 'dsh-card-lan-actions' }, [
            h('input', {
              key: 'code',
              className: 'dsh-card-lan-input dsh-card-lan-input-invite',
              type: 'text',
              readOnly: true,
              'aria-label': zh.inviteCode,
              value: inviteCode,
              onFocus: (event) => {
                if (event !== null && event !== undefined && event.target !== null
                  && event.target !== undefined && typeof event.target.select === 'function') {
                  event.target.select()
                }
              },
            }),
            h('button', {
              key: 'copy',
              type: 'button',
              className: 'dsh-card-lan-button',
              disabled: form === null || busy,
              onClick: () => void copyInvite(),
            }, zh.copyInvite),
          ]),
          h('div', { key: 'pasteRow', className: 'dsh-card-lan-actions' }, [
            h('input', {
              key: 'paste',
              className: 'dsh-card-lan-input dsh-card-lan-input-invite',
              type: 'text',
              'aria-label': zh.inviteLabel,
              placeholder: zh.invitePlaceholder,
              value: invitePaste,
              disabled: form === null || busy,
              onChange: (event) => setInvitePaste(event.target.value),
            }),
            h('button', {
              key: 'apply',
              type: 'button',
              className: 'dsh-card-lan-button',
              disabled: form === null || busy,
              onClick: () => applyInvite(),
            }, zh.applyInvite),
          ]),
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
          h('div', { key: 'autoFillBots', className: 'dsh-card-lan-field' }, [
            h('label', { key: 'check', className: 'dsh-card-lan-check' }, [
              h('input', {
                key: 'input',
                type: 'checkbox',
                'aria-label': zh.autoFillBots,
                checked: effectiveAutoFillBots,
                disabled: busy,
                onChange: (event) => changeAutoFillBots(event.target.checked),
              }),
              h('span', { key: 'label' }, zh.autoFillBots),
            ]),
            h('span', { key: 'hint', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.autoFillBotsHint),
          ]),
          h('label', { key: 'botCount', className: 'dsh-card-lan-field' }, [
            h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.botCount),
            h('select', {
              key: 'select',
              className: 'dsh-card-lan-input dsh-card-lan-input-narrow',
              'aria-label': zh.botCount,
              value: String(effectiveBotCount),
              // Auto-fill ignores botCount host-side, so the count is read-only.
              disabled: busy || effectiveAutoFillBots,
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
      ]

      // Split the one flat field list into the two tab panels (PROTOCOL §7.11).
      const enabledField = fieldNodes[0]
      const roomField = fieldNodes[1]
      const portField = fieldNodes[2]
      const inviteBlock = fieldNodes[3]
      const nickField = fieldNodes[4]
      const roomSettingsBlock = fieldNodes[5]
      const displayBlock = fieldNodes[6]
      const saveActions = fieldNodes[7]

      const networkFields = h('div', { key: 'networkFields', className: 'dsh-card-lan-fields' }, [
        roomField,
        portField,
        nickField,
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

      const tabButton = (id, label) => h('button', {
        key: id,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === id,
        className: 'dsh-card-lan-tab' + (tab === id ? ' is-active' : ''),
        onClick: () => setTab(id),
      }, label)

      const tabBar = h('div', {
        key: 'tabs',
        className: 'dsh-card-lan-tabs',
        role: 'tablist',
        'aria-label': zh.tabsLabel,
      }, [
        tabButton('room', zh.tabRoom),
        tabButton('settings', zh.tabSettings),
      ])

      // 房间: seat/connection controls + discovery. 设置: editable config + save.
      const roomPanel = h('div', {
        key: 'roomPanel',
        className: 'dsh-card-lan-tabpanel',
        role: 'tabpanel',
      }, [
        h('div', { key: 'enabledBlock', className: 'dsh-card-lan-field dsh-card-lan-settings-block' }, [enabledField]),
        status,
        h('div', { key: 'table', className: 'dsh-card-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-card-lan-label' }, zh.tableLabel),
          identity,
          tableActions,
        ]),
        inviteBlock,
        h('div', { key: 'peers', className: 'dsh-card-lan-peers' }, [
          h('div', { key: 'title', className: 'dsh-card-lan-label' }, zh.foundTables),
          peerNodes.length === 0
            ? h('p', { key: 'empty', className: 'dsh-card-lan-muted dsh-card-lan-small' }, zh.noPeers)
            : null,
          ...peerNodes,
        ]),
        manualBlock,
      ])

      const settingsPanel = h('div', {
        key: 'settingsPanel',
        className: 'dsh-card-lan-tabpanel',
        role: 'tabpanel',
      }, [
        networkFields,
        roomSettingsBlock,
        displayBlock,
        saveActions,
      ])

      return h('div', { className: 'dsh-card-lan-section' }, [
        head,
        tabBar,
        noticeNode,
        tab === 'settings' ? settingsPanel : roomPanel,
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
      const [selectedIndexes, setSelectedIndexes] = useState([])
      const [raiseOpen, setRaiseOpen] = useState(false)
      const [raiseTarget, setRaiseTarget] = useState(null)
      const [showSettings, setShowSettings] = useState(false)
      const settingsTimer = useRef(null)
      // A drag that ends over the capsule must not also expand it.
      const suppressCapsuleClick = useRef(false)

      // The local hand selection is invalidated whenever the board, the turn or
      // my hand changes (a play landed, the round moved on, re-deal).
      const tableRecord = data !== null ? asObject(data.table) : null
      const boardKey = tableRecord === null ? '' : [
        asString(tableRecord.game, DEFAULT_GAME),
        asString(tableRecord.phase, ''),
        asString(tableRecord.turn, ''),
        // Sorted so a host re-ordering the hand does not reset the selection.
        sortDdzCards(asArray(tableRecord.myCards)).join(','),
        // Mahjong keeps the hand in `myHand` (tiles), so track it too.
        asArray(tableRecord.myHand).join(','),
        // A new call window (new discard) invalidates old selections.
        (() => {
          const lastDiscardRecord = asObject(tableRecord.lastDiscard)
          return lastDiscardRecord !== null
            ? asString(lastDiscardRecord.node, '') + ':' + asString(lastDiscardRecord.tile, '')
            : ''
        })(),
      ].join('|')
      useEffect(() => {
        setSelectedIndexes([])
        setRaiseOpen(false)
        setRaiseTarget(null)
      }, [boardKey])

      const configRecord = data !== null ? asObject(data.config) : null
      // Guandan needs room for 27 cards: keep at least a 420px panel even if the
      // user picked the small/medium size (bigger sizes are respected).
      const earlyGame = tableRecord !== null ? gameOf(tableRecord.game) : DEFAULT_GAME
      // Mahjong gets its dedicated wide window (720–760px) regardless of the
      // user's overlay-size preset; other games keep their normal widths.
      const sizeWidth = isMahjongId(earlyGame)
        ? MJ_WIDTH
        : Math.max(
          earlyGame === 'guandan' ? GUANDAN_MIN_WIDTH : 0,
          OVERLAY_WIDTHS[overlaySizeOf(configRecord)],
        )
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
      const isGuandan = game === 'guandan'
      const isZjh = game === 'zhajinhua'
      const isTexas = game === 'texas'
      const isMahjong = isMahjongId(game)
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

      // Guandan-only view fields (PROTOCOL §7.12); ignored by the other games.
      const guandanInfo = isGuandan
        ? {
          level: asString(table.level, '2'),
          teamLevels: asArray(table.teamLevels).map((value) => asString(value, '2')).slice(0, 2),
          myTeam: teamIndexOf(table.team, me !== undefined ? me.team : undefined),
          winnerTeam: teamIndexOf(table.winnerTeam),
          upgrade: asNumber(table.upgrade, -1),
          orders: asArray(table.orders).map((value) => asString(value, '')).filter((value) => value !== ''),
          // Hosts expose "passed A / match over" as `matchWon` (PROTOCOL §7.12
          // extension); older probes are kept for defensive compatibility.
          victory: table.matchWon === true || table.victory === true || table.passedA === true
            || table.matchOver === true || table.gameOver === true,
        }
        : null

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

      /** Zhajinhua writes (PROTOCOL §7.14): look / call / raise / fold / compare. */
      const lookCards = () => act({ type: 'look' })
      const callBet = () => act({ type: 'call' })
      const raiseBet = () => act({ type: 'raise' })
      const foldHand = () => act({ type: 'fold' })
      const compareHand = () => act({ type: 'compare' })
      /** Texas Hold'em writes (PROTOCOL §7.16): check also exists. */
      const checkBet = () => act({ type: 'check' })

      /** Mahjong milestone ③: declare riichi (PROTOCOL §7.22). */
      const riichiCall = () => void act({ type: 'riichi' })

      /** Guandan tribute-return write (PROTOCOL §7.12, v10). */
      const submitTribute = (card) => {
        const value = asString(card, '')
        if (value === '') return
        void act({ type: 'tribute-return', card: value })
      }

      /** Mahjong writes (PROTOCOL §7.18): discard / nuki / tsumo. */
      const discardSelected = () => {
        const hand = asArray(table.myHand)
        const tile = selectedIndexes.length === 1 && typeof hand[selectedIndexes[0]] === 'string'
          ? hand[selectedIndexes[0]]
          : ''
        if (tile === '') return
        setSelectedIndexes([])
        void act({ type: 'discard', tile })
      }
      const nukiTile = () => void act({ type: 'nuki', tile: 'N' })
      // Mahjong milestone ② (PROTOCOL §7.20): calls, kans, furiten.
      const mjLastDiscard = isMahjong ? asObject(table.lastDiscard) : null
      const mjCallTile = () => {
        const record = asObject(table.lastDiscard)
        return record !== null ? asString(record.tile, '') : ''
      }
      const ronCall = () => void act({ type: 'ron' })
      const ponCall = () => {
        const tile = mjCallTile()
        if (tile === '') return
        void act({ type: 'pon', tiles: [tile, tile] })
      }
      const kanCall = () => {
        const tile = mjCallTile()
        if (tile === '') return
        void act({ type: 'kan', tiles: [tile, tile, tile] })
      }
      const chiCall = (option) => {
        const tiles = asArray(option).filter((tile) => typeof tile === 'string' && tile !== '')
        if (tiles.length !== 2) return
        void act({ type: 'chi', tiles })
      }
      const passCall = () => void act({ type: 'pass' })
      const ankanCall = (tile) => {
        const value = asString(tile, '')
        if (value === '') return
        void act({ type: 'ankan', tile: value })
      }
      const kakanCall = (tile) => {
        const value = asString(tile, '')
        if (value === '') return
        void act({ type: 'kakan', tile: value })
      }
      const tsumoWin = () => void act({ type: 'tsumo' })

      /** Card-game writes (PROTOCOL §7.3/§7.6/§7.12): bid / play / pass / start. */
      const toggleCard = (index) => {
        // Guandan tribute returns exactly one card, so replace the selection.
        if (isGuandan && phase === 'tribute') {
          setSelectedIndexes([index])
          return
        }
        // Mahjong discards exactly one tile.
        if (isMahjong) {
          setSelectedIndexes([index])
          return
        }
        setSelectedIndexes((current) => (current.indexOf(index) === -1
          ? current.concat([index])
          : current.filter((item) => item !== index)))
      }
      const playSelected = async () => {
        if (selectedIndexes.length === 0) return
        // Map hand indexes back to card codes (duplicates are legitimate).
        const cards = selectedIndexes
          .map((index) => cardMyCards[index])
          .filter((card) => typeof card === 'string' && card !== '')
        if (cards.length === 0) return
        const saved = await act({ type: 'play', cards })
        if (saved) setSelectedIndexes([])
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
      // Guandan v10 tribute fields (PROTOCOL §7.12).
      const gdTribute = isGuandan ? asArray(table.tribute) : []
      const gdPendingReturn = isGuandan ? asString(table.pendingReturn, '') : ''

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
          selectedIndexes,
          toggleCard,
          landlordPlayer,
          guandan: guandanInfo,
          tribute: gdTribute,
          pendingReturn: gdPendingReturn,
          submitTribute,
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

      // Zhajinhua view fields (PROTOCOL §7.14); ignored by the other games.
      const zjhMyCards = isZjh
        ? asArray(table.myCards).filter((card) => typeof card === 'string' && card !== '')
        : []
      const bettingGame = isZjh
        ? buildZhajinhuaContent({
          role,
          isSpectator,
          phase,
          players,
          me,
          myNode,
          turnNode,
          turnNick,
          myCards: zjhMyCards,
          pot: Math.max(0, asNumber(table.pot, 0)),
          currentBet: Math.max(0, asNumber(table.currentBet, 0)),
          raises: Math.max(0, asNumber(table.raises, 0)),
          maxRaises: ZJH_MAX_RAISES,
          winnerNode: asString(table.winnerNode, ''),
          busy,
          connectionBroken,
          turnRemainingMs,
          lookCards,
          callBet,
          raiseBet,
          foldHand,
          compareHand,
          startRound,
        })
        : null

      // Texas Hold'em view fields (PROTOCOL §7.16); ignored by the other games.
      const txCommunityRaw = isTexas ? asArray(table.community) : []
      const txCommunity = isTexas
        ? (txCommunityRaw.length > 0 ? txCommunityRaw : asArray(table.board))
        : []
      // v10 raise controls: range from the minimum raise (currentBet + max(20,
      // last raise increment)) to the player's all-in street total.
      const txRaiseInfo = (() => {
        if (!isTexas) return null
        const txMe = players.find((slot) => slot.self === true)
        const chips = txMe !== undefined ? Math.max(0, asNumber(txMe.chips, 0)) : 0
        const streetBet = txMe !== undefined ? Math.max(0, asNumber(txMe.bet, 0)) : 0
        const bet = Math.max(0, asNumber(table.currentBet, 0))
        const lastDelta = Math.max(TX_RAISE_STEP,
          Math.max(0, asNumber(table.lastRaise, Math.max(0, asNumber(table.raiseSize, 0)))))
        const allIn = streetBet + chips
        const minTarget = Math.min(allIn, bet + lastDelta)
        return { minTarget: Math.max(0, minTarget), allIn: Math.max(0, allIn) }
      })()
      const toggleRaise = () => setRaiseOpen((value) => !value)
      const changeRaiseTarget = (value) => {
        if (txRaiseInfo === null) return
        const numeric = Number(value)
        if (!Number.isFinite(numeric)) return
        setRaiseTarget(Math.min(txRaiseInfo.allIn, Math.max(txRaiseInfo.minTarget, Math.round(numeric))))
      }
      const submitRaise = (value) => {
        if (txRaiseInfo === null) return
        const numeric = Number(value)
        const amount = Math.min(txRaiseInfo.allIn, Math.max(txRaiseInfo.minTarget,
          Number.isFinite(numeric) ? Math.round(numeric) : txRaiseInfo.minTarget))
        setRaiseOpen(false)
        setRaiseTarget(null)
        void act({ type: 'raise', amount })
      }
      const texasGame = isTexas
        ? buildTexasContent({
          role,
          isSpectator,
          phase,
          players,
          me,
          myNode,
          turnNode,
          turnNick,
          myCards: asArray(table.myCards).filter((card) => typeof card === 'string' && card !== ''),
          community: txCommunity,
          pot: Math.max(0, asNumber(table.pot, 0)),
          currentBet: Math.max(0, asNumber(table.currentBet, 0)),
          dealerNode: asString(table.dealer, ''),
          winnerNodes: asArray(table.winnerNodes),
          pots: asArray(table.pots),
          raiseOpen,
          raiseMin: txRaiseInfo !== null ? txRaiseInfo.minTarget : 0,
          raiseMax: txRaiseInfo !== null ? txRaiseInfo.allIn : 0,
          raiseTarget,
          toggleRaise,
          setRaiseTarget: changeRaiseTarget,
          submitRaise,
          busy,
          connectionBroken,
          turnRemainingMs,
          foldHand,
          checkBet,
          callBet,
          raiseBet,
          startRound,
        })
        : null

      // Mahjong view fields (PROTOCOL §7.18); ignored by other games.
      const mjMyHand = isMahjong
        ? asArray(table.myHand).filter((tile) => typeof tile === 'string' && tile !== '')
        : []
      const mjDiscardsRaw = isMahjong ? table.discards : null
      const mahjongDiscardsFor = (slot, index) => {
        if (Array.isArray(mjDiscardsRaw)) {
          return asArray(mjDiscardsRaw[index]).filter((tile) => typeof tile === 'string' && tile !== '')
        }
        const discardsMap = asObject(mjDiscardsRaw)
        if (discardsMap === null) return []
        return asArray(discardsMap[asString(slot.node, '')]).filter((tile) => typeof tile === 'string' && tile !== '')
      }
      // Milestone ②: call window / melds / doras / furiten (PROTOCOL §7.20).
      const mjDorasRaw = isMahjong
        ? asArray(table.doras).filter((tile) => typeof tile === 'string' && tile !== '')
        : []
      const mjDoras = mjDorasRaw.length > 0
        ? mjDorasRaw
        : (isMahjong && asString(table.doraIndicator, '') !== ''
          ? [asString(table.doraIndicator, '')]
          : [])
      const mjPendingRaw = isMahjong
        ? asArray(table.pending).map((entry) => asObject(entry)).filter((entry) => entry !== null)
        : []
      const mjMyPending = mjPendingRaw.find((entry) => asString(entry.node, '') === myNode) || null
      const mjChiOptions = mjMyPending !== null
        ? asArray(mjMyPending.chiOptions).map((option) => {
          const optionRecord = asObject(option)
          const tiles = Array.isArray(option) ? option : asArray(optionRecord !== null ? optionRecord.tiles : [])
          return tiles.filter((tile) => typeof tile === 'string' && tile !== '')
        }).filter((tiles) => tiles.length === 2)
        : []
      const mjFuritenMap = isMahjong ? asObject(table.furiten) : null
      const mjMyFuriten = mjFuritenMap !== null && mjFuritenMap[myNode] === true
      const mjMustDiscard = isMahjong && table.mustDiscard === true
      const mjMeldsMap = isMahjong ? asObject(table.melds) : null
      const mahjongMeldsFor = (slot) => {
        const direct = asArray(slot.melds)
        if (direct.length > 0) return direct
        if (mjMeldsMap !== null) return asArray(mjMeldsMap[asString(slot.node, '')])
        return []
      }
      // Milestone ③: points / riichi / yaku settlement (PROTOCOL §7.22).
      // The host may flatten these onto the table view or keep them under
      // `winInfo`; both shapes are accepted.
      const mjWinInfo = isMahjong ? asObject(table.winInfo) : null
      const mjPick = (key, fallback) => {
        if (!isMahjong) return fallback
        if (table[key] !== undefined && table[key] !== null) return table[key]
        if (mjWinInfo !== null && mjWinInfo[key] !== undefined && mjWinInfo[key] !== null) return mjWinInfo[key]
        return fallback
      }
      const mjPoints = isMahjong ? asObject(mjPick('points', null)) : null
      const mjRiichiMap = isMahjong ? asObject(mjPick('riichi', null)) : null
      const mjRiichiSticks = isMahjong ? Math.max(0, asNumber(mjPick('riichiSticks', 0), 0)) : 0
      const mjAutoDiscard = isMahjong && mjPick('autoDiscard', false) === true
      const mjYaku = isMahjong ? asArray(mjPick('yaku', [])) : []
      const mjHan = isMahjong ? asNumber(mjPick('han', -1), -1) : -1
      const mjFu = isMahjong ? asNumber(mjPick('fu', -1), -1) : -1
      const mjScore = isMahjong ? asNumber(mjPick('score', -1), -1) : -1
      const mjDeltas = isMahjong ? asObject(mjPick('deltas', null)) : null
      const mjUraDoras = isMahjong
        ? asArray(mjPick('uraDoras', [])).filter((tile) => typeof tile === 'string' && tile !== '')
        : []
      const mjSticksAwarded = isMahjong
        ? Math.max(0, asNumber(mjPick('riichiSticksAwarded', mjRiichiSticks), mjRiichiSticks))
        : 0
      const mjDoraHan = isMahjong ? asNumber(mjPick('doraHan', -1), -1) : -1
      const mjAkaHan = isMahjong ? asNumber(mjPick('akaHan', -1), -1) : -1
      const mjUraHan = isMahjong ? asNumber(mjPick('uraHan', -1), -1) : -1
      // Milestone ④: seat winds / tenpai / match end.
      const mjSeatWindMap = isMahjong ? asObject(mjPick('seatWind', null)) : null
      const mjTenpaiMap = isMahjong ? asObject(mjPick('tenpai', null)) : null
      const mjMatchOver = isMahjong && mjPick('matchOver', false) === true
      const mjFinalPoints = isMahjong ? mjPick('finalPoints', []) : []
      const mjRoundLabel = isMahjong ? asString(mjPick('roundLabel', ''), '') : ''
      const mjDealerRepeat = isMahjong
        && (mjPick('dealerRepeat', false) === true
          || mjPick('renchan', false) === true
          || mjPick('repeated', false) === true
          || (Number.isInteger(mjPick('honba', 0)) && mjPick('honba', 0) > 0)
          || (Number.isInteger(mjPick('dealerRepeatCount', 0)) && mjPick('dealerRepeatCount', 0) > 0))
      const mahjongGame = isMahjong
        ? buildMahjongContent({
          game,
          role,
          isSpectator,
          phase,
          players,
          me,
          myNode,
          turnNode,
          turnNick,
          myHand: mjMyHand,
          round: Math.max(0, asNumber(table.round, 0)),
          dealerNode: asString(table.dealer, ''),
          wall: Math.max(0, asNumber(table.wall, 0)),
          nuki: Math.max(0, asNumber(table.nuki, 0)),
          doraIndicator: asString(table.doraIndicator, ''),
          doras: mjDoras,
          pendingEntry: mjMyPending,
          lastDiscard: mjLastDiscard,
          chiOptions: mjChiOptions,
          myFuriten: mjMyFuriten,
          mustDiscard: mjMustDiscard,
          meldsFor: mahjongMeldsFor,
          points: mjPoints,
          riichiMap: mjRiichiMap,
          riichiSticks: mjRiichiSticks,
          autoDiscard: mjAutoDiscard,
          yaku: mjYaku,
          han: mjHan,
          fu: mjFu,
          score: mjScore,
          deltas: mjDeltas,
          uraDoras: mjUraDoras,
          sticksAwarded: mjSticksAwarded,
          doraHan: mjDoraHan,
          akaHan: mjAkaHan,
          uraHan: mjUraHan,
          seatWindMap: mjSeatWindMap,
          tenpaiMap: mjTenpaiMap,
          matchOver: mjMatchOver,
          finalPoints: mjFinalPoints,
          roundLabel: mjRoundLabel,
          dealerRepeat: mjDealerRepeat,
          riichiCall,
          result: asString(table.result, ''),
          winnerNode: asString(table.winnerNode, asString(table.winner, '')),
          discardsFor: mahjongDiscardsFor,
          selectedIndexes,
          toggleCard,
          discardSelected,
          nukiTile,
          tsumoWin,
          ronCall,
          ponCall,
          kanCall,
          chiCall,
          passCall,
          ankanCall,
          kakanCall,
          busy,
          connectionBroken,
          turnRemainingMs,
          startRound,
        })
        : null

      let hint = ''
      if (isCardGame) {
        hint = cardGame.hint
      } else if (bettingGame !== null) {
        hint = bettingGame.hint
      } else if (texasGame !== null) {
        hint = texasGame.hint
      } else if (mahjongGame !== null) {
        hint = mahjongGame.hint
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
          ...(isCardGame
            ? cardGame.headExtras
            : (bettingGame !== null
              ? bettingGame.headExtras
              : (texasGame !== null
                ? texasGame.headExtras
                : (mahjongGame !== null ? mahjongGame.headExtras : [])))),
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
      } else if (bettingGame !== null) {
        for (const node of bettingGame.bodyNodes) bodyChildren.push(node)
      } else if (texasGame !== null) {
        for (const node of texasGame.bodyNodes) bodyChildren.push(node)
      } else if (mahjongGame !== null) {
        for (const node of mahjongGame.bodyNodes) bodyChildren.push(node)
      } else {
        bodyChildren.push(dealerBlock)
        for (const row of rows) bodyChildren.push(row)
        if (bjResultBanner !== null) bodyChildren.push(bjResultBanner)
      }
      const finalActions = isCardGame
        ? cardGame.actionNodes
        : (bettingGame !== null
          ? bettingGame.actionNodes
          : (texasGame !== null
            ? texasGame.actionNodes
            : (mahjongGame !== null ? mahjongGame.actionNodes : bjActionNodes)))
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
      '.dsh-card-lan-tabs{display:flex;flex-wrap:wrap;gap:6px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25));padding-bottom:2px}',
      '.dsh-card-lan-tab{font:inherit;font-size:12px;line-height:1.4;padding:6px 14px;',
      'border-radius:8px 8px 0 0;cursor:pointer;background:transparent;border:1px solid transparent;',
      'color:var(--dsw-alias-label-secondary,#94a3b8);transition:color .15s ease,background .15s ease}',
      '.dsh-card-lan-tab:hover{color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-card-lan-tab.is-active{background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.7));',
      'border-color:var(--dsw-alias-border-l1,rgba(148,163,184,.35));border-bottom-color:transparent;',
      'color:var(--dsw-alias-label-primary,#e2e8f0);font-weight:600}',
      '.dsh-card-lan-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      '.dsh-card-lan-tabpanel{display:flex;flex-direction:column;gap:16px}',
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
      '.dsh-card-lan-input-invite{flex:1 1 220px;min-width:0;font-variant-numeric:tabular-nums}',
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
      '.dsh-card-lan-row.is-winner{border-color:rgba(34,197,94,.55);',
      'box-shadow:inset 0 0 0 1px rgba(34,197,94,.3),0 0 14px rgba(34,197,94,.14)}',
      '.dsh-card-lan-tag.is-pot{background:rgba(16,185,129,.16);border-color:rgba(16,185,129,.4);color:#34d399}',
      '.dsh-card-lan-tag.is-raises{background:rgba(245,158,11,.14);color:#fbbf24}',
      '.dsh-card-lan-tag.is-seen{background:rgba(56,189,248,.16);color:#7dd3fc}',
      '.dsh-card-lan-tag.is-game-zhajinhua{background:rgba(251,113,133,.16);border-color:rgba(251,113,133,.4);color:#fb7185}',
      '.dsh-card-lan-pill.is-game-zhajinhua{background:rgba(251,113,133,.16);border-color:rgba(251,113,133,.45);color:#fb7185}',
      '.dsh-card-lan-zjh-me{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.55));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-card-lan-zjh-hand{gap:6px;padding:2px 0;min-height:44px}',
      '.dsh-card-lan-zjh-hands{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.35));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-zjh-handline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}',
      '.dsh-card-lan-zjh-handline.is-out{opacity:.55}',
      '.dsh-card-lan-zjh-handline.is-winner{color:#4ade80}',
      '.dsh-card-lan-zjh-handnick{min-width:56px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-card-lan-tag.is-game-texas{background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.4);color:#34d399}',
      '.dsh-card-lan-pill.is-game-texas{background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.45);color:#34d399}',
      '.dsh-card-lan-tag.is-tx-d{background:rgba(250,204,21,.18);color:#facc15;font-weight:700}',
      '.dsh-card-lan-tag.is-tx-sb{background:rgba(56,189,248,.16);color:#7dd3fc;font-weight:600}',
      '.dsh-card-lan-tag.is-tx-bb{background:rgba(251,146,60,.16);color:#fb923c;font-weight:600}',
      '.dsh-card-lan-tag.is-tx-allin{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.4);color:#f87171;font-weight:600}',
      '.dsh-card-lan-tx-seat.is-turn{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-card-lan-tx-community{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.45));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-tx-board{gap:6px;min-height:44px}',
      '.dsh-card-lan-tx-slot{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;',
      'min-width:29px;height:40px;padding:0 4px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'font-size:9px;color:var(--dsw-alias-label-secondary,#94a3b8);background:rgba(148,163,184,.06)}',
      '.dsh-card-lan-tx-me{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.55));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-card-lan-tx-hole{gap:8px;min-height:44px}',
      '.dsh-card-lan-tx-pots{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.35));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-tx-potline{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-tx-winners{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;',
      'background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.3)}',
      '.dsh-card-lan-tx-winner{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:#6ee7b7}',
      '.dsh-card-lan-tx-raise{display:flex;flex-direction:column;gap:6px;flex:1 1 100%;padding:8px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.5));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.3))}',
      '.dsh-card-lan-tx-range{width:100%;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}',
      '.dsh-card-lan-button.is-active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);',
      'background:rgba(77,107,254,.18);color:#c7d2fe}',
      '.dsh-card-lan-gd-tribute{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;',
      'background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.28)}',
      '.dsh-card-lan-gd-tributeline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 0;font-size:12px}',
      '.dsh-card-lan-gd-tributeline.is-my-pending{border-radius:6px;background:rgba(77,107,254,.14);padding:2px 6px}',
      '.dsh-card-lan-gd-tributenames{color:var(--dsw-alias-label-secondary,#94a3b8);min-width:96px}',
      '.dsh-card-lan-tag.is-tribute-gift{background:rgba(251,146,60,.16);color:#fb923c}',
      '.dsh-card-lan-tag.is-tribute-return{background:rgba(52,211,153,.14);color:#34d399}',
      '.dsh-card-lan-tag.is-tribute-pending{background:rgba(245,158,11,.14);color:#fbbf24}',
      '.dsh-card-lan-tag.is-tribute-skip{background:rgba(148,163,184,.16);color:#cbd5e1}',
      '.dsh-card-lan-ddz-card.is-disabled{opacity:.4;cursor:not-allowed;filter:grayscale(.5)}',
      '.dsh-card-lan-ddz-card.is-disabled:hover{transform:none}',
      '.dsh-card-lan-tag.is-zjh-235{background:rgba(250,204,21,.2);border-color:rgba(250,204,21,.45);',
      'color:#facc15;font-weight:700}',
      '.dsh-card-lan-tag.is-hand-label{background:rgba(148,163,184,.14);color:#cbd5e1}',
      '.dsh-card-lan-tag.is-game-mahjong4{background:rgba(45,212,191,.16);border-color:rgba(45,212,191,.4);color:#2dd4bf}',
      '.dsh-card-lan-tag.is-game-mahjong3{background:rgba(45,212,191,.16);border-color:rgba(45,212,191,.4);color:#2dd4bf}',
      '.dsh-card-lan-pill.is-game-mahjong4{background:rgba(45,212,191,.16);border-color:rgba(45,212,191,.45);color:#2dd4bf}',
      '.dsh-card-lan-pill.is-game-mahjong3{background:rgba(45,212,191,.16);border-color:rgba(45,212,191,.45);color:#2dd4bf}',
      '.dsh-card-lan-tag.is-mj-round{background:rgba(250,204,21,.14);color:#facc15}',
      '.dsh-card-lan-tag.is-mj-dora{background:rgba(251,146,60,.14);color:#fb923c}',
      '.dsh-card-lan-tag.is-mj-dealer{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.4);',
      'color:#f87171;font-weight:700}',
      '.dsh-card-lan-mj-tile{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;',
      'min-width:34px;height:46px;padding:0 4px;border-radius:6px;background:#f6f3ea;color:#1b1f27;',
      'font-size:16px;font-weight:700;line-height:1;border:2px solid transparent;',
      'box-shadow:0 2px 6px rgba(2,6,23,.35),inset 0 0 0 1px rgba(15,23,42,.10);user-select:none;-webkit-user-select:none;',
      'transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease}',
      '.dsh-card-lan-mj-tile.is-small{min-width:22px;height:28px;font-size:11px;padding:0 2px;cursor:default;border-width:1px}',
      '.dsh-card-lan-mj-tile.is-red{color:#cc2f26}',
      '.dsh-card-lan-mj-tile.is-green{color:#1f7a44}',
      '.dsh-card-lan-mj-tile[role="button"]:hover{transform:translateY(-3px)}',
      '.dsh-card-lan-mj-tile.is-selected{transform:translateY(-6px);border-color:var(--dsw-alias-brand-primary,#4d6bfe);',
      'box-shadow:0 4px 12px rgba(77,107,254,.35),inset 0 0 0 1px rgba(77,107,254,.4)}',
      '.dsh-card-lan-mj-hand-area{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.45));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-mj-hand{display:flex;flex-wrap:wrap;gap:4px;align-items:flex-end;padding:2px 0;min-height:50px}',
      '.dsh-card-lan-mj-river{display:flex;flex-wrap:wrap;gap:2px;align-items:center;min-height:30px}',
      '.dsh-card-lan-mj-riverlabel{font-size:10px;color:var(--dsw-alias-label-secondary,#94a3b8);margin-right:2px}',
      '.dsh-card-lan-mj-reveal{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.35));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-mj-revealline{display:flex;flex-wrap:wrap;gap:2px;align-items:center;font-size:12px}',
      '.dsh-card-lan-mj-revealline.is-winner{color:#4ade80}',
      '.dsh-card-lan-mj-tile.is-back{background:repeating-linear-gradient(135deg,#3b5b8f 0 4px,#27436f 4px 8px);',
      'color:transparent;box-shadow:0 2px 6px rgba(2,6,23,.35),inset 0 0 0 1px rgba(255,255,255,.18)}',
      '.dsh-card-lan-mj-call{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:8px;',
      'background:rgba(77,107,254,.12);border:1px solid rgba(77,107,254,.4)}',
      '.dsh-card-lan-mj-calltext{font-size:12px;font-weight:600;color:#c7d2fe}',
      '.dsh-card-lan-mj-melds{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.dsh-card-lan-mj-meld{display:inline-flex;align-items:center;gap:2px;padding:2px 4px;border-radius:6px;',
      'background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.2)}',
      '.dsh-card-lan-mj-meldlabel{font-size:10px;color:var(--dsw-alias-label-secondary,#94a3b8);margin-right:2px}',
      '.dsh-card-lan-tag.is-mj-furiten{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.45);',
      'color:#f87171;font-weight:600}',
      '.dsh-card-lan-mj-points{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 10px;border-radius:8px;',
      'background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.18)}',
      '.dsh-card-lan-mj-point{display:inline-flex;align-items:center;padding:0 7px;border-radius:999px;font-size:11px;',
      'line-height:1.8;background:rgba(148,163,184,.12);color:#cbd5e1;font-variant-numeric:tabular-nums}',
      '.dsh-card-lan-mj-point.is-self{background:rgba(77,107,254,.18);color:#c7d2fe}',
      '.dsh-card-lan-mj-point.is-dealer{border:1px solid rgba(239,68,68,.4)}',
      '.dsh-card-lan-tag.is-mj-pointtag{background:rgba(148,163,184,.12);color:#cbd5e1}',
      '.dsh-card-lan-tag.is-mj-riichi{background:rgba(250,204,21,.16);border-color:rgba(250,204,21,.4);',
      'color:#facc15;font-weight:600}',
      '.dsh-card-lan-tag.is-mj-stick{background:rgba(250,204,21,.14);color:#facc15}',
      '.dsh-card-lan-tag.is-mj-aka{background:rgba(239,68,68,.14);color:#f87171}',
      '.dsh-card-lan-mj-resultpanel{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;',
      'background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.28)}',
      '.dsh-card-lan-mj-resultline{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:#cbd5e1}',
      '.dsh-card-lan-mj-yaku{display:flex;flex-direction:column;gap:2px}',
      '.dsh-card-lan-mj-yakuline{font-size:11px;line-height:1.5;color:#cbd5e1}',
      '.dsh-card-lan-mj-deltas{display:flex;flex-direction:column;gap:2px;padding-top:4px;',
      'border-top:1px dashed rgba(148,163,184,.25)}',
      '.dsh-card-lan-mj-deltaline{font-size:11px;line-height:1.5;color:#cbd5e1;font-variant-numeric:tabular-nums}',
      '.dsh-card-lan-mj-deltaline.is-plus{color:#4ade80}',
      '.dsh-card-lan-mj-deltaline.is-minus{color:#f87171}',
      '.dsh-card-lan-tag.is-mj-wind{background:rgba(56,189,248,.14);border-color:rgba(56,189,248,.35);',
      'color:#7dd3fc;font-weight:700}',
      '.dsh-card-lan-tag.is-mj-repeat{background:rgba(251,146,60,.16);border-color:rgba(251,146,60,.4);',
      'color:#fb923c;font-weight:600}',
      '.dsh-card-lan-tag.is-mj-tenpai{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.4);color:#4ade80}',
      '.dsh-card-lan-mj-tenpais{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;',
      'background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.22)}',
      '.dsh-card-lan-mj-tenpairow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px}',
      '.dsh-card-lan-mj-tenpairow.is-tenpai{color:#86efac}',
      '.dsh-card-lan-mj-ranking{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;',
      'background:rgba(250,204,21,.08);border:1px solid rgba(250,204,21,.3)}',
      '.dsh-card-lan-mj-rankline{font-size:12px;line-height:1.6;color:#fde68a;font-variant-numeric:tabular-nums}',
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
      '.dsh-card-lan-tag.is-game-guandan{background:rgba(167,139,250,.16);border-color:rgba(167,139,250,.4);color:#c4b5fd}',
      '.dsh-card-lan-pill.is-game-guandan{background:rgba(167,139,250,.16);border-color:rgba(167,139,250,.45);color:#c4b5fd}',
      '.dsh-card-lan-tag.is-team-ours{background:rgba(34,197,94,.18);border-color:rgba(34,197,94,.42);color:#4ade80}',
      '.dsh-card-lan-tag.is-team-theirs{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.4);color:#f87171}',
      '.dsh-card-lan-tag.is-team-neutral{background:rgba(148,163,184,.14);color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-card-lan-tag.is-level{background:rgba(245,158,11,.16);border-color:rgba(245,158,11,.4);color:#fbbf24}',
      '.dsh-card-lan-tag.is-order{background:rgba(167,139,250,.14);color:#c4b5fd}',
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
      '.dsh-card-lan-ddz-hand.is-guandan{gap:3px;max-height:150px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}',
      '.dsh-card-lan-ddz-card{position:relative;min-width:24px;height:34px;padding:0 3px;font-size:12px;',
      'border:2px solid transparent;cursor:pointer;transition:transform .12s ease,border-color .12s ease}',
      '.dsh-card-lan-ddz-badge{position:absolute;top:-6px;right:-6px;display:inline-flex;align-items:center;',
      'justify-content:center;min-width:14px;height:14px;padding:0 2px;border-radius:999px;font-size:9px;line-height:1;',
      'background:rgba(239,68,68,.92);color:#fff;box-shadow:0 1px 3px rgba(2,6,23,.35)}',
      '.dsh-card-lan-ddz-orders{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.35));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.2))}',
      '.dsh-card-lan-ddz-order-line{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#94a3b8)}',
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
