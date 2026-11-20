import { currencies, money, offsetDate } from './core.mjs'
import { categoryName, directionLabel, formatDate, language, t } from './i18n.mjs'
import { categoryIconPaths, categoryIconTone } from './icons.mjs'

const paths = {
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.7"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.7"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.7"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.7"/>',
  ledger: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  tag: '<path d="M3 11.5V5a2 2 0 0 1 2-2h6.5l9 9a1.6 1.6 0 0 1 0 2.3l-6.2 6.2a1.6 1.6 0 0 1-2.3 0z"/><path d="M7.5 7.5h.01" stroke-width="3"/>',
  upload: '<path d="M12 15V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  download: '<path d="M12 4v11m-4-4 4 4 4-4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3m-8 0H5a1 1 0 0 1-1-1v-3M7 10h10M7 14h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h3m4 0h9"/><path d="M9 4v4m4 2v4m-6 2v4"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 2.6 8 7 10 4.4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  calendar: '<rect x="4" y="6" width="16" height="15" rx="2"/><path d="M8 3v5m8-5v5M4 11h16"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  erase: '<path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9L3 12zM12 9l6 6m0-6-6 6"/>',
  trash: '<path d="M4 7h16m-10 4v5m4-5v5m-8-9 1 13h10l1-13m-8 0V4h4v3"/>',
  income: '<path d="M6 18 18 6M9 6h9v9"/>',
  expense: '<path d="M6 6l12 12m-9 0h9V9"/>',
  chart: '<path d="M4 19h16M7 16v-4m5 4V8m5 8V4"/>',
}

export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
export const icon = (name, size = 19) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? categoryIconPaths(name)}</svg>`
export const categoryArt = (name, size = 22, label) => `<span class="category-icon" data-tone="${categoryIconTone(name, label)}">
  <svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${categoryIconPaths(name)}</svg></span>`
export const brand = extra => `<div class="brand ${extra}"><img class="brand-mark" src="./icons/touch.png" alt="" width="30" height="30"><span>${t('小日账')}</span></div>`
export const option = (value, label, selected) => `<option value="${escape(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escape(label)}</option>`
export const currencyOptions = selected => Object.entries(currencies).map(([value, label]) => option(value, t(label), selected)).join('')
export const meterFill = (key, level, axis = 'x', className = '') => `<span class="meter-fill ${className}" data-meter="${escape(key)}"
  data-axis="${axis}" data-level="${level}" style="--meter-level:${level}" aria-hidden="true"></span>`
export const icoButton = (action, glyph, label, extra = '') => `<button type="button" class="icon-button" data-action="${action}" aria-label="${label}" title="${label}" ${extra}>${icon(glyph)}</button>`
export const button = (action, label, extra = '', glyph = '', className = '') => `<button type="button" class="button ${className}" data-action="${action}" ${extra}>${glyph ? icon(glyph, 17) : ''}${label}</button>`

export function tabs(action, values, active) {
  return `<div class="tabs">${Object.entries(values).map(([id, label]) => `<button type="button" class="tab" data-action="${action}" data-value="${id}" aria-pressed="${id === active}">${label}</button>`).join('')}</div>`
}

export const dayLabel = day => formatDate(day)

export function periodDisplay(range, month) {
  const small = text => formatDate(text, 'short')
  const selected = range
    ? (range.start.slice(0, 4) === range.end.slice(0, 4) ? `${small(range.start)} ～ ${small(range.end)}` : `${formatDate(range.start)} ～ ${formatDate(range.end)}`)
    : formatDate(month, 'month')
  return `<div class="period">
    <button data-action="month-prev" type="button" aria-label="${t('上个月')}">${icon('left', 15)}</button>
    <button data-action="period" type="button" aria-label="${t('选择日期范围')}" aria-describedby="period-value">${icon('calendar', 16)}<span id="period-value">${selected}</span></button>
    <button data-action="month-next" type="button" aria-label="${t('下个月')}">${icon('right', 15)}</button>
  </div>`
}

export function summaryCards(summary, currency, counts) {
  const items = [
    ['net', t('净收支'), summary.net],
    ['expense', t('总支出'), summary.expense, t('{0} 笔支出', counts.expense)],
    ['income', t('总收入'), summary.income, t('{0} 笔收入', counts.income)]
  ]
  return `<section class="stat-board" aria-label="${t('收支汇总')}">${items.map(([cls, label, amount, caption]) => `<div class="stat-cell ${cls}">
    <span class="stat-label">${label}</span>
    <strong class="stat-value">${money(amount, currency)}</strong>
    ${caption ? `<span class="stat-note">${caption}</span>` : ''}
  </div>`).join('')}</section>`
}

export function trend(summary, range, currency, offset) {
  const count = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1
  const pageSize = 31
  const page = Math.min(offset, Math.floor((count - 1) / pageSize))
  const from = page * pageSize
  const days = Math.min(count - from, pageSize)
  const series = Array.from({ length: days }, (_, index) => {
    const day = offsetDate(range.start, from + index)
    return { day, ...(summary.days.get(day) ?? { income: 0, expense: 0 }) }
  })
  let peak = 0
  for (const sums of summary.days.values()) peak = Math.max(peak, sums.income, sums.expense)
  const unit = peak > 0 ? 10 ** Math.max(0, Math.floor(Math.log10(peak / 3))) : 1
  const step = peak ? Math.ceil(peak / (3 * unit)) * unit : currency === 'JPY' ? 1000 : 10000
  const top = step * 3
  const compact = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: currency === 'JPY' ? 1 : 2 })
  const tick = int => compact.format(int / (currency === 'JPY' ? 1 : 100))
  const date = day => formatDate(day, 'short')
  return `<section class="panel">
    <div class="panel-head"><div><h2>${t('收支走势')}</h2><p>${t('按日统计')}</p></div>
    ${count > pageSize ? `<div class="inline-actions">
      ${icoButton('trend-page', 'left', t('上一段日期'), `data-value="${page - 1}" ${page === 0 ? 'disabled' : ''}`)}
      ${icoButton('trend-page', 'right', t('下一段日期'), `data-value="${page + 1}" ${from + days === count ? 'disabled' : ''}`)}
      </div>` : ''}</div>
    <div class="legend"><span><i></i>${t('收入')}</span><span><i class="cost"></i>${t('支出')}</span></div>
    <div class="chart-shell"><div class="chart-ticks" aria-hidden="true">${[3, 2, 1, 0].map(n => `<span>${tick(step * n)}</span>`).join('')}</div>
    <div class="chart">${series.map((bin, index) => {
      const label = t('{0} 收入 {1}，支出 {2}', bin.day, money(bin.income, currency), money(bin.expense, currency))
      return `<button type="button" class="chart-day" data-action="drill-day" data-start="${bin.day}" data-end="${bin.day}" aria-label="${label}" title="${label}" ${bin.income || bin.expense ? '' : 'disabled'}>
        ${meterFill(`trend:${index}:income`, bin.income / top, 'y', 'bar')}
        ${meterFill(`trend:${index}:expense`, bin.expense / top, 'y', 'bar cost')}</button>`
    }).join('')}${series.some(day => day.income || day.expense) ? '' : `<span class="chart-empty">${t('此期间暂无收支')}</span>`}</div></div>
    <div class="chart-labels"><span>${date(series[0].day)}</span>${days > 2 ? `<span>${date(series[Math.floor((days - 1) / 2)].day)}</span>` : ''}
    ${days > 1 ? `<span>${date(series.at(-1).day)}</span>` : ''}</div>
    </section>`
}

export function breakdown(entries, categories, direction, currency) {
  const key = currency === 'JPY' ? 'yen' : 'yuan'
  const lookup = new Map(categories.map(item => [item.id, item]))
  const buckets = new Map()
  for (const entry of entries) {
    if (entry.direction !== direction || !entry[key]) continue
    const category = lookup.get(entry.categoryId)
    const id = category?.parentId ?? category?.id ?? ''
    const bucket = buckets.get(id) ?? { total: 0, children: new Map() }
    bucket.total += entry[key]
    if (category?.parentId) bucket.children.set(category.id, (bucket.children.get(category.id) ?? 0) + entry[key])
    buckets.set(id, bucket)
  }
  const total = [...buckets.values()].reduce((sum, bucket) => sum + bucket.total, 0)
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 })
  let index = 0
  const row = (id, label, amount, child = false) => `<button type="button" class="stat-line${child ? ' child' : ''}" data-action="drill-category" data-value="${escape(id)}">
    <span class="stat-name"><span>${escape(label)}</span><span class="stat-pair"><strong>${money(amount, currency)}</strong>
      <small>${percent.format(amount / total)}</small></span></span>
    <span class="stat-track" aria-hidden="true">${meterFill(`category:${index++}`, amount / total)}</span>
    </button>`
  const rows = [...buckets].sort((a, b) => b[1].total - a[1].total).map(([id, bucket]) =>
    row(id, categoryName(lookup.get(id)) || t('未分类'), bucket.total) +
    [...bucket.children].sort((a, b) => b[1] - a[1]).map(([child, amount]) => row(child, categoryName(lookup.get(child)), amount, true)).join('')
  ).join('')
  return `<section class="panel"><div class="panel-head"><div><h2>${t('分类统计')}</h2><p>${t('按一级和二级分类')}</p></div>
    ${tabs('stats-direction', { expense: t('支出'), income: t('收入') }, direction)}</div>
    ${rows ? `<div class="category-stats">${rows}</div>` : `<div class="category-fallback"><div class="empty-ring">${icon('tag', 24)}</div><span>${t('此期间暂无{0}分类数据', directionLabel(direction))}</span></div>`}</section>`
}

// `picked` is undefined outside selection mode, otherwise whether this row is selected.
export function transaction(entry, categories, reportCurrency, grouped = false, picked) {
  const category = categories.find(item => item.id === entry.categoryId)
  const parent = categories.find(item => item.id === category?.parentId)
  const selected = entry.direction === 'transfer' ? t('转账') : categoryName(category)
  const title = entry.note || selected || t('未分类')
  const tag = entry.direction === 'transfer' ? t('转账') : [categoryName(parent), categoryName(category)].filter(Boolean).join(' · ') || t('未分类')
  const time = entry.at.slice(11, 16)
  const when = grouped ? time : `${formatDate(entry.at.slice(0, 10), 'short')} ${time}`
  const detail = [when, entry.note ? tag : categoryName(parent)].filter(Boolean).join(' · ')
  const converted = entry[reportCurrency === 'JPY' ? 'yen' : 'yuan']
  const showConverted = (reportCurrency !== entry.currency || converted !== entry.minor) && entry.direction !== 'transfer'
  // The report currency is already shown in the page controls, so only foreign amounts need a code.
  const note = entry.currency !== reportCurrency || showConverted
    ? `<small>${entry.currency}${showConverted ? ` · ${converted == null ? t('待换算') : t('约 {0}', money(converted, reportCurrency))}` : ''}</small>`
    : ''
  const picking = picked !== undefined
  return `<button type="button" class="transaction${picking ? ' picking' : ''}" data-action="${picking ? 'toggle-select' : 'edit'}" data-value="${escape(entry.id)}"${picking ? ` aria-pressed="${picked}"` : ''}>
    ${picking ? `<span class="pick-mark" aria-hidden="true">${icon('check', 14)}</span>` : ''}
    ${categoryArt(category?.icon ?? (entry.direction === 'transfer' ? 'transfer' : 'tag'), 22, category?.name)}
    <span class="txn-body"><strong class="txn-title">${escape(title)}</strong><span class="txn-meta">${escape(detail)}</span></span>
    <span class="txn-value ${entry.direction === 'income' ? 'benefit' : entry.direction === 'transfer' ? 'transfer' : ''}">${({ income: '+', expense: '−', transfer: '' })[entry.direction]}${money(entry.minor, entry.currency)}${note}</span></button>`
}

export function emptyLedger(isFiltered) {
  return `<div class="empty"><span class="icon-tile">${icon('ledger', 21)}</span>
    <strong>${isFiltered ? t('没有符合条件的流水') : t('还没有流水')}</strong>
    <p>${isFiltered ? t('可调整日期、分类或搜索词。') : t('手动记一笔，或导入已有账单。')}</p>
    ${isFiltered ? '' : `<div class="inline-actions">${button('add', t('记一笔'), '', 'plus', 'primary')}${button('pick-import', t('导入账单'), '', 'upload')}</div>`}
  </div>`
}
