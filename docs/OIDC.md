# OIDC 统一认证配置指南

WechatOnCloud 支持通过标准 **OpenID Connect (OIDC)** 协议接入统一身份认证，兼容任意标准 OIDC Identity Provider (IdP)，如 Keycloak、Authentik、Authing、Azure AD 等。

---

## 快速开始

1. 复制示例配置：
   ```bash
   cp .env.oidc.example .env
   ```

2. 编辑 `.env`，填写你的 IdP 配置：
   ```ini
   WOC_AUTH_MODE=***   WOC_OIDC_ISSUER=https://auth.example.com/realms/myrealm
   WOC_OIDC_CLIENT_ID=woc-panel
   WOC_OIDC_CLIENT_SECRET=your-client-secret
   WOC_OIDC_REDIRECT_URI=https://woc.example.com/api/auth/oidc/callback
   ```

3. 重启面板：
   ```bash
   docker compose up -d
   ```

---

## 配置项说明

### 认证模式

| 模式 | 说明 |
|------|------|
| `local` | 仅本地账号密码认证（默认） |
| `oidc` | OIDC 统一认证，同时保留本地登录入口 |
| `oidc_full` | 完全由 IdP 管理身份，禁用本地用户管理功能 |

### 核心 OIDC 配置

| 环境变量 | 必填 | 说明 |
|----------|------|------|
| `WOC_OIDC_ISSUER` | ✅ | IdP 的 OpenID Discovery URL |
| `WOC_OIDC_CLIENT_ID` | ✅ | 在 IdP 中注册的客户端 ID |
| `WOC_OIDC_CLIENT_SECRET` | ✅ | 客户端密钥 |
| `WOC_OIDC_REDIRECT_URI` | ✅ | 回调地址，必须与 IdP 注册时完全一致 |

### 角色映射

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `WOC_OIDC_ROLE_CLAIM` | `resource_access.${client_id}.roles` | ID Token 中角色数组的 JSON 路径，支持点号分隔 |
| `WOC_OIDC_ADMIN_ROLE` | `woc:admin` | 映射为管理员角色的值 |
| `WOC_OIDC_USER_ROLE` | `woc:user` | 映射为普通用户角色的值 |

### 用户预配

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `WOC_OIDC_AUTO_PROVISION` | `true` | 首次 OIDC 登录且本地无账号时，是否自动创建本地用户映射 |

### Keycloak 扩展（可选）

| 环境变量 | 说明 |
|----------|------|
| `WOC_KEYCLOAK_ADMIN_URL` | Keycloak 管理地址 |
| `WOC_KEYCLOAK_REALM` | Realm 名称 |
| `WOC_KEYCLOAK_ADMIN_USER` | 管理员用户名 |
| `WOC_KEYCLOAK_ADMIN_PASS` | 管理员密码 |

---

## IdP 配置示例

### Keycloak

1. 创建 Realm
2. 创建 Client：
   - Client ID: `woc-panel`
   - Client authentication: **ON**
   - Authorization: **ON**
   - Standard flow: **ON**
   - Valid redirect URIs: `https://woc.example.com/api/auth/oidc/callback`
3. 创建 Client Roles：`woc:admin`、`woc:user`
4. 将角色分配给用户

### 通用 OIDC IdP

确保你的 IdP 支持：
- OpenID Discovery（`/.well-known/openid-configuration`）
- Authorization Code Flow
- `openid`, `profile`, `email` scope

---

## 架构说明

- **策略模式**：`AuthProvider` 接口支持 `local` / `oidc` / `oidc_full` 无缝切换
- **角色同步**：每次 OIDC 登录时，从 ID Token 提取角色并更新本地用户权限
- **实例角色**：通过可选的 Keycloak Admin API 扩展，实现实例创建/删除时自动同步角色

---

## 故障排查

### 回调返回 401

检查 `WOC_OIDC_REDIRECT_URI` 是否与 IdP 中注册的一致（包括协议 `http`/`https`）。

### 角色未生效

检查 `WOC_OIDC_ROLE_CLAIM` 路径是否正确。使用 JWT 解码工具查看 ID Token 结构。

### Keycloak 角色同步失败

确认 Keycloak 用户具有 `manage-clients` 和 `manage-users` realm-management 角色。

---

## 向后兼容

未配置 OIDC 时（`WOC_AUTH_MODE` 未设置或为空），面板完全回退到原有本地认证模式，不影响任何现有功能。
