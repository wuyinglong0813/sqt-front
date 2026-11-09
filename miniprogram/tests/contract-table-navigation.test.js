'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const currency = require('../utils/chineseCurrency');

function harness(platform = 'windows') {
  let page;
  let now = 1000;
  const listeners = new Set();
  const wx = {
    getDeviceInfo: () => ({ platform }),
    onKeyDown: callback => listeners.add(callback),
    offKeyDown: callback => listeners.delete(callback)
  };
  class Clock extends Date {
    static now() { return now; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/sign-contract/sign-contract.js'), 'utf8'), {
    Page: definition => { page = definition; }, wx, Date: Clock, setTimeout() {},
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
  return { page, listeners, wx, advance: ms => { now += ms; } };
}
const event = (row, col, value) => ({ currentTarget: { dataset: { row, col } }, detail: { value } });
const press = (listeners, key, modifiers = {}) => {
  for (const listener of listeners) listener({ key, ...modifiers });
};

test('phone confirm saves the latest quantity and recalculates totals without advancing', () => {
  const { page } = harness('ios');
  page.onShow();
  page.onTableCellFocus(event(0, 1));
  page.onTableCellConfirm(event(0, 1, '02500'));
  assert.equal(page.data.tableRows[0][1], '2500');
  assert.equal(page.data.tableRows[0][3], '7500');
  assert.equal(page.data.totalAmount, '7512');
  assert.equal(page.data.tableRows.length, 2);
  assert.equal(page.data.tableActiveRow, 0);
  assert.equal(page.data.tableActiveCol, 1);
  assert.equal(page.data.tableFocusRow, -1);
  page.onTableCellFocus(event(1, 0));
  // Native blur from the previous cell can arrive after an explicit tap.
  page.onTableCellBlur(event(0, 1, '2500'));
  assert.equal(page.data.tableFocusRow, 1);
  assert.equal(page.data.tableFocusCol, 0);
});

test('phone confirm in any text column on the last row keeps the row count unchanged', () => {
  const { page } = harness('android');
  const columns = ['品名', '型号', '规格', '单位', '数量', '单价', '金额', '备注'];
  page.data.tableSection = { columns };
  page.data.tableRows = [
    ['电线', 'A1', '细', '米', '2', '3', '6', '红蓝'],
    ['电线', 'A1', '细', '米', '4', '3', '12', '红白']
  ];
  Object.assign(page.data, page.tableColumnMetadata(columns));
  page.onShow();
  for (const [col, value] of [[0, '电缆'], [1, 'B2'], [2, '粗'], [3, '卷'], [7, '红黄']]) {
    page.onTableCellFocus(event(1, col));
    page.onTableCellConfirm(event(1, col, value));
    assert.equal(page.data.tableRows[1][col], value);
    assert.equal(page.data.tableRows.length, 2);
    assert.equal(page.data.tableActiveRow, 1);
    assert.equal(page.data.tableActiveCol, col);
    assert.equal(page.data.tableFocusRow, -1);
  }
  page.addTableRow();
  assert.equal(page.data.tableRows.length, 3);
  assert.equal(page.data.tableRows[2][6], '0');
  assert.equal(page.data.totalAmount, '18');
});

test('phone confirm on a manually entered amount saves it without moving or adding a row', () => {
  const { page } = harness('ios');
  const columns = ['品名', '金额', '备注'];
  page.data.tableSection = { columns };
  page.data.tableRows = [['电线', '6', '红蓝'], ['电线', '12', '红白']];
  Object.assign(page.data, page.tableColumnMetadata(columns));
  page.onShow();
  page.onNumberCellFocus(event(1, 1));
  page.onTableCellConfirm(event(1, 1, '012.5'));
  assert.equal(page.data.tableRows[1][1], '12.5');
  assert.equal(page.data.totalAmount, '18.5');
  assert.equal(page.data.tableRows.length, 2);
  assert.equal(page.data.tableActiveRow, 1);
  assert.equal(page.data.tableActiveCol, 1);
  assert.equal(page.data.tableFocusRow, -1);
});

test('a single desktop click enables all four arrows, skips calculated amounts and stops at table bounds', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onTableCellTap(event(0, 2));
  assert.equal(page.data.tableFocusRow, -1);
  press(listeners, 'ArrowRight');
  assert.equal(page.data.tableActiveCol, 4);
  press(listeners, 'ArrowDown');
  assert.equal(page.data.tableActiveRow, 1);
  assert.equal(page.data.tableActiveCol, 4);
  press(listeners, 'ArrowDown');
  press(listeners, 'ArrowRight');
  assert.equal(page.data.tableRows.length, 2);
  assert.equal(page.data.tableActiveRow, 1);
  assert.equal(page.data.tableActiveCol, 4);
  press(listeners, 'ArrowLeft');
  press(listeners, 'ArrowUp');
  assert.equal(page.data.tableFocusRow, -1);
  assert.equal(page.data.tableActiveRow, 0);
  assert.equal(page.data.tableActiveCol, 2);
  assert.equal(page.data.tableRows[1][4], '红白');
});

test('desktop manual amount columns remain selectable and arrows reveal offscreen columns', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.data.amountAutoCalculated = false;
  page.tableScrollMetrics = { contentWidth: 806, viewportWidth: 300 };
  page.data.tableScrollbarThumbWidth = 38;
  page.onTableCellTap(event(0, 2));
  press(listeners, 'ArrowRight');
  assert.equal(page.data.tableActiveCol, 3);
  assert.ok(page.data.tableScrollLeft > 0);
  assert.ok(page.data.tableScrollbarThumbLeft > 0);
  press(listeners, 'ArrowLeft');
  press(listeners, 'ArrowLeft');
  press(listeners, 'ArrowLeft');
  assert.equal(page.data.tableActiveCol, 0);
  assert.equal(page.data.tableScrollLeft, 0);
});

for (const platform of ['windows', 'mac']) {
  test(`${platform} click, arrows, Enter, confirm and arrows work without a navigation toggle`, () => {
    const { page, listeners } = harness(platform);
    page.onShow();
    page.onShow();
    assert.equal(listeners.size, 1);
    assert.equal(page.data.tableKeyboardAvailable, true);
    page.onTableCellTap(event(0, 1));
    press(listeners, 'ArrowRight');
    assert.equal(page.data.tableActiveCol, 2);
    press(listeners, 'Enter');
    assert.equal(page.data.tableFocusRow, 0);
    assert.equal(page.data.tableFocusCol, 2);
    // Native inputs own arrows while editing, even if a platform also emits the global event.
    press(listeners, 'ArrowDown');
    press(listeners, 'x');
    assert.equal(page.data.tableActiveRow, 0);
    assert.equal(page.data.tableRows[0][2], '3');
    page.onTableCellConfirm(event(0, 2, '9'));
    assert.equal(page.data.tableRows[0][3], '18');
    assert.equal(page.data.totalAmount, '30');
    assert.equal(page.data.tableActiveRow, 0);
    assert.equal(page.data.tableActiveCol, 2);
    assert.equal(page.data.tableFocusRow, -1);
    page.onTableCellBlur(event(0, 2, '9'));
    press(listeners, 'ArrowLeft');
    assert.equal(page.data.tableActiveCol, 1);
    page.onHide();
    assert.equal(listeners.size, 0);
    page.onShow();
    assert.equal(listeners.size, 1);
    page.onUnload();
    assert.equal(listeners.size, 0);
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} keeps tap-to-edit and finishes on the current cell without a desktop key listener`, () => {
    const { page, listeners } = harness(platform);
    page.onShow();
    assert.equal(page.data.tableKeyboardAvailable, false);
    assert.equal(listeners.size, 0);
    page.onTableCellFocus(event(0, 1));
    assert.equal(page.data.tableFocusRow, 0);
    assert.equal(page.data.tableFocusCol, 1);
    page.onTableCellConfirm(event(0, 1, '5'));
    assert.equal(page.data.tableFocusRow, -1);
    assert.equal(page.data.tableFocusCol, -1);
    assert.equal(page.data.tableActiveRow, 0);
    assert.equal(page.data.tableActiveCol, 1);
  });
}

for (const missing of ['onKeyDown', 'offKeyDown']) {
  test(`desktop clients without ${missing} retain native editing instead of an unusable selection state`, () => {
    const { page, listeners, wx } = harness();
    delete wx[missing];
    page.onShow();
    assert.equal(page.data.tableKeyboardAvailable, false);
    assert.equal(listeners.size, 0);
    page.onTableCellFocus(event(0, 1));
    page.onTableCellConfirm(event(0, 1, '5'));
    assert.equal(page.data.tableFocusRow, -1);
    assert.equal(page.data.tableActiveRow, 0);
    assert.equal(page.data.tableRows[0][3], '15');
    page.onHide();
    page.onUnload();
  });
}

test('desktop double click edits only the same cell within the double-click interval', () => {
  const { page, advance } = harness();
  page.onShow();
  page.onTableCellTap(event(0, 0));
  assert.equal(page.data.tableFocusRow, -1);
  advance(100);
  page.onTableCellTap(event(0, 1));
  assert.equal(page.data.tableFocusRow, -1);
  advance(400);
  page.onTableCellTap(event(0, 1));
  assert.equal(page.data.tableFocusRow, -1);
  advance(100);
  page.onTableCellTap(event(0, 1));
  assert.equal(page.data.tableFocusRow, 0);
  assert.equal(page.data.tableFocusCol, 1);
  assert.equal(page.data.tableRows[0][1], '2');
});

test('desktop last-row confirm saves the final value and resumes arrow navigation from that row', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onTableCellTap(event(1, 1));
  press(listeners, 'Enter');
  assert.equal(page.data.tableFocusRow, 1);
  assert.equal(page.data.tableFocusCol, 1);
  page.onTableCellChange(event(1, 1, '5'));
  assert.equal(page.data.tableRows[1][1], '5');
  assert.equal(page.data.tableRows[1][3], '15');
  page.onTableCellConfirm(event(1, 1, '50'));
  assert.equal(page.data.tableRows.length, 2);
  assert.equal(page.data.tableRows[1][1], '50');
  assert.equal(page.data.tableRows[1][3], '150');
  assert.equal(page.data.tableActiveRow, 1);
  assert.equal(page.data.tableActiveCol, 1);
  assert.equal(page.data.tableFocusRow, -1);
  press(listeners, 'ArrowUp');
  assert.equal(page.data.tableActiveRow, 0);
  press(listeners, 'ArrowDown');
  assert.equal(page.data.tableActiveRow, 1);
  press(listeners, 'F2');
  assert.equal(page.data.tableFocusRow, 1);
  assert.equal(page.data.tableRows[1][1], '50');
});

test('unreported shortcut modifiers, text and IME keys cannot overwrite selected desktop cells', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onTableCellTap(event(0, 0));
  const originalRows = JSON.stringify(page.data.tableRows);
  // The documented global event does not expose ctrlKey/metaKey, so Ctrl+C/V
  // can be indistinguishable from a plain letter. Leave text handling to input.
  for (const key of ['c', 'v', '5', ' ', '中', 'Process', 'Dead', 'Unidentified', 'Backspace', 'Delete']) {
    press(listeners, key);
    assert.equal(JSON.stringify(page.data.tableRows), originalRows, key);
    assert.equal(page.data.tableFocusRow, -1, key);
    assert.equal(page.data.tableActiveRow, 0, key);
    assert.equal(page.data.tableActiveCol, 0, key);
  }
});

test('Tab remains available for native focus navigation without changing table selection', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onTableCellTap(event(0, 2));
  press(listeners, 'Tab', { shiftKey: 'false' });
  assert.equal(page.data.tableActiveCol, 2);
  press(listeners, 'Tab', { shiftKey: 'true' });
  assert.equal(page.data.tableActiveCol, 2);
  assert.equal(page.data.tableFocusRow, -1);
});

test('PC navigation accepts string false modifiers and ignores genuinely pressed shortcut modifiers', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onTableCellTap(event(0, 1));
  press(listeners, 'ArrowDown', { altKey: 'false', ctrlKey: 'false', metaKey: 'false' });
  assert.equal(page.data.tableActiveRow, 1);
  press(listeners, 'ArrowUp', { altKey: '0', ctrlKey: 0, metaKey: false });
  assert.equal(page.data.tableActiveRow, 0);
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
    for (const value of [true, 'true', 1, '1']) {
      press(listeners, 'ArrowDown', { [modifier]: value });
      press(listeners, 'x', { [modifier]: value });
      assert.equal(page.data.tableActiveRow, 0, `${modifier}=${value} should preserve shortcut handling`);
      assert.equal(page.data.tableFocusRow, -1);
      assert.equal(page.data.tableRows[0][1], '2');
    }
  }
});

test('clearing selection and hiding the page stop global keys from changing the table', () => {
  const { page, listeners } = harness();
  page.onShow();
  const keyDown = [...listeners][0];
  press(listeners, 'ArrowDown');
  assert.equal(page.data.tableActiveRow, -1);
  page.onTableCellTap(event(0, 1));
  page.clearTableSelection();
  press(listeners, 'ArrowDown');
  press(listeners, 'x');
  assert.equal(page.data.tableActiveRow, -1);
  assert.equal(page.data.tableFocusRow, -1);
  assert.equal(page.data.tableRows[0][1], '2');
  page.onTableCellTap(event(0, 1));
  page.onHide();
  keyDown({ key: 'ArrowDown' });
  keyDown({ key: 'x' });
  assert.equal(page.data.tableActiveRow, -1);
  assert.equal(page.data.tableRows[0][1], '2');
});

test('Escape releases desktop selection without changing cell values', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onTableCellTap(event(0, 1));
  press(listeners, 'Escape');
  assert.equal(page.data.tableActiveRow, -1);
  assert.equal(page.data.tableActiveCol, -1);
  assert.equal(page.data.tableFocusRow, -1);
  press(listeners, 'ArrowDown');
  assert.equal(page.data.tableActiveRow, -1);
  assert.equal(page.data.tableRows[0][1], '2');
});

test('switching templates clears stale cell coordinates until the user selects the new table', () => {
  const { page, listeners } = harness();
  page.onShow();
  page.onTableCellTap(event(1, 4));
  page.data.templates = [{ content: JSON.stringify({ sections: [{ type: 'table', columns: ['说明'], rows: [['内容']] }] }) }];
  page.selectTemplate(0);
  assert.equal(page.data.tableActiveRow, -1);
  assert.equal(page.data.tableFocusCol, -1);
  press(listeners, 'ArrowRight');
  assert.equal(page.data.tableActiveRow, -1);
  page.onTableCellTap(event(0, 0));
  press(listeners, 'Enter');
  assert.equal(page.data.tableFocusRow, 0);
  assert.equal(page.data.tableFocusCol, 0);
});

test('deleting selected or preceding rows keeps selection valid and late blur cannot restore a deleted row', () => {
  const { page } = harness();
  page.onShow();
  page.onTableCellTap(event(1, 1));
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

test('vertical selection scrolls only when a row leaves the viewport after removing the toolbar', () => {
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
      exec: callback => callback([rowRect, { scrollTop: 300 }])
    };
    return query;
  };
  page.selectTableCell(1, 1, false);
  assert.deepEqual(scrolls, [340]);
  rowRect = { top: 90, bottom: 140 };
  page.selectTableCell(1, 1, false);
  assert.deepEqual(scrolls, [340]);
  rowRect = { top: 2, bottom: 52 };
  page.selectTableCell(0, 1, false);
  assert.deepEqual(scrolls, [340, 290]);
});

test('delayed row measurements cannot scroll another page or a later visit to this page', () => {
  const { page, wx } = harness();
  const pending = [], scrolls = [];
  const measurements = [{ top: 700, bottom: 750 }, { scrollTop: 300 }];
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


test('desktop cells use a non-input selection surface and the page has no navigation toolbar', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../pages/sign-contract/sign-contract.wxml'), 'utf8');
  assert.doesNotMatch(markup, /table-navigation|table-keyboard-toggle|左一格|右一格|方向键选格/);
  assert.match(markup, /wx:elif="{{tableKeyboardAvailable && \(tableFocusRow !== ri \|\| tableFocusCol !== ci\)}}"/);
  assert.match(markup, /<view class="td-input td-display[^>]*catchtap="onTableCellTap"/);
  const editableInputs = [...markup.matchAll(/<input\b[^>]*bindconfirm="onTableCellConfirm"[^>]*>/g)];
  assert.equal(editableInputs.length, 3);
  for (const [tag] of editableInputs) {
    assert.match(tag, /confirm-type="done"/, tag);
    assert.doesNotMatch(tag, /confirm-hold/, tag);
  }
  const outsideInputs = [...markup.matchAll(/<(?:input|textarea)\b[^>]*>/g)]
    .map(match => match[0]).filter(tag => !/class="td-input/.test(tag));
  assert.ok(outsideInputs.length > 0);
  for (const tag of outsideInputs) assert.match(tag, /bindfocus="clearTableSelection"/, tag);
});
