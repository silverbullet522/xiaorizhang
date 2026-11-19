import { offsetDate, tokyoNow } from './core.mjs'
import { readRates, saveRates } from './storage.mjs'

const codes = ['CNY', 'USD']
const endpoint = 'https://api.frankfurter.dev/v2/rates'
const cache = new Map()
const inflight = new Map()
const maxAge = 60 * 60 * 1000
const initialized = readRates().then(records => records.forEach(record => cache.set(record.key, record))).catch(() => {})

export function quotesFor(day) {
  const today = tokyoNow().slice(0, 10)
  if (day > today) return {}
  return Object.fromEntries(codes.flatMap(code => {
    const recent = cache.get(`latest:${code}`)
    const record = day === today && recent?.queriedOn === today ? recent : cache.get(`day:${day}:${code}`)
    return record && record.date <= day ? [[code, { rate: record.rate, date: record.date }]] : []
  }))
}

async function fetchQuotes(params) {
  const url = new URL(endpoint)
  url.search = new URLSearchParams({ base: 'JPY', quotes: codes.join(','), ...params })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { signal: controller.signal, referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error('汇率服务暂时不可用。')
    const records = await response.json()
    if (!Array.isArray(records)) throw new Error('汇率响应格式无效。')
    return records.filter(record => codes.includes(record.quote) && record.base === 'JPY' &&
      /^\d{4}-\d\d-\d\d$/.test(record.date) && Number.isFinite(record.rate) && record.rate > 0 && record.rate <= 100000)
  } finally { clearTimeout(timer) }
}

function shared(key, work) {
  if (!inflight.has(key)) inflight.set(key, work().finally(() => inflight.delete(key)))
  return inflight.get(key)
}

async function persist(records) {
  records.forEach(record => cache.set(record.key, record))
  try { await saveRates(records) } catch { /* Cached quotes remain usable for this session. */ }
}

async function latest(today) {
  const quotes = await fetchQuotes({})
  await persist(quotes.filter(quote => quote.date <= today).map(({ quote, rate, date }) => ({
    key: `latest:${quote}`, rate, date, queriedOn: today, fetchedAt: Date.now()
  })))
}

async function history(days) {
  const from = offsetDate(days[0], -14)
  const to = days.at(-1)
  const quotes = await fetchQuotes({ from, to })
  const grouped = Object.fromEntries(codes.map(code => [code, quotes.filter(q => q.quote === code).sort((a, b) => a.date.localeCompare(b.date))]))
  const records = days.flatMap(day => codes.flatMap(code => {
    const quote = grouped[code].findLast(record => record.date <= day)
    return quote ? [{ key: `day:${day}:${code}`, rate: quote.rate, date: quote.date }] : []
  }))
  await persist(records)
}

export async function loadQuotes(days) {
  await initialized
  if (!navigator.onLine) return
  const today = tokyoNow().slice(0, 10)
  const dates = [...new Set(days)].sort()
  const tasks = []
  if (dates.includes(today) && codes.some(code => {
    const record = cache.get(`latest:${code}`)
    return record?.queriedOn !== today || Date.now() - record.fetchedAt > maxAge
  })) tasks.push(shared('latest', () => latest(today)))
  const old = dates.filter(day => day < today && codes.some(code => !cache.has(`day:${day}:${code}`)))
  const groups = Map.groupBy ? Map.groupBy(old, day => day.slice(0, 4)) : old.reduce((map, day) => {
    const year = day.slice(0, 4)
    map.set(year, [...(map.get(year) ?? []), day])
    return map
  }, new Map())
  for (const batch of groups.values()) tasks.push(shared(batch.join(','), () => history(batch)))
  await Promise.allSettled(tasks)
}
