// 面板自更新（watchtower 式）：面板容器无法干净地"重建自己"（执行到删除自己时进程就没了），
// 故由面板先拉新镜像，再派生一个【临时 helper 容器】（用新镜像 + docker.sock）去重建 woc-panel：
//   stop+rm 旧面板 → 用新镜像按旧容器配置重建 → 起来 → 健康检查（稳定运行）→ 成功；
//   若新面板起不来 → 回滚：用旧镜像重新建回面板。helper 干完自行退出。
// 最坏情况（helper 也挂）用户 `docker compose up -d` 即可恢复（与手动方式一致）。
//
// 配置复刻要点：
//   - Env：用「新镜像 baked env」+「旧容器相对旧镜像多出来的 env」（即 compose 注入的运行时变量），
//     这样新 WOC_VERSION 来自新镜像、PANEL_* 等运行时变量保留（不会把旧 WOC_VERSION 带进去）。
//   - Labels：保留（含 com.docker.compose.*，让 compose 之后仍认得这个容器）。
//   - HostConfig：整体复用（binds/docker.sock/端口/重启策略/网络模式）。
//   - 网络：复用全部已连接网络（主网络在 create 时给，其余 create 后 connect）。

import Docker from 'dockerode';
import { appendPanelLog } from './logs.js';

const docker = new Docker();
const PANEL_NAME = process.env.WOC_PANEL_CONTAINER || 'woc-panel';
const UPDATER_NAME = PANEL_NAME + '-updater';

function pull(ref: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(ref, (err: any, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: any) => (e ? reject(e) : resolve()));
    });
  });
}

function envToMap(env?: string[] | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of env || []) {
    const i = e.indexOf('=');
    if (i > 0) m.set(e.slice(0, i), e.slice(i + 1));
  }
  return m;
}

// 由旧容器 inspect + 目标镜像，构造重建用的 create 选项（含 env-diff 与网络）。
async function buildCreateOpts(self: any, imageRef: string): Promise<Docker.ContainerCreateOptions> {
  const newImg: any = await docker.getImage(imageRef).inspect();
  let oldBaked = new Map<string, string>();
  try {
    const oldImg: any = await docker.getImage(self.Image).inspect(); // self.Image = 旧镜像 id
    oldBaked = envToMap(oldImg.Config?.Env);
  } catch {
    /* 旧镜像可能已被新 tag 覆盖且无法 inspect：oldBaked 为空，下面会多带几个 baked env，无害 */
  }
  const newBaked = envToMap(newImg.Config?.Env);
  const containerEnv = envToMap(self.Config?.Env);
  const finalEnv = new Map(newBaked); // 起步：新镜像 baked（含新 WOC_VERSION）
  for (const [k, v] of containerEnv) {
    // compose 注入或覆盖的（旧镜像没有该 key，或容器值与旧 baked 不同）→ 保留
    if (!oldBaked.has(k) || oldBaked.get(k) !== v) finalEnv.set(k, v);
  }
  const cfg = self.Config || {};
  const nets: Record<string, any> = self.NetworkSettings?.Networks || {};
  const netNames = Object.keys(nets);
  const opts: Docker.ContainerCreateOptions = {
    name: String(self.Name || '').replace(/^\//, '') || PANEL_NAME, // 用目标容器自身名字，而非硬编码常量
    Image: imageRef,
    Hostname: cfg.Hostname,
    User: cfg.User || undefined,
    Env: [...finalEnv].map(([k, v]) => `${k}=${v}`),
    Cmd: cfg.Cmd || undefined,
    Entrypoint: cfg.Entrypoint || undefined,
    Labels: cfg.Labels || undefined,
    WorkingDir: cfg.WorkingDir || undefined,
    ExposedPorts: cfg.ExposedPorts || undefined,
    HostConfig: self.HostConfig,
  };
  if (netNames.length) {
    const primary = netNames[0];
    const aliases = (nets[primary].Aliases || []).filter((a: string) => !String(self.Id).startsWith(a));
    opts.NetworkingConfig = { EndpointsConfig: { [primary]: { Aliases: aliases } } };
  }
  return opts;
}

// 面板侧：拉新镜像 + 派生 helper 容器重建自身。返回目标镜像。
let updateInFlight = false;

export async function triggerSelfUpdate(): Promise<{ target: string }> {
  if (updateInFlight) throw new Error('面板更新已在进行中，请稍候');
  updateInFlight = true;
  try {
    return await doSelfUpdate();
  } catch (e) {
    updateInFlight = false; // 失败可重试；成功后面板会被 helper 重建、本进程退出，无需复位
    throw e;
  }
}

async function doSelfUpdate(): Promise<{ target: string }> {
  const self: any = await docker.getContainer(PANEL_NAME).inspect();
  const ref: string = self.Config.Image; // 如 docker.io/gloridust/woc-panel:latest 或 :v1.2.1
  const repo = ref.split('@')[0].replace(/:[^/:]+$/, ''); // 去 tag
  const target = `${repo}:latest`; // 拉最新发布
  appendPanelLog('WARN', `面板自更新：开始拉取 ${target}`);
  await pull(target);
  appendPanelLog('INFO', `面板自更新：${target} 已拉取，派生 ${UPDATER_NAME} 容器重建面板（数据保留）`);

  const spec = { panelName: PANEL_NAME, newImage: target, oldImageId: self.Image };
  // 仅需 docker.sock；spec 经 env 传入，不依赖 /data 挂载，避免路径不一致。
  const sockBind =
    (self.HostConfig.Binds || []).find((b: string) => b.includes('docker.sock')) || '/var/run/docker.sock:/var/run/docker.sock';
  try {
    await docker.getContainer(UPDATER_NAME).remove({ force: true });
  } catch {
    /* 无旧 updater，正常 */
  }
  const helper = await docker.createContainer({
    name: UPDATER_NAME,
    Image: target,
    Env: ['WOC_UPDATER=1', `WOC_UPDATER_SPEC=${JSON.stringify(spec)}`],
    Cmd: ['npm', 'run', 'updater'],
    HostConfig: {
      Binds: [sockBind],
      NetworkMode: self.HostConfig.NetworkMode, // 与面板同网，便于健康检查按名访问
      RestartPolicy: { Name: 'no' },
      AutoRemove: false, // 保留日志便于排查；下次更新前会先删旧 updater
    },
  });
  await helper.start();
  return { target };
}

// 等容器稳定运行：在 timeoutMs 内，State.Running 持续为真且无新的 crash/退出，视为健康。
async function waitStable(name: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const info: any = await docker.getContainer(name).inspect();
      const s = info.State || {};
      if (s.Running && !s.Restarting) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 8000) return true; // 连续稳定运行 8s
      } else {
        stableSince = 0; // 退出/重启中 → 重新计时
      }
    } catch {
      stableSince = 0; // 容器暂不可读（重建间隙）
    }
  }
  return false;
}

// helper 侧：读取 spec，重建面板；失败回滚到旧镜像。
export async function runUpdaterRecreate(): Promise<void> {
  const spec = JSON.parse(process.env.WOC_UPDATER_SPEC || '{}');
  const { panelName, newImage, oldImageId } = spec;
  if (!panelName || !newImage) {
    console.error('[updater] 缺少 spec，退出');
    return;
  }
  console.log(`[updater] 重建面板 ${panelName} → ${newImage}`);
  await new Promise((r) => setTimeout(r, 2500)); // 稍等：让面板把 HTTP 响应回给前端后再停它，避免前端误报"更新失败"
  const self: any = await docker.getContainer(panelName).inspect(); // 先抓旧配置（停之前）
  const otherNets = Object.keys(self.NetworkSettings?.Networks || {}).slice(1);

  const recreate = async (imageRef: string) => {
    const opts = await buildCreateOpts(self, imageRef);
    try {
      await docker.getContainer(panelName).remove({ force: true });
    } catch {
      /* 已删/不存在 */
    }
    const c = await docker.createContainer(opts);
    for (const net of otherNets) {
      try {
        await docker.getNetwork(net).connect({ Container: c.id });
      } catch {
        /* 次要网络连接失败不致命 */
      }
    }
    await c.start();
    return c;
  };

  // 先停旧面板
  try {
    await docker.getContainer(panelName).stop({ t: 8 } as any);
  } catch {
    /* 已停 */
  }
  try {
    await recreate(newImage);
    if (await waitStable(panelName, 60000)) {
      console.log('[updater] 面板更新成功，新版本已稳定运行');
      return;
    }
    console.error('[updater] 新面板未在限时内稳定运行 → 回滚旧镜像');
  } catch (e) {
    console.error('[updater] 重建新面板失败 → 回滚旧镜像：', e);
  }
  // 回滚
  try {
    await recreate(oldImageId);
    console.error('[updater] 已回滚到旧版本面板（更新失败）');
  } catch (e) {
    console.error('[updater] 回滚失败，请手动 `docker compose up -d` 恢复：', e);
  }
}
