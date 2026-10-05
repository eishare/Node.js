## 📦 翼龙面板 Node.js 环境部署指南（适用：内存64MB、100MB，如 Freecloudpanel 等）

### ✨ 核心特性

* **Argo隧道**：TCP/UDP双模切换、连接数可调；Cloudflare CDN边缘节点可见。
* **极限精简优化**：适配 64MB 内存环境（如 FreeCloudPanel），同时适用内存100MB。
* **安全性**：自动生成 UUID/32位密码，重启复用。
* **存储空间清理**：部署完成后，自动清理磁盘空间，避免64MB存储溢出。
* **优化**：已加入主动内存回收机制。

---

### 1. 临时隧道+TUIC部署流程

1. 将 `start.sh`、`index.js` 和 `package.json` 上传至面板服务器根目录。
2. 填入TUIC端口号、Argo端口号8001。
3. 临时隧道协议切换http2/quic，连接数默认1。
4. 开机。

> [!NOTE]
> **临时隧道说明**  
> Cloudflare临时隧道默认优先单连接模式：连接数=1。

---

### 2. 固定隧道+TUIC部署流程

1. 将 `start.sh`、`index.js` 和 `package.json` 上传至面板服务器根目录。
2. 在环境变量或配置中填入你的 **固定隧道域名 (`ARGO_DOMAIN`)** 与 **Token (`ARGO_AUTH`)**。
3. 隧道协议可选 `http2`，并发连接数设为 `1~4`；或`quic`，并发连接数设为 `1`
4. 填入TUIC端口号。
5. 开机。

> [!CAUTION]
> **64MB 内存红线警告**  
> 1.  http2协议，并发连接数建议4以下。
> 2.  quic协议，建议将并发连接数设为 `1`（`ARGO_CONNECTIONS=1`），多条quic会增加内存/CPU占用，也可能会引发机房QoS。

> [!IMPORTANT]
> **关于客户端，Argo隧道显示 `-1`（假性超时）的说明**  
> 在 64MB 极低内存环境下，Argo节点可能会显示 `-1`，但网络正常。 
