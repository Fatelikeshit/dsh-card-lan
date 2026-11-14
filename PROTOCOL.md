# dsh-card-lan 开发契约（v1）

局域网 21 点牌桌插件。两个半边：**宿主半边** `lib/index.js`（跑在 DSH 的 Node 进程里，管 UDP 联机与权威牌局）和**浏览器半边** `client.js`（跑在 DSH 网页里，管大厅和牌桌 UI）。两边只通过本文件的 HTTP 契约和 `view` JSON 通信，不许互相 import。

## 0. 文件与职责边界

```
dsh-card-lan/
  package.json        （Lead 已写）
  cordis.patch.yml    （Lead 已写）
  lib/engine.js       （Lead 已写，纯规则引擎，已通过单测）
  lib/index.js        （宿主半边，由 host 负责人写）
  client.js           （浏览器半边，由 client 负责人写）
  test/               （Lead 写）
```

- 宿主半边只写 `lib/index.js`，浏览器半边只写 `client.js`。不要动别人的文件。
- 不新增任何 npm 依赖；不联网；不碰 `C:\Users\fu\.dsh`（安装由 Lead 做）。
- Node 18 兼容（本机 `node -v` 是 18.12）。`node --check <文件>` 必须通过。
- 全部中文文案；代码注释可中英混排。

## 1. 状态与身份

- `node`：每台机器一个稳定 id，`/^[A-Za-z0-9_-]{6,64}$/`，首次运行生成 UUID 并持久化。
- `nick`：昵称，1–24 字符，默认取 `os.hostname()`。
- `room`：房间名 1–32 字符，双方一致才能互相发现，默认 `dsh-card`。
- `port`：UDP 端口，默认 **41235**，范围 1024–65535。
- `enabled`：联机开关，默认 `true`。
- `passwordEnabled` / `password`：房主开桌时是否启用房间密码、密码内容（1–16 字符，开启时必填）。密码只存在本机配置，绝不进 hello/state 报文（hello 只广播布尔 `password`）。
- `spectatorEnabled`：房主是否允许观战，默认 `true`。
- `turnTimeout`：回合超时秒数（0–300，0 表示关闭），默认 `45`；超时由房主自动替当前玩家「停牌」。
- `overlaySize`：浮层大小 `small|medium|large`，默认 `medium`。
- `overlayX` / `overlayY`：浮层上次拖动位置（像素整数，`null` = 默认右下角）。
- `autoFade`：鼠标离开浮层时自动变淡，默认 `true`。
- 配置持久化到 `$DSH_HOME/dsh-card-lan.json`（`DSH_HOME` 缺省 `~/.dsh`）。`createCardLan({ home })` 的 `home` 可覆盖目录（测试用）。原子写：先写 `.tmp` 再 rename。

## 2. UDP 传输

所有数据报都是 UTF-8 JSON，`v: 1`。接收方丢弃 `v !== 1`、超大包、抛异常的包。

### 2.1 发现（广播，每 1500ms 一次，状态变化立刻补一次）

目标地址：每个非 internal IPv4 网卡的子网广播地址 + `255.255.255.255` + `127.0.0.1`，目标端口 = `config.port`（与 pet-lan 相同做法）。

```json
{
  "v": 1, "t": "hello", "room": "dsh-card", "node": "uuid-xxxx",
  "nick": "大肥鱼", "port": 41235,
  "table": { "open": true, "players": 2, "password": true, "watch": true, "spectators": 0 } | null,
  "sentAt": 1700000000000
}
```

- 接收方过滤：`message.room === config.room`、`message.node !== 自己`。
- 对端表 `peers`：key=node，记录 `{ node, nick, ip, port, table, lastSeen }`；`lastSeen` 超过 **6500ms** 删除。
- 只有房主（table 打开）的 `hello.table` 非 null，其他人发 `null`。
- `password`：房主是否启用了房间密码（只广播布尔值，不广播密码）。
- `watch`：房主是否允许观战；`spectators`：当前观战人数。

### 2.2 入座（客户端 → 房主，单播）

```json
{ "v":1, "t":"join", "room":"dsh-card", "to":"房主node", "from":"自己node", "nick":"大肥鱼",
  "pw":"密码或空串", "role":"player" | "spectator", "sentAt":1700000000000 }
```

- 房主校验：`to === 自己 node` 或 `to === ""`（手动 IP 入座时客户端还不知道房主 node，`to` 为空串）、`table.open`，然后按 `role` 分支（缺省 `player`）：
  - `player`：`passwordEnabled` 时 `pw` 必须等于 `password`；`players.length < 4`；`from` 不在玩家/观战表里。
  - `spectator`：`passwordEnabled` 时 `pw` 必须等于 `password`（观战也要密码）；`spectatorEnabled` 必须为 true；观战人数 < 6；`from` 不在玩家表里（已在观战表则幂等回 state）。
- 通过：把 `{node, nick, ip:来源地址, port:来源端口, role}` 加进玩家表或观战表，立刻向该来源单播一次 `state`（观战者收到 `table.role = "spectator"`、`players[i].self = false`）。
- 拒绝：向来源单播 `{"v":1,"t":"reject","to":from,"reason":"closed"|"full"|"password"|"watch-closed"|"watch-full"}`。

### 2.2b 离座（客户端 → 房主，单播）

```json
{ "v":1, "t":"leave", "room":"dsh-card", "to":"房主node", "from":"自己node", "sentAt":1700000000000 }
```

- 客人执行 `leave` 时，先向房主单播 `leave`（连发 3 次、间隔约 100ms，防丢），然后清空本地座位。
- 房主收到后：`to` 为空串或等于自己 node、`from` 在已入座表里 → 把该玩家从牌桌移除并立刻向剩余玩家单播 `state`；不在表里则忽略。
- 房主自己的 `leave` 等价于 `close`（本地处理，不发 `leave` 报文）。

### 2.3 动作（客户端 → 房主，单播）

```json
{
  "v":1, "t":"action", "room":"dsh-card", "to":"房主node", "from":"自己node",
  "aid":"随机12位", "action": { "type": "start" | "hit" | "stand" },
  "sentAt":1700000000000
}
```

- 房主去重：每个 `from` 最近 30 秒内应用过的 `aid` 集合，重复的直接忽略但仍回 `state`（幂等）。
- 房主只接受已入座玩家的动作；`start` 只有房主自己能发（本地调用，不走 UDP）。
- 应用后立刻向所有已入座玩家和观战者单播 `state`。

### 2.4 状态（房主 → 客户端，单播，变化即发 + 每 1000ms 心跳）

```json
{
  "v":1, "t":"state", "room":"dsh-card", "host":"房主node", "seq":17,
  "acks": ["aid1","aid2"],
  "table": { ...与 HTTP view.table 完全相同的对象... },
  "scores": { "node": {"win":1,"lose":0,"push":0} },
  "sentAt":1700000000000
}
```

- `acks`：最近 8 个已应用的 `aid`，客户端据此清掉待重传动作。
- 观战者与玩家收到同样形状的 `state`，只是 `table.role = "spectator"`、所有 `players[i].self = false`；房主心跳同样发给观战者。
- 客户端收到后刷新自己的 `table` 视图；超过 **4000ms** 没收到任何 state → `staleMs` 递增，UI 显示“房主失联”。
- 客户端 `action` 可靠传输：同一 `aid` 每 400ms 重发一次，最多 5 次；收到 `acks` 含该 `aid` 或动作被新 state 体现后停止。
- 客户端 `join` 每 1000ms 重发一次，最多 8 次，直到收到第一个 state。

### 2.5 房主对玩家的存活清理

- 房主每 1000ms 检查已入座玩家的 hello `lastSeen`；超过 **12000ms** 未见则从牌桌移除（若在局中则按 `leave` 处理），并发一次 state。
- 房主自己关闭牌桌（`close`）时清空玩家，不再广播 `table.open`。

### 2.5b 房主关桌通知（房主 → 客人，单播）

```json
{ "v":1, "t":"closed", "room":"dsh-card", "host":"房主node", "reason":"closed", "sentAt":1700000000000 }
```

- 房主 `closeTable` / 关闭联机 / 更换房间名或端口时，向所有玩家和观战者各单播一次 `closed`。
- 客人收到后清空本地座位与观战/玩家状态，`view.lastError = "host-closed"`，UI 提示「房主已关闭牌桌」并回大厅。

### 2.5c 客人自动重连

- 客人（player/spectator）在 `guestStaleMs > 5000` 且仍持有上次房主信息时，自动用记住的 `{hostNode, ip, port, pw, role}` 重发 `join`（每 1s，最多 5 次）；期间 `view.reconnecting = true`。
- 收到任意 `state` 即重连成功：`reconnecting = false`、`lastError` 清空、`staleMs` 归零。
- 5 次仍失败：`reconnecting = false`、`lastError = "reconnect-failed"`，停止自动重试；房主信息（node/ip/port/pw/role）留在进程内存里，用户可触发 `action {type:"rejoin"}` 再试一次。
- 房主信息（含密码）只存进程内存，不写盘；`leave`、收到 `closed`、手动 `join` 都会清空它。
- 房主关闭牌桌后客人不会重连（`closed` 已清空房主信息）。

## 3. HTTP API（只允许 127.0.0.1 回环访问）

每个路由 `ctx.webServer.register({ kind: 'exact', path, handler })`，`Cache-Control: no-store`，错误也要返回 JSON。

守卫与 dsh-pet-lan 相同：socket 远端是回环地址、Host 是回环主机名、`Origin`（若有）与 Host 同端口；不满足返回 403。

### 3.1 `GET /api/card-lan` → `view`

完整结构（**宿主和客户端都按这个结构消费**）：

```json
{
  "ok": true,
  "version": 1,
  "enabled": true,
  "config": {
    "enabled": true, "room": "dsh-card", "port": 41235, "overlayOpacity": 0.9,
    "passwordEnabled": false, "password": "", "spectatorEnabled": true,
    "overlaySize": "medium", "overlayX": null, "overlayY": null, "autoFade": true, "turnTimeout": 45,
    "nick": "大肥鱼", "nodeId": "uuid-xxxx"
  },
  "udpReady": true,
  "boundPort": 41235,
  "lastError": null,
  "reconnecting": false,
  "host": { "node": "自己uuid", "ip": "192.168.1.5", "port": 41235, "open": true },
  "peers": [
    {
      "node": "uuid-yyyy", "nick": "同事", "ip": "192.168.1.7",
      "port": 41235, "lastSeen": 1700000000000,
      "table": { "open": true, "players": 2, "password": false, "watch": true, "spectators": 0 }
    }
  ],
  "table": {
    "role": "host",
    "hostNode": "uuid-yyyy",
    "phase": "playing",
    "round": 2,
    "turn": "uuid-xxxx",
    "players": [
      {
        "node": "uuid-xxxx", "nick": "大肥鱼",
        "cards": ["AS", "5H"], "total": 16,
        "status": "playing", "result": null, "self": true
      }
    ],
    "dealer": { "cards": ["9S"], "hidden": true, "total": 9 },
    "log": ["第 2 局开始", "大肥鱼 要了一张牌"],
    "scores": { "uuid-xxxx": { "win": 1, "lose": 0, "push": 0 } },
    "staleMs": 0,
    "turnRemainingMs": 18000
  },
  "stats": { "sent": 0, "received": 0, "dropped": 0, "startedAt": 1700000000000 }
}
```

- `host.open === false` 时 `host` 仍给对象；未开桌给 `"host": null`。
- `table` 未入座为 `null`。`role`: `"host"`（本机开桌）、`"player"`（作为客人入座）或 `"spectator"`（观战）。
- `turn` 是待行动玩家 node 或 `null`。`dealer` 用 `engine.visibleDealer()`：`playing` 阶段只给第一张牌、`hidden:true`。
- `players[i].self` 标记本机玩家；`scores` 以 node 为 key，所有人都在（含 0）。
- `staleMs`：`role` 为 `player` / `spectator` 时有意义，为距最近一次收到 state 的毫秒数；`role === "host"` 恒 0。
- `reconnecting`：客人正在自动重连时为 `true`（UI 显示「重连中…」）；房主恒 `false`。
- `turnRemainingMs`：`phase === "playing"` 且 `turnTimeout > 0` 时为当前回合剩余毫秒数（state 心跳每秒刷新），否则 `null`。超时房主自动替当前玩家停牌。

### 3.2 `POST /api/card-lan/config`

请求体：`{ "enabled"?: boolean, "room"?: string, "port"?: number, "nick"?: string, "overlayOpacity"?: number,
  "passwordEnabled"?: boolean, "password"?: string, "spectatorEnabled"?: boolean,
  "overlaySize"?: "small"|"medium"|"large", "overlayX"?: number|null, "overlayY"?: number|null, "autoFade"?: boolean,
  "turnTimeout"?: number }`
返回：`{ "ok": true, "config": {...} }` 或 `{ "ok": false, "error": ... }`（新增 `invalid-turn-timeout`）
- `overlayOpacity`：牌桌浮层的整体不透明度，0.25–1，服务端 clamp 到两位小数；本机显示偏好，不影响联机对局。
- `password`：1–16 字符；`passwordEnabled: true` 而密码为空 → `invalid-password`。
- `overlaySize`：`small|medium|large` 三档；`overlayX/overlayY`：`null`（恢复默认右下角）或 -10000–10000 的整数，越界 clamp。
- `autoFade`：鼠标离开浮层时自动变淡的开关。
- `turnTimeout`：0–300 的整数秒；0 关闭，非整数/越界 → `invalid-turn-timeout`。
规则：
- 改 `room` 或 `port`：清空 peers、关闭牌桌、重新绑定 socket（`port` 变化时才重绑）；`enabled` 由 true→false 关闭 socket 并清空牌桌。
- 其他字段改动持久化即可。

### 3.3 `POST /api/card-lan/action`

请求体：
```json
{ "type": "open" | "close" | "join" | "leave" | "start" | "hit" | "stand" | "rejoin",
  "hostNode": "仅 join：从 peers 里选",
  "hostIp": "仅 join 手动入座", "hostPort": 41235,
  "pw": "仅 join：房间密码（无密码时省略）",
  "role": "仅 join：player | spectator（缺省 player）" }
```
返回 `{ "ok": true }` 或 `{ "ok": false, "error": "..." }`（错误字符串直接可展示：`udp-offline`、`table-closed`、`not-your-turn`、`not-playing`、`unknown-peer`、`no-players`、`not-host`、`already-seated`、`send-failed`、`no-target`）。`join` 被房主拒绝时通过 `view.lastError` 反馈：`join-password`、`join-watch-closed`、`join-watch-full`、`join-full`、`join-closed`。

语义：
- `open`：本机成为房主，牌桌 = `newTable([{node, nick}])`（`phase:"idle"`），广播 hello。
- `close`：房主关桌，清空玩家，广播 hello。
- `join`：向 `hostNode` 对应 peer（或 `hostIp:hostPort`）单播 `join`（带上可选 `pw` 与 `role`）；立即返回 ok，结果靠轮询。`role:"spectator"` 即观战。
- `rejoin`：用进程内存里记住的房主信息再次发起入座（自动重连失败后用户点「重新连接」用）；没有记忆 → `no-target`。
- `leave`：自己退出牌桌；房主退出等价于 `close`。
- `start`：房主开始/下一局（`phase` 为 `idle` 或 `result` 时），调 `engine.startRound`。
- `hit` / `stand`：房主本地直接 `engine.applyAction`；客人则发 UDP `action`（带 aid 重传）。
- 每次成功变更后房主广播 state；`view` 立即可见。

## 4. 宿主半边导出契约

```js
export const name = 'dsh-card-lan'
export const inject = ['webServer']
export function apply(ctx) { /* ctx.effect(...) 启动服务 + 注册路由 */ }
export function createCardLan(options = {}) {
  // options.home 覆盖 DSH_HOME（测试用）
  return {
    async start(),          // 载入配置、开 socket、起定时器
    dispose(),              // 清 socket 与定时器
    routes(),               // 路由数组
    view(),                 // 返回上面的 view 对象
    async setConfig(patch), // 返回 { ok, config?, error? }
    async action(body),     // 返回 { ok, error? }
  }
}
```

`apply` 内用 `ctx.effect(() => { void lan.start(); return () => lan.dispose() }, '...')` 和 `ctx.effect(() => { const ds = lan.routes().map(r => ctx.webServer.register(r)); return () => ds.forEach(d => d()) }, '...')`，与 pet-lan 一致。

## 5. 浏览器半边要求

单文件 classic script，顶层：

```js
window.__ModuleLoader__.load({
  id: 'dsh-card-lan',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
    // ...
    return { inject: ['slots'], apply(ctx) { ... } }
  },
})
```

- 注册两个插槽：
  - `settings.section`：`{ name:'settings.section', id:'card-lan', order:136, label: () => '牌桌联机' }` → 大厅页。
  - `shell.overlay`：`{ name:'shell.overlay', id:'card-lan-table', order:1002 }` → 牌桌浮层（只有 `view.table` 非空时渲染内容，否则返回 null）。
- 轮询 `GET /api/card-lan`，间隔 900ms；`useSyncExternalStore` 或 useState 都行，不能闪烁、不能每次重挂组件。
- 所有写操作 `POST /api/card-lan/action`、`/config`，失败时把 `error` 显示成中文提示（不要静默）。
- 样式：一个 `<style data-plugin-css="dsh-card-lan/style.css">` 注入一次；类名统一 `dsh-card-lan-` 前缀；颜色用 DSH 变量（如 `var(--dsw-alias-bg-layer-1, ...)`、`var(--dsw-alias-label-primary, ...)`），深浅色主题都不崩。
- 牌面：文字渲染（`♠♥♦♣`，红桃/方块用红色），不用图片/字体资源。
- 浮层：右下角固定面板，宽约 380px，可最小化成一个小胶囊；不能挡住输入区（可拖动更好，MVP 不强制）。

### 大厅页（settings.section）必须包含

1. 开关、房间名、UDP 端口、昵称（可编辑 + 保存）。
2. 状态行：UDP 是否监听、端口、发现几个对端、最近错误。
3. 按钮：`创建牌桌` / `关闭牌桌`（房主时）；`开始本局`（房主且 phase 为 idle/result）。
4. 发现的牌桌列表：每个 peer 若 `table.open` 显示 `昵称 · 2 人` + `加入` 按钮；未开桌的显示为“在线”。
5. 手动加入：`IP` + `端口` + `加入`（跨网段兜底）。
6. 当前状态说明：我是房主 / 我在某人的牌桌 / 未入座 / 我在观战。
7. 房间设置（房主）：「启用房间密码」勾选 + 密码输入（开启时必填 1–16 字符）、「允许观战」勾选、「回合超时」秒数输入（0–300，0 关闭，默认 45）；随「保存」一起 PATCH。
8. 发现的牌桌行：`table.password === true` 时给密码输入再「加入」；`table.watch === true` 时给「观战」按钮。
9. 手动加入：IP + 端口 + 可选密码 + 「加入」。
10. 浮层显示设置：大小三档（小/中/大）、「自动变淡」开关、「重置位置」按钮；不透明度滑杆保留。
11. 重连状态：`view.reconnecting === true` 时状态行显示「正在重连房主…」；`view.lastError === 'reconnect-failed'` 时显示「重连失败」+「重新连接」按钮（`action {type:'rejoin'}`）；`view.lastError === 'host-closed'` 时显示「房主已关闭牌桌」并回未入座状态。

### 牌桌浮层（shell.overlay）必须包含

1. 顶部：局数 `第 N 局`、阶段、房主昵称、`最小化`、`关闭/离开`。
2. 庄家区：牌面 + 点数（`hidden` 时显示一张盖牌）。
3. 每个玩家一行：昵称、牌面、点数、状态（要牌中/停牌/爆牌/黑杰克）、结算（赢/输/平）、`(我)` 标记、当前回合高亮。
4. 操作按钮：房主 `开始本局` / `下一局`；轮到我时 `要牌` / `停牌`；非我回合置灰。
5. 结算横幅：本局赢/输/平。
6. `staleMs > 4000` 显示“房主失联，等待重连…”。
7. 拖动标题栏移动浮层，松手把 `overlayX/overlayY` PATCH 回配置；**最小化后的胶囊同样可拖动**（`pointerdown` 后移动超过阈值才视为拖动，拖动结束的 click 不触发展开，纯点击仍展开）；三档大小用宽度变量生效；`autoFade` 开启时鼠标离开浮层整体变淡约 45%（不低于 0.25），移回恢复；快捷键 `Ctrl+Shift+H` 隐藏/显示浮层（隐藏时整个 overlay 不渲染）。
8. `role === "spectator"` 时：顶部显示「观战中」，不出现要牌/停牌/开始本局/下一局按钮，`self` 标记不出现。
9. 重连中（`view.reconnecting`）时顶部/提示区显示「正在重连房主…」；失联且重连失败时显示「重连失败」+「重新连接」按钮；`role` 仍按玩家/观战渲染。
10. 轮到我且 `table.turnRemainingMs` 存在时，提示「轮到你了 · 剩 {n} 秒（超时自动停牌）」，随 state 心跳刷新。
11. 浮层头部（`§3.2`）标题栏工具区有齿轮按钮「牌桌设置」：点开展开一个小面板，可当场调 **不透明度滑杆（25%–100%，拖动即时预览、停手 300ms 落盘）**、**浮层大小（小/中/大）**、**自动变淡开关**、**重置位置**；改动和 `POST /api/card-lan/config` 是同一份配置（大厅「牌桌联机」里同步可见），非本机字段不改。

## 6. 验收

- `node --check lib/index.js`、`node --check client.js` 通过。
- `node --test test/` 全绿（引擎单测 + Lead 的集成测试，集成测试直接调 `createCardLan`，不经过 HTTP）。
- 集成测试覆盖：hello 发现、手动入座、开局、要牌/停牌、房主推 state、动作重传去重、断线清理。
- 集成测试新增覆盖：密码开启后入座（密码对/错）、观战入座、`passwordEnabled`/`spectatorEnabled`/`overlaySize`/`overlayX`/`autoFade` 的配置 patch 与 clamp。
- 集成测试再新增：`turnTimeout` 配置与非法值、回合超时自动停牌并把回合推进到结算、房主 `close` 后客人收到 `closed`（`view.table` 清空 + `lastError === 'host-closed'`）。
- 不要自行安装插件或重启 DSH；那是 Lead 的事。

## 7. 多玩法（v4）

21 点保留，新增斗地主。玩法选择在「创建牌桌」时决定，牌桌携带 `game`，所有入座者跟随房主的玩法。

### 7.1 配置与开桌

- `config.game`：`"blackjack" | "doudizhu" | "paodekuai" | "guandan" | "zhajinhua" | "texas" | "mahjong4" | "mahjong3"`，默认 `"blackjack"`，表示下次「创建牌桌」的玩法（持久化）。
- `view.config.game` 暴露。
- `action { "type":"open", "game"?: ... }`：带 `game` 时先写回 `config.game` 再开桌；非法 → `{ok:false,error:"invalid-game"}`。不带则用 `config.game`。
- `hello.table` 增加 `game` 字段，发现列表按玩法显示（21 点 / 斗地主）。
- `view.table.game` 必填（两种玩法都带）；21 点的 table 结构不变。

### 7.2 通用动作透传

- UDP `action` 报文的 `action` 对象改为通用透传：`{ "type": string, ...payload }`；房主把 `type` 不属于宿主控制类（open/close/join/leave/start/rejoin）的动作交给当前玩法的引擎处理。
- HTTP `POST /api/card-lan/action` 同理：`{ "type": "bid"|"play"|"pass"|... , ...payload }`。
- 引擎校验失败的错误码原样返回（见 7.4）。

### 7.3 斗地主玩法

3 人、54 张（含大小王）。牌面编码沿用 21 点风格：`3S`…`10H`、`JS`/`QH`/`KD`/`AC`、`2S`…，大小王为 `BJ`（小王）、`RJ`（大王）。花色仅用于显示，大小顺序：`3<4<…<10<J<Q<K<A<2<BJ<RJ`。

`view.table`（`game === "doudizhu"`）：

```json
{
  "game": "doudizhu",
  "role": "host|player|spectator",
  "hostNode": "uuid",
  "phase": "idle|bidding|playing|result",
  "round": 3,
  "turn": "uuid|null",
  "landlord": "uuid|null",
  "myCards": ["3S", "3D", "BJ"],
  "players": [
    { "node": "uuid", "nick": "甲", "self": true, "count": 17,
      "status": "playing|out", "role": "landlord|farmer",
      "result": null, "bidding": true|false|null }
  ],
  "lastPlay": { "node": "uuid", "cards": ["AS","AH"], "label": "对 A" },
  "mustPlay": false,
  "log": ["..."],
  "scores": { "uuid": { "win": 1, "lose": 0 } },
  "staleMs": 0,
  "turnRemainingMs": 30000
}
```

- `myCards`：只有 `self` 玩家拿到自己的手牌；其他人/观战者为 `[]`（隐私要求：房主逐个下发）。
- `players[].count`：剩余张数；`bidding` 只在 `phase === "bidding"` 时有意义。
- `lastPlay`：最近一手有效出牌（新一墩时为 `null`）；`mustPlay` 表示当前回合玩家必须出牌（领出）。
- 观战者看全部牌面信息，但看不到任何人的手牌。

阶段与流程：
1. 发牌：每人 17 张，底牌 3 张。
2. `phase === "bidding"`：从 `(round-1) % 3` 号座位开始轮流 `bid`；第一次 `bid true` 的玩家成为地主并拿底牌，转 `playing`；三人都不叫 → 重新发牌（`round+1`），不结算。
3. `phase === "playing"`：地主先出；每回合可 `play`（出牌）或 `pass`（不要，仅当有 `lastPlay` 且不是自己刚出的牌时可用）。
4. 所有其他人都 pass 后，`lastPlay` 清空、出牌权回到最后出牌者（`mustPlay=true`）。
5. 有人出完 → `phase === "result"`：地主先出完 = 地主胜，任一农民先出完 = 农民胜；胜方每人 `win+1`，负方每人 `lose+1`。

牌型（第一版）：
- 单张、对子、三张、三带一（三张 + 任意单张）、三带二（三张 + 任意对子）；
- 单顺（≥5 张连续，不含 2/王）、双顺（≥3 对连续，不含 2/王）、飞机（≥2 组连续三张，**不带翅膀**，不含 2/王）；
- 炸弹（四张同点）、王炸（大小王）；
- 比较：同类型且同张数比主牌点数；炸弹压一切非炸弹；王炸最大；炸弹之间比点数。
- 不支持四带二、飞机带翅膀（返回 `bad-cards`）。

动作：
- `{ "type":"bid", "bid": true|false }`：仅 bidding 阶段、轮到该玩家。
- `{ "type":"play", "cards": ["3S","3D"] }`：仅 playing 阶段、轮到该玩家、必须压过 `lastPlay`（或领出）。
- `{ "type":"pass" }`：仅 playing 阶段、有 `lastPlay`、轮到该玩家。

错误码：`not-your-turn`、`bad-phase`、`bad-cards`（牌不在手里 / 牌型非法 / 压不过）、`must-play`（领出时不能过）。

超时（由房主 `turnTimeout` 驱动）：
- bidding 阶段 → 自动 `bid false`；
- playing 阶段 → `mustPlay` 时自动出最小的一张单牌，否则自动 `pass`。

掉线/离开：
- 地主离开 → 农民胜（直接结算）；农民离开 → 该玩家从本局移除（手牌弃掉），若场上只剩地主 → 地主胜；若某位农民已出完且无人可继续 → 按已产生的胜负结算。
- 不在局中（idle/result）离开只影响座位列表。

### 7.4 引擎模块契约

- 每个玩法一个纯逻辑模块：`lib/games/blackjack.js`（把现有 `lib/engine.js` 收进去或薄封装）与 `lib/games/doudizhu.js`。
- 宿主只按 `table.game` 分派：`startRound(state)`、`applyAction(state, node, action)`、`snapshot(state, viewerNode, meta)`、`onTimeout(state, node)`、`removePlayer(state, node)`。
- 引擎不碰 socket/HTTP/定时器，所有输入先由宿主校验来源（是已入座玩家、轮到它）。
- `lib/engine.js` 保留给 21 点（或移入 games 目录后由宿主 import），斗地主不得复用 21 点的计点逻辑。

### 7.6 跑得快（v5）

3 人、48 张：`3..A` × 4 花色（去掉 2 和大小王），每人 16 张；大小顺序 `3<4<…<10<J<Q<K<A`。

`view.table`（`game === "paodekuai"`）：

```json
{
  "game": "paodekuai",
  "role": "host|player|spectator",
  "hostNode": "uuid",
  "phase": "idle|playing|result",
  "round": 2,
  "turn": "uuid|null",
  "myCards": ["3S", "4D", "AS"],
  "players": [
    { "node": "uuid", "nick": "甲", "self": true, "count": 16, "status": "playing|out", "result": null }
  ],
  "lastPlay": { "node": "uuid", "cards": ["AS","AH"], "label": "对 A" },
  "mustPlay": false,
  "log": ["..."],
  "scores": { "uuid": { "win": 0, "lose": 0 } },
  "staleMs": 0,
  "turnRemainingMs": 30000
}
```

流程与规则：
- 发牌后 `phase="playing"`；**持有黑桃 3（`3S`）的玩家先出**（每局洗牌后按手牌判定）。
- 牌型：单、对、三张、三带二（三张 + 任意对子）、顺子（≥5 张连续，A 可作最大，不含 2/王——本版无 2/王）、连对（≥2 对连续）、飞机（≥2 组连续三张，**不带翅膀**）、炸弹（四张同点）；四带二、飞机带翅膀 → `bad-cards`。
- 比较：同型同张数比主牌点数；炸弹压一切非炸弹，炸弹之间比点数。
- **必须管上**：当前玩家能压过 `lastPlay` 时必须出牌；只有压不过时才允许 `pass`（否则返回 `must-play`）。领出（`lastPlay === null`）可出任意合法牌。
- 其余人压不过（全部 pass）后：`lastPlay` 清空、出牌权回到最后出牌者（`mustPlay=true`）。
- 先出完者胜（`win+1`），其余人 `lose+1`。
- 超时（房主 `turnTimeout`）：必须出 → 自动出「能压过的最小合法牌」，压不过则自动 `pass`；领出 → 自动出最小单张。
- 掉线/离开：局中离开者手牌弃掉并移除；若只剩 1 人 → 其直接胜；idle/result 只移座位。

动作：`{ "type":"play", "cards":[...] }` / `{ "type":"pass" }`；错误码 `not-your-turn`、`bad-phase`、`bad-cards`、`must-play`。

界面照斗地主牌桌复用（无叫地主/地主农民）：顶部局数、阶段、回合倒计时；其他玩家昵称、剩余张数、已出完、回合高亮；中间 `lastPlay` 与「轮到你领出」；我的手牌可点选，`出牌` / `不要`（`mustPlay` 时禁用；能管必须管的错误用中文提示）；结算横幅「你赢了/你输了」；观战无手牌无按钮。

### 7.7 浏览器半边（多玩法续）

- 大厅「创建牌桌」旁加玩法选择：`21 点` / `斗地主` / `跑得快` / `掼蛋`（默认取 `view.config.game`），点创建时 `action {type:"open", game}`；发现列表显示玩法标签。
- `view.table.game === "doudizhu"` 时渲染斗地主牌桌（不能用 21 点 UI）：
  - 顶部：局数、阶段（叫地主中 / 出牌中 / 本局结束）、地主标记、回合倒计时；
  - 其他人：昵称、地主/农民标记、剩余张数、当前回合高亮、已出完；
  - 中间：`lastPlay` 展示（谁出了什么牌 / 新一墩），`mustPlay` 时提示「轮到你领出」；
  - 我的区域：手牌横排（点击选中/取消，选中上浮高亮），按钮：`叫地主`/`不叫`（bidding 且轮到我）、`出牌`/`不要`（playing 且轮到我；不合法时置灰或提示）、房主 `开始下一局`（result）；
  - 结算横幅：地主胜/农民胜 + 我的输赢；观战者看牌局但不显示手牌、无操作按钮。
- 21 点 UI 保留原样；`view.table.game` 缺省按 `"blackjack"` 处理。
- 样式与类名沿用 `dsh-card-lan-` 前缀，牌面仍是文字渲染。

### 7.8 人机补位（v6）

- `config.botCount`：整数 `0..2`，默认 `0`（不补），表示**最多补几个机器人**（`autoFillBots=false` 时实际补位 = `min(botCount, minPlayers - 已入座真人数)`）；`view.config` 暴露，另派生 `view.config.fillBots = botCount > 0` 兼容旧客户端。`POST /api/card-lan/config` 接受 `{botCount:0|1|2}`，非整数/越界 → `invalid-botcount`；兼容接受旧字段 `{fillBots:boolean}`（true→2 / false→0）与非法值 → `invalid-fillbots`。
- `config.autoFillBots`：布尔，**自动补齐**开关（默认 `false`；迁移规则：旧配置缺省且 `botCount===2` → `true`，旧 `fillBots:true` → botCount 2 且 `true`）。开启时忽略 `botCount`，直接补到 `minPlayers`（需要多少补多少，即「人数不足就补满」）；关闭时按 `botCount` 上限补。`view.config` 暴露；`POST` 非布尔 → `invalid-autofillbots`。
- 作用范围：`game` 为 `doudizhu` / `paodekuai` 的牌局。房主开启补位（`botCount > 0`）后：**开桌即按已入座真人补足 `min(botCount, 3 - 真人数)` 个机器人**（未开局时桌上就显示）；`idle/result` 阶段后加入的真人会**顶掉一个机器人**，不会因机器人占座被 `full` 拒绝；`playing/bidding/dealer` 阶段仍拒绝入座。机器人 node 形如 `bot-1`/`bot-2`，昵称「机器人·小A」「机器人·小B」，`players[].bot=true`（其余字段同普通玩家；手牌仍按查看者隐私，非本人不可见）。
- 机器人只存在于房主牌局内：不广播 hello、不参与发现/TTL 清理、不接受网络 action；房主关闭补位（`botCount=0`，且处于 idle/result）或 `关闭牌桌` 时清除机器人；`开始下一局` 时按当前真人数与 `botCount` 重新补空位。
- 人数不足：真人 + 机器人 < `minPlayers` 时开局，引擎返回 `no-players`，UI 映射为「人数不足：斗地主/跑得快需要 3 人」。
- 机器人行动：轮到机器人后 600–1000ms 自动动作（宿主驱动，引擎提供决策）：
  - 斗地主：`bidding` 按手牌强度 `bid true/false`（保证不会连续三人不叫导致无限重发）；`playing` 领出最小合法牌，跟牌优先最小能压过的同型牌、必要时炸弹，压不过 `pass`；
  - 跑得快：领出最小单张；跟牌出「能压过的最小合法牌」并遵守 must-play，压不过才 `pass`；
  - 机器人不占用人类回合的超时计时（`turnTimeout` 只作用于人类）。
- `view.table.players[].bot`：布尔，缺省 `false`，供 UI 标注。
- 21 点忽略 `fillBots`。

### 7.9 人机 UI

- 大厅在「观战/密码」附近加 checkbox「人机补位（斗地主/跑得快）」，默认取 `view.config.fillBots`，改动 PATCH 配置。
- 牌桌里 `bot === true` 的玩家昵称旁显示「🤖 机器人」标记；其手牌仍只显示剩余张数，不显示牌面；其余交互不变。

### 7.10 邀请复制/粘贴（v6.4）

纯客户端功能，不新增宿主字段或接口；大厅网络设置（房间名 / UDP 端口）下方加「邀请」块：

- **「复制房间名+端口」**：生成 `DSH-CARD-LAN|<room>|<port>` 写入剪贴板（`navigator.clipboard.writeText`，不可用时回退临时 `textarea` + `document.execCommand('copy')`）；成功 notice 显示复制内容，失败提示手动复制。
- **粘贴框 + 「填入」**：接受 `DSH-CARD-LAN|room|port`，也容忍 `房间名 端口`、`房间名,端口`、`房间名；端口` 等写法；解析成功把 room/port 填进表单（端口同时同步到手动加入框），并**直接 `POST /api/card-lan/config {room,port}` 应用保存**（不要求用户再切「设置」页签点保存）；保存成功 notice「已应用邀请：房间「{room}」、端口 {port}（已保存）」；保存失败（如 invalid-room / invalid-port / 端口占用）显示错误且表单保留刚填入的值，方便去「设置」修正；解析失败给出格式要求（端口 1024–65535，房间名 1–32 字符）。

### 7.11 大厅页签（v6.5）

大厅「牌桌联机」section 改为两个页签（默认「房间」）：

- **「房间」页签**：联机开关、联机状态行、创建/开始/关闭牌桌 + 我的身份、**邀请朋友（复制/粘贴邀请码）**、发现列表、手动 IP+端口加入；
- **「设置」页签**：房间名 / UDP 端口 / 昵称 +「保存/刷新」、房间设置（密码、观战、机器人数量、自动补齐、回合超时）、浮层显示设置（透明度/大小/自动变淡/重置位置/隐藏浮层）；
- 页签切换不清空表单草稿；notice 在两个页签都可见；其余交互与接口不变。

### 7.12 掼蛋（v7.0）

4 人、两副牌 108 张（含大小王各 2），每人 27 张；座位 0/2 一队、1/3 一队（对家）。

- **级牌**：初始 2；当前局级牌 = `table.level`（上一局头游队伍的级牌，首局 2）。`table.teamLevels` = `["rank","rank"]` 记录两队升级进度（2..A）。
- **逢人配**：红桃级牌是万能牌，可替代任意非王牌组成牌型；单出/对子等按级牌本身算。手牌里的红桃级牌照常下发（客户端可标「配」）。
- **牌大小**：`2<3<…<10<J<Q<K<A<级牌<小王<大王`；花色不区分大小（同花顺除外）。
- **牌型**：单、对、三、三带二（三张+对子）、顺子（5 张连续，A 可作 1 组成 A2345）、连对（3 连对）、钢板（2 组连续三张）、炸弹（4 张及以上同点）、同花顺（5 张同花色顺子）、四大天王（2 大王+2 小王）。同型同张数比主牌；炸弹类压非炸弹：4炸<5炸<同花顺<6炸<7炸<8炸<四大天王（同花顺之间比点数；四大天王最大）。
- **流程**：第一局由座位 0 先出（或按约定），之后每局由上一局头游先出。有人先出完成为**头游**，其余三家继续打，按出完顺序得二游/三游/末游。
- **升级**：头游+二游同队（双上）+3；头游+三游 +2；头游+末游 +1；另一队不升。达到 A 后需「过 A」：该队打 A 的这局若再拿头游（且满足升级）即赢得整场，否则停在 A。
- 动作：`play`/`pass`；v7.0 不含进贡/还贡，**v10.0 起加入**（见下）。
- **进贡/还贡（v10.0）**：每局开始（首局除外）进入 `phase="tribute"`：
  - 依据上局名次：双下（头游+二游同队）→ 末游贡头游、三游贡二游；其余情况末游贡头游；
  - 进贡牌自动：进贡方手里最大的普通牌（红桃级牌/逢人配不参与进贡）；若进贡方手里有 **2 张大王** → 抗贡，该路免除并记日志；
  - 还贡：收贡方从手牌选 1 张 **点数 ≤10** 的牌（含红桃级牌）还给进贡方，动作 `{ "type":"tribute-return", "card":"3S" }`；双方交换后该路完成；
  - 全部完成后 `phase="playing"`，先手：有实际进贡时为**进贡方**（双贡时为末游），全部抗贡时为头游；
  - `view.table` 增加 `tribute: [{from,to,card,gift,returned,skipped}]` 与 `pendingReturn: node|null`；`myCards` 随交换更新。
- 错误码：`not-your-turn`、`bad-phase`、`bad-cards`、`must-play`。
- 超时：领出最小单张；跟牌出能压过的最小合法牌，压不过 `pass`。
- 机器人：v7.0 不补（`fillBots` 仍只对斗地主/跑得快生效）。

### 7.13 掼蛋 UI（v7.0）

- 大厅玩法选择增加「掼蛋」，发现列表显示玩法标签。
- 牌桌 4 座：显示昵称、队伍标记（我方/对方）、剩余张数、当前回合高亮、出完顺序/结果；顶部显示当前级牌与双方级数（如「打 2 · 我方 2 / 对方 2」）。
- 我的手牌 27 张：可点选（多行/换行排列），红桃级牌带「配」标记；出牌/不要；领出提示；结算横幅「本局 +N 级」或「过 A，胜利」。
- 浮层宽度需比 3 人玩法更宽（可用 large 或按 27 张自适应换行）。

### 7.14 炸金花（v8.0）

2–6 人、1 副 52 张，每人 3 张暗牌；无机器人补位。

- **筹码**：起始 1000/人（首次坐下或不足时自动补到 1000），每局底注 10；底池 `pot`。宿主记账，局间筹码延续。
- **牌型与大小**：豹子（三张同点）> 顺金（同花顺）> 金花（同花）> 顺子（含 A23，A23 最小、AKQ 最大）> 对子 > 单张；同型比点数（对子先比对子再比单张，单张按 A>K>…>2）。
- **235 吃豹子（v10.0 起启用）**：三张为 2、3、5 且**花色各不相同**时视为特殊 235，**赢任何豹子**；对其它牌型仍按普通单张（最小）比较；235 对 235 平局（比牌时发起方输）。
- **流程**：每人先交底注进底池；从座位 0（首局）/上局赢家（后续）开始轮流行动。行动：
  - `look` 看牌：把自己 3 张牌变为可见；不消耗行动（仍在自己的回合，可看完再跟/加/弃/比）；
  - `call` 跟注：已看牌付 `currentBet`，未看牌（闷牌）付 `ceil(currentBet/2)`；
  - `raise` 加注：仅已看牌可加；加注后 `currentBet += 10`，本局加注次数 +1（上限 5 次，超过 → `raise-cap`）；
  - `fold` 弃牌：出局（手牌作废）；
  - `compare` 比牌：**仅当场上只剩 2 名未弃牌玩家**时可发起；付跟注额，双方亮牌比较，输者出局、平局发起方输；剩 1 人即结算。
- **强制摊牌**：所有人各行动一轮计 1 轮；打满 **3 轮** 仍未结束 → 剩余玩家全部摊牌比较，最大者赢。
- **结算**：只剩 1 人或摊牌后，赢家拿走 `pot`；`phase="result"`，显示所有人手牌与赢家。下局重新发牌、重新交底注；筹码不足 10 自动补到 1000。
- **超时**：轮到谁超时自动 `fold`。
- 动作错误码：`not-your-turn`、`bad-phase`、`bad-action`（未知动作）、`no-chips`（筹码不足）、`compare-unavailable`（不止 2 人）、`raise-cap`（加注次数用尽）。
- `view.table`：`game/role/hostNode/phase(idle|bidding|result)/round/turn/pot/currentBet/raises/myCards(仅自己看牌后或 result)/players(node,nick,self,chips,bet,status(active|folded|out),seen,result)/log/scores/staleMs/turnRemainingMs`；`result` 时带 `winnerNode`。

### 7.15 炸金花 UI（v8.0）

- 大厅玩法选择增加「炸金花」；发现列表显示标签。
- 牌桌：顶部「炸金花 · 第 N 局」、阶段、底池 `pot`、当前注 `currentBet`、加注次数/上限、回合倒计时；
- 玩家行：昵称、筹码、本局投入、状态（已看牌/闷牌/弃牌/赢）、当前回合高亮；
- 我的区域：3 张牌（未看牌显示背面，`看牌` 后翻开）、筹码/本局投入、按钮 `看牌`（未看）/`跟注 {amount}`/`加注`/`弃牌`（只剩 2 人时）`比牌`；
- 结算：「你赢了 +{pot}」/「你输了」，显示所有人手牌；房主「开始下一局」；
- 观战者不显示任何人的暗牌（result 时可见全部），无操作按钮。

### 7.16 德州扑克（v9.0）

2–6 人、1 副 52 张；每人 2 张底牌 + 5 张公共牌；无机器人补位。

- **筹码**：起始 1000；小盲 10、大盲 20；每局开始筹码 < 20 自动补到 1000；局间筹码延续。
- **按钮/盲注**：按钮（dealer）首局座位 0，之后每局按座位 +1。2 人时按钮=小盲、对家=大盲；3+ 人时按钮下一位小盲、再下一位大盲。翻前由大盲后一位先行动（2 人时为按钮/小盲）。
- **下注轮**：preflop → flop(3 张) → turn(1) → river(1)。每街从 dealer 下一位（翻前大盲后一位）按座位轮转行动，只由未弃牌且未 all-in 的玩家行动；已 all-in 不再行动。
- **动作**：`fold` / `check`（本街投入已等于 currentBet 时合法）/ `call`（补到 currentBet；筹码不足自动 all-in）/ `raise`（**v10.0 起带 `amount`，表示目标本街总投入**；最小加注 = `currentBet + max(大盲20, 上次加注增量)`，不满足 → `bad-raise`；`amount` 超过自身剩余筹码则自动 all-in；不传 `amount` 时按最小加注处理，兼容旧客户端）。
- **街推进**：所有 active 玩家本街投入相等（或已 all-in）→ 发下一街，`currentBet=0`；只剩 1 人未弃牌 → 立即结算。
- **摊牌**：按每人本局 `committed` 总额构建边池（不同 committed 值分层）；每层池由「未弃牌且 committed ≥ 该层」的玩家争夺，7 选 5 最大者赢该池，平局均分（余数给座位靠前者）。牌型：同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌；A 可作 1 组成 A2345。
- **超时**：能 check 则自动 check，否则 fold。
- 错误码：`not-your-turn`、`bad-phase`、`bad-action`、`bad-raise`（不满足最小加注/无筹码）。
- `view.table`：`game/role/hostNode/phase(idle|preflop|flop|turn|river|result)/round/dealer/turn/pot/currentBet/community/myCards/players(node,nick,self,chips,bet,committed,status(active|folded|allin),result,lastAction)/log/scores/staleMs/turnRemainingMs`；`result` 时带 `board`、`winnerNodes`、`pots`（各池金额与赢家）、`players[].cards`。

### 7.17 德州扑克 UI（v9.0）

- 大厅玩法选择增加「德州扑克」；发现列表显示标签。
- 牌桌：顶部「德州扑克 · 第 N 局」/阶段（翻前/翻牌/转牌/河牌/本局结束）、底池、当前注、盲注 10/20、回合倒计时；
- 玩家行：昵称、筹码、本街投入、按钮「D/SB/BB」标记、状态（行动中/弃牌/全下）、当前回合高亮；
- 中间：5 张公共牌（未发显示空位），已发出的翻开；
- 我的区域：2 张底牌（自己始终可见）、筹码/本局投入、动作按钮 `弃牌`/`过牌`/`跟注 {N}`/`加注到 {N}`（筹码不足时 `全下 {N}`）；
- 结算：「你赢了 +{N}」/「你输了」，展示公共牌与赢家手牌；房主「开始下一局」；
- 观战：看不到任何人底牌（result 时才公开），无操作按钮。

### 7.18 日麻（v11.0，里程碑①：牌墙/配牌/摸打/和了框架）

玩法 id：`mahjong4`（4 人）/ `mahjong3`（3 人），大厅显示「日麻·四人」「日麻·三人」；无机器人。

- **牌组**：4 人 136 张（1–9m/p/s 各 4 + 东南西北白发中各 4）；3 人 108 张（去掉 2m–8m，保留 1m/9m；东南西三家）。
- **赤宝**：4 人红 5m/5p/5s 各 1；3 人红 5p/5s 各 1（替换对应普通 5）。牌编码：`1m`…`9s`、`E/S/W/N/P/F/C`（东南西北白发中）、红 5 为 `5mr/5pr/5sr`。
- **配牌**：庄家 14 张、其余 13；首局庄家座位 0，之后按座位轮转（连庄逻辑留给里程碑④）。
- **宝牌指示**：王牌翻 1 张，M1 只展示；**拔北（3 人）**：自己回合内若手牌有 `N`，可动作 `{type:'nuki', tile:'N'}`：移出该北、拔北计数 +1（每张算 1 宝牌）、从王牌补摸 1 张，仍由本人行动（可连续拔）；4 人无拔北。
- **行动**：`{type:'discard', tile}` 打出一张；`{type:'tsumo'}` 自摸和了（M1 只判基本和了型：4 面子+雀头 / 七对子 / 国士无双；**暂不计役/符/点数**，结算显示「和了（里程碑①）」）；`{type:'nuki'}`（仅 3 人）。
- **流局**：活牌墙摸完且无人和了 → `phase='result'`、`result='exhausted'`。
- **阶段**：`idle|playing|result`；`turn`=当前行动者；`dealer`；`wall`（剩余活牌数）；`doraIndicator`；`nuki`；`discards`（按玩家数组）；手牌隐私：`myHand` 只给自己，观战/他人 `[]`，`result` 公开全部手牌。
- 错误码：`not-your-turn`、`bad-phase`、`bad-action`、`bad-tile`、`not-winning`。
- **后续里程碑**：② 吃/碰/杠+副露；③ 全役种+符点+立直/宝牌/里宝；④ 流局罚符/连庄/场风/3 人差异/机器人。

### 7.19 日麻 UI（v11.0）

- 大厅玩法选择增加「日麻·四人」「日麻·三人」；发现列表显示标签；
- **专用日麻大窗**（overlay 内加宽模式，约 720–760px）：顶部场风/局数（东风 N 局）、宝牌指示牌、剩余牌数、拔北数（3 人）、回合倒计时；
- 其他家：昵称、门前/手牌数、牌河（按顺序横排）、当前回合高亮；
- 我的区域：13/14 张手牌文字牌（可点选），按钮 `打出`（未选牌禁用）/`拔北`（仅 3 人且手牌有北）/`自摸和了`（仅当服务端判定可和？M1 由客户端展示、服务端校验）；
- 结算：「和了（里程碑①）」/「流局」，公开所有人手牌；房主「开始下一局」；
- 观战：看不到任何人手牌（result 公开），无操作按钮。

## 8. 验收补充（v4）

- `node --check` 两个半边通过。
- `node --test test/` 全绿：既有 21 点/密码/观战/超时/重连用例不回归；新增斗地主引擎单测（牌型识别与比较、叫地主流程、出牌/过牌、结算、超时动作、地主离开）。
- 集成测试覆盖：`open {game:"doudizhu"}` 后 `view.table.game` 正确、3 人入座、叫地主→出牌→结算全流程（可用引擎直调或双实例）。
- 不新增依赖、不装插件、不重启 DSH。
- v6 人机补位：`config.fillBots` 缺省 false、非法值 `invalid-fillbots`；`true` 时斗地主/跑得快开局补到 3 人（`bot-1/bot-2`、`players[].bot`），机器人自动叫地主/出牌直到 result，关桌清理，21 点忽略；引擎 `botAction` 单测各跑完整局。
