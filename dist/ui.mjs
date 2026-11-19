import { currencies, directions, money, offsetDate } from './core.mjs'

const paths = {
  logo: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 3v18m3-12h4m-4 4h4m-4 4h2"/>',
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.7"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.7"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.7"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.7"/>',
  ledger: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  tag: '<path d="M3 11.5V5a2 2 0 0 1 2-2h6.5l9 9a1.6 1.6 0 0 1 0 2.3l-6.2 6.2a1.6 1.6 0 0 1-2.3 0z"/><path d="M7.5 7.5h.01" stroke-width="3"/>',
  upload: '<path d="M12 15V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3m-8 0H5a1 1 0 0 1-1-1v-3M7 10h10M7 14h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h3m4 0h9"/><path d="M9 4v4m4 2v4m-6 2v4"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 2.6 8 7 10 4.4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  calendar: '<rect x="4" y="6" width="16" height="15" rx="2"/><path d="M8 3v5m8-5v5M4 11h16"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  erase: '<path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9L3 12zM12 9l6 6m0-6-6 6"/>',
  trash: '<path d="M4 7h16m-10 4v5m4-5v5m-8-9 1 13h10l1-13m-8 0V4h4v3"/>',
  wallet: '<path d="M19 8V6a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h13a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V7"/><path d="M21 13h-5v3h5"/>',
  income: '<path d="M6 18 18 6M9 6h9v9"/>',
  expense: '<path d="M6 6l12 12m-9 0h9V9"/>',
  transfer: '<path d="M4 8h15m-4-4 4 4-4 4m5 4H5m4-4-4 4 4 4"/>',
  chart: '<path d="M4 19h16M7 16v-4m5 4V8m5 8V4"/>',
  bag: '<path d="M5 8h14l1 12H4zM9 9V6a3 3 0 0 1 6 0v3"/>',
  coffee: '<path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 9h2a2 2 0 0 1 0 4h-2M3 21h16M8 3v2m5-2v2"/>',
  train: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14m-7-8v8m-4 7-2 3m10-3 2 3m-9-6h.01m6 0h.01"/>',
  home: '<path d="m3 11 9-8 9 8m-2-2v10a2 2 0 0 1-2 2h-3v-6h-4v6H7a2 2 0 0 1-2-2V9"/>',
  sparkle: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/>',
  heart: '<path d="M20.8 8.8c0 4-5.4 8-8.8 11.1C8.6 16.8 3.2 12.8 3.2 8.8a4.8 4.8 0 0 1 8.8-2.4 4.8 4.8 0 0 1 8.8 2.4Z"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12M12 8C7 8 6 7 6 5a2.4 2.4 0 0 1 4-1c1 1 2 3 2 4zm0 0c5 0 6-1 6-3a2.4 2.4 0 0 0-4-1c-1 1-2 3-2 4z"/>'
}

export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
export const icon = (name, size = 19) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.tag}</svg>`
export const categoryArt = (glyph, size = 18) => `<span class="category-icon">${icon(glyph, size)}</span>`
export const brand = extra => `<div class="brand ${extra}"><span class="brand-mark">${icon('logo', 22)}</span><span>小日账</span></div>`
export const option = (value, label, selected) => `<option value="${escape(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escape(label)}</option>`
export const currencyOptions = selected => Object.entries(currencies).map(([value, label]) => option(value, label, selected)).join('')
export const icoButton = (action, glyph, label, extra = '') => `<button type="button" class="icon-button" data-action="${action}" aria-label="${label}" title="${label}" ${extra}>${icon(glyph)}</button>`
export const button = (action, label, extra = '', glyph = '', className = '') => `<button type="button" class="button ${className}" data-action="${action}" ${extra}>${glyph ? icon(glyph, 17) : ''}${label}</button>`

export function tabs(action, values, active) {
  return `<div class="tabs">${Object.entries(values).map(([id, label]) => `<button type="button" class="tab" data-action="${action}" data-value="${id}" aria-pressed="${id === active}">${label}</button>`).join('')}</div>`
}

export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number)
  return `${y}年${m}月${d}日`
}

export function periodDisplay(range, month) {
  const [year, number] = month.split('-')
  const small = text => text.slice(5).replace('-', '/')
  const selected = range
    ? (range.start.slice(0, 4) === range.end.slice(0, 4) ? `${small(range.start)} ～ ${small(range.end)}` : `${range.start} ～ ${range.end}`)
    : `${year}年${Number(number)}月`
  return `<div class="period">
    <button data-action="month-prev" type="button" aria-label="上个月">${icon('left', 15)}</button>
    <button data-action="period" type="button" aria-label="选择日期范围">${icon('calendar', 16)}<span>${selected}</span></button>
    <button data-action="month-next" type="button" aria-label="下个月">${icon('right', 15)}</button>
  </div>`
}

export function summaryCards(summary, currency, counts) {
  const items = [
    ['net', '净收支', summary.net, '收入 − 支出'],
    ['expense', '总支出', summary.expense, `${counts.expense} 笔支出`],
    ['income', '总收入', summary.income, `${counts.income} 笔收入`]
  ]
  return `<section class="stat-board" aria-label="收支汇总">${items.map(([cls, label, amount, caption]) => `<div class="stat-cell ${cls}">
    <span class="stat-label">${label}</span>
    <strong class="stat-value">${money(amount, currency)}</strong>
    <span class="stat-note">${caption}</span>
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
  const unit = peak > 0 ? 10 ** Math.floor(Math.log10(peak)) : 1
  const top = peak ? Math.ceil(peak / unit) * unit : currency === 'JPY' ? 3000 : 30000
  const tick = int => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.ceil(int / (currency === 'JPY' ? 1 : 100)))
  const date = day => day.slice(5).replace('-', '/')
  return `<section class="panel">
    <div class="panel-head"><div><h2>收支走势</h2><p>按日统计</p></div>
    ${count > pageSize ? `<div class="inline-actions">
      ${icoButton('trend-page', 'left', '上一段日期', `data-value="${page - 1}" ${page === 0 ? 'disabled' : ''}`)}
      ${icoButton('trend-page', 'right', '下一段日期', `data-value="${page + 1}" ${from + days === count ? 'disabled' : ''}`)}
      </div>` : ''}</div>
    <div class="legend"><span><i></i>收入</span><span><i class="cost"></i>支出</span></div>
    <div class="chart-shell"><div class="chart-ticks" aria-hidden="true">${[1, 2/3, 1/3, 0].map(n => `<span>${tick(top * n)}</span>`).join('')}</div>
    <div class="chart">${series.map(bin => {
      const label = `${bin.day} 收入 ${money(bin.income, currency)}，支出 ${money(bin.expense, currency)}`
      return `<button type="button" class="chart-day" data-action="drill-day" data-start="${bin.day}" data-end="${bin.day}" aria-label="${label}" title="${label}" ${bin.income || bin.expense ? '' : 'disabled'}>
        <span class="bar" style="--h:${bin.income / top * 100}%"></span><span class="bar cost" style="--h:${bin.expense / top * 100}%"></span></button>`
    }).join('')}${series.some(day => day.income || day.expense) ? '' : '<span class="chart-empty">此期间暂无收支</span>'}</div></div>
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
  const row = (id, label, amount, child = false) => `<button type="button" class="stat-line${child ? ' child' : ''}" data-action="drill-category" data-value="${escape(id)}">
    <span class="stat-name"><span>${escape(label)}</span><strong>${money(amount, currency)}</strong></span>
    <span class="stat-track"><i style="--w:${amount / total * 100}%"></i></span>
    </button>`
  const rows = [...buckets].sort((a, b) => b[1].total - a[1].total).map(([id, bucket]) =>
    row(id, lookup.get(id)?.name ?? '未分类', bucket.total) +
    [...bucket.children].sort((a, b) => b[1] - a[1]).map(([child, amount]) => row(child, lookup.get(child).name, amount, true)).join('')
  ).join('')
  return `<section class="panel"><div class="panel-head"><div><h2>分类统计</h2><p>按一级和二级分类</p></div>
    ${tabs('stats-direction', { expense: '支出', income: '收入' }, direction)}</div>
    ${rows ? `<div class="category-stats">${rows}</div>` : `<div class="category-fallback"><div class="empty-ring">${icon('tag', 24)}</div><span>此期间暂无${directions[direction]}分类数据</span></div>`}</section>`
}

// `picked` is undefined outside selection mode, otherwise whether this row is selected.
export function transaction(entry, categories, reportCurrency, grouped = false, picked) {
  const category = categories.find(item => item.id === entry.categoryId)
  const parent = categories.find(item => item.id === category?.parentId)
  const selected = entry.direction === 'transfer' ? '转账' : category?.name
  const title = (grouped ? selected || entry.note : entry.note || selected) || '未分类'
  const tag = entry.direction === 'transfer' ? '转账' : [parent?.name, category?.name].filter(Boolean).join(' · ') || '未分类'
  const time = entry.at.slice(11, 16)
  const detail = grouped ? [time, entry.note !== title ? entry.note : ''].filter(Boolean).join(' · ')
    : `${tag} · ${entry.at.slice(5, 10).replace('-', '/')} ${time}`
  const converted = entry[reportCurrency === 'JPY' ? 'yen' : 'yuan']
  const showConverted = (reportCurrency !== entry.currency || converted !== entry.minor) && entry.direction !== 'transfer'
  // The report currency is already shown in the page controls, so only foreign amounts need a code.
  const note = entry.currency !== reportCurrency || showConverted
    ? `<small>${entry.currency}${showConverted ? ` · ${converted == null ? '待换算' : `约 ${money(converted, reportCurrency)}`}` : ''}</small>`
    : ''
  const picking = picked !== undefined
  return `<button type="button" class="transaction${picking ? ' picking' : ''}" data-action="${picking ? 'toggle-select' : 'edit'}" data-value="${escape(entry.id)}"${picking ? ` aria-pressed="${picked}"` : ''}>
    ${picking ? `<span class="pick-mark" aria-hidden="true">${icon('check', 14)}</span>` : ''}
    ${categoryArt(category?.icon ?? (entry.direction === 'transfer' ? 'transfer' : 'tag'))}
    <span class="txn-body"><strong class="txn-title">${escape(title)}</strong><span class="txn-meta">${escape(detail)}</span></span>
    <span class="txn-value ${entry.direction === 'income' ? 'benefit' : entry.direction === 'transfer' ? 'transfer' : ''}">${({ income: '+', expense: '−', transfer: '' })[entry.direction]}${money(entry.minor, entry.currency)}${note}</span></button>`
}

export function emptyLedger(isFiltered) {
  return `<div class="empty"><span class="icon-tile">${icon('ledger', 21)}</span>
    <strong>${isFiltered ? '没有符合条件的流水' : '还没有流水'}</strong>
    <p>${isFiltered ? '可调整日期或收支筛选。' : '手动记一笔，或导入已有账单。'}</p>
    ${isFiltered ? '' : `<div class="inline-actions">${button('add', '记一笔', '', 'plus', 'primary')}${button('pick-import', '导入账单', '', 'upload')}</div>`}
  </div>`
}
