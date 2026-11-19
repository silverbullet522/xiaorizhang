import { createImportMatcher, currencies, dateTime, defaults, directions, planBackupRestore, presetRenames, restorePlanSignature, tokyoNow, withQuotes, within } from './core.mjs'
import { iconNames } from './icons.mjs'
import { billKey, findMerchantRule, firstUnpostedDate, merchantKey, nextBillDate, readFeatures, validFeature } from './features.mjs'
import { sameLedger } from './sync-ledger.mjs'

export const ledgerChanges = new EventTarget()
const ledgerStores = ['entries', 'categories', 'settings']

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

async function transact(names, mode, run, notify = true) {
  const db = await database
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode)
    const store = name => tx.objectStore(name)
    let result
    tx.oncomplete = () => {
      resolve(result)
      if (notify && mode === 'readwrite' && names.some(name => ledgerStores.includes(name))) {
        ledgerChanges.dispatchEvent(new Event('change'))
      }
    }
    tx.onabort = () => reject(tx.error ?? new Error('账本写入被中断。'))
    try { run(store, value => { result = value }) }
    catch (error) { tx.abort(); reject(error) }
  })
}

function ledgerRequests(store, done, forSync = false) {
  const settings = store('settings')
  const entries = store('entries').getAll()
  const categories = store('categories').getAll()
  const currency = settings.get('currency')
  const deletedPresets = settings.get('deletedPresets')
  const sync = forSync ? settings.get('driveSync') : null
  const reset = forSync ? settings.get('driveReset') : null
  const features = settings.get('features')
  features.onsuccess = () => {
    const ledger = {
      entries: entries.result.sort((a, b) => b.at.localeCompare(a.at) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
      categories: categories.result,
      currency: currency.result ?? 'JPY',
      deletedPresets: deletedPresets.result ?? [],
      features: readFeatures(features.result, categoryDirections(categories.result))
    }
    done(forSync ? { ledger, sync: sync.result, reset: reset.result } : ledger)
  }
}

export function readLedger() {
  return transact(ledgerStores, 'readonly', ledgerRequests)
}

export function readDriveState() {
  return transact(ledgerStores, 'readonly', (store, done) => ledgerRequests(store, done, true))
}

export function applyDriveState(expected, ledger, sync) {
  return transact(ledgerStores, 'readwrite', (store, done) => ledgerRequests(store, current => {
    if (current.sync?.revision !== expected.sync?.revision || current.reset !== expected.reset ||
        !sameLedger(current.ledger, expected.ledger)) { done(null); return }
    const settings = store('settings')
    const changed = !sameLedger(ledger, current.ledger)
    if (changed) {
      const entries = store('entries')
      const categories = store('categories')
      entries.clear()
      categories.clear()
      ledger.entries.forEach(entry => entries.add(entry))
      ledger.categories.forEach(category => categories.add(category))
      settings.put(presetVersion, 'presets')
      settings.put(ledger.currency, 'currency')
      settings.put(ledger.deletedPresets, 'deletedPresets')
      settings.put(ledger.features, 'features')
    }
    settings.put(sync, 'driveSync')
    settings.delete('driveReset')
    done({ changed })
  }, true), false)
}

const categoryDirections = list => new Map(list.map(item => [item.id, item.direction]))
const withExistingCategory = (entry, categories) => entry.categoryId && categories.get(entry.categoryId) !== entry.direction
  ? { ...entry, categoryId: null }
  : entry

export const saveEntry = (entry, merchant) => saveEntries([entry], merchant)
export const saveEntries = (list, merchant) => transact(merchant ? ['entries', 'categories', 'settings'] : ['entries', 'categories'], 'readwrite', (store, done) => {
  const entries = store('entries')
  const request = store('categories').getAll()
  request.onsuccess = () => {
    const categories = categoryDirections(request.result)
    const writeEntries = () => {
      for (const entry of list) entries.put(withExistingCategory(entry, categories))
    }
    if (!merchant) { writeEntries(); return }
    const settings = store('settings')
    const saved = settings.get('features')
    saved.onsuccess = () => {
      const features = readFeatures(saved.result, categories)
      const key = merchantKey(merchant.alias)
      const previous = findMerchantRule(features.merchants, merchant.alias, request.result, list[0].direction).rule
      const aliases = previous?.aliases.some(alias => merchantKey(alias) === key) ? previous.aliases : [...(previous?.aliases ?? []), merchant.alias]
      const rule = validFeature('merchants', { id: previous?.id ?? crypto.randomUUID(), aliases,
        name: merchant.name, categoryId: list[0].categoryId }, categories)
      const others = features.merchants.filter(item => item.id !== rule?.id)
      if (!rule || !rule.categoryId || featureConflict('merchants', rule, others)) { done('invalid'); return }
      features.merchants = [...others, rule]
      settings.put(features, 'features')
      writeEntries()
    }
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
    for (const key of ['presets', 'currency', 'deletedPresets', 'features']) settings.delete(key)
    const linked = settings.get('driveSync')
    linked.onsuccess = () => {
      if (linked.result) settings.put(crypto.randomUUID(), 'driveReset')
    }
    store('rates').clear()
    syncPresets(categories, settings)
  })
}

export const saveCurrency = currency => transact(['settings'], 'readwrite', store => store('settings').put(currency, 'currency'))

function featureConflict(list, item, others) {
  if (list === 'budgets') return others.some(value => value.categoryId === item.categoryId && value.currency === item.currency)
  if (list === 'bills') return Boolean(item.sourceEntryId && others.some(value => value.sourceEntryId === item.sourceEntryId))
  if (list === 'merchants') {
    const keys = new Set([item.name, ...item.aliases].map(merchantKey).filter(Boolean))
    return others.some(value => [value.name, ...value.aliases].some(alias => keys.has(merchantKey(alias))))
  }
  return false
}

export function saveFeature(list, item, previous) {
  return transact(['settings', 'categories'], 'readwrite', (store, done) => {
    const settings = store('settings')
    const categories = store('categories').getAll()
    const current = settings.get('features')
    current.onsuccess = () => {
      const directions = categoryDirections(categories.result)
      const features = readFeatures(current.result, directions)
      const valid = validFeature(list, item, directions)
      if (!valid) { done('invalid'); return }
      const existing = features[list].find(value => value.id === valid.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(existing)) { done('changed'); return }
      const others = features[list].filter(value => value.id !== valid.id)
      if (featureConflict(list, valid, others)) { done('duplicate'); return }
      features[list] = [...others, valid]
      settings.put(features, 'features')
      done('saved')
    }
  })
}

export function deleteFeature(list, id) {
  return transact(['settings', 'categories'], 'readwrite', store => {
    const settings = store('settings')
    const categories = store('categories').getAll()
    const current = settings.get('features')
    current.onsuccess = () => {
      const features = readFeatures(current.result, categoryDirections(categories.result))
      features[list] = features[list].filter(item => item.id !== id)
      settings.put(features, 'features')
    }
  })
}

export function postBill(id, due, entry) {
  return transact(['settings', 'categories', 'entries'], 'readwrite', (store, done) => {
    const settings = store('settings')
    const entries = store('entries')
    const categories = store('categories').getAll()
    const current = settings.get('features')
    current.onsuccess = () => {
      const directions = categoryDirections(categories.result)
      const features = readFeatures(current.result, directions)
      const bill = features.bills.find(item => item.id === id)
      const source = billKey(id, due)
      // Reuse the index to look up source keys only for this schedule, inside the write transaction.
      const prior = entries.index('sourceKey').getAll(IDBKeyRange.bound(billKey(id, ''), billKey(id, '\uffff')))
      prior.onsuccess = () => {
        const posted = new Set(prior.result.map(item => item.sourceKey))
        if (!bill || !due || due > tokyoNow().slice(0, 10) || firstUnpostedDate(bill, posted) !== due) {
          done(false)
          return
        }
        entries.add(withExistingCategory({ ...entry, sourceKey: source }, directions))
        bill.next = nextBillDate(bill, due)
        settings.put(features, 'features')
        done(true)
      }
    }
  })
}

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
    const configured = settings.get('features')
    configured.onsuccess = () => {
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
      const features = readFeatures(configured.result, categoryDirections(categoryList.result))
      features.budgets = features.budgets.filter(item => !removedIds.has(item.categoryId))
      for (const item of [...features.merchants, ...features.bills]) if (removedIds.has(item.categoryId)) item.categoryId = null
      settings.put(features, 'features')
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
      const matcher = createImportMatcher(existing.result)
      const categories = categoryDirections(request.result)
      let added = 0
      for (const entry of entries) {
        if (matcher.find(entry)) continue
        target.add(withExistingCategory(entry, categories))
        matcher.add({ entry })
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

export function backupDocument({ entries, categories, currency, deletedPresets, features }) {
  return { format: 'hiba-ledger', version: 1, exportedAt: new Date().toISOString(), currency, categories, entries,
    ...(deletedPresets?.length ? { deletedPresets } : {}), ...(features ? { features } : {}) }
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
  const features = readFeatures(input.features, categoryDirections(categories))
  return { entries, categories, currency: input.currency, deletedPresets: [...deletedPresets], features }
}

function categoryRestorer(store, current, backup, deletedPresets) {
  const key = item => JSON.stringify([item.direction, item.parentId, item.name])
  const byId = new Map(current.map(item => [item.id, item]))
  const byName = new Map(current.map(item => [key(item), item]))
  const byPreset = new Map(current.filter(item => item.presetId).map(item => [item.presetId, item]))
  const fromBackup = new Map(backup.map(item => [item.id, item]))
  const restoredIds = new Map()

  function restoreCategory(id) {
    if (id === null) return null
    if (restoredIds.has(id)) return restoredIds.get(id)
    const category = fromBackup.get(id)
    const parentId = restoreCategory(category.parentId)
    if (category.parentId !== null && parentId === null) { restoredIds.set(id, null); return null }

    const presetId = category.presetId ?? (presetsById.has(id) ? id : null)
    const record = { id, parentId, direction: category.direction, name: category.name, icon: category.icon }
    const match = [byId.get(id), byId.get(presetId), byPreset.get(presetId), byName.get(key(record))]
      .find(item => item?.parentId === parentId && item.direction === record.direction)
    let localId = match?.id ?? null
    if (!match && !deletedPresets.has(presetId)) {
      if (byId.has(id)) record.id = crypto.randomUUID()
      store.add(record)
      byId.set(record.id, record)
      byName.set(key(record), record)
      localId = record.id
    }
    restoredIds.set(id, localId)
    return localId
  }

  return restoreCategory
}

export function restoreLedger(backup, signature) {
  return transact(['entries', 'categories', 'settings'], 'readwrite', (store, done) => {
    const entries = store('entries')
    const categories = store('categories')
    const settings = store('settings')
    const currentEntries = entries.getAll()
    const currentCategories = categories.getAll()
    const currency = settings.get('currency')
    const deleted = settings.get('deletedPresets')
    const configured = settings.get('features')
    configured.onsuccess = () => {
      const plan = planBackupRestore(currentEntries.result, backup.entries)
      if (signature && signature !== restorePlanSignature(plan)) { done({ changed: true }); return }
      done({ restored: plan.entries.length, latestDate: plan.dates.at(-1), skippedDates: plan.skippedDates })
      if (!plan.entries.length) return

      const deletedPresets = new Set(deleted.result ?? [])
      const fresh = !currentEntries.result.length && currency.result === undefined && !deletedPresets.size &&
        !Object.values(readFeatures(configured.result, categoryDirections(currentCategories.result))).some(items => items.length) &&
        currentCategories.result.length === defaults.length && currentCategories.result.every(item => {
          const preset = presetsById.get(item.id)
          return preset && preset.name === item.name && preset.icon === item.icon && preset.parentId === item.parentId && preset.direction === item.direction && !item.presetId
        })

      for (const id of plan.replaceIds) entries.delete(id)
      if (fresh) {
        // Restore the full category setup when migrating to an untouched ledger.
        categories.clear()
        backup.categories.forEach(item => categories.add(item))
        settings.put(backup.currency, 'currency')
        settings.put(backup.deletedPresets ?? [], 'deletedPresets')
        if (backup.features) settings.put(backup.features, 'features')
        syncPresets(categories, settings)
        plan.entries.forEach(item => entries.add(item))
        return
      }
      const restoreCategory = categoryRestorer(categories, currentCategories.result, backup.categories, deletedPresets)
      for (const item of plan.entries) entries.add({ ...item, categoryId: restoreCategory(item.categoryId) })
    }
  })
}
