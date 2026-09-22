# 云微 (woc) — fnOS 应用包

将 [WechatOnCloud](https://github.com/Gloridust/WechatOnCloud) 面板打包为飞牛 fnOS `.fpk`。

桌面入口使用 `type: url` + 安装端口，在**系统浏览器**打开；FN Connect 下访问域名为 `woc.[fnid].fnos.net`（不走统一网关子路径 `/app/woc`，以避免上游面板绝对路径与无 basename 的 SPA 在子路径下空白页）。

## 目录结构

```
woc/
├── app/docker/docker-compose.yaml   # 仅 panel 服务
├── app/ui/config                    # 桌面入口 type=url
├── app/ui/images/                   # 桌面图标
├── cmd/                             # 生命周期脚本
├── config/privilege                 # 运行身份
├── config/resource                  # docker-project + 数据共享
├── wizard/install                   # 安装向导
├── manifest
├── ICON.PNG / ICON_256.PNG
└── README.md
```

## 构建

需安装飞牛官方 `fnpack` CLI（见 <https://developer.fnnas.com/docs/guide/>）。

```bash
cd fnos/woc
fnpack build
```

在飞牛「应用中心 → 手动安装」上传产出的 `.fpk`。建议 fnOS ≥ 1.2.0401。

## 访问方式

| 方式 | 地址 | 说明 |
|------|------|------|
| FN Connect（推荐） | `https://woc.[fnid].fnos.net/` | 桌面图标在系统浏览器打开 |
| LAN 端口 | `http://<NAS_IP>:<wizard_port>/` | 默认端口 `36080` |

## 架构要点（1.0.1）

- **panel**：默认镜像 `docker.io/gloridust/woc-panel`，挂载 `docker.sock`；端口 `${wizard_port:-36080}:8080`；`PANEL_ALLOWED_HOSTS` 默认 `*.fnos.net,*.5ddd.com`。
- **桌面**：`micro_app=true`，`type=url`，`port=${wizard_port}`，`url=/`。
- **appname**：`woc`（缩短 FN Connect 三级域名；从旧包 `wechat-on-cloud` 升级需先卸载再装）。

## 已知限制

- 挂载 `docker.sock` 等同宿主 Docker 管理权限；若沙箱禁止该挂载，将无法新建微信实例。
- 上游面板为根路径 SPA；若要用统一网关 `/app/{appname}`，需另行改面板 `base` / `BrowserRouter` basename 后重建镜像。
