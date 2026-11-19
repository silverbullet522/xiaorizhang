import test from 'node:test'
import assert from 'node:assert/strict'
import { parseScreenText } from '../dist/screen.mjs'

test('优先提取人民币实付金额、商户和完整的付款时间', () => {
  const text = [
    '微信支付', '支付成功', '订单金额 ¥50.00 优惠金额 ¥8.00', '实付金额：￥４２．００',
    '商户名称：小店咖啡', '交易时间：2026-11-19 22:12:48', '交易单号 11238992912392929'
  ].join('\n')
  assert.deepEqual(parseScreenText(text), {
    amount: '42.00', currency: 'CNY', direction: 'expense', note: '小店咖啡',
    at: '2026-11-19T22:12:48', status: 'ready'
  })
})

test('日文付款页识别分行的币种和金额并忽略余额', () => {
  const text = 'PayPay\n支払い完了\n店舗名\nコンビニ東京店\nお支払い金額\n¥\n1,280\n残高 9,201円'
  const draft = parseScreenText(text)
  assert.equal(draft.amount, '1280')
  assert.equal(draft.currency, 'JPY')
  assert.equal(draft.note, 'コンビニ東京店')
})

test('美元和带时区的时间按明确字段识别', () => {
  const text = 'Payment completed\nPaid to: Blue Coffee\nTotal paid: US$ 12.40\nPaid at: 2026-11-19T23:40:00+08:00'
  assert.deepEqual(parseScreenText(text), {
    amount: '12.40', currency: 'USD', direction: 'expense', note: 'Blue Coffee',
    at: '2026-11-20T00:40:00', status: 'ready'
  })
})

test('退款计入收入，交易未完成时不预填付款金额', () => {
  const refund = parseScreenText('退款成功\n退款金额 RMB 78.01\n原支付金额 RMB 81.01\n商户：饮品店')
  assert.equal(refund.direction, 'income')
  assert.equal(refund.amount, '78.01')
  const declined = parseScreenText('支付失败\n支付金额 1,200円')
  assert.equal(declined.status, 'unfinished')
  assert.equal(declined.amount, '')
})

test('金额或币种不明时留给用户填写，区分余额和订单号', () => {
  const yen = parseScreenText('支付成功\n实付 ¥12.34')
  assert.equal(yen.amount, '12.34')
  assert.equal(yen.currency, null)
  assert.equal(yen.status, 'unknownCurrency')
  const many = parseScreenText('付款金额 1,200円\n支付金额 2,500円')
  assert.equal(many.status, 'multiple')
  assert.equal(many.amount, '')
  const noCharge = parseScreenText('12:33\n余额 ¥3,000\n优惠 JPY 200\n订单号：102948771321234')
  assert.equal(noCharge.status, 'missing')
  assert.equal(noCharge.amount, '')
  assert.equal(parseScreenText('支付金额 HK$128\n实付金额 100 HKD').amount, '')
})
