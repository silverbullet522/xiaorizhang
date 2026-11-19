import {
  amountMinor, dateTime, directions, duplicatePreviews, importRows, money, monthBounds, statementColumns,
  summarize, tokyoNow, withQuotes, within
} from './core.mjs'
import {
  addEntries, backupDocument, completeRates, deleteEntry, readLedger, restoreLedger,
  saveCategory, saveCurrency, saveEntry, validateBackup
} from './storage.mjs'
import { loadQuotes, quotesFor } from './rates.mjs'
import { guessColumns, readFile } from './tables.mjs'
import {
  brand, breakdown, button, currencyOptions, dayLabel, emptyLedger, escape, icoButton, icon,
  option, periodDisplay, summaryCards, tabs, transaction, trend
} from './ui.mjs'

const byId = id => document.getElementById(id)
const main = byId('main')
const dialog = byId('dialog')
const state = {
  entries: [], categories: [], currency: 'JPY', view: 'overview', month: tokyoNow().slice(0, 7),
  range: null, ledgerDay: null, ledgerDirection: 'all', ledgerCategory: null, ledgerLimit: 60,
  statsDirection: 'expense', categoryDirection: 'expense', trendPage: 0
}
const viewNames = { overview: ['概览', 'overview'], ledger: ['流水', 'ledger'], categories: ['分类', 'tag'] }
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
let importState
let pendingBackup
let noticeTimer
let ratesTask
let offlineReady = Boolean(navigator.serviceWorker?.controller)

function toast(message) {
  clearTimeout(noticeTimer)
  byId('notice').textContent = message
  noticeTimer = setTimeout(() => { byId('notice').textContent = '' }, 3200)
}

function formError(message) {
  const error = dialog.querySelector('.form-error')
  if (error) error.textContent = message
  else toast(message)
}

function period() { return state.range ?? monthBounds(state.month) }
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN')
const parentOrder = ['food', 'travel', 'shopping', 'home', 'fun', 'health', 'salary', 'extra']
const priority = item => parentOrder.includes(item.id) ? parentOrder.indexOf(item.id) : parentOrder.length
const topCategories = direction => state.categories.filter(item => item.direction === direction && item.parentId === null)
  .sort((a, b) => priority(a) - priority(b) || byName(a, b))
const children = id => id ? state.categories.filter(item => item.parentId === id).sort(byName) : []

function navLink(view) {
  const [label, glyph] = viewNames[view]
  const active = state.view === view ? 'aria-current="page"' : ''
  return `<button class="nav-link" data-action="navigate" data-value="${view}" ${active} type="button">${icon(glyph, 19)}${label}</button>`
}

function chrome() {
  const status = navigator.onLine ? (offlineReady ? '本机账本 · 可离线使用' : '本机账本') : '离线模式'
  byId('sidebar').innerHTML = `${brand('sidebar-brand')}<nav class="side-nav">${Object.keys(viewNames).map(navLink).join('')}</nav>
    <div class="side-foot"><button class="side-extra" type="button" data-action="backup">${icon('shield')}设置与备份</button>
    <div class="side-status"><span class="dot ${navigator.onLine ? '' : 'off'}"></span>${status}</div></div>`
  byId('topbar').innerHTML = `<span class="top-label">${icon('shield', 16)}${status}</span>${brand('mobile-brand')}
    <div class="top-actions">${icoButton('pick-import', 'upload', '导入账单')}
    ${icoButton('backup', 'settings', '设置与备份')}
    <span class="desktop-add">${button('add', '记一笔', '', 'plus', 'primary')}</span></div>`
  byId('mobile-nav').innerHTML = `${navLink('overview')}${navLink('ledger')}${navLink('categories')}
    <button class="nav-link mobile-add" type="button" data-action="add">${icon('plus', 19)}记一笔</button>`
}

const periodControls = () => `<div class="filter-actions">${periodDisplay(state.range, state.month)}${tabs('currency', { JPY: 'JPY', CNY: 'CNY' }, state.currency)}</div>`
const pendingBanner = count => count
  ? `<div class="banner"><span>当前金额为已换算小计，${count} 笔待换算。</span><button type="button" data-action="retry-rates" class="plain">刷新汇率</button></div>`
  : ''

function overview() {
  const range = period()
  const entries = state.entries.filter(entry => within(entry, range))
  const totals = summarize(entries, state.currency)
  const counts = { expense: entries.filter(entry => entry.direction === 'expense').length, income: entries.filter(entry => entry.direction === 'income').length }
  return `<div class="page-heading"><div><h1>账本概览</h1></div>${periodControls()}</div>
    ${summaryCards(totals, state.currency, counts)}${pendingBanner(totals.pending)}
    <div class="dashboard-grid">${trend(totals, range, state.currency, state.trendPage)}${breakdown(entries, state.categories, state.statsDirection, state.currency)}</div>
    <section class="panel"><div class="panel-head"><h2>近期流水</h2><button class="plain" type="button" data-action="navigate" data-value="ledger">查看全部</button></div>
    <div class="ledger">${entries.length ? entries.slice(0, 5).map(item => transaction(item, state.categories, state.currency)).join('') : emptyLedger(Boolean(state.entries.length))}</div></section>`
}

function ledger() {
  const range = state.ledgerDay ?? period()
  const category = state.categories.find(item => item.id === state.ledgerCategory)
  const filtered = state.entries.filter(entry => within(entry, range) &&
    (state.ledgerDirection === 'all' || entry.direction === state.ledgerDirection) &&
    (state.ledgerCategory === null || (state.ledgerCategory === '' ? !entry.categoryId
      : entry.categoryId === state.ledgerCategory || state.categories.some(item => item.id === entry.categoryId && item.parentId === state.ledgerCategory))))
  let lastDay
  const rows = filtered.slice(0, state.ledgerLimit).map(item => {
    const day = item.at.slice(0, 10)
    const heading = day !== lastDay ? `<h3 class="day-label">${dayLabel(day)}</h3>` : ''
    lastDay = day
    return heading + transaction(item, state.categories, state.currency)
  }).join('')
  const restrictions = [state.ledgerDay && (range.start === range.end ? dayLabel(range.start) : `${range.start} ～ ${range.end}`),
    state.ledgerCategory !== null && (category?.name ?? '未分类')].filter(Boolean)
  return `<div class="page-heading"><div><h1>流水</h1><p>${filtered.length} 笔记录</p></div>${periodControls()}</div>
    <section class="panel"><div class="ledger-filter">
    ${tabs('ledger-direction', { all: '全部', ...directions }, state.ledgerDirection)}
    ${button('pick-import', '导入账单', '', 'upload')}</div>
    ${restrictions.length ? `<button class="filter-tag" type="button" data-action="clear-drill" aria-label="清除当前细分筛选">${escape(restrictions.join(' · '))} ×</button>` : ''}
    <div class="ledger">${rows || emptyLedger(Boolean(state.entries.length))}</div>
    ${filtered.length > state.ledgerLimit ? button('more-ledger', '显示更多') : ''}</section>`
}

function categoryPage() {
  const direction = state.categoryDirection
  const groups = topCategories(direction).map(item => {
    const tags = children(item.id).map(child => `<span class="chip">${escape(child.name)}</span>`).join('')
    return `<section class="panel"><div class="group-head"><span class="category-icon">${icon(item.icon)}</span>
      <h2>${escape(item.name)}</h2>${icoButton('category-new', 'plus', '新增二级分类', `data-value="${item.id}"`)}</div>
      <div class="chips">${tags || '<span class="fine">还没有二级分类</span>'}</div></section>`
  })
  return `<div class="page-heading"><div><h1>分类</h1><p>用两级分类整理收入和支出</p></div>
    <div class="filter-actions">${tabs('category-direction', { expense: '支出', income: '收入' }, direction)}
    ${button('category-new', '新增一级分类', '', 'plus', 'primary')}</div></div><div class="groups">${groups.join('')}</div>`
}

function render() {
  chrome()
  main.innerHTML = ({ overview, ledger, categories: categoryPage })[state.view]()
}

async function reload() {
  Object.assign(state, await readLedger())
  render()
}

function clearDrill() {
  state.ledgerDay = null
  state.ledgerCategory = null
  state.ledgerLimit = 60
  state.trendPage = 0
}

function go(view) {
  state.view = view
  render()
  main.focus({ preventScroll: true })
  window.scrollTo(0, 0)
}

function openDialog(title, content, wide = false) {
  dialog.classList.toggle('wide', wide)
  dialog.innerHTML = `<div class="dialog-top"><h2 id="dialog-title">${title}</h2>
    ${icoButton('close', 'close', '关闭')}</div><div class="dialog-content">${content}</div>`
  if (!dialog.open) dialog.showModal()
  dialog.scrollTop = 0
}

const errorPlaceholder = '<p class="form-error" role="alert"></p>'
const cancelButton = button('close', '取消')
const submitButton = label => `<button type="submit" class="button primary">${label}</button>`
const field = (name, content) => `<label class="form-field">${name}${content}</label>`
const selectField = (label, key, options) => field(label, `<select name="${key}">${options}</select>`)

function openPeriod() {
  const { start, end } = period()
  openDialog('选择日期范围', `<form id="period-form" class="form-grid">
    <div class="form-pair">${field('开始日期', `<input name="start" type="date" value="${start}" required>`)}
    ${field('结束日期', `<input name="end" type="date" value="${end}" required>`)}</div>
    ${errorPlaceholder}<div class="form-footer">${button('this-month', '回到本月', '', '', 'leading')}${cancelButton}${submitButton('应用日期范围')}</div>
    </form>`)
}

function changeMonth(delta) {
  const [year, number] = state.month.split('-').map(Number)
  const date = new Date(Date.UTC(year, number - 1 + delta, 1))
  if (date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9999) return
  state.month = date.toISOString().slice(0, 7)
  state.range = null
  clearDrill()
  render()
}

function createCategory(parentId) {
  const parent = state.categories.find(item => item.id === parentId)
  openDialog(parent ? '新增二级分类' : '新增一级分类', `<form id="category-form" class="form-grid" data-parent="${parent?.id ?? ''}">
    ${parent ? `<p class="fine">${directions[parent.direction]} · ${escape(parent.name)}</p>` : selectField('收支类型', 'direction', ['expense', 'income'].map(id => option(id, directions[id], state.categoryDirection)).join(''))}
    ${field('分类名称', '<input name="name" maxlength="24" required placeholder="输入分类名称">')}
    ${errorPlaceholder}<div class="form-footer">${cancelButton}${submitButton('保存分类')}</div></form>`)
}

function selectCategories(form, direction, selectedId, rootId) {
  const selected = state.categories.find(item => item.id === selectedId)
  const first = rootId ?? selected?.parentId ?? selected?.id ?? ''
  form.elements.parent.innerHTML = option('', '未分类', first) + topCategories(direction).map(item => option(item.id, item.name, first)).join('')
  form.elements.child.innerHTML = option('', '选择二级分类（可选）', selectedId) + children(form.elements.parent.value).map(item => option(item.id, item.name, selectedId)).join('')
  form.elements.parent.disabled = direction === 'transfer'
  form.elements.child.disabled = direction === 'transfer' || !children(form.elements.parent.value).length
}

const amountText = (minor, currency) => (minor / (currency === 'JPY' ? 1 : 100)).toFixed(currency === 'JPY' ? 0 : 2)
function openEntry(id) {
  const entry = state.entries.find(item => item.id === id)
  if (id && !entry) return
  const at = entry?.at ?? tokyoNow()
  const currency = entry?.currency ?? 'JPY'
  const amount = entry ? amountText(entry.minor, currency) : ''
  openDialog(entry ? '编辑流水' : '记一笔', `<form id="entry-form" class="form-grid" data-id="${entry?.id ?? ''}">
    <div class="form-pair">
      ${selectField('收支类型', 'direction', Object.entries(directions).map(([key, value]) => option(key, value, entry?.direction ?? 'expense')).join(''))}
      ${selectField('币种', 'currency', currencyOptions(currency))}
    </div>
    ${field('金额', `<input name="amount" inputmode="${currency === 'JPY' ? 'numeric' : 'decimal'}" value="${amount}" autocomplete="off" maxlength="24" placeholder="0" required>`)}
    <div class="fx" id="fx-preview" aria-live="polite"></div>
    <div class="form-pair">
      ${field('日期 · 东京时间', `<input name="day" type="date" min="1900-01-01" max="9999-12-31" value="${at.slice(0, 10)}" required>`)}
      ${field('时间', `<input name="time" type="time" step="1" value="${at.slice(11)}" required>`)}
    </div>
    <div class="form-pair">
      ${selectField('一级分类', 'parent', '')}${selectField('二级分类', 'child', '')}
    </div>
    ${field('备注', `<textarea name="note" maxlength="500" placeholder="商户或其他备注">${escape(entry?.note ?? '')}</textarea>`)}
    ${errorPlaceholder}<div class="form-footer">${entry ? button('delete-entry', '删除', `data-value="${entry.id}"`, '', 'danger leading') : ''}
    ${cancelButton}${submitButton('保存流水')}</div></form>`)
  const form = byId('entry-form')
  selectCategories(form, entry?.direction ?? 'expense', entry?.categoryId)
  refreshEntryQuote(form, true)
}

function entryDraft(form) {
  const data = form.elements
  const at = dateTime(`${data.day.value}T${data.time.value}`)
  const currency = data.currency.value
  const minor = amountMinor(data.amount.value, currency)
  if (!at || minor === null || minor <= 0) return null
  const previous = state.entries.find(item => item.id === form.dataset.id)
  const sameAmount = previous?.currency === currency && previous?.minor === minor
  const sameDay = previous?.at.slice(0, 10) === at.slice(0, 10)
  const preserve = sameAmount && sameDay
  return withQuotes({
    at, currency, minor, direction: data.direction.value,
    categoryId: data.direction.value === 'transfer' ? null : data.child.value || data.parent.value || null,
    note: data.note.value.trim(),
    settlementYen: sameAmount ? previous.settlementYen : null,
    sourceRate: sameAmount ? previous.sourceRate : null,
    sourceKey: previous?.sourceKey ?? null,
    yen: preserve ? previous.yen : null,
    yuan: preserve ? previous.yuan : null,
    fx: sameDay ? previous.fx : {}
  }, quotesFor(at.slice(0, 10)))
}

function quotePreview(form) {
  const text = byId('fx-preview')
  const draft = entryDraft(form)
  const selected = form.elements.currency.value
  const available = quotesFor(form.elements.day.value)
  const rateLabel = draft?.fx.CNY ?? available.CNY
  if (!draft) {
    text.innerHTML = rateLabel ? `1 JPY ≈ ${rateLabel.rate} CNY<small>参考汇率 · ${rateLabel.date}</small>`
      : '输入金额后查看换算'
    return
  }
  const estimates = []
  if (selected !== 'JPY') estimates.push(draft.yen == null ? '日元待换算' : `${draft.settlementYen != null ? '日元实扣 ' : '约 '}${money(draft.yen, 'JPY')} JPY`)
  if (selected !== 'CNY') estimates.push(draft.yuan == null ? '人民币待换算' : `约 ${money(draft.yuan, 'CNY')} CNY`)
  const dates = [...new Set(Object.values(draft.fx).map(item => item.date))]
  text.innerHTML = `${estimates.join(' · ')}${dates.length ? `<small>参考汇率日期 · ${dates.join(' / ')}</small>` : '<small>如需参考汇率，联网后会自动补齐</small>'}`
}

function refreshEntryQuote(form, network) {
  quotePreview(form)
  const day = form.elements.day.value
  if (!network || !dateTime(day)) return
  loadQuotes([day]).then(() => {
    if (dialog.open && byId('entry-form') === form && form.elements.day.value === day) quotePreview(form)
  }).catch(() => {})
}

async function refreshRates(showStatus = false) {
  if (!ratesTask) {
    const pending = state.entries.filter(entry => entry.yen == null || entry.yuan == null)
    ratesTask = (async () => {
      if (!pending.length) return 0
      await loadQuotes(pending.map(item => item.at.slice(0, 10)))
      const updated = await completeRates(pending.map(item => item.id), quotesFor)
      if (updated) await reload()
      return updated ?? 0
    })().finally(() => { ratesTask = null })
  }
  const updated = await ratesTask
  if (showStatus) toast(updated ? `已补齐 ${updated} 笔汇率` : '暂未获取到可补齐的参考汇率')
}

function openBackup() {
  openDialog('设置与备份', `<div class="form-grid">
    <p class="fine">${offlineReady ? '应用已准备就绪，可离线记账。' : '首次联网打开时会准备离线应用。'}账本数据保存在当前设备。</p>
    ${standalone ? '' : '<p class="fine">在 iPhone 的 Safari 里轻点「分享」→「添加到主屏幕」，开启「作为 Web App 打开」。安装后从主屏幕开始记账。</p>'}
    <div class="backup-actions">${button('export-backup', '导出完整备份', '', '', 'primary')}${button('pick-backup', '恢复备份')}</div>
    <p class="fine">备份包括流水、自定义分类和汇总币种，可存到 iPhone 的「文件」。</p>
    ${errorPlaceholder}</div>`)
}

async function exportBackup() {
  const file = new File([JSON.stringify(backupDocument(state))], `小日账-${tokyoNow().slice(0, 10)}.json`, { type: 'application/json' })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '小日账备份' }); return }
    catch (error) { if (error.name === 'AbortError') return }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  // Keep the temporary link inside the modal's active subtree.
  dialog.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  toast('备份文件已生成')
}

function columnControl(label, name, headers, selected) {
  return selectField(label, name, option(-1, '选择列', selected) + headers.map((h, i) => option(i, h || `第 ${i + 1} 列`, selected)).join(''))
}

function importMapping() {
  const { headers } = importState.table
  const opts = importState.options
  const column = (label, name) => columnControl(label, name, headers, opts[name])
  return `<form id="map-form" class="form-grid">
    <div class="form-pair">${column('日期与时间', 'date')}
    ${selectField('金额列格式', 'mode', option('signed', '单一金额列', opts.mode) + option('pair', '分别有出金、入金列', opts.mode))}</div>
    <div id="map-signed" class="form-pair" ${opts.mode === 'signed' ? '' : 'hidden'}>${column('金额', 'amount')}${column('收支方向（选填）', 'direction')}</div>
    <div id="map-pair" class="form-pair" ${opts.mode === 'pair' ? '' : 'hidden'}>${column('出金金额', 'debit')}${column('入金金额', 'credit')}</div>
    <div class="form-pair">${column('币种（选填）', 'currency')}${selectField('未指定币种时使用', 'fixedCurrency', currencyOptions(opts.fixedCurrency))}</div>
    <div class="form-pair">${column('分类（选填）', 'category')}${column('备注（选填）', 'note')}</div>
    <p class="fine">日期支持年/月/日或 Excel 日期。单一金额列未指定收支方向时，负数视为支出，正数视为收入。</p>
    <div class="form-footer">${submitButton('预览导入')}</div>
    </form>`
}

function importPreview() {
  if (!importState.preview) return ''
  const rows = duplicatePreviews(importState.preview, state.entries)
  const counts = { ready: rows.filter(row => row.entry && !row.duplicate).length, invalid: rows.filter(row => row.error).length, duplicate: rows.filter(row => row.duplicate).length }
  return `<section class="import-preview"><div class="import-counts">
    <span class="chip">待导入 ${counts.ready}</span><span class="chip">重复 ${counts.duplicate}</span><span class="chip">有问题 ${counts.invalid}</span></div>
    <div>${rows.slice(0, importState.limit).map(({ number, entry, duplicate, error }) => {
      if (!entry) return `<div class="import-row"><span>第 ${number} 行</span><span class="form-error">${escape(error)}</span></div>`
      const direction = importState.overrides.get(number) ?? entry.direction
      const meta = `第 ${number} 行 · ${entry.at.replace('T', ' ')} · ${money(entry.minor, entry.currency)} ${entry.currency}`
      return `<div class="import-row"><div><strong>${escape(entry.note || directions[entry.direction])}</strong><small>${meta}</small></div>
        ${duplicate ? '<span class="chip">重复</span>' : `<select class="control" aria-label="第 ${number} 行收支类型" data-import-row="${number}">
        ${Object.entries(directions).map(([id, label]) => option(id, label, direction)).join('')}</select>`}</div>`
    }).join('')}</div>
    ${!rows.length ? '<p class="fine">这张表只有表头。</p>' : ''}
    <div class="form-footer">${rows.length > importState.limit ? button('more-import', '显示更多', '', '', 'leading') : ''}
    ${button('confirm-import', `导入 ${counts.ready} 笔有效流水`, counts.ready ? '' : 'disabled', '', 'primary')}</div></section>`
}

function openImport() {
  const items = importState.file.sheetNames
  const statement = importState.table && statementColumns(importState.table.headers)
  openDialog('导入账单', `<div class="form-grid">
    <div class="import-headline"><strong>${escape(importState.file.name)}</strong>${statement ? '<span class="chip">已识别日文账单</span>' : ''}</div>
    ${items.length ? selectField('工作表', 'sheet', items.map(name => option(name, name, importState.sheet)).join('')).replace('name="sheet"', 'id="sheet" name="sheet"') : ''}
    ${errorPlaceholder}
    ${importState.table && !statement ? importMapping() : ''}
    ${importPreview()}</div>`, true)
  if (importState.error) formError(importState.error)
}

function chooseSheet(name) {
  importState.sheet = name
  importState.table = null
  importState.preview = null
  importState.overrides.clear()
  importState.limit = 40
  importState.error = ''
  try {
    importState.table = importState.file.table(name)
    if (statementColumns(importState.table.headers)) importState.preview = importRows(importState.table, {})
    else importState.options = guessColumns(importState.table.headers)
  } catch (error) { importState.error = error.message }
  openImport()
}

function mappingSubmit(form) {
  const value = new FormData(form)
  const keys = ['date', 'amount', 'direction', 'debit', 'credit', 'currency', 'category', 'note']
  const options = { mode: value.get('mode'), fixedCurrency: value.get('fixedCurrency'), categories: state.categories }
  for (const key of keys) options[key] = Number(value.get(key))
  const required = options.mode === 'pair' ? ['date', 'debit', 'credit'] : ['date', 'amount']
  if (required.some(key => options[key] < 0) || new Set(required.map(key => options[key])).size !== required.length) {
    formError('请选择不同的日期和金额列。')
    return
  }
  importState.options = options
  importState.limit = 40
  importState.overrides.clear()
  importState.preview = importRows(importState.table, options)
  openImport()
}

async function confirmImport(control) {
  // Recompute from the current mapping so a changed select never imports an old preview.
  if (byId('map-form')?.dataset.dirty) { formError('列映射已更改，请重新预览。'); return }
  control.disabled = true
  try {
    const rows = duplicatePreviews(importState.preview, state.entries).filter(row => row.entry && !row.duplicate)
    const createdAt = new Date().toISOString()
    const entries = rows.map(({ number, entry }) => {
      const direction = importState.overrides.get(number) ?? entry.direction
      return withQuotes({
        ...entry, direction, id: crypto.randomUUID(), createdAt,
        categoryId: direction === entry.direction ? entry.categoryId : null
      }, quotesFor(entry.at.slice(0, 10)))
    })
    const added = await addEntries(entries)
    dialog.close()
    await reload()
    if (added) {
      const mostRecent = entries.reduce((last, entry) => entry.at > last ? entry.at : last, '')
      const importMonth = mostRecent.slice(0, 7)
      // Open a date range spanning the imported batch if it covers more than one month.
      const oldest = entries.reduce((first, entry) => entry.at < first ? entry.at : first, mostRecent)
      state.month = importMonth
      state.range = oldest.slice(0, 7) === importMonth ? null : { start: oldest.slice(0, 10), end: mostRecent.slice(0, 10) }
      clearDrill()
      state.ledgerDirection = 'all'
      go('ledger')
    }
    toast(`已导入 ${added} 笔流水`)
    await refreshRates()
  } finally { control.disabled = false }
}

async function submitEntry(form) {
  const entry = entryDraft(form)
  if (!entry) { formError('请输入有效日期和正数金额（日元为整数，人民币和美元最多两位小数）。'); return }
  const previous = state.entries.find(item => item.id === form.dataset.id)
  const id = previous?.id ?? crypto.randomUUID()
  const createdAt = previous?.createdAt ?? new Date().toISOString()
  await saveEntry({ ...entry, id, createdAt })
  dialog.close()
  if (!previous && !within(entry, period())) {
    state.month = entry.at.slice(0, 7)
    state.range = null
    clearDrill()
  }
  await reload()
  toast(previous ? '流水已更新' : '流水已保存')
  await refreshRates()
}

async function submitCategory(form) {
  const parent = state.categories.find(item => item.id === form.dataset.parent)
  const direction = parent?.direction ?? form.elements.direction.value
  const parentId = parent?.id ?? null
  const name = form.elements.name.value.normalize('NFKC').trim()
  if (!name || name.length > 24) { formError('请输入 1 到 24 个字符的名称。'); return }
  if (state.categories.some(item => item.parentId === parentId && item.direction === direction && item.name === name)) {
    formError('同级分类中已有这个名称。')
    return
  }
  const added = await saveCategory({ id: crypto.randomUUID(), parentId, direction, name, icon: parent?.icon ?? 'tag' })
  if (!added) { formError('同级分类中已有这个名称。'); return }
  state.categoryDirection = direction
  dialog.close()
  await reload()
  toast('分类已保存')
}

function submitPeriod(form) {
  const data = new FormData(form)
  const start = data.get('start')
  const end = data.get('end')
  if (!dateTime(start) || !dateTime(end) || start > end) {
    formError('请输入有效日期，结束日期须为开始日期或之后。')
    return
  }
  state.range = { start, end }
  state.month = start.slice(0, 7)
  clearDrill()
  dialog.close()
  render()
}

function pickFile(id) {
  const input = byId(id)
  if (dialog.open) dialog.close()
  input.value = ''
  input.click()
}

const actions = {
  navigate: ({ value }) => {
    clearDrill()
    state.ledgerDirection = 'all'
    go(value)
  },
  add: () => openEntry(),
  edit: ({ value }) => openEntry(value),
  'delete-entry': async ({ value }) => {
    if (!confirm('删除这笔流水？')) return
    await deleteEntry(value)
    dialog.close()
    await reload()
    toast('流水已删除')
  },
  'category-new': ({ value }) => createCategory(value),
  'category-direction': ({ value }) => { state.categoryDirection = value; render() },
  'stats-direction': ({ value }) => { state.statsDirection = value; render() },
  'trend-page': ({ value }) => { state.trendPage = Number(value); render() },
  'ledger-direction': ({ value }) => { state.ledgerDirection = value; state.ledgerLimit = 60; render() },
  'more-ledger': () => { state.ledgerLimit += 60; render() },
  'clear-drill': () => { clearDrill(); render() },
  'drill-day': ({ start, end }) => {
    clearDrill()
    state.ledgerDay = { start, end }
    state.ledgerDirection = 'all'
    go('ledger')
  },
  'drill-category': ({ value }) => {
    clearDrill()
    state.ledgerCategory = value
    state.ledgerDirection = state.statsDirection
    go('ledger')
  },
  currency: async ({ value }) => {
    await saveCurrency(value)
    await reload()
    if (value === 'CNY') await refreshRates()
  },
  period: openPeriod,
  'month-prev': () => changeMonth(-1),
  'month-next': () => changeMonth(1),
  'this-month': () => {
    state.month = tokyoNow().slice(0, 7)
    state.range = null
    clearDrill()
    dialog.close()
    render()
  },
  'retry-rates': () => refreshRates(true),
  'pick-import': () => pickFile('file-import'),
  'more-import': () => {
    if (byId('map-form')?.dataset.dirty) { formError('列映射已更改，请重新预览。'); return }
    const position = dialog.scrollTop
    importState.limit += 40
    openImport()
    dialog.scrollTop = position
  },
  'confirm-import': (_, control) => confirmImport(control),
  backup: openBackup,
  'export-backup': exportBackup,
  'pick-backup': () => pickFile('file-backup'),
  'confirm-restore': async (_, control) => {
    control.disabled = true
    try {
      await restoreLedger(pendingBackup)
      pendingBackup = null
      dialog.close()
      await reload()
      clearDrill()
      if (state.entries.length) state.month = state.entries[0].at.slice(0, 7)
      state.range = null
      go('overview')
      toast('备份已恢复')
      await refreshRates()
    } finally { control.disabled = false }
  },
  close: () => dialog.close()
}

async function handleError(error) {
  console.error(error)
  formError('操作未完成，请检查设备存储后重试。')
}

document.addEventListener('click', event => {
  const control = event.target.closest('[data-action]')
  if (!control || control.disabled) return
  try { Promise.resolve(actions[control.dataset.action]?.(control.dataset, control)).catch(handleError) }
  catch (error) { handleError(error) }
})

const forms = { 'entry-form': submitEntry, 'category-form': submitCategory, 'period-form': submitPeriod, 'map-form': mappingSubmit }
dialog.addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  if (form.dataset.saving) return
  form.dataset.saving = 'true'
  const control = event.submitter
  if (control) control.disabled = true
  try {
    formError('')
    await forms[form.id]?.(form)
  } catch (error) { handleError(error) }
  finally {
    delete form.dataset.saving
    if (control) control.disabled = false
  }
})

dialog.addEventListener('change', event => {
  const control = event.target
  if (control.id === 'sheet') { chooseSheet(control.value); return }
  if (control.dataset.importRow) { importState.overrides.set(Number(control.dataset.importRow), control.value); return }
  const form = control.form
  if (form?.id === 'map-form') {
    form.dataset.dirty = 'true'
    if (control.name === 'mode') {
      byId('map-signed').hidden = control.value !== 'signed'
      byId('map-pair').hidden = control.value !== 'pair'
    }
    return
  }
  if (form?.id !== 'entry-form') return
  const direction = form.elements.direction.value
  if (control.name === 'direction') selectCategories(form, direction)
  if (control.name === 'parent') selectCategories(form, direction, null, control.value)
  if (control.name === 'currency') form.elements.amount.inputMode = control.value === 'JPY' ? 'numeric' : 'decimal'
  if (['currency', 'day', 'time'].includes(control.name)) refreshEntryQuote(form, control.name !== 'time')
})

dialog.addEventListener('input', event => {
  const control = event.target
  if (control.form?.id === 'entry-form' && control.name === 'amount') refreshEntryQuote(control.form, false)
})

byId('file-import').addEventListener('change', async event => {
  const file = event.target.files?.[0]
  if (!file) return
  openDialog('导入账单', '<p id="import-loading" class="fine">正在读取文件…</p>')
  const indicator = byId('import-loading')
  try {
    const parsed = await readFile(file)
    if (dialog.open && byId('import-loading') === indicator) {
      importState = { file: parsed, overrides: new Map() }
      chooseSheet(parsed.sheetNames[0])
    }
  } catch (error) {
    if (dialog.open && byId('import-loading') === indicator) {
      openDialog('导入账单', `<p class="form-error">${escape(error.message || '无法读取这个表格。')}</p>`)
    }
  } finally { if (event.target.files?.[0] === file) event.target.value = '' }
})

byId('file-backup').addEventListener('change', async event => {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error('备份文件超过 32 MB。')
    pendingBackup = validateBackup(JSON.parse(await file.text()))
    openDialog('确认恢复备份', `<div class="form-grid">
      <p>备份包含 <strong>${pendingBackup.entries.length}</strong> 笔流水和 <strong>${pendingBackup.categories.length}</strong> 个分类。</p>
      <p class="fine">恢复会替换当前账本里的 ${state.entries.length} 笔流水与现有分类。</p>
      ${errorPlaceholder}<div class="form-footer">${cancelButton}${button('confirm-restore', '替换并恢复', '', '', 'danger')}</div></div>`)
  } catch {
    openDialog('恢复备份', '<p class="form-error">无法读取备份。请选择由小日账导出的有效 JSON 文件。</p>')
  } finally { if (event.target.files?.[0] === file) event.target.value = '' }
})

function updateConnectivity() {
  chrome()
  if (navigator.onLine) refreshRates().catch(handleError)
}
window.addEventListener('online', updateConnectivity)
window.addEventListener('offline', updateConnectivity)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reload().then(() => refreshRates()).catch(handleError)
})
setInterval(() => {
  if (!document.hidden && navigator.onLine) refreshRates().catch(handleError)
}, 5 * 60 * 1000)

async function start() {
  try {
    await reload()
    refreshRates().catch(handleError)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then(() => {
        offlineReady = true
        chrome()
      }).catch(error => console.warn('离线缓存暂时不可用', error))
    }
  } catch (error) {
    console.error(error)
    chrome()
    main.innerHTML = '<div class="panel"><h1>无法打开账本</h1><p class="fine">请检查浏览器是否允许本地存储，然后重新打开应用。</p></div>'
  }
}
start()
