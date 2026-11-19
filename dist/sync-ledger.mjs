import { defaults } from './core.mjs'
import { emptyFeatures } from './features.mjs'

const initialSetup = { categories: defaults, currency: 'JPY', deletedPresets: [], features: emptyFeatures() }
export const emptyReplica = () => ({ reset: null, setup: null, entries: [] })
const entryKey = entry => entry.sourceKey ? 'source:' + entry.sourceKey : 'entry:' + entry.id
const idOrder = (a, b) => a === b ? 0 : a < b ? -1 : 1
const stampOrder = (a, b) => (a?.[0] ?? 0) - (b?.[0] ?? 0) || idOrder(a?.[1] ?? '', b?.[1] ?? '')
const later = (a, b) => stampOrder(a, b) >= 0 ? a : b

function canonical(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

export const equalData = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

function ledgerSetup({ categories, currency, deletedPresets, features }) {
  const byId = (a, b) => idOrder(a.id, b.id)
  return {
    categories: [...categories].sort(byId), currency, deletedPresets: [...deletedPresets].sort(),
    features: Object.fromEntries(Object.entries(features).map(([key, values]) => [key, [...values].sort(byId)]))
  }
}

export function mergeReplicas(replicas) {
  let reset = null
  let setup = null
  const entries = new Map()
  for (const replica of replicas) {
    reset = later(reset, replica.reset)
    if (replica.setup && stampOrder(replica.setup.stamp, setup?.stamp) > 0) setup = replica.setup
    for (const [key, change] of replica.entries) {
      if (stampOrder(change.stamp, entries.get(key)?.stamp) > 0) entries.set(key, change)
    }
  }
  return {
    reset,
    setup: stampOrder(setup?.stamp, reset) > 0 ? setup : null,
    entries: [...entries].filter(([, change]) => stampOrder(change.stamp, reset) > 0)
      .sort(([a], [b]) => idOrder(a, b))
  }
}

export function replicaLedger(replica) {
  const setup = ledgerSetup(replica.setup?.value ?? initialSetup)
  const directions = new Map(setup.categories.map(category => [category.id, category.direction]))
  const entries = replica.entries.flatMap(([, { value }]) => !value ? [] : [
    value.categoryId && directions.get(value.categoryId) !== value.direction ? { ...value, categoryId: null } : value
  ])
  return { ...setup, entries }
}

function newestStamp(replica) {
  return replica.entries.reduce((latest, [, change]) => later(latest, change.stamp),
    later(replica.reset, replica.setup?.stamp ?? null))
}

export function mergeLedgerChanges(base, local, remote, { reset, time, id }) {
  const incoming = mergeReplicas(remote)
  const newest = later(newestStamp(base), newestStamp(incoming))
  const stamp = [Math.max(time, (newest?.[0] ?? 0) + 1), id]
  const changes = emptyReplica()
  const before = reset ? emptyReplica() : base
  const previous = replicaLedger(before)
  if (reset) changes.reset = stamp
  // A reset uses its own stamp. Data entered after clearing belongs to the next revision.
  const written = reset ? [stamp[0] + 1, id] : stamp
  const setup = ledgerSetup(local)
  const stateChanged = !equalData(setup, ledgerSetup(previous))
  const remotelyCleared = !reset && stampOrder(incoming.reset, base.reset) > 0
  if (stateChanged && !remotelyCleared) changes.setup = { stamp: written, value: setup }
  const oldEntries = new Map(previous.entries.map(entry => [entryKey(entry), entry]))
  const current = new Map(local.entries.map(entry => [entryKey(entry), entry]))
  const cloudKeys = new Set(incoming.entries.filter(([, change]) => change.value).map(([key]) => key))
  for (const [key, entry] of current) {
    const old = oldEntries.get(key)
    if (!equalData(old, entry) && (!remotelyCleared || !old || cloudKeys.has(key))) {
      changes.entries.push([key, { stamp: written, value: entry }])
    }
  }
  for (const key of oldEntries.keys()) {
    if (!current.has(key) && (!remotelyCleared || cloudKeys.has(key))) changes.entries.push([key, { stamp: written, value: null }])
  }
  return mergeReplicas([base, incoming, changes])
}

export function sameLedger(a, b) {
  return equalData(ledgerSetup(a), ledgerSetup(b)) &&
    equalData([...a.entries].sort((x, y) => idOrder(x.id, y.id)), [...b.entries].sort((x, y) => idOrder(x.id, y.id)))
}

export function readReplica(document) {
  const validStamp = stamp => Array.isArray(stamp) && stamp.length === 2 &&
    Number.isSafeInteger(stamp[0]) && stamp[0] > 0 && typeof stamp[1] === 'string' && /^[a-z0-9-]{1,80}$/i.test(stamp[1])
  const replica = document?.replica
  const keys = new Set()
  if (document?.format !== 'hiba-drive-sync' || document.version !== 1 || !replica ||
      (replica.reset !== null && !validStamp(replica.reset)) ||
      (replica.setup !== null && (!validStamp(replica.setup?.stamp) || !Array.isArray(replica.setup.value?.categories) ||
        !Array.isArray(replica.setup.value.deletedPresets) || !replica.setup.value.features)) ||
      !Array.isArray(replica.entries)) throw new Error('invalid-cloud')
  for (const pair of replica.entries) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('invalid-cloud')
    const [key, change] = pair
    if (typeof key !== 'string' || !/^(source:|entry:).+$/s.test(key) || key.length > 1032 || keys.has(key) ||
        !validStamp(change?.stamp) || (change.value !== null &&
          (!change.value || typeof change.value !== 'object' || entryKey(change.value) !== key))) throw new Error('invalid-cloud')
    keys.add(key)
  }
  return mergeReplicas([replica])
}
