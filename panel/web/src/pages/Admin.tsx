import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Cropper from 'react-easy-crop';
import { api, APP_LABELS, appProfile, fmtUploadSize, type PanelUser, type InstanceWithStatus, type VolEntry, type AppType, type VersionInfo } from '../api';
import { InstanceIcon, ICON_CHOICES } from '../AppIcon';
import { useUI, PasswordInput, Modal, Field, MenuButton, Spinner, useDocTitle, type MenuEntry } from '../ui';
import { useAuth } from '../auth';
import { Icon, type IconName } from '../icons';
import { statusOf, ThemeToggle, initial } from '../AppShell';

const BUSY_PHASES = ['downloading', 'extracting', 'installing'];

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// docker 的容器状态（Up 5 minutes / Exited (0) 2 hours ago …）翻成中文，残留容器列表里直接给人看
function zhDuration(s: string): string {
  const t = s.trim();
  const m = t.match(/^(\d+|an?|about an?|less than an?)\s+(second|minute|hour|day|week|month|year)s?$/i);
  if (!m) return t;
  const unit: Record<string, string> = { second: '秒', minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月', year: '年' };
  const q = m[1].toLowerCase();
  const n = /^\d+$/.test(q) ? q : q.startsWith('less') ? '不到 1' : q.startsWith('about') ? '约 1' : '1';
  return `${n} ${unit[m[2].toLowerCase()]}`;
}
export function zhDockerStatus(status: string): { text: string; running: boolean } {
  const s = (status || '').trim();
  let m = s.match(/^Up (.+?)(?: \((?:healthy|unhealthy|health: starting)\))?$/i);
  if (m) return { text: `运行中 · ${zhDuration(m[1])}`, running: true };
  m = s.match(/^Exited \((-?\d+)\) (.+) ago$/i);
  if (m) return { text: `已停止 · ${zhDuration(m[2])}前`, running: false };
  if (/^Created/i.test(s)) return { text: '已创建，未启动', running: false };
  if (/^Restarting/i.test(s)) return { text: '反复重启中', running: true };
  if (/^Paused/i.test(s)) return { text: '已暂停', running: false };
  if (/^Dead/i.test(s)) return { text: '已损坏', running: false };
  if (/^Removal/i.test(s)) return { text: '删除中', running: false };
  return { text: s || '状态未知', running: false };
}

// 友好空状态：图标 + 标题 + 说明 + 可选引导按钮
function EmptyState({ icon, title, sub, action }: { icon: IconName; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-blob">
        <Icon name={icon} size={34} strokeWidth={1.6} />
      </div>
      <div className="empty-title">{title}</div>
      {sub && <div className="empty-sub">{sub}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// 勾选列表：分配账号 / 可访问实例。一行一个，勾选状态一眼可见（此前是颜色区分的胶囊，选没选看不出来）
function CheckList({
  options,
  selected,
  onToggle,
  empty,
}: {
  options: { id: string; label: string; sub?: string; lead?: ReactNode }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  empty: ReactNode;
}) {
  if (options.length === 0) return <div className="field-hint">{empty}</div>;
  return (
    <div className="check-list">
      {options.map((o) => (
        <label key={o.id} className="check-row">
          <input type="checkbox" checked={selected.has(o.id)} onChange={() => onToggle(o.id)} />
          <span className="check-box">
            <Icon name="check" size={14} strokeWidth={3} />
          </span>
          {o.lead}
          <span className="check-main">
            <span className="check-title">{o.label}</span>
            {o.sub && <span className="check-sub">{o.sub}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

const RELEASES_URL = 'https://github.com/Gloridust/WechatOnCloud/releases';

const DIAG_RANGE_OPTIONS = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: '1y', label: '1 年' },
];

// 「诊断与日志」（仅管理员）：单实例「日志」只记录该实例日志；这里一键打包全局——系统信息 +
// 面板运维日志 + 全部实例容器状态/日志 + 容器清单，便于排查部署/创建卡死/黑屏不可用等问题。
function DiagnosticsSection() {
  const [range, setRange] = useState('24h');
  const exportBundle = () => {
    // tar.gz 带 content-disposition: attachment，用隐藏 <a> 触发下载（带同源 cookie），不离开页面。
    const a = document.createElement('a');
    a.href = api.diagnosticsUrl(range);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-icon info">
          <Icon name="activity" size={20} />
        </div>
        <div className="panel-titles">
          <div className="panel-title">诊断与日志</div>
          <div className="panel-desc">部署失败、创建卡住、桌面黑屏、升级失败时，导出诊断包发给维护者。包里有系统和 Docker 信息、面板日志、各实例容器的状态和日志，不含密码和密钥。</div>
        </div>
      </div>
      <div className="panel-body">
        <Field label="时间范围">
          <div className="pill-group" role="radiogroup" aria-label="时间范围">
            {DIAG_RANGE_OPTIONS.map((r) => (
              <button key={r.key} type="button" role="radio" aria-checked={range === r.key} className={'pill' + (range === r.key ? ' on' : '')} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
        </Field>
        <div className="panel-actions">
          <button className="btn btn-primary" onClick={exportBundle}>
            <Icon name="download" size={17} />
            导出诊断包
          </button>
          <a className="btn btn-ghost" href={api.panelLogUrl(range)} target="_blank" rel="noreferrer">
            查看面板日志
            <Icon name="external" size={15} />
          </a>
        </div>
        <div className="panel-foot">超过一年的日志会自动清理。</div>
      </div>
    </div>
  );
}

// 「关于」：显示真实构建版本号 + 检测新版（后台已每 6h 查 Docker Hub/GHCR；这里读缓存并可手动重查）。
function AboutSection({ isAdmin }: { isAdmin: boolean }) {
  const { toast, confirm } = useUI();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [outdatedInst, setOutdatedInst] = useState(0); // 镜像落后的实例数（提示"更新面板≠更新实例"）
  const [remoteNewer, setRemoteNewer] = useState(false); // 远端有新实例镜像（本地还没拉）

  useEffect(() => {
    api.getVersion().then(setInfo).catch(() => {});
    if (isAdmin)
      api
        .upgradeStatus()
        .then((s) => {
          setOutdatedInst(s.outdatedCount);
          // 没有任何实例时不提示"实例镜像有新版"（全新安装的噪音）
          setRemoteNewer(s.remoteNewer === true && s.instances.length > 0);
        })
        .catch(() => {});
  }, [isAdmin]);

  // 一键更新面板：拉新镜像 + 派生 helper 容器重建 woc-panel（数据保留，带失败回滚）。
  // 触发后面板会被重建、本连接短暂中断，约 20s 后自动刷新到新版本。
  const selfUpdate = async () => {
    const ok = await confirm({
      title: info?.isDev ? '升级到正式版？' : '更新面板？',
      body: `会拉取最新${info?.isDev ? '正式发布的' : ''}面板镜像并重建面板容器，数据和登录都保留。大约十几秒，期间面板会短暂断开，完成后自动刷新。${info?.latest ? `目标版本 ${info.latest}。` : ''}`,
      confirmText: info?.isDev ? '升级' : '更新',
    });
    if (!ok) return;
    setUpdating(true);
    try {
      const r = await api.selfUpdatePanel();
      toast(r.message || '已开始更新，面板将重启，请稍候…', 'ok');
      window.setTimeout(() => window.location.reload(), 25000); // 等新面板起来后自动刷新
    } catch (e: any) {
      toast(e.message || '更新失败', 'error');
      setUpdating(false);
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.checkUpdate();
      setInfo(r);
      const rel = /^v?\d+\.\d+\.\d+$/.test(r.current);
      if (r.error) toast('检查失败：' + r.error, 'error');
      else if (r.hasUpdate) toast(`发现新版本 ${r.latest}`, 'ok');
      else if (!rel) toast(`最新发布 ${r.latest ?? '未知'}（当前为开发版）`, 'ok');
      else toast('已是最新版本', 'ok');
    } catch (e: any) {
      toast(e.message || '检查失败', 'error');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <img src="/favicon.svg" className="panel-logo" alt="" />
        <div className="panel-titles">
          <div className="panel-title">
            云微 · WechatOnCloud
            {info?.isDev ? <span className="tag tag-muted">开发版</span> : info?.hasUpdate ? <span className="tag tag-warn">有新版</span> : null}
          </div>
          <div className="panel-desc">
            当前版本 <b className="num">{info?.current ?? '…'}</b>
            {info?.latest && !info.error && (info.isDev || info.hasUpdate) && (
              <>
                {'，最新'}
                {info.isDev ? '发布' : ''} <b className="num">{info.latest}</b>
              </>
            )}
            {info && !info.isDev && !info.hasUpdate && info.latest && !info.error && '，已是最新'}
          </div>
        </div>
      </div>
      <div className="panel-body">
        {info?.hasUpdate && (
          <div className="callout callout-warn">
            <Icon name="sparkle" size={18} />
            <div className="callout-body">
              <div className="callout-text">
                {!isAdmin
                  ? '面板有新版本，请联系管理员更新。'
                  : info.isDev
                    ? '当前是开发版（本地或自己构建的）。点「升级到正式版」会拉取最新正式发布的镜像并重建面板，数据和登录保留。'
                    : '点「更新面板」会自动拉取新镜像并重建面板，数据和登录保留，大约十几秒。'}
              </div>
            </div>
          </div>
        )}
        {isAdmin && (outdatedInst > 0 || remoteNewer) && (
          <div className="callout callout-warn">
            <Icon name="upgrade" size={18} />
            <div className="callout-body">
              <div className="callout-text">
                {outdatedInst > 0 ? <>另有 <b>{outdatedInst}</b> 个实例的镜像可以升级。</> : <>实例镜像有新版本。</>}
                面板和实例是两个镜像，更新面板不会顺带升级实例，请到「实例」里点「一键升级」。
              </div>
            </div>
          </div>
        )}
        <div className="panel-actions">
          {info?.hasUpdate && isAdmin && (
            <button className="btn btn-primary" disabled={updating} onClick={selfUpdate}>
              {updating ? <Spinner size="sm" /> : <Icon name="upgrade" size={17} />}
              {updating ? '更新中，请稍候…' : info.isDev ? '升级到正式版' : '更新面板'}
            </button>
          )}
          {isAdmin && (
            <button className="btn" disabled={checking || updating} onClick={check}>
              {checking ? <Spinner size="sm" /> : <Icon name="refresh" size={16} />}
              {checking ? '检查中…' : '检查更新'}
            </button>
          )}
          <a className="btn btn-ghost" href={info?.hasUpdate ? RELEASES_URL + '/latest' : RELEASES_URL} target="_blank" rel="noreferrer">
            {info?.hasUpdate ? '看看新版改了什么' : '发布日志'}
            <Icon name="external" size={15} />
          </a>
        </div>
        {info && (
          <div className="panel-foot">
            {info.checkedAt ? `上次检查 ${fmtDate(info.checkedAt)}` : '还没检查过'}
            {info.source && ` · 来源 ${info.source}`}
            {info.error && ` · ${info.error}`}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Admin({ onOpenMenu, onChangePassword }: { onOpenMenu: () => void; onChangePassword: () => void }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  useDocTitle(isAdmin ? '管理' : '设置');
  const { toast, confirm } = useUI();
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [err, setErr] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);
  const [creatingInst, setCreatingInst] = useState(false);
  const [assignInst, setAssignInst] = useState<InstanceWithStatus | null>(null); // 给实例选账户
  const [assignUser, setAssignUser] = useState<PanelUser | null>(null); // 给账户选实例
  const [resetTarget, setResetTarget] = useState<PanelUser | null>(null); // 重置密码弹窗
  const [renameUserTarget, setRenameUserTarget] = useState<PanelUser | null>(null); // 改用户名弹窗
  const [deleteInst, setDeleteInst] = useState<InstanceWithStatus | null>(null); // 删除实例弹窗
  const [renameInst, setRenameInst] = useState<InstanceWithStatus | null>(null); // 重命名实例弹窗
  const [securityInst, setSecurityInst] = useState<InstanceWithStatus | null>(null); // 安全（内存阈值）弹窗
  const [volumeInst, setVolumeInst] = useState<InstanceWithStatus | null>(null); // 数据卷管理弹窗
  const [iconInst, setIconInst] = useState<InstanceWithStatus | null>(null); // 图标编辑弹窗
  const [acting, setActing] = useState<Record<string, string>>({}); // 实例 id → 进行中的动作文案（启动中/升级中…）
  // 管理页信息架构：实例 / 用户 / 系统 三个 Tab（此前 7 个区块一条长滚动，找东西全靠翻）。
  // 记住上次停留的 Tab（sessionStorage），升级轮询等跨 Tab 状态不受影响——Tab 只控制渲染。
  const [tab, setTabRaw] = useState<'inst' | 'users' | 'system'>(() => {
    const t = sessionStorage.getItem('woc_admin_tab');
    return t === 'users' || t === 'system' ? t : 'inst';
  });
  const setTab = (t: 'inst' | 'users' | 'system') => {
    setTabRaw(t);
    try {
      sessionStorage.setItem('woc_admin_tab', t);
    } catch {
      /* ignore */
    }
  };
  const [upg, setUpg] = useState<{ outdatedCount: number; outdatedIds: string[]; remoteNewer: boolean } | null>(null); // 镜像落后的实例 + 远端有新版
  const [upgradingAll, setUpgradingAll] = useState(false);
  const [upgProgress, setUpgProgress] = useState(''); // 一键升级进度文案（"2/5 · 升级「xxx」…"）
  const pollingRef = useRef(false); // 防止 load() 恢复轮询与手动发起的轮询并存
  // 未使用的旧数据卷（来自之前删实例时未勾选"彻底清除"）：允许复用以继承聊天记录，或显式删除。
  const [orphanVols, setOrphanVols] = useState<{ name: string; createdAt?: string; sizeBytes?: number }[]>([]);
  // 残留 woc-wx-* 容器（runInstance 启动失败遗留的 Created 容器等）：占着卷名让删卷报 409。
  const [orphanConts, setOrphanConts] = useState<{ id: string; name: string; status: string; volumeName?: string }[]>([]);
  const setAct = (id: string, label: string | null) =>
    setActing((a) => {
      const n = { ...a };
      if (label) n[id] = label;
      else delete n[id];
      return n;
    });

  const subs = users.filter((u) => u.role !== 'admin');
  const timer = useRef<number | undefined>(undefined);

  const load = async () => {
    if (!isAdmin) return; // 子账号无管理数据权限，管理页只给改密
    try {
      const [{ users }, { instances }] = await Promise.all([api.listUsers(), api.listInstances()]);
      setUsers(users);
      setInstances(instances);
    } catch (e: any) {
      setErr(e.message);
    }
    // 孤儿卷 / 残留容器独立 catch：docker 接口失败不应阻塞用户/实例视图
    try {
      const { volumes } = await api.listOrphanVolumes();
      setOrphanVols(volumes);
    } catch {
      /* ignore */
    }
    try {
      const s = await api.upgradeStatus();
      setUpg({ outdatedCount: s.outdatedCount, outdatedIds: s.outdatedIds, remoteNewer: s.remoteNewer === true });
      // 刷新页面/重进管理页时发现后台一键升级还在跑 → 恢复进度条与轮询
      if (s.upgradeAll.running && !pollingRef.current) void pollUpgradeAll();
    } catch {
      /* ignore：更新检测失败不影响管理页 */
    }
    try {
      const { containers } = await api.listOrphanContainers();
      setOrphanConts(containers);
    } catch {
      /* ignore */
    }
  };

  const removeOrphanCont = async (c: { id: string; name: string }) => {
    const ok = await confirm({
      title: `删除残留容器「${c.name}」？`,
      body: '此容器不属于任何登记实例（多为创建失败遗留）。删除不会动数据卷，删后才能继续清理同名旧数据卷。',
      danger: true,
      confirmText: '删除容器',
    });
    if (!ok) return;
    try {
      await api.deleteOrphanContainer(c.id);
      toast('已删除残留容器，可继续清理数据卷', 'ok');
      setOrphanConts((cs) => cs.filter((x) => x.id !== c.id));
      // 容器走了之后，原本被它占着的卷可能从"被引用"翻成"孤儿"，刷新一次
      try {
        const { volumes } = await api.listOrphanVolumes();
        setOrphanVols(volumes);
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      toast(e.message || '删除失败', 'error');
    }
  };

  const removeOrphanVol = async (name: string) => {
    const ok = await confirm({
      title: `彻底删除数据卷「${name}」？`,
      body: '该卷里保存的微信本地数据（聊天记录缓存等）将永久消失，无法恢复。',
      danger: true,
      confirmText: '彻底删除',
    });
    if (!ok) return;
    try {
      await api.deleteOrphanVolume(name);
      toast('已删除数据卷', 'ok');
      setOrphanVols((vs) => vs.filter((v) => v.name !== name));
    } catch (e: any) {
      toast(e.message || '删除失败', 'error');
    }
  };

  useEffect(() => {
    load();
    return () => window.clearTimeout(timer.current);
  }, []);

  // 安装/更新进行中时轮询进度
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (instances.some((i) => BUSY_PHASES.includes(i.wechat.phase))) timer.current = window.setTimeout(load, 1500);
    return () => window.clearTimeout(timer.current);
  }, [instances]);

  const trigger = async (inst: InstanceWithStatus, kind: 'install' | 'update') => {
    try {
      await (kind === 'install' ? api.instanceWechatInstall(inst.id) : api.instanceWechatUpdate(inst.id));
      setInstances((list) =>
        list.map((i) =>
          i.id === inst.id ? { ...i, wechat: { ...i.wechat, phase: 'downloading', percent: -1, message: '正在准备…' } } : i,
        ),
      );
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 1000);
      toast(kind === 'install' ? `已开始下载${appProfile(inst.appType).label}` : '已开始更新', 'ok');
    } catch (e: any) {
      toast(e.message || '操作失败', 'error');
    }
  };

  // 上传安装包（QQ）：腾讯拒绝下载时，把在电脑浏览器下好的 .deb 传进实例安装（#153）。传完服务端即触发安装
  const pkgInput = useRef<HTMLInputElement>(null);
  const pkgTarget = useRef<InstanceWithStatus | null>(null);
  const pickPackage = (inst: InstanceWithStatus) => {
    pkgTarget.current = inst;
    pkgInput.current?.click();
  };
  const uploadPackage = async (file: File) => {
    const inst = pkgTarget.current;
    if (!inst) return;
    setAct(inst.id, '上传安装包 0%');
    try {
      await api.uploadAppPackage(inst.id, file, (loaded, size) =>
        setAct(inst.id, loaded < size ? `上传安装包 ${Math.floor((loaded / size) * 100)}%` : '上传安装包：写入中'),
      );
      setInstances((list) =>
        list.map((i) =>
          i.id === inst.id ? { ...i, wechat: { ...i.wechat, phase: 'extracting', percent: -1, message: '正在准备安装…' } } : i,
        ),
      );
      toast('安装包已上传，正在安装', 'ok');
    } catch (e: any) {
      toast(e.message || '上传失败', 'error');
    } finally {
      setAct(inst.id, null);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(load, 1000);
  };

  const start = async (inst: InstanceWithStatus) => {
    setAct(inst.id, '启动中…');
    try {
      await api.instanceStart(inst.id);
      toast('实例已启动', 'ok');
      await load();
    } catch (e: any) {
      toast(e.message || '启动失败', 'error');
    } finally {
      setAct(inst.id, null);
    }
  };

  const lifecycle = async (inst: InstanceWithStatus, kind: 'stop' | 'restart' | 'upgrade') => {
    const label = kind === 'stop' ? '停止中…' : kind === 'upgrade' ? '升级中…' : '重启中…';
    setAct(inst.id, label);
    try {
      if (kind === 'upgrade') {
        // 升级是后端异步任务（拉镜像可能数分钟）：发起后轮询 upgradingIds 直到完成，
        // 避免同步等待被反代掐断而误报失败（旧版实况）。
        await api.instanceUpgrade(inst.id);
        toast('已开始升级：拉取最新镜像并重建（后台进行）…', 'info');
        for (let i = 0; i < 400; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          try {
            const s = await api.upgradeStatus();
            if (!s.upgradingIds.includes(inst.id)) {
              // 完成后据"是否仍落后"给结论（失败详情在面板日志）
              if (s.outdatedIds.includes(inst.id)) toast('升级未完成，请查看「面板日志」', 'error');
              else toast('已升级到最新镜像并重启', 'ok');
              break;
            }
          } catch {
            /* 面板短暂不可达，继续轮询 */
          }
        }
      } else {
        await (kind === 'stop' ? api.instanceStop(inst.id) : api.instanceRestart(inst.id));
        toast(kind === 'stop' ? '已停止' : '已重启', 'ok');
      }
      await load();
    } catch (e: any) {
      toast(e.message || '操作失败', 'error');
    } finally {
      setAct(inst.id, null);
    }
  };

  // 轮询一键升级进度直到完成（3s 一次；异常网络下最多轮 30 分钟兜底退出）。
  // 发起升级与"刷新页面后发现后台还在跑"（load 里检测）都走这里。
  const pollUpgradeAll = async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setUpgradingAll(true);
    try {
      for (let i = 0; i < 600; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        try {
          const s = await api.upgradeStatus();
          const p = s.upgradeAll;
          if (p.running) {
            // 拉取阶段 total=0，只显示 phase；进入逐个升级后显示 n/total
            setUpgProgress(p.total ? `${p.done}/${p.total}${p.phase ? ` · ${p.phase}` : ''}` : p.phase || '…');
            continue;
          }
          if (p.total === 0) toast('所有实例已是最新镜像', 'ok');
          else
            toast(
              `升级完成：成功 ${p.total - p.failed}${p.failed ? `、失败 ${p.failed}（看面板日志）` : ''}`,
              p.failed ? 'error' : 'ok',
            );
          break;
        } catch {
          /* 面板短暂不可达（不影响后台任务），继续轮询 */
        }
      }
      await load();
    } finally {
      pollingRef.current = false;
      setUpgradingAll(false);
      setUpgProgress('');
    }
  };

  // 一键升级全部"镜像落后"的实例。后端异步执行（先统一拉镜像、再逐个重建，可能数分钟），
  // 这里发起后轮询 upgrade-status 里的进度，避免单个请求悬死（旧版同步等待被反馈"一直卡死"）。
  const upgradeAll = async () => {
    const n = upg?.outdatedCount || 0;
    const ok = await confirm({
      title: n ? `升级全部 ${n} 个可升级实例？` : '拉取新版镜像并升级全部实例？',
      body: '后台先拉取最新实例镜像，再逐个重建（数据保留）；期间这些实例会短暂重连，可离开本页。',
      confirmText: '全部升级',
    });
    if (!ok) return;
    setUpgradingAll(true);
    try {
      await api.upgradeAllInstances();
      toast('已开始升级（后台进行，可离开本页）…', 'info');
      await pollUpgradeAll();
    } catch (e: any) {
      toast(e.message || '升级失败', 'error');
      setUpgradingAll(false);
      setUpgProgress('');
    }
  };

  const instName = (id: string) => instances.find((i) => i.id === id)?.name || id;
  const usersForInstance = (id: string) => subs.filter((u) => u.allowedInstances.includes(id));

  const toggle = async (u: PanelUser) => {
    try {
      await api.setDisabled(u.id, !u.disabled);
      toast(u.disabled ? '已启用' : '已禁用', 'ok');
    } catch (e: any) {
      toast(e.message, 'error');
    }
    load();
  };
  const removeUser = async (u: PanelUser) => {
    const ok = await confirm({ title: `删除子账号「${u.username}」？`, body: '该账户将无法再登录。', danger: true, confirmText: '删除' });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      toast('已删除', 'ok');
    } catch (e: any) {
      toast(e.message, 'error');
    }
    load();
  };

  const tabs = [
    { key: 'inst' as const, label: '实例', icon: 'box' as IconName, dot: !!(upg?.outdatedCount || upg?.remoteNewer) && instances.length > 0 },
    { key: 'users' as const, label: '账号', icon: 'users' as IconName, dot: false },
    { key: 'system' as const, label: '系统', icon: 'activity' as IconName, dot: orphanConts.length + orphanVols.length > 0 },
  ];
  const leftovers = orphanConts.length + orphanVols.length;

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="icon-btn ws-menu" onClick={onOpenMenu} aria-label="打开菜单">
          <Icon name="menu" size={21} />
        </button>
        <span className="ws-title">
          <span className="ws-title-text">{isAdmin ? '管理' : '设置'}</span>
        </span>
        <ThemeToggle />
      </header>

      <main className="content">
        {err && (
          <div className="callout callout-danger" style={{ marginBottom: 18 }}>
            <Icon name="alert" size={18} />
            <div className="callout-body">
              <div className="callout-text">{err}</div>
            </div>
          </div>
        )}

        {/* 三个 Tab：实例（日常）/ 账号（偶尔配置）/ 系统（出事才看：残留资源、诊断、关于）。
            Tab 上的红点提示「这里有事要处理」，免得藏进 Tab 的事被漏看。右侧放当前 Tab 的主操作。 */}
        {isAdmin && (
          <div className="admin-head">
            <div className="seg-tabs" role="tablist" aria-label="管理分区">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  className={'seg-tab' + (tab === t.key ? ' active' : '')}
                  onClick={() => setTab(t.key)}
                >
                  <Icon name={t.icon} size={16} />
                  {t.label}
                  {t.dot && <span className="seg-dot" aria-label="有待处理事项" />}
                </button>
              ))}
            </div>
            {tab === 'inst' && instances.length > 0 && (
              <button className="btn btn-primary btn-sm admin-add" aria-label="新建实例" title="新建实例" onClick={() => setCreatingInst(true)}>
                <Icon name="plus" size={17} />
                <span className="admin-add-label">新建实例</span>
              </button>
            )}
            {tab === 'users' && subs.length > 0 && (
              <button className="btn btn-primary btn-sm admin-add" aria-label="新建子账号" title="新建子账号" onClick={() => setCreatingUser(true)}>
                <Icon name="plus" size={17} />
                <span className="admin-add-label">新建子账号</span>
              </button>
            )}
          </div>
        )}

        {isAdmin && tab === 'inst' && (
          <>
            {!!(upg?.outdatedCount || upg?.remoteNewer) && instances.length > 0 && (
              <div className="callout callout-warn" style={{ marginBottom: 18 }}>
                <Icon name="upgrade" size={19} />
                <div className="callout-body">
                  <div className="callout-title">{upg.outdatedCount ? `${upg.outdatedCount} 个实例可以升级` : '实例镜像有新版本'}</div>
                  <div className="callout-text">升级会拉取新镜像并重建容器，聊天记录和登录都保留。面板和实例是两个镜像，更新面板不会顺带升级实例。</div>
                </div>
                <div className="callout-actions">
                  <button className="btn btn-primary btn-sm" disabled={upgradingAll} onClick={upgradeAll}>
                    {upgradingAll ? <Spinner size="sm" /> : <Icon name="upgrade" size={16} />}
                    {upgradingAll ? `升级中 ${upgProgress || '…'}` : '一键升级'}
                  </button>
                </div>
              </div>
            )}
            {instances.length === 0 ? (
              <EmptyState
                icon="box"
                title="还没有实例"
                sub="一个实例就是一个独立的微信、QQ 或浏览器，跑在自己的容器里，数据互不相通。"
                action={
                  <button className="btn btn-primary" onClick={() => setCreatingInst(true)}>
                    <Icon name="plus" size={18} />
                    新建实例
                  </button>
                }
              />
            ) : (
              <div className="inst-grid">
                {instances.map((inst) => (
                  <InstanceAdminCard
                    key={inst.id}
                    inst={inst}
                    outdated={!!upg?.outdatedIds.includes(inst.id)}
                    userCount={usersForInstance(inst.id).length}
                    acting={acting[inst.id]}
                    onEnter={() => nav(`/i/${inst.id}`)}
                    onTrigger={trigger}
                    onPackage={() => pickPackage(inst)}
                    onStart={() => start(inst)}
                    onStop={() => lifecycle(inst, 'stop')}
                    onRestart={() => lifecycle(inst, 'restart')}
                    onUpgrade={() => lifecycle(inst, 'upgrade')}
                    onRename={() => setRenameInst(inst)}
                    onAssign={() => setAssignInst(inst)}
                    onDelete={() => setDeleteInst(inst)}
                    onSecurity={() => setSecurityInst(inst)}
                    onVolume={() => setVolumeInst(inst)}
                    onIcon={() => setIconInst(inst)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {isAdmin && tab === 'users' && (
          <section className="section">
            <div className="section-row">
              <span className="section-title">
                子账号 {subs.length > 0 && <span className="section-count">{subs.length}</span>}
              </span>
            </div>
            <p className="section-desc">子账号只能看到分配给它的实例，不能进入「管理」。适合家人、同事各用各的微信。</p>
            {subs.length === 0 ? (
              <EmptyState
                icon="users"
                title="还没有子账号"
                sub="新建子账号后，把实例分给它，对方用自己的账号登录面板就只看得到这些实例。"
                action={
                  <button className="btn btn-primary" onClick={() => setCreatingUser(true)}>
                    <Icon name="plus" size={18} />
                    新建子账号
                  </button>
                }
              />
            ) : (
              <div className="list-card">
                {subs.map((u) => (
                  <div key={u.id} className="list-row">
                    <span className={'row-av' + (u.disabled ? ' muted-av' : '')}>{initial(u.username)}</span>
                    <div className="row-main">
                      <div className="row-title">
                        <span className="row-title-text">{u.username}</span>
                        {u.disabled && <span className="tag tag-off">已停用</span>}
                      </div>
                      {u.allowedInstances.length > 0 ? (
                        <div className="chip-row">
                          {u.allowedInstances.map((id) => {
                            const ins = instances.find((i) => i.id === id);
                            return (
                              <span key={id} className={'chip' + (ins ? '' : ' no-icon')}>
                                {ins && <InstanceIcon icon={ins.icon} appType={ins.appType} size={16} radius={5} />}
                                {instName(id)}
                              </span>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="row-sub">还没有分配实例，登录后什么也看不到</div>
                      )}
                    </div>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => setAssignUser(u)} title="选择这个子账号能访问哪些实例">
                        <Icon name="box" size={16} />
                        <span className="hide-sm">分配实例</span>
                      </button>
                      <MenuButton
                        className="icon-btn"
                        label={`子账号「${u.username}」的更多操作`}
                        items={[
                          { label: '改用户名', icon: 'pencil', onClick: () => setRenameUserTarget(u) },
                          { label: '重置密码', icon: 'key', onClick: () => setResetTarget(u) },
                          { label: u.disabled ? '启用' : '停用', icon: u.disabled ? 'checkCircle' : 'ban', onClick: () => toggle(u), hint: u.disabled ? '恢复登录' : '暂时不让登录，已登录的会话立即失效' },
                          'sep',
                          { label: '删除子账号', icon: 'trash', danger: true, onClick: () => removeUser(u) },
                        ]}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* 我的账号：所有人（含子账号）都能在此改密。管理员放「账号」Tab，子账号没有 Tab 直接显示 */}
        {(!isAdmin || tab === 'users') && (
          <section className="section">
            <div className="section-row">
              <span className="section-title">我的账号</span>
            </div>
            <div className="list-card">
              <div className="list-row">
                <span className="row-av">{initial(user?.username)}</span>
                <div className="row-main">
                  <div className="row-title">
                    <span className="row-title-text">{user?.username}</span>
                    <span className="tag tag-muted">{isAdmin ? '管理员' : '子账号'}</span>
                  </div>
                  <div className="row-sub">{isAdmin ? '可以访问和管理全部实例' : `可以访问 ${user?.allowedInstances.length ?? 0} 个实例`}</div>
                </div>
                <div className="row-actions">
                  <button className="btn btn-sm" onClick={onChangePassword}>
                    <Icon name="key" size={16} />
                    修改密码
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {isAdmin && tab === 'system' && leftovers > 0 && (
          <section className="section">
            <div className="section-row">
              <span className="section-title">
                待清理 <span className="section-count">{leftovers}</span>
              </span>
            </div>
            <p className="section-desc">这些容器和数据卷不属于任何实例，多是创建失败、或删除实例时保留下来的。残留容器占着数据卷的名字，要先删容器，才能删同名的数据卷。</p>
            <div className="list-card">
              {orphanConts.map((c) => {
                const st = zhDockerStatus(c.status);
                return (
                  <div key={c.id} className="list-row">
                    <span className="row-av muted-av">
                      <Icon name="box" size={18} />
                    </span>
                    <div className="row-main">
                      <div className="row-title mono">
                        <span className="row-title-text">{c.name}</span>
                        <span className={'tag ' + (st.running ? 'tag-warn' : 'tag-off')}>{st.text}</span>
                      </div>
                      <div className="row-sub">残留容器{c.volumeName ? ` · 占着数据卷 ${c.volumeName}` : ''}</div>
                    </div>
                    <div className="row-actions">
                      <button className="btn btn-sm btn-ghost danger" onClick={() => removeOrphanCont(c)}>
                        <Icon name="trash" size={16} />
                        <span className="hide-sm">删除</span>
                      </button>
                    </div>
                  </div>
                );
              })}
              {orphanVols.map((v) => (
                <div key={v.name} className="list-row">
                  <span className="row-av muted-av">
                    <Icon name="database" size={18} />
                  </span>
                  <div className="row-main">
                    <div className="row-title mono">
                      <span className="row-title-text">{v.name}</span>
                    </div>
                    <div className="row-sub">
                      没在用的数据卷
                      {v.createdAt ? ` · ${v.createdAt.slice(0, 10)} 创建` : ''}
                      {typeof v.sizeBytes === 'number' ? ` · ${fmtBytes(v.sizeBytes)}` : ''}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => setCreatingInst(true)} title="新建实例时选择复用这个数据卷，能接着用里面的聊天记录">
                      <Icon name="plus" size={16} />
                      <span className="hide-sm">复用</span>
                    </button>
                    <button className="btn btn-sm btn-ghost danger" onClick={() => removeOrphanVol(v.name)}>
                      <Icon name="trash" size={16} />
                      <span className="hide-sm">删除</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {isAdmin && tab === 'system' && (
          <section className="section">
            <DiagnosticsSection />
          </section>
        )}
        {(!isAdmin || tab === 'system') && (
          <section className="section">
            <AboutSection isAdmin={isAdmin} />
          </section>
        )}
      </main>

      {creatingUser && (
        <CreateUser
          instances={instances}
          onClose={() => setCreatingUser(false)}
          onDone={() => {
            setCreatingUser(false);
            toast('子账号已创建', 'ok');
            load();
          }}
        />
      )}
      {creatingInst && (
        <CreateInstance
          subs={subs}
          onClose={() => setCreatingInst(false)}
          onDone={() => {
            setCreatingInst(false);
            if (tab !== 'inst') setTab('inst');
            load();
          }}
        />
      )}
      {assignInst && (
        <AssignUsers
          inst={assignInst}
          subs={subs}
          onClose={() => setAssignInst(null)}
          onDone={() => {
            setAssignInst(null);
            toast('已保存', 'ok');
            load();
          }}
        />
      )}
      {assignUser && (
        <AssignInstances
          user={assignUser}
          instances={instances}
          onClose={() => setAssignUser(null)}
          onDone={() => {
            setAssignUser(null);
            toast('已保存', 'ok');
            load();
          }}
        />
      )}
      {resetTarget && (
        <ResetPassword
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => {
            setResetTarget(null);
            toast('密码已重置', 'ok');
          }}
        />
      )}
      {renameUserTarget && (
        <RenameUser
          user={renameUserTarget}
          onClose={() => setRenameUserTarget(null)}
          onDone={() => {
            setRenameUserTarget(null);
            toast('用户名已修改', 'ok');
            load();
          }}
        />
      )}
      {deleteInst && (
        <DeleteInstance
          inst={deleteInst}
          onClose={() => setDeleteInst(null)}
          onDone={() => {
            setDeleteInst(null);
            toast('实例已删除', 'ok');
            load();
          }}
        />
      )}
      {renameInst && (
        <RenameInstance
          inst={renameInst}
          onClose={() => setRenameInst(null)}
          onDone={() => {
            setRenameInst(null);
            toast('已重命名', 'ok');
            load();
          }}
        />
      )}
      {securityInst && (
        <InstanceSecurity
          inst={securityInst}
          onClose={() => setSecurityInst(null)}
          onDone={() => {
            toast('已保存', 'ok');
            load();
          }}
        />
      )}
      {volumeInst && <VolumeManager inst={volumeInst} onClose={() => setVolumeInst(null)} onChanged={load} />}
      <input
        ref={pkgInput}
        type="file"
        accept=".deb"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void uploadPackage(f);
        }}
      />
      {iconInst && (
        <InstanceIconEditor
          inst={iconInst}
          onClose={() => setIconInst(null)}
          onDone={() => {
            toast('图标已更新', 'ok');
            load();
          }}
        />
      )}
    </div>
  );
}

function RenameInstance({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(inst.name);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.renameInstance(inst.id, name.trim());
      onDone();
    } catch (e: any) {
      setErr(e.message || '重命名失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="重命名实例"
      size="sm"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || name.trim() === inst.name}>
            保存
          </button>
        </>
      }
    >
      <Field label="实例名称" hint="最多 30 个字" error={err || undefined}>
        <input className="input" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function RenameUser({ user, onClose, onDone }: { user: PanelUser; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(user.username);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.renameUser(user.id, name.trim());
      onDone();
    } catch (e: any) {
      setErr(e.message || '改名失败');
    } finally {
      setBusy(false);
    }
  };
  const valid = /^[a-zA-Z0-9_]{3,20}$/.test(name.trim());
  return (
    <Modal
      title="修改用户名"
      subtitle={`当前：${user.username}`}
      size="sm"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !valid || name.trim() === user.username}>
            保存
          </button>
        </>
      }
    >
      <Field
        label="新用户名"
        hint="3–20 位字母、数字或下划线。对方下次登录要用新用户名，已登录的不受影响。"
        error={name.trim() && !valid ? '只能用 3–20 位字母、数字或下划线' : err || undefined}
      >
        <input className="input" autoCapitalize="off" autoCorrect="off" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }: { user: PanelUser; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && pw !== confirm;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw !== confirm) {
      setErr('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await api.resetUser(user.id, pw);
      onDone();
    } catch (e: any) {
      setErr(e.message || '重置失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`重置「${user.username}」的密码`}
      subtitle="对方已登录的设备会被退出"
      size="sm"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || pw.length < 6 || pw !== confirm}>
            重置
          </button>
        </>
      }
    >
      <Field label="新密码" hint="至少 6 位" error={pw.length > 0 && pw.length < 6 ? '至少 6 位' : undefined}>
        <PasswordInput autoComplete="new-password" value={pw} onChange={setPw} autoFocus />
      </Field>
      <Field label="再输一次" error={mismatch ? '两次输入的新密码不一致' : err || undefined}>
        <PasswordInput autoComplete="new-password" value={confirm} onChange={setConfirm} invalid={mismatch} />
      </Field>
    </Modal>
  );
}

// 「安全」弹窗：编辑某实例的内存安全阀（soft / hard）。
// soft：超过且无人在远程会话时主动重启（柔和自愈，不打扰）
// hard：超过即强制重启（无视会话，防止 OOM）
// 留空 = 使用面板全局默认（来自 env）。
function InstanceSecurity({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const { toast, confirm } = useUI();
  const [data, setData] = useState<import('../api').MemLimits | null>(null);
  // 输入字段：空串 = "使用默认"（→ 提交时映射为 null）
  const [softStr, setSoftStr] = useState('');
  const [hardStr, setHardStr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  const regenMachineId = async () => {
    const ok = await confirm({
      title: '重置该实例的设备 ID？',
      body: '会生成一个全新的设备标识（machine-id）并重启实例，相当于"换一台新设备"。微信需要重新扫码登录。适用于该账号被微信判定设备风险、登录即被强制退出的情况。',
      danger: true,
      confirmText: '重置并重启',
    });
    if (!ok) return;
    setRegenBusy(true);
    try {
      await api.regenMachineId(inst.id);
      toast('已重置设备 ID，实例正在重启，请稍后重新扫码登录', 'ok');
      onClose();
      onDone();
    } catch (e: any) {
      toast(e.message || '重置失败', 'error');
    } finally {
      setRegenBusy(false);
    }
  };

  // 首次加载 + 每 5s 刷新 currentMB（运行实例的实时内存）
  useEffect(() => {
    let alive = true;
    const fetchOnce = async (initial: boolean) => {
      try {
        const d = await api.getInstanceMemLimits(inst.id);
        if (!alive) return;
        setData(d);
        if (initial) {
          setSoftStr(d.soft == null ? '' : String(d.soft));
          setHardStr(d.hard == null ? '' : String(d.hard));
          setLoaded(true);
        }
      } catch (e: any) {
        if (alive && initial) {
          setErr(e?.message || '读取失败');
          setLoaded(true);
        }
      }
    };
    fetchOnce(true);
    const t = window.setInterval(() => fetchOnce(false), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [inst.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    const parse = (s: string): number | null => {
      const t = s.trim();
      if (t === '') return null;
      const n = Number(t);
      if (!Number.isInteger(n)) throw new Error('阈值需为整数（MiB）');
      return n;
    };
    let s: number | null;
    let h: number | null;
    try {
      s = parse(softStr);
      h = parse(hardStr);
    } catch (e: any) {
      setErr(e.message);
      return;
    }
    if (s != null && h != null && s >= h) {
      setErr('柔和重启的阈值要小于强制重启的');
      return;
    }
    setBusy(true);
    try {
      await api.setInstanceMemLimits(inst.id, s, h);
      onDone();
      onClose();
    } catch (e: any) {
      setErr(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const resetToDefault = () => {
    setSoftStr('');
    setHardStr('');
  };

  return (
    <Modal
      title="内存与设备"
      subtitle={inst.name}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={resetToDefault} disabled={busy || !loaded || !data} title="清空两个阈值，改用面板默认">
            恢复默认
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !loaded || !data}>
            保存
          </button>
        </>
      }
    >
      {!loaded ? (
        <div className="stack" aria-label="读取中">
          <div className="skeleton" style={{ height: 18, width: '80%' }} />
          <div className="skeleton" style={{ height: 78 }} />
          <div className="skeleton" style={{ height: 66 }} />
        </div>
      ) : !data ? (
        <div className="error">{err || '读取失败'}</div>
      ) : (
        <>
          <p className="modal-text">KasmVNC 长时间运行会慢慢涨内存。面板定时巡检，超过阈值就自动重启这个实例，聊天记录和登录都不受影响。</p>
          <dl className="kv security-status">
            <dt>当前内存</dt>
            <dd>{data.currentMB > 0 ? `${data.currentMB} MiB` : '—'}</dd>
            <dt>面板默认</dt>
            <dd>
              柔和 {data.defaultSoft} · 强制 {data.defaultHard} MiB
            </dd>
            <dt>巡检</dt>
            <dd>{data.watchdogEnabled ? `每 ${data.intervalSec} 秒一次` : '已关闭'}</dd>
          </dl>
          <div className="two-col">
            <Field label="柔和重启（MiB）" hint={`超过且没人在用时才重启。留空用默认 ${data.defaultSoft}`}>
              <input className="input num" inputMode="numeric" placeholder={`${data.defaultSoft}`} value={softStr} onChange={(e) => setSoftStr(e.target.value.replace(/[^0-9]/g, ''))} />
            </Field>
            <Field label="强制重启（MiB）" hint={`超过就重启，不管有没有人在用。留空用默认 ${data.defaultHard}`}>
              <input className="input num" inputMode="numeric" placeholder={`${data.defaultHard}`} value={hardStr} onChange={(e) => setHardStr(e.target.value.replace(/[^0-9]/g, ''))} />
            </Field>
          </div>
          <div className="field-hint">日常大约用 1500 MiB。柔和阈值建议略高一些（如 2000），强制阈值建议明显低于宿主可用内存（如 3000~4000）。</div>
          {err && <div className="error">{err}</div>}
          <div className="danger-zone">
            <div className="danger-zone-title">重置设备 ID</div>
            <div className="field-hint" style={{ color: 'var(--text-2)' }}>
              微信会根据设备标识做风控。如果这个账号被判定设备风险、登录后反复被强制退出，可以换一个全新的设备 ID（相当于换了台新设备），再重新扫码登录。会重启这个实例。
            </div>
            <div>
              <button type="button" className="btn btn-sm btn-ghost danger" onClick={regenMachineId} disabled={regenBusy || busy}>
                {regenBusy ? <Spinner size="sm" /> : <Icon name="refresh" size={16} />}
                {regenBusy ? '重置中…' : '重置设备 ID 并重启'}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function DeleteInstance({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const [purge, setPurge] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.deleteInstance(inst.id, purge);
      onDone();
    } catch (e: any) {
      setErr(e.message || '删除失败');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`删除实例「${inst.name}」？`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={submit}>
            {busy && <Spinner size="sm" />}
            {purge ? '连数据一起删除' : '删除实例'}
          </button>
        </>
      }
    >
      <p className="modal-text">容器会被删除。聊天记录（数据卷）默认保留，以后新建实例时可以选择复用，接着用。</p>
      <label className={'check-row purge-opt danger' + (purge ? ' on' : '')}>
        <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
        <span className="check-box">
          <Icon name="check" size={14} strokeWidth={3} />
        </span>
        <span className="check-main">
          <span className="check-title">同时永久删除聊天记录（数据卷）</span>
          <span className="check-sub">删掉就找不回来了</span>
        </span>
      </label>
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}

// 管理页的实例卡片：一眼看清「是什么、什么状态、下一步该点什么」。
// 主按钮随状态变：在线→进入实例，没装→下载安装，装失败→重试，停着→启动；其余操作收进「更多」菜单分组列出。
function InstanceAdminCard({
  inst,
  outdated,
  userCount,
  acting,
  onEnter,
  onTrigger,
  onPackage,
  onStart,
  onStop,
  onRestart,
  onUpgrade,
  onRename,
  onAssign,
  onDelete,
  onSecurity,
  onVolume,
  onIcon,
}: {
  inst: InstanceWithStatus;
  outdated?: boolean;
  userCount: number;
  acting?: string;
  onEnter: () => void;
  onTrigger: (inst: InstanceWithStatus, kind: 'install' | 'update') => void;
  onPackage: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onUpgrade: () => void;
  onRename: () => void;
  onAssign: () => void;
  onDelete: () => void;
  onSecurity: () => void;
  onVolume: () => void;
  onIcon: () => void;
}) {
  const wx = inst.wechat;
  const busy = BUSY_PHASES.includes(wx.phase);
  const installed = wx.installed && wx.phase !== 'downloading';
  const offline = inst.runtime !== 'running';
  const profile = appProfile(inst.appType);
  const st = statusOf(inst);
  const errored = !offline && !busy && wx.phase === 'error';
  const ready = installed || !profile.needsInstall;

  const badge = acting ? { text: '处理中', cls: 'tag-busy' } : { text: st.text, cls: st.tag };
  const sub = installed && wx.version ? `${profile.label} ${wx.version}` : ready ? profile.label : `${profile.label} · 还没安装`;

  // calm = 一切正常时的「进入实例」用柔和按钮；实心绿只留给需要管理员动手的状态（启动 / 安装 / 重试），一屏卡片里一眼能挑出来
  type Primary = { label: string; icon: IconName; onClick?: () => void; disabled?: boolean; calm?: boolean };
  let primary: Primary;
  if (acting) primary = { label: '请稍候', icon: 'refresh', disabled: true };
  else if (offline) primary = { label: inst.runtime === 'missing' ? '创建并启动' : '启动', icon: 'power', onClick: onStart };
  else if (busy) primary = { label: '安装中', icon: 'download', disabled: true };
  else if (ready) primary = { label: '进入实例', icon: 'arrowRight', onClick: onEnter, calm: true };
  else if (errored) primary = { label: '重试安装', icon: 'refresh', onClick: () => onTrigger(inst, 'install') };
  else primary = { label: `下载安装${profile.label}`, icon: 'download', onClick: () => onTrigger(inst, 'install') };

  const items: MenuEntry[] = [
    profile.needsInstall && !offline && { section: profile.label },
    profile.needsInstall && !offline && installed && { label: profile.updateLabel, icon: 'refresh', onClick: () => onTrigger(inst, 'update'), disabled: busy },
    profile.needsInstall && !offline && !installed && errored && { label: '下载安装', icon: 'download', onClick: () => onTrigger(inst, 'install') },
    profile.packageUpload && !offline && {
      label: '上传安装包',
      icon: 'package',
      onClick: onPackage,
      disabled: busy,
      hint: '腾讯拒绝下载时：在电脑浏览器打开 im.qq.com/linuxqq 下载 Linux 版的 .deb，从这里传进实例安装',
    },
    { section: '实例' },
    { label: '升级实例', icon: 'upgrade', onClick: onUpgrade, hint: '拉取最新镜像并重建容器，聊天记录保留' },
    !offline && { label: '重启', icon: 'restart', onClick: onRestart },
    !offline && { label: '停止', icon: 'stop', onClick: onStop },
    { label: '查看日志', icon: 'logs', onClick: () => window.open(api.instanceLogsUrl(inst.id), '_blank') },
    { section: '设置' },
    { label: '重命名', icon: 'pencil', onClick: onRename },
    { label: '分配账号', icon: 'users', onClick: onAssign },
    { label: '图标', icon: 'image', onClick: onIcon },
    { label: '数据卷', icon: 'database', onClick: onVolume, hint: '整卷备份与恢复、导入 PC 微信数据、管理文件' },
    { label: '内存与设备', icon: 'shield', onClick: onSecurity, hint: '内存超限自动重启的阈值；重置设备 ID' },
    'sep',
    { label: '删除实例', icon: 'trash', danger: true, onClick: onDelete },
  ];

  const imgVer = inst.imageVersion
    ? /^\d+\.\d+\.\d+$/.test(inst.imageVersion)
      ? `v${inst.imageVersion}`
      : inst.imageVersion.slice(0, 8)
    : '';

  return (
    <div className="inst-card">
      <div className="ic-head">
        <InstanceIcon icon={inst.icon} appType={inst.appType} size={44} radius={13} />
        <div className="ic-titles">
          <div className="ic-name" title={inst.name}>
            {inst.name}
          </div>
          <div className="ic-sub">{sub}</div>
        </div>
        <span className={'tag ' + badge.cls}>{badge.text}</span>
      </div>

      {(busy || acting) && (
        <div className="ic-progress" aria-live="polite">
          <div className="ic-progress-text">
            <span>{acting || wx.message || '请稍候…'}</span>
            {!acting && wx.percent >= 0 && <span className="num">{wx.percent}%</span>}
          </div>
          <div className="wx-progress">
            <div
              className={'wx-progress-bar' + (acting || wx.percent < 0 ? ' indeterminate' : '')}
              style={!acting && wx.percent >= 0 ? { width: `${wx.percent}%` } : undefined}
            />
          </div>
        </div>
      )}

      {errored && !acting && (
        <div className="ic-error">
          <Icon name="alert" size={15} />
          <span>{wx.message || '安装失败，可以重试'}</span>
        </div>
      )}

      <div className="ic-meta">
        {outdated && !acting && <span className="tag tag-warn">可升级</span>}
        {imgVer && (
          <span
            className="ic-meta-item"
            title={/^\d+\.\d+\.\d+$/.test(inst.imageVersion || '') ? '这个实例正在运行的镜像版本' : '本地自己构建的镜像（没有发布版本号，显示镜像短 id）'}
          >
            <Icon name="box" size={14} />
            {imgVer}
          </span>
        )}
        <span className="ic-meta-item" title="能访问这个实例的子账号（管理员能访问全部实例）">
          <Icon name="users" size={14} />
          {userCount ? `${userCount} 个子账号` : '仅管理员'}
        </span>
      </div>

      <div className="ic-actions">
        <button
          className={'btn btn-sm ic-primary' + (primary.disabled ? '' : primary.calm ? ' btn-soft' : ' btn-primary')}
          disabled={primary.disabled}
          onClick={primary.onClick}
        >
          {acting || busy ? <Spinner size="sm" /> : <Icon name={primary.icon} size={16} />}
          {primary.label}
        </button>
        <MenuButton className="icon-btn raised" label={`「${inst.name}」的更多操作`} items={items} />
      </div>
    </div>
  );
}

// 把裁剪区域画到 128px 画布并导出 PNG dataURL（存进 inst.icon）
async function cropToDataUrl(src: string, area: { x: number; y: number; width: number; height: number }): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
  const SIZE = 128;
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  c.getContext('2d')!.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, SIZE, SIZE);
  return c.toDataURL('image/png');
}

// 实例图标编辑：选内置图标 / 上传图片裁剪 / 恢复默认。
function InstanceIconEditor({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const { toast } = useUI();
  const [sel, setSel] = useState<string>(inst.icon || ''); // '' = 按应用默认
  const [busy, setBusy] = useState(false);
  const [cropSrc, setCropSrc] = useState(''); // 非空 = 裁剪态
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) return toast('请选择图片文件', 'error');
    if (f.size > 8 * 1024 * 1024) return toast('图片过大（>8MB）', 'error');
    const r = new FileReader();
    r.onload = () => {
      setCropSrc(String(r.result));
      setCrop({ x: 0, y: 0 });
      setZoom(1);
    };
    r.readAsDataURL(f);
  };

  const confirmCrop = async () => {
    if (!cropSrc || !area) return;
    try {
      setSel(await cropToDataUrl(cropSrc, area));
      setCropSrc('');
    } catch {
      toast('裁剪失败', 'error');
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setInstanceIcon(inst.id, sel || null);
      onDone();
      onClose();
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="实例图标"
      subtitle={inst.name}
      onClose={onClose}
      footer={
        cropSrc ? (
          <>
            <button type="button" className="btn" onClick={() => setCropSrc('')}>
              返回
            </button>
            <button type="button" className="btn btn-primary" onClick={confirmCrop}>
              使用这张
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              保存
            </button>
          </>
        )
      }
    >
      {cropSrc ? (
        <>
          <div className="icon-crop">
            <Cropper
              image={cropSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_, a) => setArea(a)}
            />
          </div>
          <Field label="缩放">
            <input className="zoom-range" type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </Field>
        </>
      ) : (
        <>
          <div className="icon-edit-top">
            <InstanceIcon icon={sel || undefined} appType={inst.appType} size={56} radius={16} />
            <div>
              <div style={{ fontWeight: 600 }}>预览</div>
              <div className="muted">{sel.startsWith('data:') ? '自定义图片' : sel.startsWith('builtin:') ? '内置图标' : '应用默认图标'}</div>
            </div>
          </div>
          <Field label="内置图标">
            <div className="icon-grid">
              <button type="button" className={'icon-pick' + (sel === '' ? ' sel' : '')} onClick={() => setSel('')}>
                <InstanceIcon appType={inst.appType} size={38} radius={11} />
                <span>默认</span>
              </button>
              {ICON_CHOICES.map((c) => (
                <button type="button" key={c.key} className={'icon-pick' + (sel === `builtin:${c.key}` ? ' sel' : '')} onClick={() => setSel(`builtin:${c.key}`)}>
                  <InstanceIcon icon={`builtin:${c.key}`} size={38} radius={11} />
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          </Field>
          <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={16} />
            上传图片并裁剪
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
        </>
      )}
    </Modal>
  );
}

// 数据卷管理（仅管理员）：整卷备份/恢复 + 文件浏览器（浏览/上传/解压/下载/改名/移动/删除）。
// 主要场景：把 PC 微信数据迁移上来、跨实例迁移、离线备份。文件浏览在「运行中」的实例上操作
// （浏览/改名/删除靠 docker exec，需容器运行）。整卷恢复会覆盖数据，强提示；服务端校验通过后自动停止→写入→启动实例。
function VolumeManager({ inst, onClose, onChanged }: { inst: InstanceWithStatus; onClose: () => void; onChanged: () => void }) {
  const { toast, confirm } = useUI();
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<VolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(''); // 进行中操作文案；非空即禁用界面
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const extractRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);
  const offline = inst.runtime !== 'running'; // 文件浏览需实例运行中

  const join = (a: string, b: string) => (a ? a + '/' + b : b);

  const load = async (p = path) => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.volumeList(inst.id, p);
      setEntries(r.entries);
      setPath(r.path);
    } catch (e: any) {
      setErr(e?.message || '读取失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (offline) {
      setLoading(false);
      return;
    }
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.id]);

  const sorted = [...entries].sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const segs = path ? path.split('/') : [];

  const run = async (label: string, fn: () => Promise<any>, okMsg?: string, skipReload = false) => {
    setBusy(label);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'ok');
      if (!skipReload) await load();
    } catch (e: any) {
      toast(e?.message || '操作失败', 'error');
    } finally {
      setBusy('');
    }
  };

  const doMkdir = async () => {
    const name = mkdirName.trim();
    if (!name) return;
    await run('新建中…', () => api.volumeMkdir(inst.id, join(path, name)), '已新建文件夹');
    setMkdirName('');
    setMkdirOpen(false);
  };

  const doRename = async (oldName: string) => {
    const nv = renameVal.trim();
    setRenaming(null);
    if (!nv || nv === oldName) return;
    // 含 / → 视为相对 /config 的目标路径（移动到子目录）；否则同目录改名
    const to = nv.includes('/') ? nv.replace(/^\/+/, '') : join(path, nv);
    await run('处理中…', () => api.volumeMove(inst.id, join(path, oldName), to), '已重命名 / 移动');
  };

  const doDelete = async (en: VolEntry) => {
    const ok = await confirm({
      title: `删除「${en.name}」？`,
      body: en.type === 'dir' ? '将递归删除该文件夹下所有内容，不可恢复。' : '删除后不可恢复。',
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await run('删除中…', () => api.volumeDelete(inst.id, join(path, en.name)), '已删除');
  };

  // 上传进度 → 进行中文案；传完后服务端还要处理（改名 / 校验 / 写入），文案随阶段更新
  const progress = (name: string) => (loaded: number, total: number) =>
    setBusy(
      loaded < total
        ? `上传 ${name}：${Math.floor((loaded / total) * 100)}%（${fmtUploadSize(loaded)} / ${fmtUploadSize(total)}）`
        : `已上传 ${name}，正在处理…`,
    );
  const stage = (s: string) => setBusy(`${s}…`);

  const onPick = (kind: 'upload' | 'extract' | 'restore') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (kind === 'restore') {
      const running = inst.runtime === 'running';
      const ok = await confirm({
        title: '恢复整卷备份？',
        body: `该实例的 /config 将还原成「${file.name}」里的内容：现有数据（含登录态、聊天库）会被替换，备份里没有的文件也会删掉，不可撤销。只接受本系统导出的整卷备份；恢复失败会自动退回恢复前的数据。${
          running ? '实例正在运行，写入前会自动停止、写完自动启动。' : ''
        }`,
        danger: true,
        confirmText: '恢复',
      });
      if (!ok) return;
      await run(
        `上传 ${file.name}…`,
        () => api.volumeRestore(inst.id, file, progress(file.name), stage),
        running ? '恢复完成，实例已重新启动' : '恢复完成（实例保持停止，启动后生效）',
        true,
      );
      onChanged();
      return;
    }
    if (kind === 'upload') await run(`上传 ${file.name}…`, () => api.volumeUpload(inst.id, path, file, progress(file.name)), '上传完成');
    else await run(`上传 ${file.name}…`, () => api.volumeExtract(inst.id, path, file, progress(file.name), stage), '解压完成');
  };

  const disabled = !!busy;
  const icon = (en: VolEntry): IconName => (en.type === 'dir' ? 'folder' : 'file');

  return (
    <Modal title="数据卷" subtitle={`${inst.name} · /config`} size="lg" className="vol-modal" onClose={onClose}>
      {/* 整卷备份 / 恢复（运行/停止均可用） */}
      <div className="vol-sec">
        <div className="vol-section-label">整卷备份与恢复</div>
        <div className="vol-topbar">
          <a className="btn btn-sm" href={api.volumeBackupUrl(inst.id)} target="_blank" rel="noreferrer">
            <Icon name="download" size={16} />
            下载整卷备份
          </a>
          <button className="btn btn-sm" disabled={disabled} onClick={() => restoreRef.current?.click()}>
            <Icon name="restart" size={16} />
            从备份恢复…
          </button>
          <input ref={restoreRef} type="file" accept=".gz,.tgz,.tar" hidden onChange={onPick('restore')} />
        </div>
        <div className="vol-hint">整卷包含登录状态和聊天记录，可以离线备份、换机器、在实例之间迁移。恢复会把卷还原成备份时的样子。</div>
      </div>

      {busy && (
        <div className="vol-busy" aria-live="polite">
          <Spinner size="sm" />
          <span>{busy}</span>
        </div>
      )}

      {offline ? (
        <div className="callout callout-warn">
          <Icon name="info" size={18} />
          <div className="callout-body">
            <div className="callout-text">实例没在运行，浏览和上传文件要先启动实例。整卷备份和恢复不受影响。</div>
          </div>
        </div>
      ) : (
        <div className="vol-sec">
          <div className="vol-sec-head">
            <div className="vol-crumbs" aria-label="当前位置">
              <button className="vol-crumb" disabled={disabled || !path} onClick={() => load('')}>
                /config
              </button>
              {segs.map((s, i) => (
                <span key={i}>
                  <span className="vol-sep">/</span>
                  <button className="vol-crumb" disabled={disabled || i === segs.length - 1} onClick={() => load(segs.slice(0, i + 1).join('/'))}>
                    {s}
                  </button>
                </span>
              ))}
            </div>
            <div className="vol-tools">
              <button className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => uploadRef.current?.click()} title="上传单个文件到当前文件夹">
                <Icon name="upload" size={16} />
                上传
              </button>
              <button className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => extractRef.current?.click()} title="上传 .tar / .tar.gz 并解压到当前文件夹（导入 PC 微信数据用）">
                <Icon name="archive" size={16} />
                上传并解压
              </button>
              <button className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => setMkdirOpen((v) => !v)}>
                <Icon name="folderPlus" size={16} />
                新建文件夹
              </button>
              <button className="icon-btn" disabled={disabled} onClick={() => load()} title="刷新" aria-label="刷新">
                <Icon name="refresh" size={16} />
              </button>
              <input ref={uploadRef} type="file" hidden onChange={onPick('upload')} />
              <input ref={extractRef} type="file" accept=".gz,.tgz,.tar" hidden onChange={onPick('extract')} />
            </div>
          </div>
          {mkdirOpen && (
            <div className="vol-mkdir">
              <input
                className="input"
                placeholder="文件夹名"
                value={mkdirName}
                autoFocus
                onChange={(e) => setMkdirName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doMkdir();
                  if (e.key === 'Escape') setMkdirOpen(false);
                }}
              />
              <button className="btn btn-primary" disabled={disabled || !mkdirName.trim()} onClick={doMkdir}>
                创建
              </button>
            </div>
          )}

          <div className="vol-list">
            {loading ? (
              <div className="vol-empty">
                <Spinner size="sm" />
              </div>
            ) : err ? (
              <div className="vol-empty error">{err}</div>
            ) : (
              <>
                {path && (
                  <button className="vol-row vol-main vol-up" disabled={disabled} onClick={() => load(parent)}>
                    <span className="vol-ic">
                      <Icon name="folderUp" size={18} />
                    </span>
                    <span className="vol-nm">返回上一级</span>
                  </button>
                )}
                {sorted.length === 0 ? (
                  <div className="vol-empty">{path ? '这个文件夹是空的' : '数据卷是空的'}</div>
                ) : (
                  sorted.map((en) => (
                    <div className="vol-row" key={en.name}>
                      {renaming === en.name ? (
                        <input
                          className="input vol-rename"
                          autoFocus
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') doRename(en.name);
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={() => doRename(en.name)}
                        />
                      ) : (
                        <button
                          className="vol-main"
                          disabled={disabled}
                          onClick={() => (en.type === 'dir' ? load(join(path, en.name)) : undefined)}
                          style={{ cursor: en.type === 'dir' ? 'pointer' : 'default' }}
                        >
                          <span className={'vol-ic' + (en.type === 'dir' ? ' dir' : '')}>
                            <Icon name={icon(en)} size={18} />
                          </span>
                          <span className="vol-nm">{en.name}</span>
                          <span className="vol-meta">
                            {en.type === 'dir' ? '' : fmtBytes(en.size)}
                            {en.mtime ? `${en.type === 'dir' ? '' : ' · '}${fmtDate(en.mtime)}` : ''}
                          </span>
                        </button>
                      )}
                      <div className="vol-acts">
                        {en.type === 'file' && (
                          <a className="vol-act" title="下载" aria-label={`下载 ${en.name}`} href={api.volumeDownloadUrl(inst.id, join(path, en.name))} target="_blank" rel="noreferrer">
                            <Icon name="download" size={16} />
                          </a>
                        )}
                        <button
                          className="vol-act"
                          title="重命名 / 移动（名字里带 / 就是移到那个路径）"
                          aria-label={`重命名 ${en.name}`}
                          disabled={disabled}
                          onClick={() => {
                            setRenameVal(en.name);
                            setRenaming(en.name);
                          }}
                        >
                          <Icon name="pencil" size={16} />
                        </button>
                        <button className="vol-act danger" title="删除" aria-label={`删除 ${en.name}`} disabled={disabled} onClick={() => doDelete(en)}>
                          <Icon name="trash" size={16} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
          <div className="vol-hint">
            导入 PC 微信数据：把数据文件夹打包成 <b>.tar.gz</b>，用「上传并解压」放到对应文件夹，然后重启实例。能不能解密取决于微信版本和设备绑定，请先自己验证。
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateUser({ instances, onClose, onDone }: { instances: InstanceWithStatus[]; onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const validName = /^[a-zA-Z0-9_]{3,20}$/.test(username.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !validName || password.length < 6) return;
    setErr('');
    setBusy(true);
    try {
      await api.createUser(username.trim(), password, [...sel]);
      onDone();
    } catch (e: any) {
      setErr(e.message || '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建子账号"
      subtitle="子账号只能看到分配给它的实例"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !validName || password.length < 6}>
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <Field
        label="用户名"
        hint="3–20 位字母、数字或下划线，登录时用"
        error={username.trim() && !validName ? '只能用 3–20 位字母、数字或下划线（不支持中文）' : undefined}
      >
        <input
          className={'input' + (username.trim() && !validName ? ' invalid' : '')}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
      </Field>
      <Field label="初始密码" hint="至少 6 位，对方登录后可以自己修改">
        <PasswordInput autoComplete="new-password" value={password} onChange={setPassword} />
      </Field>
      <Field label="可以访问的实例">
        <CheckList
          options={instances.map((i) => ({
            id: i.id,
            label: i.name,
            sub: appProfile(i.appType).label,
            lead: <InstanceIcon icon={i.icon} appType={i.appType} size={28} radius={8} />,
          }))}
          selected={sel}
          onToggle={(id) => setSel((s) => toggleSet(s, id))}
          empty="还没有实例，可以以后再分配"
        />
      </Field>
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}

// 可创建的应用类型（Telegram 只有 x86_64、自定义应用尚未开放，暂不出现在这里）
const APP_OPTIONS: { type: AppType; desc: string }[] = [
  { type: 'wechat', desc: '官方 Linux 版' },
  { type: 'qq', desc: '官方 Linux 版' },
  { type: 'chromium', desc: '登录网页版社媒' },
];
const APP_HINT: Partial<Record<AppType, string>> = {
  wechat: '创建后在实例卡片上点「下载安装微信」（约 200MB），装好就能扫码登录。',
  qq: '创建后在实例卡片上点「下载安装QQ」（约 180MB）。下载被腾讯拒绝时，可以在电脑浏览器打开 im.qq.com/linuxqq 下载 Linux 版的 .deb，再点卡片「⋯」菜单里的「上传安装包」传进来。',
  chromium: '浏览器随镜像就绪，创建后直接进入，用来登录 Telegram、X、Instagram 等网页版。',
};

function CreateInstance({ subs, onClose, onDone }: { subs: PanelUser[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [appType, setAppType] = useState<AppType>('wechat');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 未使用的旧数据卷（之前删除实例但未勾选「彻底清除」时保留下来的），允许在此复用以继承聊天记录。
  const [orphans, setOrphans] = useState<{ name: string; createdAt?: string }[]>([]);
  const [reuse, setReuse] = useState<string>(''); // '' = 不复用，新建空卷

  useEffect(() => {
    let alive = true;
    api
      .listOrphanVolumes()
      .then(({ volumes }) => alive && setOrphans(volumes))
      .catch(() => {
        /* 读取失败时不阻塞创建：列表为空即可，照常新建空卷 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      await api.createInstance(name.trim(), [...sel], reuse || undefined, appType);
      onDone();
    } catch (e: any) {
      setErr(e.message || '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建实例"
      subtitle="每个实例是一个独立的容器，数据互不相通"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size="sm" />}
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <Field label="应用" hint={APP_HINT[appType]}>
        <div className="app-picker" role="radiogroup" aria-label="应用">
          {APP_OPTIONS.map((o) => (
            <button
              key={o.type}
              type="button"
              role="radio"
              aria-checked={appType === o.type}
              className={'app-pick' + (appType === o.type ? ' sel' : '')}
              onClick={() => setAppType(o.type)}
            >
              {appType === o.type && (
                <span className="app-pick-check">
                  <Icon name="check" size={12} strokeWidth={3.2} />
                </span>
              )}
              <InstanceIcon appType={o.type} size={40} radius={12} />
              <span className="app-pick-name">{APP_LABELS[o.type]}</span>
              <span className="app-pick-desc">{o.desc}</span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="名称" hint={`可以留空，会自动命名为「${APP_LABELS[appType]} 1」这样`}>
        <input className="input" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder={`例如：工作${APP_LABELS[appType]}`} />
      </Field>
      <Field
        label={
          <>
            可以访问的子账号 <span className="muted">· 管理员能访问全部实例</span>
          </>
        }
      >
        <CheckList
          options={subs.map((u) => ({ id: u.id, label: u.username, lead: <span className="row-av sm">{initial(u.username)}</span> }))}
          selected={sel}
          onToggle={(id) => setSel((s) => toggleSet(s, id))}
          empty="还没有子账号。需要的话，以后在「账号」里新建再分配。"
        />
      </Field>
      {orphans.length > 0 && (
        <Field label="数据卷" hint="复用旧数据卷时，要用原来的微信号扫码登录，才能看到以前的聊天记录。">
          <select className="input" value={reuse} onChange={(e) => setReuse(e.target.value)}>
            <option value="">新建空数据卷（全新登录）</option>
            {orphans.map((v) => (
              <option key={v.name} value={v.name}>
                复用 {v.name}
                {v.createdAt ? `（${v.createdAt.slice(0, 10)} 创建）` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}

function AssignUsers({
  inst,
  subs,
  onClose,
  onDone,
}: {
  inst: InstanceWithStatus;
  subs: PanelUser[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(subs.filter((u) => u.allowedInstances.includes(inst.id)).map((u) => u.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.setInstanceUsers(inst.id, [...sel]);
      onDone();
    } catch (e: any) {
      setErr(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="分配账号"
      subtitle={`哪些子账号可以使用「${inst.name}」`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || subs.length === 0} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <CheckList
        options={subs.map((u) => ({
          id: u.id,
          label: u.username,
          sub: u.disabled ? '已停用' : undefined,
          lead: <span className={'row-av sm' + (u.disabled ? ' muted-av' : '')}>{initial(u.username)}</span>,
        }))}
        selected={sel}
        onToggle={(id) => setSel((s) => toggleSet(s, id))}
        empty="还没有子账号。到「账号」里新建后再来分配。"
      />
      <div className="field-hint">管理员始终能访问全部实例，不用分配。</div>
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}

function AssignInstances({
  user,
  instances,
  onClose,
  onDone,
}: {
  user: PanelUser;
  instances: InstanceWithStatus[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(user.allowedInstances));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.setUserInstances(user.id, [...sel]);
      onDone();
    } catch (e: any) {
      setErr(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="分配实例"
      subtitle={`「${user.username}」可以使用哪些实例`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || instances.length === 0} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <CheckList
        options={instances.map((i) => ({
          id: i.id,
          label: i.name,
          sub: appProfile(i.appType).label,
          lead: <InstanceIcon icon={i.icon} appType={i.appType} size={28} radius={8} />,
        }))}
        selected={sel}
        onToggle={(id) => setSel((s) => toggleSet(s, id))}
        empty="还没有实例"
      />
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}

function toggleSet(s: Set<string>, id: string): Set<string> {
  const next = new Set(s);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
