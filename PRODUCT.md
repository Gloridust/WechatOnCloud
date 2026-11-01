# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, weighted equally:

- **The self-hoster (admin).** Runs 云微 on their own NAS or Docker host. Opens their own WeChat / QQ / browser sessions from phone, laptop and office PC through the day, and also creates instances, upgrades images, assigns accounts and debugs failures.
- **Sub-account users.** Family members or teammates the admin invites. Less technical. They log in, see the instances they were given, and open one. They should never need to understand containers, images or volumes.

Both use it in Chinese (zh-CN), on desktop browsers and phones (installed as a PWA on iOS / desktop Chrome).

## Product Purpose

Run the official WeChat (and QQ, or a Chromium browser for Telegram / X / Instagram web) server-side on hardware you own, and reach the same live session from any browser. Each instance is its own container with its own data volume; KasmVNC streams the desktop to the browser. Success: opening an instance from any device is instant and obvious, and the admin can see and fix instance health without reading logs first.

## Positioning

The session lives on your own box, not on a phone or a vendor cloud: one always-on WeChat that every device shares, with the official client unmodified. The panel is the single entry point; VNC credentials never reach the browser.

## Operating Context

- Daily loop: log in → pick an instance → work inside the streamed desktop (type Chinese via the forward bar, transfer files, paste text/images, toggle sound).
- Same instance shows in only one place at a time; opening it elsewhere takes it over, the old tab offers "continue here".
- Admin loop: create instance (WeChat / QQ / Chromium), download/install the app, start/stop/restart, upgrade image, rename, icon, assign accounts, memory safety thresholds, volume backup/restore, orphan volume/container cleanup, diagnostics export, panel self-update.
- Long-running states are common and must read clearly: pulling image (GB-scale), installing app, upgrading, creation failed with reason + hint.

## Capabilities and Constraints

- Frontend: React 18 + Vite + react-router, single `styles.css`, PWA. No UI library.
- Instance desktop is an iframe (KasmVNC); the panel chrome around it must stay thin so the desktop gets the space.
- Must work at 390px phone width and on desktop; light and dark theme (auto / light / dark) with the admin able to push dark mode into instances.
- Roles: admin (everything) and sub (only assigned instances, change own password).
- Copy is Chinese; keep existing factual copy, error causes and hints.

## Brand Commitments

None binding. The user explicitly allowed replacing the name styling, icon, colors, type and layout. The product name 云微 / WechatOnCloud stays as the product's name.

## Evidence on Hand

- README screenshots: `doc/img/Screenshot-1.png`, `doc/img/Screenshot-2.png`.
- No testimonials, metrics or customer claims exist; do not invent any.

## Product Principles

1. The instance is the product. Everything else is a way to get into one or keep it healthy.
2. State before decoration: running / stopped / installing / failed must be readable at a glance, with the next action next to it.
3. Sub-account users should never see ops vocabulary they can't act on.
4. Thin chrome around the desktop; never compete with the streamed app.
5. Long operations narrate themselves (what step, how far, what to do if it fails).

## Accessibility & Inclusion

WCAG AA contrast, keyboard operability (focus rings, Esc closes overlays), touch targets ≥ 44px on phones, respect `prefers-reduced-motion`.
