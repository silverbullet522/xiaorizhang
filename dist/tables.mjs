import { csvRows, statementColumns } from './core.mjs'

let library
async function sheetJS() {
  if (globalThis.XLSX) return globalThis.XLSX
  if (!library) library = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = './vendor/xlsx.full.min.js'
    script.onload = () => globalThis.XLSX ? resolve(globalThis.XLSX) : reject(new Error('无法打开 Excel 解析器。'))
    script.onerror = () => { script.remove(); reject(new Error('无法加载 Excel 解析器，请联网后重试。')) }
    document.head.append(script)
  }).catch(error => { library = null; throw error })
  return library
}

function tableRows(rows, first = 1) {
  const filled = value => value != null && String(value).trim() !== ''
  const firstRow = rows.findIndex(row => row.some(filled))
  if (firstRow < 0) throw new Error('这张表没有可读取的列。')
  const headers = rows[firstRow].map(value => String(value ?? '').trim())
  const data = rows.slice(firstRow + 1).flatMap((cells, i) =>
    cells.some(filled) ? [{ cells, number: first + firstRow + i + 1 }] : [])
  if (data.length > 20000) throw new Error('单张表最多导入 20,000 笔，请拆分文件。')
  return { headers, rows: data }
}

function csvText(bytes) {
  const mark = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength))
  if (mark[0] === 255 && mark[1] === 254) return new TextDecoder('utf-16le').decode(bytes)
  if (mark[0] === 254 && mark[1] === 255) return new TextDecoder('utf-16be').decode(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('shift_jis', { fatal: true }).decode(bytes) }
}

export async function readFile(file) {
  if (!file.size || file.size > 12 * 1024 * 1024) throw new Error('请选择小于 12 MB 的非空表格。')
  const bytes = await file.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const fingerprint = Array.from(new Uint8Array(hash), num => num.toString(16).padStart(2, '0')).join('')
  const extension = file.name.split('.').at(-1).toLowerCase()
  if (extension === 'csv') {
    const table = tableRows(csvRows(csvText(bytes)))
    return { name: file.name, sheetNames: [], table: () => ({ ...table, fileKey: fingerprint }) }
  }
  if (!['xlsx', 'xls'].includes(extension)) throw new Error('请选择 CSV、XLSX 或 XLS 表格。')
  const xlsx = await sheetJS()
  const workbook = xlsx.read(bytes, { type: 'array', cellFormula: false, sheetRows: 20002 })
  if (!workbook.SheetNames.length) throw new Error('这个 Excel 文件没有工作表。')
  return {
    name: file.name,
    sheetNames: workbook.SheetNames,
    table: name => {
      const sheet = workbook.Sheets[name]
      if (!sheet?.['!ref']) throw new Error('这张工作表是空的，请选择其他工作表。')
      const range = xlsx.utils.decode_range(sheet['!ref'])
      if (range.e.r - range.s.r > 20000 || range.e.c - range.s.c > 199) {
        throw new Error('单张表最多导入 20,000 笔和 200 列，请拆分文件。')
      }
      const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: true })
      const table = tableRows(grid, range.s.r + 1)
      const id = statementColumns(table.headers)?.id
      if (id != null) {
        for (const row of table.rows) {
          const cell = sheet[xlsx.utils.encode_cell({ r: row.number - 1, c: range.s.c + id })]
          if (cell?.t === 'n' && cell.w && /^\d+$/.test(cell.w)) row.cells[id] = cell.w
        }
      }
      return { ...table, fileKey: `${fingerprint}:${name}`, excel1904: Boolean(workbook.Workbook?.WBProps?.date1904) }
    }
  }
}

const findHeader = (headers, labels) => headers.findIndex(name => labels.includes(name))
export function guessColumns(headers) {
  const names = headers.map(name => name.normalize('NFKC').toLowerCase().replace(/[\s_]/g, ''))
  const find = (...keys) => findHeader(names, keys)
  const debit = find('支出', '出金', 'debit', 'expense', '出金金额', '支出金额')
  const credit = find('收入', '入金', 'credit', 'income', '入金金额', '收入金额')
  return {
    mode: debit >= 0 && credit >= 0 ? 'pair' : 'signed',
    date: find('日期', '记账日期', '交易时间', '交易日期', '日期时间', '时间', 'date', 'datetime', 'timestamp', '取引日'),
    amount: find('金额', '交易金额', 'amount', '金額'),
    debit, credit,
    direction: find('收支', '类型', '收支类型', '方向', 'direction', 'type'),
    currency: find('币种', '货币', '通貨', 'currency', 'currencycode'),
    category: find('分类', '类别', 'カテゴリ', 'category'),
    note: find('备注', '摘要', '商户', 'memo', 'note', 'description', '取引先'),
    fixedCurrency: 'JPY'
  }
}
