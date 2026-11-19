import { currencies, dateTime, monthBounds, offsetDate } from './core.mjs'

export const emptyFeatures = () => ({ merchants: [], budgets: [], bills: [] })
export const billCycles = ['weekly', 'monthly', 'yearly']
export const merchantKey = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function findMerchantRule(rules, note, categories, direction) {
  const keys = [merchantKey(note), merchantKey(note?.split(/\s+[-–—]\s+/u)[0])].filter(Boolean)
  for (const key of new Set(keys)) {
    const matches = rules.filter(rule => [rule.name, ...rule.aliases].some(alias => merchantKey(alias) === key))
    const rule = matches.find(item => categories.find(category => category.id === item.categoryId)?.direction === direction)
      ?? matches.find(item => !item.categoryId) ?? matches[0]
    if (rule) {
      const category = categories.find(item => item.id === rule.categoryId)
      return { rule, note: rule.name || note, categoryId: category?.direction === direction ? category.id : null }
    }
  }
  return { note, categoryId: null }
}

const isDay = value => typeof value === 'string' && dateTime(value)?.slice(0, 10) === value
const validAmount = minor => Number.isSafeInteger(minor) && minor > 0 && minor <= 1e12
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)
const text = (value, length) => typeof value === 'string' && value.length <= length

export function validFeature(list, item, categories) {
  if (!item || !validId(item.id)) return null
  const { id, categoryId, name, minor, currency } = item
  const direction = categories.get(categoryId)
  if (list === 'merchants') {
    if (!text(name, 120) || !Array.isArray(item.aliases) || !item.aliases.length || item.aliases.length > 24 ||
        item.aliases.some(alias => !text(alias, 500) || !merchantKey(alias)) || (categoryId !== null && !direction)) return null
    return { id, categoryId, name: name.trim(), aliases: item.aliases.map(alias => alias.trim()) }
  }
  if (!validAmount(minor)) return null
  if (list === 'budgets') {
    return direction === 'expense' && ['JPY', 'CNY'].includes(currency) ? { id, categoryId, minor, currency } : null
  }
  if (list === 'bills') {
    const { start, next, cycle } = item
    if (!text(name, 120) || !name.trim() || !Object.hasOwn(currencies, currency) || !isDay(start) ||
        (next !== null && (!isDay(next) || next < start)) || !billCycles.includes(cycle) ||
        (categoryId !== null && direction !== 'expense')) return null
    return { id, name: name.trim(), categoryId, currency, minor, start, next, cycle }
  }
  return null
}

export function readFeatures(value, categories) {
  const result = emptyFeatures()
  if (!value) return result
  for (const list of Object.keys(result)) {
    if (!Array.isArray(value[list])) continue
    const items = new Map()
    for (const item of value[list]) {
      const valid = validFeature(list, item, categories)
      if (valid) items.set(valid.id, valid)
    }
    result[list] = [...items.values()]
  }
  return result
}

export function nextBillDate(bill, due) {
  if (bill.cycle === 'weekly') {
    const next = offsetDate(due, 7)
    return isDay(next) ? next : null
  }
  const month = bill.cycle === 'monthly'
    ? offsetDate(monthBounds(due.slice(0, 7)).end, 1).slice(0, 7)
    : String(Number(due.slice(0, 4)) + 1) + bill.start.slice(4, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const last = monthBounds(month).end
  return month + '-' + (bill.start.slice(8) < last.slice(8) ? bill.start.slice(8) : last.slice(8))
}

export const billKey = (id, due) => 'recurring:' + id + ':' + due

export function firstUnpostedDate(bill, keys) {
  let date = bill.next
  while (date && keys.has(billKey(bill.id, date))) date = nextBillDate(bill, date)
  return date
}

export function budgetUsage(entries, categories, budgets, month) {
  const inMonth = entries.filter(entry => entry.direction === 'expense' && entry.at.startsWith(month + '-'))
  const parents = new Map(categories.map(item => [item.id, item.parentId]))
  return budgets.map(budget => {
    const key = budget.currency === 'CNY' ? 'yuan' : 'yen'
    let spent = 0
    let pending = 0
    for (const entry of inMonth) {
      if (entry.categoryId !== budget.categoryId && parents.get(entry.categoryId) !== budget.categoryId) continue
      if (entry[key] == null) pending++
      else spent += entry[key]
    }
    return { ...budget, spent, pending, remaining: budget.minor - spent }
  })
}

const csvCell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"'
// Excel interprets formula-looking text even when the CSV cell is quoted.
const csvText = value => /^[\s\p{Cf}]*[=+\-@]/u.test(value.normalize('NFKC')) ? "'" + value : value
const decimal = (minor, currency) => minor == null ? '' : currency === 'JPY' ? String(minor) : (minor / 100).toFixed(2)

export function ledgerCsv(entries, headers, categoryLabel, directionLabel) {
  const rows = entries.map(entry => [
    entry.at.replace('T', ' '), directionLabel(entry.direction), entry.currency, decimal(entry.minor, entry.currency),
    csvText(categoryLabel(entry.categoryId)), csvText(entry.note), decimal(entry.yen, 'JPY'), decimal(entry.yuan, 'CNY')
  ])
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
