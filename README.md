<div align="center">

<img src="doc/img/icon-192.png" width="88" height="88" alt="云微 logo" />

<h1>云微 · WechatOnCloud</h1>

<p><b>在自己的 NAS / 服务器上运行「服务端微信」，多端浏览器共享同一个微信会话</b></p>

<p>
  <a href="https://github.com/Gloridust/WechatOnCloud/stargazers"><img src="https://img.shields.io/github/stars/Gloridust/WechatOnCloud?style=flat-square&logo=github" alt="stars" /></a>
  <a href="https://github.com/Gloridust/WechatOnCloud/releases"><img src="https://img.shields.io/github/v/release/Gloridust/WechatOnCloud?style=flat-square" alt="release" /></a>
  <a href="https://github.com/Gloridust/WechatOnCloud/issues"><img src="https://img.shields.io/github/issues/Gloridust/WechatOnCloud?style=flat-square" alt="issues" /></a>
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20arm64-2496ED?style=flat-square&logo=docker&logoColor=white" alt="arch" />
  <img src="https://img.shields.io/badge/PWA-ready-5A0FC8?style=flat-square" alt="pwa" />
  <a href="https://x.com/gloridust1024"><img src="https://img.shields.io/badge/Twitter-@gloridust1024-1DA1F2?style=flat-square&logo=x&logoColor=white" alt="twitter" /></a>
  <a href="https://t.me/WechatOnCloud"><img src="https://img.shields.io/badge/Telegram-WechatOnCloud-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="telegram" /></a>
</p>

<p>
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心特性">核心特性</a> ·
  <a href="doc/运行原理.md">运行原理</a> ·
  <a href="#安全须知必读">安全须知</a> ·
  <a href="doc/技术方案.md">技术方案</a>
</p>

<table>
  <tr>
    <td width="50%"><img src="doc/img/Screenshot-1.png" alt="云微 · 面板主界面" /></td>
    <td width="50%"><img src="doc/img/Screenshot-2.png" alt="云微 · 实例桌面" /></td>
  </tr>
</table>

</div>

在飞牛 NAS（x86_64 / arm64）或任意 Docker 主机上运行服务端微信：可管理**多个**微信实例，每个实例是一个独立的微信会话；多个 web 用户通过浏览器访问被授权的实例，实现跨设备消息同步、多端共享。**不修改微信客户端。**

**一句话原理**：每个微信实例 = 一个容器，里面跑 Xvfb 虚拟显示 + 官方原版微信，KasmVNC 把画面串到浏览器；同一实例被多个浏览器连 = 共享同一个微信会话。前面一层自研**面板**是唯一对外入口，经 docker.sock 按需创建/销毁实例并反向代理。

交流群: [@WechatOnCloud](https://t.me/WechatOnCloud)

---

## 核心特性

- 🗂️ **多实例** — 一个面板管理多个独立微信会话，每个实例独立容器 + 独立数据卷，互不干扰。
- 👥 **多端共享 + 权限** — 多浏览器 / 设备共享同一会话；子账号体系，按账号分配可访问的实例（RBAC）。
- 🖥️ **微信 PC 式界面** — 左侧实例栏 + 右侧内嵌桌面，侧栏可折叠，移动端自动转抽屉。
- 📦 **微信本体运行时下载** — 镜像不打包微信，面板一键「下载安装 / 更新」带进度条；按 CPU 架构自动取包。
- 🔁 **实例生命周期** — 启动 / 停止 / 重启 / 升级（拉新镜像重建、保留聊天记录），均在面板内一键完成。
- 📎 **文件传输 + 文本剪贴板** — 拖拽上传 + 下载 + 删除，直达微信桌面 `~/Desktop`；文本可经剪贴板中转送进微信（局域网 http 下也可用）。
- 🧩 **多端协作软锁** — 同一实例多人操作时自动只读 + 申请接管，避免键鼠打架。
- 🔒 **安全优先** — 面板为唯一入口，KasmVNC 凭据服务端注入、永不下发前端；docker.sock 仅管理员可触达。
- 📱 **PWA** — iOS「添加到主屏幕」、桌面 Chrome「安装」当原生 App。
- 🏗️ **多架构** — amd64 / arm64 预构建镜像（Docker Hub + GHCR，GitHub Actions 自动发布）。

---

## 文档

| 文档 | 内容 |
|------|------|
| [运行原理与 Docker 指南](doc/运行原理.md) | 工作原理 + 架构图；面向 Docker 新手的逐步拆解、常用命令、架构自动适配 |
| [部署与运维](doc/部署与运维.md) | 数据持久化、常见问题排查、忘记超管密码的离线找回、目录结构 |
| [设备伪装与风控应对](doc/设备伪装.md) | 唯一 machine-id / 真实 hostname / os-release 伪装；账号被微信强制退出循环时怎么办 |
| [数据卷管理与迁移](doc/数据卷管理.md) | 管理员在面板里备份/恢复整卷、上传 PC 微信数据、浏览管理实例 /config 文件 |
| [发布到 GHCR](doc/发布到GHCR.md) | 用 GitHub Actions 或本机 buildx 把镜像发布到 GHCR |
| [技术方案](doc/技术方案.md) | 完整设计文档与选型权衡 |

---

## 快速开始

> 需已安装 Docker（含 Compose 插件）。x86_64 / arm64 均可。不熟悉 Docker？先读 [运行原理与 Docker 指南](doc/运行原理.md)。

`docker-compose.yml` 默认引用 **Docker Hub** 上的镜像 `docker.io/gloridust/{woc-panel,wechat-on-cloud}`（同时也发布到 GHCR 作为备用源）。
**这两个镜像需先存在**——要么官方已发布（你能直接拉取），要么你在本地自行构建。二选一：

**方式 A · 本地自构建（官方尚未发布镜像时用这个）**

```bash
git clone https://github.com/Gloridust/WechatOnCloud.git WechatOnCloud
cd WechatOnCloud
cp .env.example .env            # 至少改掉默认密码 WOC_PASSWORD
./scripts/build-local.sh        # 构建面板 + 微信实例镜像，打成 compose 用的同名标签
docker compose up -d            # compose 默认优先用本地镜像，不会再去远端拉
```

**方式 B · 拉取官方镜像（推荐，无需 clone 整个仓库）**

部署**只需要 `docker-compose.yml` 这一个文件**——它用 `image:` 直接拉官方镜像，面板数据放在该文件旁自动创建的 `./data-panel` 目录，不依赖仓库里的其它文件。

- **命令行**：丢进一个空目录拉起即可
  ```bash
  mkdir woc && cd woc
  curl -fsSL https://raw.githubusercontent.com/Gloridust/WechatOnCloud/main/docker-compose.yml -o docker-compose.yml
  docker compose up -d            # 默认从 Docker Hub 拉取（公开、amd64/arm64 多架构）
  ```
  > `raw.githubusercontent.com` 拉不动时，在 GitHub 网页打开根目录的 [docker-compose.yml](docker-compose.yml)，复制内容自己建个同名文件即可。

- **飞牛 OS（fnOS）/ 群晖 等 NAS**：在 **Docker → Compose 一键部署** 界面，把根目录 [docker-compose.yml](docker-compose.yml) 的内容**直接粘贴进去**即可部署，无需命令行、无需 clone。

> **改配置（强烈建议至少改密码）**：默认管理员 **admin / wechat**。登录后在「修改密码」里改；或部署前在 `docker-compose.yml` 旁放一个 `.env`（从 [.env.example](.env.example) 下载改名），又或在 NAS 的 Compose 环境变量里填 `WOC_PASSWORD`、`WOC_HTTP_PORT`、`WOC_IMAGE_PREFIX` 等（全部可配置项见 [.env.example](.env.example)）。

> **为什么默认 Docker Hub**：国内 / 国际通用、免登录即可拉公开镜像，**飞牛 OS（fnOS）等 NAS 系统还内置了 Docker Hub 拉取加速**，通常比 GHCR 更快更稳。`ghcr.io` 拉不动时设 `WOC_IMAGE_PREFIX` 切源：
>
> ```bash
> WOC_IMAGE_PREFIX=ghcr.io/gloridust          # 备用：GitHub Container Registry
> WOC_IMAGE_PREFIX=ghcr.nju.edu.cn/gloridust  # 备用：南京大学反代 ghcr.io（国内较稳）
> ```
>
> 更多源（自建阿里云 ACR / 腾讯 TCR 等）见 [.env.example](.env.example)。报错 `denied`？说明该源上还没有镜像（或为私有），换个源或用方式 A 本地构建。

无论哪种方式，都会拉起面板容器 `woc-panel`（唯一对外服务）。浏览器访问 `http://<NAS_IP>:36080`：

1. 用 `.env` 里设置的管理员账号（默认 **admin / wechat**）登录面板；
2. 管理员在面板「实例」页点「**新建微信实例**」，命名并选择哪些子账号可访问 → 面板自动 `docker run` 起一个微信实例容器（微信镜像本地没有时才会从镜像源拉取）；
3. 进入该实例，点「**下载并安装**」微信（约 190~210MB，进度条实时显示，仅管理员可操作）；
4. 装好后点「进入电脑版微信」→ 浏览器里出现微信窗口，手机扫码登录即可。

之后被授权的用户换任意设备打开同一地址登录面板，看到自己有权访问的实例，进入即是**同一个**微信会话。

> **🛠️ NAS / 飞牛(fnOS) 用户必看——首次新建实例若卡住报 `创建容器失败：… registry-1.docker.io … timeout`**：
> 这是 Docker **守护进程**拉取微信镜像超时。NAS 自带的「Docker Hub 加速」一般只作用于你在 NAS 界面**手动拉镜像**，不覆盖面板（经 docker.sock）触发的拉取，于是直连 `docker.io` 超时。
> **最省事的解法**：先在 NAS 的 **Docker → 镜像 → 拉取** 里手动拉一次 `gloridust/wechat-on-cloud:latest`（和你拉 `woc-panel` 同样的方式）。镜像到本地后，面板新建实例会直接复用、不再联网拉取 → 立即成功。
> 想一劳永逸：给 Docker 守护进程配「镜像加速器」（`/etc/docker/daemon.json` 的 `registry-mirrors`，改完重启 Docker），或把 `WOC_IMAGE_PREFIX` 换成国内可达源（如 `ghcr.nju.edu.cn/gloridust`）后重建面板。

> 宿主只对外暴露面板的 `36080` 一个端口；微信实例容器仅在 docker 网络内、由面板反代，不直连宿主。要改端口/版本/账号见 `.env`（可配置项见 [.env.example](.env.example)）。镜像会按 CPU 架构自动适配（[详见文档](doc/运行原理.md#架构自动适配)）。

### 面板能做什么

| 功能 | 谁可用 | 说明 |
|------|--------|------|
| 新建 / 删除微信实例 | 管理员 | 一键创建独立微信会话容器；新建时勾选可访问的子账号。删除默认保留数据卷（聊天记录），可选彻底清除 |
| 实例权限分配 | 管理员 | 在实例上改「可访问账户」，或在账户上改「可访问实例」，双向管理 |
| 下载并安装 / 更新微信 | 管理员 | 对某实例一键下载官方微信 Linux 版到其数据卷、解压安装；带进度条；后续可一键「更新到最新版」 |
| 进入电脑版微信 | 被授权用户 | 在浏览器里操作对应实例的微信，扫码登录、收发消息 |
| 文件 / 文本传输 | 被授权用户 | 拖拽上传 / 下载文件；文本经剪贴板中转送进微信 |
| 修改密码 | 所有人 | 改自己的登录密码 |
| 子账号管理 | 管理员 | 创建 / 禁用 / 重置 / 删除子账号，并分配实例访问权限 |
| 安装为 App | 所有人 | iOS Safari「添加到主屏幕」、桌面 Chrome「安装」当原生 App（PWA） |

> 子账号是**访问这套面板的身份**，不是另开一个微信。管理员隐式拥有全部实例访问权；子账号只能看到被授权的实例。
> 微信本体**不打进镜像**，而是新建实例后在面板点「下载并安装」时下载到该实例的数据卷，所以镜像很小、构建快。

---

## 资源占用

实测（8 核 / 8 GiB 宿主，实例均已登录微信、含 Chromium 内核的 WeChatAppEx）：

| 状态 | CPU | 内存（RSS） |
|------|-----|------------|
| 单实例 · 空闲（已登录、无人观看） | ~0.1–0.2 核 | ~0.6 GiB |
| 单实例 · 活跃（有人在浏览器操作 / 刷消息） | ~0.5–1 核（可突发） | ~1–1.5 GiB |
| 面板本身 | 可忽略 | ~0.12 GiB |

- 容器**不设硬性 CPU/内存上限**：空闲时省，活跃时按宿主余量突发；每实例另预留 **1 GiB `/dev/shm`**（微信 Chromium 内核所需，tmpfs，按需占用）。
- 估算：**面板 ≈ 0.15 GiB 常驻；每个微信实例按 1 vCPU + 1.5 GiB 内存预留**较从容（轻度使用可更低）。
- 参考容量：**2 核 / 2 GiB** 跑 1 个实例（轻度）；**4 核 / 8 GiB** 跑 3–4 个实例；视频通话等重负载需再加预留。

> 内存是主要瓶颈，CPU 多为短时突发。实例越多越吃内存，按上表线性叠加即可估算。

---

## 安全须知（必读）

> ⚠️ **这套系统暴露的是已登录的微信，请务必认真阅读本节。**

能登录面板的人就能看聊天记录、以你身份发消息。**面板还挂载了宿主的 `docker.sock`**（创建/销毁实例所需），它等同宿主 root 权限。因此：

- **绝不要把面板裸暴露公网**：只在内网访问，或经飞牛远程访问 / VPN / 内网穿透；
- 务必改掉默认密码（默认 admin / wechat）：`cp .env.example .env` 后改 `WOC_PASSWORD`，或登录后在「修改密码」里改；
- 实例的增删、微信安装/更新等触碰 docker 引擎的操作**仅限管理员**；docker API 绝不暴露给前端；
- KasmVNC 凭据由面板服务端注入，**浏览器永远拿不到**；实例容器名由内部随机 ID 派生，避免注入；
- 面板与外网之间再套一层 HTTPS 反代（飞牛自带反代 / Caddy / Nginx）获得正经 TLS；
- 进一步加固（陌生设备验证码、审计日志、并发控制）见 [技术方案.md](doc/技术方案.md) 第 5 节。

---

## 中文输入

**用你本地（客户端）的输入法打中文，容器内无需安装任何 IME。** 面板默认启用「即时输入」代理：先点微信输入框，再直接用本机输入法打字；英文、数字、标点会立即进入微信，中文在输入法上屏后整串进入微信输入框，规避 noVNC 原生 IME 差分逻辑的丢字 / 卡顿 / 混合输入损坏。

- 顶部「即时输入」可开关；遇到特殊浏览器或输入法不兼容时，可打开「输入条」作为兜底：在面板输入框里打一段，回车发送到微信。
- **跨设备文本**：实例工具栏的「剪贴板」可把文本送入容器剪贴板，再在微信里 `Ctrl+V` 粘贴——不依赖浏览器异步剪贴板 API，**局域网 http 访问下也可用**。
- **文件**：用工具栏「文件」拖拽上传，微信收到的文件另存到桌面即可在此下载。

---

## 路线图

- [x] MVP：Docker + 微信原生版 + KasmVNC，浏览器扫码登录、收发消息
- [x] 自研面板：cookie 鉴权 + 反代 + 子账号管理 + PWA（KasmVNC 凭据不下发前端）
- [x] 微信本体运行时下载到数据卷：面板一键「下载并安装 / 更新」，带进度条
- [x] 多实例管理 + 按账号的实例访问权限（RBAC）
- [x] 预构建多架构镜像发布到 Docker Hub / GHCR + GitHub Actions 自动化
- [x] 中文输入修复 + 文本剪贴板中转 + 实例日志导出
- [ ] 面板外层 TLS / 陌生设备验证码 / 审计日志
- [x] 多端并发控制（操作控制权心跳软锁 + 只读遮罩 + 申请接管）
- [ ] 掉登录时 web 端二维码重扫入口
- [~] 打包成飞牛原生 fpk 分发（工程已就绪见 [fnos/](fnos/)，待真实设备验证 docker.sock 权限）

## 交流与关注

- 🐦 Twitter / X：[@gloridust1024](https://x.com/gloridust1024) — 更新与动态
- ✈️ Telegram：[@WechatOnCloud](https://t.me/WechatOnCloud) — 交流群 / 问题反馈

## 致谢

创意启发自懒猫微服（原 Deepin 团队做的硬件产品），推荐有经济实力、追求稳定运营的朋友尝试！

也感谢每一位 Star / Issue / PR 的朋友——**两天突破 500 ⭐**，是继续打磨的最大动力 🙌

## Star History

<a href="https://www.star-history.com/?repos=Gloridust%2FWechatOnCloud&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Gloridust/WechatOnCloud&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Gloridust/WechatOnCloud&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Gloridust/WechatOnCloud&type=date&legend=top-left" />
 </picture>
</a>

---

<div align="center">
<sub>如果这个项目帮到了你，欢迎点个 ⭐ Star 支持一下 ·
<a href="https://github.com/Gloridust/WechatOnCloud/issues">反馈问题</a> ·
<a href="https://github.com/Gloridust/WechatOnCloud/pulls">参与贡献</a></sub>
</div>
