import { amountMinor, currencies, currencyCode, dateTime, tokyoNow } from './core.mjs'

const daySeconds = 86400
const textLimit = 24000
const addressPattern = /^[a-z0-9_+.%'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i
export const mailAddress = value => {
  const address = String(value ?? '').trim().toLowerCase()
  return address.length <= 254 && addressPattern.test(address) ? address : ''
}
export const emptyMail = () => ({ binding: null, senders: [], drafts: [], handled: [] })
const clean = value => String(value ?? '').slice(0, textLimit).normalize('NFKC')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
const compact = value => clean(value).replace(/\s+/g, ' ').trim()

const excluded = /退款|退回成功|撤销|撤銷|交易失败|交易失敗|扣款失败|扣款失敗|支付失败|支付失敗|付款失败|付款失敗|待付款|待支付|未支付|未付款|授权码|授權碼|验证码|驗證碼|返金|払い戻し|取消|キャンセル|認証コード|ワンタイム|決済失敗|ご利用いただけません|支払(?:い)?待ち|未払い|\b(?:refund(?:ed)?|reversal|voided|payment (?:due|received|required|failed|pending|declined|cancelled|canceled)|declined|verification code|security code|one[- ]time (?:code|passcode|password)|otp)\b/iu
const rejectedLine = /^(?:[您你]的)?(?:退款(?:成功|通知|已完成|[金额]{2})|退回成功|已退款|返金(?:額|完了|のお知らせ)|決済失敗|未払い|(?:(?:扣款|交易|付款|支付)(?:失败|失敗))|未支付|未付款|待付款|待支付|验证码\s*[:：]|驗證碼\s*[:：]|認証コード\s*[:：]|(?:refund (?:confirmation|processed|successful|amount)|refunded\b|payment (?:failed|pending|declined|was declined|was refunded)|your (?:verification code|one[- ]time code)|verification code\s*:))/iu
const receipt = /扣款通知|扣款成功|已扣款|消费提醒|消費提醒|消费通知|消費通知|信用卡交易通知|支付成功|支付完成|付款成功|付款完成|已付款|已支付|(?:微信支付|支付宝付款|支付寶付款)[凭憑][证證]|ご利用(?:のお知らせ|通知|速報)|カード利用のお知らせ|(?:カード|決済)利用通知|決済(?:が)?完了|支払(?:い)?(?:が)?完了|\b(?:purchase (?:alert|notification|confirmation|receipt)|card (?:payment|transaction|purchase) alert|debit (?:alert|notification)|payment (?:successful|succeeded|confirmed|confirmation|complete[d]?|receipt)|your receipt|receipt from|successfully (?:paid|charged)|(?:you|your card) (?:have been|was|has been) charged|we charged|a charge of|payment to .{1,80} was successful)\b/iu
const statusField = /^(?:交易状态|交易狀態|付款状态|支付状态|支付狀態|決済状況|取引状況|(?:payment |transaction )?status)\s*:\s*(.*)$/iu
const chargedAmount = /^(?:本次)?(?:实际(?:支付|付款)(?:金额)?|實際(?:支付|付款)(?:金額)?|实付(?:金额)?|實付(?:金額)?|扣款(?:金额|金額)|(?:お)?支払(?:い)?(?:金額|額)|(?:ご)?利用金額|決済金額|amount (?:paid|charged|debited)|total paid|paid amount|charged amount|payment amount|debit amount|total charged)\s*(?::\s*|\s+|(?=$))/iu
const generalAmount = /^(?:交易金额|交易金額|消费金额|消費金額|支付金额|支付金額|付款金额|付款金額|金额|金額|合计|合計|总计|總計|transaction amount|purchase amount|grand total|total|amount)\s*(?::\s*|\s+|(?=$))/iu
const currencyField = /^(?:交易币种|交易幣別|币种|幣種|幣別|通貨|currency)\s*:\s*(.*)$/iu
const mark = 'JPY|CNY|RMB|USD|JP¥|CN¥|US\\$|日本円|日[元圆圓]|人民币|人民幣|美元|円|元|[¥$]'
const amountValue = new RegExp(`^[-−]?\\s*(${mark})?\\s*((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)(?:\\s*(${mark}))?\\s*[-。.!！]?$`, 'iu')
const inlineAmount = new RegExp(`(?:\\b(?:a charge of|(?:was|been|successfully) charged|we charged|you paid)\\s+|(?:消费|消費|扣款|实付|實付)\\s*)((?:${mark})\\s*\\d[\\d,.]*|\\d[\\d,.]*\\s*(?:${mark}))(?![\\w.,])`, 'iu')
const merchantField = /^(?:商家名称|商家名稱|商户名称|商戶名稱|商家|商户|商戶|收款方|付款给|付款給|加盟店名?|店舗名|お支払先|(?:ご)?利用(?:先|店名)|merchant(?: name)?|store(?: name)?|paid to|payee|billed by)\s*(?::\s*|\s+|(?=$))/iu
const timeField = /^(?:交易时间|交易時間|交易日期|消费时间|消費時間|扣款时间|扣款時間|付款时间|付款時間|支付时间|支付時間|取引日時?|(?:ご)?利用日時?|支払日時|決済日時|(?:transaction|payment|purchase) (?:date(?: and time)?|time)|paid at|charged at)\s*(?::\s*|\s+|(?=$))/iu
const numericDate = /^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)[ T]*(\d{1,2}:\d{2}(?::\d{2})?)\s*(AM|PM)?\s*(.*)$/i
const englishDate = /^(?:[A-Za-z]{3,9},\s*)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:,|\s+at)?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(AM|PM)?\s*(.*)$/i
const shortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const zoneOffsets = { Z: 'Z', JST: '+09:00', UTC: 'Z', GMT: 'Z', PST: '-08:00', PDT: '-07:00', EST: '-05:00', EDT: '-04:00' }

function transactionTime(value) {
  let [, date, time, meridiem, zone] = numericDate.exec(value) ?? []
  if (!date) {
    const m = englishDate.exec(value)
    if (!m) return null
    const month = shortMonths.indexOf(m[1].slice(0, 3).toLowerCase()) + 1
    if (!month) return null
    date = `${m[3]}-${month}-${m[2]}`
    time = m[4]
    meridiem = m[5]
    zone = m[6]
  }
  if (meridiem) {
    const [hour, ...rest] = time.split(':')
    if (Number(hour) < 1 || Number(hour) > 12) return null
    time = [Number(hour) % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0), ...rest].join(':')
  }
  const local = dateTime(`${date} ${time}`)
  if (!local || !zone) return local
  const offset = zoneOffsets[zone.toUpperCase()] ?? /^(?:UTC|GMT)?\s*([+-]\d{2}):?(\d{2})$/i.exec(zone)?.slice(1).join(':')
  const dateWithZone = offset && new Date(local + offset)
  return dateWithZone && Number.isFinite(dateWithZone.getTime()) ? tokyoNow(dateWithZone) : null
}

const explicitCurrency = value => value === '¥' || value === '$' ? null : currencyCode(value === '日本円' ? '円' : value)
function readAmount(value, hint) {
  const match = amountValue.exec(value)
  if (!match) return null
  const [, before, raw, after] = match
  const codes = new Set([before, after, hint].map(explicitCurrency).filter(Boolean))
  const [code] = codes
  const marksMatch = [before, after].every(mark => mark !== '$' || code === 'USD') &&
    [before, after].every(mark => mark !== '¥' || code === 'JPY' || code === 'CNY')
  const currency = codes.size === 1 && marksMatch ? code : null
  const amount = raw.replaceAll(',', '')
  if (amountMinor(amount, currency ?? 'CNY') > 0) return { amount, currency }
  return currency && amountMinor(amount, 'CNY') > 0 ? { amount, currency: null } : null
}

function fieldValues(lines, pattern) {
  return lines.flatMap((line, index) => {
    const match = pattern.exec(line)
    return match ? [line.slice(match[0].length).trim() || lines[index + 1] || ''] : []
  })
}

export function parsePaymentMail(subject, body, received) {
  const title = compact(subject)
  const lines = clean(body).split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean)
  if (excluded.test(title) || lines.some(line => {
    const status = statusField.exec(line)?.[1] ?? ''
    return rejectedLine.test(line) || excluded.test(status) || /^(?:failed|pending|cancelled|canceled)\b/i.test(status)
  })) return null
  if (!receipt.test(title) && !lines.some(line => receipt.test(line))) return null
  const receiptDate = new Date(received)
  if (!Number.isFinite(receiptDate.getTime())) return null
  const receivedAt = tokyoNow(receiptDate)
  const times = new Set(fieldValues(lines, timeField).map(transactionTime).filter(Boolean))
  const time = times.size === 1 ? [...times][0] : null
  const hints = new Set(fieldValues(lines, currencyField).map(explicitCurrency).filter(Boolean))
  const hint = hints.size === 1 ? [...hints][0] : null
  const charged = fieldValues(lines, chargedAmount)
  const general = fieldValues(lines, generalAmount)
  const inline = [title, ...lines].map(line => inlineAmount.exec(line)?.[1]).filter(Boolean)
  const amounts = charged.length ? charged : general.length ? general : inline
  const candidates = amounts.map(value => readAmount(value, hint)).filter(Boolean)
  const comparable = new Set(candidates.map(item => Number(item.amount)))
  const codes = new Set(candidates.map(item => item.currency).filter(Boolean))
  const chosen = candidates.find(item => item.currency) ?? candidates[0]
  const conflicted = comparable.size > 1 || codes.size > 1 || (candidates.length > 0 && candidates.length !== amounts.length)
  const amount = conflicted ? '' : chosen?.amount ?? ''
  const currency = conflicted ? null : chosen?.currency ?? null
  const note = fieldValues(lines, merchantField).map(compact).find(value => value && value.length <= 120 && /\p{L}/u.test(value) &&
    !/https?:|\d{7}|:/.test(value) && !excluded.test(value)) ?? ''
  return { at: time ?? receivedAt, receivedAt, usedReceivedTime: !time, note, amount, currency,
    status: conflicted ? 'multiple' : !amount ? 'missing' : !currency ? 'unknownCurrency' : 'ready' }
}

const header = (part, name) => part?.headers?.find(item => item.name.toLowerCase() === name)?.value ?? ''
function messageText(payload, htmlText) {
  const bodies = { 'text/plain': [], 'text/html': [] }
  let remaining = textLimit
  function visit(part, depth) {
    if (depth > 16 || !remaining || !part || part.filename || /^attachment\b/i.test(header(part, 'content-disposition'))) return
    if (/^multipart\//i.test(part.mimeType)) {
      for (const child of part.parts ?? []) visit(child, depth + 1)
      return
    }
    const type = part.mimeType?.toLowerCase()
    if (!Object.hasOwn(bodies, type) || !part.body?.data) return
    const data = part.body.data.slice(0, 160000).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
    const bytes = Uint8Array.from(atob(data.slice(0, data.length % 4 === 1 ? -1 : data.length)), char => char.charCodeAt(0))
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(header(part, 'content-type'))?.[1]
    let decoder
    try { decoder = new TextDecoder(charset || 'utf-8') } catch { decoder = new TextDecoder() }
    const decoded = decoder.decode(bytes)
    const text = (type === 'text/html' ? htmlText(decoded) : decoded).trim().slice(0, textLimit)
    bodies[type].push(text)
    if (type === 'text/plain') remaining = Math.max(0, remaining - text.length)
  }
  visit(payload, 0)
  return (bodies['text/plain'].filter(Boolean).length ? bodies['text/plain'] : bodies['text/html']).join('\n').slice(0, textLimit)
}

export function decodeMailHtml(html) {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('script,style,template,iframe,svg,object,noscript,head,[hidden]').forEach(node => node.remove())
  template.content.querySelectorAll('br,p,div,td,th,tr,li,h1,h2,h3,section,article').forEach(node => node.after('\n'))
  return template.content.textContent
}

export async function mailKey(email, id) {
  const data = new TextEncoder().encode(`${email}\n${id}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return 'gmail:' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Use a fixed upper bound for every page. The overlap absorbs messages arriving around the checkpoint.
export async function scanPaymentMail(request, mailbox, alreadySaved, now = Date.now(), htmlText = decodeMailHtml) {
  const until = Math.floor(now / 1000)
  const known = new Set([...alreadySaved, ...mailbox.handled, ...mailbox.drafts.map(item => item.sourceKey)])
  const scanned = []
  for (const sender of mailbox.senders) {
    if (sender.cursor >= until) continue
    const from = sender.cursor == null ? until - 7 * daySeconds : sender.cursor - 300
    const query = { q: `from:${sender.address} -in:sent -in:drafts after:${from - 1} before:${until}`, maxResults: '100' }
    const drafts = []
    const pages = new Set()
    do {
      const page = await request('messages', query)
      if (!page || (page.messages !== undefined && !Array.isArray(page.messages))) throw new Error('invalid-mail-page')
      for (const { id } of page.messages ?? []) {
        if (!/^[A-Za-z0-9_-]+$/.test(id ?? '')) throw new Error('invalid-mail-id')
        const key = await mailKey(mailbox.binding.email, id)
        if (known.has(key)) continue
        const message = await request(`messages/${id}`, { format: 'full', fields: 'id,internalDate,payload' })
        if (!message) continue // It was deleted since the list call.
        const received = Number(message.internalDate)
        if (!Number.isFinite(received) || !message.payload) throw new Error('invalid-mail-message')
        const rawSender = header(message.payload, 'from').trim()
        const address = mailAddress(/<([^<>]+)>$/.exec(rawSender)?.[1] ?? rawSender)
        if (address !== sender.address || received < from * 1000 || received >= until * 1000) continue
        const draft = parsePaymentMail(header(message.payload, 'subject'), messageText(message.payload, htmlText), received)
        if (!draft) continue
        drafts.push({ ...draft, sourceKey: key, sender: address })
        known.add(key)
      }
      query.pageToken = page.nextPageToken || ''
      if (query.pageToken && pages.has(query.pageToken)) throw new Error('repeated-mail-page')
      pages.add(query.pageToken)
    } while (query.pageToken)
    scanned.push({ id: sender.id, cursor: until, drafts })
  }
  return scanned
}

export function mergeMailScan(state, bindingId, scanned, savedKeys) {
  if (state.binding?.id !== bindingId) return state
  const known = new Set([...savedKeys, ...state.handled, ...state.drafts.map(item => item.sourceKey)])
  const updates = new Map(scanned.map(item => [item.id, item]))
  const drafts = [...state.drafts]
  const senders = state.senders.map(sender => {
    const update = updates.get(sender.id)
    if (!update || sender.cursor >= update.cursor) return sender
    for (const draft of update.drafts) {
      if (known.has(draft.sourceKey)) continue
      known.add(draft.sourceKey)
      drafts.push(draft)
    }
    return { ...sender, cursor: update.cursor }
  })
  return { ...state, senders, drafts }
}

export const mailDraftMinor = draft => Object.hasOwn(currencies, draft.currency) ? amountMinor(draft.amount, draft.currency) : null

export function duplicateMailKeys(drafts, entries) {
  const suspects = new Set()
  const groups = new Map()
  for (const item of [...drafts, ...entries]) {
    const isDraft = item.status !== undefined
    const minor = isDraft ? mailDraftMinor(item) : item.direction === 'expense' ? item.minor : null
    if (!minor) continue
    const key = `${item.currency}:${minor}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ at: Date.parse(item.at + 'Z'), key: item.sourceKey, isDraft })
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at)
    for (const [index, item] of group.entries()) {
      if (!item.isDraft) continue
      const other = [group[index - 1], group[index + 1]].find(candidate => candidate &&
        candidate.key !== item.key && Math.abs(candidate.at - item.at) <= 600000)
      if (other) suspects.add(item.key)
    }
  }
  return suspects
}
