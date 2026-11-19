import { amountMinor, currencyCode, dateTime, tokyoNow } from './core.mjs'

export const screenTextLimit = 12000

const mark = 'JPY|CNY|RMB|USD|CN¥|JP¥|US\\$|人民币|人民幣|日元|日圆|日圓|美元|円|元|[¥$]'
const number = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?'
const amounts = new RegExp(
  '(?<![\\w.,])(?:(?<sign>[+-])\\s*)?(?:(?<before>' + mark + ')\\s*(?:(?<inner>[+-])\\s*)?)?' +
  '(?<number>' + number + ')(?:\\s*(?<after>' + mark + '))?(?![\\w.,])', 'giu'
)
const onlyMark = new RegExp('^(?:' + mark + ')$', 'iu')
const paid = /(?:实付(?:金额)?|實付(?:金額)?|实际支付|實際支付|支付金额|支付金額|付款金额|付款金額|扣款金额|扣款金額|退款金额|退款金額|到账金额|到帳金額|收款金额|收款金額|お支払い(?:金額)?|お支払(?:金額)?|支払い金額|お会計|支払[額金]|決済金額|利用金額|返金額|amount paid|total paid|paid amount|refund amount|amount received)\s*[:：]*$/iu
const total = /(?:应付(?:金额)?|應付(?:金額)?|总金额|總金額|交易金额|交易金額|金额|金額|总计|總計|合计|合計|grand total|total|amount)\s*[:：]*$/iu
const ignore = /(?:原价|原價|原金额|原金額|原币|原幣|原始金额|订单金额|訂單金額|商品金额|商品總額|海外利用額|外貨金額|参考金额|換算|折合|汇率|匯率|レート|小计|小計|优惠|優惠|折扣|クーポン|値引|节省|節省|立减|立減|余额|餘額|残高|积分|積分|ポイント|税|稅|手续费|手續費|手数料|运费|運費|送料|小费|小費|订单号|訂單號|交易号|交易號|卡号|卡號|交易单号|取引番号|明細番号|\b(?:subtotal|discount|coupon|balance|points|tax(?:es)?|fees?|shipping|tip|order (?:id|no)|account|card number)\b)/iu
const unsupported = /(?:HK\$|HKD|TWD|EUR|GBP|CAD|AUD|SGD|KRW|€|£|₩)/iu
const merchantField = /^(?:付给|付款给|收款方|商户名称|商戶名稱|商家名称|商家名稱|店铺名称|店鋪名稱|商户(?!订单|編號|编号)|商戶(?!訂單|編號)|商家|对方名称|對方名稱|お支払い先|支払先|店舗名|加盟店名|ご利用先|利用先|merchant|payee|paid to)\s*[:：]?\s*(.*)$/iu
const timeField = /^(?:交易时间|交易時間|交易日期|付款时间|付款時間|支付时间|支付時間|交易日|取引日|支払日時|利用日時|決済日時|transaction (?:date|time)|paid at)\s*[:：]?\s*(.*)$/iu
const fullStamp = /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?[ T]+\d{1,2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:\d{2})?/i
const received = /(?:退款成功|已退款|退款金[额額]|已退回|已到[账帳]|到[账帳]金[额額]|收款成功|收款金[额額]|已收款|返金(?:完了|額)|refunded|refund amount|payment received|amount received)/iu
const unfinished = /^(?:支付失败|付款失败|交易失败|未支付|待支付|待付款|交易已?取消|交易关闭|決済失敗|支払い失敗|支払い待ち|payment (?:failed|declined|pending|cancelled|canceled))\s*[。.!！]?$/iu
const statusText = /(?:成功|完了|支払い|支付|付款|退款|交易|订单|訂單|详情|詳情|明細|レシート|receipt|payment|completed|success|total|amount|查看|返回|确认|確認|完成|星期|wallet|钱包|錢包|paypay|alipay|支付宝|支付寶|微信)/iu

function currencyHint(text) {
  const hints = []
  if (/(?:\b(?:CNY|RMB|Alipay)\b|人民币|人民幣|支付宝|支付寶|微信支付|财付通|財付通)/iu.test(text)) hints.push('CNY')
  if (/(?:\b(?:JPY|PayPay)\b|日[元圆圓]|お支払|支払い|決済|円)/iu.test(text)) hints.push('JPY')
  if (/(?:\bUSD\b|US\$|美元)/iu.test(text)) hints.push('USD')
  return hints.length === 1 ? hints[0] : null
}

function grade(context) {
  if (paid.test(context)) {
    // 原支付金额 refers to the original charge.
    return /(?:原|参考|參考|折合|換算)\s*(?:实际)?(?:支付|付款|实付)?[金额金額]*\s*[:：]*$/u.test(context) ? 0 : 4
  }
  if (ignore.test(context) || unsupported.test(context)) return 0
  if (total.test(context)) return 3
  return 2
}

function findCandidates(lines, hint) {
  const results = []
  lines.forEach((line, row) => {
    let previousEnd = 0
    for (const match of line.matchAll(amounts)) {
      const { before, after, number: digits, sign, inner } = match.groups
      const segment = line.slice(previousEnd, match.index).trim()
      const first = previousEnd === 0
      previousEnd = match.index + match[0].length
      const rest = line.slice(previousEnd)
      const standalone = !segment && !rest.trim() && first
      const prior = lines[row - 1] ?? ''
      const previousMark = standalone && onlyMark.test(prior) ? prior : null
      const context = segment || (standalone ? lines[row - (previousMark ? 2 : 1)] ?? '' : '')
      const score = grade(context)
      const marks = [before || previousMark, after].filter(Boolean)
      if (!score || unsupported.test(rest.trim().split(/\s+/)[0]) ||
          (!marks.length && (score < 3 || (rest.trim() && !standalone)))) continue
      const explicit = [...new Set(marks.filter(value => value !== '¥' && value !== '$').map(currencyCode).filter(Boolean))]
      if (explicit.length > 1) continue
      const compatibleHint = marks.every(value => value !== '$' || hint === 'USD') &&
        marks.every(value => value !== '¥' || hint !== 'USD')
      const currency = explicit[0] ?? (compatibleHint ? hint : null)
      const raw = digits.replace(/,/g, '')
      if (!amountMinor(raw, currency ?? 'CNY')) continue
      results.push({ row, currency, amount: raw, score, sign: sign || inner, context })
    }
  })
  return results
}

function merchantName(lines, chosen) {
  const plausible = value => value && value.length <= 100 && /[\p{L}]/u.test(value) &&
    !/\d{7,}|^[*•·×]+|https?:\/\//iu.test(value) && !ignore.test(value) && !timeField.test(value) &&
    !fullStamp.test(value) && !onlyMark.test(value)
  for (const [index, line] of lines.entries()) {
    const match = merchantField.exec(line)
    if (!match) continue
    const name = match[1] || lines[index + 1]
    if (plausible(name) && !statusText.test(name) && !paid.test(name) && !total.test(name)) return name
  }
  if (!chosen) return ''
  const nearby = lines.slice(Math.max(0, chosen.row - 2), chosen.row).filter(line =>
    plausible(line) && !statusText.test(line) && !paid.test(line) && !total.test(line) && !line.includes(':') &&
    ![...line.matchAll(amounts)].some(match => match.groups.before || match.groups.after))
  return nearby.length === 1 ? nearby[0] : ''
}

function screenTimestamp(lines) {
  const row = lines.findIndex(line => timeField.test(line))
  if (row < 0) return null
  const stamp = fullStamp.exec(timeField.exec(lines[row])[1] || lines[row + 1] || '')
  if (!stamp) return null
  const local = dateTime(stamp[1])
  if (!local || !stamp[2]) return local
  const absolute = new Date(local + stamp[2].toUpperCase())
  return Number.isNaN(absolute.getTime()) ? null : tokyoNow(absolute)
}

// Default subcategory ids paired with merchant keywords; the first match wins.
const keywordCategories = [
  ['food-1', /咖啡|coffee|caf[eé]|カフェ|珈琲|コーヒー|スターバックス|starbucks|ドトール|タリーズ|瑞幸|luckin|奶茶|喜茶|蜜雪/iu],
  ['food-2', /コンビニ|セブン-?イレブン|7-?eleven|ローソン|lawson|ファミリーマート|ファミマ|familymart|全家|罗森|便利店|超市|スーパー|イオン|\baeon\b|西友|まいばすけっと|盒马|永辉/iu],
  ['food-0', /餐厅|饭店|食堂|レストラン|ラーメン|寿司|居酒屋|焼肉|牛丼|吉野家|すき家|松屋|マクドナルド|mcdonald|麦当劳|肯德基|\bkfc\b|美团外卖|饿了么|uber ?eats|restaurant/iu],
  ['travel-1', /タクシー|\btaxi\b|出租车|滴滴|\bdidi\b|\buber\b(?! ?eats)/iu],
  ['travel-2', /航空|机票|airlines?|ジェットスター/iu],
  ['travel-0', /suica|pasmo|icoca|\bjr\b|地下鉄|メトロ|\bmetro\b|地铁|公交|巴士|バス|鉄道|railway|新幹線|12306/iu],
  ['shopping-0', /ユニクロ|uniqlo|\bzara\b|しまむら|优衣库/iu],
  ['shopping-1', /ダイソー|daiso|ドラッグ|マツモトキヨシ|ウエルシア|スギ薬局|ツルハ|無印|无印|\bmuji\b|ニトリ|ロフト|药妆/iu],
  ['shopping-2', /ビックカメラ|ヨドバシ|bic ?camera|yodobashi|京东|数码/iu],
  ['home-1', /電気料金|电费|ガス料金|燃气|水道|水费|宽带/iu],
  ['health-0', /病院|クリニック|医院|诊所|薬局|药店|药房|pharmacy|clinic|hospital/iu],
  ['fun-0', /映画|电影|cinema|netflix|spotify|steam|nintendo|カラオケ|\bktv\b/iu]
]
const sameNote = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')

// Prefer the category last used for the same merchant, then a keyword match on the merchant or the whole screen.
export function suggestCategory(draft, text, entries, categories) {
  const usable = id => categories.some(item => item.id === id && item.direction === draft.direction)
  const note = sameNote(draft.note)
  if (note) {
    const previous = entries.filter(entry => entry.direction === draft.direction && entry.categoryId && sameNote(entry.note) === note)
      .reduce((latest, entry) => !latest || entry.at > latest.at ? entry : latest, null)
    if (previous && usable(previous.categoryId)) return previous.categoryId
  }
  if (draft.direction !== 'expense') return null
  for (const source of [draft.note, String(text ?? '').slice(0, screenTextLimit).normalize('NFKC')]) {
    if (!source) continue
    const match = keywordCategories.find(([id, pattern]) => pattern.test(source) && usable(id))
    if (match) return match[0]
  }
  return null
}

const stamp = at => Date.parse(at + 'Z')

// A matching amount near the screen's time, or saved in the last half hour, is probably the same payment.
export function likelyDuplicate(draft, entries, now = Date.now()) {
  if (!draft.currency || !draft.amount) return null
  const minor = amountMinor(draft.amount, draft.currency)
  if (!minor) return null
  return entries.find(entry => entry.currency === draft.currency && entry.minor === minor && entry.direction === draft.direction &&
    (draft.at ? Math.abs(stamp(entry.at) - stamp(draft.at)) <= 10 * 60000 : now - Date.parse(entry.createdAt) <= 30 * 60000)) ?? null
}

export function parseScreenText(input) {
  const lines = String(input ?? '').slice(0, screenTextLimit).normalize('NFKC')
    .replace(/[−–﹣]/g, '-').split(/\r?\n|\r/u).map(line => line.trim()).filter(Boolean)
  const text = lines.join('\n')
  const hint = currencyHint(text)
  const pending = lines.some(line => unfinished.test(line))
  const candidates = pending ? [] : findCandidates(lines, hint)
  const best = candidates.reduce((score, item) => Math.max(score, item.score), 0)
  const top = candidates.filter(item => item.score === best)
  const distinctAmounts = new Set(top.map(item => Number(item.amount)))
  const distinctCurrencies = new Set(top.map(item => item.currency).filter(Boolean))
  const conflicting = distinctAmounts.size > 1 || distinctCurrencies.size > 1
  const chosen = conflicting ? null : top.find(item => item.currency) ?? top[0]
  const direction = chosen
    ? (received.test(chosen.context) || (chosen.sign !== '-' && (received.test(text) || chosen.sign === '+')) ? 'income' : 'expense')
    : received.test(text) ? 'income' : 'expense'
  return {
    amount: chosen?.amount ?? '',
    currency: chosen?.currency ?? (chosen ? null : hint),
    direction,
    note: merchantName(lines, chosen),
    at: screenTimestamp(lines),
    status: pending ? 'unfinished' : conflicting ? 'multiple' : !chosen ? 'missing' : chosen.currency ? 'ready' : 'unknownCurrency'
  }
}
