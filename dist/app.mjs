import {
  amountMinor, dateTime, directions, duplicatePreviews, importRows, money, monthBounds, offsetDate, statementColumns,
  summarize, tokyoNow, withQuotes, within
} from './core.mjs'
import {
  addEntries, backupDocument, completeRates, deleteEntry, readLedger, restoreLedger,
  saveCategory, saveCurrency, saveEntry, validateBackup
} from './storage.mjs'
import { loadQuotes, quotesFor } from './rates.mjs'
import { guessColumns, readFile } from './tables.mjs'
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
  statsDirection: 'expense', categoryDirection: 'expense', trendPage: 0
}
const viewNames = { home: ['账本', 'ledger'], overview: ['报表', 'chart'], categories: ['分类', 'tag'] }
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const phone = standalone || matchMedia('(pointer: coarse)').matches
let importState
let hiddenAt = 0
let pasteTimer
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
  const active = (state.view === view || (view === 'home' && state.view === 'ledger')) ? 'aria-current="page"' : ''
  return `<button class="nav-link" data-action="navigate" data-value="${view}" ${active} type="button">${icon(glyph, 19)}${label}</button>`
}

function chrome() {
  const status = navigator.onLine ? (offlineReady ? '本机账本 · 可离线使用' : '本机账本') : '离线模式'
  byId('sidebar').innerHTML = `${brand('sidebar-brand')}<nav class="side-nav">${Object.keys(viewNames).map(navLink).join('')}</nav>
    <div class="side-foot"><button class="side-extra" type="button" data-action="backup">${icon('shield')}设置与备份</button>
    <div class="side-status"><span class="dot ${navigator.onLine ? '' : 'off'}"></span>${status}</div></div>`
  byId('topbar').innerHTML = `${brand('mobile-brand')}
    <div class="top-actions">${icoButton('screen-paste', 'scan', '粘贴屏幕账单')}
    ${icoButton('pick-import', 'upload', '导入账单')}
    <span class="desktop-add">${button('add', '记一笔', '', 'plus', 'primary')}</span></div>`
  byId('mobile-nav').innerHTML = `${navLink('home')}${navLink('overview')}
    <button class="mobile-add" type="button" data-action="add" aria-label="记一笔">${icon('plus', 26)}</button>
    ${navLink('categories')}<button class="nav-link" type="button" data-action="backup" aria-label="设置与备份">${icon('settings', 20)}设置</button>`
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
      <div class="day-rows">${group.slice(0, remaining).map(entry => transaction(entry, state.categories, state.currency, true)).join('')}</div>
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
      <section class="book-activity">
        <div class="activity-head"><h2>流水</h2><button class="plain" type="button" data-action="navigate" data-value="ledger">筛选</button></div>
        <div class="day-stack">${dayCards(entries)}</div>
        ${entries.length > state.ledgerLimit ? button('more-ledger', '显示更多') : ''}
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
  const restrictions = [state.ledgerDay && (range.start === range.end ? dayLabel(range.start) : `${range.start} ～ ${range.end}`),
    state.ledgerCategory !== null && (category?.name ?? '未分类')].filter(Boolean)
  return `<div class="page-heading"><div><h1>流水</h1><p>${filtered.length} 笔记录</p></div>${periodControls()}</div>
    <div class="ledger-filter">
    ${tabs('ledger-direction', { all: '全部', expense: directions.expense, income: directions.income }, state.ledgerDirection)}
    ${button('pick-import', '导入账单', '', 'upload')}</div>
    ${restrictions.length ? `<button class="filter-tag" type="button" data-action="clear-drill" aria-label="清除当前细分筛选">${escape(restrictions.join(' · '))} ×</button>` : ''}
    <div class="day-stack">${dayCards(filtered)}</div>
    ${filtered.length > state.ledgerLimit ? button('more-ledger', '显示更多') : ''}`
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
  main.innerHTML = ({ home, overview, ledger, categories: categoryPage })[state.view]()
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

function createCategory(parentId) {
  const parent = state.categories.find(item => item.id === parentId)
  openDialog(parent ? '新增二级分类' : '新增一级分类', `<form id="category-form" class="form-grid" data-parent="${parent?.id ?? ''}">
    ${parent ? `<p class="fine">${directions[parent.direction]} · ${escape(parent.name)}</p>` : selectField('收支类型', 'direction', ['expense', 'income'].map(id => option(id, directions[id], state.categoryDirection)).join(''))}
    ${field('分类名称', '<input name="name" maxlength="24" required placeholder="输入分类名称">')}
    ${errorPlaceholder}<div class="form-footer">${cancelButton}${submitButton('保存分类')}</div></form>`)
}

function selectCategories(form, selectedId = '') {
  const direction = form.elements.direction.value
  const selected = state.categories.find(item => item.id === selectedId && item.direction === direction)
  const rootId = selected?.parentId ?? selected?.id ?? ''
  const section = form.querySelector('.entry-categories')
  const strip = section.querySelector('.category-strip')
  const childGrid = section.querySelector('.category-children')
  form.elements.category.value = selected?.id ?? ''
  section.querySelector('.category-adder').hidden = true
  section.hidden = direction === 'transfer'
  if (section.hidden) return
  const pill = (item, active) => `<button type="button" class="entry-cat" aria-pressed="${active}" data-action="entry-category" data-value="${item.id}">
    ${categoryArt(item.icon, 19)}<span>${escape(item.name)}</span></button>`
  const roots = [...topCategories(direction), { id: '', name: '未分类', icon: 'tag' }]
  strip.innerHTML = roots.map(item => pill(item, item.id === rootId)).join('') +
    `<button type="button" class="entry-cat entry-add" data-action="category-add" data-value="" aria-label="新增${directions[direction]}一级分类">
    <span class="category-icon">${icon('plus', 18)}</span><span>添加</span></button>`
  // A chosen top-level category always offers its own add slot, even before it has subcategories.
  const root = state.categories.find(item => item.id === rootId)
  childGrid.hidden = !root
  childGrid.innerHTML = root ? children(rootId).map(item => pill(item, item.id === selectedId)).join('') +
    `<button type="button" class="entry-cat entry-add" data-action="category-add" data-value="${escape(rootId)}" aria-label="在${escape(root.name)}下新增二级分类">${icon('plus', 14)}<span>添加</span></button>` : ''
  section.querySelector('.entry-category-name').textContent = selected?.name ?? '未分类'
}

function openCategoryAdder(form, parentId) {
  const parent = state.categories.find(item => item.id === parentId)
  const adder = form.querySelector('.category-adder')
  const input = adder.querySelector('input')
  adder.dataset.parent = parent?.id ?? ''
  adder.querySelector('.category-adder-error').textContent = ''
  input.value = ''
  input.placeholder = parent ? `「${parent.name}」下的新分类` : `新的${directions[form.elements.direction.value]}一级分类`
  adder.hidden = false
  input.focus()
}

// Adds the category without leaving the entry sheet, then selects it so the draft keeps going.
async function saveInlineCategory(form) {
  const adder = form.querySelector('.category-adder')
  if (adder.dataset.saving) return
  const parent = state.categories.find(item => item.id === adder.dataset.parent)
  adder.dataset.saving = 'true'
  try {
    const result = await addCategory(parent?.id ?? null, parent?.direction ?? form.elements.direction.value, adder.querySelector('input').value)
    if (result.error) { adder.querySelector('.category-adder-error').textContent = result.error; return }
    await reload()
    if (byId('entry-form') === form) selectCategories(form, result.id)
    toast('分类已添加')
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
  if (!duplicate) return `<p class="screen-review">${icon('scan', 18)}<span>${screenReview[screen.status]}</span></p>`
  const category = state.categories.find(item => item.id === duplicate.categoryId)
  const when = `${Number(duplicate.at.slice(5, 7))}月${Number(duplicate.at.slice(8, 10))}日 ${duplicate.at.slice(11, 16)}`
  return `<p class="screen-review warn">${icon('scan', 18)}<span>可能已经记过：${when} · ${escape(duplicate.note || category?.name || '未分类')} ${money(duplicate.minor, duplicate.currency)}。确认不是同一笔再保存。</span></p>`
}

// Transfers are no longer offered, except to keep an existing transfer editable as it is.
const directionsFor = current => Object.entries(directions).filter(([key]) => key !== 'transfer' || current === 'transfer')
const dayText = day => !dateTime(day) ? '选择日期' : day === tokyoNow().slice(0, 10) ? '今天' : day.replaceAll('-', '/')

function openEntry(id, screen) {
  const entry = state.entries.find(item => item.id === id)
  if (id && !entry) return
  hidePaste()
  const at = entry?.at ?? screen?.at ?? tokyoNow()
  const currency = entry?.currency ?? (screen ? screen.currency ?? '' : 'JPY')
  const amount = entry ? amountText(entry.minor, currency) : screen?.amount ?? ''
  const direction = entry?.direction ?? screen?.direction ?? 'expense'
  const choices = (screen ? option('', '请选择币种', currency) : '') + currencyOptions(currency)
  const directionChoices = directionsFor(direction).map(([key, label]) => `<label class="entry-direction">
    <input class="sr-only" type="radio" name="direction" value="${key}"${direction === key ? ' checked' : ''}>
    <span>${label}</span></label>`).join('')
  openDialog(entry ? '编辑流水' : screen ? '核对屏幕账单' : '记一笔', `<form id="entry-form" data-id="${entry?.id ?? ''}">
    <div class="entry-content">
    ${screen ? screenNotice(screen) : ''}
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
    <section class="entry-categories" aria-label="选择分类">
      <input type="hidden" name="category">
      <div class="entry-category-heading"><h3>分类</h3><span class="entry-category-name"></span></div>
      <div class="category-strip" aria-label="一级分类"></div>
      <div class="category-children" aria-label="二级分类"></div>
      <div class="category-adder" hidden>
        <input class="control" type="text" maxlength="24" autocomplete="off" enterkeyhint="done" aria-label="新分类名称">
        <button type="button" class="button" data-action="category-add-cancel">取消</button>
        <button type="button" class="button primary" data-action="category-add-save">添加</button>
        <span class="category-adder-error" role="alert"></span>
      </div>
    </section></div>
    <div class="entry-footer">
    <div class="entry-note">
      <label><span class="sr-only">备注</span><textarea name="note" maxlength="500" rows="1" placeholder="填写备注">${escape(entry?.note ?? screen?.note ?? '')}</textarea></label>
      ${entry ? icoButton('delete-entry', 'trash', '删除流水', `data-value="${entry.id}"`) : ''}
    </div>
    ${errorPlaceholder}</div>
    ${keypad(entry || screen)}</form>`, 'entry')
  const form = byId('entry-form')
  selectCategories(form, entry?.categoryId ?? screen?.categoryId)
  updateEntryCurrency(form)
  refreshEntryQuote(form, true)
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
      <li>在付款或收款详情上轻点背面两下，手机会回到主屏幕。打开小日账，点底部弹出的「粘贴屏幕账单」，再点系统的「粘贴」。</li>
      <li>金额、币种、时间、商户会自动填好；同一商户会沿用上次的分类，常见店铺也会自动选分类。核对后点「保存」。</li>
    </ol>
    <div class="form-footer">
      <a class="button leading" href="shortcuts://create-shortcut">打开快捷指令</a>
      ${button('screen-input', '返回屏幕记账')}
    </div></div>`)
}

function showScreenInput(unread = false) {
  hidePaste()
  openDialog('屏幕记账', `<form id="screen-form" class="form-grid">
    <p class="fine">${unread ? '没有读到剪贴板里的账单文字。' : ''}在付款或收款页面运行快捷指令后，可从剪贴板读取屏幕文字，也可以长按下方输入框粘贴。</p>
    ${field('识别出的文字', `<textarea name="screenText" maxlength="${screenTextLimit}" placeholder="粘贴快捷指令识别出的账单文字" spellcheck="false"></textarea>`)}
    ${errorPlaceholder}
    <div class="form-footer">
      ${button('screen-guide', '配置轻点背面', '', '', 'leading')}
      ${button('screen-read', '读取剪贴板')}
      ${submitButton('识别并预填')}
    </div></form>`)
}

function applyScreenText(text) {
  if (!text.trim()) {
    formError('这里还没有账单文字。运行快捷指令后再粘贴。')
    return
  }
  const draft = parseScreenText(text)
  openEntry(null, { ...draft, categoryId: suggestCategory(draft, text, state.entries, state.categories) })
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
  if (!phone || dialog.open) return
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

function openBackup() {
  openDialog('设置与备份', `<div class="form-grid">
    <p class="fine">${offlineReady ? '应用已准备就绪，可离线记账。' : '首次联网打开时会准备离线应用。'}账本数据保存在当前设备。</p>
    ${standalone ? '' : '<p class="fine">在 iPhone 的 Safari 里轻点「分享」→「添加到主屏幕」，开启「作为 Web App 打开」。安装后从主屏幕开始记账。</p>'}
    <div class="backup-actions">${button('export-backup', '导出完整备份', '', '', 'primary')}${button('pick-backup', '恢复备份')}${button('screen-guide', '配置屏幕记账', '', 'scan')}</div>
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
        ${directionsFor(direction).map(([id, label]) => option(id, label, direction)).join('')}</select>`}</div>`
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

async function addCategory(parentId, direction, value) {
  const name = value.normalize('NFKC').trim()
  if (!name || name.length > 24) return { error: '请输入 1 到 24 个字符的名称。' }
  const taken = { error: '同级分类中已有这个名称。' }
  if (state.categories.some(item => item.parentId === parentId && item.direction === direction && item.name === name)) return taken
  const parent = state.categories.find(item => item.id === parentId)
  const category = { id: crypto.randomUUID(), parentId, direction, name, icon: parent?.icon ?? 'tag' }
  return await saveCategory(category) ? { id: category.id } : taken
}

async function submitCategory(form) {
  const parent = state.categories.find(item => item.id === form.dataset.parent)
  const direction = parent?.direction ?? form.elements.direction.value
  const result = await addCategory(parent?.id ?? null, direction, form.elements.name.value)
  if (result.error) { formError(result.error); return }
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
  'entry-key': ({ value }) => pressEntryKey(byId('entry-form'), value),
  'entry-category': ({ value }, control) => {
    const form = byId('entry-form')
    const group = control.parentElement
    selectCategories(form, value)
    Array.from(group.children).find(item => item.dataset.value === value)?.focus({ preventScroll: true })
  },
  'screen-paste': pasteFromScreen,
  'dismiss-paste': hidePaste,
  'screen-input': () => showScreenInput(),
  'screen-read': readScreenClipboard,
  'screen-guide': openScreenGuide,
  'delete-entry': async ({ value }) => {
    if (!confirm('删除这笔流水？')) return
    await deleteEntry(value)
    dialog.close()
    await reload()
    toast('流水已删除')
  },
  'category-new': ({ value }) => createCategory(value),
  'category-add': ({ value }) => openCategoryAdder(byId('entry-form'), value),
  'category-add-cancel': () => { byId('entry-form').querySelector('.category-adder').hidden = true },
  'category-add-save': () => saveInlineCategory(byId('entry-form')),
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
  'entry-form': submitEntry, 'category-form': submitCategory, 'period-form': submitPeriod, 'map-form': mappingSubmit,
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
  if (!event.isComposing && event.keyCode !== 229) saveInlineCategory(event.target.form).catch(handleError)
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
