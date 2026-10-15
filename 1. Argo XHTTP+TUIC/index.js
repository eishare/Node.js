#!/usr/bin/env node
{ const w = process.stderr.write; process.stderr.write = (chunk, ...args) => typeof chunk === 'string' && chunk.includes('DeprecationWarning') ? true : w.apply(process.stderr, [chunk, ...args]); }


// ========= Sing-box TUIC + Argo Xray (xHTTP h2) 固定隧道 变量设置 =========


const TUIC_PORT = process.env.TUIC_PORT || "";                                        // TUIC 直连端口（留空=不部署）

const ARGO_PORT = process.env.ARGO_PORT || "8001";                                    // 固定隧道回源端口（与服务URL端口一致 http://127.0.0.1:8001）

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";                                    // 固定隧道域名（必须与 PORT/AUTH 同时具备才部署）

const ARGO_AUTH = process.env.ARGO_AUTH || "";                                        // 固定隧道 Token（必须与 PORT/DOMAIN 同时具备才部署）

const ARGO_PROTOCOL = process.env.ARGO_PROTOCOL || "quic";                            // http2或quic（http2=稳定+低占用；quic=响应快+占用略高）
 
const ARGO_CONNECTIONS = process.env.ARGO_CONNECTIONS || "1";                         // 隧道连接数量 建议http2≤4，quic=1

const CFIP = process.env.CFIP || "www.teamviewer.com";                                // 优选域名（备选 www.visa.com.hk  usa.visa.com  www.wto.org  www.shopify.com ) 


// ============================ 变量设置完成 ===============================

const DIRECT_PORT = process.env.DIRECT_PORT || process.env.SERVER_PORT || TUIC_PORT;
const CFPORT = process.env.CFPORT || 443;
const FILE_PATH = process.env.FILE_PATH || ".tmp";
const URL_FILE_PATH = process.env.URL_FILE_PATH || "sub.txt";

const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, execSync } = require("child_process");

const log = (msg) => process.stdout.write(msg + "\n");

const iataMap = {
  HKG: "香港", TPE: "台湾", NRT: "日本", HND: "日本", KIX: "日本",
  ICN: "韩国", SIN: "新加坡", BKK: "泰国", MNL: "菲律宾", SGN: "越南",
  LAX: "美国", DFW: "美国", SJC: "美国", SEA: "美国", JFK: "美国", ORD: "美国",
  LHR: "英国", FRA: "德国", CDG: "法国", AMS: "荷兰", HEL: "芬兰"
};

const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
let singboxMemLimit, xrayMemLimit, cloudflaredMemLimit, dynamicGOGC, dynamicProcs;

if (totalMemMB <= 160) {
  singboxMemLimit = "20MiB";
  xrayMemLimit = "20MiB";
  cloudflaredMemLimit = "45MiB";
  dynamicGOGC = "400"; 
  dynamicProcs = "1";
} else if (totalMemMB < 256) {
  singboxMemLimit = "40MiB";
  xrayMemLimit = "40MiB";
  cloudflaredMemLimit = "90MiB";
  dynamicGOGC = "250";
  dynamicProcs = "1";
} else if (totalMemMB < 352) {
  singboxMemLimit = "65MiB";
  xrayMemLimit = "65MiB";
  cloudflaredMemLimit = "130MiB";
  dynamicGOGC = "300";
  dynamicProcs = "1"; 
} else if (totalMemMB < 448) {
  singboxMemLimit = "65MiB";
  xrayMemLimit = "65MiB";
  cloudflaredMemLimit = "140MiB";
  dynamicGOGC = "220";
  dynamicProcs = "1";
} else if (totalMemMB < 576) {
  singboxMemLimit = "80MiB";
  xrayMemLimit = "80MiB";
  cloudflaredMemLimit = "160MiB";
  dynamicGOGC = "200";
  dynamicProcs = "1"; 
} else {
  singboxMemLimit = "200MiB";
  xrayMemLimit = "200MiB";
  cloudflaredMemLimit = "350MiB";
  dynamicGOGC = "200";
  dynamicProcs = process.env.GOMAXPROCS || "2";
}

const GO_BASE_ENV = {
  ...process.env,
  GODEBUG: "madvdontneed=1,netdns=go,cgocheck=0", 
  GOMAXPROCS: String(dynamicProcs), 
  GOGC: String(dynamicGOGC)
};

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const uuidFilePath = path.join(FILE_PATH, "uuid.txt");
const tuicPwdFilePath = path.join(FILE_PATH, "tuic_password.txt");
const seed = process.env.MACHINE_SEED || os.hostname() || "fixed-seed";

const genPwd = (s) => crypto.createHash("sha256").update(s + "-tuic").digest("hex").slice(0, 32);
const genUUID = (s) => {
  const h = crypto.createHash("md5").update(s + "-uuid").digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${(parseInt(h.slice(16,18), 16) & 0x3f | 0x80).toString(16)}${h.slice(18,20)}-${h.slice(20,32)}`;
};

let TUIC_PASSWORD = process.env.TUIC_PASSWORD;
if (!TUIC_PASSWORD) {
  if (fs.existsSync(tuicPwdFilePath)) {
    TUIC_PASSWORD = fs.readFileSync(tuicPwdFilePath, "utf-8").trim();
  } else {
    TUIC_PASSWORD = genPwd(seed);
    try {
      fs.writeFileSync(tuicPwdFilePath, TUIC_PASSWORD, "utf-8");
    } catch (e) {}
  }
}

let UUID = process.env.UUID;
if (!UUID) {
  if (fs.existsSync(uuidFilePath)) {
    UUID = fs.readFileSync(uuidFilePath, "utf-8").trim();
  } else {
    UUID = genUUID(seed);
    try {
      fs.writeFileSync(uuidFilePath, UUID, "utf-8");
    } catch (e) {}
  }
}
UUID = UUID.toLowerCase();

const XHTTP_PATH = `/${UUID}-xhttp`;

function getPublicIP() {
  const overrideIp = process.env.SERVER_IP || process.env.CFIP;
  if (overrideIp && overrideIp.trim() && overrideIp !== "www.visa.co.jp") {
    return Promise.resolve(overrideIp.trim());
  }

  const fetchIP = (url) => new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 3500 }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        const ip = data.trim();
        ip ? resolve(ip) : reject(new Error("Empty"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });

  return fetchIP("https://api.ipify.org")
    .catch(() => fetchIP("https://ipv4.icanhazip.com"))
    .catch(() => "127.0.0.1");
}

function generateCertificates(keyPath, certPath) {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return;
  try {
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}" 2>/dev/null && openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com" 2>/dev/null`);
    fs.chmodSync(keyPath, 0o600);
  } catch (e) {}
}

const singboxPath = path.join(FILE_PATH, "singbox");
const webPath = path.join(FILE_PATH, "web");
const botPath = path.join(FILE_PATH, "bot");

const singboxConfigPath = path.join(FILE_PATH, "singbox_config.json");
const xrayConfigPath = path.join(FILE_PATH, "xray_config.json");
const certPath = path.join(FILE_PATH, "cert.pem");
const keyPath = path.join(FILE_PATH, "private.key");

const isArm = ["arm", "arm64", "aarch64"].includes(os.arch());
const XRAY_VER = "25.1.30";
const SINGBOX_VER = "1.11.4";

const singboxUrl = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-${isArm ? "arm64" : "amd64"}.tar.gz`;
const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VER}/Xray-linux-${isArm ? "arm64-v8a" : "64"}.zip`;
const cloudflaredUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${isArm ? "arm64" : "amd64"}`;

let singboxProc = null;
let webProc = null;
let botProc = null;
let isExiting = false;

function downloadFile(urlStr, targetPath) {
  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith("https") ? https : http;
    const req = client.get(urlStr, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy();
        return downloadFile(res.headers.location, targetPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(targetPath);
      res.pipe(file);
      file.on("finish", () => { file.close(() => { req.destroy(); resolve(); }); });
    });
    req.on("error", (err) => { req.destroy(); try { fs.unlinkSync(targetPath); } catch (e) {} reject(err); });
  });
}

async function startSingBox() {
  if (isExiting) return;
  try {
    if (!fs.existsSync(singboxPath)) {
      log("正在下载 Sing-box...");
      const tempTar = path.join(FILE_PATH, "singbox.tar.gz");
      await downloadFile(singboxUrl, tempTar);
      execSync(`tar -xzf "${tempTar}" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1 || tar -xzf "${tempTar}" -C "${FILE_PATH}" sing-box`);
      const extractedPath = path.join(FILE_PATH, "sing-box");
      if (fs.existsSync(extractedPath) && extractedPath !== singboxPath) fs.renameSync(extractedPath, singboxPath);
      try { fs.unlinkSync(tempTar); } catch (e) {}
    }
    fs.chmodSync(singboxPath, 0o775);

    singboxProc = spawn(singboxPath, ["run", "-c", singboxConfigPath], {
      env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: singboxMemLimit }),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true
    });

    singboxProc.on("exit", (code) => {
      if (isExiting) return;
      log(`[警告] Sing-box 意外退出 (code: ${code})，3秒后自动拉起...`);
      setTimeout(() => { startSingBox().catch(e => log(`[保活错误] ${e.message}`)); }, 3000);
    });

  } catch (err) {
    log(`[错误] Sing-box 启动失败: ${err.message}，5秒后重试...`);
    if (!isExiting) setTimeout(startSingBox, 5000);
  }
}

async function startXray() {
  if (isExiting) return;
  try {
    if (!fs.existsSync(webPath)) {
      log("正在下载 Xray-core...");
      const tempZip = path.join(FILE_PATH, "xray.zip");
      await downloadFile(xrayZipUrl, tempZip);
      const extractScriptPath = path.join(FILE_PATH, "extract.py");
      const pyCode = `
import zipfile, sys
try:
    with zipfile.ZipFile(sys.argv[1], 'r') as z:
        z.extract('xray', sys.argv[2])
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;
      fs.writeFileSync(extractScriptPath, pyCode, "utf-8");

      let extracted = false;
      for (const py of ["python3", "python"]) {
        try {
          execSync(`${py} "${extractScriptPath}" "${tempZip}" "${FILE_PATH}"`, { stdio: "ignore" });
          extracted = true;
          break;
        } catch (e) {}
      }
      try { fs.unlinkSync(extractScriptPath); } catch (e) {}

      if (!extracted) {
        throw new Error("当前环境既没有 unzip 命令，也没有可用的 python3/python 环境，无法解压 Xray！");
      }

      const extractedPath = path.join(FILE_PATH, "xray");
      if (fs.existsSync(extractedPath)) {
        if (fs.existsSync(webPath)) fs.unlinkSync(webPath);
        fs.renameSync(extractedPath, webPath);
      } else {
        throw new Error("Xray 解压执行完毕，但未在目录中找到目标二进制文件。");
      }
      
      try { fs.unlinkSync(tempZip); } catch (e) {}
    }
    fs.chmodSync(webPath, 0o775);

    webProc = spawn(webPath, ["run", "-c", xrayConfigPath], {
      env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: xrayMemLimit }),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true
    });

    webProc.on("exit", (code) => {
      if (isExiting) return;
      log(`[警告] Xray 意外退出 (code: ${code})，3秒后自动拉起...`);
      setTimeout(() => { startXray().catch(e => log(`[保活错误] ${e.message}`)); }, 3000);
    });

  } catch (err) {
    log(`[错误] Xray 启动失败: ${err.message}，5秒后重试...`);
    if (!isExiting) setTimeout(startXray, 5000);
  }
}

async function startCloudflared(argoArgs) {
  if (isExiting) return;
  try {
    if (!fs.existsSync(botPath)) {
      log("正在下载 Cloudflared...");
      await downloadFile(cloudflaredUrl, botPath);
    }
    fs.chmodSync(botPath, 0o775);

    log("[Argo] 检测到完整变量 (PORT+DOMAIN+AUTH)，启动固定隧道...");

    botProc = spawn(botPath, [...argoArgs], {
      env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: cloudflaredMemLimit }),
      stdio: ["ignore", "pipe", "pipe"], detached: true
    });

    const activeConnectionsMap = new Map();
    let rl = readline.createInterface({ input: botProc.stderr });

    const detachStream = () => {
      try {
        if (rl) {
          rl.removeListener("line", onLineHandler);
          rl.close();
          rl = null;
        }
        if (botProc && botProc.stderr) {
          botProc.stderr.removeAllListeners("data");
          botProc.stderr.resume(); 
        }
        activeConnectionsMap.clear();
      } catch (e) {}
    };

    const onLineHandler = (chunk) => {
      const cleanLine = chunk.replace(/\u001b\[[0-9;]*m/g, "");

      const connMatch = cleanLine.match(/connIndex=(\d+)/i) || cleanLine.match(/"connIndex":(\d+)/i);
      const locMatch = cleanLine.match(/(?:location|region)["=:\s]+([a-zA-Z0-9]{3,4})/i) ||
                       cleanLine.match(/Registered tunnel connection.*?\b([A-Z0-9]{3,4})\b/i);

      if (locMatch) {
        const rawCode = locMatch[1].toUpperCase();
        const iataCode = rawCode.replace(/[0-9]/g, "");
        const country = iataMap[iataCode] || iataCode;
        const connId = connMatch ? connMatch[1] : String(activeConnectionsMap.size);

        if (!activeConnectionsMap.has(connId)) {
          activeConnectionsMap.set(connId, rawCode);
          log(`[Cloudflare CDN] 已连接边缘节点：${rawCode}（${country}） | 协议：${ARGO_PROTOCOL.toLowerCase()}`);
        }
      }
    };

    rl.on("line", onLineHandler);
    setTimeout(detachStream, 60000);

    botProc.on("exit", (code, signal) => {
      if (isExiting) return;
      log(`[警告] cloudflared 进程意外退出 (code: ${code}, signal: ${signal})，3秒后自动重连...`);
      setTimeout(() => startCloudflared(argoArgs), 3000);
    });

  } catch (err) {
    log(`[错误] cloudflared 启动失败: ${err.message}，5秒后重试...`);
    if (!isExiting) setTimeout(() => startCloudflared(argoArgs), 5000);
  }
}

async function main() {
    
  const domainTrim = ARGO_DOMAIN.trim();
  const authTrim = ARGO_AUTH.trim();
  const portTrim = String(ARGO_PORT).trim();

  const enableDirect = Boolean(DIRECT_PORT && String(DIRECT_PORT).trim() !== "" && String(DIRECT_PORT).trim() !== "0");

  const enableArgoFixed = Boolean(
    portTrim !== "" && portTrim !== "0" &&
    domainTrim.length > 0 &&
    authTrim.length > 30
  );

  if (!enableDirect && !enableArgoFixed) {
    log("[退出] 缺失变量 (TUIC_PORT) + Argo 固定隧道 (PORT/DOMAIN/AUTH)。放弃所有部署。");
    process.exit(0);
  }

  try { execSync("pkill -9 -f sing-box || pkill -9 -f xray || pkill -9 -f cloudflared", { stdio: "ignore" }); } catch (e) {}

  if (enableDirect) { try { execSync(`fuser -k -9 ${DIRECT_PORT}/udp`, { stdio: "ignore" }); } catch (e) {} }

  let globalLinks = [];

  if (enableDirect) {
    generateCertificates(keyPath, certPath);

    const singboxConfig = {
      log: { level: "panic" },
      dns: {
        servers: [
          {
            tag: "local-sys-dns",
            address: "local",
            detour: "direct"
          }
        ],
        strategy: "prefer_ipv4",
        independent_cache: true,
        cache_capacity: 4096
      },
      inbounds: [
        {
          type: "tuic",
          tag: "tuic-in",
          listen: "::",
          listen_port: parseInt(DIRECT_PORT),
          users: [{ uuid: UUID, password: TUIC_PASSWORD }],
          congestion_control: "bbr",
          tls: {
            enabled: true,
            alpn: ["h3"],
            certificate_path: certPath,
            key_path: keyPath
          }
        }
      ],
      outbounds: [{ type: "direct", tag: "direct", udp_fragment: true }],
      route: {
        auto_detect_interface: true,
        final: "direct"
      }
    };

    fs.writeFileSync(singboxConfigPath, JSON.stringify(singboxConfig, null, 2));
    log(`[初始化] 已加载 Sing-box TUIC 直连入站，监听端口: ${DIRECT_PORT}`);
    await startSingBox();

    const publicIp = await getPublicIP();
    const directTuic = `tuic://${UUID}:${TUIC_PASSWORD}@${publicIp}:${DIRECT_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#TUIC_easyshare`;
    globalLinks.push(directTuic);
  } else {
    log("[初始化] 缺失变量 TUIC_PORT，已放弃部署 TUIC 直连。");
  }

  if (enableArgoFixed) {
    const xrayConfig = {
      log: { loglevel: "none" },
      inbounds: [
        {
          port: parseInt(ARGO_PORT),
          listen: "127.0.0.1",
          protocol: "vless",
          settings: { clients: [{ id: UUID }], decryption: "none" },
          streamSettings: {
            network: "xhttp",
            security: "none",
            xhttpSettings: { path: XHTTP_PATH, mode: "auto", scMaxConcurrentStreams: 16 }
          }
        }
      ],
      outbounds: [{ protocol: "freedom", tag: "direct" }]
    };

    fs.writeFileSync(xrayConfigPath, JSON.stringify(xrayConfig, null, 2));
    log(`[初始化] 已加载 Xray Argo xHTTP 回源入站，监听端口: ${ARGO_PORT}`);
    await startXray();

    const argoArgs = [
      "tunnel", 
      "--no-autoupdate", 
      "--retries", "5", 
      "--grace-period", "1s", 
      "--protocol", ARGO_PROTOCOL.toLowerCase(), 
      "--ha-connections", ARGO_CONNECTIONS,
      "run",
      "--token", authTrim
    ];

    await startCloudflared(argoArgs);

    const argoLinkH2 = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&alpn=h2&sni=${domainTrim}&fp=chrome&type=xhttp&mode=auto&host=${domainTrim}&path=${encodeURIComponent(XHTTP_PATH)}#h2_argo_easyshare`;
const argoLinkH3 = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&alpn=h3&sni=${domainTrim}&fp=chrome&type=xhttp&mode=auto&host=${domainTrim}&path=${encodeURIComponent(XHTTP_PATH)}#h3_argo_easyshare`;
globalLinks.push(argoLinkH2);
globalLinks.push(argoLinkH3);
  } else {
    log("[初始化] 缺失变量 (PORT/DOMAIN/AUTH)，已放弃部署 Argo 固定隧道。");
  }

  if (globalLinks.length > 0) {
    const base64Sub = Buffer.from(globalLinks.join("\r\n")).toString("base64");
    const consoleFormatted = `====================== Base64 订阅/链接 ======================\n${base64Sub}\n==============================================================`;
    
    log(`\n${consoleFormatted}`);
    try {
      fs.writeFileSync(URL_FILE_PATH, consoleFormatted, "utf-8");
      log(`[链接] Base64 已写入: ${URL_FILE_PATH}`);
    } catch (e) {}
  }

  const cleanup = () => {
    isExiting = true;
    try { if (singboxProc) singboxProc.kill("SIGKILL"); } catch (e) {}
    try { if (webProc) webProc.kill("SIGKILL"); } catch (e) {}
    try { if (botProc) botProc.kill("SIGKILL"); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.resume();
}

main().catch((err) => { log(`[错误] ${err.message}`); process.exit(1); });
