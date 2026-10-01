import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { useUI, PasswordInput, Modal, Field, useDocTitle } from './ui';
import { Icon } from './icons';
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
  // 每次切页都会刷新列表，快速切换时几个请求同时在路上、回来的先后不定：只认比已采用的更新的结果，旧的别覆盖新的
  const issued = useRef(0);
  const applied = useRef(0);
  const reload = async () => {
    const seq = ++issued.current;
    try {
      const { instances } = await api.listInstances();
      if (seq < applied.current) return;
      applied.current = seq;
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

// 实例状态（颜色 + 文案）：侧栏角标、主页卡片、管理卡片、实例页标题共用，同一状态处处同色同字
export function statusOf(inst: InstanceWithStatus): { cls: string; tag: string; text: string } {
  const offline = inst.runtime !== 'running';
  if (offline) return { cls: 'st-off', tag: 'tag-off', text: inst.runtime === 'missing' ? '未创建' : '已停止' };
  if (BUSY.includes(inst.wechat.phase)) return { cls: 'st-busy', tag: 'tag-busy', text: '安装中' };
  if (inst.wechat.installed) return { cls: 'st-on', tag: 'tag-on', text: '在线' };
  if (inst.wechat.phase === 'error') return { cls: 'st-err', tag: 'tag-err', text: '安装出错' };
  return { cls: 'st-warn', tag: 'tag-warn', text: '待安装' };
}

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
      if (e.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openMenu = () => setDrawer(true);
  const openChangePassword = () => setShowPw(true);

  return (
    <InstancesCtx.Provider value={state}>
      <div className={'shell' + (railed ? ' collapsed' : '') + (drawer ? ' drawer-open' : '')}>
        <Sidebar collapsed={railed} onToggleCollapsed={toggleCollapsed} onClose={() => setDrawer(false)} />
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

// 头像：取用户名第一个字（中文名取首字，英文取首字母大写）
export function initial(name?: string): string {
  const c = (name || '?').trim().charAt(0);
  return c ? c.toUpperCase() : '?';
}

function Sidebar({ collapsed, onToggleCollapsed, onClose }: { collapsed: boolean; onToggleCollapsed: () => void; onClose: () => void }) {
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
    <aside className="sidebar" aria-label="导航">
      <div className="sb-top">
        <div className="sb-brand">
          <img src="/favicon.svg" className="sb-logo" alt="" />
          {!collapsed && <span className="sb-name">云微</span>}
        </div>
        <button className="icon-btn sb-collapse" title={collapsed ? '展开侧栏（⌘B）' : '收起侧栏（⌘B）'} aria-label={collapsed ? '展开侧栏' : '收起侧栏'} onClick={onToggleCollapsed}>
          <Icon name="sidebar" size={19} />
        </button>
        <button className="icon-btn sb-close" aria-label="关闭菜单" onClick={onClose}>
          <Icon name="x" size={20} />
        </button>
      </div>

      <nav className="sb-nav">
        <button className={'sb-item' + (loc.pathname === '/' ? ' on' : '')} onClick={() => go('/')} title="主页" aria-current={loc.pathname === '/' ? 'page' : undefined}>
          <span className="sb-ic">
            <Icon name="home" size={19} />
          </span>
          {!collapsed && <span className="sb-label">主页</span>}
        </button>
      </nav>

      {!collapsed && (
        <div className="sb-section">
          <span>实例</span>
          {instances.length > 0 && <span className="sb-section-count">{instances.length}</span>}
        </div>
      )}
      <div className="sb-list">
        {instances.length === 0 && !collapsed && <div className="sb-empty">{isAdmin ? '还没有实例，去「管理」新建一个' : '还没有分配给你的实例'}</div>}
        {instances.map((inst) => {
          const on = loc.pathname === `/i/${inst.id}`;
          const st = statusOf(inst);
          return (
            <button
              key={inst.id}
              className={'sb-item sb-inst' + (on ? ' on' : '')}
              onClick={() => go(`/i/${inst.id}`)}
              title={`${inst.name} · ${st.text}`}
              aria-current={on ? 'page' : undefined}
            >
              <span className="sb-avatar">
                <InstanceIcon icon={inst.icon} appType={inst.appType} size={32} radius={10} />
                <span className={'sb-dot ' + st.cls} />
              </span>
              {!collapsed && <span className="sb-label">{inst.name}</span>}
              {/* 在线是常态，只靠角标的绿点表达；其它状态才写出来，免得一列「在线」把真正要注意的淹没 */}
              {!collapsed && st.cls !== 'st-on' && <span className={'sb-stxt ' + st.cls}>{st.text}</span>}
            </button>
          );
        })}
      </div>

      <div className="sb-footer">
        <button
          className={'sb-item' + (loc.pathname === '/admin' ? ' on' : '')}
          onClick={() => go('/admin')}
          title={isAdmin && hasUpdate ? '管理 · 有新版本可用' : isAdmin ? '管理' : '设置'}
          aria-current={loc.pathname === '/admin' ? 'page' : undefined}
        >
          <span className="sb-ic">
            <Icon name="settings" size={19} />
            {isAdmin && hasUpdate && <span className="sb-updot" />}
          </span>
          {!collapsed && <span className="sb-label">{isAdmin ? '管理' : '设置'}</span>}
          {!collapsed && isAdmin && hasUpdate && <span className="sb-updot-text">新版</span>}
        </button>
        <button
          className="sb-item"
          title="退出登录"
          onClick={async () => {
            if (await confirm({ title: '退出登录？', body: '实例里的应用会继续运行，下次登录面板即可回来。', confirmText: '退出' })) logout();
          }}
        >
          <span className="sb-ic">
            <Icon name="logout" size={19} />
          </span>
          {!collapsed && <span className="sb-label">退出登录</span>}
        </button>
        <div className="sb-user" title={`${user?.username} · ${isAdmin ? '管理员' : '子账号'}`}>
          <span className="sb-user-av">{initial(user?.username)}</span>
          {!collapsed && (
            <span className="sb-user-text">
              <span className="sb-user-name">{user?.username}</span>
              <span className="sb-user-role">{isAdmin ? '管理员' : '子账号'}</span>
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}

// 主题切换（跟随系统 / 亮色 / 深色 循环）
const THEME_ICON: Record<ThemeMode, 'auto' | 'sun' | 'moon'> = { auto: 'auto', light: 'sun', dark: 'moon' };
// 主题开关：统一控制「面板」+「实例桌面」深色。面板部分立即生效（本地 CSS）；实例部分仅管理员可改
// （服务端持久化 + 对运行中实例 docker exec 实时切换；非管理员只切自己的面板观感，不动实例）。
export function ThemeToggle() {
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
    ? `外观：${label}（点击切换 跟随系统 / 亮色 / 深色；面板立即换肤，浏览器实例重启后跟随）`
    : `外观：${label}（点击切换 跟随系统 / 亮色 / 深色）`;
  return (
    <button className="icon-btn theme-toggle" onClick={cycle} title={hint} aria-label={`外观：${label}，点击切换`}>
      <Icon name={THEME_ICON[mode]} size={19} />
    </button>
  );
}

function HomeView({ onOpenMenu, onChangePassword }: { onOpenMenu: () => void; onChangePassword: () => void }) {
  const { user } = useAuth();
  const { instances, loaded } = useInstances();
  const nav = useNavigate();
  const isAdmin = user?.role === 'admin';
  const online = instances.filter((i) => statusOf(i).cls === 'st-on').length;
  const hour = new Date().getHours();
  const greet = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  useDocTitle('');

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="icon-btn ws-menu" onClick={onOpenMenu} aria-label="打开菜单">
          <Icon name="menu" size={21} />
        </button>
        <span className="ws-title">
          <span className="ws-title-text">主页</span>
        </span>
        <ThemeToggle />
      </header>

      <div className="content">
        <div className="hero">
          <h1 className="hero-title">
            {greet}，{user?.username}
          </h1>
          {/* 没有实例时不写副标题：下面的空状态已经说清楚了，不重复 */}
          {(!loaded || instances.length > 0) && (
            <div className="hero-sub">{!loaded ? '正在读取实例…' : `${instances.length} 个实例，${online} 个在线。点开卡片即可进入。`}</div>
          )}
        </div>

        {user?.mustChangePassword && (
          <div className="callout callout-danger" style={{ marginBottom: 22 }}>
            <Icon name="alert" size={20} />
            <div className="callout-body">
              <div className="callout-title">还在用默认密码</div>
              <div className="callout-text">这个面板登录着你的微信，知道默认密码的人都能进来。请先改掉它。</div>
            </div>
            <div className="callout-actions">
              <button className="btn btn-danger btn-sm" onClick={onChangePassword}>
                修改密码
              </button>
            </div>
          </div>
        )}

        {loaded && instances.length === 0 ? (
          <div className="empty-state">
            <div className="empty-blob">
              <img src="/favicon.svg" alt="" />
            </div>
            <div className="empty-title">还没有实例</div>
            <div className="empty-sub">{isAdmin ? '一个实例就是一个独立的微信（或 QQ、浏览器），数据互不相通。' : '请联系管理员为你分配实例。'}</div>
            {isAdmin && (
              <button className="btn btn-primary empty-action" onClick={() => nav('/admin')}>
                <Icon name="plus" size={18} />
                去新建实例
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="section-row">
              <span className="section-title">
                我的实例 {instances.length > 0 && <span className="section-count">{instances.length}</span>}
              </span>
              {isAdmin && (
                <button className="btn-text" onClick={() => nav('/admin')}>
                  管理实例
                  <Icon name="chevronRight" size={16} />
                </button>
              )}
            </div>
            <div className="home-grid">
              {instances.map((inst) => {
                const st = statusOf(inst);
                const prof = appProfile(inst.appType);
                const meta = inst.wechat.installed
                  ? `${prof.label} ${inst.wechat.version || ''}`.trim()
                  : st.cls === 'st-busy'
                    ? inst.wechat.percent >= 0
                      ? `${inst.wechat.percent}%`
                      : '请稍候'
                    : inst.runtime === 'running' && prof.needsInstall
                      ? `${prof.label} · 还没安装`
                      : prof.label;
                return (
                  <button key={inst.id} className="home-card" onClick={() => nav(`/i/${inst.id}`)}>
                    <span className="home-card-av">
                      <InstanceIcon icon={inst.icon} appType={inst.appType} size={46} radius={14} />
                    </span>
                    <span className="home-card-main">
                      <span className="home-card-name">{inst.name}</span>
                      <span className="home-card-meta">
                        <span className={'tag ' + st.tag}>{st.text}</span>
                        <span className="home-card-ver">{meta}</span>
                      </span>
                    </span>
                    <span className="home-card-go">
                      <Icon name="chevronRight" size={20} />
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ChangePassword({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const { toast } = useUI();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const tooShort = newPassword.length > 0 && newPassword.length < 6;
  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const canSubmit = !busy && !!oldPassword && newPassword.length >= 6 && newPassword === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setErr('');
    setBusy(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      toast('密码已修改，其它设备上的登录已退出', 'ok');
      onSaved?.();
      onClose();
    } catch (e: any) {
      setErr(e.message || '修改失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="修改密码"
      subtitle="改完后，其它设备上的登录会被退出"
      size="sm"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!canSubmit}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <Field label="当前密码">
        <PasswordInput autoComplete="current-password" value={oldPassword} onChange={setOld} autoFocus />
      </Field>
      <Field label="新密码" error={tooShort ? '至少 6 位' : undefined} hint="至少 6 位">
        <PasswordInput autoComplete="new-password" value={newPassword} onChange={setNew} invalid={tooShort} />
      </Field>
      <Field label="再输一次新密码" error={mismatch ? '两次输入的新密码不一致' : undefined}>
        <PasswordInput autoComplete="new-password" value={confirm} onChange={setConfirm} invalid={mismatch} />
      </Field>
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}
