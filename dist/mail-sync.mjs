import { loadGoogleOAuth, validGoogleClient } from './google-auth.mjs'
import { emptyMail, mailAddress, scanPaymentMail } from './mail.mjs'
import { completeMailScan, readLedger, readMail, updateMail } from './storage.mjs'

const gmailUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/'
const scope = 'https://www.googleapis.com/auth/gmail.readonly'
const sessionKey = 'hiba-gmail-session'

export const mailEvents = new EventTarget()
export const mailStatus = { mailbox: emptyMail(), phase: 'idle', ready: false, authorized: false }
let session
let authorization
let scanTask
let prepareTask
let expiration
let rescan = false

function report(phase = mailStatus.phase) {
  mailStatus.phase = phase
  mailEvents.dispatchEvent(new Event('status'))
}

function setSession(value) {
  session?.controller.abort()
  clearTimeout(expiration)
  session = value ? { ...value, controller: new AbortController() } : null
  mailStatus.authorized = Boolean(session)
  try {
    if (value) sessionStorage.setItem(sessionKey, JSON.stringify(value))
    else sessionStorage.removeItem(sessionKey)
  } catch { /* The open page can still check mail. */ }
  if (session) expiration = setTimeout(expireSession, Math.max(0, session.expires - Date.now()))
}

function expireSession() {
  setSession(null)
  const linked = Boolean(mailStatus.mailbox.binding)
  report(linked ? 'authorize' : 'idle')
  if (linked) prepareMailGoogle()
}

export async function initializeMail() {
  mailStatus.mailbox = await readMail()
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey))
    if (saved?.bindingId === mailStatus.mailbox.binding?.id && saved.token && saved.expires > Date.now()) setSession(saved)
  } catch { /* Authorize again when no usable token is restored. */ }
  if (session) report('idle')
  else expireSession()
  checkMailNow()
}

export function prepareMailGoogle() {
  if (mailStatus.ready || prepareTask || !navigator.onLine) return
  prepareTask = loadGoogleOAuth().then(() => {
    mailStatus.ready = true
    report(mailStatus.phase === 'google-unavailable' ? (mailStatus.mailbox.binding ? 'authorize' : 'idle') : mailStatus.phase)
  }).catch(() => report('google-unavailable')).finally(() => { prepareTask = null })
}

async function gmail(active, path, params = {}) {
  const url = new URL(path, gmailUrl)
  url.search = new URLSearchParams(params)
  const request = new AbortController()
  const signal = active.controller.signal
  const cancel = () => request.abort()
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(cancel, 20000)
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${active.token}` },
      signal: request.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' })
    if (response.status === 404 && path.startsWith('messages/')) return null
    if (!response.ok) throw Object.assign(new Error('gmail-request'), { status: response.status })
    return await response.json()
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}

function requestFailure(error) {
  if (!navigator.onLine) return 'offline'
  return error.status === 403 ? 'forbidden' : 'error'
}

async function finishAuthorization(active, response, oauth) {
  if (authorization !== active) return
  try {
    if (!response.access_token || !oauth.hasGrantedAllScopes(response, scope)) { report('denied'); return }
    active.token = response.access_token
    const expires = Date.now() + Number(response.expires_in) * 1000 - 15000
    if (!(expires > Date.now())) { report('denied'); return }
    const profile = await gmail(active, 'profile', { fields: 'emailAddress' })
    const email = mailAddress(profile.emailAddress)
    if (!email || (active.binding && email !== active.binding.email)) { report('wrong-account'); return }
    const binding = active.binding ?? { id: crypto.randomUUID(), clientId: active.clientId, email }
    if (authorization !== active) return
    const saved = await updateMail(current => {
      if (current.binding?.id !== active.binding?.id) return current
      return { ...current, binding }
    })
    if (authorization !== active) return
    mailStatus.mailbox = saved
    if (saved.binding?.id !== binding.id) { report('wrong-account'); return }
    setSession({ bindingId: binding.id, token: active.token, expires })
    report('idle')
    checkMailNow(true)
  } catch (error) {
    if (authorization === active) report(error.status === 401 ? 'denied' : requestFailure(error))
  } finally {
    if (authorization === active) authorization = null
  }
}

export function authorizeMail(value) {
  if (!navigator.onLine) { report('offline'); return }
  if (!mailStatus.ready) { prepareMailGoogle(); return }
  if (authorization) return
  const binding = mailStatus.mailbox.binding
  const clientId = binding?.clientId ?? value?.trim()
  if (!validGoogleClient(clientId)) return
  const oauth = globalThis.google.accounts.oauth2
  const active = { binding, clientId, controller: new AbortController() }
  authorization = active
  function denied() {
    if (authorization !== active) return
    authorization = null
    report('denied')
  }
  try {
    const client = oauth.initTokenClient({ client_id: clientId, scope, include_granted_scopes: false,
      callback: response => finishAuthorization(active, response, oauth), error_callback: denied })
    report('authorizing')
    client.requestAccessToken({ prompt: binding ? '' : 'select_account', login_hint: binding?.email })
  } catch { denied() }
}

export async function refreshMail() {
  const previous = mailStatus.mailbox.binding?.id
  const mailbox = await readMail()
  mailStatus.mailbox = mailbox
  if (previous !== mailbox.binding?.id || (session && session.bindingId !== mailbox.binding?.id)) expireSession()
  else report()
}

export function resetMailSession() {
  authorization?.controller.abort()
  authorization = null
  rescan = false
  setSession(null)
  mailStatus.mailbox = emptyMail()
  report('idle')
}

export async function disconnectMail() {
  const bindingId = mailStatus.mailbox.binding?.id
  resetMailSession()
  mailStatus.mailbox = await updateMail(current => current.binding?.id === bindingId ? emptyMail() : current)
  report(mailStatus.mailbox.binding ? 'authorize' : 'idle')
}

export async function changeMailSender(address, removeId) {
  const bindingId = mailStatus.mailbox.binding?.id
  mailStatus.mailbox = await updateMail(current => {
    if (!bindingId || current.binding?.id !== bindingId) return current
    if (removeId) return { ...current, senders: current.senders.filter(item => item.id !== removeId) }
    if (current.senders.some(item => item.address === address)) return current
    return { ...current, senders: [...current.senders, { id: crypto.randomUUID(), address, cursor: null }] }
  })
  report()
  if (!removeId) checkMailNow(true)
}

export async function ignoreMailDraft(key) {
  mailStatus.mailbox = await updateMail(current => {
    if (!current.drafts.some(draft => draft.sourceKey === key)) return current
    return { ...current, drafts: current.drafts.filter(draft => draft.sourceKey !== key), handled: [...current.handled, key] }
  })
  report()
}

export function checkMailNow(queue = false) {
  if (!session || document.hidden) return
  if (session.expires <= Date.now()) { expireSession(); return }
  if (!navigator.onLine) { report('offline'); return }
  if (scanTask) { rescan ||= queue; return scanTask }
  const active = session
  scanTask = (async () => {
    const mailbox = await readMail()
    if (session !== active) return
    if (mailbox.binding?.id !== active.bindingId) {
      mailStatus.mailbox = mailbox
      expireSession()
      return
    }
    if (!mailbox.senders.length) { report('idle'); return }
    report('checking')
    const ledger = await readLedger()
    const known = ledger.entries.map(entry => entry.sourceKey).filter(key => key?.startsWith('gmail:'))
    const results = await scanPaymentMail((path, params) => gmail(active, path, params), mailbox, known)
    if (session !== active) return
    const updated = await completeMailScan(active.bindingId, results)
    if (session !== active) return
    mailStatus.mailbox = updated
    if (updated.binding?.id === active.bindingId) report('checked')
    else expireSession()
  })().catch(error => {
    if (session !== active) return
    if (error.status === 401) expireSession()
    else report(requestFailure(error))
  }).finally(() => {
    scanTask = null
    if (rescan) { rescan = false; checkMailNow() }
  })
  return scanTask
}
