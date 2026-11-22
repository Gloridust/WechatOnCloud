// 发布门禁用（scripts/gate/data-root-desktop.sh）：让面板以为自己跑在 Docker Desktop 上。
// 只改 docker.info() 返回的 OperatingSystem，其余 Docker 调用原样走宿主的 docker.sock。
// 经 NODE_OPTIONS=--require 预加载，面板代码不需要任何测试开关。
const Docker = require('/app/node_modules/dockerode');
const info = Docker.prototype.info;
Docker.prototype.info = async function (...args) {
  const r = await info.apply(this, args);
  return { ...r, OperatingSystem: 'Docker Desktop (simulated)' };
};
