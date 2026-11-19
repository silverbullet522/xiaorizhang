import { defaults, directions } from './core.mjs'
import { messages } from './translations.mjs'

export const languageOptions = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', en: 'English'
}

const preferenceKey = 'hiba-language'
const translationIndexes = { 'zh-TW': 0, ja: 1, en: 2 }
const presetNames = new Map(defaults.map(({ id, name }) => [id, name]))
export let language = 'zh-CN'

export function systemLanguage(preferences) {
  for (const preference of preferences) {
    const [base, ...parts] = String(preference ?? '').toLowerCase().split('-')
    if (base === 'ja' || base === 'en') return base
    if (base === 'zh' || base === 'yue') {
      if (parts.includes('hans')) return 'zh-CN'
      return base === 'yue' || parts.some(part => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh-CN'
    }
  }
  return 'zh-CN'
}

export function initializeLanguage() {
  let saved
  try { saved = localStorage.getItem(preferenceKey) } catch { /* Storage may be unavailable in private contexts. */ }
  language = Object.hasOwn(languageOptions, saved) ? saved : systemLanguage(navigator.languages?.length ? navigator.languages : [navigator.language])
}

export function saveLanguage(value) {
  if (!Object.hasOwn(languageOptions, value)) return
  localStorage.setItem(preferenceKey, value)
  language = value
}

export function t(message, ...values) {
  const translation = Object.hasOwn(messages, message) ? messages[message][translationIndexes[language]] ?? message : message
  return values.length ? translation.replace(/\{(\d+)\}/g, (_, index) => values[index]) : translation
}

export const directionLabel = direction => t(directions[direction])

export function categoryName(category) {
  if (!category) return ''
  const { id, name } = category
  return id && presetNames.get(id) === name ? t(name) : name
}

const dateFormats = {
  full: { year: 'numeric', month: 'long', day: 'numeric' },
  short: { month: 'short', day: 'numeric' },
  month: { year: 'numeric', month: 'long' },
  monthOnly: { month: 'long' },
  weekday: { weekday: 'short' }
}
const dateFormatters = new Map()

export function formatDate(date, style = 'full') {
  const key = `${language}:${style}`
  if (!dateFormatters.has(key)) dateFormatters.set(key, new Intl.DateTimeFormat(language, { ...dateFormats[style], timeZone: 'UTC' }))
  return dateFormatters.get(key).format(new Date(`${date.length === 7 ? date + '-01' : date}T00:00:00Z`))
}
