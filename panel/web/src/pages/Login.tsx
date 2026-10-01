import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Field, PasswordInput, useDocTitle } from '../ui';
import { Icon } from '../icons';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useDocTitle('登录');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErr('请输入用户名和密码');
      return;
    }
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
        <form className="card login-card" onSubmit={submit} noValidate>
          <div className="brand">
            <div className="brand-logo">
              <img src="/favicon.svg" alt="" />
            </div>
            <h1>云微</h1>
            <p>登录后在浏览器里使用服务器上的微信</p>
          </div>
          <Field label="用户名" htmlFor="login-user">
            <input
              id="login-user"
              className="input"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="密码" htmlFor="login-pw">
            <PasswordInput id="login-pw" autoComplete="current-password" value={password} onChange={setPassword} invalid={!!err && !busy} />
          </Field>
          {err && (
            <div className="error" role="alert">
              {err}
            </div>
          )}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        <div className="login-foot">
          <Icon name="lock" size={14} />
          建议只在内网或可信网络里访问
        </div>
      </div>
    </div>
  );
}
