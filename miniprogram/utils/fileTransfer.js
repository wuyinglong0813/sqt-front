const { request } = require('./request');

const CLOUD_CHUNK_SIZE = 640 * 1024;
const CLOUD_CHUNK_CONCURRENCY = 4;

function writeBase64File(filePath, contentBase64) {
  return new Promise((resolve, reject) => {
    if (!filePath || !contentBase64) {
      reject(new Error('文件内容为空'));
      return;
    }
    wx.getFileSystemManager().writeFile({
      filePath,
      data: contentBase64,
      encoding: 'base64',
      success: () => resolve(filePath),
      fail: error => reject(new Error((error && error.errMsg) || '文件保存失败'))
    });
  });
}

async function downloadApiFile(url, filePath) {
  const payload = await request({ url, timeout: 60000 });
  await writeBase64File(filePath, payload && payload.contentBase64);
  return {
    filePath,
    fileName: (payload && payload.fileName) || '',
    contentType: (payload && payload.contentType) || ''
  };
}

function appendBase64File(filePath, contentBase64, overwrite) {
  return new Promise((resolve, reject) => {
    if (!filePath || !contentBase64) {
      reject(new Error('文件内容为空'));
      return;
    }
    const options = {
      filePath,
      data: contentBase64,
      encoding: 'base64',
      success: () => resolve(filePath),
      fail: error => reject(new Error((error && error.errMsg) || '文件保存失败'))
    };
    const fileSystem = wx.getFileSystemManager();
    if (overwrite) fileSystem.writeFile(options);
    else fileSystem.appendFile(options);
  });
}

function localFileReady(filePath, expectedSize) {
  if (!filePath) return false;
  try {
    const stat = wx.getFileSystemManager().statSync(filePath);
    const actualSize = Number(stat && stat.size);
    const declaredSize = Number(expectedSize || 0);
    return Number.isFinite(actualSize) && actualSize > 0
      && (declaredSize <= 0 || actualSize === declaredSize);
  } catch (error) {
    return false;
  }
}

function fetchFileChunk(url, offset, chunkSize) {
  const separator = url.includes('?') ? '&' : '?';
  return request({
    url: `${url}${separator}offset=${offset}&size=${chunkSize}`,
    timeout: 60000
  });
}

function validateFileChunk(payload, expectedOffset, totalSize) {
  const chunkOffset = Number(payload && payload.offset);
  const chunkLength = Number(payload && payload.length);
  const responseTotalSize = Number(payload && payload.totalSize);
  if (!payload || chunkOffset !== expectedOffset || !Number.isFinite(chunkLength)
    || chunkLength <= 0 || !Number.isFinite(responseTotalSize)
    || responseTotalSize <= 0 || expectedOffset + chunkLength > responseTotalSize
    || (totalSize > 0 && responseTotalSize !== totalSize)) {
    throw new Error('文件分片数据异常，请重试');
  }
  return { chunkLength, totalSize: responseTotalSize };
}

async function downloadChunkedApiFileUnchecked(url, filePath, expectedSize,
  chunkSize = CLOUD_CHUNK_SIZE) {
  const safeChunkSize = Math.max(1, Math.min(Number(chunkSize) || 0, CLOUD_CHUNK_SIZE));
  const declaredSize = Number(expectedSize || 0);
  const firstPayload = await fetchFileChunk(url, 0, safeChunkSize);
  const first = validateFileChunk(firstPayload, 0, declaredSize);
  let totalSize = first.totalSize;
  let offset = first.chunkLength;
  let writtenSize = first.chunkLength;
  await appendBase64File(filePath, firstPayload.contentBase64, true);

  while (offset < totalSize) {
    const offsets = [];
    for (let index = 0; index < CLOUD_CHUNK_CONCURRENCY && offset < totalSize; index += 1) {
      offsets.push(offset);
      offset += Math.min(safeChunkSize, totalSize - offset);
    }
    const payloads = await Promise.all(
      offsets.map(chunkOffset => fetchFileChunk(url, chunkOffset, safeChunkSize))
    );
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index];
      const chunk = validateFileChunk(payload, offsets[index], totalSize);
      await appendBase64File(filePath, payload.contentBase64, false);
      writtenSize += chunk.chunkLength;
    }
  }

  if (writtenSize !== totalSize || (declaredSize > 0 && declaredSize !== totalSize)) {
    throw new Error('文件下载不完整，请重试');
  }
  return {
    filePath,
    fileName: '',
    contentType: '',
    fileSize: totalSize
  };
}

async function downloadChunkedApiFile(url, filePath, expectedSize, chunkSize = CLOUD_CHUNK_SIZE) {
  try {
    return await downloadChunkedApiFileUnchecked(url, filePath, expectedSize, chunkSize);
  } catch (error) {
    try { wx.getFileSystemManager().unlinkSync(filePath); } catch (unlinkError) {}
    throw error;
  }
}

function uploadMultipartApiFile(url, filePath, data = {}, fileFieldName = 'file') {
  return new Promise((resolve, reject) => {
    const app = getApp();
    const token = app.globalData.token || wx.getStorageSync('tradepass_token') || '';
    const companyId = app.globalData.currentCompanyId || '';
    const header = {};
    if (token) header.Authorization = token;
    if (companyId) header['X-Company-Id'] = String(companyId);
    const formData = Object.entries(data || {}).reduce((result, [key, value]) => {
      if (value !== undefined && value !== null) result[key] = String(value);
      return result;
    }, {});

    wx.uploadFile({
      url: `${app.globalData.baseUrl}${url}`,
      filePath,
      name: fileFieldName,
      formData,
      header,
      timeout: 60000,
      success: ({ statusCode, data: rawData }) => {
        let payload = null;
        try {
          payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        } catch (error) {
          reject(new Error('上传响应格式不正确'));
          return;
        }
        if (statusCode === 401 || (payload && payload.code === 401)) {
          reject(new Error('登录已失效'));
          return;
        }
        if (statusCode >= 200 && statusCode < 300 && payload && payload.code === 0) {
          resolve(payload.data);
          return;
        }
        reject(new Error((payload && payload.message) || `上传失败（${statusCode || '未知状态'}）`));
      },
      fail: error => reject(new Error((error && error.errMsg) || '文件上传失败'))
    });
  });
}

async function uploadSignatureApiFile(url, filePath, data = {}) {
  const fs = wx.getFileSystemManager();
  const stat = fs.statSync(filePath);
  if (!stat || !stat.size || stat.size > 500 * 1024) {
    throw new Error('签名图片为空或过大，请重新签名');
  }
  const signatureBase64 = await new Promise((resolve, reject) => {
    fs.readFile({ filePath, encoding: 'base64',
      success: result => resolve(result.data),
      fail: () => reject(new Error('签名图片读取失败，请重新签名')) });
  });
  return request({ url, method: 'POST', data: { ...data, signatureBase64 }, timeout: 60000 });
}

module.exports = {
  uploadSignatureApiFile,
  downloadApiFile,
  downloadChunkedApiFile,
  localFileReady,
  uploadMultipartApiFile,
  writeBase64File
};
