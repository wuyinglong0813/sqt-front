'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const currency = require('../utils/chineseCurrency');

function harness(platform = 'windows') {
  let page;
  const listeners = new Set();
  const wx = {
    getDeviceInfo: () => ({ platform }),
    onKeyDown: callback => listeners.add(callback),
    offKeyDown: callback => listeners.delete(callback)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/sign-contract/sign-contract.js'), 'utf8'), {
    Page: definition => { page = definition; }, wx, setTimeout() {},
    require: id => {
      if (id.endsWith('/chineseCurrency')) return currency;
      throw new Error(`Unexpected require ${id}`);
    }
  });
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = page.data;
      for (const part of keys.slice(0, -1)) target = target[part];
      target[keys.at(-1)] = value;
    }
    if (callback) callback();
  };
  page.data.tableSection = { columns: ['品名', '数量', '单价', '金额', '备注'] };
  page.data.tableRows = [['电线', '2', '3', '6', '红蓝'], ['电线', '4', '3', '12', '红白']];
  Object.assign(page.data, page.tableColumnMetadata(page.data.tableSection.columns));
  return { page, listeners, wx };
}
const event = (row, col, value) => ({ currentTarget: { dataset: { row, col } }, detail: { value } });
const navigate = direction => ({ currentTarget: { dataset: { direction } } });

test('confirm saves the latest quantity, recalculates totals and focuses the same column next row', () => {
  const { page } = harness();
  page.onTableCellFocus(event(0, 1));
  page.onTableCellConfirm(event(0, 1, '02500'));
  assert.equal(page.data.tableRows[0][1], '2500');
  assert.equal(page.data.tableRows[0][3], '7500');
  assert.equal(page.data.totalAmount, '7512');
  assert.equal(page.data.tableRows.length, 2);
  assert.equal(page.data.tableFocusRow, 1);
  assert.equal(page.data.tableFocusCol, 1);
  // Native blur can arrive after the new input is focused.
  page.onTableCellBlur(event(0, 1, '2500'));
  assert.equal(page.data.tableFocusRow, 1);
});

test('confirming the last row retains remarks and adds one editable product row', () => {
  const { page } = harness();
  page.onTableCellConfirm(event(1, 4, '红黄'));
  assert.equal(page.data.tableRows[1][4], '红黄');
  assert.equal(page.data.tableRows.length, 3);
  assert.equal(page.data.tableRows[2][3], '0');
  assert.equal(page.data.tableFocusRow, 2);
  assert.equal(page.data.tableFocusCol, 4);
  assert.equal(page.data.totalAmount, '18');
});

test('direction buttons preserve row and column, skip calculated amounts and stop at table bounds', () => {
  const { page } = harness();
  page.onTableCellFocus(event(0, 2));
  page.onTableNavigate(navigate('right'));
  assert.equal(page.data.tableActiveCol, 4);
  page.onTableNavigate(navigate('down'));
  assert.equal(page.data.tableActiveRow, 1);
  assert.equal(page.data.tableActiveCol, 4);
  page.onTableNavigate(navigate('down'));
  page.onTableNavigate(navigate('right'));
  assert.equal(page.data.tableRows.length, 2);
  assert.equal(page.data.tableActiveRow, 1);
  assert.equal(page.data.tableActiveCol, 4);
  page.onTableNavigate(navigate('left'));
  page.onTableNavigate(navigate('up'));
  assert.equal(page.data.tableFocusRow, 0);
  assert.equal(page.data.tableFocusCol, 2);
  assert.equal(page.data.tableRows[1][4], '红白');
});

test('manual amount columns remain selectable and navigation reveals offscreen columns', () => {
  const { page } = harness();
  page.data.amountAutoCalculated = false;
  page.tableScrollMetrics = { contentWidth: 806, viewportWidth: 300 };
  page.data.tableScrollbarThumbWidth = 38;
  page.selectTableCell(0, 2, true);
  page.onTableNavigate(navigate('right'));
  assert.equal(page.data.tableActiveCol, 3);
  assert.ok(page.data.tableScrollLeft > 0);
  assert.ok(page.data.tableScrollbarThumbLeft > 0);
  page.onTableNavigate(navigate('left'));
  page.onTableNavigate(navigate('left'));
  page.onTableNavigate(navigate('left'));
  assert.equal(page.data.tableActiveCol, 0);
  assert.equal(page.data.tableScrollLeft, 0);
});

test('PC key events move selection only in explicit navigation mode and Enter returns to editing', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onShow();
  assert.equal(listeners.size, 1);
  page.onTableCellFocus(event(0, 2));
  const keyDown = [...listeners][0];
  keyDown({ key: 'ArrowDown' });
  assert.equal(page.data.tableActiveRow, 0);
  page.toggleTableKeyboardMode();
  assert.equal(page.data.tableFocusRow, -1);
  keyDown({ key: 'ArrowRight' });
  keyDown({ key: 'ArrowDown' });
  assert.equal(page.data.tableActiveRow, 1);
  assert.equal(page.data.tableActiveCol, 4);
  assert.equal(page.data.tableFocusRow, -1);
  keyDown({ key: 'Enter' });
  assert.equal(page.data.tableKeyboardMode, false);
  assert.equal(page.data.tableFocusRow, 1);
  assert.equal(page.data.tableFocusCol, 4);
  page.onHide();
  assert.equal(listeners.size, 0);
  page.onShow();
  assert.equal(listeners.size, 1);
  page.onUnload();
  assert.equal(listeners.size, 0);
});

test('phones use confirm and direction buttons without registering unsupported PC listeners', () => {
  const { page, listeners } = harness('ios');
  page.onShow();
  assert.equal(page.data.tableKeyboardAvailable, false);
  assert.equal(listeners.size, 0);
  page.onTableNavigate(navigate('down'));
  assert.equal(page.data.tableFocusRow, 0);
  page.onTableCellConfirm(event(0, 1, '5'));
  assert.equal(page.data.tableFocusRow, 1);
});

test('PC navigation accepts string false modifiers and ignores genuinely pressed shortcut modifiers', () => {
  const { page } = harness();
  page.selectTableCell(0, 1, true);
  page.toggleTableKeyboardMode();
  page.onTableKeyDown({ key: 'ArrowDown', altKey: 'false', ctrlKey: 'false', metaKey: 'false' });
  assert.equal(page.data.tableActiveRow, 1);
  page.onTableKeyDown({ key: 'ArrowUp', altKey: '0', ctrlKey: 0, metaKey: false });
  assert.equal(page.data.tableActiveRow, 0);
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
    for (const value of [true, 'true', 1, '1']) {
      page.onTableKeyDown({ key: 'ArrowDown', [modifier]: value });
      assert.equal(page.data.tableActiveRow, 0, `${modifier}=${value} should preserve shortcut handling`);
    }
  }
});

test('switching templates clears stale cell focus and selection coordinates', () => {
  const { page } = harness();
  page.selectTableCell(1, 4, true);
  page.data.templates = [{ content: JSON.stringify({ sections: [{ type: 'table', columns: ['说明'], rows: [['内容']] }] }) }];
  page.selectTemplate(0);
  assert.equal(page.data.tableActiveRow, -1);
  assert.equal(page.data.tableFocusCol, -1);
  page.onTableNavigate(navigate('right'));
  assert.equal(page.data.tableFocusRow, 0);
  assert.equal(page.data.tableFocusCol, 0);
});

test('deleting selected or preceding rows keeps selection valid and late blur cannot restore a deleted row', () => {
  const { page } = harness();
  page.selectTableCell(1, 1, true);
  page.deleteTableRow({ currentTarget: { dataset: { index: '0' } } });
  assert.equal(page.data.tableActiveRow, 0);
  assert.equal(page.data.tableFocusRow, -1);
  assert.equal(page.data.tableRows.length, 1);
  assert.equal(page.data.tableRows[0][1], '4');
  page.onNumberCellBlur(event(1, 1, ''));
  assert.equal(page.data.tableRows.length, 1);
  page.onNumberCellBlur(event(0, 1, ''));
  assert.equal(page.data.tableRows[0][1], '4');
  page.deleteTableRow({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.tableRows.length, 1);
});

test('vertical keyboard selection scrolls only when the selected row leaves the viewport', () => {
  const { page, wx } = harness();
  page.onShow();
  const scrolls = [];
  let rowRect = { top: 700, bottom: 750 };
  wx.getWindowInfo = () => ({ windowHeight: 800 });
  wx.pageScrollTo = options => scrolls.push(options.scrollTop);
  wx.createSelectorQuery = () => {
    const query = {
      in: () => query, select: () => query, selectViewport: () => query,
      boundingClientRect: () => query, scrollOffset: () => query,
      exec: callback => callback([rowRect, { scrollTop: 300 }, { height: 110 }])
    };
    return query;
  };
  page.selectTableCell(1, 1, false);
  assert.deepEqual(scrolls, [340]);
  rowRect = { top: 160, bottom: 210 };
  page.selectTableCell(1, 1, false);
  assert.deepEqual(scrolls, [340]);
  rowRect = { top: 90, bottom: 140 };
  page.selectTableCell(0, 1, false);
  assert.deepEqual(scrolls, [340, 268]);
});

test('delayed row measurements cannot scroll another page or a later visit to this page', () => {
  const { page, wx } = harness();
  const pending = [], scrolls = [];
  const measurements = [{ top: 700, bottom: 750 }, { scrollTop: 300 }, { height: 110 }];
  wx.getWindowInfo = () => ({ windowHeight: 800 });
  wx.pageScrollTo = options => scrolls.push(options.scrollTop);
  wx.createSelectorQuery = () => {
    const query = {
      in: () => query, select: () => query, selectViewport: () => query,
      boundingClientRect: () => query, scrollOffset: () => query,
      exec: callback => pending.push(callback)
    };
    return query;
  };
  page.onShow();
  page.selectTableCell(1, 1, false);
  page.onHide();
  pending[0](measurements);
  assert.deepEqual(scrolls, []);
  page.onShow();
  pending[0](measurements);
  assert.deepEqual(scrolls, []);
  page.selectTableCell(1, 1, false);
  pending[1](measurements);
  assert.deepEqual(scrolls, [340]);
  page.selectTableCell(1, 1, false);
  page.onUnload();
  pending[2](measurements);
  assert.deepEqual(scrolls, [340]);
});
