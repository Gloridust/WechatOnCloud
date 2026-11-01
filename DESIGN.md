---
name: 云微 · WechatOnCloud panel
description: Self-hosted WeChat / QQ / browser instances, managed from rounded, iOS-style grouped lists.
colors:
  page-gray: "#f2f3f5"
  surface: "#ffffff"
  fill-gray: "#ececf0"
  separator: "#e5e5ea"
  control-line: "#8a8a8f"
  label: "#1c1c1e"
  secondary-label: "#65656b"
  green-text: "#05803f"
  green-fill: "#06843f"
  green-fill-press: "#056b34"
  green-tint: "#e8f8ef"
  status-green: "#07c160"
  red: "#c4271f"
  red-tint: "#ffecea"
  blue: "#2456c4"
  blue-tint: "#e8f0fe"
  amber: "#8a5800"
  amber-tint: "#fff4e0"
  dark-page: "#000000"
  dark-surface: "#1c1c1e"
  dark-fill: "#2c2c2e"
  dark-separator: "#38383a"
  dark-label: "#f2f2f7"
  dark-secondary-label: "#98989f"
  dark-green-text: "#30d158"
  dark-green-fill: "#17803f"
  dark-red: "#ff6961"
typography:
  large-title:
    fontFamily: "-apple-system, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "17px"
    fontWeight: 700
  row-title:
    fontFamily: "-apple-system, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "-apple-system, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  footnote:
    fontFamily: "-apple-system, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "13px"
    fontWeight: 400
  pill:
    fontFamily: "-apple-system, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
    fontSize: "12px"
    fontWeight: 600
rounded:
  input: "12px"
  card: "16px"
  group: "18px"
  dialog: "20px"
  pill: "999px"
spacing:
  row-x: "16px"
  row-y: "12px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.green-fill}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    height: "44px"
    padding: "0 18px"
  button-primary-hover:
    backgroundColor: "{colors.green-fill-press}"
  button-secondary:
    backgroundColor: "{colors.fill-gray}"
    textColor: "{colors.label}"
    rounded: "{rounded.pill}"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.red}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    height: "44px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.label}"
    rounded: "{rounded.input}"
    height: "48px"
    padding: "0 16px"
  status-pill:
    backgroundColor: "{colors.green-tint}"
    textColor: "{colors.green-text}"
    rounded: "{rounded.pill}"
    typography: "{typography.pill}"
    padding: "3px 10px"
  grouped-list:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.group}"
  list-row:
    backgroundColor: "{colors.surface}"
    padding: "12px 16px"
    height: "68px"
---

# Design System: 云微 · WechatOnCloud panel

## Overview

**Creative North Star: "Settings, but for your own WeChat server"**

The panel borrows the calm, familiar structure of iOS Settings: a light gray page, white rounded groups, rows separated by inset hairlines, colored status pills and round green buttons. People already know how to read it, so the product disappears into the task: open an instance, or fix one.

Every list (instances, accounts, leftover containers and volumes) is the same grouped list. Each row has the app icon, the name, a one-line subtitle, a note when something needs attention, a status pill, and the action that fits the state. Dark mode follows iOS dark grouped style: black page, dark-gray groups.

Chosen by the user from three rounded mockups (iOS grouped list / modern app / refined soft cards), after the soft-neumorphic original and a square "manuscript paper" redesign were both rejected.

**Key Characteristics:**
- Light gray page (#f2f3f5), white rounded groups (18px), soft lift instead of borders.
- Rows separated by inset hairlines that start after the icon.
- Status as tinted pills; actions as pill buttons; WeChat-family green for the primary action.
- System sans only; large bold titles; secondary text in gray.
- The `>_` logo is a fixed brand asset and is never changed.

## Colors

Neutral grays with one green for action, and status tints that only appear inside pills.

### Primary
- **Green Fill** (#06843f, press #056b34; dark #17803f): primary buttons and "on" toggles. White text 4.8:1.
- **Green Text** (#05803f; dark #30d158): text links ("管理 ›", "+ 新建实例"), online pill text, selected nav.
- **Green Tint** (#e8f8ef): online pill background, selected nav background, selected chips.
- **Status Green** (#07c160): status dots and progress fill only, never text.

### Secondary (status, inside pills only)
- **Red** (#c4271f / tint #ffecea; dark #ff6961): creation failed, disabled account, destructive menu items, error text.
- **Blue** (#2456c4 / tint #e8f0fe): processing / installing.
- **Amber** (#8a5800 / tint #fff4e0): awaiting install, upgrade available.
- **Neutral** (secondary label on #f0f0f2): stopped, not created, image version.

### Neutral
- **Page Gray** (#f2f3f5; dark #000000): the page behind the groups.
- **Surface** (#ffffff; dark #1c1c1e): groups, cards, dialogs, sidebar.
- **Fill Gray** (#ececf0; dark #2c2c2e): secondary buttons, segmented control track, progress track.
- **Separator** (#e5e5ea; dark #38383a): inset row hairlines (decorative).
- **Control Line** (#8a8a8f; dark #7c7c82): input and chip outlines, ≥3:1.
- **Label** (#1c1c1e; dark #f2f2f7) and **Secondary Label** (#65656b; dark #98989f, ≥5:1).

### Named Rules
**The Red Means Broken Rule.** Red is only for real failures, errors and destructive actions. A stopped instance is a neutral gray pill with a next step.

**The One Green Rule.** One filled green button per row or dialog. Everything else is a gray pill or a green text link.

## Typography

**Font:** the platform sans (`-apple-system` / PingFang SC / Microsoft YaHei / Noto Sans SC). No web fonts.

### Hierarchy
- **Large Title** (700, 28px): home greeting.
- **Title** (700, 17px): header title, dialog titles.
- **Row Title** (600, 16px): instance and account names, one line with ellipsis.
- **Body** (400, 14px): banner text, descriptions (help text capped at 64ch).
- **Footnote** (400, 13px, secondary label): row subtitles, notes, section labels.
- **Pill** (600, 12px): status pills; versions use tabular figures.

## Layout

- Shell: white sidebar (264px, collapsible to 64px, drawer under 768px) separated by a hairline; content centred, 560px on phones and 940px at ≥880px.
- Grouped list: `grid-template-columns: minmax(0,1fr) max-content max-content`, rows on `subgrid`, so pills and buttons align down the group. Rows ≥68px, 12px/16px padding; the hairline starts at 68px (after the icon), or 16px in lists without icons.
- Under 640px a row becomes two lines: icon + name/subtitle/note, then the status pill and the action (44px).
- Admin uses an iOS segmented control for 实例 / 用户 / 系统.
- Instance page: header toolbar of pill buttons (icon + label); 481–767px icon-only 44px; ≤480px shows 文件 / 输入 plus a 更多 menu.

## Elevation & Depth

- **Lift** (`0 1px 2px rgba(0,0,0,.04), 0 1px 1px rgba(0,0,0,.02)`): groups, cards, banners. Off in dark mode.
- **Pop** (`0 10px 30px rgba(0,0,0,.14), 0 2px 6px rgba(0,0,0,.08)`): menus, dialogs, toasts, the login card. In dark mode a 1px separator ring replaces most of the shadow.
- Dialog mask: plain `rgba(0,0,0,.36)`, no blur.

## Shapes

- Radii: 12px inputs, 16px cards and banners, 18px groups, 20px dialogs, pill for buttons, status pills, chips and the segmented control. App icons 10px; avatars round-cornered, status dots round.

## Components

- **Primary button**: green pill, white text, 44px (34px inside rows); press scales to 0.97.
- **Secondary button**: gray pill, label color text.
- **Danger button**: red pill; only in confirmations. A danger "outline" is a red-tinted pill.
- **Text link**: green text, tinted background on hover.
- **Input**: white, 12px radius, control-line outline, green 2px ring + soft halo on focus. Always with a visible label.
- **Status pill**: tinted background + colored text (green / blue / amber / red / neutral).
- **Grouped list row**: icon · name · subtitle · note (red for failures, with the admin remedy hint below) · status pill · action (+ `管理 ▾`). Sub-accounts see 「请联系管理员」 instead of actions they can't take.
- **Row menu** (`RowMenu`): 14px-radius popover with pop shadow, grouped items, destructive item last in red; flips upward and caps its height when there's no room.
- **Segmented control**: gray pill track, selected segment is a white pill with a small shadow; attention dots sit next to labels.
- **Banner**: white card, round tinted icon, bold title + secondary text, one action.
- **Chip toggle**: outlined pill with a round check; selected = green tint, green outline, filled check.
- **State word**: fades in when a status changes; off under reduced motion.

## Do's and Don'ts

- **Do** use the tokens in `panel/web/src/styles.css` (`:root`) and the parts in `parts.tsx` / `icons.tsx`.
- **Do** put every list in the grouped list, with the next step in every non-online row.
- **Do** keep text ≥4.5:1 and control outlines ≥3:1 in both themes.
- **Don't** change the logo (`favicon.svg`, PWA icons). It is a fixed brand asset.
- **Don't** use red for stopped/idle states, or more than one filled green button per row.
- **Don't** use square corners, heavy borders, glass/blur, gradients or emoji icons.
