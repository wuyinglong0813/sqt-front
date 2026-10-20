'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let page;
  const calls = [], modals = [], sheets = [], notices = [], chosen = [];
  const saved = { SALES_ORDER: [], RETURN_ORDER: [] };
  const wx = {
    showModal: options => modals.push(options),
    showActionSheet: options => sheets.push(options),
    showToast: options => notices.push(options.title),
    showLoading() {}, hideLoading() {},
    chooseMessageFile: options => chosen.push(options),
    getFileSystemManager: () => ({ readFile: options => options.success({ data: '{"columns":["品名","数量"],"blankRows":8}' }) })
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/document-template/document-template.js'), 'utf8'), {
    Page: definition => { page = definition; }, wx,
    require: id => {
      if (id.endsWith('/datetime')) return { formatDateTime: value => value || '' };
      if (id.endsWith('/privacy')) return { runPrivacyAction: async action => action() };
      if (id.endsWith('/request')) return { request: async options => {
        calls.push(options);
        if (options.method === 'POST') {
          saved[options.data.documentType].push({ id: '2098123456789012345', ...options.data });
          return {};
        }
        return saved[options.url.endsWith('RETURN_ORDER') ? 'RETURN_ORDER' : 'SALES_ORDER'];
      } };
      throw new Error(`Unexpected require: ${id}`);
    }
  });
  page.setData = values => Object.assign(page.data, values);
  return { page, wx, calls, modals, sheets, notices, chosen, saved };
}

test('adding a template first offers standard recovery without opening WeChat chats', () => {
  const h = harness();
  h.page.uploadSalesTemplate();
  assert.equal(h.chosen.length, 0);
  assert.match(h.sheets[0].itemList[0], /标准销售单模板/);
  h.sheets[0].success({ tapIndex: 0 });
  assert.match(h.modals[0].content, /无需准备或上传文件/);
  h.modals[0].success({ confirm: false });
  assert.equal(h.calls.length, 0);
});

test('an empty company can restore and reuse a standard template through the existing API', async () => {
  const h = harness();
  h.page.restoreActiveTemplate();
  const originalSave = h.page.saveTemplate;
  let finished;
  h.page.saveTemplate = (...args) => { finished = originalSave.apply(h.page, args); return finished; };
  h.modals[0].success({ confirm: true });
  await finished;
  assert.equal(h.chosen.length, 0);
  const write = h.calls.find(call => call.method === 'POST');
  assert.equal(write.url, '/document-templates');
  assert.equal(write.data.name, '标准销售单模板');
  assert.deepEqual(JSON.parse(write.data.content), {
    columns: ['序号', '品名', '规格', '单位', '数量', '单价', '金额', '备注'], blankRows: 8
  });
  assert.equal(h.page.data.salesCount, 1);
  assert.equal(h.page.data.templates[0].name, '标准销售单模板');
  h.page.restoreActiveTemplate();
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.notices.at(-1), '标准模板已在列表中');
});

test('custom upload explains the accepted file and chat source before choosing a file', async () => {
  const h = harness();
  h.page.uploadReturnTemplate();
  h.sheets[0].success({ tapIndex: 1 });
  assert.equal(h.chosen.length, 0);
  assert.match(h.modals[0].content, /JSON/);
  assert.match(h.modals[0].content, /微信聊天/);
  assert.match(h.modals[0].content, /标准模板/);
  h.modals[0].success({ confirm: true });
  await Promise.resolve();
  assert.equal(h.chosen.length, 1);
  await h.chosen[0].success({ tempFiles: [{ path: '/template.json', name: '退货版式.json' }] });
  assert.equal(h.modals[1].title, '上传退货单模板');
});

test('an invalid custom file is rejected without creating a substitute standard template', async () => {
  const h = harness();
  h.wx.getFileSystemManager = () => ({ readFile: options => options.success({ data: '{"columns":[null]}' }) });
  await h.page.chooseTemplateFile('SALES_ORDER');
  await h.chosen[0].success({ tempFiles: [{ path: '/invalid.json', name: 'invalid.json' }] });
  assert.equal(h.calls.length, 0);
  assert.equal(h.modals[0].title, '模板文件无法使用');
  assert.match(h.modals[0].content, /标准模板/);
  await assert.rejects(h.page.readTemplateContent('/template.pdf', 'template.pdf'), /JSON/);
});

test('deleting the final template warns about custom data and points to standard recovery', () => {
  const h = harness();
  const template = { id: '2098123456789012345', documentType: 'RETURN_ORDER', name: '企业退货单' };
  h.page.data.returnTemplates = [template];
  h.page.deleteTemplate({ currentTarget: { dataset: { template } } });
  assert.match(h.modals[0].content, /最后一个退货单模板/);
  assert.match(h.modals[0].content, /自定义内容无法恢复/);
  assert.match(h.modals[0].content, /可恢复标准版式/);
  h.modals[0].success({ confirm: false });
  assert.equal(h.calls.length, 0);
});
