// 临时 helper 容器的入口（由 triggerSelfUpdate 以 `npm run updater` 启动，env WOC_UPDATER=1）。
// 只做一件事：重建面板，然后退出。
import { runUpdaterRecreate } from './self-update.js';

runUpdaterRecreate()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[updater] 异常退出：', e);
    process.exit(1);
  });
