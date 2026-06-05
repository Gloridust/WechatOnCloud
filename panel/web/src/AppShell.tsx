import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { useAuthConfig } from './hooks/useAuthConfig';
import { useUI, PasswordInput } from './ui';
import { api, type InstanceWithStatus } from './api';
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
  const { mode } = useAuthConfig();
  const allowLocalMgmt = mode !== 'oidc_full';
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
        <Sidebar collapsed={railed} onToggleCollapsed={toggleCollapsed} allowLocalMgmt={allowLocalMgmt} />
        <div className="shell-backdrop" onClick={() => setDrawer(false)} />
        <main className="workspace">
          <Routes>
            <Route path="/" element={<HomeView onOpenMenu={openMenu} onChangePassword={openChangePassword} allowLocalMgmt={allowLocalMgmt} />} />
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

function Sidebar({ collapsed, onToggleCollapsed, allowLocalMgmt }: { collapsed: boolean; onToggleCollapsed: () => void; allowLocalMgmt: boolean }) {
  const { user, logout } = useAuth();
  const { confirm } = useUI();
  const { instances } = useInstances();
  const nav = useNavigate();
  const loc = useLocation();
  const isAdmin = user?.role === 'admin';
  const go = (p: string) => nav(p);

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

      {!collapsed && <div className="sb-section">微信实例</div>}
      <div className="sb-list">
        {instances.length === 0 && !collapsed && <div className="sb-empty">暂无可用实例</div>}
        {instances.map((inst) => {
          const on = loc.pathname === `/i/${inst.id}`;
          const st = statusOf(inst);
          return (
            <button key={inst.id} className={'sb-item sb-inst' + (on ? ' on' : '')} onClick={() => go(`/i/${inst.id}`)} title={inst.name}>
              <span className="sb-avatar">
                {inst.name.slice(0, 1)}
                <span className={'sb-dot ' + st.cls} />
              </span>
              {!collapsed && <span className="sb-label">{inst.name}</span>}
              {!collapsed && <span className="sb-stxt">{st.text}</span>}
            </button>
          );
        })}
      </div>

      <div className="sb-footer">
        <button className={'sb-item' + (loc.pathname === '/admin' ? ' on' : '')} onClick={() => go('/admin')} title={isAdmin ? '管理' : '设置'}>
          <span className="sb-ic">{Icon.gear}</span>
          {!collapsed && <span className="sb-label">{isAdmin ? '管理' : '设置'}</span>}
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

function HomeView({ onOpenMenu, onChangePassword, allowLocalMgmt }: { onOpenMenu: () => void; onChangePassword: () => void; allowLocalMgmt: boolean }) {
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
      </header>

      <div className="content">
        <div className="hello">
          你好，<b>{user?.username}</b>
          {isAdmin && <span className="tag">管理员</span>}
        </div>

        {allowLocalMgmt && user?.mustChangePassword && (
          <button className="warn-banner" onClick={onChangePassword}>
            <span className="warn-icon">!</span>
            <span className="warn-text">
              <b>你还在使用默认密码</b>
              <span>该系统登录着你的微信，请立即修改密码 ›</span>
            </span>
          </button>
        )}

        <div className="section-row">
          <span className="section-title">我的微信实例</span>
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
            <div className="empty-title">还没有微信实例</div>
            <div className="empty-sub">{isAdmin ? '去「管理」新建一个微信实例' : '请联系管理员为你分配实例'}</div>
          </div>
        ) : (
          <div className="inst-grid">
            {instances.map((inst) => {
              const st = statusOf(inst);
              return (
                <button key={inst.id} className="home-card" onClick={() => nav(`/i/${inst.id}`)}>
                  <span className="home-card-av">{inst.name.slice(0, 1)}</span>
                  <span className="home-card-main">
                    <span className="home-card-name">{inst.name}</span>
                    <span className={'home-card-st ' + st.cls}>● {st.text}</span>
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
