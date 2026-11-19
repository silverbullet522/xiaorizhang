import test from 'node:test'
import assert from 'node:assert/strict'
import {
  amountMinor, csvRows, dateTime, defaults, duplicatePreviews, importRows, monthBounds, presetRenames, summarize, tokyoNow, withQuotes, within
} from '../dist/core.mjs'
import { iconNames } from '../dist/icons.mjs'

test('整月和单日范围均按东京流水日期包含起止两天', () => {
  const month = monthBounds('2024-02')
  assert.deepEqual(month, { start: '2024-02-01', end: '2024-02-29' })
  assert.equal(within({ at: '2024-02-01T00:00:00' }, month), true)
  assert.equal(within({ at: '2024-02-29T23:59:59' }, month), true)
  assert.equal(within({ at: '2024-03-01T00:00:00' }, month), false)
  const day = { start: '2024-02-29', end: '2024-02-29' }
  assert.equal(within({ at: '2024-02-29T23:59:59' }, day), true)
  assert.equal(within({ at: '2024-02-28T23:59:59' }, day), false)
})

test('预设分类保留旧编号，子分类与上级同为一种收支', () => {
  const byId = new Map(defaults.map(item => [item.id, item]))
  assert.equal(byId.size, defaults.length)
  const original = {
    'food-0': '正餐', 'food-1': '咖啡饮品', 'food-2': '食材零食', 'travel-0': '公共交通', 'travel-1': '打车', 'travel-2': '机票',
    'shopping-0': '服饰', 'shopping-1': '日用品', 'shopping-2': '数码', 'home-0': '房租', 'home-1': '水电网费',
    'fun-1': '旅行', 'health-0': '医疗', 'health-1': '运动',
    'salary-0': '基本工资', 'salary-1': '奖金', 'extra-0': '副业', 'extra-1': '礼金'
  }
  for (const [id, name] of Object.entries(original)) assert.equal(byId.get(id)?.name, name)
  for (const item of defaults.filter(item => item.parentId)) assert.equal(byId.get(item.parentId).direction, item.direction)
  // 休闲 became 娱乐 and its old 娱乐 child became 休闲; the ids stay put.
  assert.equal(byId.get('fun').name, '娱乐')
  assert.equal(byId.get('fun-0').name, '休闲')
  for (const { id, to } of presetRenames) assert.equal(byId.get(id).name, to)
  for (const item of defaults) assert.ok(iconNames.has(item.icon), item.icon)
})

test('东京时间和 Excel 日期不依赖设备时区', () => {
  assert.equal(tokyoNow(new Date('2026-11-18T16:12:34Z')), '2026-11-19T01:12:34')
  assert.equal(dateTime('2026/2/28 23:19:27'), '2026-02-28T23:19:27')
  assert.equal(dateTime('2026/2/29'), null)
  assert.equal(dateTime(1.5, false), '1900-01-01T12:00:00')
  assert.equal(dateTime(60, false), null)
  assert.equal(dateTime(0.5, true), '1904-01-01T12:00:00')
})

test('金额使用币种最小单位并保留已保存的换算', () => {
  assert.equal(amountMinor('1,020.50', 'CNY'), 102050)
  assert.equal(amountMinor('1,2', 'CNY'), null)
  assert.equal(amountMinor('10.01', 'JPY'), null)
  const entry = { currency: 'CNY', minor: 1013, yen: null, yuan: null }
  const first = withQuotes(entry, { CNY: { rate: 0.05, date: '2026-11-19' } })
  assert.equal(first.yen, 203)
  assert.equal(first.yuan, 1013)
  assert.deepEqual(withQuotes(first, { CNY: { rate: 0.06, date: '2026-11-19' } }), first)
})

test('日文账单保留海外原币并只将实扣额计入日元统计', () => {
  const csv = '取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,取引内容,取引先,取引番号\r\n' +
    '2026/11/19 21:23:00,"6,000",-,38,USD,支払い,"商店,東京",12345678901234567890\r\n' +
    '2026/11/19 21:24:00,-,500,-,-,チャージ,-,A13'
  const [headers, ...data] = csvRows(csv)
  const table = { headers, rows: data.map((cells, index) => ({ cells, number: index + 2 })) }
  const rows = importRows(table, {})
  const entries = rows.map(row => row.entry)
  assert.equal(entries[0].currency, 'USD')
  assert.equal(entries[0].minor, 3800)
  assert.equal(entries[0].note, '商店,東京')
  assert.equal(entries[1].note, 'チャージ')
  assert.equal(entries[0].sourceKey, 'statement:12345678901234567890')
  const { expense, income, net, pending } = summarize(entries, 'JPY')
  assert.deepEqual([expense, income, net, pending], [6000, 500, -5500, 0])
  assert.equal(summarize(entries, 'CNY').pending, 2)
  assert.equal(duplicatePreviews(rows, entries).filter(row => row.duplicate).length, 2)
})

test('通用表格尊重收支列，报告异常行，并排除转账金额', () => {
  const [headers, ...data] = csvRows('日期,金额,收支,备注\n2026-11-19,10,转账,"多行\n""备注"""\n无效,8,支出,错误')
  const table = { headers, fileKey: 'sheet', rows: data.map((cells, index) => ({ cells, number: index + 2 })) }
  const [valid, invalid] = importRows(table, { date: 0, amount: 1, direction: 2, note: 3, fixedCurrency: 'JPY' })
  assert.equal(valid.entry.direction, 'transfer')
  assert.equal(valid.entry.note, '多行\n"备注"')
  assert.equal(valid.entry.sourceKey, 'file:sheet:2')
  assert.equal(invalid.error, '日期格式无效')
  assert.equal(summarize([valid.entry], 'JPY').net, 0)
})
