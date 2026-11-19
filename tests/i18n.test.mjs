import test from 'node:test'
import assert from 'node:assert/strict'
import { systemLanguage } from '../dist/i18n.mjs'

test('按系统语言偏好顺序选择支持的语言，未匹配时使用简体中文', () => {
  assert.equal(systemLanguage(['ja-JP', 'en-US']), 'ja')
  assert.equal(systemLanguage(['de-DE', 'en-GB']), 'en')
  assert.equal(systemLanguage(['zh-HK']), 'zh-TW')
  assert.equal(systemLanguage(['zh-Hant-CN']), 'zh-TW')
  assert.equal(systemLanguage(['zh-Hans-TW']), 'zh-CN')
  assert.equal(systemLanguage(['zh-SG']), 'zh-CN')
  assert.equal(systemLanguage(['fr-FR']), 'zh-CN')
})
