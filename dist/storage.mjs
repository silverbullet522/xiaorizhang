import { currencies, dateTime, defaults, directions, presetRenames, withQuotes, within } from './core.mjs'
import { iconNames } from './icons.mjs'

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
    addMissingDefaults(db).then(() => resolve(db))
  }
  open.onerror = () => reject(open.error)
})

const presetVersion = 2
const presetsById = new Map(defaults.map(item => [item.id, item]))

// Brings older ledgers up to the current presets. Version 2 (one time) renames presets that still carry their old
// name and gives preset categories their own icons; before it, icons could not be chosen, so these were never edited.
// Every open then adds missing presets, skipping any name already used at that level.
function addMissingDefaults(db) {
  return new Promise(resolve => {
    const tx = db.transaction(['categories', 'settings'], 'readwrite')
    syncPresets(tx.objectStore('categories'), tx.objectStore('settings'))
    // A failed top-up must never keep the ledger from opening.
    tx.oncomplete = tx.onabort = () => resolve()
  })
}

function syncPresets(store, settings) {
  const request = store.getAll()
  const version = settings.get('presets')
  const deleted = settings.get('deletedPresets')
  deleted.onsuccess = () => {
    // Requests in one transaction finish in order.
    const existing = request.result
    const from = version.result ?? 1
    const deletedPresets = new Set(deleted.result ?? [])
    const key = item => JSON.stringify([item.direction, item.parentId, item.name])
    if (from < presetVersion) {
      for (const item of existing) {
        const rename = presetRenames.find(change => change.id === item.id && change.from === item.name)
        if (rename && !existing.some(other => other !== item && key(other) === key({ ...item, name: rename.to }))) item.name = rename.to
        if (presetsById.has(item.id)) item.icon = presetsById.get(item.id).icon
        if (rename || presetsById.has(item.id)) store.put(item)
      }
      settings.put(presetVersion, 'presets')
    }
    const byId = new Map(existing.map(item => [item.id, item]))
    for (const item of existing) {
      if (item.presetId && !byId.has(item.presetId)) byId.set(item.presetId, item)
    }
    const byName = new Map(existing.map(item => [key(item), item]))
    const parentFor = new Map()
    for (const item of defaults) {
      if (deletedPresets.has(item.id)) continue
      const parent = parentFor.get(item.parentId)
      if (item.parentId !== null && !parent) continue
      const preset = { ...item, parentId: parent?.id ?? null }
      const match = byId.get(item.id) ?? byName.get(key(preset))
      if (!match) {
        store.add(preset)
        byName.set(key(preset), preset)
      } else if (!presetsById.has(match.id) && !match.presetId) {
        // Remember a same-name replacement so renaming it does not bring the preset back.
        match.presetId = item.id
        store.put(match)
      }
      const category = match ?? preset
      if (item.parentId === null && category.parentId === null && category.direction === item.direction &&
          (category.id === item.id || category.presetId === item.id)) parentFor.set(item.id, category)
    }
  }
}

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
    const deletedPresets = store('settings').get('deletedPresets')
    deletedPresets.onsuccess = () => done({
      entries: entries.result.sort((a, b) => b.at.localeCompare(a.at) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
      categories: categories.result,
      currency: currency.result ?? 'JPY',
      deletedPresets: deletedPresets.result ?? []
    })
  })
}

const categoryDirections = list => new Map(list.map(item => [item.id, item.direction]))
const withExistingCategory = (entry, categories) => entry.categoryId && categories.get(entry.categoryId) !== entry.direction
  ? { ...entry, categoryId: null }
  : entry

export const saveEntry = entry => saveEntries([entry])
export const saveEntries = list => transact(['entries', 'categories'], 'readwrite', store => {
  const entries = store('entries')
  const request = store('categories').getAll()
  request.onsuccess = () => {
    const categories = categoryDirections(request.result)
    for (const entry of list) entries.put(withExistingCategory(entry, categories))
  }
})
export const deleteEntry = id => transact(['entries'], 'readwrite', store => store('entries').delete(id))
// One transaction, so a failure leaves every selected entry in place.
export const deleteEntries = ids => transact(['entries'], 'readwrite', store => {
  const entries = store('entries')
  for (const id of ids) entries.delete(id)
})

// Recheck the confirmed rows against the date range in case another tab edited a date.
export function deleteEntriesInRange(range, ids) {
  const confirmed = new Set(ids)
  return transact(['entries'], 'readwrite', (store, done) => {
    const entries = store('entries')
    const request = entries.getAll()
    request.onsuccess = () => {
      let removed = 0
      for (const entry of request.result) {
        if (!confirmed.has(entry.id) || !within(entry, range)) continue
        entries.delete(entry.id)
        removed++
      }
      done(removed)
    }
  })
}

export function clearLedger() {
  return transact(['entries', 'categories', 'settings', 'rates'], 'readwrite', store => {
    const categories = store('categories')
    const settings = store('settings')
    store('entries').clear()
    categories.clear()
    settings.clear()
    store('rates').clear()
    syncPresets(categories, settings)
  })
}

export const saveCurrency = currency => transact(['settings'], 'readwrite', store => store('settings').put(currency, 'currency'))

export function saveCategory(category, { editing = false } = {}) {
  return transact(['categories'], 'readwrite', (store, done) => {
    const target = store('categories')
    const request = target.getAll()
    request.onsuccess = () => {
      const categories = request.result
      const current = editing ? categories.find(item => item.id === category.id) : undefined
      if (editing && !current) { done('missing'); return }
      const next = current ? { ...current, name: category.name, icon: category.icon } : category
      if (next.parentId !== null && !categories.some(item => item.id === next.parentId && item.parentId === null && item.direction === next.direction)) {
        done('missing')
        return
      }
      const exists = categories.some(item => item.id !== current?.id && item.parentId === next.parentId &&
        item.direction === next.direction && item.name === next.name)
      if (exists) { done('duplicate'); return }
      if (current) target.put(next)
      else target.add(next)
      done('saved')
    }
  })
}

export function deleteCategory(id) {
  return transact(['categories', 'entries', 'settings'], 'readwrite', (store, done) => {
    const categories = store('categories')
    const entries = store('entries')
    const settings = store('settings')
    const categoryList = categories.getAll()
    const deleted = settings.get('deletedPresets')
    deleted.onsuccess = () => {
      if (!categoryList.result.some(item => item.id === id)) { done(null); return }
      const removed = categoryList.result.filter(item => item.id === id || item.parentId === id)
      const removedIds = new Set(removed.map(item => item.id))
      const deletedPresets = new Set(deleted.result ?? [])
      for (const item of removed) {
        const presetId = item.presetId ?? item.id
        if (presetsById.has(presetId)) deletedPresets.add(presetId)
        categories.delete(item.id)
      }
      settings.put([...deletedPresets], 'deletedPresets')
      const affected = entries.getAll()
      affected.onsuccess = () => {
        let uncategorized = 0
        for (const entry of affected.result) {
          if (!removedIds.has(entry.categoryId)) continue
          entries.put({ ...entry, categoryId: null })
          uncategorized++
        }
        done({ removedIds: [...removedIds], uncategorized })
      }
    }
  })
}

export function addEntries(entries) {
  return transact(['entries', 'categories'], 'readwrite', (store, done) => {
    const target = store('entries')
    const existing = target.getAll()
    const request = store('categories').getAll()
    request.onsuccess = () => {
      // The read and inserts share one write transaction across all open tabs.
      const seen = new Set(existing.result.map(entry => entry.sourceKey).filter(Boolean))
      const categories = categoryDirections(request.result)
      let added = 0
      for (const entry of entries) {
        if (entry.sourceKey && seen.has(entry.sourceKey)) continue
        target.add(withExistingCategory(entry, categories))
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

export function backupDocument({ entries, categories, currency, deletedPresets }) {
  return { format: 'hiba-ledger', version: 1, exportedAt: new Date().toISOString(), currency, categories, entries,
    ...(deletedPresets?.length ? { deletedPresets } : {}) }
}

const shortText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const minorOrNull = value => value === null || (Number.isSafeInteger(value) && value >= 0)
const quoteCodes = ['CNY', 'USD']
const safeId = value => shortText(value, 120) && /^[a-zA-Z0-9_-]+$/.test(value)
const safeIcons = iconNames

export function validateBackup(input) {
  const fail = () => { throw new Error('无法恢复。请选择由小日账导出的有效备份文件。') }
  if (input?.format !== 'hiba-ledger' || input.version !== 1 || !['JPY', 'CNY'].includes(input.currency) ||
      !Array.isArray(input.entries) || !Array.isArray(input.categories)) fail()
  const deleted = input.deletedPresets === undefined ? [] : input.deletedPresets
  if (!Array.isArray(deleted) || deleted.some(id => !presetsById.has(id))) fail()
  const deletedPresets = new Set(deleted)
  const categoryMap = new Map()
  const names = new Set()
  const representedPresets = new Set()
  const categories = input.categories.map(item => {
    const { id, parentId, direction, icon, name, presetId } = item ?? {}
    const key = JSON.stringify([direction, parentId, name])
    if (!safeId(id) || !(parentId === null || safeId(parentId)) || !['income', 'expense'].includes(direction) ||
        !safeIcons.has(icon) || !shortText(name, 24) || categoryMap.has(id) || names.has(key) || deletedPresets.has(id) || deletedPresets.has(presetId)) fail()
    const category = { id, parentId, direction, icon, name }
    if (presetId !== undefined) {
      const preset = presetsById.get(presetId)
      if (!preset || preset.direction !== direction || representedPresets.has(presetId)) fail()
      category.presetId = presetId
      representedPresets.add(presetId)
    }
    categoryMap.set(id, category)
    names.add(key)
    return category
  })
  for (const item of categories) {
    const parent = categoryMap.get(item.parentId)
    if (item.parentId !== null) {
      if (!parent || parent.parentId !== null || parent.direction !== item.direction) fail()
    }
    if (item.presetId && (categoryMap.has(item.presetId) || presetsById.get(item.presetId).parentId !== (parent?.presetId ?? parent?.id ?? null))) fail()
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
  return { entries, categories, currency: input.currency, deletedPresets: [...deletedPresets] }
}

export function restoreLedger(backup) {
  return transact(['entries', 'categories', 'settings'], 'readwrite', store => {
    const entries = store('entries')
    const categories = store('categories')
    entries.clear()
    categories.clear()
    backup.entries.forEach(item => entries.add(item))
    backup.categories.forEach(item => categories.add(item))
    const settings = store('settings')
    settings.put(backup.currency, 'currency')
    settings.put(backup.deletedPresets ?? [], 'deletedPresets')
    syncPresets(categories, settings)
  })
}
