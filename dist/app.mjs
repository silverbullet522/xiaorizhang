import {
  amountExpressionMinor, amountMinor, dateTime, directions, duplicatePreviews, importRows, money, monthBounds, offsetDate, planBackupRestore, statementColumns,
  restorePlanSignature, summarize, tokyoNow, withQuotes, within
} from './core.mjs'
import {
  addEntries, backupDocument, clearLedger, completeRates, deleteCategory, deleteEntries, deleteEntriesInRange, deleteEntry, readLedger, restoreLedger,
  deleteFeature, postBill, saveCategory, saveCurrency, saveEntries, saveEntry, saveFeature, validateBackup
} from './storage.mjs'
import { clearQuoteCache, loadQuotes, quotesFor } from './rates.mjs'
import {
  authorizeDrive, configureDrive, driveEvents, driveStatus, initializeDrive, pauseDrive, prepareGoogle, queueDriveSync, syncDriveNow
} from './drive-sync.mjs'
import { guessColumns, readFile } from './tables.mjs'
import { allowsMotion, animateCategory, playMotion, readMeters, transitionMeters } from './motion.mjs'
import { billCycles, billKey, budgetUsage, emptyFeatures, findMerchantRule, firstUnpostedDate, ledgerCsv, nextFutureBillDate } from './features.mjs'
import { categoryName, directionLabel, formatDate, initializeLanguage, language, languageOptions, saveLanguage, t } from './i18n.mjs'
import { iconAliases, iconChoices, iconNames } from './icons.mjs'
import { createCategorySuggester, likelyDuplicate, parseScreenText, screenTextLimit, suggestCategory } from './screen.mjs'
import {
  brand, breakdown, button, categoryArt, currencyOptions, dayLabel, emptyLedger, escape, icoButton, icon,
  meterFill, option, periodDisplay, summaryCards, tabs, transaction, trend
} from './ui.mjs'

const byId = id => document.getElementById(id)
const main = byId('main')
const dialog = byId('dialog')
const state = {
  entries: [], categories: [], features: emptyFeatures(), currency: 'JPY', view: 'home', month: tokyoNow().slice(0, 7),
  range: null, ledgerDay: null, ledgerDirection: 'all', ledgerCategory: null, ledgerLimit: 60,
  statsDirection: 'expense', categoryDirection: 'expense', trendPage: 0,
  selecting: false, selected: new Set(), ledgerQuery: '', searchAll: false, ledgerSearchOpen: false, ledgerCategoriesOpen: false, budgetExpanded: false
}
const viewNames = { home: ['账本', 'ledger'], overview: ['报表', 'chart'], categories: ['分类', 'tag'], settings: ['设置', 'settings'] }
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const phone = standalone || matchMedia('(pointer: coarse)').matches
let importState
let hiddenAt = 0
let pasteTimer
let bulk
let pendingBackup
let noticeTimer
let ratesTask
let offlineReady = Boolean(navigator.serviceWorker?.controller)
let swipedRow = null
let entrySwipe = null
let ignoreSwipeClick = false

function toast(message, success = false) {
  clearTimeout(noticeTimer)
  const notice = byId('notice')
  notice.textContent = message
  notice.classList.toggle('has-feedback', success)
  if (success) {
    notice.insertAdjacentHTML('afterbegin', icon('check', 18))
    playMotion(notice.firstElementChild, [{ opacity: .2, transform: 'scale(.68)' }, { opacity: 1, transform: 'scale(1)' }], 190)
  }
  noticeTimer = setTimeout(() => { notice.textContent = '' }, 3200)
}

function formError(message) {
  const error = dialog.querySelector('.form-error')
  if (error) error.textContent = message
  else toast(message)
}

function period() { return state.range ?? monthBounds(state.month) }
const byName = (a, b) => categoryName(a).localeCompare(categoryName(b), language)
const parentOrder = ['food', 'travel', 'shopping', 'home', 'living', 'comm', 'fun', 'health', 'beauty', 'learn',
  'social', 'family', 'pet', 'car', 'misc', 'salary', 'extra', 'invest']
const priority = item => parentOrder.includes(item.id) ? parentOrder.indexOf(item.id) : parentOrder.length
const topCategories = direction => state.categories.filter(item => item.direction === direction && item.parentId === null)
  .sort((a, b) => priority(a) - priority(b) || byName(a, b))
const children = id => id ? state.categories.filter(item => item.parentId === id).sort(byName) : []
const categoryTile = (item, active, action, disclosure = '') => `<button type="button" class="entry-cat" aria-pressed="${active}"${disclosure} data-action="${action}" data-value="${escape(item.id)}">
    ${categoryArt(item.icon, 27, item.name)}<span>${escape(categoryName(item))}</span></button>`

const offlineDescription = () => offlineReady ? t('应用已准备就绪，可离线记账。') : t('首次联网打开时会准备离线应用。')

function navLink(view) {
  const [label, glyph] = viewNames[view]
  const active = state.view === view ? 'aria-current="page"' : ''
  return `<button class="nav-link" data-action="navigate" data-value="${view}" ${active} type="button">${icon(glyph, 19)}${t(label)}</button>`
}

function chrome() {
  const status = navigator.onLine ? (offlineReady ? t('本机账本 · 可离线使用') : t('本机账本')) : t('离线模式')
  byId('sidebar').innerHTML = `${brand('sidebar-brand')}<nav class="side-nav">${Object.keys(viewNames).map(navLink).join('')}</nav>
    <div class="side-foot"><div class="side-status"><span class="dot ${navigator.onLine ? '' : 'off'}"></span>${status}</div></div>`
  byId('topbar').innerHTML = `${brand('mobile-brand')}
    <div class="top-actions">${icoButton('screen-paste', 'scan', t('粘贴屏幕账单'))}
    ${icoButton('pick-import', 'upload', t('导入账单'))}
    <span class="desktop-add">${button('add', t('记一笔'), '', 'plus', 'primary')}</span></div>`
  const mobileNav = byId('mobile-nav')
  // Keep the buttons mounted so their active color and icon can transition.
  if (mobileNav.dataset.language !== language) {
    mobileNav.innerHTML = `${navLink('home')}${navLink('overview')}
      <button class="mobile-add" type="button" data-action="add" aria-label="${t('记一笔')}">${icon('plus', 26)}</button>
      ${navLink('categories')}${navLink('settings')}`
    mobileNav.dataset.language = language
  }
  for (const link of mobileNav.querySelectorAll('.nav-link')) {
    if (link.dataset.value === state.view) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  const offline = byId('settings-offline')
  if (offline) offline.textContent = offlineDescription()
}

const periodControls = () => `<div class="filter-actions">${periodDisplay(state.range, state.month)}${tabs('currency', { JPY: 'JPY', CNY: 'CNY' }, state.currency)}</div>`
const pendingBanner = count => count
  ? `<div class="banner"><span>${t('当前金额为已换算小计，{0} 笔待换算。', count)}</span><button type="button" data-action="retry-rates" class="plain">${t('刷新汇率')}</button></div>`
  : ''

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
    const label = day === today ? t('今天') : day === yesterday ? t('昨天') : formatDate(day, 'weekday')
    const totals = [
      sums.expense && t('支 {0}', money(sums.expense, state.currency)),
      sums.income && t('收 {0}', money(sums.income, state.currency)),
      sums.pending && t('待换算')
    ].filter(Boolean)
    cards.push(`<article class="day-card">
      <header class="day-head">
        <h3 aria-label="${dayLabel(day)}"><time datetime="${day}">${formatDate(day, 'short')}</time><span>${label}</span></h3>
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
  const month = formatDate(state.month, 'monthOnly')
  const thisMonth = state.month === today.slice(0, 7)
  const periodLabels = state.range ? [t('区间支出'), t('区间收入'), t('区间净收支')]
    : thisMonth ? [t('本月支出'), t('本月收入'), t('本月净收支')]
      : [t('{0}支出', month), t('{0}收入', month), t('{0}净收支', month)]
  const entries = state.entries.filter(entry => within(entry, active))
  const totals = summarize(entries, state.currency)
  const daily = summarize(state.entries.filter(entry => entry.at.startsWith(today)), state.currency)
  const reminder = billsPanel()
  return `<div class="page-heading book-heading"><h1>${t('账本')}</h1>${periodControls()}</div>
    <div class="book-layout">
      <div class="book-digest">
        <section class="digest" aria-label="${t('收支摘要')}">
          <div class="digest-today"><div><h2>${t('今日支出')}</h2>
            ${daily.pending ? `<small>${t('{0} 笔待换算', daily.pending)}</small>` : ''}</div>
            <strong>${money(daily.expense, state.currency)}</strong></div>
          <dl class="digest-stats">
            <div><dt>${periodLabels[0]}</dt><dd>${money(totals.expense, state.currency)}</dd></div>
            <div><dt>${periodLabels[1]}</dt><dd>${money(totals.income, state.currency)}</dd></div>
            <div><dt>${periodLabels[2]}</dt><dd>${money(totals.net, state.currency)}</dd></div>
          </dl>
        </section>
        ${pendingBanner(totals.pending)}
        ${reminder ? `<div class="due-slot">${reminder}</div>` : ''}${budgetPanel()}
      </div>
      <section class="book-activity" aria-labelledby="ledger-title">
        <div class="activity-head"><h2 id="ledger-title" tabindex="-1">${t('流水')}</h2>
          ${icoButton('ledger-search-toggle', 'search', state.ledgerSearchOpen ? t('关闭搜索') : t('搜索流水'),
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
  return `<div class="page-heading report-heading"><h1>${t('报表')}</h1>${periodControls()}</div>
    ${summaryCards(totals, state.currency, counts)}${pendingBanner(totals.pending)}
    <div class="dashboard-grid">${trend(totals, range, state.currency, state.trendPage)}${breakdown(entries, state.categories, state.statsDirection, state.currency)}</div>
    <section class="panel"><div class="panel-head"><h2>${t('近期流水')}</h2><button class="plain" type="button" data-action="navigate" data-value="home" data-focus="ledger">${t('查看全部')}</button></div>
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
    const parent = lookup.get(category?.parentId)
    const text = searchText([entry.note, categoryName(category), categoryName(parent), category?.name, parent?.name].join(' '))
    return terms.every(term => text.includes(term))
  })
}

function ledgerCategoryButtonContent() {
  const selected = state.categories.find(item => item.id === state.ledgerCategory)
  const label = categoryName(selected) || (state.ledgerCategory === '' ? t('未分类') : t('全部分类'))
  return `<span class="sr-only">${t('筛选分类，当前：')}</span>${selected ? categoryArt(selected.icon, 17, selected.name) : icon('tag', 17)}
    <span class="ledger-category-label">${escape(label)}</span>${icon('down', 14)}`
}

function categoryChoiceGroups(shown, selectedId, action, childrenId) {
  const selected = state.categories.find(item => item.id === selectedId)
  const rootId = selected?.parentId ?? selected?.id
  const parentIds = new Set(state.categories.map(item => item.parentId))
  const pick = (item, active, disclosure) => categoryTile(item, active, action, disclosure)
  return shown.map(direction => {
    const roots = topCategories(direction)
    if (!roots.length) return ''
    const root = roots.find(item => item.id === rootId)
    const kids = root ? children(root.id) : []
    return `<div class="ledger-picker-group">
      ${shown.length > 1 ? `<h3>${directionLabel(direction)}</h3>` : ''}
      <div class="category-strip" role="group" aria-label="${t('{0}一级分类', directionLabel(direction))}">
        ${roots.map(item => pick(item, item.id === rootId, parentIds.has(item.id) ? ` aria-expanded="${item.id === rootId}"` : '')).join('')}
        ${kids.length ? `<div id="${childrenId}" class="category-children" role="group" aria-label="${t('{0}的二级分类', escape(categoryName(root)))}">
          ${kids.map(item => pick(item, item.id === selectedId)).join('')}</div>` : ''}
      </div></div>`
  }).join('')
}

function ledgerCategoryChoices() {
  const shown = state.ledgerDirection === 'all' ? ['expense', 'income'] : [state.ledgerDirection]
  const shortcuts = [
    categoryTile({ id: '*', name: t('全部分类'), icon: 'shapes' }, state.ledgerCategory === null, 'ledger-category-pick'),
    categoryTile({ id: '', name: t('未分类'), icon: 'tag' }, state.ledgerCategory === '', 'ledger-category-pick')
  ].join('')
  return `<div class="category-strip" role="group" aria-label="${t('快捷分类')}">${shortcuts}</div>
    ${categoryChoiceGroups(shown, state.ledgerCategory, 'ledger-category-pick', 'ledger-filter-children')}`
}

function ledgerResults() {
  const filtered = ledgerEntries()
  const sums = summarize(filtered, state.currency)
  const wide = searching() && !state.ledgerDay
  const scopeName = state.range ? t('所选区间') : formatDate(state.month, 'monthOnly')
  const parts = [t('{0}{1} 笔', wide && state.searchAll ? t('全部时间 · ') : '', filtered.length),
    sums.expense && t('支出 {0}', money(sums.expense, state.currency)), sums.income && t('收入 {0}', money(sums.income, state.currency))].filter(Boolean)
  return `<div class="result-head"><p>${parts.join(' · ')}
      ${wide ? `<button type="button" class="plain" data-action="search-scope">${state.searchAll ? t('只搜{0}', scopeName) : t('搜索全部时间')}</button>` : ''}</p>
    ${filtered.length || state.selecting ? `<button class="plain" type="button" data-action="select-mode">${state.selecting ? t('完成') : t('选择')}</button>` : ''}</div>
    <div class="day-stack">${dayCards(filtered)}</div>
    ${filtered.length > state.ledgerLimit ? button('more-ledger', t('显示更多')) : ''}`
}

function ledgerTools() {
  const day = state.ledgerDay
  return `<div class="ledger-tools">
      <div id="ledger-search-field"${state.ledgerSearchOpen ? '' : ' hidden'}><label class="search-field"><span class="sr-only">${t('搜索备注或分类')}</span>
        <input id="ledger-search" type="search" value="${escape(state.ledgerQuery)}" placeholder="${t('搜索备注或分类')}" enterkeyhint="search" autocomplete="off" spellcheck="false"></label></div>
      <div class="ledger-filter">${tabs('ledger-direction', { all: t('全部'), expense: directionLabel('expense'), income: directionLabel('income') }, state.ledgerDirection)}
        <button type="button" id="ledger-category-toggle" class="ledger-category-toggle" data-action="ledger-categories-toggle"
          aria-controls="ledger-category-picker" aria-expanded="${state.ledgerCategoriesOpen}">${ledgerCategoryButtonContent()}</button></div>
      <section id="ledger-category-picker" class="ledger-category-picker" aria-labelledby="ledger-picker-title"${state.ledgerCategoriesOpen ? '' : ' hidden'}>
        <div class="ledger-picker-head"><h3 id="ledger-picker-title">${t('选择分类')}</h3>${button('ledger-categories-close', t('完成'), '', '', 'subtle')}</div>
        <div id="ledger-category-options" class="ledger-category-options">${state.ledgerCategoriesOpen ? ledgerCategoryChoices() : ''}</div>
      </section>
      ${day ? `<button class="filter-tag" type="button" data-action="clear-drill" aria-label="${t('清除日期筛选')}">${escape(day.start === day.end ? dayLabel(day.start) : `${day.start} ～ ${day.end}`)} ×</button>` : ''}
    </div>`
}

// Refresh only the list so the search box keeps focus and any IME composition in progress.
function refreshLedgerResults() {
  const results = byId('ledger-results')
  if (!results) { render(); return }
  resetEntrySwipe()
  results.innerHTML = ledgerResults()
  syncSelection()
}

function setLedgerSearchOpen(open) {
  state.ledgerSearchOpen = open
  const trigger = byId('ledger-search-toggle')
  const input = byId('ledger-search')
  const label = open ? t('关闭搜索') : t('搜索流水')
  trigger.setAttribute('aria-expanded', String(open))
  trigger.setAttribute('aria-label', label)
  trigger.title = label
  const field = byId('ledger-search-field')
  const from = field.hidden ? 0 : field.getBoundingClientRect().height
  field.hidden = false
  field.inert = !open
  const to = open ? field.firstElementChild.getBoundingClientRect().height : 0
  const animation = playMotion(field, [
    { height: `${from}px`, overflow: 'hidden', opacity: from ? 1 : .1 },
    { height: `${to}px`, overflow: 'hidden', opacity: open ? 1 : 0 }
  ], 170)
  if (!open) {
    const hide = () => { if (!state.ledgerSearchOpen) field.hidden = true }
    if (animation) animation.finished.then(hide, hide)
    else hide()
  }
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
  const editCategoryButton = (item, className, size, affordance) => `<button type="button" class="${className}" data-action="category-edit" data-value="${escape(item.id)}" aria-label="${t('编辑{0}', escape(categoryName(item)))}">
    ${categoryArt(item.icon, size, item.name)}<span class="category-edit-name">${escape(categoryName(item))}</span>${icon(affordance, 15)}</button>`
  const groups = topCategories(direction).map(item => {
    const tags = children(item.id).map(child => editCategoryButton(child, 'child-category', 18, 'right')).join('')
    return `<section class="panel category-group"><div class="group-head"><h2>${editCategoryButton(item, 'group-title', 23, 'pencil')}</h2>
      ${icoButton('category-new', 'plus', t('新增二级分类'), `data-value="${escape(item.id)}"`)}</div>
      ${tags ? `<div class="category-rows">${tags}</div>` : ''}</section>`
  })
  return `<div class="page-heading"><h1>${t('分类')}</h1>
    <div class="filter-actions">${tabs('category-direction', { expense: t('支出'), income: t('收入') }, direction)}
    ${button('category-new', t('新增一级分类'), '', 'plus', 'primary')}</div></div>
    ${groups.length ? `<div class="groups">${groups.join('')}</div>` : `<p class="panel fine">${t('还没有{0}分类', directionLabel(direction))}</p>`}`
}

function render() {
  const previousMeters = main.dataset.view === state.view ? readMeters(main) : null
  const previousReminder = allowsMotion.matches && state.view === 'home' && main.dataset.view === 'home'
    ? main.querySelector('.due-slot:not([data-leaving])') : null
  const reminderHeight = previousReminder?.getBoundingClientRect().height
  resetEntrySwipe()
  chrome()
  main.innerHTML = ({ home, overview, categories: categoryPage, settings: settingsPage })[state.view]()
  main.dataset.view = state.view
  placeLedgerCategoryChildren()
  syncSelection()
  transitionMeters(main, previousMeters)
  transitionDueReminder(previousReminder, reminderHeight)
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
  bar.innerHTML = `<button type="button" class="plain" data-action="select-mode">${t('取消')}</button>
    <span class="select-count" aria-live="polite">${t('已选 {0} 笔', count)}</span>
    <button type="button" class="plain" data-action="select-all" ${rows.length ? '' : 'disabled'}>${all ? t('全不选') : t('全选')}</button>
    <button type="button" class="button" data-action="bulk-category" ${count ? '' : 'disabled'}>${t('{0}改分类', icon('tag', 16))}</button>
    <button type="button" class="button danger" data-action="delete-selected" ${count ? '' : 'disabled'}>${t('{0}删除', icon('trash', 16))}</button>`
}

function stopSelecting() {
  state.selecting = false
  state.selected.clear()
}

function showSwipedRow(row = null) {
  if (swipedRow === row) return
  if (swipedRow) {
    const button = swipedRow.lastElementChild
    if (document.activeElement === button) swipedRow.firstElementChild.focus({ preventScroll: true })
    button.inert = true
    swipedRow.classList.remove('swipe-open')
  }
  swipedRow = row
  if (row) {
    row.classList.add('swipe-open')
    row.lastElementChild.inert = false
  }
}

function clearEntryDrag() {
  if (!entrySwipe) return
  const { row } = entrySwipe
  row.classList.remove('swipe-dragging')
  row.style.removeProperty('--swipe-offset')
  entrySwipe = null
}

function resetEntrySwipe() {
  showSwipedRow()
  clearEntryDrag()
}

function beginEntrySwipe(event) {
  if (!event.isPrimary) { clearEntryDrag(); return }
  ignoreSwipeClick = false
  if (swipedRow && !swipedRow.contains(event.target)) showSwipedRow()
  if (event.pointerType !== 'touch' || dialog.open) return
  const control = event.target.closest('.transaction-swipe > button')
  if (!control || control.inert || control.disabled) return
  const row = control.parentElement
  const width = row.lastElementChild.offsetWidth
  entrySwipe = {
    row, width, x: event.clientX, y: event.clientY, pointer: event.pointerId,
    start: row === swipedRow ? -width : 0, dragging: false,
    deleteButton: control === row.lastElementChild ? control : null
  }
}

function moveEntrySwipe(event) {
  const swipe = entrySwipe
  if (!swipe || swipe.pointer !== event.pointerId) return
  const dx = event.clientX - swipe.x
  if (!swipe.dragging) {
    const dy = Math.abs(event.clientY - swipe.y)
    if (Math.max(Math.abs(dx), dy) < 9) return
    if (swipe.deleteButton || Math.abs(dx) <= dy * 1.25 || (dx > 0 && swipe.start === 0)) { clearEntryDrag(); return }
    swipe.dragging = true
    swipe.row.classList.add('swipe-dragging')
  }
  const offset = Math.max(-swipe.width, Math.min(0, swipe.start + dx))
  swipe.row.style.setProperty('--swipe-offset', `${offset}px`)
}

function finishEntrySwipe(event) {
  const swipe = entrySwipe
  if (!swipe || swipe.pointer !== event.pointerId) return
  if (event.type === 'pointerup') {
    if (swipe.dragging) {
      ignoreSwipeClick = true
      const offset = swipe.start + event.clientX - swipe.x
      showSwipedRow(offset < -swipe.width / 2 ? swipe.row : null)
    } else if (swipe.deleteButton && swipe.row === swipedRow &&
      Math.hypot(event.clientX - swipe.x, event.clientY - swipe.y) < 9 &&
      swipe.deleteButton.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      // Browsers can skip the compatibility click just after the row moves.
      ignoreSwipeClick = true
      swipe.deleteButton.click()
    }
  }
  clearEntryDrag()
}

// Categories belong to one direction, so a mixed selection changes one direction at a time.
function openBulkCategory() {
  const picked = state.entries.filter(entry => state.selected.has(entry.id))
  const counts = { expense: 0, income: 0 }
  for (const entry of picked) if (entry.direction in counts) counts[entry.direction] += 1
  if (!counts.expense && !counts.income) { toast(t('转账没有分类，选中的流水无需修改。')); return }
  bulk = { counts, others: picked.length - counts.expense - counts.income, direction: counts.expense >= counts.income ? 'expense' : 'income', categoryId: undefined }
  renderBulkCategory()
}

function renderBulkCategory() {
  const { counts, direction, categoryId } = bulk
  const selected = state.categories.find(item => item.id === categoryId)
  const rootId = selected?.parentId ?? selected?.id ?? (categoryId === null ? '' : undefined)
  const pill = (item, active) => `<button type="button" class="entry-cat" aria-pressed="${active}" data-action="bulk-pick" data-value="${item.id}">
    ${categoryArt(item.icon)}<span>${escape(categoryName(item))}</span></button>`
  const roots = [...topCategories(direction), { id: '', name: t('未分类'), icon: 'tag' }]
  const root = selected && state.categories.find(item => item.id === rootId)
  const unchanged = counts[direction === 'expense' ? 'income' : 'expense'] + bulk.others
  const label = categoryId === undefined ? t('选择分类') : t('改为「{0}」', escape(categoryName(selected) || t('未分类')))
  openDialog(t('修改分类'), `<div class="form-grid bulk-category category-picker" data-direction="${direction}">
    ${counts.expense && counts.income ? tabs('bulk-direction', { expense: t('支出 {0} 笔', counts.expense), income: t('收入 {0} 笔', counts.income) }, direction) : ''}
    <p class="fine">${t('修改 {0} 笔{1}的分类{2}。', counts[direction], directionLabel(direction), unchanged ? t('，其余 {0} 笔不变', unchanged) : '')}</p>
    <div class="category-strip">${roots.map(item => pill(item, item.id === rootId)).join('')}
      <button type="button" class="entry-cat entry-add" data-action="category-add" data-value="" aria-label="${t('新增{0}一级分类', directionLabel(direction))}">
      <span class="category-icon">${icon('plus', 18)}</span><span>${t('添加')}</span></button></div>
    ${root ? `<div class="category-children">${children(root.id).map(item => pill(item, item.id === categoryId)).join('')}
      <button type="button" class="entry-cat entry-add" data-action="category-add" data-value="${escape(root.id)}" aria-label="${t('在{0}下新增二级分类', escape(categoryName(root)))}"><span class="category-icon">${icon('plus', 18)}</span><span>${t('添加')}</span></button></div>` : ''}
    ${categoryAdder()}
    <div class="form-footer">${cancelButton()}<button type="button" class="button primary" data-action="bulk-apply" ${categoryId === undefined ? 'disabled' : ''}>${label}</button></div>
  </div>`)
}

async function applyBulkCategory(control) {
  const { direction, categoryId } = bulk
  if (categoryId === undefined) return
  const targets = state.entries.filter(entry => state.selected.has(entry.id) && entry.direction === direction)
  const name = categoryName(state.categories.find(item => item.id === categoryId)) || t('未分类')
  control.disabled = true
  await saveEntries(targets.filter(entry => entry.categoryId !== categoryId).map(entry => ({ ...entry, categoryId })))
  dialog.close()
  stopSelecting()
  await reload()
  toast(t('已将 {0} 笔改为「{1}」', targets.length, name))
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
  const changed = state.view !== view
  state.view = view
  stopSelecting()
  render()
  const target = focusLedger ? byId('ledger-title') : main
  target.focus({ preventScroll: true })
  if (focusLedger) target.scrollIntoView({ block: 'start' })
  else window.scrollTo(0, 0)
  if (changed) playMotion(main, [{ opacity: .55, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], 170)
}

function openDialog(title, content, layout = '') {
  resetEntrySwipe()
  const replacingEntry = dialog.open && layout === 'entry' && dialog.classList.contains('entry-sheet')
  dialog.classList.toggle('wide', layout === 'wide')
  dialog.classList.toggle('entry-sheet', layout === 'entry')
  dialog.innerHTML = `<div class="dialog-top"><h2 id="dialog-title">${title}</h2>
    ${icoButton('close', 'close', t('关闭'))}</div><div class="dialog-content">${content}</div>`
  if (!dialog.open) dialog.showModal()
  dialog.scrollTop = 0
  if (replacingEntry) playMotion(dialog.querySelector('.dialog-content'),
    [{ opacity: .55, transform: 'translateY(9px)' }, { opacity: 1, transform: 'translateY(0)' }], 195)
}

const errorPlaceholder = '<p class="form-error" role="alert"></p>'
const cancelButton = () => button('close', t('取消'))
const submitButton = label => `<button type="submit" class="button primary">${label}</button>`
const field = (name, content) => `<label class="form-field">${name}${content}</label>`
const selectField = (label, key, options) => field(label, `<select name="${key}">${options}</select>`)
const invalidDateRange = '请输入有效日期，结束日期须为开始日期或之后。'

function dateRangeFields({ start, end }) {
  return `<div class="form-pair">${field(t('开始日期'), `<input name="start" type="date" min="1900-01-01" max="9999-12-31" value="${start}" required>`)}
    ${field(t('结束日期'), `<input name="end" type="date" min="1900-01-01" max="9999-12-31" value="${end}" required>`)}</div>`
}

function dateRangeFromForm(form) {
  const start = form.elements.start.value
  const end = form.elements.end.value
  return dateTime(start) && dateTime(end) && start <= end ? { start, end } : null
}

function openPeriod() {
  openDialog(t('选择日期范围'), `<form id="period-form" class="form-grid">
    ${dateRangeFields(period())}
    ${errorPlaceholder}<div class="form-footer">${button('this-month', t('回到本月'), '', '', 'leading')}${cancelButton()}${submitButton(t('应用日期范围'))}</div>
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
  const title = category ? t(parent ? '编辑二级分类' : '编辑一级分类') : t(parent ? '新增二级分类' : '新增一级分类')
  openDialog(title, `<form id="category-form" class="form-grid" data-id="${escape(category?.id)}" data-parent="${escape(parent?.id)}" data-direction="${direction ?? ''}" data-icon-holder data-icon="${selectedIcon}">
    ${direction ? `<p class="fine">${directionLabel(direction)}${parent ? ` · ${escape(categoryName(parent))}` : ''}</p>` : selectField(t('收支类型'), 'direction', ['expense', 'income'].map(id => option(id, directionLabel(id), state.categoryDirection)).join(''))}
    ${field(t('分类名称'), `<input name="name" value="${escape(categoryName(category))}" maxlength="24" required autocomplete="off" placeholder="${t('输入分类名称')}">`)}
    <div class="field"><span>${t('图标')}</span>${iconPicker(selectedIcon)}</div>
    ${errorPlaceholder}<div class="form-footer">
    ${category ? button('category-delete', t('删除分类'), '', 'trash', 'danger leading') : ''}${cancelButton()}${submitButton(t('保存分类'))}</div></form>`)
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
  const strip = dialog.querySelector('.category-strip > .category-children')?.parentElement
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
  const roots = [...topCategories(direction), { id: '', name: t('未分类'), icon: 'tag' }]
  strip.innerHTML = roots.map(item => pill(item, item.id === rootId, item.id ?
    ` aria-expanded="${item.id === rootId}" aria-controls="entry-subcategories"` : '')).join('') +
    `<button type="button" class="entry-cat entry-add" data-action="category-add" data-value="" aria-label="${t('新增{0}一级分类', directionLabel(direction))}">
    <span class="category-icon">${icon('plus', 18)}</span><span>${t('添加')}</span></button>`
  // A chosen top-level category always offers its own add slot, even before it has subcategories.
  const root = roots.find(item => item.id && item.id === rootId)
  childGrid.hidden = !root
  childGrid.innerHTML = root ? children(rootId).map(item => pill(item, item.id === selectedId)).join('') +
    `<button type="button" class="entry-cat entry-add" data-action="category-add" data-value="${escape(rootId)}" aria-label="${t('在{0}下新增二级分类', escape(categoryName(root)))}"><span class="category-icon">${icon('plus', 18)}</span><span>${t('添加')}</span></button>` : ''
  strip.append(childGrid)
  placeCategoryChildren(strip)
  section.querySelector('.entry-category-name').textContent = categoryName(selected) || t('未分类')
}

// The entry sheet and the bulk category dialog share one inline "add category" field.
const categoryAdder = () => `<div class="category-adder" data-icon-holder hidden>
  <input class="control" type="text" maxlength="24" autocomplete="off" enterkeyhint="done" aria-label="${t('新分类名称')}">
  <button type="button" class="button" data-action="category-add-cancel">${t('取消')}</button>
  <button type="button" class="button primary" data-action="category-add-save">${t('添加')}</button>
  <span class="category-adder-error" role="alert"></span>
  <div class="icon-picker-slot"></div>
</div>`

// Use the stored icon (or the parent's icon for a new child) and resolve old names in the picker.
const startingIcon = category => category ? iconAliases[category.icon] ?? category.icon : 'tag'
const iconPicker = selected => `<div class="icon-picker" role="radiogroup" aria-label="${t('选择图标')}">${iconChoices.map(name =>
  `<button type="button" class="icon-choice" role="radio" aria-checked="${name === selected}" aria-label="${name}" data-action="pick-icon" data-value="${name}">${categoryArt(name)}</button>`).join('')}</div>`
const pickerDirection = picker => picker.dataset.direction ?? picker.closest('form').elements.direction.value

function openCategoryAdder(picker, parentId) {
  const parent = state.categories.find(item => item.id === parentId)
  const adder = picker.querySelector('.category-adder')
  const input = adder.querySelector('input')
  adder.dataset.parent = parent?.id ?? ''
  adder.querySelector('.category-adder-error').textContent = ''
  input.value = ''
  input.placeholder = parent ? t('「{0}」下的新分类', categoryName(parent)) : t('新的{0}一级分类', directionLabel(pickerDirection(picker)))
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
    toast(t('分类已添加'))
  } finally { delete adder.dataset.saving }
}

const amountText = (minor, currency) => (minor / (currency === 'JPY' ? 1 : 100)).toFixed(currency === 'JPY' ? 0 : 2)
const screenReview = {
  ready: '请核对屏幕上的金额、币种和收支方向，再保存。',
  unknownCurrency: '已找到金额，请确认并选择币种。',
  multiple: '画面中有多个可能的金额，请填写实际扣款或到账金额。',
  unfinished: '画面显示交易未完成。请核对实际是否发生收支。',
  missing: '没有找到明确的金额，请对照付款或收款页面填写。'
}

function screenNotice(screen) {
  const duplicate = likelyDuplicate(screen, state.entries)
  if (!duplicate) return `<p class="screen-review">${icon('scan', 18)}<span>${t(screenReview[screen.status])}</span></p>`
  const category = state.categories.find(item => item.id === duplicate.categoryId)
  const when = `${formatDate(duplicate.at.slice(0, 10), 'short')} ${duplicate.at.slice(11, 16)}`
  return `<p class="screen-review warn">${icon('scan', 18)}<span>${t('可能已经记过：{0} · {1} {2}。确认不是同一笔再保存。', when, escape(duplicate.note || categoryName(category) || t('未分类')), money(duplicate.minor, duplicate.currency))}</span></p>`
}

// Transfers are no longer offered, except to keep an existing transfer editable as it is.
const directionsFor = current => Object.keys(directions).filter(key => key !== 'transfer' || current === 'transfer')
  .map(key => [key, directionLabel(key)])
const dayText = day => !dateTime(day) ? t('选择日期') : day === tokyoNow().slice(0, 10) ? t('今天') : formatDate(day)

function openEntry(id, screen, scheduled) {
  const bill = scheduled?.bill
  const entry = state.entries.find(item => item.id === id)
  if (id && !entry) return
  hidePaste()
  const now = tokyoNow()
  const at = entry?.at ?? screen?.at ?? (scheduled ? scheduled.due + now.slice(10) : now)
  const currency = entry?.currency ?? bill?.currency ?? (screen ? screen.currency ?? '' : 'JPY')
  const original = entry ?? bill
  const amount = original ? amountText(original.minor, currency) : screen?.amount ?? ''
  const direction = entry?.direction ?? screen?.direction ?? 'expense'
  const choices = (screen ? option('', t('请选择币种'), currency) : '') + currencyOptions(currency)
  const directionChoices = directionsFor(direction).filter(([key]) => !bill || key === 'expense').map(([key, label]) => `<label class="entry-direction">
    <input class="sr-only" type="radio" name="direction" value="${key}"${direction === key ? ' checked' : ''}>
    <span>${label}</span></label>`).join('')
  const title = bill ? t('确认固定账单') : entry ? t('编辑流水') : screen ? t('核对屏幕账单') : t('记一笔')
  openDialog(title, `<form id="entry-form" data-id="${entry?.id ?? ''}" data-bill="${escape(bill?.id)}"
    data-due="${scheduled?.due ?? ''}" data-merchant="${escape(screen?.merchant)}">
    <div class="entry-content">
    ${screen ? screenNotice(screen) : ''}
    <div class="entry-toolbar">
      <fieldset class="entry-modes"><legend class="sr-only">${t('收支类型')}</legend>${directionChoices}</fieldset>
      <div class="entry-clock">
        <label class="entry-day"><span class="entry-day-text" aria-hidden="true">${dayText(at.slice(0, 10))}</span>${icon('down', 14)}
          <span class="sr-only">${t('日期 · 东京时间')}</span>
          <input name="day" type="date" min="1900-01-01" max="9999-12-31" value="${at.slice(0, 10)}" required></label>
        <label><span class="sr-only">${t('时间')}</span><input name="time" type="time" step="1" value="${at.slice(11)}" required></label>
      </div>
    </div>
    <div class="entry-amount">
      <span class="entry-symbol" aria-hidden="true">${currency === 'USD' ? '$' : currency ? '¥' : ''}</span>
      <label class="entry-amount-input"><span class="sr-only">${t('金额')}</span>
        <input name="amount" inputmode="none" value="${escape(amount)}" autocomplete="off" maxlength="64" placeholder="0" required></label>
      <label class="entry-currency"><span class="sr-only">${t('币种')}</span><select class="control" name="currency" required>${choices}</select></label>
    </div>
    <div class="entry-amount-feedback" hidden>
      <div class="fx" id="fx-preview" aria-live="polite"></div>
      <button class="plain entry-clear" type="button" data-action="entry-key" data-value="clear">${t('清空')}</button>
    </div>
    <section class="entry-categories category-picker" aria-label="${t('选择分类')}">
      <input type="hidden" name="category">
      <div class="entry-category-heading"><h3>${t('分类')}</h3><span class="entry-category-name"></span></div>
      <div class="category-strip">
        <div id="entry-subcategories" class="category-children" role="group" aria-label="${t('二级分类')}" hidden></div>
      </div>
      ${categoryAdder()}
    </section></div>
    <div class="entry-footer">
    <div class="entry-note">
      <label><span class="sr-only">${t('备注')}</span><textarea name="note" maxlength="500" rows="1" placeholder="${t('填写备注')}">${escape(entry?.note ?? screen?.note ?? bill?.name ?? '')}</textarea></label>
      ${entry ? icoButton('delete-entry', 'trash', t('删除流水'), `data-value="${entry.id}"`) : ''}
    </div>
    ${bill ? '' : `<div class="entry-footer-actions"><label class="switch-line"><input type="checkbox" name="rememberMerchant">${t('记住此商户的分类')}</label>
      ${entry?.direction === 'expense' ? button('bill-from-entry', t('设为固定账单'), `data-value="${escape(entry.id)}"`, 'calendar', 'subtle') : ''}</div>`}
    ${errorPlaceholder}</div>
    ${keypad(entry || screen || bill)}</form>`, 'entry')
  const form = byId('entry-form')
  selectCategories(form, entry?.categoryId ?? screen?.categoryId ?? bill?.categoryId)
  updateEntryCurrency(form)
  refreshEntryQuote(form, true)
}

function keypad(single) {
  const key = (value, glyph = '', label = '') => `<button class="key" type="button" data-action="entry-key" data-value="${value}"${label ? ` aria-label="${label}"` : ''}>${glyph ? icon(glyph, 20) : value === '-' ? '−' : value}</button>`
  return `<div class="entry-keypad" aria-label="${t('数字键盘')}">
    ${['7', '8', '9'].map(value => key(value)).join('')}${key('erase', 'erase', t('删除一位'))}
    ${['4', '5', '6'].map(value => key(value)).join('')}${key('-', '', t('减号'))}
    ${['1', '2', '3'].map(value => key(value)).join('')}${key('+', '', t('加号'))}
    <button type="submit" class="key key-save" aria-label="${t('保存流水')}">${t('保存')}</button>
    ${single ? '<span></span>' : `<button class="key key-repeat" type="submit" value="repeat">${t('再记一笔')}</button>`}
    ${key('0')}${key('.', '', t('小数点'))}
  </div>`
}

function updateEntryCurrency(form) {
  const code = form.elements.currency.value
  form.querySelector('.entry-symbol').textContent = code === 'USD' ? '$' : code ? '¥' : ''
  form.querySelector('[data-value="."]').disabled = code === 'JPY'
}

function pressEntryKey(form, value) {
  const input = form.elements.amount
  const current = input.value.normalize('NFKC').trim()
  const operand = current.split(/[+−-]/).at(-1)
  let next = current
  if (value === 'erase') next = current.slice(0, -1)
  else if (value === 'clear') next = ''
  else if (value === '+' || value === '-') {
    const before = current.replace(/[+−-]$/, '').trimEnd()
    if (/\d\.?$/.test(before)) next = before + (value === '-' ? '−' : '+')
  } else if (value === '.') {
    if (form.elements.currency.value !== 'JPY' && !operand.includes('.')) next = current + (operand ? '.' : '0.')
  } else if ((operand.split('.')[1]?.length ?? 0) < 2) {
    next = (operand === '0' ? current.slice(0, -1) : current) + value
  }
  if (next.length <= input.maxLength) {
    input.value = next
    input.setSelectionRange(next.length, next.length)
    input.scrollLeft = input.scrollWidth
  }
  formError('')
  refreshEntryQuote(form, false)
}

function entryDraft(form, minor = amountExpressionMinor(form.elements.amount.value, form.elements.currency.value)) {
  const data = form.elements
  const at = dateTime(`${data.day.value}T${data.time.value}`)
  const currency = data.currency.value
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
  openDialog(t('配置 iPhone 快捷指令'), `<div class="form-grid">
    <ol class="setup-steps">
      <li>${t('打开{0}，按提示添加。', `<a href="https://www.icloud.com/shortcuts/5c81ff9b141b47b0bb4c26487117fa79" target="_blank" rel="noopener">${t('屏幕记账快捷指令')}</a>`)}</li>
      <li>${t('在 iPhone「设置」进入「辅助功能」→「触控」→「轻点背面」→「轻点两下」，选择这个快捷指令。')}</li>
      <li>${t('在付款或收款详情上轻点背面两下，手机会回到主屏幕。打开小日账，点底部弹出的「粘贴屏幕账单」，再点系统的「粘贴」。')}</li>
      <li>${t('金额、币种、时间、商户会自动填好；同一商户会沿用上次的分类，常见店铺也会自动选分类。核对后点「保存」。')}</li>
    </ol>
    <div class="form-footer">
      ${button('screen-input', t('返回屏幕记账'))}
    </div></div>`)
}

function showScreenInput(unread = false) {
  hidePaste()
  openDialog(t('屏幕记账'), `<form id="screen-form" class="form-grid">
    <p class="fine">${t('{0}在付款或收款页面运行快捷指令后，可从剪贴板读取屏幕文字，也可以长按下方输入框粘贴。', unread ? t('没有读到剪贴板里的账单文字。') + ' ' : '')}</p>
    ${field(t('识别出的文字'), `<textarea name="screenText" maxlength="${screenTextLimit}" placeholder="${t('粘贴快捷指令识别出的账单文字')}" spellcheck="false"></textarea>`)}
    ${errorPlaceholder}
    <div class="form-footer">
      ${button('screen-guide', t('配置轻点背面'), '', '', 'leading')}
      ${button('screen-read', t('读取剪贴板'))}
      ${submitButton(t('识别并预填'))}
    </div></form>`)
}

function applyScreenText(text) {
  if (!text.trim()) {
    formError(t('这里还没有账单文字。运行快捷指令后再粘贴。'))
    return
  }
  const draft = parseScreenText(text)
  const match = findMerchantRule(state.features.merchants, draft.note, state.categories, draft.direction)
  const categoryId = match.categoryId ?? suggestCategory(draft, text, state.entries, state.categories)
  openEntry(null, { ...draft, note: match.note, merchant: draft.note, categoryId })
}

// Read the clipboard inside the tap itself; only show the manual paste form when that fails.
async function pasteFromScreen() {
  hidePaste()
  let text = ''
  try { text = await navigator.clipboard.readText() } catch { /* Denied, unsupported, or the paste prompt was dismissed. */ }
  if (dialog.open) return
  if (text.trim()) applyScreenText(text)
  else showScreenInput(true)
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

async function readScreenClipboard() {
  const form = byId('screen-form')
  if (!navigator.clipboard?.readText) return
  let text
  try {
    text = await navigator.clipboard.readText()
  } catch {
    // Safari also supports the system paste menu on the text area.
    return
  }
  if (dialog.open && byId('screen-form') === form) applyScreenText(text)
}

function quotePreview(form) {
  const text = byId('fx-preview')
  const expression = form.elements.amount.value.trim()
  const hasOperators = /[\d.]\s*[+−-]/.test(expression.normalize('NFKC'))
  form.classList.toggle('has-amount-expression', hasOperators)
  text.parentElement.hidden = !expression
  if (!expression) { text.textContent = ''; return }
  const selected = form.elements.currency.value
  if (!selected) {
    text.textContent = t('选择币种后查看换算')
    return
  }
  const minor = amountExpressionMinor(expression, selected)
  const calculation = minor !== null && hasOperators
    ? `<strong class="entry-calculation">= ${money(minor, selected)}</strong>` : ''
  const draft = entryDraft(form, minor)
  const available = quotesFor(form.elements.day.value)
  const rateLabel = draft?.fx.CNY ?? available.CNY
  if (!draft) {
    text.innerHTML = calculation || (rateLabel ? `1 JPY ≈ ${rateLabel.rate} CNY<small>${t('参考汇率 · {0}', rateLabel.date)}</small>`
      : t('输入金额后查看换算'))
    return
  }
  const estimates = []
  if (selected !== 'JPY') estimates.push(draft.yen == null ? t('日元待换算') : `${draft.settlementYen != null ? t('日元实扣 ') : t('约 ')}${money(draft.yen, 'JPY')} JPY`)
  if (selected !== 'CNY') estimates.push(draft.yuan == null ? t('人民币待换算') : t('约 {0} CNY', money(draft.yuan, 'CNY')))
  const dates = [...new Set(Object.values(draft.fx).map(item => item.date))]
  text.innerHTML = `${calculation}${estimates.join(' · ')}${dates.length ? `<small>${t('参考汇率日期 · {0}', dates.join(' / '))}</small>` : `<small>${t('如需参考汇率，联网后会自动补齐')}</small>`}`
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
  if (showStatus) toast(updated ? t('已补齐 {0} 笔汇率', updated) : t('暂未获取到可补齐的参考汇率'))
}

const featureTitles = { merchants: '商户规则', total: '总预算', budgets: '分类预算', bills: '固定账单' }
const cycleLabels = { weekly: '每周', monthly: '每月', yearly: '每年' }
const todayTokyo = () => tokyoNow().slice(0, 10)
const featureStore = list => list === 'total' ? 'budgets' : list
const featureItems = list => featureStore(list) === 'budgets'
  ? state.features.budgets.filter(item => (item.categoryId === null) === (list === 'total'))
  : state.features[list]

function budgetPanel() {
  if (!state.features.budgets.length) return ''
  const budgets = budgetUsage(state.entries, state.categories, state.features.budgets, state.month)
  const totals = budgets.filter(item => item.categoryId === null)
  const categories = budgets.filter(item => item.categoryId !== null)
  const control = totals.length ? button('manage-feature', t('管理'), 'data-value="total"', '', 'budget-action subtle')
    : button('edit-feature', t('设置'), 'data-list="total"', '', 'budget-action subtle')
  return `<section class="home-budget" aria-labelledby="home-budget-title">
    <div class="home-budget-head"><div class="home-budget-title"><h2 id="home-budget-title">${t('总预算')}</h2>
      ${state.range ? `<small>${formatDate(state.month, 'month')}</small>` : ''}</div>${control}</div>
    ${totals.length ? budgetRows(totals) : ''}
    ${categories.length ? `<details id="category-budget-details" class="budget-details"${state.budgetExpanded ? ' open' : ''}>
      <summary class="budget-disclosure"><span>${t('分类预算')}</span>${icon('down', 16)}</summary>
      <div class="category-budget-body">
        ${budgetRows(categories, true)}
        ${button('manage-feature', t('管理'), 'data-value="budgets"', '', 'budget-action subtle')}
      </div>
    </details>` : ''}
  </section>`
}

function budgetRows(budgets, categorized = false) {
  return `<ul class="feature-list">${budgets.map(budget => {
    const amount = value => money(value, budget.currency)
    const label = categorized ? importCategoryLabel(budget.categoryId) : budget.currency
    const over = budget.remaining < 0
    const status = over ? t('超出 {0}', amount(-budget.remaining)) : t('剩余 {0}', amount(budget.remaining))
    return `<li class="budget-line${over ? ' over-budget' : ''}">
      ${categorized ? `<div class="budget-category">${escape(label)} <small>${budget.currency}</small></div>` : ''}
      <div class="budget-line-values">
        <span>${categorized ? '' : `<b>${budget.currency}</b> `}${t('已用 {0}', amount(budget.spent))}<span class="budget-limit"> / ${amount(budget.minor)}</span></span>
        <strong>${status}</strong>
      </div>
      <span class="budget-track" role="progressbar" aria-label="${escape((categorized ? label : t('总预算')) + ' · ' + budget.currency)}"
        aria-valuemin="0" aria-valuemax="${budget.minor}" aria-valuenow="${Math.min(budget.spent, budget.minor)}" aria-valuetext="${escape(status)}">
        ${meterFill(`budget:${budget.id}`, Math.min(budget.spent / budget.minor, 1))}</span>
      ${budget.pending ? `<small>${t('{0} 笔待换算', budget.pending)}</small>` : ''}
    </li>`
  }).join('')}</ul>`
}

function dueBills() {
  const keys = new Set(state.entries.map(entry => entry.sourceKey).filter(key => key?.startsWith('recurring:')))
  const today = todayTokyo()
  return state.features.bills.map(bill => ({ bill, due: firstUnpostedDate(bill, keys) }))
    .filter(item => item.due && item.due <= today).sort((a, b) => a.due.localeCompare(b.due))
}

const billControl = ({ bill, due }) => `data-value="${escape(bill.id)}" data-due="${due}"`

function billsPanel() {
  const due = dueBills()
  if (!due.length) return ''
  const single = due.length === 1 ? due[0] : null
  const summary = t('{0} 笔待确认', due.length)
  const amount = single ? money(single.bill.minor, single.bill.currency) +
    (single.bill.currency === state.currency ? '' : ` ${single.bill.currency}`) : ''
  return `<button class="due-reminder" type="button" data-action="${single ? 'review-bill' : 'review-due-bills'}" ${single ? billControl(single) : ''}>
    ${icon('calendar', 17)}<span>${t('固定账单')}</span><small>${summary}${amount ? ' · ' + amount : ''}</small>${icon('right', 15)}
  </button>`
}

function transitionDueReminder(previous, height) {
  const digest = main.querySelector('.book-digest')
  if (!previous || !digest || !allowsMotion.matches) return
  const current = digest.querySelector('.due-slot')
  if (current) {
    const summary = current.querySelector('.due-reminder small')
    if (summary.textContent !== previous.querySelector('.due-reminder small').textContent) {
      playMotion(summary, [{ opacity: .4, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], 160)
    }
    return
  }
  previous.dataset.leaving = ''
  previous.inert = true
  previous.setAttribute('aria-hidden', 'true')
  previous.querySelector('.due-reminder').disabled = true
  digest.insertBefore(previous, digest.querySelector('.home-budget'))
  const animation = playMotion(previous, [
    { height: height + 'px', overflow: 'hidden', opacity: 1 },
    { height: '0px', overflow: 'hidden', opacity: 0 }
  ], 190)
  if (animation) animation.finished.then(() => previous.remove(), () => previous.remove())
  else previous.remove()
}

function openDueBills() {
  const due = dueBills()
  if (!due.length) return
  openDialog(t('待确认的固定账单'), `<div class="form-grid"><div>${due.map(occurrence => {
    const { bill, due } = occurrence
    return `<button type="button" class="feature-row" data-action="review-bill" ${billControl(occurrence)}>
      <span><strong>${escape(bill.name)}</strong><small>${dayLabel(due)} · ${money(bill.minor, bill.currency)} ${bill.currency}</small></span>
      ${icon('right', 15)}</button>`
  }).join('')}</div>
  <div class="form-footer">${button('manage-feature', t('管理'), 'data-value="bills"')}</div></div>`)
}

function manageFeature(list) {
  if (!Object.hasOwn(featureTitles, list)) return
  const rows = featureItems(list).map(item => {
    const category = item.categoryId ? importCategoryLabel(item.categoryId) : ''
    const title = list === 'total' ? item.currency : list === 'budgets' ? category : item.name || item.aliases[0]
    const sub = list === 'merchants' ? [...item.aliases, category].filter(Boolean).join(' · ')
      : [money(item.minor, item.currency) + ' ' + item.currency,
        list === 'bills' ? [t(cycleLabels[item.cycle]), item.next ? t('下次日期 {0}', dayLabel(item.next)) : '', category].filter(Boolean).join(' · ') : ''].filter(Boolean).join(' · ')
    return `<button type="button" class="feature-row" data-action="edit-feature" data-list="${list}" data-value="${escape(item.id)}">
      <span><strong>${escape(title)}</strong><small>${escape(sub)}</small></span>${icon('right', 15)}</button>`
  }).join('')
  openDialog(t(featureTitles[list]), `<div class="form-grid">${rows ? `<div>${rows}</div>` : `<p class="fine">${t('还没有设置任何项目。')}</p>`}
    <div class="form-footer">${button('edit-feature', t('添加'), `data-list="${list}"`, 'plus', 'primary')}</div></div>`)
}

function merchantCategoryOptions(selected) {
  const groups = ['expense', 'income'].map(direction => {
    const items = topCategories(direction).flatMap(root => [root, ...children(root.id)])
    return `<optgroup label="${directionLabel(direction)}">${items.map(item =>
      option(item.id, importCategoryLabel(item.id), selected)).join('')}</optgroup>`
  }).join('')
  return option('', t('未分类'), selected) + groups
}

function featureCategoryLabel(value, optional) {
  const selected = state.categories.find(item => item.id === value && item.direction === 'expense')
  const label = selected ? importCategoryLabel(selected.id) : t(optional ? '未分类' : '选择分类')
  return `${selected ? categoryArt(selected.icon, 17, selected.name) : icon('tag', 17)}
    <span id="feature-category-value" class="ledger-category-label">${escape(label)}</span>${icon('down', 14)}`
}

function featureCategoryPicker(value, optional) {
  return `<div class="feature-category form-field" data-optional="${optional}">
    <span id="feature-category-label">${t('分类')}</span>
    <input type="hidden" name="category" value="${escape(value)}">
    <button type="button" class="ledger-category-toggle feature-category-toggle" data-action="feature-categories-toggle"
      aria-labelledby="feature-category-label feature-category-value" aria-controls="feature-category-picker" aria-expanded="false">${featureCategoryLabel(value, optional)}</button>
    <section id="feature-category-picker" class="ledger-category-picker" aria-labelledby="feature-picker-title" hidden>
      <div class="ledger-picker-head"><h3 id="feature-picker-title">${t('选择分类')}</h3>
        ${button('feature-categories-close', t('完成'), '', '', 'subtle')}</div>
      <div class="ledger-category-options"></div>
    </section></div>`
}

function setFeatureCategoriesOpen(picker, open) {
  const trigger = picker.querySelector('.feature-category-toggle')
  const panel = picker.querySelector('.ledger-category-picker')
  const options = picker.querySelector('.ledger-category-options')
  const value = picker.querySelector('[name="category"]').value
  const optional = picker.dataset.optional === 'true'
  trigger.innerHTML = featureCategoryLabel(value, optional)
  trigger.setAttribute('aria-expanded', String(open))
  panel.hidden = !open
  if (!open) {
    options.innerHTML = ''
    trigger.focus({ preventScroll: true })
    return
  }
  const scroll = options.scrollTop
  options.innerHTML = (optional ? `<div class="category-strip">${categoryTile({ id: '', name: t('未分类'), icon: 'tag' }, !value, 'feature-category-pick')}</div>` : '') +
    categoryChoiceGroups(['expense'], value, 'feature-category-pick', 'feature-filter-children')
  const children = options.querySelector('.category-children')
  if (children) placeCategoryChildren(children.parentElement)
  options.scrollTop = scroll
}

function featureForm(list, id, source) {
  if (!Object.hasOwn(featureTitles, list)) return
  const item = featureItems(list).find(rule => rule.id === id)
  if (id && !item) return
  const merchant = list === 'merchants'
  const bill = list === 'bills'
  const currency = item?.currency ?? source?.currency ?? state.currency
  const categoryId = item?.categoryId ?? source?.categoryId ?? ''
  const category = list === 'total' ? '' : merchant ? selectField(t('分类'), 'category', merchantCategoryOptions(categoryId))
    : featureCategoryPicker(categoryId, bill)
  const sourceDay = source?.at.slice(0, 10) ?? ''
  const suggestedStart = sourceDay ? nextFutureBillDate(sourceDay, todayTokyo(), 'monthly') ?? '' : ''
  const name = item?.name ?? (source ? (source.note.trim() || importCategoryLabel(source.categoryId)).slice(0, 120) : '')
  const minStart = sourceDay ? offsetDate(sourceDay, 1) : '1900-01-01'
  const start = item?.start ?? (source ? suggestedStart : todayTokyo())
  const currencies = bill ? currencyOptions(currency) : ['JPY', 'CNY'].map(code => option(code, code, currency)).join('')
  const nameField = field(t(merchant ? '商户显示名称（选填）' : '账单名称'),
    `<input name="name" maxlength="120" value="${escape(name)}" ${bill ? 'required' : ''}>`)
  const amountFields = `<div class="form-pair">${selectField(t('币种'), 'currency', currencies)}
    ${field(t(bill ? '金额' : '每月预算金额'), `<input name="amount" inputmode="decimal" maxlength="24" value="${item || source ? amountText((item ?? source).minor, currency) : ''}" required>`)}</div>`
  openDialog(t(featureTitles[list]), `<form id="feature-form" class="form-grid" data-list="${list}" data-id="${escape(id ?? '')}"
    data-source="${escape(source?.id)}" data-source-day="${sourceDay}" data-suggested-start="${suggestedStart}">
    ${merchant || bill ? nameField : ''}
    ${merchant ? field(t('商户别名（每行一个）'), `<textarea name="aliases" maxlength="12000" required>${escape(item?.aliases.join('\n') ?? '')}</textarea>`) : amountFields}
    ${bill ? `<div class="form-pair">${selectField(t('周期'), 'cycle', billCycles.map(cycle => option(cycle, t(cycleLabels[cycle]), item?.cycle ?? 'monthly')).join(''))}
      ${field(t('首次扣款日'), `<input name="start" type="date" min="${minStart}" max="9999-12-31" value="${start}" required>`)}</div>` : ''}
    ${category}
    ${errorPlaceholder}<div class="form-footer">
      ${item ? button('remove-feature', t('删除'), '', 'trash', 'danger leading') : ''}
      ${button('manage-feature', t('返回'), `data-value="${list}"`)}${submitButton(t('保存'))}</div></form>`)
}

function billFromEntry(id) {
  const entry = state.entries.find(item => item.id === id && item.direction === 'expense')
  if (!entry) return
  const existing = state.features.bills.find(bill => bill.sourceEntryId === entry.id || entry.sourceKey?.startsWith(billKey(bill.id, '')))
  featureForm('bills', existing?.id, existing ? null : entry)
}

async function submitFeature(form) {
  const { list, id } = form.dataset
  const data = form.elements
  const previous = featureItems(list).find(item => item.id === id)
  if (id && !previous) { formError(t('设置已变化，请返回后重试。')); return }
  const item = { id: id || crypto.randomUUID(), categoryId: data.category?.value || null }
  if (list === 'budgets' && !item.categoryId) {
    formError(t('请选择预算分类。'))
    form.querySelector('.feature-category-toggle').focus()
    return
  }
  if (list === 'merchants') {
    item.name = data.name.value.trim()
    item.aliases = data.aliases.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  } else {
    item.currency = data.currency.value
    item.minor = amountMinor(data.amount.value, item.currency)
    if (list === 'bills') {
      item.name = data.name.value.trim()
      item.start = data.start.value
      item.cycle = data.cycle.value
      const { source, sourceDay, suggestedStart } = form.dataset
      if (sourceDay && item.start <= sourceDay) { formError(t('首次扣款日须晚于原流水日期。')); return }
      item.sourceEntryId = previous?.sourceEntryId ?? (source || undefined)
      if (item.start === previous?.start) item.anchor = previous.anchor
      else if (sourceDay && item.start === suggestedStart) item.anchor = sourceDay
      item.next = item.start === previous?.start && item.cycle === previous?.cycle ? previous.next : item.start
    }
  }
  const result = await saveFeature(featureStore(list), item, previous)
  if (result !== 'saved') {
    formError(t(result === 'duplicate' ? (list === 'bills' ? '这笔流水已有固定账单。' : list === 'total' ? '该币种已有总预算。' : '已有相同的商户或分类预算。')
      : result === 'changed' ? '设置已变化，请返回后重试。' : '请检查填写的名称、分类、金额和日期。'))
    return
  }
  await reload()
  manageFeature(list)
}

async function removeFeature(form) {
  const { list, id } = form.dataset
  if (!id || !confirm(t('删除这项设置？'))) return
  await deleteFeature(featureStore(list), id)
  await reload()
  manageFeature(list)
}

const driveMessages = {
  authorize: 'Google 授权已过期，请重新授权。',
  authorizing: '等待 Google 授权…',
  denied: 'Google 授权未完成，请重试。',
  syncing: '正在同步账本…',
  synced: '已同步',
  paused: '已暂停同步，本机仍可记账。',
  offline: '离线中，联网后会继续同步。',
  error: '同步暂未完成，本机数据已保留。',
  'google-unavailable': '暂时无法连接 Google，请重试。',
  'wrong-account': '请选择原来同步的 Google 账号。',
  'invalid-cloud': '云端账本无法读取，请保留本机备份。'
}

function driveSummary() {
  const message = t(driveMessages[driveStatus.phase] ?? (driveStatus.clientId ? '等待连接 Google Drive' : '尚未连接 Google Drive'))
  return driveStatus.phase === 'synced' && driveStatus.time
    ? `${message} · ${driveStatus.time.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}`
    : message
}

function paintDriveSettings() {
  const caption = byId('settings-drive-caption')
  if (caption) caption.textContent = driveSummary()
  const status = byId('drive-status')
  if (!status) return
  status.textContent = driveSummary()
  byId('drive-account').textContent = driveStatus.email
  const { authorized, clientId, phase, ready } = driveStatus
  const busy = phase === 'authorizing' || phase === 'syncing'
  const form = byId('drive-config-form')
  form.hidden = driveStatus.linked
  byId('drive-buttons').innerHTML = clientId
    ? `${authorized || busy ? button('drive-pause', t('暂停同步')) : ''}
      ${authorized ? button('drive-now', t('立即同步'), busy ? 'disabled' : '', '', 'primary')
        : button('drive-authorize', t(ready ? '连接 Google Drive' : '加载 Google 授权'), busy ? 'disabled' : '', '', 'primary')}`
    : ''
}

function openDriveSettings() {
  openDialog(t('Google Drive 同步'), `<div class="form-grid">
    <p class="fine">${t('流水、分类和账本设置先保存在本机，授权后也会同步到 Google Drive 的应用专用空间。')}</p>
    <p class="fine"><span id="drive-account"></span><br><span id="drive-status" role="status"></span></p>
    <form id="drive-config-form" class="form-grid">
      ${field(t('Google OAuth 客户端 ID'), `<input name="client" required type="text" spellcheck="false" autocapitalize="none" autocomplete="off" value="${escape(driveStatus.clientId)}">`)}
      <p class="fine"><a href="https://github.com/silverbullet522/xiaorizhang#google-drive-同步" target="_blank" rel="noopener">${t('客户端 ID 配置说明')}</a></p>
      ${errorPlaceholder}<div class="form-footer">${submitButton(t('保存客户端 ID'))}</div>
    </form>
    <div id="drive-buttons" class="form-footer"></div>
  </div>`)
  paintDriveSettings()
  prepareGoogle()
}

function submitDriveConfig(form) {
  if (!configureDrive(form.elements.client.value)) {
    formError(t('请输入以 .apps.googleusercontent.com 结尾的客户端 ID。'))
    return
  }
  formError('')
}

function settingsPage() {
  const row = (action, glyph, label, extra = '') => `<button class="settings-row" type="button" data-action="${action}" ${extra}>
    ${icon(glyph, 18)}<span>${label}</span>${icon('right', 14)}</button>`
  const group = (title, rows, caption = '') => `<section class="settings-group"><h2>${title}</h2>
    <div class="settings-rows">${rows}</div>${caption}</section>`
  const featureIcons = { total: 'chart', budgets: 'tag', bills: 'calendar', merchants: 'shopping-bag' }
  return `<div class="page-heading settings-heading"><h1>${t('设置')}</h1></div>
    <div class="settings-grid">
      ${group(t('常用设置'), `<label class="settings-row settings-language">${icon('settings', 18)}<span>${t('语言')}</span>
        <select id="app-language" aria-label="${t('语言')}">${Object.entries(languageOptions).map(([code, name]) => option(code, name, language)
          .replace('<option ', `<option lang="${code}" `)).join('')}</select></label>` +
        Object.entries(featureIcons).map(([list, glyph]) => row('manage-feature', glyph, t(featureTitles[list]), `data-value="${list}"`)).join(''))}
      ${group(t('应用与离线'), row('screen-guide', 'scan', t('配置屏幕记账')),
        `<p class="settings-note" id="settings-offline">${offlineDescription()}</p>
        ${standalone ? '' : `<p class="settings-note">${t('在 iPhone 的 Safari 里轻点「分享」→「添加到主屏幕」，开启「作为 Web App 打开」。')}</p>`}`)}
      ${group(t('数据与备份'),
        row('drive-settings', 'upload', t('Google Drive 同步')) +
        row('export-backup', 'download', t('导出完整备份')) + row('export-backup-range', 'calendar', t('按日期导出')) +
        row('export-csv', 'download', t('按日期导出 CSV')) + row('pick-backup', 'upload', t('恢复备份')),
        `<p class="settings-note" id="settings-drive-caption">${driveSummary()}</p>`)}
      ${group(t('数据管理'), row('delete-entry-range', 'calendar', t('按日期删除流水')))}
      <div class="settings-rows settings-destructive">${row('clear-ledger', 'trash', t('清除所有数据'))}</div>
    </div>`
}

async function exportBackup(range) {
  const entries = range ? state.entries.filter(entry => within(entry, range)) : state.entries
  const date = range ? t('{0}至{1}', range.start, range.end) : tokyoNow().slice(0, 10)
  const file = new File([JSON.stringify(backupDocument({ ...state, entries, features: range ? null : state.features }))],
    t('小日账-{0}.json', date), { type: 'application/json' })
  return shareOrDownload(file, t('小日账备份'), t('备份文件已生成'))
}

async function shareOrDownload(file, title, message) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true }
    catch (error) { if (error.name === 'AbortError') return false }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  const container = dialog.open ? dialog : main
  container.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  toast(message)
  return true
}

async function exportCsv(range) {
  const entries = state.entries.filter(entry => within(entry, range))
  const headers = ['日期', '收支类型', '币种', '原币金额', '分类', '备注', '折算日元', '折算人民币'].map(label => t(label))
  const csv = ledgerCsv(entries, headers, importCategoryLabel, directionLabel)
  const file = new File([csv], `ledger-${range.start}_${range.end}.csv`, { type: 'text/csv;charset=utf-8' })
  return shareOrDownload(file, t('流水 CSV'), t('CSV 文件已生成'))
}

function openDataRange(operation) {
  const range = period()
  const current = tokyoNow().slice(0, 7)
  const previous = offsetDate(`${current}-01`, -1).slice(0, 7)
  const months = new Set([current, previous, range.start.slice(0, 7)])
  for (const entry of state.entries) months.add(entry.at.slice(0, 7))
  const choices = [...months].sort().reverse().map(month => {
    const prefix = month === current ? t('本月 · ') : month === previous ? t('上月 · ') : ''
    return option(month, prefix + formatDate(month, 'month'))
  }).join('')
  const deleting = operation === 'delete'
  const csv = operation === 'csv'
  openDialog(t(deleting ? '按日期删除流水' : csv ? '按日期导出 CSV' : '按日期导出'), `<form id="data-range-form" class="form-grid" data-operation="${operation}">
    ${selectField(t('快捷选择月份'), 'month', option('', t('选择整月')) + choices)}
    ${dateRangeFields(range)}
    <p class="fine">${t('按东京日期计算，包含起止两天。{0}', deleting || csv ? '' : t('备份包含所选流水与分类。恢复时按备份中有流水的日期替换。'))}</p>
    <p id="data-range-count" class="fine" aria-live="polite"></p>
    ${errorPlaceholder}<div class="form-footer">${cancelButton()}${submitButton(t(deleting ? '下一步' : csv ? '导出 CSV' : '导出备份'))}</div>
  </form>`)
  updateDataRange(byId('data-range-form'))
}

function updateDataRange(form) {
  const range = dateRangeFromForm(form)
  const month = range && monthBounds(range.start.slice(0, 7))
  form.elements.month.value = month && month.start === range.start && month.end === range.end ? range.start.slice(0, 7) : ''
  const count = range && state.entries.filter(entry => within(entry, range)).length
  form.querySelector('#data-range-count').textContent = range ? t('所选范围有 {0} 笔流水', count) : ''
}

async function submitDataRange(form) {
  const range = dateRangeFromForm(form)
  if (!range) { formError(t(invalidDateRange)); return }
  if (form.dataset.operation !== 'delete') {
    const exported = await (form.dataset.operation === 'csv' ? exportCsv(range) : exportBackup(range))
    if (exported && byId('data-range-form') === form && dialog.open) dialog.close()
    return
  }
  const ids = state.entries.filter(entry => within(entry, range)).map(entry => entry.id)
  if (!ids.length) { formError(t('所选日期范围没有流水。')); return }
  if (!confirm(t('删除 {0} 至 {1} 的 {2} 笔流水？\n此操作无法撤销。', range.start, range.end, ids.length))) return
  const removed = await deleteEntriesInRange(range, ids)
  if (byId('data-range-form') === form && dialog.open) dialog.close()
  stopSelecting()
  await reload()
  toast(removed ? t('已删除 {0} 笔流水', removed) : t('所选流水已变化，请重新选择日期范围。'))
}

function openClearLedger() {
  openDialog(t('清除所有数据'), `<form id="clear-ledger-form" class="form-grid">
    <p>${t('将清除本机账本的 {0} 笔流水、自定义分类、分类修改和设置。', `<strong>${state.entries.length}</strong>`)}</p>
    ${driveStatus.linked ? `<p class="fine">${t('下次同步时，也会清除 Google Drive 中的同步账本。')}</p>` : ''}
    <p class="fine">${t('清除后会恢复预设分类和默认汇总币种。此操作无法撤销。')}</p>
    ${errorPlaceholder}<div class="form-footer">${cancelButton()}<button class="button danger" type="submit">${t('确认清除')}</button></div>
  </form>`)
}

async function submitClearLedger(form) {
  clearQuoteCache()
  await clearLedger()
  if (!importState?.saving) importState = null
  pendingBackup = null
  bulk = null
  state.month = tokyoNow().slice(0, 7)
  state.range = null
  state.categoryDirection = 'expense'
  state.statsDirection = 'expense'
  resetLedgerFilters()
  stopSelecting()
  hidePaste()
  if (byId('clear-ledger-form') === form && dialog.open) dialog.close()
  await reload()
  toast(t('所有账本数据已清除'))
}

function columnControl(label, name, headers, selected) {
  return selectField(label, name, option(-1, t('选择列'), selected) + headers.map((h, i) => option(i, h || t('第 {0} 列', i + 1), selected)).join(''))
}

function importMapping() {
  const { headers } = importState.table
  const opts = importState.options
  const column = (label, name) => columnControl(label, name, headers, opts[name])
  return `<form id="map-form" class="form-grid">
    <div class="form-pair">${column(t('日期与时间'), 'date')}
    ${selectField(t('金额列格式'), 'mode', option('signed', t('单一金额列'), opts.mode) + option('pair', t('分别有出金、入金列'), opts.mode))}</div>
    <div id="map-signed" class="form-pair" ${opts.mode === 'signed' ? '' : 'hidden'}>${column(t('金额'), 'amount')}${column(t('收支方向（选填）'), 'direction')}</div>
    <div id="map-pair" class="form-pair" ${opts.mode === 'pair' ? '' : 'hidden'}>${column(t('出金金额'), 'debit')}${column(t('入金金额'), 'credit')}</div>
    <div class="form-pair">${column(t('币种（选填）'), 'currency')}${selectField(t('未指定币种时使用'), 'fixedCurrency', currencyOptions(opts.fixedCurrency))}</div>
    <div class="form-pair">${column(t('分类（选填）'), 'category')}${column(t('备注（选填）'), 'note')}</div>
    <p class="fine">${t('日期支持年/月/日或 Excel 日期。单一金额列未指定收支方向时，负数视为支出，正数视为收入。')}</p>
    <div class="form-footer">${submitButton(t('预览导入'))}</div>
    </form>`
}

function prepareImportPreview(options) {
  importState.preview = importRows(importState.table, options)
  importState.suggestCategory = createCategorySuggester(state.entries, state.categories)
}

function importEntryDraft(number, entry) {
  const direction = importState.overrides.get(number) ?? entry.direction
  const match = findMerchantRule(state.features.merchants, entry.note, state.categories, direction)
  const draft = { ...entry, note: match.note, direction,
    categoryId: (direction === entry.direction ? entry.categoryId : null) ?? match.categoryId }
  if (direction !== 'transfer' && !draft.categoryId) draft.categoryId = importState.suggestCategory(draft, draft.note) ?? importState.suggestCategory(draft, entry.note)
  return draft
}

function importCategoryLabel(id) {
  const category = state.categories.find(item => item.id === id)
  if (!category) return t('未分类')
  const parent = state.categories.find(item => item.id === category.parentId)
  return parent ? `${categoryName(parent)} / ${categoryName(category)}` : categoryName(category)
}

function importMatchDetails(match) {
  const { entry, number } = match
  return `<details class="import-match"><summary class="chip">${t('重复')}</summary>
    <small>${t(number == null ? '匹配账本中的流水' : '匹配文件中的第 {0} 行', number)}</small>
    <small>${escape(entry.note || directionLabel(entry.direction))}</small>
    <small>${escape(entry.at.replace('T', ' '))} · ${directionLabel(entry.direction)} · ${money(entry.minor, entry.currency)} ${entry.currency}</small>
  </details>`
}

function importPreview() {
  if (!importState.preview) return ''
  const rows = duplicatePreviews(importState.preview.filter(row => !row.ignored), state.entries)
  const ignored = importState.preview.length - rows.length
  const counts = { ready: rows.filter(row => row.entry && !row.duplicate).length, invalid: rows.filter(row => row.error).length, duplicate: rows.filter(row => row.duplicate).length }
  // Offered above and below the rows so a long preview never needs scrolling just to import.
  const confirm = button('confirm-import', t('导入 {0} 笔有效流水', counts.ready), counts.ready ? '' : 'disabled', '', 'primary')
  return `<section class="import-preview"><div class="import-top"><div class="import-counts">
    <span class="chip">${t('待导入 {0}', counts.ready)}</span><span class="chip">${t('重复 {0}', counts.duplicate)}</span><span class="chip">${t('有问题 {0}', counts.invalid)}</span>
    ${ignored ? `<span class="chip">${t('已忽略 {0} 条积分记录', ignored)}</span>` : ''}</div>
    ${rows.length ? confirm : ''}</div>
    <div>${rows.slice(0, importState.limit).map(({ number, entry, duplicate, match, error }) => {
      if (!entry) return `<div class="import-row"><span>${t('第 {0} 行', number)}</span><span class="form-error">${escape(t(error))}</span></div>`
      const { direction, categoryId, note } = duplicate ? entry : importEntryDraft(number, entry)
      const meta = t('第 {0} 行 · {1} · {2} {3}', number, entry.at.replace('T', ' '), money(entry.minor, entry.currency), entry.currency)
      return `<div class="import-row"><div><strong>${escape(note || directionLabel(direction))}</strong><small>${meta}</small>
        ${duplicate ? '' : `<small class="import-category"${direction === 'transfer' ? ' hidden' : ''}>${escape(importCategoryLabel(categoryId))}</small>`}</div>
        ${duplicate ? importMatchDetails(match) : `<select class="control" aria-label="${t('第 {0} 行收支类型', number)}" data-import-row="${number}">
        ${directionsFor(direction).map(([id, label]) => option(id, label, direction)).join('')}</select>`}</div>`
    }).join('')}</div>
    ${!rows.length ? `<p class="fine">${ignored ? t('这张表只有已忽略的积分记录。') : t('这张表只有表头。')}</p>` : ''}
    <div class="form-footer">${rows.length > importState.limit ? button('more-import', t('显示更多'), '', '', 'leading') : ''}
    ${confirm}</div></section>`
}

function openImport() {
  const items = importState.file.sheetNames
  const statement = importState.table && statementColumns(importState.table.headers)
  openDialog(t('导入账单'), `<div class="form-grid">
    <div class="import-headline"><strong>${escape(importState.file.name)}</strong>${statement ? `<span class="chip">${t('已识别日文账单')}</span>` : ''}</div>
    ${items.length ? selectField(t('工作表'), 'sheet', items.map(name => option(name, name, importState.sheet)).join('')).replace('name="sheet"', 'id="sheet" name="sheet"') : ''}
    ${errorPlaceholder}
    ${importState.table && !statement ? importMapping() : ''}
    ${importPreview()}</div>`, 'wide')
  if (importState.error) formError(t(importState.error))
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
    if (statementColumns(importState.table.headers)) prepareImportPreview({})
    else importState.options = guessColumns(importState.table.headers)
  } catch (error) { importState.error = error.message }
  openImport()
}

function mappingSubmit(form) {
  const value = new FormData(form)
  const keys = ['date', 'amount', 'direction', 'debit', 'credit', 'currency', 'category', 'note']
  const options = { mode: value.get('mode'), fixedCurrency: value.get('fixedCurrency'), categories: state.categories, categoryName }
  for (const key of keys) options[key] = Number(value.get(key))
  const required = options.mode === 'pair' ? ['date', 'debit', 'credit'] : ['date', 'amount']
  if (required.some(key => options[key] < 0) || new Set(required.map(key => options[key])).size !== required.length) {
    formError(t('请选择不同的日期和金额列。'))
    return
  }
  importState.options = options
  importState.limit = 40
  importState.overrides.clear()
  prepareImportPreview(options)
  openImport()
}

async function confirmImport() {
  // Recompute from the current mapping so a changed select never imports an old preview.
  if (byId('map-form')?.dataset.dirty) { formError(t('列映射已更改，请重新预览。')); return }
  if (importState.saving) return
  importState.saving = true
  const controls = [...dialog.querySelectorAll('[data-action="confirm-import"]')]
  controls.forEach(item => { item.disabled = true })
  try {
    const rows = duplicatePreviews(importState.preview, state.entries).filter(row => row.entry && !row.duplicate)
    const createdAt = new Date().toISOString()
    const entries = rows.map(({ number, entry }) => withQuotes({
      ...importEntryDraft(number, entry), id: crypto.randomUUID(), createdAt
    }, quotesFor(entry.at.slice(0, 10))))
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
    toast(t('已导入 {0} 笔流水', added))
    await refreshRates()
  } finally {
    importState.saving = false
    controls.forEach(item => { item.disabled = false })
  }
}

async function submitEntry(form, control) {
  const entry = entryDraft(form)
  if (!entry) { formError(t('请输入有效日期和正数金额（日元为整数，人民币和美元最多两位小数）。')); return }
  const previous = state.entries.find(item => item.id === form.dataset.id)
  const id = previous?.id ?? crypto.randomUUID()
  const createdAt = previous?.createdAt ?? new Date().toISOString()
  const repeat = !previous && control?.value === 'repeat'
  const record = { ...entry, id, createdAt }
  if (form.dataset.bill) {
    if (!await postBill(form.dataset.bill, form.dataset.due, record)) {
      await reload()
      formError(t('这期账单已入账或设置已更改。'))
      return
    }
  } else {
    const remember = form.elements.rememberMerchant?.checked
    const merchant = remember ? { alias: form.dataset.merchant || entry.note, name: entry.note } : null
    if (remember && (!entry.categoryId || !merchant.name || merchant.name.length > 120)) {
      formError(t('记住商户前，请填写商户名称并选择分类。'))
      return
    }
    if (await saveEntry(record, merchant) === 'invalid') {
      formError(t('无法保存商户规则，请检查同名规则和分类。'))
      return
    }
  }
  if (!repeat && dialog.open && byId('entry-form') === form) dialog.close()
  if (!previous && !within(entry, period())) {
    state.month = entry.at.slice(0, 7)
    state.range = null
    clearDrill()
  }
  await reload()
  if (!previous) {
    const row = main.querySelector(`.transaction[data-value="${CSS.escape(id)}"]`)
    playMotion(row, [{ opacity: .25, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], 200)
  }
  if (repeat && dialog.open && byId('entry-form') === form) {
    openEntry()
    const key = byId('entry-form').querySelector('.key-save')
    key.classList.add('saved-entry-key')
    key.insertAdjacentHTML('afterbegin', icon('check', 16))
    const mark = key.firstElementChild
    playMotion(mark, [{ opacity: .2, transform: 'scale(.68)' }, { opacity: 1, transform: 'scale(1)' }], 180)
    setTimeout(() => { mark.remove(); key.classList.remove('saved-entry-key') }, 700)
  }
  toast(previous ? t('流水已更新') : t('流水已保存'), true)
  await refreshRates()
}

async function saveCategoryDraft(parentId, direction, value, chosenIcon, previous) {
  const name = previous && value === categoryName(previous) ? previous.name : value.normalize('NFKC').trim()
  if (!name || name.length > 24) return { error: t('请输入 1 到 24 个字符的名称。') }
  if (state.categories.some(item => item.id !== previous?.id && item.parentId === parentId && item.direction === direction && categoryName(item) === name)) {
    return { error: t('同级分类中已有这个名称。') }
  }
  const parent = state.categories.find(item => item.id === parentId)
  const icon = iconNames.has(chosenIcon) ? chosenIcon : startingIcon(previous ?? parent)
  const category = { id: previous?.id ?? crypto.randomUUID(), parentId, direction, name, icon }
  const result = await saveCategory(category, { editing: Boolean(previous) })
  if (result === 'duplicate') return { error: t('同级分类中已有这个名称。') }
  if (result === 'missing') return { error: t('分类已不存在，请关闭后重试。') }
  return { id: category.id }
}

async function submitCategory(form) {
  const previous = state.categories.find(item => item.id === form.dataset.id)
  if (form.dataset.id && !previous) { formError(t('分类已不存在，请关闭后重试。')); return }
  const direction = form.dataset.direction || form.elements.direction.value
  const result = await saveCategoryDraft(form.dataset.parent || null, direction, form.elements.name.value, form.dataset.icon, previous)
  if (result.error) { formError(result.error); return }
  state.categoryDirection = direction
  dialog.close()
  await reload()
  main.querySelector(`[data-action="category-edit"][data-value="${CSS.escape(result.id)}"]`)?.focus({ preventScroll: true })
  toast(t('分类已保存'))
}

async function deleteCategoryFromForm(control) {
  const form = control.form
  if (form.dataset.saving) return
  const category = state.categories.find(item => item.id === form.dataset.id)
  if (!category) return
  const childrenNotice = category.parentId === null ? t('其下的所有二级分类也会一并删除。\n') : ''
  if (!confirm(t('删除「{0}」？\n{1}相关流水会保留，并归为「未分类」。', categoryName(category), childrenNotice))) return

  form.dataset.saving = 'true'
  control.disabled = true
  try {
    const result = await deleteCategory(category.id)
    if (result?.removedIds.includes(state.ledgerCategory)) state.ledgerCategory = null
    await reload()
    if (byId('category-form') === form && dialog.open) dialog.close()
    const message = result ? t('分类已删除') : t('分类已不存在')
    toast(result?.uncategorized ? t('{0}，{1} 笔流水已归为未分类', message, result.uncategorized) : message)
  } finally {
    delete form.dataset.saving
    control.disabled = false
  }
}

function submitPeriod(form) {
  const range = dateRangeFromForm(form)
  if (!range) { formError(t(invalidDateRange)); return }
  state.range = range
  state.month = range.start.slice(0, 7)
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
    const changed = control.getAttribute('aria-pressed') === 'false'
    selectCategories(form, value)
    const selected = Array.from(group.children).find(item => item.dataset.value === value)
    selected?.focus({ preventScroll: true })
    if (selected?.getAttribute('aria-expanded') === 'true') {
      selected.scrollIntoView({ block: 'nearest' })
      const panel = byId('entry-subcategories')
      panel.firstElementChild.scrollIntoView({ block: 'nearest' })
    }
    animateCategory(changed ? selected : null, opensChildren ? byId('entry-subcategories') : null)
  },
  'screen-paste': pasteFromScreen,
  'dismiss-paste': hidePaste,
  'screen-input': () => showScreenInput(),
  'screen-read': readScreenClipboard,
  'screen-guide': openScreenGuide,
  'delete-entry': async ({ value }, control) => {
    if (!confirm(t('删除这笔流水？'))) return
    control.disabled = true
    try {
      await deleteEntry(value)
      if (dialog.open && byId('entry-form')?.dataset.id === value) dialog.close()
      await reload()
      toast(t('流水已删除'))
    } finally { control.disabled = false }
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
    if (!ids.length || !confirm(t('删除选中的 {0} 笔流水？删除后无法恢复。', ids.length))) return
    control.disabled = true
    await deleteEntries(ids)
    stopSelecting()
    await reload()
    toast(t('已删除 {0} 笔流水', ids.length))
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
    const opensChildren = control.getAttribute('aria-expanded') === 'false'
    const changed = control.getAttribute('aria-pressed') === 'false'
    state.ledgerCategory = value === '*' ? null : value
    state.ledgerLimit = 60
    if (control.hasAttribute('aria-expanded')) {
      refreshLedgerCategories()
      const active = byId('ledger-category-options').querySelector('[aria-expanded="true"]')
      const children = byId('ledger-filter-children')
      active?.focus({ preventScroll: true })
      children?.firstElementChild?.scrollIntoView({ block: 'nearest' })
      animateCategory(changed ? active : null, opensChildren ? children : null)
    } else {
      setLedgerCategoriesOpen(false)
      if (changed) animateCategory(byId('ledger-category-toggle'))
    }
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
  'bulk-pick': ({ value }, control) => {
    const changed = control.getAttribute('aria-pressed') === 'false'
    const rootSelected = state.categories.find(item => item.id === value)?.parentId === null
    bulk.categoryId = value || null
    renderBulkCategory()
    const picker = dialog.querySelector('.bulk-category')
    const selected = picker.querySelector(`[data-action="bulk-pick"][data-value="${CSS.escape(value)}"]`)
    selected?.focus({ preventScroll: true })
    if (changed) animateCategory(selected, rootSelected ? picker.querySelector('.category-children') : null)
  },
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
    if (byId('map-form')?.dataset.dirty) { formError(t('列映射已更改，请重新预览。')); return }
    const position = dialog.scrollTop
    importState.limit += 40
    openImport()
    dialog.scrollTop = position
  },
  'confirm-import': () => confirmImport(),
  'export-backup': () => exportBackup(),
  'drive-settings': openDriveSettings,
  'drive-authorize': authorizeDrive,
  'drive-pause': pauseDrive,
  'drive-now': syncDriveNow,
  'export-backup-range': () => openDataRange('export'),
  'export-csv': () => openDataRange('csv'),
  'manage-feature': ({ value }) => manageFeature(value),
  'edit-feature': ({ list, value }) => featureForm(list, value),
  'remove-feature': (_, control) => removeFeature(control.form),
  'feature-categories-toggle': (_, control) => {
    const picker = control.closest('.feature-category')
    const open = control.getAttribute('aria-expanded') === 'false'
    setFeatureCategoriesOpen(picker, open)
    if (open) picker.querySelector('.category-children [aria-pressed="true"], [data-action="feature-category-pick"][aria-expanded="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  },
  'feature-categories-close': (_, control) => setFeatureCategoriesOpen(control.closest('.feature-category'), false),
  'feature-category-pick': ({ value }, control) => {
    const picker = control.closest('.feature-category')
    const hasChildren = control.hasAttribute('aria-expanded')
    const opensChildren = control.getAttribute('aria-expanded') === 'false'
    const changed = control.getAttribute('aria-pressed') === 'false'
    picker.querySelector('[name="category"]').value = value
    setFeatureCategoriesOpen(picker, hasChildren)
    if (hasChildren) {
      const active = picker.querySelector('[aria-expanded="true"][data-action="feature-category-pick"]')
      const children = picker.querySelector('.category-children')
      active?.focus({ preventScroll: true })
      active?.scrollIntoView({ block: 'nearest' })
      children?.firstElementChild?.scrollIntoView({ block: 'nearest' })
      animateCategory(changed ? active : null, opensChildren ? children : null)
    } else if (changed) animateCategory(picker.querySelector('.feature-category-toggle'))
  },
  'bill-from-entry': ({ value }) => billFromEntry(value),
  'review-due-bills': openDueBills,
  'review-bill': ({ value, due }) => {
    const occurrence = dueBills().find(item => item.bill.id === value && item.due === due)
    if (occurrence) openEntry(null, null, occurrence)
  },
  'delete-entry-range': () => openDataRange('delete'),
  'clear-ledger': openClearLedger,
  'pick-backup': () => pickFile('file-backup'),
  'confirm-restore': async (_, control) => {
    const request = pendingBackup
    if (!request) return
    control.disabled = true
    try {
      const { restored, latestDate, skippedDates, changed } = await restoreLedger(request.backup, request.signature)
      const active = dialog.open && dialog.contains(control)
      if (changed) {
        await reload()
        if (active && pendingBackup === request) previewBackup(request.backup, true)
        return
      }
      if (!restored) {
        const message = t('备份流水与其他日期的现有流水冲突，本次没有替换任何流水。')
        if (active) formError(message)
        else toast(message)
        return
      }
      if (pendingBackup === request) pendingBackup = null
      if (active) dialog.close()
      await reload()
      if (active && !dialog.open) {
        resetLedgerFilters()
        state.month = latestDate.slice(0, 7)
        state.range = null
        go('home')
      }
      toast(t('已恢复 {0} 笔流水{1}', restored, skippedDates ? t('，跳过 {0} 个冲突日期', skippedDates) : ''))
    } finally { control.disabled = false }
  },
  close: () => dialog.close()
}

async function handleError(error) {
  console.error(error)
  formError(t('操作未完成，请检查设备存储后重试。'))
}

document.addEventListener('click', event => {
  const control = event.target.closest('[data-action]')
  if (!control || control.disabled || control.inert) return
  if (ignoreSwipeClick && event.detail && control.closest('.transaction-swipe')) {
    // A touch that moved the row can still generate a click after release.
    ignoreSwipeClick = false
    event.preventDefault()
    return
  }
  if (control === swipedRow?.firstElementChild) { showSwipedRow(); return }
  try { Promise.resolve(actions[control.dataset.action]?.(control.dataset, control)).catch(handleError) }
  catch (error) { handleError(error) }
})

const forms = {
  'drive-config-form': submitDriveConfig,
  'entry-form': submitEntry, 'category-form': submitCategory, 'period-form': submitPeriod, 'map-form': mappingSubmit,
  'data-range-form': submitDataRange, 'clear-ledger-form': submitClearLedger, 'feature-form': submitFeature,
  'screen-form': form => applyScreenText(form.elements.screenText.value)
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
  if (control.dataset.importRow) {
    const number = Number(control.dataset.importRow)
    const { entry } = importState.preview.find(item => item.number === number)
    importState.overrides.set(number, control.value)
    const draft = importEntryDraft(number, entry)
    const row = control.closest('.import-row')
    const category = row.querySelector('.import-category')
    category.hidden = draft.direction === 'transfer'
    category.textContent = importCategoryLabel(draft.categoryId)
    row.querySelector('strong').textContent = draft.note || directionLabel(draft.direction)
    return
  }
  const form = control.form
  if (form?.id === 'feature-form' && control.name === 'cycle' && form.dataset.sourceDay) {
    if (form.elements.start.value === form.dataset.suggestedStart) {
      const next = nextFutureBillDate(form.dataset.sourceDay, todayTokyo(), control.value) ?? ''
      form.elements.start.value = form.dataset.suggestedStart = next
    }
    return
  }
  if (form?.id === 'data-range-form') {
    if (control.name === 'month' && control.value) {
      const { start, end } = monthBounds(control.value)
      form.elements.start.value = start
      form.elements.end.value = end
    }
    formError('')
    updateDataRange(form)
    return
  }
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
  const picker = event.target.closest('.feature-category')
  if (event.key === 'Escape' && picker?.querySelector('.feature-category-toggle')?.getAttribute('aria-expanded') === 'true') {
    event.preventDefault()
    setFeatureCategoriesOpen(picker, false)
    return
  }
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

byId('file-import').addEventListener('change', async event => {
  const file = event.target.files?.[0]
  if (!file) return
  openDialog(t('导入账单'), `<p id="import-loading" class="fine">${t('正在读取文件…')}</p>`)
  const indicator = byId('import-loading')
  try {
    const parsed = await readFile(file)
    if (dialog.open && byId('import-loading') === indicator) {
      importState = { file: parsed, overrides: new Map() }
      chooseSheet(parsed.sheetNames[0])
    }
  } catch (error) {
    if (dialog.open && byId('import-loading') === indicator) {
      openDialog(t('导入账单'), `<p class="form-error">${escape(error.message ? t(error.message) : t('无法读取这个表格。'))}</p>`)
    }
  } finally { if (event.target.files?.[0] === file) event.target.value = '' }
})

function previewBackup(backup, changed = false) {
  const plan = planBackupRestore(state.entries, backup.entries)
  pendingBackup = { backup, signature: restorePlanSignature(plan) }
  const labels = { add: '新增', replace: '替换', skip: '跳过（日期冲突）' }
  openDialog(t('确认恢复备份'), `<div class="form-grid">
    ${changed ? `<p class="form-error">${t('账本已变化，已更新恢复预览。请重新确认。')}</p>` : ''}
    <p>${t('备份包含 {0} 笔流水，共 {1} 个日期。', backup.entries.length, plan.changes.length)}</p>
    <div class="restore-days" tabindex="0" role="region" aria-label="${t('按日期预览')}">
      <table><thead><tr><th scope="col">${t('日期')}</th><th scope="col">${t('处理方式')}</th>
        <th scope="col">${t('本机笔数')}</th><th scope="col">${t('备份笔数')}</th></tr></thead>
        <tbody>${plan.changes.map(item => `<tr><th scope="row">${dayLabel(item.date)}</th>
          <td>${t(labels[item.action])}</td><td>${item.previous}</td><td>${item.incoming}</td></tr>`).join('')}</tbody>
      </table></div>
    <p class="fine">${t('只替换预览中标为「替换」的日期。')}</p>
    ${errorPlaceholder}<div class="form-footer">${cancelButton()}
      ${button('confirm-restore', t('按日期恢复'), plan.entries.length ? '' : 'disabled', '', 'danger')}</div></div>`)
}

byId('file-backup').addEventListener('change', async event => {
  const file = event.target.files?.[0]
  if (!file) return
  pendingBackup = null
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error(t('备份文件超过 32 MB。'))
    const backup = validateBackup(JSON.parse(await file.text()))
    if (event.target.files?.[0] !== file) return
    if (!backup.entries.length) {
      openDialog(t('恢复备份'), `<p class="fine">${t('这份备份没有流水，没有可恢复的日期。')}</p><div class="form-footer">${button('close', t('关闭'))}</div>`)
      return
    }
    previewBackup(backup)
  } catch {
    if (event.target.files?.[0] === file) openDialog(t('恢复备份'), `<p class="form-error">${t('无法读取备份。请选择由小日账导出的有效 JSON 文件。')}</p>`)
  } finally { if (event.target.files?.[0] === file) event.target.value = '' }
})

function updateConnectivity() {
  chrome()
  syncDriveNow()
  if (navigator.onLine) refreshRates().catch(handleError)
}
window.addEventListener('online', updateConnectivity)
window.addEventListener('offline', updateConnectivity)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); hidePaste(); return }
  // Coming back from another app usually means a shortcut just copied a payment screen.
  if (Date.now() - hiddenAt > 1500) offerPaste()
  queueDriveSync(0)
  reload().then(() => refreshRates()).catch(handleError)
})
document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || dialog.open) return
  if (event.key === 'Escape') {
    if (swipedRow) {
      event.preventDefault()
      resetEntrySwipe()
    } else if (state.ledgerSearchOpen && ['ledger-search', 'ledger-search-toggle'].includes(event.target.id)) {
      event.preventDefault()
      setLedgerSearchOpen(false)
    } else if (state.ledgerCategoriesOpen && (event.target.id === 'ledger-category-toggle' || byId('ledger-category-picker')?.contains(event.target))) {
      setLedgerCategoriesOpen(false)
    } else if (state.selecting) { stopSelecting(); refreshLedgerResults() }
  }
  // Search runs as you type; Enter just puts the phone keyboard away.
  if (event.key === 'Enter' && event.target.id === 'ledger-search') event.target.blur()
})

main.addEventListener('toggle', event => {
  if (event.target.id === 'category-budget-details') state.budgetExpanded = event.target.open
}, true)

main.addEventListener('change', event => {
  const control = event.target
  if (control.id !== 'app-language' || control.value === language) return
  try {
    saveLanguage(control.value)
    applyLanguage()
    render()
    byId('app-language').focus({ preventScroll: true })
  } catch (error) {
    control.value = language
    handleError(error)
  }
})

main.addEventListener('input', event => {
  if (event.target.id !== 'ledger-search') return
  state.ledgerQuery = event.target.value
  state.ledgerLimit = 60
  refreshLedgerResults()
})

document.addEventListener('pointerdown', event => {
  if (!byId('quick-paste').hidden && !event.target.closest('#quick-paste')) hidePaste()
  beginEntrySwipe(event)
})
document.addEventListener('pointermove', moveEntrySwipe, { passive: true })
document.addEventListener('pointerup', finishEntrySwipe)
document.addEventListener('pointercancel', finishEntrySwipe)
setInterval(() => {
  if (!document.hidden && navigator.onLine) refreshRates().catch(handleError)
}, 5 * 60 * 1000)

driveEvents.addEventListener('status', paintDriveSettings)
driveEvents.addEventListener('ledger', () => {
  const search = byId('ledger-search')
  if (search && document.activeElement === search && state.view === 'home') {
    readLedger().then(ledger => {
      Object.assign(state, ledger)
      if (byId('ledger-results')) refreshLedgerResults()
    }).catch(handleError)
  } else reload().catch(handleError)
})
setInterval(() => { if (!document.hidden) syncDriveNow() }, 60000)

function applyLanguage() {
  document.documentElement.lang = language
  document.title = t('小日账')
  document.querySelector('meta[name="description"]').content = t('小日账，适合 iPhone 的个人收支账本。')
  for (const id of ['sidebar', 'mobile-nav']) byId(id).setAttribute('aria-label', t('主要导航'))
  byId('select-bar').setAttribute('aria-label', t('多选操作'))
  byId('notice').textContent = ''
  const loading = main.querySelector('.initial')
  if (loading) loading.textContent = t('正在打开账本…')
  byId('quick-paste').innerHTML = `<button type="button" class="quick-paste-main" data-action="screen-paste">${t('{0}粘贴屏幕账单', icon('scan', 18))}</button>
    <button type="button" class="quick-paste-close" data-action="dismiss-paste" aria-label="${t('关闭')}">${icon('close', 16)}</button>`
}

async function start() {
  initializeLanguage()
  applyLanguage()
  try {
    await reload()
    initializeDrive().catch(handleError)
    offerPaste()
    refreshRates().catch(handleError)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then(() => {
        offlineReady = true
        chrome()
      }).catch(error => console.warn(t('离线缓存暂时不可用'), error))
    }
  } catch (error) {
    console.error(error)
    chrome()
    main.innerHTML = `<div class="panel"><h1>${t('无法打开账本')}</h1><p class="fine">${t('请检查浏览器是否允许本地存储，然后重新打开应用。')}</p></div>`
  }
}
start()
