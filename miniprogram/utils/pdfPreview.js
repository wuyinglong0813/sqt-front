const { request } = require('./request');
const { downloadChunkedApiFile, localFileReady } = require('./fileTransfer');
const { captureCompanyContext, isCompanyContextCurrent } = require('./companyContext');

// A page can be reopened while a previous instance is still downloading. Share
// the writer for its immutable versioned path rather than append twice to it.
const activeDownloads = new Map();

function previewPageFile(url, filePath, force) {
  if (activeDownloads.has(filePath)) return activeDownloads.get(filePath);
  if (!force && localFileReady(filePath)) return Promise.resolve({ filePath });
  const pending = downloadChunkedApiFile(url, filePath);
  activeDownloads.set(filePath, pending);
  const clean = () => { if (activeDownloads.get(filePath) === pending) activeDownloads.delete(filePath); };
  pending.then(clean, clean);
  return pending;
}

function createPdfPreview({ baseUrl, cachePrefix, isCurrent = () => true, onState }) {
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(baseUrl || '') || !/^[a-zA-Z0-9_-]{1,120}$/.test(cachePrefix || '')) {
    throw new Error('PDF预览地址异常');
  }
  const app = getApp();
  const companyContext = captureCompanyContext(app);
  const ownerCurrent = () => isCurrent() && isCompanyContextCurrent(app, companyContext);
  let disposed = false, generation = 0, versionKey = '', loadingPromise;
  let state = { pages: [], loading: false, error: '', versionChanged: false };
  const current = value => !disposed && value === generation && ownerCurrent();
  const emit = patch => {
    state = { ...state, ...patch };
    if (!disposed && ownerCurrent()) onState({ ...state, pages: state.pages.map(page => ({ ...page })) });
  };
  const updatePage = (number, patch) => emit({ pages: state.pages.map(page => page.pageNumber === number
    ? { ...page, ...patch } : page) });
  const readPage = async (number, force, expectedGeneration) => {
    if (!current(expectedGeneration) || state.versionChanged) return;
    updatePage(number, { loading: true, error: '', filePath: '' });
    try {
      const filePath = `${wx.env.USER_DATA_PATH}/pdf-preview-${cachePrefix}-${versionKey}-page-${number}.png`;
      const result = await previewPageFile(`${baseUrl}/preview-chunk-data?page=${number}&previewKey=${encodeURIComponent(versionKey)}`, filePath, force);
      if (!current(expectedGeneration) || state.versionChanged) return;
      updatePage(number, { filePath: result.filePath, loading: false, error: '' });
    } catch (error) {
      if (!current(expectedGeneration) || state.versionChanged) return;
      if (Number(error && error.code) === 409 || Number(error && error.statusCode) === 409) {
        emit({ pages: [], versionChanged: true, error: '文件内容已更新，请重新加载' });
      } else {
        updatePage(number, { filePath: '', loading: false, error: `第 ${number} 页加载失败，请重试` });
      }
    }
  };

  const load = (force = false) => {
    if (disposed || !ownerCurrent()) return Promise.resolve();
    if (loadingPromise && !force) return loadingPromise;
    const expectedGeneration = ++generation;
    emit({ pages: [], loading: true, error: '', versionChanged: false });
    const pending = (async () => {
      try {
        const manifest = await request({ url: `${baseUrl}/preview-manifest`, timeout: 60000 });
        if (!current(expectedGeneration)) return;
        const count = Number(manifest && manifest.totalPages);
        const key = manifest && manifest.previewKey;
        if (!Number.isSafeInteger(count) || count < 1 || count > 500
            || typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) {
          throw new Error('PDF预览信息异常，请重新加载');
        }
        versionKey = key;
        emit({ pages: Array.from({ length: count }, (_, index) => ({
          pageNumber: index + 1, filePath: '', loading: true, error: ''
        })) });
        let nextPage = 1;
        const worker = async () => {
          while (current(expectedGeneration) && !state.versionChanged && nextPage <= count) {
            const number = nextPage++;
            await readPage(number, force, expectedGeneration);
          }
        };
        await Promise.all(Array.from({ length: Math.min(2, count) }, worker));
      } catch (error) {
        if (current(expectedGeneration)) emit({ pages: [], error: 'PDF预览加载失败，请重试' });
      } finally {
        if (current(expectedGeneration)) emit({ loading: false });
      }
    })();
    loadingPromise = pending;
    pending.then(() => { if (loadingPromise === pending) loadingPromise = null; });
    return pending;
  };

  return {
    load,
    async retry(pageNumber) {
      const number = Number(pageNumber);
      if (disposed || !ownerCurrent() || state.loading) return;
      if (state.versionChanged || !state.pages.length) return load(true);
      if (!Number.isInteger(number) || !state.pages.some(page => page.pageNumber === number)) return;
      const expectedGeneration = generation;
      emit({ loading: true });
      try { await readPage(number, true, expectedGeneration); }
      finally { if (current(expectedGeneration)) emit({ loading: false }); }
    },
    imageError(pageNumber) {
      const number = Number(pageNumber);
      if (disposed || !ownerCurrent() || state.versionChanged || !state.pages.some(page => page.pageNumber === number)) return;
      updatePage(number, { filePath: '', loading: false, error: `第 ${number} 页显示失败，请重试` });
    },
    dispose() { disposed = true; generation += 1; },
    getState() { return { ...state, pages: state.pages.map(page => ({ ...page })) }; }
  };
}

module.exports = { createPdfPreview };
