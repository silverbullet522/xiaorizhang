export const currencies = { JPY: 'JPY 日元', CNY: 'CNY 人民币', USD: 'USD 美元' }
export const directions = { expense: '支出', income: '收入', transfer: '转账' }
const tokyoClock = new Intl.DateTimeFormat('sv-SE-u-nu-latn', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

export function tokyoNow(now = new Date()) {
  const parts = Object.fromEntries(tokyoClock.formatToParts(now).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

const seeds = [
  ['food', '餐饮', 'expense', 'coffee', ['正餐', '咖啡饮品', '食材零食']],
  ['travel', '交通', 'expense', 'train', ['公共交通', '打车', '机票']],
  ['shopping', '购物', 'expense', 'bag', ['服饰', '日用品', '数码']],
  ['home', '住房', 'expense', 'home', ['房租', '水电网费']],
  ['fun', '休闲', 'expense', 'sparkle', ['娱乐', '旅行']],
  ['health', '医疗健康', 'expense', 'heart', ['医疗', '运动']],
  ['salary', '工资', 'income', 'wallet', ['基本工资', '奖金']],
  ['extra', '其他收入', 'income', 'gift', ['副业', '礼金']]
]

export const defaults = seeds.flatMap(([id, name, direction, icon, children]) => [
  { id, name, direction, icon, parentId: null },
  ...children.map((child, index) => ({ id: `${id}-${index}`, name: child, direction, icon, parentId: id }))
])

export function dateTime(value, excel1904 = null) {
  if (typeof value === 'number' && excel1904 !== null && Number.isFinite(value) && value >= 0 && value <= 2957000) {
    if (!excel1904 && Math.floor(value) === 60) return null
    const epoch = excel1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, value < 60 ? 31 : 30)
    const date = new Date(epoch + Math.round(value * 86400) * 1000)
    return dateTime(date.toISOString().slice(0, 19))
  }
  const match = String(value ?? '').trim().replace(/年|月/g, '/').replace(/日/g, '')
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return null
  const [, y, m, d, h = '00', min = '00', s = '00'] = match
  const [year, month, day, hour] = [y, m, d, h].map(Number)
  if (year < 1900 || month < 1 || month > 12 || day < 1 || hour > 23 || Number(min) > 59 || Number(s) > 59) return null
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:${s}`
}

export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number)
  return { start: `${month}-01`, end: `${month}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}` }
}

export function offsetDate(day, offset) {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function currencyCode(value) {
  const text = String(value ?? '').normalize('NFKC').trim().toUpperCase()
  if (['JPY', '円', '日元', '日圆', '日圓', 'JP¥', '¥'].includes(text)) return 'JPY'
  if (['CNY', 'RMB', '人民币', '人民幣', '元', 'CN¥'].includes(text)) return 'CNY'
  if (['USD', '美元', 'US$', '$'].includes(text)) return 'USD'
  return null
}

export function amountMinor(value, currency) {
  const normalized = String(value ?? '').normalize('NFKC').trim().replace(/^[¥$]\s*/, '')
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized)) return null
  const [whole, fraction = ''] = normalized.replace(/,/g, '').replace(/^[+-]/, '').split('.')
  const precision = currency === 'JPY' ? 0 : 2
  if (/[1-9]/.test(fraction.slice(precision))) return null
  const amount = Number(whole + fraction.slice(0, precision).padEnd(precision, '0'))
  if (!Number.isSafeInteger(amount) || amount > 1e12) return null
  return normalized.startsWith('-') ? -amount : amount
}

const formatNumber = {
  JPY: new Intl.NumberFormat('zh-CN'),
  CNY: new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  USD: new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function money(minor, currency) {
  if (minor === null || minor === undefined) return '—'
  return `${minor < 0 ? '−' : ''}${{ JPY: '¥', CNY: '¥', USD: '$' }[currency]}${formatNumber[currency].format(Math.abs(minor) / (currency === 'JPY' ? 1 : 100))}`
}

function roundRatio(numerator, denominator) {
  return Number((numerator + denominator / 2n) / denominator)
}

const scale = 10000000000n
const rateUnits = rate => BigInt(Math.round(rate * Number(scale)))

export function withQuotes(entry, quotes) {
  const result = { ...entry, fx: { ...entry.fx } }
  const quoteFor = code => result.fx[code] ?? quotes?.[code]
  if (entry.currency === 'JPY') result.yen = entry.minor
  if (entry.settlementYen != null) result.yen = entry.settlementYen
  if (entry.currency === 'CNY') result.yuan = entry.minor
  if (result.yen == null) {
    const quote = quoteFor(entry.currency)
    if (quote?.rate > 0 && rateUnits(quote.rate) > 0n) {
      result.yen = roundRatio(BigInt(entry.minor) * scale, rateUnits(quote.rate) * 100n)
      result.fx[entry.currency] = quote
    }
  }
  if (result.yuan == null && result.yen != null) {
    const quote = quoteFor('CNY')
    if (quote?.rate > 0 && rateUnits(quote.rate) > 0n) {
      result.yuan = roundRatio(BigInt(result.yen) * rateUnits(quote.rate) * 100n, scale)
      result.fx.CNY = quote
    }
  }
  return result
}

const statement = { date: '取引日', debit: '出金金額(円)', credit: '入金金額(円)', foreign: '海外出金金額', currency: '通貨', rate: '変換レート(円)', type: '取引内容', merchant: '取引先', id: '取引番号' }
const emptyCell = value => value == null || ['', '-', '—', '–'].includes(String(value).trim())

export function statementColumns(headers) {
  const normalized = headers.map(h => String(h ?? '').normalize('NFKC').trim())
  const columns = Object.fromEntries(Object.entries(statement).map(([key, label]) => [key, normalized.indexOf(label)]))
  return ['date', 'debit', 'credit', 'id'].every(key => columns[key] >= 0) ? columns : null
}

export function csvRows(source) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let closed = false
  const endField = () => { row.push(field); field = ''; closed = false }
  const endRow = () => { endField(); rows.push(row); row = [] }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') { quoted = false; closed = true }
      else field += char
    } else if (char === ',' ) endField()
    else if (char === '\n' || char === '\r') {
      endRow()
      if (char === '\r' && source[index + 1] === '\n') index++
    } else if (char === '"' && !field && !closed) quoted = true
    else if (closed || char === '"') throw new Error('CSV 中有不完整的引号，请检查文件格式。')
    else field += char
  }
  if (quoted) throw new Error('CSV 中有尚未闭合的引号。')
  if (row.length || field || closed) endRow()
  return rows
}

function amountPair(debitValue, creditValue, currency) {
  const debit = emptyCell(debitValue) ? 0 : amountMinor(debitValue, currency)
  const credit = emptyCell(creditValue) ? 0 : amountMinor(creditValue, currency)
  if (debit === null || credit === null || Boolean(debit) === Boolean(credit)) return null
  return { direction: debit ? 'expense' : 'income', minor: Math.abs(debit || credit) }
}

function typeCode(value) {
  const token = String(value ?? '').normalize('NFKC').trim().toLowerCase()
  if (['支出', '出金', 'expense', 'debit', 'out', '支付', '支払い'].includes(token)) return 'expense'
  if (['收入', '入金', 'income', 'credit', 'in', '进账'].includes(token)) return 'income'
  if (['转账', '轉帳', '振替', 'transfer'].includes(token)) return 'transfer'
  return null
}

export function importRows(table, options) {
  const { headers, rows, fileKey, excel1904 = null } = table
  const statement = statementColumns(headers)
  return rows.map(({ number, cells }) => {
    const invalid = message => ({ number, error: message })
    const cell = key => cells[(statement ?? options)[key]]
    const at = dateTime(cell('date'), excel1904)
    if (!at) return invalid('日期格式无效')
    let currency
    let amount
    let settlementYen = null
    let sourceRate = null
    let note = String(cell('note') ?? '').trim().slice(0, 500)
    let sourceKey = fileKey ? `file:${fileKey}:${number}` : null
    let categoryId = null
    if (statement) {
      amount = amountPair(cell('debit'), cell('credit'), 'JPY')
      if (!amount) return invalid('出金、入金应有一个有效金额')
      currency = 'JPY'
      if (!emptyCell(cell('foreign'))) {
        currency = currencyCode(cell('currency'))
        if (!currency) return invalid('无法识别海外付款币种')
        const foreign = amountMinor(cell('foreign'), currency)
        if (!foreign || foreign < 0) return invalid('海外付款金额无效')
        settlementYen = amount.minor
        amount.minor = foreign
        const parsedRate = Number(String(cell('rate') ?? '').replace(/,/g, ''))
        sourceRate = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : null
      }
      note = [...new Set([cell('merchant'), cell('type')].filter(value => !emptyCell(value)))].join(' · ').slice(0, 500)
      const id = String(cell('id') ?? '').trim()
      if (!emptyCell(id)) sourceKey = `statement:${id}`
    } else {
      currency = emptyCell(cell('currency')) ? options.fixedCurrency : currencyCode(cell('currency'))
      if (!Object.hasOwn(currencies, currency)) return invalid('币种无效，请选择 JPY、CNY 或 USD')
      if (options.mode === 'pair') {
        amount = amountPair(cell('debit'), cell('credit'), currency)
      } else {
        const minor = amountMinor(cell('amount'), currency)
        const direction = emptyCell(cell('direction')) ? (minor < 0 ? 'expense' : 'income') : typeCode(cell('direction'))
        if (minor && direction) amount = { minor: Math.abs(minor), direction }
      }
      if (!amount) return invalid('金额或收支方向无效')
      const category = String(cell('category') ?? '').normalize('NFKC').trim()
      const matching = (options.categories ?? []).filter(item => item.direction === amount.direction && item.name === category)
      if (matching.length === 1) categoryId = matching[0].id
    }
    return { number, entry: withQuotes({
      at, currency, ...amount, note, categoryId, settlementYen, sourceRate, sourceKey,
      yen: null, yuan: null, fx: {}
    }) }
  })
}

export function duplicatePreviews(rows, entries) {
  const seen = new Set(entries.map(entry => entry.sourceKey).filter(Boolean))
  return rows.map(row => {
    const key = row.entry?.sourceKey
    if (!key) return row
    const duplicate = seen.has(key)
    seen.add(key)
    return { ...row, duplicate }
  })
}

export function within(entry, range) {
  const day = entry.at.slice(0, 10)
  return day >= range.start && day <= range.end
}

export function summarize(entries, currency) {
  const key = currency === 'CNY' ? 'yuan' : 'yen'
  const days = new Map()
  const amounts = { income: 0, expense: 0 }
  let pending = 0
  for (const entry of entries) {
    if (entry.direction === 'transfer') continue
    if (entry[key] == null) { pending++; continue }
    amounts[entry.direction] += entry[key]
    const day = entry.at.slice(0, 10)
    const sums = days.get(day) ?? { income: 0, expense: 0 }
    sums[entry.direction] += entry[key]
    days.set(day, sums)
  }
  return { ...amounts, net: amounts.income - amounts.expense, pending, days }
}
