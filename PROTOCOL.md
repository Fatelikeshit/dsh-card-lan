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
7. 拖动标题栏移动浮层，松手把 `overlayX/overlayY` PATCH 回配置；三档大小用宽度变量生效；`autoFade` 开启时鼠标离开浮层整体变淡约 45%（不低于 0.25），移回恢复；快捷键 `Ctrl+Shift+H` 隐藏/显示浮层（隐藏时整个 overlay 不渲染）。
8. `role === "spectator"` 时：顶部显示「观战中」，不出现要牌/停牌/开始本局/下一局按钮，`self` 标记不出现。
9. 重连中（`view.reconnecting`）时顶部/提示区显示「正在重连房主…」；失联且重连失败时显示「重连失败」+「重新连接」按钮；`role` 仍按玩家/观战渲染。
10. 轮到我且 `table.turnRemainingMs` 存在时，提示「轮到你了 · 剩 {n} 秒（超时自动停牌）」，随 state 心跳刷新。

## 6. 验收

- `node --check lib/index.js`、`node --check client.js` 通过。
- `node --test test/` 全绿（引擎单测 + Lead 的集成测试，集成测试直接调 `createCardLan`，不经过 HTTP）。
- 集成测试覆盖：hello 发现、手动入座、开局、要牌/停牌、房主推 state、动作重传去重、断线清理。
- 集成测试新增覆盖：密码开启后入座（密码对/错）、观战入座、`passwordEnabled`/`spectatorEnabled`/`overlaySize`/`overlayX`/`autoFade` 的配置 patch 与 clamp。
- 集成测试再新增：`turnTimeout` 配置与非法值、回合超时自动停牌并把回合推进到结算、房主 `close` 后客人收到 `closed`（`view.table` 清空 + `lastError === 'host-closed'`）。
- 不要自行安装插件或重启 DSH；那是 Lead 的事。
