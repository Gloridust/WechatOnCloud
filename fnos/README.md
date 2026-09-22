# 飞牛 fnOS 应用打包（.fpk）

把 WechatOnCloud 打成飞牛应用中心可安装的 `.fpk`。本目录 `woc/` 是按飞牛开发文档组织的 Docker 类应用工程。

> 飞牛开发文档：<https://developer.fnnas.com/docs/guide/>

当前包设计：桌面入口 `type: url`，FN Connect 域名为 `woc.[fnid].fnos.net`（系统浏览器打开）。详见 [`woc/README.md`](./woc/README.md)。

## 构建

```bash
cd fnos/woc
fnpack build
```

然后在飞牛「应用中心 → 手动安装」上传该 `.fpk`。

## 重要前提

1. **docker.sock**：面板需挂载宿主 `/var/run/docker.sock` 按需创建微信实例；等同宿主 root 级能力。
2. **向导变量**：`wizard/install` 字段名会成为环境变量，compose 用 `${...}` 引用（含 `wizard_port`）。
3. **镜像**：默认从 Docker Hub `gloridust/woc-panel` 拉取；可用环境变量 `WOC_IMAGE_PREFIX` / `WOC_VERSION` 覆盖。
