import { currencies, dateTime, defaults, directions, withQuotes } from './core.mjs'

const database = new Promise((resolve, reject) => {
  const open = indexedDB.open('hiba-ledger', 1)
  open.onupgradeneeded = () => {
    const db = open.result
    const entries = db.createObjectStore('entries', { keyPath: 'id' })
    entries.createIndex('sourceKey', 'sourceKey', { unique: true })
    const categories = db.createObjectStore('categories', { keyPath: 'id' })
    defaults.forEach(item => categories.add(item))
    db.createObjectStore('settings')
    db.createObjectStore('rates', { keyPath: 'key' })
  }
  open.onsuccess = () => {
    const db = open.result
    db.onversionchange = () => db.close()
    resolve(db)
  }
  open.onerror = () => reject(open.error)
})

async function transact(names, mode, run) {
  const db = await database
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode)
    const store = name => tx.objectStore(name)
    let result
    tx.oncomplete = () => resolve(result)
    tx.onabort = () => reject(tx.error ?? new Error('账本写入被中断。'))
    try { run(store, value => { result = value }) }
    catch (error) { tx.abort(); reject(error) }
  })
}

export function readLedger() {
  return transact(['entries', 'categories', 'settings'], 'readonly', (store, done) => {
    const entries = store('entries').getAll()
    const categories = store('categories').getAll()
    const currency = store('settings').get('currency')
    currency.onsuccess = () => done({
      entries: entries.result.sort((a, b) => b.at.localeCompare(a.at) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
      categories: categories.result,
      currency: currency.result ?? 'JPY'
    })
  })
}

export const saveEntry = entry => transact(['entries'], 'readwrite', store => store('entries').put(entry))
export const saveEntries = list => transact(['entries'], 'readwrite', store => {
  const entries = store('entries')
  for (const entry of list) entries.put(entry)
})
export const deleteEntry = id => transact(['entries'], 'readwrite', store => store('entries').delete(id))
// One transaction, so a failure leaves every selected entry in place.
export const deleteEntries = ids => transact(['entries'], 'readwrite', store => {
  const entries = store('entries')
  for (const id of ids) entries.delete(id)
})
export const saveCurrency = currency => transact(['settings'], 'readwrite', store => store('settings').put(currency, 'currency'))

export function saveCategory(category) {
  return transact(['categories'], 'readwrite', (store, done) => {
    const target = store('categories')
    const request = target.getAll()
    request.onsuccess = () => {
      const exists = request.result.some(item => item.parentId === category.parentId &&
        item.direction === category.direction && item.name === category.name)
      if (!exists) target.add(category)
      done(!exists)
    }
  })
}

export function addEntries(entries) {
  return transact(['entries'], 'readwrite', (store, done) => {
    const target = store('entries')
    const existing = target.getAll()
    existing.onsuccess = () => {
      // The read and inserts share one write transaction across all open tabs.
      const seen = new Set(existing.result.map(entry => entry.sourceKey).filter(Boolean))
      let added = 0
      for (const entry of entries) {
        if (entry.sourceKey && seen.has(entry.sourceKey)) continue
        target.add(entry)
        if (entry.sourceKey) seen.add(entry.sourceKey)
        added++
      }
      done(added)
    }
  })
}

export const readRates = () => transact(['rates'], 'readonly', (store, done) => {
  const request = store('rates').getAll()
  request.onsuccess = () => done(request.result)
})

export const saveRates = records => transact(['rates'], 'readwrite', store => {
  const target = store('rates')
  records.forEach(record => target.put(record))
})

export function completeRates(ids, quotesFor) {
  return transact(['entries'], 'readwrite', (store, done) => {
    const target = store('entries')
    let updated = 0
    for (const id of ids) {
      const request = target.get(id)
      request.onsuccess = () => {
        const entry = request.result
        if (!entry || (entry.yen != null && entry.yuan != null)) return
        const filled = withQuotes(entry, quotesFor(entry.at.slice(0, 10)))
        if (filled.yen !== entry.yen || filled.yuan !== entry.yuan) {
          target.put(filled)
          done(++updated)
        }
      }
    }
  })
}

export function backupDocument({ entries, categories, currency }) {
  return { format: 'hiba-ledger', version: 1, exportedAt: new Date().toISOString(), currency, categories, entries }
}

const shortText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const minorOrNull = value => value === null || (Number.isSafeInteger(value) && value >= 0)
const quoteCodes = ['CNY', 'USD']
const safeId = value => shortText(value, 120) && /^[a-zA-Z0-9_-]+$/.test(value)
const safeIcons = new Set([...defaults.map(item => item.icon), 'tag'])

export function validateBackup(input) {
  const fail = () => { throw new Error('无法恢复。请选择由小日账导出的有效备份文件。') }
  if (input?.format !== 'hiba-ledger' || input.version !== 1 || !['JPY', 'CNY'].includes(input.currency) ||
      !Array.isArray(input.entries) || !Array.isArray(input.categories)) fail()
  const categoryMap = new Map()
  const names = new Set()
  const categories = input.categories.map(item => {
    const { id, parentId, direction, icon, name } = item ?? {}
    const key = JSON.stringify([direction, parentId, name])
    if (!safeId(id) || !(parentId === null || safeId(parentId)) || !['income', 'expense'].includes(direction) ||
        !safeIcons.has(icon) || !shortText(name, 24) || categoryMap.has(id) || names.has(key)) fail()
    const category = { id, parentId, direction, icon, name }
    categoryMap.set(id, category)
    names.add(key)
    return category
  })
  for (const item of categories) {
    if (item.parentId !== null) {
      const parent = categoryMap.get(item.parentId)
      if (!parent || parent.parentId !== null || parent.direction !== item.direction) fail()
    }
  }
  const ids = new Set()
  const sources = new Set()
  const entries = input.entries.map(item => {
    const { id, createdAt, at, direction, currency, minor, yen, yuan, categoryId, note, settlementYen, sourceRate, sourceKey, fx } = item ?? {}
    if (!safeId(id) || ids.has(id) || typeof createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt) ||
        typeof at !== 'string' || dateTime(at) !== at || !Object.hasOwn(directions, direction) || !Object.hasOwn(currencies, currency) ||
        !Number.isSafeInteger(minor) || minor <= 0 || minor > 1e12 || !minorOrNull(yen) || !minorOrNull(yuan) || !minorOrNull(settlementYen) ||
        !(sourceRate === null || Number.isFinite(sourceRate) && sourceRate > 0) ||
        !(sourceKey === null || shortText(sourceKey, 1024) && !sources.has(sourceKey)) ||
        !(categoryId === null || categoryMap.get(categoryId)?.direction === direction) ||
        typeof note !== 'string' || note.length > 500 || !fx || typeof fx !== 'object' || Array.isArray(fx)) fail()
    const approvedQuotes = {}
    for (const [code, quote] of Object.entries(fx)) {
      if (!quoteCodes.includes(code) || !Number.isFinite(quote?.rate) || quote.rate <= 0 || quote.rate > 100000 ||
          typeof quote.date !== 'string' || dateTime(quote.date)?.slice(0, 10) !== quote.date) fail()
      approvedQuotes[code] = { rate: quote.rate, date: quote.date }
    }
    ids.add(id)
    if (sourceKey) sources.add(sourceKey)
    return { id, createdAt, at, direction, currency, minor, yen, yuan, categoryId, note, settlementYen, sourceRate, sourceKey, fx: approvedQuotes }
  })
  return { entries, categories, currency: input.currency }
}

export function restoreLedger(backup) {
  return transact(['entries', 'categories', 'settings'], 'readwrite', store => {
    const entries = store('entries')
    const categories = store('categories')
    entries.clear()
    categories.clear()
    backup.entries.forEach(item => entries.add(item))
    backup.categories.forEach(item => categories.add(item))
    store('settings').put(backup.currency, 'currency')
  })
}
