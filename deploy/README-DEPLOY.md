# 联机部署指南（TURN + 自建信令）

## 为什么要做
默认只用 PeerJS 公有云（免费、无 SLA）和公共 STUN。遇到**对称 NAT / 手机蜂窝网络 / 企业网络**时，点对点打不通，
表现为"房主无响应""连接超时"。**TURN 中继**能兜底；自建 **PeerServer** 能摆脱公有云不稳定与限流。

## 你需要
- 一台有公网 IP 的小 VPS（1 核 1G 足够）；两个域名/子域：`mj.example.com`（信令）、`turn.example.com`（TURN）。
- 防火墙放行：`80/443`（Caddy）、`3478/udp+tcp`、`5349/tcp`、`49160-49200/udp`（TURN 中继端口）。

## 步骤
1. 装 Docker 和 Caddy（或 Nginx）。
2. 把 `deploy/` 目录传到服务器，改 `turnserver.conf`：`user=`（用户名:强密码）、`realm`、`external-ip`。
3. `docker compose up -d` 启动 PeerServer（127.0.0.1:9000）和 coturn。
4. 用 `Caddyfile` 反代 `mj.example.com` → `127.0.0.1:9000`（自动 HTTPS）。
5. 编辑站点根目录的 `net-config.js`：

```js
window.QJ_NET_CONFIG = {
  peer: { host: 'mj.example.com', port: 443, path: '/peerjs', secure: true, key: 'peerjs' },
  ice: [
    { urls: 'turn:turn.example.com:3478', username: 'mjuser', credential: '你的强密码' },
    { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'mjuser', credential: '你的强密码' }
  ]
};
```
6. 游戏页面必须走 **HTTPS**（语音、Wake Lock、剪贴板都需要）。

## 验证
- 打开 https://mj.example.com/peerjs ，应返回 `{"name":"PeerJS Server",...}`。
- 浏览器打开 https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ ，加入你的 TURN，
  点 Gather candidates，应看到 `typ relay` 候选。
- 两台手机（一台关 WiFi 用流量）进同一房间，能进、能打。游戏内点状态条 → "复制诊断"，里面有连接事件日志。

## 安全与成本
- `net-config.js` 是公开文件，**TURN 密码对所有玩家可见**。这是静态凭据的固有限制，所以必须在 `turnserver.conf` 里
  设配额（`user-quota` / `total-quota`）、禁止中继到内网（已含 `denied-peer-ip`），并定期换密码。
- 想进一步防盗用：改用 coturn 的 `use-auth-secret`（限时凭据），由一个小接口按需签发；当前客户端读取静态配置，
  需要时再加一个"启动前拉取凭据"的步骤。
- TURN 只在直连失败时才中继，流量通常很小；月流量以实际中继为准，建议在 VPS 面板设置流量告警。
- 公有云 PeerServer 的房间 ID 是全局共享命名空间；自建后 `ROOM_PREFIX` 只在你自己的服务里生效，更干净。

## 回退
删掉或清空 `net-config.js` 里的内容即回到公有云 + 公共 STUN。浏览器端也可临时用
`localStorage.qj_mj_net_ice` 追加 ICE，或在控制台设 `Game.netPeerConfig` 调试（优先级最高）。
