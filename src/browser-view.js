'use strict';

const { requiredString } = require('./control');
const { integer } = require('./protocol');

const TOOLBAR_ITEMS = Object.freeze({
  '设备控制': 'el-icon-mobile-phone', '参数设置': 'el-icon-setting', '音频': 'el-icon-microphone',
  '音量': 'el-icon-bell', '重命名': 'el-icon-edit-outline', '尺寸管理': 'el-icon-view',
  'vpc代理': 'el-icon-connection', '上传谷歌证书': 'el-icon-upload2', '文件管理': 'el-icon-folder',
  '备份管理': 'el-icon-copy-document', '随机设备信息': 'el-icon-magic-stick',
  '更换镜像': 'el-icon-coin', '导入V3镜像': 'el-icon-top', '钛备份': 'el-icon-files'
});

// Inject an authenticated Playwright Page. This layer only changes the website UI.
class CloudPhoneBrowserView {
  constructor(page, { udid } = {}) {
    if (!page || typeof page.locator !== 'function') throw new TypeError('Pass a Playwright-compatible page');
    this.page = page;
    this.udid = requiredString('udid', udid);
  }

  async _popup() {
    const frames = await this.page.locator('.device-popup iframe.webrtc-iframe').all();
    let target;
    for (const frame of frames) if (await frame.getAttribute('id') === this.udid) {
      if (target) throw new Error('More than one window controls this udid');
      target = frame;
    }
    if (!target) throw new Error('Open the target cloud-phone popup first');
    const escaped = this.udid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const popup = this.page.locator('.device-popup').filter({ has: this.page.locator('iframe[id="' + escaped + '"]') });
    if (await popup.count() !== 1) throw new Error('Cannot uniquely identify target popup');
    return popup;
  }

  async setPreferences(preferences) {
    const labels = { showSideToolbar: '功能栏', autoCopy: '自动复制', autoRefresh: '自动刷新' };
    if (!preferences || !Object.keys(preferences).length) throw new TypeError('Specify at least one preference');
    for (const [key, value] of Object.entries(preferences)) {
      if (!Object.hasOwn(labels, key) || typeof value !== 'boolean') throw new TypeError('Unknown preference or non-boolean value: ' + key);
    }
    const popup = await this._popup();
    const more = popup.locator('button.header-icon-btn').filter({ has: this.page.locator('i.el-icon-more') });
    let menuId = await more.getAttribute('aria-controls');
    if (!menuId) { await more.click(); menuId = await more.getAttribute('aria-controls'); }
    if (!menuId || !/^[\w-]+$/.test(menuId)) throw new Error('Cloud frontend menu structure has changed');
    const menu = this.page.locator('#' + menuId);
    if (!await menu.isVisible()) await more.click();
    await menu.waitFor({ state: 'visible', timeout: 5000, timeoutMs: 5000 });
    const applied = {};
    try {
      for (const [key, value] of Object.entries(preferences)) {
        const row = menu.locator('.more-menu-row').filter({ hasText: labels[key] });
        const toggle = row.getByRole('switch');
        // Vue removes aria-checked when false; read the actual DOM checkbox instead.
        const checkbox = toggle.locator('input[type="checkbox"]');
        if (await checkbox.count() !== 1) throw new Error('Preference switch has no unique checkbox');
        const readChecked = () => checkbox.evaluate(input => input.checked);
        if (await readChecked() !== value) await toggle.click();
        if (await readChecked() !== value) throw new Error('Preference update was not applied: ' + key);
        applied[key] = value;
      }
    } finally {
      if (await menu.isVisible()) await more.click();
      // Dropdown hiding is delayed; the next call must not reuse a disappearing menu.
      await menu.waitFor({ state: 'hidden', timeout: 5000, timeoutMs: 5000 });
    }
    return applied;
  }

  async refresh() {
    const popup = await this._popup();
    await popup.locator('button.header-icon-btn').filter({ has: this.page.locator('i.el-icon-refresh') }).click();
  }

  async setSize(size) {
    size = integer('size', size, 240, 800);
    if ((size - 240) % 16) throw new RangeError('Browser size must follow the 16-pixel slider steps');
    const popup = await this._popup();
    const slider = popup.getByRole('slider');
    // Element UI does not expose aria-valuenow here; aria-valuetext can remain stale.
    // The visible label tracks the pending value, and the wrapper owns keydown.
    const value = popup.locator('.quick-size-value');
    const handle = slider.locator('.el-slider__button-wrapper');
    let current = Number(await value.innerText());
    if (!Number.isInteger(current) || current < 240 || current > 800 || (current - 240) % 16) {
      throw new Error('Cannot read current size slider value');
    }
    for (let step = 0; current !== size && step < 40; step++) {
      await handle.press(current < size ? 'ArrowRight' : 'ArrowLeft');
      const next = Number(await value.innerText());
      if (!Number.isInteger(next) || Math.abs(next - current) !== 16) throw new Error('Size slider did not update');
      current = next;
    }
    if (current !== size || Number(await value.innerText()) !== size) {
      throw new Error('Requested browser size was not applied');
    }
    return size;
  }

  async openSidebarAction(category, item) {
    if (!Object.hasOwn(TOOLBAR_ITEMS, category)) throw new TypeError('Unknown sidebar category: ' + category);
    if (item !== undefined) requiredString('item', item);
    const popup = await this._popup();
    const entry = popup.locator('.screen-side-toolbar .side-toolbar-item').filter({
      has: this.page.locator('button.side-toolbar-btn i.' + TOOLBAR_ITEMS[category])
    });
    if (await entry.count() !== 1) throw new Error('Sidebar item unavailable (check toolbar visibility and account permissions): ' + category);
    // Keyboard activation avoids transient tooltip overlays covering the icon.
    if (!item || !await entry.locator('.side-submenu').isVisible()) await entry.locator('button.side-toolbar-btn').press('Enter');
    if (item) {
      requiredString('item', item);
      await entry.locator('.side-submenu').waitFor({ state: 'visible' });
      const action = entry.locator('button.side-submenu-btn').filter({ has: this.page.getByText(item, { exact: true }) });
      if (await action.count() !== 1) throw new Error('Sidebar action is not present: ' + item);
      await action.click();
    }
    // This acknowledges only the click. Dialogs/confirmations may still need caller interaction.
    return { category, item: item ?? null, dispatched: true };
  }
}

module.exports = { CloudPhoneBrowserView, TOOLBAR_ITEMS };
