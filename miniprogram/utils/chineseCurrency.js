/**
 * 数字金额转中文大写
 * @param {number} num
 * @returns {string} 如 "壹万贰仟叁佰肆拾伍元陆角柒分"
 */
function numberToChineseCurrency(num) {
  if (num === null || num === undefined || isNaN(num) || num < 0) return '零元整';
  if (num === 0) return '零元整';

  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const radices = ['', '拾', '佰', '仟'];
  const bigRadices = ['', '万', '亿', '兆'];

  // 处理到分
  const amount = Math.round(num * 100);
  const intPart = Math.floor(amount / 100);
  const decPart = amount % 100;

  let result = '';

  // 处理整数部分（每4位一组）
  if (intPart > 0) {
    let zeroCount = 0;
    const intStr = String(intPart);
    const len = intStr.length;
    let needZero = false;

    for (let i = 0; i < len; i++) {
      const p = len - 1 - i;           // 从右往左的位置
      const d = parseInt(intStr[i]);    // 当前数字
      const q = Math.floor(p / 4);      // 大单位索引（万/亿）
      const r = p % 4;                  // 小单位索引（仟/佰/拾）

      if (d === 0) {
        zeroCount++;
      } else {
        if (zeroCount > 0 && needZero) {
          result += '零';
        }
        result += digits[d] + radices[r];
        zeroCount = 0;
        needZero = true;
      }

      // 在每4位末尾（r===0 即个位）加上大单位
      if (r === 0) {
        if (zeroCount < 4) {
          result += bigRadices[q];
        }
        zeroCount = 0;
        needZero = false;
      }
    }
    result += '元';
  }

  // 处理小数部分
  const jiao = Math.floor(decPart / 10);
  const fen = decPart % 10;

  if (jiao === 0 && fen === 0) {
    result += '整';
  } else {
    if (jiao > 0) {
      result += digits[jiao] + '角';
    } else if (intPart > 0) {
      result += '零';
    }
    if (fen > 0) {
      result += digits[fen] + '分';
    }
  }

  return result;
}

/**
 * 默认购销合同模板 JSON
 */
const DEFAULT_CONTRACT_COLUMNS = ['产品名称', '规格型号', '单位', '数量', '单价(元)', '金额(元)', '备注'];

const DEFAULT_TEMPLATE = {
  title: '购销合同',
  fields: [
    { key: 'contractNo', label: '合同编号', value: '', editable: false, hint: '签订时自动生成' },
    { key: 'supplier', label: '供方（甲方）', value: '', editable: true },
    { key: 'buyer', label: '需方（乙方）', value: '', editable: true },
    { key: 'signDate', label: '签订日期', value: '', editable: true, type: 'date' }
  ],
  sections: [
    {
      title: '产品名称、规格、数量、单价、金额',
      type: 'table',
      columns: DEFAULT_CONTRACT_COLUMNS,
      rows: [['', '', '', '0', '0', '0', '']]
    },
    { title: '质量要求、技术标准', type: 'clause', content: '' },
    { title: '交货时间、地点、方式', type: 'clause', content: '' },
    { title: '运输方式及费用承担', type: 'clause', content: '' },
    { title: '包装标准及费用', type: 'clause', content: '' },
    { title: '验收标准、方法', type: 'clause', content: '' },
    { title: '结算方式及期限', type: 'clause', content: '' },
    { title: '违约责任', type: 'clause', content: '' },
    { title: '合同争议解决方式', type: 'clause', content: '' },
    { title: '合同生效与变更', type: 'clause', content: '' },
    { title: '其他约定事项', type: 'clause', content: '' }
  ]
};

/**
 * 计算产品表格合计
 * @param {Array<Array<string>>} rows - 合同商品行
 * @param {Array<string>} columns - 合同商品列
 * @returns {{ rows, totalAmount: number, totalAmountCn: string }}
 */
function calcTableTotal(rows, columns = DEFAULT_CONTRACT_COLUMNS) {
  const normalizedColumns = normalizeContractColumns(columns);
  const quantityIndex = findContractColumn(normalizedColumns, ['数量'], 3);
  const priceIndex = findContractColumn(normalizedColumns, ['单价'], 4);
  const amountIndex = findContractColumn(normalizedColumns, ['金额'], 5);
  let total = 0;
  const calcRows = (rows || []).map(row => {
    const next = normalizedColumns.map((_, index) => {
      const value = (row || [])[index];
      return value == null ? '' : String(value);
    });
    const qty = parseFloat(next[quantityIndex]) || 0;
    const price = parseFloat(next[priceIndex]) || 0;
    const amount = Math.round(qty * price * 100) / 100;
    total += amount;
    next[quantityIndex] = next[quantityIndex] || '0';
    next[priceIndex] = next[priceIndex] || '0';
    next[amountIndex] = String(amount);
    return next;
  });
  return {
    rows: calcRows,
    totalAmount: Math.round(total * 100) / 100,
    totalAmountCn: numberToChineseCurrency(Math.round(total * 100) / 100)
  };
}

function findContractColumn(columns, aliases, fallback = -1) {
  const index = (columns || []).findIndex(column => aliases.some(alias => String(column || '').includes(alias)));
  if (index >= 0) return index;
  return fallback >= 0 && fallback < (columns || []).length ? fallback : -1;
}

function normalizeContractColumns(columns) {
  const normalized = Array.isArray(columns) && columns.length > 0
    ? columns.map(column => String(column || ''))
    : DEFAULT_CONTRACT_COLUMNS.slice();
  if (!normalized.some(column => column.includes('备注'))) normalized.push('备注');
  return normalized;
}

function normalizeContractTable(columns, rows) {
  const sourceColumns = Array.isArray(columns) ? columns.map(column => String(column || '')) : [];
  const normalizedColumns = normalizeContractColumns(sourceColumns);
  const remarkAdded = normalizedColumns.length > sourceColumns.length;
  const normalizedRows = (rows || []).map(row => {
    const next = Array.isArray(row) ? row.map(value => value == null ? '' : String(value)) : [];
    if (remarkAdded) next.push('');
    while (next.length < normalizedColumns.length) next.push('');
    return next.slice(0, normalizedColumns.length);
  });
  return {
    columns: normalizedColumns,
    rows: normalizedRows.length > 0
      ? normalizedRows
      : [normalizedColumns.map(column => ['数量', '单价', '金额'].some(alias => column.includes(alias)) ? '0' : '')]
  };
}

function calcFeeTotal(fees) {
  return Math.round((fees || []).reduce((sum, item) => sum + (parseFloat(item && item.amount) || 0), 0) * 100) / 100;
}

const CHINESE_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十'];

/**
 * 数字转中文序号（1→一，11→十一）
 */
function toChineseNum(n) {
  const idx = Math.max(0, n - 1);
  return CHINESE_NUMS[idx] || String(n);
}

/**
 * 重新编排条款序号（标题不含数字前缀，序号由 _label 统一管理）
 * 兼容已有带数字前缀的标题，自动去除
 * @returns {Array<{title:string, content:string, _num:string, _label:string}>}
 */
function reorderClauses(clauses) {
  return (clauses || []).map((c, i) => {
    // 去除标题中可能已有的中文数字前缀（如 "一、xxx" → "xxx"）
    const title = (c.title || '').replace(/^[一二三四五六七八九十]+、\s*/, '');
    return {
      title,
      content: c.content || '',
      _num: toChineseNum(i + 1),
      _label: toChineseNum(i + 1) + '、'
    };
  });
}

module.exports = {
  numberToChineseCurrency,
  DEFAULT_CONTRACT_COLUMNS,
  DEFAULT_TEMPLATE,
  calcTableTotal,
  calcFeeTotal,
  findContractColumn,
  normalizeContractColumns,
  normalizeContractTable,
  toChineseNum,
  reorderClauses
};
