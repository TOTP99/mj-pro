# 联机协议 v2（PeerJS，房主权威）

## 角色与信任模型
- **房主**跑完整引擎，是唯一的裁判；**客人**是只读镜像 + 意图上报。
- 房主**不信任**任何客人输入：每条消息先过结构校验（`Game.netValidIntent`）、限流（5 秒 60 条）、语义校验（必须对应一个当前有效的 offer/prompt id 且座位匹配）。畸形/刷屏累计 10 次即踢。
- 客人永远只收到**自己的暗牌**；一局结束时才下发所有人手牌用于结算摊牌（`snap.allHands`）。
- 座位表对外脱敏，**重连令牌 token 只在 welcome 里发给本人**。
- 房间码 6 位（去掉 I/O/0/1），`crypto.getRandomValues` 生成。

## 握手
`hello {v:2, name, token?, resume?}` → `welcome {v, seat, seats, code, token, resumed, started}` 或 `deny {text, fatal}`。版本不一致直接拒绝（fatal）。名字在两端都做净化（去控制字符/尖括号，≤12 字）。

## 对局消息
| 方向 | 消息 | 说明 |
|---|---|---|
| 房主→客人 | `state {snap}` | 快照，带递增 `seq`，客人丢弃过期快照 |
| 房主→客人 | `prompt {id, kind, ms, …}` | 出牌/吃碰杠/亮牌要约，`ms` = 倒计时 |
| 客人→房主 | `intent {id, kind, …}` | 回应 prompt |
| 房主→客人 | `result` / `seats` / `toast` / `auto` / `kicked` / `hostbye` | |
| 双向 | `ping {ts}` / `pong {ts}` | 心跳 + RTT |
| 客人→房主 | `ready {epoch}` | 已看完结算（房主开下一局的门闩，最多等 `netTimeouts.ready`） |
| 客人→房主 | `resume` | 取消托管 |

## 掉线与重连
- 意外掉线（心跳 `dead` 超时 / 连接关闭）：座位**保留令牌 `reserve`（默认 90 秒）**，期间 AI 暂代，座位表显示"离线"。
- 客人侧：连接关闭或 `hostSilent` 内收不到房主任何消息 → 自动重连（`hello {token, resume:true}`，每 2.5 秒一次），成功后回原座位，房主立即同步快照；旧连接未超时则被令牌顶替。
- 主动离开（`bye`）/ 被请出（`kicked`）不保留座位。
- 房主端 PeerJS 信令断线自动 `reconnect()`。

## 挂机托管
真人连续 2 次回应超时 → 自动**托管**（AI 代打，不再等待，不拖慢全桌）；本人点屏幕上的"恢复"即可回来。

## 可调参数 `Game.netTimeouts`
`turn 45s / claim 15s / reveal 15s / hello 14s / ping 10s / dead 55s / hostSilent 32s / reserve 90s / ready 10s / open 15s`（以 `js/23-net.js` 的 `NET_CONFIG` 为准）

## 网络穿透
默认 3 个公共 STUN。对称 NAT（部分手机网络）需要 TURN：
`localStorage.qj_mj_net_ice = '[{"urls":"turn:your.host:3478","username":"u","credential":"p"}]'`
自建信令：`Game.netPeerConfig = {host, port, path, secure}`。
**生产部署**：改站点根的 `net-config.js`（`peer` / `ice`），完整步骤见 `deploy/README-DEPLOY.md`。优先级：`Game.netPeerConfig` > `net-config.js` > 默认。

## 诊断
点屏幕上的联机状态条复制诊断信息（近 120 条事件、座位、RTT，不含手牌），反馈问题时附上。

## v4.5.4 加固
- **重复建房/加入**：已在房间中再建房或加入会被拒绝（`你已在联机房间中`），避免旧连接泄漏、客人变幽灵；状态条点按可随时回到房间面板（含踢人、锁房、复制诊断）。
- **断线重连补发要约**：重连成功后，房主若正在等该座位，会把当前要约（`prompt`，带剩余时间）重发一次，不必干等超时。
- **吃碰杠超时不计挂机**：`claim` 要约超时按"过"处理，不再累计托管次数。
- **锁房**：房主可锁房，锁房后新玩家被拒，令牌重连不受影响。
- **消息体积**：客人→房主上限 4KB；房主→客人上限 16KB（快照后期约 3.4KB）。超限不再静默，记入诊断日志 `guest:drop-oversize`。
- **信令**：房主信令断开后带退避持续重连；建房/加入有总超时 `open`（15s）。
- **前后台**：联机中申请屏幕常亮（Wake Lock）；回到前台立即检查连接，房主补发心跳与快照。
- **客人端**：模式/筹码/调庄/清零由房主设置，客人点击只提示；"局/风/圈"以房主为准（快照 `fieldCount`）；结算页不显示手动调分。

- **牌桌昵称**：真人座位在头像下方显示名字（来自座位表，`textContent` 渲染）；AI/空位不显示。


## 补充（v4.5.5）
- **快照字段**：除座位/手牌/分数外还带 `fieldCount`（局/风/圈以房主为准）、`started`（对局是否已开始，客人房间面板据此显示状态）。
- **锁房**：`Game.net.locked` 为真时，新客人（无有效令牌）收到 `deny {text:'房主已锁房…'}`；令牌重连不受影响。
- **重连补发要约**：令牌重连成功且房主正在等该座位时，重发当前 `prompt`（`ms` 为剩余时间）。
- **消息上限**：客人→房主 4KB；房主→客人 16KB。超限的房主消息在客人侧记 `guest:drop-oversize` 到诊断日志。
- **阶段**：`Game.netGetPhase()` → `offline | lobby | playing | settling`，结算门闩只在 `settling` 生效；诊断信息含 `phase`。
- **邀请链接/二维码**：`?room=ABC234`（或 `#room=`）打开页面时自动加入（昵称取本机已存或默认「客人NN」），随后用 `history.replaceState` 清掉地址栏参数，刷新不会重复触发；失败则停在预填好的加入页。二维码编码的就是这条链接。
