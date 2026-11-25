import test from 'node:test'
import assert from 'node:assert/strict'
import { duplicateMailKeys, emptyMail, mailAddress, mailKey, mergeMailScan, parsePaymentMail, scanPaymentMail } from '../dist/mail.mjs'

const now = Date.parse('2026-11-25T04:00:00Z')
const seconds = now / 1000
const binding = { id: 'binding-a', email: 'owner@example.com' }
const sender = { id: 'bank', address: 'bank@example.com', cursor: null }
const merchant = { id: 'merchant', address: 'shop@example.com', cursor: null }
const mailbox = { ...emptyMail(), binding, senders: [sender, merchant] }
const jpBody = 'ご利用先：ROCKETNOW JPN\nご利用金額：１,８００円\nご利用日時：2026年11月25日 12:40\n利用可能額：100,000円'

test('分别提取日文、中文和英文收据，优先识别实扣并按东京时间入账', () => {
  assert.deepEqual(parsePaymentMail('カード利用のお知らせ', jpBody, now), {
    at: '2026-11-25T12:40:00', receivedAt: '2026-11-25T13:00:00', usedReceivedTime: false,
    note: 'ROCKETNOW JPN', amount: '1800', currency: 'JPY', status: 'ready'
  })
  const chinese = parsePaymentMail('微信支付凭证', '商户名称：便利店\n交易金额：32.00元\n实际支付金额：28.50元\n付款时间：2026-11-25 11:30:02 +08:00\n优惠：3.50元', now)
  assert.equal(chinese.amount, '28.50')
  assert.equal(chinese.note, '便利店')
  assert.equal(chinese.currency, 'CNY')
  assert.equal(chinese.at, '2026-11-25T12:30:02')
  const english = parsePaymentMail('Your receipt from Example', 'Amount charged:\nUSD 15.72\nMerchant: Example\nPaid at: Nov 24, 2026 at 7:00 PM PST\nRefund policy: see website', now)
  assert.equal(english.amount, '15.72')
  assert.equal(english.currency, 'USD')
  assert.equal(english.at, '2026-11-25T12:00:00')
  assert.equal(parsePaymentMail('You have been charged US$9.99', '', now).amount, '9.99')
})

test('实际扣款不明确时保留待补全状态，并忽略失败、退款和验证码', () => {
  assert.equal(parsePaymentMail('扣款通知', '扣款金额: ¥88.00', now).status, 'unknownCurrency')
  const split = parsePaymentMail('支付成功', '交易金额: CN¥100\n交易金额: CN¥200', now)
  assert.equal(split.status, 'multiple')
  assert.equal(split.amount, '')
  assert.equal(split.usedReceivedTime, true)
  assert.equal(split.at, '2026-11-25T13:00:00')
  assert.equal(parsePaymentMail('Debit alert', 'Amount: EUR 50', now).status, 'missing')
  assert.equal(parsePaymentMail('Debit alert', 'Amount: JPY 800\nStatus: Declined', now), null)
  assert.equal(parsePaymentMail('退款成功', jpBody, now), null)
  assert.equal(parsePaymentMail('決済が完了しました', '認証コード: 625123', now), null)
  assert.equal(parsePaymentMail('One-time code for your purchase', 'Amount: JPY 800', now), null)
  assert.equal(parsePaymentMail('Shipping update', 'Order total: USD 19.99', now), null)
})

function message(id, { address = sender.address, text = jpBody, html = false, time = now - 1000 } = {}) {
  return { id, threadId: 'shared', internalDate: String(time), payload: { mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: `Alerts <${address}>` }, { name: 'Subject', value: 'ご利用のお知らせ' }],
    parts: [
      { mimeType: html ? 'text/html' : 'text/plain', body: { data: Buffer.from(text).toString('base64url') } },
      { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: Buffer.from('Amount: USD 99999').toString('base64url') } }
    ] } }
}

test('多页及同一邮件会话中的不同收据分别保留，按发件地址和时间核对', async () => {
  const calls = []
  const result = await scanPaymentMail(async (path, params) => {
    calls.push([path, { ...params }])
    if (path === 'messages') {
      if (params.q.includes('shop@')) return { messages: [{ id: 'three' }] }
      return params.pageToken ? { messages: [{ id: 'two' }, { id: 'wrong' }, { id: 'old' }, { id: 'gone' }] }
        : { messages: [{ id: 'one' }, { id: 'one' }], nextPageToken: 'page-two' }
    }
    switch (path) {
      case 'messages/three': return message('three', { address: merchant.address, html: true, text: `<article>${jpBody}</article>` })
      case 'messages/wrong': return message('wrong', { address: 'bank@example.net' })
      case 'messages/old': return message('old', { time: now - 8 * 86400000 })
      case 'messages/gone': return null
      default: return message(path.split('/')[1])
    }
  }, mailbox, [], now, html => html.replace(/<[^>]+>/g, ''))
  assert.deepEqual(result.map(item => item.drafts.length), [2, 1])
  assert.equal(result[0].cursor, seconds)
  assert.equal(result[1].drafts[0].amount, '1800')
  assert.equal(calls.filter(([path]) => path === 'messages/one').length, 1)
  assert.match(calls[0][1].q, new RegExp(`after:${seconds - 7 * 86400 - 1}`))
  const state = mergeMailScan(mailbox, binding.id, result, [])
  assert.equal(state.drafts.length, 3)
  assert.equal(new Set(state.drafts.map(draft => draft.sourceKey)).size, 3)
  assert.equal(mergeMailScan(state, binding.id, result, []).drafts.length, 3)
  assert.equal(mergeMailScan(mailbox, 'disconnected', result, []), mailbox)
  assert.equal(mergeMailScan(mailbox, binding.id, result, [state.drafts[0].sourceKey]).drafts.length, 2)
  assert.notEqual(await mailKey(binding.email, 'one'), await mailKey('other@example.com', 'one'))
  assert.doesNotMatch(await mailKey(binding.email, 'one'), /example/)
  assert.equal(mailAddress(' From@example.com '), 'from@example.com')
  assert.equal(mailAddress('from@example.com OR is:unread'), '')
})

test('分页中断保留检查进度，重试使用重叠区间并跳过已处理邮件', async () => {
  const handled = await mailKey(binding.email, 'one')
  const state = { ...mailbox, senders: [{ ...sender, cursor: seconds - 600 }], handled: [handled] }
  await assert.rejects(scanPaymentMail(async (path, params) => {
    assert.equal(path, 'messages')
    assert.match(params.q, new RegExp(`after:${seconds - 901}`))
    if (params.pageToken) throw new Error('offline')
    return { messages: [{ id: 'one' }], nextPageToken: 'another' }
  }, state, [], now), /offline/)
  assert.equal(state.senders[0].cursor, seconds - 600)
  const result = await scanPaymentMail(async (path, params) => {
    if (path === 'messages') return params.pageToken ? { messages: [{ id: 'two' }] } : { messages: [{ id: 'one' }], nextPageToken: 'another' }
    assert.equal(path, 'messages/two')
    return message('two')
  }, state, [], now)
  assert.equal(mergeMailScan(state, binding.id, result, []).drafts.length, 1)
  assert.equal(mergeMailScan(state, binding.id, result, []).senders[0].cursor, seconds)
})

test('银行和商户的近时同额邮件须逐条核对，已有流水也参与判断', () => {
  const draft = { ...parsePaymentMail('ご利用のお知らせ', jpBody, now), sourceKey: 'gmail:1' }
  const same = { ...draft, at: '2026-11-25T12:45:00', sourceKey: 'gmail:2' }
  const later = { ...draft, at: '2026-11-25T13:10:00', sourceKey: 'gmail:3' }
  assert.deepEqual(duplicateMailKeys([draft, same, later], []), new Set(['gmail:1', 'gmail:2']))
  assert.deepEqual(duplicateMailKeys([draft], [{ at: same.at, direction: 'expense', currency: 'JPY', minor: 1800, sourceKey: null }]), new Set(['gmail:1']))
  assert.deepEqual(duplicateMailKeys([draft], [{ at: same.at, direction: 'income', currency: 'JPY', minor: 1800 }]), new Set())
})
