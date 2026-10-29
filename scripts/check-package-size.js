'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Deliberately count uncompressed source, including unused runtime assets.
// This is a local budget check, not WeChat's compiled-package size report.
const MAIN_PACKAGE_LIMIT = 1_500_000;

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)
      || value.split('/').includes('..')) throw new Error(`Invalid package path: ${value}`);
  return value.replace(/^\.\//, '').replace(/\/$/, '');
}

function ruleMatcher(rule) {
  const value = relativePath(rule.value);
  if (rule.type === 'file') return file => file === value;
  if (rule.type === 'folder') return file => file === value || file.startsWith(`${value}/`);
  // Fail closed rather than silently miscount a new packOptions rule type.
  throw new Error(`Unsupported packOptions rule: ${rule.type}; update the size checker first`);
}

function measureProject(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const root = path.resolve(path.dirname(configPath), config.miniprogramRoot || './');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const excludes = (config.packOptions?.ignore || []).map(ruleMatcher);
  const includes = (config.packOptions?.include || []).map(ruleMatcher);
  const ignored = file => !includes.some(match => match(file)) && excludes.some(match => match(file));
  const packages = (app.subPackages || app.subpackages || []).map(group => ({
    root: relativePath(group.root), pages: group.pages || [], bytes: 0, files: 0
  }));
  const main = { bytes: 0, files: 0 };
  const excluded = { bytes: 0, files: 0 };
  const includedFiles = new Set();
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink not supported in package: ${absolute}`);
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const file = path.relative(root, absolute).split(path.sep).join('/');
      const bytes = fs.statSync(absolute).size;
      if (ignored(file)) { excluded.bytes += bytes; excluded.files += 1; continue; }
      includedFiles.add(file);
      const destination = packages.find(group => file.startsWith(`${group.root}/`)) || main;
      destination.bytes += bytes;
      destination.files += 1;
    }
  };
  walk(root);
  // Misconfigured exclusions must not make the budget look good by dropping
  // the app, page entrypoints or native tab icons.
  const required = ['app.json', 'app.js', ...(app.pages || []).flatMap(page => [`${page}.js`, `${page}.wxml`]),
    ...packages.flatMap(group => group.pages.flatMap(page => [`${group.root}/${page}.js`, `${group.root}/${page}.wxml`])),
    ...(app.tabBar?.list || []).flatMap(tab => [tab.iconPath, tab.selectedIconPath].filter(Boolean))];
  for (const file of required) {
    if (!includedFiles.has(file)) throw new Error(`Runtime entry missing or excluded: ${file}`);
  }
  if ([...includedFiles].some(file => file === 'tests' || file.startsWith('tests/'))) {
    throw new Error(`Test files would enter the runtime package: ${configPath}`);
  }
  return { configPath, main, subPackages: packages.map(({ root: name, bytes, files }) => ({ name, bytes, files })), excluded };
}

function checkProject(configPath) {
  const report = measureProject(configPath);
  if (report.main.bytes >= MAIN_PACKAGE_LIMIT) {
    throw new Error(`Main package source budget exceeded: ${report.main.bytes} >= ${MAIN_PACKAGE_LIMIT} bytes (${configPath})`);
  }
  return report;
}

if (require.main === module) {
  try {
    const repository = path.resolve(__dirname, '..');
    const configs = ['project.config.json', 'miniprogram/project.config.json'];
    for (const config of configs) {
      const report = checkProject(path.join(repository, config));
      process.stdout.write(`${config}: main source ${report.main.bytes.toLocaleString('en-US')} B`
        + ` (${(report.main.bytes / 1024 / 1024).toFixed(3)} MiB) < ${MAIN_PACKAGE_LIMIT.toLocaleString('en-US')} B;`
        + ` excluded ${report.excluded.bytes.toLocaleString('en-US')} B\n`);
      for (const group of report.subPackages) process.stdout.write(`  ${group.name}: ${group.bytes.toLocaleString('en-US')} B\n`);
    }
    process.stdout.write('Source-only budget check passed. Final compiled size is reported by WeChat DevTools.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MAIN_PACKAGE_LIMIT, measureProject, checkProject };
