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
`turn 45s / claim 15s / reveal 15s / hello 12s / ping 10s / dead 60s / hostSilent 35s / reserve 90s / ready 10s`

## 网络穿透
默认 3 个公共 STUN。对称 NAT（部分手机网络）需要 TURN：
`localStorage.qj_mj_net_ice = '[{"urls":"turn:your.host:3478","username":"u","credential":"p"}]'`
自建信令：`Game.netPeerConfig = {host, port, path, secure}`。

## 诊断
点屏幕上的联机状态条复制诊断信息（近 120 条事件、座位、RTT，不含手牌），反馈问题时附上。
