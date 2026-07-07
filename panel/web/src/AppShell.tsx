import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { useUI, PasswordInput } from './ui';
import { api, appProfile, type InstanceWithStatus } from './api';
import { InstanceIcon } from './AppIcon';
import { getThemeMode, applyThemeMode, nextThemeMode, resolveDark, type ThemeMode } from './theme';
import InstanceView from './pages/Desktop';
import Admin from './pages/Admin';

const BUSY = ['downloading', 'extracting', 'installing'];

// ---- 实例数据：侧栏 / 主页 / 实例视图共享，安装中轮询 ----
interface InstancesState {
  instances: InstanceWithStatus[];
  loaded: boolean;
  reload: () => Promise<void>;
}
const InstancesCtx = createContext<InstancesState>({ instances: [], loaded: false, reload: async () => {} });
export const useInstances = () => useContext(InstancesCtx);

function useInstancesLoader(): InstancesState {
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const reload = async () => {
    try {
      const { instances } = await api.listInstances();
      setInstances(instances);
    } catch {
      /* 401 会被 api 层重定向到登录 */
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    reload();
    return () => window.clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (instances.some((i) => BUSY.includes(i.wechat.phase))) timer.current = window.setTimeout(reload, 1500);
    return () => window.clearTimeout(timer.current);
  }, [instances]);
  return { instances, loaded, reload };
}

// 实例状态点（颜色 + 文案）
export function statusOf(inst: InstanceWithStatus): { cls: string; text: string } {
  const offline = inst.runtime !== 'running';
  if (offline) return { cls: 'st-off', text: inst.runtime === 'missing' ? '未创建' : '已停止' };
  if (BUSY.includes(inst.wechat.phase)) return { cls: 'st-busy', text: '处理中' };
  if (inst.wechat.installed) return { cls: 'st-on', text: '在线' };
  return { cls: 'st-warn', text: '待安装' };
}

// ---- 图标 ----
const Icon = {
  home: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /><path d="M9.5 20v-6h5v6" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" /><path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1A2 2 0 1 1 6.9 4.5l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
    </svg>
  ),
  collapse: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" />
    </svg>
  ),
  menu: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
};

export default function AppShell() {
  const state = useInstancesLoader();
  const { refresh } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('woc_sb_collapsed') === '1');
  const [drawer, setDrawer] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  const loc = useLocation();

  useEffect(() => {
    const m = window.matchMedia('(min-width: 768px)');
    const h = () => setIsDesktop(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);

  useEffect(() => setDrawer(false), [loc.pathname]); // 路由变化关抽屉

  // 路由切换时刷新共享实例列表：管理页用的是独立列表，新建/安装实例后不会动到这个共享 context，
  // 否则进入实例页 / 回主页都读到陈旧列表（实例缺失），需手动刷新整页才出现。导航即拉一次最新即可。
  // 不清空旧数据，拉取期间沿用旧列表，无闪烁。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void state.reload(), [loc.pathname]);

  // 移动端不收成窄栏（改用抽屉）；折叠仅桌面生效
  const railed = collapsed && isDesktop;

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem('woc_sb_collapsed', c ? '0' : '1');
      return !c;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openMenu = () => setDrawer(true);
  const openChangePassword = () => setShowPw(true);

  return (
    <InstancesCtx.Provider value={state}>
      <div className={'shell' + (railed ? ' collapsed' : '') + (drawer ? ' drawer-open' : '')}>
        <Sidebar collapsed={railed} onToggleCollapsed={toggleCollapsed} />
        <div className="shell-backdrop" onClick={() => setDrawer(false)} />
        <main className="workspace">
          <Routes>
            <Route path="/" element={<HomeView onOpenMenu={openMenu} onChangePassword={openChangePassword} />} />
            <Route path="/admin" element={<Admin onOpenMenu={openMenu} onChangePassword={openChangePassword} />} />
            <Route path="/i/:id" element={<InstanceView onOpenMenu={openMenu} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      {showPw && <ChangePassword onClose={() => setShowPw(false)} onSaved={() => refresh()} />}
    </InstancesCtx.Provider>
  );
}

function Sidebar({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }) {
  const { user, logout } = useAuth();
  const { confirm } = useUI();
  const { instances } = useInstances();
  const nav = useNavigate();
  const loc = useLocation();
  const isAdmin = user?.role === 'admin';
  const go = (p: string) => nav(p);

  // 有新版时在「管理」入口点个红点（仅管理员，因为升级面板需管理员在宿主操作）。
  // 依赖 loc.pathname：导航时复查一次（服务端有缓存、开销极小），保证刚启动时首检完成后红点能及时出现。
  const [hasUpdate, setHasUpdate] = useState(false);
  useEffect(() => {
    if (!isAdmin) return;
    api
      .getVersion()
      .then((v) => setHasUpdate(!!v.hasUpdate))
      .catch(() => {});
  }, [isAdmin, loc.pathname]);

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="sb-brand">
          <img src="/favicon.svg" className="sb-logo" alt="" />
          {!collapsed && <span className="sb-name">云微</span>}
        </div>
        <button className="sb-collapse" title="折叠侧栏 (⌘B)" onClick={onToggleCollapsed}>
          {Icon.collapse}
        </button>
      </div>

      <nav className="sb-nav">
        <button className={'sb-item' + (loc.pathname === '/' ? ' on' : '')} onClick={() => go('/')} title="主页">
          <span className="sb-ic">{Icon.home}</span>
          {!collapsed && <span className="sb-label">主页</span>}
        </button>
      </nav>

      {!collapsed && <div className="sb-section">实例</div>}
      <div className="sb-list">
        {instances.length === 0 && !collapsed && <div className="sb-empty">暂无可用实例</div>}
        {instances.map((inst) => {
          const on = loc.pathname === `/i/${inst.id}`;
          const st = statusOf(inst);
          return (
            <button key={inst.id} className={'sb-item sb-inst' + (on ? ' on' : '')} onClick={() => go(`/i/${inst.id}`)} title={inst.name}>
              <span className="sb-avatar">
                <InstanceIcon icon={inst.icon} appType={inst.appType} size={34} radius={10} />
                <span className={'sb-dot ' + st.cls} />
              </span>
              {!collapsed && <span className="sb-label">{inst.name}</span>}
              {!collapsed && <span className="sb-stxt">{st.text}</span>}
            </button>
          );
        })}
      </div>

      <div className="sb-footer">
        <button
          className={'sb-item' + (loc.pathname === '/admin' ? ' on' : '')}
          onClick={() => go('/admin')}
          title={isAdmin && hasUpdate ? '管理 · 有新版本可用' : isAdmin ? '管理' : '设置'}
        >
          <span className="sb-ic">
            {Icon.gear}
            {isAdmin && hasUpdate && <span className="sb-updot" />}
          </span>
          {!collapsed && <span className="sb-label">{isAdmin ? '管理' : '设置'}</span>}
          {!collapsed && isAdmin && hasUpdate && <span className="sb-updot-text">新版</span>}
        </button>
        <button
          className="sb-item"
          title="退出"
          onClick={async () => {
            if (await confirm({ title: '退出登录？', confirmText: '退出' })) logout();
          }}
        >
          <span className="sb-ic">{Icon.logout}</span>
          {!collapsed && <span className="sb-label">退出</span>}
        </button>
        {!collapsed && (
          <div className="sb-user">
            {user?.username}
            {isAdmin && ' · 管理员'}
          </div>
        )}
      </div>
    </aside>
  );
}

// 主题切换图标（跟随系统 / 亮色 / 深色 循环）。
const themeIcon: Record<ThemeMode, JSX.Element> = {
  auto: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
    </svg>
  ),
};
// 主题开关：统一控制「面板」+「实例桌面」深色。面板部分立即生效（本地 CSS）；实例部分仅管理员可改
// （服务端持久化 + 对运行中实例 docker exec 实时切换；非管理员只切自己的面板观感，不动实例）。
function ThemeToggle() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode());

  // 让实例桌面跟随面板主题。dark = 该模式解析后的实际明暗（auto 按系统）。best-effort，失败忽略。
  const pushDesktop = (dark: boolean) => {
    if (!isAdmin) return;
    api.setDesktopTheme(dark).catch(() => {});
  };

  // 登录/进入主页时对齐一次：仅当实例当前明暗与面板主题不一致才下发，避免无谓的 exec。
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    (async () => {
      try {
        const want = resolveDark(getThemeMode());
        const { dark } = await api.getDesktopTheme();
        if (alive && dark !== want) await api.setDesktopTheme(want);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  // 跟随系统时，系统亮暗变化也要带动实例。
  useEffect(() => {
    if (!isAdmin || mode !== 'auto') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const on = () => pushDesktop(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, mode]);

  const cycle = () => {
    const m = nextThemeMode(mode);
    applyThemeMode(m);
    setMode(m);
    pushDesktop(resolveDark(m));
  };
  const label = mode === 'auto' ? '跟随系统' : mode === 'light' ? '亮色' : '深色';
  const hint = isAdmin
    ? `主题：${label}（面板即时换肤；浏览器实例重启后跟随。点击循环：跟随系统 / 亮色 / 深色）`
    : `主题：${label}（点击切换：跟随系统 / 亮色 / 深色）`;
  return (
    <button className="theme-toggle" onClick={cycle} title={hint} aria-label={`主题：${label}`}>
      {themeIcon[mode]}
    </button>
  );
}

function HomeView({ onOpenMenu, onChangePassword }: { onOpenMenu: () => void; onChangePassword: () => void }) {
  const { user } = useAuth();
  const { instances, loaded } = useInstances();
  const nav = useNavigate();
  const isAdmin = user?.role === 'admin';

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="菜单">
          {Icon.menu}
        </button>
        <span className="ws-title">主页</span>
        <ThemeToggle />
      </header>

      <div className="content">
        <div className="hello">
          你好，<b>{user?.username}</b>
          {isAdmin && <span className="tag">管理员</span>}
        </div>

        {user?.mustChangePassword && (
          <button className="warn-banner" onClick={onChangePassword}>
            <span className="warn-icon">!</span>
            <span className="warn-text">
              <b>你还在使用默认密码</b>
              <span>该系统登录着你的微信，请立即修改密码 ›</span>
            </span>
          </button>
        )}

        <div className="section-row">
          <span className="section-title">我的实例</span>
          {isAdmin && (
            <button className="btn-text" onClick={() => nav('/admin')}>
              管理 ›
            </button>
          )}
        </div>

        {loaded && instances.length === 0 ? (
          <div className="empty-state">
            <div className="empty-blob">
              <img src="/favicon.svg" alt="" />
            </div>
            <div className="empty-title">还没有实例</div>
            <div className="empty-sub">{isAdmin ? '去「管理」新建一个实例' : '请联系管理员为你分配实例'}</div>
          </div>
        ) : (
          <div className="inst-grid">
            {instances.map((inst) => {
              const st = statusOf(inst);
              const prof = appProfile(inst.appType);
              const meta = inst.wechat.installed
                ? `${prof.label} ${inst.wechat.version || ''}`.trim()
                : inst.runtime === 'running' && prof.needsInstall
                  ? `待下载安装${prof.label}`
                  : '';
              return (
                <button key={inst.id} className="home-card" onClick={() => nav(`/i/${inst.id}`)}>
                  <span className="home-card-av">
                    <InstanceIcon icon={inst.icon} appType={inst.appType} size={42} radius={12} />
                  </span>
                  <span className="home-card-main">
                    <span className="home-card-name">{inst.name}</span>
                    <span className="home-card-meta">
                      <span className={'home-card-st ' + st.cls}>● {st.text}</span>
                      {meta && <span className="home-card-ver">{meta}</span>}
                    </span>
                  </span>
                  <span className="enter-arrow">›</span>
                </button>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}

export function ChangePassword({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const canSubmit = !busy && !!oldPassword && newPassword.length >= 6 && newPassword === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    if (newPassword !== confirm) {
      setMsg('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      setMsg('修改成功');
      onSaved?.();
      setTimeout(onClose, 800);
    } catch (e: any) {
      setMsg(e.message || '修改失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>修改密码</h2>
        <PasswordInput placeholder="原密码" autoComplete="current-password" value={oldPassword} onChange={setOld} />
        <PasswordInput placeholder="新密码（至少 6 位）" autoComplete="new-password" value={newPassword} onChange={setNew} />
        <PasswordInput placeholder="再次输入新密码" autoComplete="new-password" value={confirm} onChange={setConfirm} />
        {mismatch && <div className="error">两次输入的新密码不一致</div>}
        {msg && <div className={msg === '修改成功' ? 'ok' : 'error'}>{msg}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!canSubmit}>
            确定
          </button>
        </div>
      </form>
    </div>
  );
}
