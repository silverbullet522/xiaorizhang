import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyReplica, mergeLedgerChanges, mergeReplicas, readReplica, replicaLedger } from '../dist/sync-ledger.mjs'

const fresh = () => replicaLedger(emptyReplica())
const entry = (id, note = id, sourceKey = null) => ({ id, direction: 'expense', note, sourceKey, categoryId: null })
const sync = (base, ledger, remote = [], options = {}) => mergeLedgerChanges(base, ledger, remote, { time: 100, id: 'local', ...options })

test('独立设备的新增和修改可以合并，空设备不会覆盖云端分类设置', () => {
  const a = sync(emptyReplica(), { ...fresh(), currency: 'CNY', entries: [entry('a')] })
  const b = sync(emptyReplica(), { ...fresh(), entries: [entry('b')] }, [], { id: 'other' })
  const merged = sync(emptyReplica(), fresh(), [a, b])
  assert.equal(replicaLedger(merged).currency, 'CNY')
  assert.deepEqual(replicaLedger(merged).entries.map(item => item.id), ['a', 'b'])

  const edit = sync(merged, { ...replicaLedger(merged), entries: [entry('a', '改备注'), entry('b')] })
  assert.equal(replicaLedger(mergeReplicas([merged, edit])).entries[0].note, '改备注')
})

test('同来源流水只出现一次，删除标记不会在合并旧版本时复活', () => {
  const a = sync(emptyReplica(), { ...fresh(), entries: [entry('import-a', '午餐', 'file:receipt:1')] })
  const b = sync(emptyReplica(), { ...fresh(), entries: [entry('import-b', '午餐', 'file:receipt:1')] }, [], { id: 'other' })
  const merged = mergeReplicas([a, b])
  assert.equal(replicaLedger(merged).entries.length, 1)
  const removed = sync(merged, { ...replicaLedger(merged), entries: [] }, [merged])
  assert.deepEqual(replicaLedger(mergeReplicas([a, b, removed])).entries, [])
})

test('清除同步账本丢弃清除前的数据，并保留之后录入的新流水', () => {
  const before = sync(emptyReplica(), { ...fresh(), currency: 'CNY', entries: [entry('old')] })
  const unseen = sync(before, { ...replicaLedger(before), entries: [entry('old'), entry('unseen')] })
  const cleared = sync(before, { ...fresh(), entries: [entry('new')] }, [unseen], { reset: true })
  const oldDevice = sync(before, { ...replicaLedger(before), entries: [entry('old', '离线修改')] }, [cleared])
  assert.equal(replicaLedger(oldDevice).currency, 'JPY')
  assert.deepEqual(replicaLedger(oldDevice).entries, [entry('new')])
})

test('非法云端副本会停止同步', () => {
  assert.throws(() => readReplica({ format: 'hiba-drive-sync', version: 2, replica: emptyReplica() }), /invalid-cloud/)
  const replica = sync(emptyReplica(), { ...fresh(), entries: [entry('a')] })
  const payload = { format: 'hiba-drive-sync', version: 1, replica }
  assert.deepEqual(readReplica(JSON.parse(JSON.stringify(payload))), replica)
  replica.entries.push(replica.entries[0])
  assert.throws(() => readReplica(payload), /invalid-cloud/)
})
