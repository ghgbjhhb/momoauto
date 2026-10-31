# 4318 控制台公网入口（frp 内网穿透）

把本机 `127.0.0.1:4318` 的网页控制台经 hkcn2-1 发布成他人可访问的 HTTPS 入口。

**入口：<https://hkcn2-1.5913286.cc:14318>**

链路：访客浏览器 → hkcn2-1 nginx（14318，TLS）→ frps `127.0.0.1:18001` → 本机 frpc → 本机 4318。

## 使用前置条件（最容易踩的一条）

本机控制台进程必须携带环境变量

```
YUNMOMO_PUBLIC_ORIGINS=https://hkcn2-1.5913286.cc:14318
```

否则隧道是通的，但公网访问全部 403「仅允许本地控制台同源访问」（应用自身的 loopback 守卫，见 `src/server/http.js` 的 `allowedRequest`）。该值已用 `setx` 写入 HKCU，**只对之后新开的终端生效**；从旧终端或 IDE 内置终端启动 `npm run app` 会带空值。

`npm run tunnel:start` / 双击启动脚本会探测这一点并打印 `PUBLIC-OK 200` 或 `PUBLIC-403 …`。

## 用法

| 操作 | 命令 |
| --- | --- |
| 启动（幂等，已在跑就不重复拉起） | `npm run tunnel:start`，或双击 `启动4318穿透.bat` |
| 状态 + 公网探测 | `npm run tunnel:status` |
| 停止（只停这条，不动 8188 那条隧道） | `npm run tunnel:stop`，或双击 `停止4318穿透.bat` |

重启电脑后需要手动启动一次：隧道**未装开机自启**（按运维决定），控制台也要带上面的环境变量启动。

## 文件

| 文件 | 说明 | 入库 |
| --- | --- | --- |
| `frpc-hkcn2-4318.toml` | 隧道配置，路径全部相对本目录 | 是 |
| `启动4318穿透.bat` / `停止4318穿透.bat` | 一键入口，`silent` 参数跳过 `pause`（npm 用） | 是 |
| `frpc4318.ps1` | `status` / `stop` / `check` / `probe`，按配置文件名筛选进程 | 是 |
| `run-4318-hidden.vbs` | 真正拉起 frpc 的启动器（设好工作目录后最小化后台运行） | 是 |
| `pki/ca.crt` `pki/frpc.crt` | 自建 CA 与其签发的客户端证书（公开材料） | 是 |
| `pki/frpc.key` | 客户端私钥 | 否（`.gitignore`） |
| `frpc.exe` | frp 0.62.1 客户端二进制 | 否（`.gitignore`） |
| `frpc-4318.log` | 运行日志 | 否（`*.log`） |

配置里的相对路径依赖工作目录，所以只能由本目录的脚本拉起（bat 内 `cd /d "%~dp0"`，vbs 内 `shell.CurrentDirectory`）。

**为什么启动用 vbs 而不是 cmd `start` 或 PowerShell `Start-Process`**（踩过，别再改回去）：cmd 的 `start` 会占住调用方的 stdout 管道，`npm run tunnel:start` 在 frpc 存活期间不返回；实测带 `Start-Process` 的 `.ps1` 写进目录后会被系统直接删除。所以分工是 vbs 负责拉起，ps1 只做只读的状态查询、停止和外网探测。


**CA 私钥不在这里**：`ca.key` 仍只放在 `C:\Users\Administrator\Desktop\frp-内网穿透\pki\`，它是这条隧道的信任根，只在需要签发新客户端证书时才用得到，不参与启动。别把它放进仓库，也别删桌面那个目录（否则无法再签发新证书，只能重建 CA 并同步服务端）。

## 服务端（hkcn2-1）

- `/etc/frp/frps.toml`：`bindPort = 7000`、`proxyBindAddr = "127.0.0.1"`、`allowPorts` 只放行 18001、`transport.tls.force` + 同一枚 CA 的双向证书校验，无共享 token。
- systemd `frps.service`（开机自启、`Restart=always`）。
- `/etc/nginx/sites-available/hkcn2-1-4318.conf`：`listen 14318 ssl` → `proxy_pass http://127.0.0.1:18001`，保留 `Host`/`Origin` 原样透传（应用的同源校验依赖这个），开 WebSocket Upgrade 与 3600s 超时。
- 证书是现成的 Let's Encrypt `hkcn2-1.5913286.cc`（有效至 2027-01-28），并补了续期后 reload nginx 的 deploy hook。
- `/etc/frp/tls/frps.key` 在服务器上生成，从未离开服务器。

公网只暴露 nginx 14318 与 frps 7000 两个端口；7000 对无证书的连接直接断开。

## 排查顺序

1. `npm run tunnel:status` → `STOPPED` 就先 `npm run tunnel:start`。
2. 状态 `RUNNING` 但探测 `PUBLIC-403` → 控制台缺环境变量，带变量重启 `npm run app`（4318 是多会话共用的活服务，重启前先确认没人正在用）。
3. `PUBLIC-FAIL` → 看 `frpc-4318.log`；`login fail` 类报错通常是服务端 frps 没起来或证书不匹配。
4. 与 8188 那条老隧道完全独立（不同 frps、不同 `remotePort`），互不影响。
