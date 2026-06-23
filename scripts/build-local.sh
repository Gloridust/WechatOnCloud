#!/usr/bin/env bash
# 本地构建面板镜像 + 微信实例镜像，打成与 docker-compose.yml 一致的 GHCR 标签。
# 用途：GHCR 尚未发布（没打 tag）时自测，或自托管者想自己构建而非拉取官方镜像。
# 构建完成后直接 `docker compose up -d` 即可（compose 默认 pull_policy=missing，会优先用本地镜像）。
#
# 用法：
#   ./scripts/build-local.sh                # 构建本机架构，标签 latest
#   WOC_VERSION=v1.0.0 ./scripts/build-local.sh   # 指定标签（需与 .env 的 WOC_VERSION 一致）
set -euo pipefail

OWNER="${WOC_IMAGE_OWNER:-gloridust}"
TAG="${WOC_VERSION:-latest}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 烤进面板镜像的版本号：设了 WOC_VERSION 就用它（如 v1.2.0），否则用 dev-<短SHA>（本地构建标识）。
# 开发版不是正式发布版，面板「关于」会标「开发版」、不会触发「有新版」红点。
VER="${WOC_VERSION:-dev-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)}"

PANEL_IMAGE="ghcr.io/${OWNER}/woc-panel:${TAG}"
WECHAT_IMAGE="ghcr.io/${OWNER}/wechat-on-cloud:${TAG}"

# --provenance=false --sbom=false：本地构建出「单一镜像」而非带 attestation 的 manifest list。
# 否则在 Docker 29 + containerd 镜像存储下，经典 API（docker image inspect / docker run / 面板用的
# dockerode）解析 :tag 时不会跟到新 manifest list、仍指向同名旧镜像 → 重建实例还是用旧镜像（实测踩过）。
# 面板靠 dockerode 跑实例，故实例镜像尤其必须用这俩参数。
echo "==> 构建面板镜像 ${PANEL_IMAGE} （版本号 ${VER}）"
docker build --provenance=false --sbom=false --build-arg "WOC_VERSION=${VER}" -t "${PANEL_IMAGE}" "${ROOT}/panel"

echo "==> 构建微信实例镜像 ${WECHAT_IMAGE}"
docker build --provenance=false --sbom=false -t "${WECHAT_IMAGE}" "${ROOT}/docker"

echo
echo "完成。本地镜像："
# 注意：docker images 只接受一个仓库参数，故用 --filter 各列一次
docker images --filter "reference=${PANEL_IMAGE}" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
docker images --filter "reference=${WECHAT_IMAGE}" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
echo
echo "下一步：docker compose up -d   （记得先把 .env 里 WOC_VERSION 设为 ${TAG}）"
