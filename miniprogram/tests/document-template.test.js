'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let page;
  const calls = [], modals = [], notices = [], chosen = [], shared = [], files = [], copied = [];
  const saved = { SALES_ORDER: [], RETURN_ORDER: [] };
  const wx = {
    showModal: options => modals.push(options),
    showToast: options => notices.push(options.title),
    showLoading() {}, hideLoading() {},
    env: { USER_DATA_PATH: '/user-data' },
    setClipboardData: options => copied.push(options.data),
    shareFileMessage: options => shared.push(options),
    chooseMessageFile: options => chosen.push(options),
    getFileSystemManager: () => ({
      readFile: options => options.success({ data: '{"columns":["品名","数量"],"blankRows":8}' }),
      writeFile: options => { files.push(options); options.success(); }
    })
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
  page.setData = values => Object.entries(values).forEach(([key, value]) => {
    const keys = key.split('.');
    let target = page.data;
    keys.slice(0, -1).forEach(part => { target = target[part]; });
    target[keys.at(-1)] = value;
  });
  return { page, wx, calls, modals, notices, chosen, saved, shared, files, copied };
}

test('adding a template first offers explained options and a read-only standard preview', () => {
  const h = harness();
  h.page.uploadSalesTemplate();
  assert.equal(h.chosen.length, 0);
  assert.equal(h.page.data.addType, 'SALES_ORDER');
  h.page.previewStandardOption();
  assert.equal(h.page.data.addType, '');
  assert.equal(h.page.data.preview.mode, 'standard');
  assert.equal(h.page.data.preview.name, '标准销售单模板');
  assert.equal(h.page.data.preview.columns.at(-1), '备注');
  assert.equal(h.page.data.preview.rows.length, 8);
  h.page.closeTemplatePreview();
  assert.equal(h.page.data.preview, null);
  assert.equal(h.calls.length, 0);
});

test('an empty company can restore and reuse a standard template through the existing API', async () => {
  const h = harness();
  h.page.restoreActiveTemplate();
  assert.equal(h.calls.length, 0);
  await h.page.applyPreviewTemplate();
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
  assert.equal(h.page.data.preview.alreadyAdded, true);
  await h.page.applyPreviewTemplate();
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.notices.at(-1), '标准模板已在列表中');
});

test('custom upload provides a copyable and exportable valid JSON example before choosing a file', async () => {
  const h = harness();
  h.page.uploadReturnTemplate();
  h.page.explainTemplateUpload();
  assert.equal(h.chosen.length, 0);
  assert.equal(h.page.data.uploadGuideType, 'RETURN_ORDER');
  h.page.copyUploadExample();
  h.page.shareUploadExample();
  assert.equal(h.copied[0], h.files[0].data);
  assert.equal(h.files[0].encoding, 'utf8');
  assert.deepEqual(JSON.parse(h.files[0].data), {
    columns: ['序号', '品名', '规格', '单位', '数量', '单价', '金额', '退货原因'], blankRows: 8
  });
  assert.equal(h.shared[0].filePath, '/user-data/退货单模板示例.json');
  h.page.chooseUploadFile();
  await Promise.resolve();
  assert.equal(h.chosen.length, 1);
  await h.chosen[0].success({ tempFiles: [{ path: '/template.json', name: '退货版式.json' }] });
  assert.equal(h.page.data.uploadGuideType, '');
  assert.equal(h.page.data.preview.mode, 'upload');
  assert.equal(h.page.data.preview.name, '退货版式');
  assert.equal(h.page.data.preview.columns.join(','), '品名,数量');
  assert.equal(h.calls.length, 0);
  h.page.onPreviewNameInput({ detail: { value: '企业退货单' } });
  await h.page.applyPreviewTemplate();
  assert.equal(h.calls.find(call => call.method === 'POST').data.name, '企业退货单');
  assert.equal(h.page.data.preview, null);
});

test('an existing template opens its actual columns and row count without a write', async () => {
  const h = harness();
  const template = { id: '2098123456789012345', documentType: 'RETURN_ORDER', name: '企业退货版式', content: '{"columns":["数量","品名","退货原因"],"blankRows":12}' };
  h.page.previewTemplate({ currentTarget: { dataset: { template } } });
  assert.equal(h.page.data.preview.mode, 'existing');
  assert.equal(h.page.data.preview.label, '退货单');
  assert.equal(h.page.data.preview.sourceText, '自定义表格版式');
  assert.equal(h.page.data.preview.columns.join(','), '数量,品名,退货原因');
  assert.equal(h.page.data.preview.blankRows, 12);
  assert.equal(h.page.data.preview.rows.length, 8);
  assert.equal(h.page.data.preview.rows[0].join(','), '2,示例商品,示例退货原因');
  await h.page.applyPreviewTemplate();
  assert.equal(h.calls.length, 0);
});

test('standard template and uploaded template previews use the correct document type', () => {
  const h = harness();
  h.page.uploadReturnTemplate();
  h.page.explainTemplateUpload();
  h.page.useStandardFromGuide();
  assert.equal(h.page.data.uploadGuideType, '');
  assert.equal(h.page.data.preview.label, '退货单');
  assert.equal(h.page.data.preview.columns.at(-1), '退货原因');
  assert.equal(h.page.data.preview.rows.length, 8);
  assert.equal(h.calls.length, 0);
});

test('upload rejects unsupported payloads and invalid row limits before preview or save', async () => {
  const h = harness();
  for (const content of [
    '{"columns":["品名"],"rows":[["货品"]]}',
    '{"columns":["品名"],"blankRows":5000}',
    '{"columns":["品名"],"blankRows":8.5}',
    JSON.stringify({ columns: Array.from({ length: 21 }, (_, i) => `列${i}`) })
  ]) {
    h.wx.getFileSystemManager = () => ({ readFile: options => options.success({ data: content }) });
    await assert.rejects(h.page.readTemplateContent('/template.json', 'template.json'));
  }
  assert.equal(h.page.data.preview, null);
  assert.equal(h.calls.length, 0);
  await h.page.chooseTemplateFile('SALES_ORDER');
  await h.chosen[0].success({ tempFiles: [{ path: '/large.json', name: 'large.json', size: 300 * 1024 }] });
  assert.match(h.modals[0].content, /256 KB/);
});

test('example export gives a useful fallback on unsupported clients', () => {
  const h = harness();
  h.page.uploadSalesTemplate();
  h.page.explainTemplateUpload();
  h.wx.shareFileMessage = undefined;
  h.page.shareUploadExample();
  assert.equal(h.files.length, 0);
  assert.match(h.notices[0], /复制示例/);
});

test('template cards expose preview while delete stops propagation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../pages/document-template/document-template.wxml'), 'utf8');
  assert.match(source, /class="template-card"[^>]*bindtap="previewTemplate"/);
  assert.match(source, /class="template-delete"[^>]*catchtap="deleteTemplate"/);
  assert.match(source, /暂不支持 Word、PDF、Excel/);
  assert.match(source, /class="json-example" selectable/);
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
