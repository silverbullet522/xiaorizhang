import test from 'node:test'
import assert from 'node:assert/strict'
import { csvRows, duplicatePreviews, importRows } from '../dist/core.mjs'
import { billKey, budgetUsage, findMerchantRule, firstUnpostedDate, ledgerCsv, nextBillDate } from '../dist/features.mjs'

test('PayPay 以交易明细区分同号付款和多笔退款，并可匹配旧流水', () => {
  const [headers, ...data] = csvRows([
    '取引日,出金金額（円）,入金金額（円）,取引内容,取引先,取引番号',
    '2026/10/20 10:00:00,-,300,返金,店,A1',
    '2026/10/18 10:00:00,-,100,返金,店,A1',
    '2026/10/16 10:00:00,900,-,支払い,店,A1',
    '2026/10/20 10:00:00,-,300,返金,店,A1'
  ].join('\n'))
  const rows = importRows({ headers, rows: data.map((cells, i) => ({ cells, number: i + 2 })) }, {})
  assert.deepEqual(duplicatePreviews(rows, []).map(row => row.duplicate), [false, false, false, true])
  const old = { ...rows[0].entry, id: 'test-existing', sourceKey: 'statement:A1', note: '用户改过备注' }
  const previews = duplicatePreviews(rows, [old])
  assert.deepEqual(previews.map(row => row.duplicate), [true, false, false, true])
  assert.equal(previews[0].match.entry.id, old.id)
  assert.equal(duplicatePreviews(rows, [])[3].match.number, 2)
  const edited = { ...rows[2].entry, at: '2026-11-01T00:00:00', minor: 1200 }
  assert.equal(duplicatePreviews(rows, [edited])[2].duplicate, true)
})

const categories = [{ id: 'food', parentId: null, direction: 'expense' }, { id: 'delivery', parentId: 'food', direction: 'expense' }]
const expense = (at, yen, yuan, categoryId = 'delivery') => ({ at, yen, yuan, categoryId, direction: 'expense' })

test('商户别名接收全角和门店后缀，分类仍要符合收支方向', () => {
  const rule = { id: 'rocket', name: 'Rocket Now', aliases: ['ROCKETNOW JPN'], categoryId: 'delivery' }
  assert.deepEqual(findMerchantRule([rule], 'ＲＯＣＫＥＴＮＯＷ ＪＰＮ - 東京', categories, 'expense'),
    { rule, note: 'Rocket Now', categoryId: 'delivery' })
  assert.equal(findMerchantRule([rule], 'Rocket Now', categories, 'income').categoryId, null)
})

test('预算按币种汇总子分类和待换算笔数', () => {
  const entries = [expense('2026-02-28T23:30:00', 800, 3800), expense('2026-03-03T10:00:00', 1000, 4800),
    expense('2026-03-31T10:00:00', 400, null), { ...expense('2026-03-31T11:00:00', 10000, 50000), direction: 'income' }]
  const [budget] = budgetUsage(entries, categories, [{ id: 'b1', categoryId: 'food', currency: 'CNY', minor: 5000 }], '2026-03')
  assert.deepEqual([budget.spent, budget.pending, budget.remaining], [4800, 1, 200])
})

test('固定账单在短月顺延到月末，下一月恢复原日期并跳过已记的期次', () => {
  const bill = { id: 'test-rent', start: '2024-01-31', next: '2024-01-31', cycle: 'monthly' }
  assert.equal(nextBillDate(bill, bill.start), '2024-02-29')
  assert.equal(nextBillDate(bill, '2024-02-29'), '2024-03-31')
  assert.equal(firstUnpostedDate(bill, new Set([billKey(bill.id, bill.next)])), '2024-02-29')
  assert.equal(nextBillDate({ start: '2024-02-29', cycle: 'yearly' }, '2024-02-29'), '2025-02-28')
  assert.equal(nextBillDate({ cycle: 'weekly' }, '2024-02-28'), '2024-03-06')
})

test('CSV 保留原币金额、单元格引号与换行，并中和主动公式', () => {
  const entry = { at: '2026-11-19T08:30:00', currency: 'CNY', minor: 1024, yen: 230, yuan: 1024,
    categoryId: 'delivery', note: '＝1+1,"测试"\n第二行', direction: 'expense' }
  const csv = ledgerCsv([entry], ['日期'], () => '餐饮 / 外卖', () => '支出')
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  assert.deepEqual(csvRows(csv.slice(1))[1],
    ['2026-11-19 08:30:00', '支出', 'CNY', '10.24', '餐饮 / 外卖', "'" + entry.note, '230', '10.24'])
})
