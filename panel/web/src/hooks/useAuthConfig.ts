import { useState, useEffect } from 'react';

interface AuthConfig {
  mode: string;
  oidcLabel: string;
}

export function useAuthConfig(): AuthConfig {
  const [config, setConfig] = useState<AuthConfig>({ mode: 'local', oidcLabel: '统一身份登录' });
  useEffect(() => {
    fetch('/api/auth/mode')
      .then((r) => r.json())
      .then((d) => setConfig({
        mode: d.mode || 'local',
        oidcLabel: d.oidcLabel || '统一身份登录'
      }))
      .catch(() => {});
  }, []);
  return config;
}
