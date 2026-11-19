import {
  amountMinor, dateTime, directions, duplicatePreviews, importRows, money, monthBounds, offsetDate, statementColumns,
  summarize, tokyoNow, withQuotes, within
} from './core.mjs'
import {
  addEntries, backupDocument, completeRates, deleteCategory, deleteEntries, deleteEntry, readLedger, restoreLedger,
  saveCategory, saveCurrency, saveEntries, saveEntry, validateBackup
} from './storage.mjs'
import { loadQuotes, quotesFor } from './rates.mjs'
import { guessColumns, readFile } from './tables.mjs'
import { iconAliases, iconChoices, iconNames } from './icons.mjs'
import { likelyDuplicate, parseScreenText, screenTextLimit, suggestCategory } from './screen.mjs'
import {
  brand, breakdown, button, categoryArt, currencyOptions, dayLabel, emptyLedger, escape, icoButton, icon,
  option, periodDisplay, summaryCards, tabs, transaction, trend
} from './ui.mjs'

const byId = id => document.getElementById(id)
const main = byId('main')
const dialog = byId('dialog')
const state = {
  entries: [], categories: [], currency: 'JPY', view: 'home', month: tokyoNow().slice(0, 7),
  range: null, ledgerDay: null, ledgerDirection: 'all', ledgerCategory: null, ledgerLimit: 60,
  statsDirection: 'expense', categoryDirection: 'expense', trendPage: 0,
  selecting: false, selected: new Set(), ledgerQuery: '', searchAll: false, ledgerSearchOpen: false, ledgerCategoriesOpen: false
}
const viewNames = { home: ['账本', 'ledger'], overview: ['报表', 'chart'], categories: ['分类', 'tag'], settings: ['设置', 'settings'] }
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const phone = standalone || matchMedia('(pointer: coarse)').matches
const allowsMotion = matchMedia('(prefers-reduced-motion: no-preference)')
let importState
let hiddenAt = 0
let pasteTimer
let bulk
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
const parentOrder = ['food', 'travel', 'shopping', 'home', 'living', 'comm', 'fun', 'health', 'beauty', 'learn',
  'social', 'family', 'pet', 'car', 'misc', 'salary', 'extra', 'invest']
const priority = item => parentOrder.includes(item.id) ? parentOrder.indexOf(item.id) : parentOrder.length
const topCategories = direction => state.categories.filter(item => item.direction === direction && item.parentId === null)
  .sort((a, b) => priority(a) - priority(b) || byName(a, b))
const children = id => id ? state.categories.filter(item => item.parentId === id).sort(byName) : []
const categoryTile = (item, active, action, disclosure = '') => `<button type="button" class="entry-cat" aria-pressed="${active}"${disclosure} data-action="${action}" data-value="${escape(item.id)}">
    ${categoryArt(item.icon, 27, item.name)}<span>${escape(item.name)}</span></button>`

const offlineDescription = () => offlineReady ? '应用已准备就绪，可离线记账。' : '首次联网打开时会准备离线应用。'

function navLink(view) {
  const [label, glyph] = viewNames[view]
  const active = state.view === view ? 'aria-current="page"' : ''
  return `<button class="nav-link" data-action="navigate" data-value="${view}" ${active} type="button">${icon(glyph, 19)}${label}</button>`
}

function chrome() {
  const status = navigator.onLine ? (offlineReady ? '本机账本 · 可离线使用' : '本机账本') : '离线模式'
  byId('sidebar').innerHTML = `${brand('sidebar-brand')}<nav class="side-nav">${Object.keys(viewNames).map(navLink).join('')}</nav>
    <div class="side-foot"><div class="side-status"><span class="dot ${navigator.onLine ? '' : 'off'}"></span>${status}</div></div>`
  byId('topbar').innerHTML = `${brand('mobile-brand')}
    <div class="top-actions">${icoButton('screen-paste', 'scan', '粘贴屏幕账单')}
    ${icoButton('pick-import', 'upload', '导入账单')}
    <span class="desktop-add">${button('add', '记一笔', '', 'plus', 'primary')}</span></div>`
  byId('mobile-nav').innerHTML = `${navLink('home')}${navLink('overview')}
    <button class="mobile-add" type="button" data-action="add" aria-label="记一笔">${icon('plus', 26)}</button>
    ${navLink('categories')}${navLink('settings')}`
  const offline = byId('settings-offline')
  if (offline) offline.textContent = offlineDescription()
}

const periodControls = () => `<div class="filter-actions">${periodDisplay(state.range, state.month)}${tabs('currency', { JPY: 'JPY', CNY: 'CNY' }, state.currency)}</div>`
const pendingBanner = count => count
  ? `<div class="banner"><span>当前金额为已换算小计，${count} 笔待换算。</span><button type="button" data-action="retry-rates" class="plain">刷新汇率</button></div>`
  : ''

const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'UTC' })

function dayCards(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const day = entry.at.slice(0, 10)
    if (!groups.has(day)) groups.set(day, [])
    groups.get(day).push(entry)
  }
  let remaining = state.ledgerLimit
  const cards = []
  const today = tokyoNow().slice(0, 10)
  const yesterday = offsetDate(today, -1)
  for (const [day, group] of groups) {
    if (remaining <= 0) break
    const sums = summarize(group, state.currency)
    const [, month, date] = day.split('-').map(Number)
    const label = day === today ? '今天' : day === yesterday ? '昨天' : weekday.format(new Date(day + 'T00:00:00Z'))
    const totals = [
      sums.expense && `支 ${money(sums.expense, state.currency)}`,
      sums.income && `收 ${money(sums.income, state.currency)}`,
      sums.pending && '待换算'
    ].filter(Boolean)
    cards.push(`<article class="day-card">
      <header class="day-head">
        <h3 aria-label="${dayLabel(day)}"><time datetime="${day}">${month}月${date}日</time><span>${label}</span></h3>
        <p>${totals.map(text => `<span>${text}</span>`).join('')}</p>
      </header>
      <div class="day-rows">${group.slice(0, remaining).map(entry => transaction(entry, state.categories, state.currency, true,
        state.selecting ? state.selected.has(entry.id) : undefined)).join('')}</div>
    </article>`)
    remaining -= group.length
  }
  return entries.length ? cards.join('') : `<section class="day-card empty-card">${emptyLedger(Boolean(state.entries.length))}</section>`
}

function home() {
  const active = period()
  const today = tokyoNow().slice(0, 10)
  const month = state.month === today.slice(0, 7) ? '本月' : `${Number(state.month.slice(5))}月`
  const periodName = state.range ? '区间' : month
  const entries = state.entries.filter(entry => within(entry, active))
  const totals = summarize(entries, state.currency)
  const daily = summarize(state.entries.filter(entry => entry.at.startsWith(today)), state.currency)
  return `<div class="page-heading book-heading"><h1>账本</h1>${periodControls()}</div>
    <div class="book-layout">
      <div class="book-digest">
        <section class="digest" aria-label="收支摘要">
          <div class="digest-today"><h2>今日支出</h2><strong>${money(daily.expense, state.currency)}</strong>
            ${daily.pending ? `<small>${daily.pending} 笔待换算</small>` : ''}</div>
          <dl class="digest-stats">
            <div><dt>${periodName}支出</dt><dd>${money(totals.expense, state.currency)}</dd></div>
            <div><dt>${periodName}收入</dt><dd>${money(totals.income, state.currency)}</dd></div>
            <div><dt>${periodName}净收支</dt><dd>${money(totals.net, state.currency)}</dd></div>
          </dl>
        </section>
        ${pendingBanner(totals.pending)}
      </div>
      <section class="book-activity" aria-labelledby="ledger-title">
        <div class="activity-head"><h2 id="ledger-title" tabindex="-1">流水</h2>
          ${icoButton('ledger-search-toggle', 'search', state.ledgerSearchOpen ? '关闭搜索' : '搜索流水',
            `id="ledger-search-toggle" aria-controls="ledger-search-field" aria-expanded="${state.ledgerSearchOpen}"`)}</div>
        ${ledgerTools()}
        <div id="ledger-results">${ledgerResults()}</div>
      </section>
    </div>`
}

function overview() {
  const range = period()
  const entries = state.entries.filter(entry => within(entry, range))
  const totals = summarize(entries, state.currency)
  const counts = { expense: entries.filter(entry => entry.direction === 'expense').length, income: entries.filter(entry => entry.direction === 'income').length }
  return `<div class="page-heading"><div><h1>报表</h1></div>${periodControls()}</div>
    ${summaryCards(totals, state.currency, counts)}${pendingBanner(totals.pending)}
    <div class="dashboard-grid">${trend(totals, range, state.currency, state.trendPage)}${breakdown(entries, state.categories, state.statsDirection, state.currency)}</div>
    <section class="panel"><div class="panel-head"><h2>近期流水</h2><button class="plain" type="button" data-action="navigate" data-value="home" data-focus="ledger">查看全部</button></div>
    <div class="ledger">${entries.length ? entries.slice(0, 5).map(item => transaction(item, state.categories, state.currency)).join('') : emptyLedger(Boolean(state.entries.length))}</div></section>`
}

const searchText = value => String(value ?? '').normalize('NFKC').toLowerCase()
const searching = () => Boolean(state.ledgerQuery.trim())

function ledgerEntries() {
  const terms = searchText(state.ledgerQuery).split(/\s+/).filter(Boolean)
  const range = state.ledgerDay ?? (terms.length && state.searchAll ? null : period())
  const lookup = new Map(state.categories.map(item => [item.id, item]))
  return state.entries.filter(entry => {
    if (range && !within(entry, range)) return false
    if (state.ledgerDirection !== 'all' && entry.direction !== state.ledgerDirection) return false
    const category = lookup.get(entry.categoryId)
    if (state.ledgerCategory === '' ? entry.categoryId : state.ledgerCategory !== null &&
      entry.categoryId !== state.ledgerCategory && category?.parentId !== state.ledgerCategory) return false
    if (!terms.length) return true
    // Every word must appear in the note, the category, or its parent category.
    const text = searchText([entry.note, category?.name, lookup.get(category?.parentId)?.name].join(' '))
    return terms.every(term => text.includes(term))
  })
}

function ledgerCategoryButtonContent() {
  const selected = state.categories.find(item => item.id === state.ledgerCategory)
  const label = selected?.name ?? (state.ledgerCategory === '' ? '未分类' : '全部分类')
  return `<span class="sr-only">筛选分类，当前：</span>${selected ? categoryArt(selected.icon, 17, selected.name) : icon('tag', 17)}
    <span class="ledger-category-label">${escape(label)}</span>${icon('down', 14)}`
}

function ledgerCategoryChoices() {
  const selected = state.categories.find(item => item.id === state.ledgerCategory)
  const rootId = selected?.parentId ?? selected?.id
  const shown = state.ledgerDirection === 'all' ? ['expense', 'income'] : [state.ledgerDirection]
  const parentIds = new Set(state.categories.map(item => item.parentId))
  const pick = (item, active, disclosure) => categoryTile(item, active, 'ledger-category-pick', disclosure)
  const shortcuts = [
    pick({ id: '*', name: '全部分类', icon: 'shapes' }, state.ledgerCategory === null),
    pick({ id: '', name: '未分类', icon: 'tag' }, state.ledgerCategory === '')
  ].join('')
  const groups = shown.map(direction => {
    const roots = topCategories(direction)
    if (!roots.length) return ''
    const root = roots.find(item => item.id === rootId)
    const kids = root ? children(root.id) : []
    return `<div class="ledger-picker-group">
      ${shown.length > 1 ? `<h3>${directions[direction]}</h3>` : ''}
      <div class="category-strip" role="group" aria-label="${directions[direction]}一级分类">
        ${roots.map(item => pick(item, item.id === rootId, parentIds.has(item.id) ? ` aria-expanded="${item.id === rootId}"` : '')).join('')}
        ${kids.length ? `<div id="ledger-filter-children" class="category-children" role="group" aria-label="${escape(root.name)}的二级分类">
          ${kids.map(item => pick(item, item.id === state.ledgerCategory)).join('')}</div>` : ''}
      </div></div>`
  }).join('')
  return `<div class="category-strip" role="group" aria-label="快捷分类">${shortcuts}</div>${groups}`
}

function ledgerResults() {
  const filtered = ledgerEntries()
  const sums = summarize(filtered, state.currency)
  const wide = searching() && !state.ledgerDay
  const scopeName = state.range ? '所选区间' : `${Number(state.month.slice(5))}月`
  const parts = [`${wide && state.searchAll ? '全部时间 · ' : ''}${filtered.length} 笔`,
    sums.expense && `支出 ${money(sums.expense, state.currency)}`, sums.income && `收入 ${money(sums.income, state.currency)}`].filter(Boolean)
  return `<div class="result-head"><p>${parts.join(' · ')}
      ${wide ? `<button type="button" class="plain" data-action="search-scope">${state.searchAll ? `只搜${scopeName}` : '搜索全部时间'}</button>` : ''}</p>
    ${filtered.length || state.selecting ? `<button class="plain" type="button" data-action="select-mode">${state.selecting ? '完成' : '选择'}</button>` : ''}</div>
    <div class="day-stack">${dayCards(filtered)}</div>
    ${filtered.length > state.ledgerLimit ? button('more-ledger', '显示更多') : ''}`
}

function ledgerTools() {
  const day = state.ledgerDay
  return `<div class="ledger-tools">
      <label class="search-field" id="ledger-search-field"${state.ledgerSearchOpen ? '' : ' hidden'}><span class="sr-only">搜索备注或分类</span>
        <input id="ledger-search" type="search" value="${escape(state.ledgerQuery)}" placeholder="搜索备注或分类" enterkeyhint="search" autocomplete="off" spellcheck="false"></label>
      <div class="ledger-filter">${tabs('ledger-direction', { all: '全部', expense: directions.expense, income: directions.income }, state.ledgerDirection)}
        <button type="button" id="ledger-category-toggle" class="ledger-category-toggle" data-action="ledger-categories-toggle"
          aria-controls="ledger-category-picker" aria-expanded="${state.ledgerCategoriesOpen}">${ledgerCategoryButtonContent()}</button></div>
      <section id="ledger-category-picker" class="ledger-category-picker" aria-labelledby="ledger-picker-title"${state.ledgerCategoriesOpen ? '' : ' hidden'}>
        <div class="ledger-picker-head"><h3 id="ledger-picker-title">选择分类</h3>${button('ledger-categories-close', '完成', '', '', 'subtle')}</div>
        <div id="ledger-category-options" class="ledger-category-options">${state.ledgerCategoriesOpen ? ledgerCategoryChoices() : ''}</div>
      </section>
      ${day ? `<button class="filter-tag" type="button" data-action="clear-drill" aria-label="清除日期筛选">${escape(day.start === day.end ? dayLabel(day.start) : `${day.start} ～ ${day.end}`)} ×</button>` : ''}
    </div>`
}

// Refresh only the list so the search box keeps focus and any IME composition in progress.
function refreshLedgerResults() {
  const results = byId('ledger-results')
  if (!results) { render(); return }
  results.innerHTML = ledgerResults()
  syncSelection()
}

function setLedgerSearchOpen(open) {
  state.ledgerSearchOpen = open
  const trigger = byId('ledger-search-toggle')
  const input = byId('ledger-search')
  const label = open ? '关闭搜索' : '搜索流水'
  trigger.setAttribute('aria-expanded', String(open))
  trigger.setAttribute('aria-label', label)
  trigger.title = label
  byId('ledger-search-field').hidden = !open
  if (open) {
    if (state.ledgerCategoriesOpen) {
      state.ledgerCategoriesOpen = false
      refreshLedgerCategories()
    }
    input.focus()
    return
  }
  input.value = state.ledgerQuery = ''
  state.searchAll = false
  state.ledgerLimit = 60
  trigger.focus({ preventScroll: true })
  refreshLedgerResults()
}

function placeLedgerCategoryChildren() {
  const strip = byId('ledger-filter-children')?.parentElement
  if (strip) placeCategoryChildren(strip)
}

function refreshLedgerCategories() {
  const trigger = byId('ledger-category-toggle')
  const options = byId('ledger-category-options')
  const open = state.ledgerCategoriesOpen
  trigger.innerHTML = ledgerCategoryButtonContent()
  trigger.setAttribute('aria-expanded', String(open))
  byId('ledger-category-picker').hidden = !open
  const scroll = options.scrollTop
  options.innerHTML = open ? ledgerCategoryChoices() : ''
  placeLedgerCategoryChildren()
  options.scrollTop = scroll
}

function setLedgerCategoriesOpen(open) {
  state.ledgerCategoriesOpen = open
  refreshLedgerCategories()
  if (open) {
    byId('ledger-search').blur()
    const options = byId('ledger-category-options')
    const active = options.querySelector('.category-children [aria-pressed="true"], [aria-expanded="true"]')
    if (active) options.scrollTop = active.offsetTop - 8
    byId('ledger-category-picker').scrollIntoView({ block: 'nearest' })
  } else byId('ledger-category-toggle').focus({ preventScroll: true })
}

function categoryPage() {
  const direction = state.categoryDirection
  const editCategoryButton = (item, className, size, affordance) => `<button type="button" class="${className}" data-action="category-edit" data-value="${escape(item.id)}" aria-label="编辑${escape(item.name)}">
    ${categoryArt(item.icon, size, item.name)}<span class="category-edit-name">${escape(item.name)}</span>${icon(affordance, 15)}</button>`
  const groups = topCategories(direction).map(item => {
    const tags = children(item.id).map(child => editCategoryButton(child, 'child-category', 18, 'right')).join('')
    return `<section class="panel category-group"><div class="group-head"><h2>${editCategoryButton(item, 'group-title', 23, 'pencil')}</h2>
      ${icoButton('category-new', 'plus', '新增二级分类', `data-value="${escape(item.id)}"`)}</div>
      ${tags ? `<div class="category-rows">${tags}</div>` : ''}</section>`
  })
  return `<div class="page-heading"><h1>分类</h1>
    <div class="filter-actions">${tabs('category-direction', { expense: '支出', income: '收入' }, direction)}
    ${button('category-new', '新增一级分类', '', 'plus', 'primary')}</div></div>
    ${groups.length ? `<div class="groups">${groups.join('')}</div>` : `<p class="panel fine">还没有${directions[direction]}分类</p>`}`
}

function render() {
  chrome()
  main.innerHTML = ({ home, overview, categories: categoryPage, settings: settingsPage })[state.view]()
  placeLedgerCategoryChildren()
  syncSelection()
}

// Only rows still on screen can stay selected, so a bulk action never reaches entries the person cannot see.
function syncSelection() {
  const visible = new Set(pickRows().map(row => row.dataset.value))
  for (const id of state.selected) if (!visible.has(id)) state.selected.delete(id)
  selectionBar()
}

const pickRows = () => [...main.querySelectorAll('[data-action="toggle-select"]')]

function selectionBar() {
  const bar = byId('select-bar')
  bar.hidden = !state.selecting
  document.body.classList.toggle('selecting', state.selecting)
  if (!state.selecting) return
  const rows = pickRows()
  const count = state.selected.size
  const all = rows.length > 0 && rows.every(row => state.selected.has(row.dataset.value))
  bar.innerHTML = `<button type="button" class="plain" data-action="select-mode">取消</button>
    <span class="select-count" aria-live="polite">已选 ${count} 笔</span>
    <button type="button" class="plain" data-action="select-all" ${rows.length ? '' : 'disabled'}>${all ? '全不选' : '全选'}</button>
    <button type="button" class="button" data-action="bulk-category" ${count ? '' : 'disabled'}>${icon('tag', 16)}改分类</button>
    <button type="button" class="button danger" data-action="delete-selected" ${count ? '' : 'disabled'}>${icon('trash', 16)}删除</button>`
}

function stopSelecting() {
  state.selecting = false
  state.selected.clear()
}

// Categories belong to one direction, so a mixed selection changes one direction at a time.
function openBulkCategory() {
  const picked = state.entries.filter(entry => state.selected.has(entry.id))
  const counts = { expense: 0, income: 0 }
  for (const entry of picked) if (entry.direction in counts) counts[entry.direction] += 1
  if (!counts.expense && !counts.income) { toast('转账没有分类，选中的流水无需修改。'); return }
  bulk = { counts, others: picked.length - counts.expense - counts.income, direction: counts.expense >= counts.income ? 'expense' : 'income', categoryId: undefined }
  renderBulkCategory()
}

function renderBulkCategory() {
  const { counts, direction, categoryId } = bulk
  const selected = state.categories.find(item => item.id === categoryId)
  const rootId = selected?.parentId ?? selected?.id ?? (categoryId === null ? '' : undefined)
  const pill = (item, active) => `<button type="button" class="entry-cat" aria-pressed="${active}" data-action="bulk-pick" data-value="${item.id}">
    ${categoryArt(item.icon)}<span>${escape(item.name)}</span></button>`
  const roots = [...topCategories(direction), { id: '', name: '未分类', icon: 'tag' }]
  const root = selected && state.categories.find(item => item.id === rootId)
  const unchanged = counts[direction === 'expense' ? 'income' : 'expense'] + bulk.others
  const label = categoryId === undefined ? '选择分类' : `改为「${escape(selected?.name ?? '未分类')}」`
  openDialog('修改分类', `<div class="form-grid bulk-category category-picker" data-direction="${direction}">
    ${counts.expense && counts.income ? tabs('bulk-direction', { expense: `支出 ${counts.expense} 笔`, income: `收入 ${counts.income} 笔` }, direction) : ''}
    <p class="fine">修改 ${counts[direction]} 笔${directions[direction]}的分类${unchanged ? `，其余 ${unchanged} 笔不变` : ''}。</p>
    <div class="category-strip">${roots.map(item => pill(item, item.id === rootId)).join('')}
      <button type="button" class="entry-cat entry-add" data-action="category-add" data-value="" aria-label="新增${directions[direction]}一级分类">
      <span class="category-icon">${icon('plus', 18)}</span><span>添加</span></button></div>
    ${root ? `<div class="category-children">${children(root.id).map(item => pill(item, item.id === categoryId)).join('')}
      <button type="button" class="entry-cat entry-add" data-action="category-add" data-value="${escape(root.id)}" aria-label="在${escape(root.name)}下新增二级分类"><span class="category-icon">${icon('plus', 18)}</span><span>添加</span></button></div>` : ''}
    ${categoryAdder}
    <div class="form-footer">${cancelButton}<button type="button" class="button primary" data-action="bulk-apply" ${categoryId === undefined ? 'disabled' : ''}>${label}</button></div>
  </div>`)
}

async function applyBulkCategory(control) {
  const { direction, categoryId } = bulk
  if (categoryId === undefined) return
  const targets = state.entries.filter(entry => state.selected.has(entry.id) && entry.direction === direction)
  const name = state.categories.find(item => item.id === categoryId)?.name ?? '未分类'
  control.disabled = true
  await saveEntries(targets.filter(entry => entry.categoryId !== categoryId).map(entry => ({ ...entry, categoryId })))
  dialog.close()
  stopSelecting()
  await reload()
  toast(`已将 ${targets.length} 笔改为「${name}」`)
}

async function reload() {
  Object.assign(state, await readLedger())
  render()
}

// Changing the month or range drops a drilled-in day but keeps the search and category filter.
function clearDrill() {
  state.ledgerDay = null
  state.ledgerLimit = 60
  state.trendPage = 0
}

function resetLedgerFilters() {
  clearDrill()
  state.ledgerCategory = null
  state.ledgerDirection = 'all'
  state.ledgerQuery = ''
  state.searchAll = false
  state.ledgerSearchOpen = false
  state.ledgerCategoriesOpen = false
}

function go(view, focusLedger = false) {
  state.view = view
  stopSelecting()
  render()
  const target = focusLedger ? byId('ledger-title') : main
  target.focus({ preventScroll: true })
  if (focusLedger) target.scrollIntoView({ block: 'start' })
  else window.scrollTo(0, 0)
}

function openDialog(title, content, layout = '') {
  dialog.classList.toggle('wide', layout === 'wide')
  dialog.classList.toggle('entry-sheet', layout === 'entry')
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

function openCategoryForm({ parentId, categoryId } = {}) {
  const category = state.categories.find(item => item.id === categoryId)
  if (categoryId && !category) return
  const parent = state.categories.find(item => item.id === (category?.parentId ?? parentId))
  const direction = category?.direction ?? parent?.direction
  const selectedIcon = startingIcon(category ?? parent)
  const title = `${category ? '编辑' : '新增'}${parent ? '二级' : '一级'}分类`
  openDialog(title, `<form id="category-form" class="form-grid" data-id="${escape(category?.id)}" data-parent="${escape(parent?.id)}" data-direction="${direction ?? ''}" data-icon-holder data-icon="${selectedIcon}">
    ${direction ? `<p class="fine">${directions[direction]}${parent ? ` · ${escape(parent.name)}` : ''}</p>` : selectField('收支类型', 'direction', ['expense', 'income'].map(id => option(id, directions[id], state.categoryDirection)).join(''))}
    ${field('分类名称', `<input name="name" value="${escape(category?.name)}" maxlength="24" required autocomplete="off" placeholder="输入分类名称">`)}
    <div class="field"><span>图标</span>${iconPicker(selectedIcon)}</div>
    ${errorPlaceholder}<div class="form-footer">
    ${category ? button('category-delete', '删除分类', '', 'trash', 'danger leading') : ''}${cancelButton}${submitButton('保存分类')}</div></form>`)
  if (category) {
    const picker = dialog.querySelector('.icon-picker')
    const active = picker.querySelector('[aria-checked="true"]')
    if (active) picker.scrollTop = active.getBoundingClientRect().top - picker.getBoundingClientRect().top - (picker.clientHeight - active.offsetHeight) / 2
  }
}

function placeCategoryChildren(strip) {
  const childGrid = strip.querySelector('.category-children')
  if (!childGrid || childGrid.hidden || !strip.clientWidth) return

  const buttons = Array.from(strip.children).filter(item => item !== childGrid)
  const activeIndex = buttons.findIndex(item => item.getAttribute('aria-expanded') === 'true')
  // Use the rendered track count so the panel follows the selected row at any width.
  const columns = getComputedStyle(strip).gridTemplateColumns.split(' ').length
  const rowEnd = buttons[Math.min(buttons.length, (Math.floor(activeIndex / columns) + 1) * columns) - 1]
  if (rowEnd.nextElementSibling === childGrid) return

  const focused = childGrid.contains(document.activeElement) ? document.activeElement : null
  rowEnd.after(childGrid)
  focused?.focus({ preventScroll: true })
}

window.addEventListener('resize', () => {
  const strip = dialog.querySelector('.category-strip')
  if (dialog.open && strip) placeCategoryChildren(strip)
  placeLedgerCategoryChildren()
})

function selectCategories(form, selectedId = '') {
  const direction = form.elements.direction.value
  const selected = state.categories.find(item => item.id === selectedId && item.direction === direction)
  const rootId = selected?.parentId ?? selected?.id ?? ''
  const section = form.querySelector('.entry-categories')
  const strip = section.querySelector('.category-strip')
  const childGrid = section.querySelector('.category-children')
  const adder = section.querySelector('.category-adder')
  form.elements.category.value = selected?.id ?? ''
  adder.hidden = true
  if (adder.parentElement === childGrid) section.append(adder)
  section.hidden = direction === 'transfer'
  if (section.hidden) return
  const pill = (item, active, disclosure) => categoryTile(item, active, 'entry-category', disclosure)
  const roots = [...topCategories(direction), { id: '', name: '未分类', icon: 'tag' }]
  strip.innerHTML = roots.map(item => pill(item, item.id === rootId, item.id ?
    ` aria-expanded="${item.id === rootId}" aria-controls="entry-subcategories"` : '')).join('') +
    `<button type="button" class="entry-cat entry-add" data-action="category-add" data-value="" aria-label="新增${directions[direction]}一级分类">
    <span class="category-icon">${icon('plus', 18)}</span><span>添加</span></button>`
  // A chosen top-level category always offers its own add slot, even before it has subcategories.
  const root = roots.find(item => item.id && item.id === rootId)
  childGrid.hidden = !root
  childGrid.innerHTML = root ? children(rootId).map(item => pill(item, item.id === selectedId)).join('') +
    `<button type="button" class="entry-cat entry-add" data-action="category-add" data-value="${escape(rootId)}" aria-label="在${escape(root.name)}下新增二级分类"><span class="category-icon">${icon('plus', 18)}</span><span>添加</span></button>` : ''
  strip.append(childGrid)
  placeCategoryChildren(strip)
  section.querySelector('.entry-category-name').textContent = selected?.name ?? '未分类'
}

// The entry sheet and the bulk category dialog share one inline "add category" field.
const categoryAdder = `<div class="category-adder" data-icon-holder hidden>
  <input class="control" type="text" maxlength="24" autocomplete="off" enterkeyhint="done" aria-label="新分类名称">
  <button type="button" class="button" data-action="category-add-cancel">取消</button>
  <button type="button" class="button primary" data-action="category-add-save">添加</button>
  <span class="category-adder-error" role="alert"></span>
  <div class="icon-picker-slot"></div>
</div>`

// Use the stored icon (or the parent's icon for a new child) and resolve old names in the picker.
const startingIcon = category => category ? iconAliases[category.icon] ?? category.icon : 'tag'
const iconPicker = selected => `<div class="icon-picker" role="radiogroup" aria-label="选择图标">${iconChoices.map(name =>
  `<button type="button" class="icon-choice" role="radio" aria-checked="${name === selected}" aria-label="${name}" data-action="pick-icon" data-value="${name}">${categoryArt(name)}</button>`).join('')}</div>`
const pickerDirection = picker => picker.dataset.direction ?? picker.closest('form').elements.direction.value

function openCategoryAdder(picker, parentId) {
  const parent = state.categories.find(item => item.id === parentId)
  const adder = picker.querySelector('.category-adder')
  const input = adder.querySelector('input')
  adder.dataset.parent = parent?.id ?? ''
  adder.querySelector('.category-adder-error').textContent = ''
  input.value = ''
  input.placeholder = parent ? `「${parent.name}」下的新分类` : `新的${directions[pickerDirection(picker)]}一级分类`
  adder.dataset.icon = startingIcon(parent)
  adder.querySelector('.icon-picker-slot').innerHTML = iconPicker(adder.dataset.icon)
  if (picker.classList.contains('entry-categories')) {
    const container = parent ? picker.querySelector('.category-children') : picker
    if (adder.parentElement !== container) container.append(adder)
  }
  adder.hidden = false
  input.focus()
}

// Adds the category without leaving the sheet, then selects it so the draft or bulk change keeps going.
async function saveInlineCategory(picker) {
  const adder = picker.querySelector('.category-adder')
  if (adder.dataset.saving) return
  const parent = state.categories.find(item => item.id === adder.dataset.parent)
  const form = picker.closest('#entry-form')
  adder.dataset.saving = 'true'
  try {
    const result = await saveCategoryDraft(parent?.id ?? null, parent?.direction ?? pickerDirection(picker), adder.querySelector('input').value, adder.dataset.icon)
    if (result.error) { adder.querySelector('.category-adder-error').textContent = result.error; return }
    await reload()
    if (form && byId('entry-form') === form) selectCategories(form, result.id)
    else if (!form && bulk && dialog.contains(picker)) { bulk.categoryId = result.id; renderBulkCategory() }
    toast('分类已添加')
  } finally { delete adder.dataset.saving }
}

const amountText = (minor, currency) => (minor / (currency === 'JPY' ? 1 : 100)).toFixed(currency === 'JPY' ? 0 : 2)
const screenReview = {
  reading: '正在读取剪贴板…',
  unread: '没有读到剪贴板文字。可长按下方框粘贴，或直接填写流水。',
  edited: '已保留你填写的内容。如需重新识别，可长按下方框粘贴。',
  ready: '请核对屏幕上的金额、币种和收支方向，再保存。',
  unknownCurrency: '已找到金额，请确认并选择币种。',
  multiple: '画面中有多个可能的金额，请填写实际扣款或到账金额。',
  unfinished: '画面显示交易未完成。请核对实际是否发生收支。',
  missing: '没有找到明确的金额，请对照付款或收款页面填写。'
}

function screenNotice(screen) {
  const duplicate = likelyDuplicate(screen, state.entries)
  if (!duplicate) return `<p class="screen-review">${icon('scan', 18)}<span>${screenReview[screen.status]}</span></p>`
  const category = state.categories.find(item => item.id === duplicate.categoryId)
  const when = `${Number(duplicate.at.slice(5, 7))}月${Number(duplicate.at.slice(8, 10))}日 ${duplicate.at.slice(11, 16)}`
  return `<p class="screen-review warn">${icon('scan', 18)}<span>可能已经记过：${when} · ${escape(duplicate.note || category?.name || '未分类')} ${money(duplicate.minor, duplicate.currency)}。确认不是同一笔再保存。</span></p>`
}

// Transfers are no longer offered, except to keep an existing transfer editable as it is.
const directionsFor = current => Object.entries(directions).filter(([key]) => key !== 'transfer' || current === 'transfer')
const dayText = day => !dateTime(day) ? '选择日期' : day === tokyoNow().slice(0, 10) ? '今天' : day.replaceAll('-', '/')

function openEntry(id, { fromScreen = false } = {}) {
  const entry = state.entries.find(item => item.id === id)
  if (id && !entry) return
  hidePaste()
  const at = entry?.at ?? tokyoNow()
  const currency = entry?.currency ?? 'JPY'
  const amount = entry ? amountText(entry.minor, currency) : ''
  const direction = entry?.direction ?? 'expense'
  const choices = (fromScreen ? option('', '请选择币种', currency) : '') + currencyOptions(currency)
  const directionChoices = directionsFor(direction).map(([key, label]) => `<label class="entry-direction">
    <input class="sr-only" type="radio" name="direction" value="${key}"${direction === key ? ' checked' : ''}>
    <span>${label}</span></label>`).join('')
  openDialog(entry ? '编辑流水' : fromScreen ? '截屏记账' : '记一笔', `<form id="entry-form" data-id="${entry?.id ?? ''}">
    <div class="entry-content">
    ${fromScreen ? `<div id="screen-entry-notice" role="status">${screenNotice({ status: 'reading' })}</div>
      <label id="screen-entry-fallback" class="form-field screen-entry-paste" hidden><span>屏幕账单文字</span>
        <textarea id="screen-entry-text" rows="2" maxlength="${screenTextLimit}" spellcheck="false" placeholder="长按此处粘贴"></textarea></label>` : ''}
    <div class="entry-toolbar">
      <fieldset class="entry-modes"><legend class="sr-only">收支类型</legend>${directionChoices}</fieldset>
      <div class="entry-clock">
        <label class="entry-day"><span class="entry-day-text" aria-hidden="true">${dayText(at.slice(0, 10))}</span>${icon('down', 14)}
          <span class="sr-only">日期 · 东京时间</span>
          <input name="day" type="date" min="1900-01-01" max="9999-12-31" value="${at.slice(0, 10)}" required></label>
        <label><span class="sr-only">时间</span><input name="time" type="time" step="1" value="${at.slice(11)}" required></label>
      </div>
    </div>
    <div class="entry-amount">
      <span class="entry-symbol" aria-hidden="true">${currency === 'USD' ? '$' : currency ? '¥' : ''}</span>
      <label class="entry-amount-input"><span class="sr-only">金额</span>
        <input name="amount" inputmode="none" value="${escape(amount)}" autocomplete="off" maxlength="24" placeholder="0" required></label>
      <label class="entry-currency"><span class="sr-only">币种</span><select class="control" name="currency" required>${choices}</select></label>
    </div>
    <div class="fx" id="fx-preview" aria-live="polite"></div>
    <section class="entry-categories category-picker" aria-label="选择分类">
      <input type="hidden" name="category">
      <div class="entry-category-heading"><h3>分类</h3><span class="entry-category-name"></span></div>
      <div class="category-strip">
        <div id="entry-subcategories" class="category-children" role="group" aria-label="二级分类" hidden></div>
      </div>
      ${categoryAdder}
    </section></div>
    <div class="entry-footer">
    <div class="entry-note">
      <label><span class="sr-only">备注</span><textarea name="note" maxlength="500" rows="1" placeholder="填写备注">${escape(entry?.note ?? '')}</textarea></label>
      ${entry ? icoButton('delete-entry', 'trash', '删除流水', `data-value="${entry.id}"`) : ''}
    </div>
    ${errorPlaceholder}</div>
    ${keypad(entry || fromScreen)}</form>`, 'entry')
  const form = byId('entry-form')
  selectCategories(form, entry?.categoryId)
  updateEntryCurrency(form)
  refreshEntryQuote(form, !fromScreen)
  return form
}

function keypad(single) {
  const key = (value, glyph = '', label = '') => `<button class="key" type="button" data-action="entry-key" data-value="${value}"${label ? ` aria-label="${label}"` : ''}>${glyph ? icon(glyph, 20) : value}</button>`
  return `<div class="entry-keypad" aria-label="数字键盘">
    ${['7', '8', '9'].map(value => key(value)).join('')}${key('erase', 'erase', '删除一位')}
    ${['4', '5', '6'].map(value => key(value)).join('')}<button class="key key-clear" type="button" data-action="entry-key" data-value="clear">清空</button>
    ${['1', '2', '3'].map(value => key(value)).join('')}
    <button type="submit" class="key key-save" aria-label="保存流水">保存</button>
    ${single ? '<span></span>' : '<button class="key key-repeat" type="submit" value="repeat">再记一笔</button>'}
    ${key('0')}${key('.', '', '小数点')}
  </div>`
}

function updateEntryCurrency(form) {
  const code = form.elements.currency.value
  form.querySelector('.entry-symbol').textContent = code === 'USD' ? '$' : code ? '¥' : ''
  form.querySelector('[data-value="."]').disabled = code === 'JPY'
}

function pressEntryKey(form, value) {
  const input = form.elements.amount
  if (value === 'erase') input.value = input.value.slice(0, -1)
  else if (value === 'clear') input.value = ''
  else if (value === '.') {
    if (!input.value.includes('.')) input.value = (input.value || '0') + '.'
  } else if (input.value.length < input.maxLength && (input.value.split('.')[1]?.length ?? 0) < 2) {
    input.value = (input.value === '0' ? '' : input.value) + value
  }
  formError('')
  refreshEntryQuote(form, false)
}

function entryDraft(form) {
  const data = form.elements
  const at = dateTime(`${data.day.value}T${data.time.value}`)
  const currency = data.currency.value
  const minor = amountMinor(data.amount.value, currency)
  if (!at || !currency || minor === null || minor <= 0) return null
  const previous = state.entries.find(item => item.id === form.dataset.id)
  const sameAmount = previous?.currency === currency && previous?.minor === minor
  const sameDay = previous?.at.slice(0, 10) === at.slice(0, 10)
  const preserve = sameAmount && sameDay
  return withQuotes({
    at, currency, minor, direction: data.direction.value,
    categoryId: data.direction.value === 'transfer' ? null : data.category.value || null,
    note: data.note.value.trim(),
    settlementYen: sameAmount ? previous.settlementYen : null,
    sourceRate: sameAmount ? previous.sourceRate : null,
    sourceKey: previous?.sourceKey ?? null,
    yen: preserve ? previous.yen : null,
    yuan: preserve ? previous.yuan : null,
    fx: sameDay ? previous.fx : {}
  }, quotesFor(at.slice(0, 10)))
}

function openScreenGuide() {
  openDialog('配置 iPhone 快捷指令', `<div class="form-grid">
    <ol class="setup-steps">
      <li>在「快捷指令」新建「小日账·屏幕记账」，依次添加「截屏」（Take Screenshot）、「从图像提取文本」（Extract Text from Image）、「拷贝至剪贴板」（Copy to Clipboard）、「前往主屏幕」（Go to Home Screen）。中间两步分别使用上一步的结果。</li>
      <li>在 iPhone「设置」进入「辅助功能」→「触控」→「轻点背面」→「轻点两下」，选择这个快捷指令。</li>
      <li>在付款或收款详情上轻点背面两下，打开小日账，点「粘贴屏幕账单」或右上角扫描图标，即可进入记账面板。如果 iPhone 提示确认粘贴，点系统的「粘贴」。</li>
      <li>支持快捷指令输出「时间：」「金额：」「备注：」三行，也可以粘贴原始截屏文字。核对已填内容和币种后点「保存」。</li>
    </ol>
    <div class="form-footer">
      <a class="button leading" href="shortcuts://create-shortcut">打开快捷指令</a>
      ${button('screen-paste', '开始截屏记账')}
    </div></div>`)
}

function showScreenPaste(form, screen, offerManualPaste) {
  form.querySelector('#screen-entry-notice').innerHTML = screenNotice(screen)
  form.querySelector('#screen-entry-fallback').hidden = !offerManualPaste
}

function applyScreenText(form, text) {
  const draft = parseScreenText(text)
  const data = form.elements
  const priorDirection = data.direction.value
  if (draft.amount || draft.direction === 'income') data.direction.value = draft.direction
  if (draft.amount) data.amount.value = draft.amount
  if (draft.amount || draft.currency) data.currency.value = draft.currency ?? ''
  if (draft.note) data.note.value = draft.note.slice(0, data.note.maxLength)
  if (draft.at) {
    data.day.value = draft.at.slice(0, 10)
    data.time.value = draft.at.slice(11)
    form.querySelector('.entry-day-text').textContent = dayText(data.day.value)
  }
  const categoryId = draft.amount || draft.note ? suggestCategory(draft, text, state.entries, state.categories) : null
  if (categoryId || priorDirection !== data.direction.value) selectCategories(form, categoryId)
  showScreenPaste(form, draft, !draft.amount)
  if (draft.amount) form.querySelector('#screen-entry-text').value = ''
  updateEntryCurrency(form)
  refreshEntryQuote(form, Boolean(draft.amount))
}

async function pasteFromScreen() {
  const form = openEntry(null, { fromScreen: true })
  const initial = new FormData(form)
  let text = ''
  // Start the clipboard read in the same click, while the browser still has user activation.
  try { text = await navigator.clipboard?.readText?.() ?? '' } catch { /* The browser may refuse clipboard access. */ }
  if (!dialog.open || byId('entry-form') !== form || form.dataset.saving) return
  if (!text.trim()) { showScreenPaste(form, { status: 'unread' }, true); return }
  const current = new FormData(form)
  if (form.querySelector('.category-adder:not([hidden])') || [...initial].some(([name, value]) => current.get(name) !== value)) {
    showScreenPaste(form, { status: 'edited' }, true)
    return
  }
  applyScreenText(form, text)
}

function hidePaste() {
  clearTimeout(pasteTimer)
  byId('quick-paste').hidden = true
}

function offerPaste() {
  if (!phone || dialog.open || state.selecting) return
  byId('quick-paste').hidden = false
  clearTimeout(pasteTimer)
  pasteTimer = setTimeout(hidePaste, 12000)
}

function quotePreview(form) {
  const text = byId('fx-preview')
  text.hidden = !form.elements.amount.value.trim()
  if (text.hidden) return
  const draft = entryDraft(form)
  const selected = form.elements.currency.value
  if (!selected) {
    text.textContent = '选择币种后查看换算'
    return
  }
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

function settingsPage() {
  const row = (action, glyph, label) => `<button class="settings-row" type="button" data-action="${action}">
    ${icon(glyph, 19)}<span>${label}</span>${icon('right', 15)}</button>`
  return `<div class="page-heading"><h1>设置</h1></div>
    <div class="settings-grid">
      <section class="panel settings-panel"><h2>数据与备份</h2>
        <p class="fine">账本保存在当前设备。完整备份包含流水、分类和汇总币种。</p>
        <div class="settings-rows">${row('export-backup', 'download', '导出完整备份')}${row('pick-backup', 'upload', '恢复备份')}</div>
      </section>
      <section class="panel settings-panel"><h2>屏幕记账</h2>
        <div class="settings-rows">${row('screen-guide', 'scan', '配置屏幕记账')}</div>
      </section>
      <section class="panel settings-panel"><h2>应用与离线</h2>
        <p class="fine" id="settings-offline">${offlineDescription()}</p>
        ${standalone ? '' : '<p class="fine">在 iPhone 的 Safari 里轻点「分享」→「添加到主屏幕」，开启「作为 Web App 打开」。</p>'}
      </section>
    </div>`
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
  main.append(a)
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
  // Offered above and below the rows so a long preview never needs scrolling just to import.
  const confirm = button('confirm-import', `导入 ${counts.ready} 笔有效流水`, counts.ready ? '' : 'disabled', '', 'primary')
  return `<section class="import-preview"><div class="import-top"><div class="import-counts">
    <span class="chip">待导入 ${counts.ready}</span><span class="chip">重复 ${counts.duplicate}</span><span class="chip">有问题 ${counts.invalid}</span></div>
    ${rows.length ? confirm : ''}</div>
    <div>${rows.slice(0, importState.limit).map(({ number, entry, duplicate, error }) => {
      if (!entry) return `<div class="import-row"><span>第 ${number} 行</span><span class="form-error">${escape(error)}</span></div>`
      const direction = importState.overrides.get(number) ?? entry.direction
      const meta = `第 ${number} 行 · ${entry.at.replace('T', ' ')} · ${money(entry.minor, entry.currency)} ${entry.currency}`
      return `<div class="import-row"><div><strong>${escape(entry.note || directions[entry.direction])}</strong><small>${meta}</small></div>
        ${duplicate ? '<span class="chip">重复</span>' : `<select class="control" aria-label="第 ${number} 行收支类型" data-import-row="${number}">
        ${directionsFor(direction).map(([id, label]) => option(id, label, direction)).join('')}</select>`}</div>`
    }).join('')}</div>
    ${!rows.length ? '<p class="fine">这张表只有表头。</p>' : ''}
    <div class="form-footer">${rows.length > importState.limit ? button('more-import', '显示更多', '', '', 'leading') : ''}
    ${confirm}</div></section>`
}

function openImport() {
  const items = importState.file.sheetNames
  const statement = importState.table && statementColumns(importState.table.headers)
  openDialog('导入账单', `<div class="form-grid">
    <div class="import-headline"><strong>${escape(importState.file.name)}</strong>${statement ? '<span class="chip">已识别日文账单</span>' : ''}</div>
    ${items.length ? selectField('工作表', 'sheet', items.map(name => option(name, name, importState.sheet)).join('')).replace('name="sheet"', 'id="sheet" name="sheet"') : ''}
    ${errorPlaceholder}
    ${importState.table && !statement ? importMapping() : ''}
    ${importPreview()}</div>`, 'wide')
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

async function confirmImport() {
  // Recompute from the current mapping so a changed select never imports an old preview.
  if (byId('map-form')?.dataset.dirty) { formError('列映射已更改，请重新预览。'); return }
  if (importState.saving) return
  importState.saving = true
  const controls = [...dialog.querySelectorAll('[data-action="confirm-import"]')]
  controls.forEach(item => { item.disabled = true })
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
      resetLedgerFilters()
      go('home', true)
    }
    toast(`已导入 ${added} 笔流水`)
    await refreshRates()
  } finally {
    importState.saving = false
    controls.forEach(item => { item.disabled = false })
  }
}

async function submitEntry(form, control) {
  const entry = entryDraft(form)
  if (!entry) { formError('请输入有效日期和正数金额（日元为整数，人民币和美元最多两位小数）。'); return }
  const previous = state.entries.find(item => item.id === form.dataset.id)
  const id = previous?.id ?? crypto.randomUUID()
  const createdAt = previous?.createdAt ?? new Date().toISOString()
  const repeat = !previous && control?.value === 'repeat'
  await saveEntry({ ...entry, id, createdAt })
  if (!repeat) dialog.close()
  if (!previous && !within(entry, period())) {
    state.month = entry.at.slice(0, 7)
    state.range = null
    clearDrill()
  }
  await reload()
  if (repeat && dialog.open && byId('entry-form') === form) openEntry()
  toast(previous ? '流水已更新' : '流水已保存')
  await refreshRates()
}

async function saveCategoryDraft(parentId, direction, value, chosenIcon, previous) {
  const name = value === previous?.name ? value : value.normalize('NFKC').trim()
  if (!name || name.length > 24) return { error: '请输入 1 到 24 个字符的名称。' }
  const parent = state.categories.find(item => item.id === parentId)
  const icon = iconNames.has(chosenIcon) ? chosenIcon : startingIcon(previous ?? parent)
  const category = { id: previous?.id ?? crypto.randomUUID(), parentId, direction, name, icon }
  const result = await saveCategory(category, { editing: Boolean(previous) })
  if (result === 'duplicate') return { error: '同级分类中已有这个名称。' }
  if (result === 'missing') return { error: '分类已不存在，请关闭后重试。' }
  return { id: category.id }
}

async function submitCategory(form) {
  const previous = state.categories.find(item => item.id === form.dataset.id)
  if (form.dataset.id && !previous) { formError('分类已不存在，请关闭后重试。'); return }
  const direction = form.dataset.direction || form.elements.direction.value
  const result = await saveCategoryDraft(form.dataset.parent || null, direction, form.elements.name.value, form.dataset.icon, previous)
  if (result.error) { formError(result.error); return }
  state.categoryDirection = direction
  dialog.close()
  await reload()
  main.querySelector(`[data-action="category-edit"][data-value="${CSS.escape(result.id)}"]`)?.focus({ preventScroll: true })
  toast('分类已保存')
}

async function deleteCategoryFromForm(control) {
  const form = control.form
  if (form.dataset.saving) return
  const category = state.categories.find(item => item.id === form.dataset.id)
  if (!category) return
  const childrenNotice = category.parentId === null ? '其下的所有二级分类也会一并删除。\n' : ''
  if (!confirm(`删除「${category.name}」？\n${childrenNotice}相关流水会保留，并归为「未分类」。`)) return

  form.dataset.saving = 'true'
  control.disabled = true
  try {
    const result = await deleteCategory(category.id)
    if (result?.removedIds.includes(state.ledgerCategory)) state.ledgerCategory = null
    await reload()
    if (byId('category-form') === form && dialog.open) dialog.close()
    const message = result ? '分类已删除' : '分类已不存在'
    toast(result?.uncategorized ? `${message}，${result.uncategorized} 笔流水已归为未分类` : message)
  } finally {
    delete form.dataset.saving
    control.disabled = false
  }
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
  navigate: ({ value, focus }) => {
    resetLedgerFilters()
    go(value, focus === 'ledger')
  },
  add: () => openEntry(),
  edit: ({ value }) => openEntry(value),
  'entry-key': ({ value }) => pressEntryKey(byId('entry-form'), value),
  'entry-category': ({ value }, control) => {
    const form = byId('entry-form')
    const group = control.parentElement
    const opensChildren = control.getAttribute('aria-expanded') === 'false'
    selectCategories(form, value)
    const selected = Array.from(group.children).find(item => item.dataset.value === value)
    selected?.focus({ preventScroll: true })
    if (selected?.getAttribute('aria-expanded') === 'true') {
      selected.scrollIntoView({ block: 'nearest' })
      const panel = byId('entry-subcategories')
      panel.firstElementChild.scrollIntoView({ block: 'nearest' })
      if (opensChildren && allowsMotion.matches) {
        panel.animate([{ opacity: .55, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' })
      }
    }
  },
  'screen-paste': pasteFromScreen,
  'dismiss-paste': hidePaste,
  'screen-guide': openScreenGuide,
  'delete-entry': async ({ value }) => {
    if (!confirm('删除这笔流水？')) return
    await deleteEntry(value)
    dialog.close()
    await reload()
    toast('流水已删除')
  },
  'select-mode': () => {
    const starting = !state.selecting
    stopSelecting()
    state.selecting = starting
    hidePaste()
    refreshLedgerResults()
  },
  'toggle-select': ({ value }, control) => {
    if (!state.selected.delete(value)) state.selected.add(value)
    control.setAttribute('aria-pressed', String(state.selected.has(value)))
    selectionBar()
  },
  'select-all': () => {
    const rows = pickRows()
    const all = rows.every(row => state.selected.has(row.dataset.value))
    for (const row of rows) {
      if (all) state.selected.delete(row.dataset.value)
      else state.selected.add(row.dataset.value)
      row.setAttribute('aria-pressed', String(!all))
    }
    selectionBar()
  },
  'delete-selected': async (_, control) => {
    const ids = [...state.selected]
    if (!ids.length || !confirm(`删除选中的 ${ids.length} 笔流水？删除后无法恢复。`)) return
    control.disabled = true
    await deleteEntries(ids)
    stopSelecting()
    await reload()
    toast(`已删除 ${ids.length} 笔流水`)
  },
  'category-new': ({ value }) => openCategoryForm({ parentId: value }),
  'category-edit': ({ value }) => openCategoryForm({ categoryId: value }),
  'category-delete': (_, control) => deleteCategoryFromForm(control),
  'category-add': ({ value }, control) => openCategoryAdder(control.closest('.category-picker'), value),
  'pick-icon': ({ value }, control) => {
    const holder = control.closest('[data-icon-holder]')
    holder.dataset.icon = value
    for (const choice of control.parentElement.children) choice.setAttribute('aria-checked', String(choice === control))
  },
  'category-add-cancel': (_, control) => { control.closest('.category-adder').hidden = true },
  'category-add-save': (_, control) => saveInlineCategory(control.closest('.category-picker')),
  'category-direction': ({ value }) => { state.categoryDirection = value; render() },
  'stats-direction': ({ value }) => { state.statsDirection = value; render() },
  'trend-page': ({ value }) => { state.trendPage = Number(value); render() },
  'ledger-search-toggle': () => setLedgerSearchOpen(!state.ledgerSearchOpen),
  'ledger-categories-toggle': () => setLedgerCategoriesOpen(!state.ledgerCategoriesOpen),
  'ledger-categories-close': () => setLedgerCategoriesOpen(false),
  'ledger-category-pick': ({ value }, control) => {
    state.ledgerCategory = value === '*' ? null : value
    state.ledgerLimit = 60
    if (control.hasAttribute('aria-expanded')) {
      refreshLedgerCategories()
      const active = byId('ledger-category-options').querySelector('[aria-expanded="true"]')
      active?.focus({ preventScroll: true })
      byId('ledger-filter-children')?.firstElementChild?.scrollIntoView({ block: 'nearest' })
    } else setLedgerCategoriesOpen(false)
    refreshLedgerResults()
  },
  'ledger-direction': ({ value }, control) => {
    if (state.ledgerDirection === value) return
    state.ledgerDirection = value
    const category = state.categories.find(item => item.id === state.ledgerCategory)
    if (category && value !== 'all' && category.direction !== value) state.ledgerCategory = null
    state.ledgerLimit = 60
    for (const tab of control.parentElement.children) tab.setAttribute('aria-pressed', String(tab === control))
    refreshLedgerCategories()
    refreshLedgerResults()
  },
  'more-ledger': () => { state.ledgerLimit += 60; refreshLedgerResults() },
  'clear-drill': (_, control) => {
    state.ledgerDay = null
    state.ledgerLimit = 60
    if (document.activeElement === control) byId('ledger-title').focus({ preventScroll: true })
    control.remove()
    refreshLedgerResults()
  },
  'search-scope': () => { state.searchAll = !state.searchAll; state.ledgerLimit = 60; refreshLedgerResults() },
  'bulk-category': openBulkCategory,
  'bulk-direction': ({ value }) => { bulk.direction = value; bulk.categoryId = undefined; renderBulkCategory() },
  'bulk-pick': ({ value }) => { bulk.categoryId = value || null; renderBulkCategory() },
  'bulk-apply': (_, control) => applyBulkCategory(control),
  'drill-day': ({ start, end }) => {
    resetLedgerFilters()
    state.ledgerDay = { start, end }
    go('home', true)
  },
  'drill-category': ({ value }) => {
    resetLedgerFilters()
    state.ledgerCategory = value
    state.ledgerDirection = state.statsDirection
    go('home', true)
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
  'confirm-import': () => confirmImport(),
  'export-backup': exportBackup,
  'pick-backup': () => pickFile('file-backup'),
  'confirm-restore': async (_, control) => {
    control.disabled = true
    try {
      await restoreLedger(pendingBackup)
      pendingBackup = null
      dialog.close()
      await reload()
      resetLedgerFilters()
      if (state.entries.length) state.month = state.entries[0].at.slice(0, 7)
      state.range = null
      go('home')
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

const forms = {
  'entry-form': submitEntry, 'category-form': submitCategory, 'period-form': submitPeriod, 'map-form': mappingSubmit
}
dialog.addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  if (form.dataset.saving) return
  form.dataset.saving = 'true'
  const control = event.submitter
  if (control) control.disabled = true
  try {
    formError('')
    await forms[form.id]?.(form, control)
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
  if (control.name === 'direction') selectCategories(form)
  if (control.name === 'day') form.querySelector('.entry-day-text').textContent = dayText(control.value)
  if (control.name === 'currency') updateEntryCurrency(form)
  if (['currency', 'day', 'time'].includes(control.name)) refreshEntryQuote(form, control.name !== 'time')
})

dialog.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !event.target.matches('.category-adder input')) return
  // Enter must not submit the entry; while an IME is composing it only confirms the text.
  event.preventDefault()
  if (!event.isComposing && event.keyCode !== 229) saveInlineCategory(event.target.closest('.category-picker')).catch(handleError)
})

// The date chip shows its own text over an invisible native input; mouse users need the picker opened for them.
dialog.addEventListener('click', event => {
  if (!event.target.matches('.entry-day input') || !matchMedia('(pointer: fine)').matches) return
  try { event.target.showPicker() } catch { /* Older browsers fall back to the focused input. */ }
})

dialog.addEventListener('input', event => {
  const control = event.target
  if (control.form?.id === 'entry-form' && control.name === 'day') control.form.querySelector('.entry-day-text').textContent = dayText(control.value)
  if (control.form?.id === 'entry-form' && control.name === 'amount') refreshEntryQuote(control.form, false)
})

dialog.addEventListener('paste', event => {
  const input = event.target
  if (input.id !== 'screen-entry-text') return
  const text = event.clipboardData?.getData('text/plain')
  if (!text?.trim()) return
  event.preventDefault()
  input.value = text.slice(0, screenTextLimit)
  applyScreenText(input.form, text)
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
  if (document.hidden) { hiddenAt = Date.now(); hidePaste(); return }
  // Coming back from another app usually means a shortcut just copied a payment screen.
  if (Date.now() - hiddenAt > 1500) offerPaste()
  reload().then(() => refreshRates()).catch(handleError)
})
document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || dialog.open) return
  if (event.key === 'Escape') {
    if (state.ledgerSearchOpen && ['ledger-search', 'ledger-search-toggle'].includes(event.target.id)) {
      event.preventDefault()
      setLedgerSearchOpen(false)
    } else if (state.ledgerCategoriesOpen && (event.target.id === 'ledger-category-toggle' || byId('ledger-category-picker')?.contains(event.target))) {
      setLedgerCategoriesOpen(false)
    } else if (state.selecting) { stopSelecting(); refreshLedgerResults() }
  }
  // Search runs as you type; Enter just puts the phone keyboard away.
  if (event.key === 'Enter' && event.target.id === 'ledger-search') event.target.blur()
})

main.addEventListener('input', event => {
  if (event.target.id !== 'ledger-search') return
  state.ledgerQuery = event.target.value
  state.ledgerLimit = 60
  refreshLedgerResults()
})

document.addEventListener('pointerdown', event => {
  if (!byId('quick-paste').hidden && !event.target.closest('#quick-paste')) hidePaste()
})
setInterval(() => {
  if (!document.hidden && navigator.onLine) refreshRates().catch(handleError)
}, 5 * 60 * 1000)

async function start() {
  byId('quick-paste').innerHTML = `<button type="button" class="quick-paste-main" data-action="screen-paste">${icon('scan', 18)}粘贴屏幕账单</button>
    <button type="button" class="quick-paste-close" data-action="dismiss-paste" aria-label="关闭">${icon('close', 16)}</button>`
  try {
    await reload()
    offerPaste()
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
