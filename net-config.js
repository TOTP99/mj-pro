// 联机部署配置（可选）。不改动时：使用 PeerJS 公有云信令 + 公共 STUN。
// 生产环境强烈建议按 deploy/README-DEPLOY.md 自建 PeerServer + coturn(TURN)，
// 然后取消下面注释并填写真实地址；否则手机流量 / 公司网 / 对称 NAT 下经常连不上。
//
// 优先级：Game.netPeerConfig（控制台临时） > localStorage.qj_mj_net_peer >
//         本文件 peer > 默认公有云；ICE 为 默认 STUN + 本文件 ice + localStorage.qj_mj_net_ice。
// 注意：本文件会随站点一起公开，TURN 账号务必设配额并定期换密码。
window.QJ_NET_CONFIG = {
    // 自建信令（PeerServer）。不填则用 PeerJS 公有云。
    // peer: { host: 'mj.example.com', port: 443, path: '/peerjs', secure: true, key: 'peerjs' },

    // 额外的 ICE 服务器（TURN 在对称 NAT / 手机流量下才能稳定连通）
    // ice: [
    //     { urls: 'turn:turn.example.com:3478', username: 'mjuser', credential: 'CHANGE_ME' },
    //     { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'mjuser', credential: 'CHANGE_ME' }
    // ]
};
