// 联机部署配置（可选）。不改动时：使用 PeerJS 公有云信令 + 公共 STUN。
// 生产环境请按 deploy/README-DEPLOY.md 自建 PeerServer + coturn(TURN)，然后取消下面的注释并填写。
window.QJ_NET_CONFIG = {
    // 自建信令（PeerServer）。不填则用 PeerJS 公有云。
    // peer: { host: 'mj.example.com', port: 443, path: '/peerjs', secure: true, key: 'peerjs' },

    // 额外的 ICE 服务器（TURN 在对称 NAT / 手机流量下才能连通）
    // ice: [
    //     { urls: 'turn:turn.example.com:3478', username: 'mjuser', credential: 'CHANGE_ME' },
    //     { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'mjuser', credential: 'CHANGE_ME' }
    // ]
};
