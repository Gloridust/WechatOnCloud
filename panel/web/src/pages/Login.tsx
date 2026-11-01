import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { PasswordInput } from '../ui';
import { GridName } from '../paper';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(username.trim(), password);
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e.message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen login-screen">
      <div className="login-wrap">
        <form className="card login-card" onSubmit={submit}>
          <div className="brand">
            <div className="brand-logo">
              <img src="/favicon.svg" alt="" />
            </div>
            <h1>
              <GridName name="云微" />
            </h1>
            <p className="muted">登录以访问 NAS 上的微信</p>
          </div>
          <input
            className="input"
            placeholder="用户名"
            aria-label="用户名"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <PasswordInput placeholder="密码" autoComplete="current-password" value={password} onChange={setPassword} />
          {err && <div className="error">{err}</div>}
          <button className="btn btn-primary" disabled={busy || !username || !password}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        <div className="login-foot">服务端微信 · 多端共享 · 建议仅在内网 / 可信网络访问</div>
      </div>
    </div>
  );
}
