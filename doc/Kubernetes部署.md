# Kubernetes 部署

WechatOnCloud 支持两种运行时：

- `WOC_RUNTIME=docker`：默认模式，面板通过 `/var/run/docker.sock` 创建实例容器。
- `WOC_RUNTIME=kubernetes`：面板通过 Kubernetes API 为每个实例创建一个 StatefulSet（及其 Pod）、PVC 和 Service。

Docker / Compose 部署完全不受影响；本文只覆盖 Kubernetes 模式。

## 快速部署

```bash
# （推荐）先设置自己的管理员口令；省略则回退到默认 admin/wechat 并强制改密
kubectl create namespace wechat-on-cloud
kubectl -n wechat-on-cloud create secret generic woc-panel-admin \
  --from-literal=username=admin --from-literal=password='你的强口令'

kubectl apply -k k8s
kubectl -n wechat-on-cloud port-forward svc/woc-panel 8080:8080
```

访问 `http://127.0.0.1:8080`。管理员账号来自可选 Secret `woc-panel-admin`（模板见 `k8s/secret.example.yaml`）：未创建该 Secret 时，面板回退到默认 `admin / wechat` 并在首次登录强制改密——生产环境务必创建 Secret 或尽快改密。`kubectl apply -k k8s` 不会应用该 Secret（不在 kustomization 内），避免把口令提交进源码。

## 资源模型

面板自身：

- Deployment：`woc-panel`
- Service：`woc-panel`
- PVC：`woc-panel-data`，保存账号、实例登记、日志
- ServiceAccount：`woc-panel`（绑定的 Role 仅在本 namespace 内可管理 pods / pods/log / pods/exec / services / persistentvolumeclaims，以及 apps/statefulsets）
- Secret（可选）：`woc-panel-admin`，设置首个管理员账号 / 密码

每个实例：

- StatefulSet：`woc-wx-<id>`，`replicas` 即运行态（1=运行 / 0=停止）。`updateStrategy: OnDelete`，模板变更（镜像 / MAC / 环境变量）在 Pod 被重建时才生效。
- Pod：`woc-wx-<id>-0`（StatefulSet 副本 0）。exec / 日志 / 文件 / 数据卷操作都针对此 Pod 名，而非工作负载/Service 名 `woc-wx-<id>`。
- Service：`woc-wx-<id>`（ClusterIP），仅集群内访问，面板反代到 `:3000`；另有一个无头治理 Service `woc-wx-<id>-headless`（`clusterIP: None`，供 StatefulSet `serviceName` 使用）。
- PVC：`woc-data-<id>`，挂载到实例 `/config`（显式命名，不用 `volumeClaimTemplates`，以保留按名复用旧卷的能力）。

生命周期：启动/重启=确保 StatefulSet 存在并 `replicas=1`（重启会重建 Pod）；停止=`replicas=0` 并等待 Pod 消失；删除实例=删 StatefulSet + Service(s)（可选删 PVC）。从旧版「直连 Pod」分支升级时，面板会在拉起 StatefulSet Pod 前自动删除同名遗留裸 Pod `woc-wx-<id>`，避免 Service 同时选中新旧两个 Pod。

## 配置项

下列变量由面板进程读取，在 `k8s/deployment.yaml` 的 `env` 中配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WOC_RUNTIME` | `docker` | Kubernetes 部署设为 `kubernetes` |
| `WOC_K8S_NAMESPACE` | 当前 Pod namespace | 面板管理实例资源的 namespace（留空自动读取 ServiceAccount） |
| `WOC_WECHAT_IMAGE` | `docker.io/gloridust/wechat-on-cloud:latest` | 实例镜像 |
| `WOC_K8S_STORAGE_SIZE` | `10Gi` | 每个实例 PVC 容量 |
| `WOC_K8S_STORAGE_CLASS` | 空 | 留空使用默认 StorageClass |
| `WOC_K8S_IMAGE_PULL_POLICY` | `IfNotPresent` | 实例 Pod 镜像拉取策略。「升级实例」总会强制拉取最新镜像（不受此项影响） |
| `WOC_K8S_IMAGE_PULL_SECRET` | 空 | 私有仓库拉取实例镜像用的 imagePullSecret 名称；留空不附加 |
| `WOC_K8S_CILIUM_MAC_SPOOF` | `0` | 设为 `1` 时给实例 Pod 加 `cni.cilium.io/mac-address` 注解伪装 MAC（仅 Cilium 集群有效；其它 CNI 忽略）。改动后需重建 Pod 才生效 |
| `PANEL_ALLOWED_HOSTS` | 空 | 使用 Ingress 域名时必须填写对外域名 |

通过 Ingress 暴露面板时，把对外域名填进 `PANEL_ALLOWED_HOSTS`，并参考 `k8s/ingress.example.yaml`。

## 限制

- Kubernetes 模式不挂载宿主 `docker.sock`。
- Kubernetes 模式第一版不支持摄像头宿主设备直通；即便设置 `WOC_VIDEO_DEVICES` 也不会生效（该配置仅 Docker 模式可用）。
- `WOC_ENABLE_GPU=1` 在 Kubernetes 模式仅去掉 `DISABLE_DRI`，并不会为 Pod 申请 GPU 设备；需要硬件加速请自行配置 GPU device plugin 的 `resources.limits`。
- 设备伪装：实例 Pod 会设置「像个人电脑」的 hostname（与 Docker 一致）。MAC 伪装需要 CNI 支持：在 Cilium 集群上设 `WOC_K8S_CILIUM_MAC_SPOOF=1`，面板会在 Pod 模板加 `cni.cilium.io/mac-address` 注解，让 Pod 内 `eth0` 读到与 Docker 模式一致、由实例 id 稳定派生的厂商 MAC（仅影响 Pod 内部网卡的静态身份，不改变路由）。其它 CNI 会忽略该注解。注意：该注解只在 Pod 重建时生效——改了开关要「升级实例」/「重启」让 Pod 重建。
- 内存 watchdog 在 Kubernetes 模式不依赖 metrics-server；没有 metrics API 时内存值显示为 0，软/硬内存自愈与面板里的「内存安全阀」对 Kubernetes 实例不起作用，内存上限由 Pod `limits.memory`（设 `WOC_INSTANCE_MEM_GB` 时）+ kubelet OOM 重启保证；HTTP 响应性自愈仍可使用。
- 整卷备份/恢复依赖运行中的 Pod：实例停止（Pod 已删除）时无法备份/恢复，请先启动实例。详见 [数据卷管理](数据卷管理.md)。
- 实例数据依赖集群 StorageClass。没有默认 StorageClass 时，需要设置 `WOC_K8S_STORAGE_CLASS`。
- 实例为每实例一个 StatefulSet：由控制器负责 Pod 恢复，节点驱逐/故障后会在可调度节点上重建 Pod（不再需要手动在面板里重新启动）。但 PVC 为 `ReadWriteOnce`，若 PV 与原节点绑定（local/hostpath 类存储），跨节点重建可能因 Multi-Attach/不可调度而起不来——这取决于集群的 StorageClass 与 CNI，仍需相应的存储能力支撑。

## 卸载

仅删除面板和运行中实例：

```bash
kubectl delete -k k8s
```

删除后，如果保留了实例 PVC，可用以下命令查看：

```bash
kubectl -n wechat-on-cloud get pvc -l app.kubernetes.io/name=wechat-on-cloud
```
