# Kubernetes 部署

WechatOnCloud 支持两种运行时：

- `WOC_RUNTIME=docker`：默认模式，面板通过 `/var/run/docker.sock` 创建实例容器。
- `WOC_RUNTIME=kubernetes`：面板通过 Kubernetes API 创建每个实例的 Pod、PVC 和 Service。

Docker / Compose 部署完全不受影响；本文只覆盖 Kubernetes 模式。

## 快速部署

```bash
kubectl apply -k k8s
kubectl -n wechat-on-cloud port-forward svc/woc-panel 8080:8080
```

访问 `http://127.0.0.1:8080`，默认管理员为 `admin / wechat`。生产使用前必须改密码，或者在 `k8s/deployment.yaml` 中修改 `PANEL_ADMIN_PASSWORD` 后再部署。

## 资源模型

面板自身：

- Deployment：`woc-panel`
- Service：`woc-panel`
- PVC：`woc-panel-data`，保存账号、实例登记、日志
- ServiceAccount：`woc-panel`（绑定的 Role 仅在本 namespace 内可管理 pods / pods/log / pods/exec / services / persistentvolumeclaims）

每个实例：

- Pod：`woc-wx-<id>`
- Service：`woc-wx-<id>`，仅集群内访问，面板反代到 `:3000`
- PVC：`woc-data-<id>`，挂载到实例 `/config`

## 配置项

下列变量由面板进程读取，在 `k8s/deployment.yaml` 的 `env` 中配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WOC_RUNTIME` | `docker` | Kubernetes 部署设为 `kubernetes` |
| `WOC_K8S_NAMESPACE` | 当前 Pod namespace | 面板管理实例资源的 namespace（留空自动读取 ServiceAccount） |
| `WOC_WECHAT_IMAGE` | `docker.io/gloridust/wechat-on-cloud:latest` | 实例镜像 |
| `WOC_K8S_STORAGE_SIZE` | `10Gi` | 每个实例 PVC 容量 |
| `WOC_K8S_STORAGE_CLASS` | 空 | 留空使用默认 StorageClass |
| `WOC_K8S_IMAGE_PULL_POLICY` | `IfNotPresent` | 实例 Pod 镜像拉取策略 |
| `PANEL_ALLOWED_HOSTS` | 空 | 使用 Ingress 域名时必须填写对外域名 |

通过 Ingress 暴露面板时，把对外域名填进 `PANEL_ALLOWED_HOSTS`，并参考 `k8s/ingress.example.yaml`。

## 限制

- Kubernetes 模式不挂载宿主 `docker.sock`。
- Kubernetes 模式第一版不支持摄像头宿主设备直通。
- 内存 watchdog 在 Kubernetes 模式不依赖 metrics-server；没有 metrics API 时内存值显示为 0，HTTP 响应性自愈仍可使用。
- 实例数据依赖集群 StorageClass。没有默认 StorageClass 时，需要设置 `WOC_K8S_STORAGE_CLASS`。

## 卸载

仅删除面板和运行中实例：

```bash
kubectl delete -k k8s
```

删除后，如果保留了实例 PVC，可用以下命令查看：

```bash
kubectl -n wechat-on-cloud get pvc -l app.kubernetes.io/name=wechat-on-cloud
```
