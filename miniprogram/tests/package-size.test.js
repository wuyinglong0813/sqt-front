'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAIN_PACKAGE_LIMIT, checkProject } = require('../../scripts/check-package-size');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqt-package-size-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, content) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const config = { miniprogramRoot: 'app/', packOptions: { ignore: [{ type: 'folder', value: 'tests' }], include: [] } };
  const manifest = { pages: ['pages/home'], subPackages: [{ root: 'pagesFace', pages: ['middle'] }] };
  const saveConfig = () => write('project.config.json', JSON.stringify(config));
  saveConfig();
  write('app/app.json', JSON.stringify(manifest));
  write('app/app.js', 'App({});');
  write('app/pages/home.js', 'Page({});');
  write('app/pages/home.wxml', '<view>首页</view>');
  write('app/pagesFace/middle.js', 'Page({});');
  write('app/pagesFace/middle.wxml', '<view>核验</view>');
  return { directory, write, config, saveConfig, run: () => checkProject(path.join(directory, 'project.config.json')) };
}

test('test files stay out of the main package while subpackage bytes remain separate', t => {
  const f = fixture(t);
  const initial = f.run();
  f.write('app/tests/large.test.js', Buffer.alloc(700_000));
  f.write('app/tests/nested/data.json', 'fixture');
  f.write('app/tests-helper.js', 'runtime');
  f.write('app/pagesFace/image.png', Buffer.alloc(1234));
  const report = f.run();
  assert.equal(report.main.bytes, initial.main.bytes + Buffer.byteLength('runtime'));
  assert.equal(report.excluded.bytes, 700_007);
  assert.equal(report.subPackages[0].bytes, initial.subPackages[0].bytes + 1234);
});

test('main source at the 1.5 MB boundary fails even when the extra file has no references', t => {
  const f = fixture(t);
  const initial = f.run().main.bytes;
  f.write('app/unreferenced.bin', Buffer.alloc(MAIN_PACKAGE_LIMIT - initial - 1));
  assert.equal(f.run().main.bytes, MAIN_PACKAGE_LIMIT - 1);
  f.write('app/unreferenced.bin', Buffer.alloc(MAIN_PACKAGE_LIMIT - initial));
  assert.throws(f.run, /budget exceeded/);
});

test('includes cannot silently reintroduce tests or ignore a runtime entry to pass the budget', t => {
  const f = fixture(t);
  f.write('app/tests/fixture.js', 'test-only');
  f.config.packOptions.include = [{ type: 'file', value: 'tests/fixture.js' }];
  f.saveConfig();
  assert.throws(f.run, /Test files would enter/);
  f.config.packOptions.include = [];
  f.config.packOptions.ignore.push({ type: 'folder', value: 'pages' });
  f.saveConfig();
  assert.throws(f.run, /Runtime entry missing or excluded/);
});

test('both supported project imports exclude tooling and enforce the same main package budget', () => {
  const repository = path.resolve(__dirname, '../..');
  const reports = ['project.config.json', 'miniprogram/project.config.json'].map(file => {
    const configPath = path.join(repository, file);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const rule of [
      { type: 'folder', value: 'tests' },
      { type: 'file', value: 'project.config.json' },
      { type: 'file', value: 'project.private.config.json' }
    ]) assert.ok(config.packOptions.ignore.some(item => item.type === rule.type && item.value === rule.value));
    return checkProject(configPath);
  });
  assert.equal(reports[0].main.bytes, reports[1].main.bytes);
  assert.equal(reports[0].subPackages[0].name, 'pagesFace');
  assert.ok(reports[0].main.bytes < MAIN_PACKAGE_LIMIT);
});
