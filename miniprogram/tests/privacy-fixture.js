'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = function loadPrivacy(wx, getApp) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/privacy.js'), 'utf8'),
    { module, wx, getApp });
  return module.exports;
};
