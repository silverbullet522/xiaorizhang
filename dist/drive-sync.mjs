import { emptyReplica, equalData, mergeLedgerChanges, readReplica, replicaLedger } from './sync-ledger.mjs'
import { applyDriveState, backupDocument, ledgerChanges, readDriveState, validateBackup } from './storage.mjs'

const scope = 'https://www.googleapis.com/auth/drive.appdata'
const driveUrl = 'https://www.googleapis.com/drive/v3'
const uploadUrl = 'https://www.googleapis.com/upload/drive/v3'
const name = 'xiaorizhang-ledger-sync.json'
const preference = 'hiba-drive-client'
const sessionKey = 'hiba-drive-session'
const serviceKey = 'hiba-drive-authorization'
const validClient = value => typeof value === 'string' && /^[a-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/i.test(value)

export const driveEvents = new EventTarget()
export const driveStatus = { clientId: '', linked: false, email: '', ready: false, authorized: false, phase: 'idle', time: null,
  serviceUrl: '', paused: false, needsConsent: false }
let session
let automatic
let boundAccount = ''
let googleTask
let syncTask
let timer
let pending = false

function report(phase) {
  driveStatus.phase = phase
  driveEvents.dispatchEvent(new Event('status'))
}

function setSession(value) {
  session?.controller.abort()
  session = value ? { ...value, controller: new AbortController() } : null
  driveStatus.authorized = Boolean(session)
  try {
    if (value && !value.automatic) sessionStorage.setItem(sessionKey, JSON.stringify(value))
    else sessionStorage.removeItem(sessionKey)
  } catch { /* Synchronization remains available for this page session. */ }
}

function showBinding(sync) {
  driveStatus.linked = Boolean(sync)
  driveStatus.email = sync?.email ?? ''
  if (sync) driveStatus.clientId = sync.clientId
  boundAccount = sync?.account ?? ''
}

function serviceUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.href === url.origin + '/') return url.origin
  } catch { /* A complete HTTPS service address is required. */ }
  return ''
}

function showService(service) {
  automatic = service
  driveStatus.serviceUrl = service?.url ?? ''
  driveStatus.paused = Boolean(service?.paused)
  driveStatus.needsConsent = false
  if (service) driveStatus.clientId = service.clientId
}

function saveService(service) {
  if (service) localStorage.setItem(serviceKey, JSON.stringify(service))
  else localStorage.removeItem(serviceKey)
  showService(service)
}

export async function initializeDrive() {
  const { sync } = await readDriveState()
  showBinding(sync)
  try {
    const clientId = localStorage.getItem(preference)
    if (!sync && validClient(clientId)) driveStatus.clientId = clientId
    const service = JSON.parse(localStorage.getItem(serviceKey))
    if (service && serviceUrl(service.url) === service.url && validClient(service.clientId) &&
        /^[A-Za-z0-9_-]{43}$/.test(service.device) && (!sync || sync.clientId === service.clientId)) showService(service)
    const stored = JSON.parse(sessionStorage.getItem(sessionKey))
    if (!automatic && stored?.clientId === driveStatus.clientId && stored.token && stored.expires > Date.now()) {
      setSession(stored)
    }
  } catch { /* Unavailable storage or an expired session requires authorization. */ }
  const url = new URL(location.href)
  const outcome = url.searchParams.get('drive_auth')
  if (outcome) {
    url.searchParams.delete('drive_auth')
    history.replaceState(history.state, '', url)
  }
  if (automatic && !automatic.paused && ['denied', 'wrong-account', 'service-error'].includes(outcome)) {
    driveStatus.needsConsent = true
    report(outcome === 'service-error' ? 'auth-service-error' : outcome)
    return
  }
  report(automatic?.paused ? 'paused' : session || automatic ? 'idle' : sync ? 'authorize' : 'idle')
  queueDriveSync()
}

async function serviceRequest(url, path, method = 'GET', secret) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url + path, { method, signal: controller.signal, credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer', headers: secret ? { Authorization: 'Bearer ' + secret } : {} })
    return { status: response.status, ok: response.ok, data: response.ok && response.status !== 204 ? await response.json() : null }
  } finally { clearTimeout(timeout) }
}

export async function configureDriveService(value) {
  const url = serviceUrl(value.trim())
  if (!url || automatic) return 'invalid-url'
  let config
  try {
    const response = await serviceRequest(url, '/v1/config')
    if (!response.ok) return 'unavailable'
    config = response.data
  } catch { return 'unavailable' }
  if (config?.version !== 1 || !validClient(config.clientId)) return 'unavailable'
  if (driveStatus.linked && config.clientId !== driveStatus.clientId) return 'wrong-client'
  const device = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  saveService({ url, clientId: config.clientId, device, paused: false, pendingUntil: 0 })
  setSession(null)
  driveStatus.needsConsent = true
  report('idle')
  return 'ok'
}

export async function removeDriveService() {
  if (!automatic) return true
  const current = automatic
  if (!current.paused) pauseDrive()
  try {
    const response = await serviceRequest(current.url, '/v1/session', 'DELETE', current.device)
    if (!response.ok) return false
    if (automatic?.device === current.device) {
      saveService(null)
      if (!driveStatus.linked) driveStatus.clientId = localStorage.getItem(preference) ?? ''
      report(driveStatus.clientId ? 'authorize' : 'idle')
      prepareGoogle()
    }
    return true
  } catch { return false }
}

function startServiceAuthorization() {
  if (automatic.paused) {
    saveService({ ...automatic, paused: false })
    queueDriveSync(0)
    return
  }
  saveService({ ...automatic, pendingUntil: Date.now() + 600000 })
  setSession(null)
  report('authorizing')
  // A top-level POST lets OAuth use a first-party state cookie, even when Safari blocks third-party cookies.
  const form = document.createElement('form')
  form.action = automatic.url + '/oauth/connect'
  form.method = 'POST'
  form.hidden = true
  for (const [name, value] of Object.entries({ device: automatic.device, account: boundAccount })) {
    const input = document.createElement('input')
    Object.assign(input, { name, value, type: 'hidden' })
    form.append(input)
  }
  document.body.append(form)
  form.submit()
  form.remove()
}

async function renewDriveSession(current) {
  try {
    report('renewing')
    const response = await serviceRequest(current.url, '/v1/token', 'POST', current.device)
    if (automatic !== current) return
    if (response.status === 401) {
      if (current.pendingUntil > Date.now()) { report('authorizing'); return }
      driveStatus.needsConsent = true
      report('authorize')
      return
    }
    if (!response.ok) throw new Error('Drive authorization service unavailable')
    const result = response.data
    if (!result?.accessToken || !Number.isFinite(result.expiresIn) || result.expiresIn <= 30 || !result.account) {
      throw new Error('Invalid Drive session')
    }
    if (boundAccount && result.account !== boundAccount) {
      driveStatus.needsConsent = true
      report('wrong-account')
      return
    }
    if (current.pendingUntil) saveService({ ...current, pendingUntil: 0 })
    setSession({ clientId: current.clientId, token: result.accessToken, automatic: true, expires: Date.now() + result.expiresIn * 1000 - 15000 })
  } catch {
    if (automatic === current) report(navigator.onLine ? 'auth-service-error' : 'offline')
  }
}

export function configureDrive(clientId) {
  const value = clientId.trim()
  if (automatic || !validClient(value) || (driveStatus.linked && value !== driveStatus.clientId)) return false
  if (value !== driveStatus.clientId) {
    localStorage.setItem(preference, value)
    driveStatus.clientId = value
    setSession(null)
  }
  report('idle')
  prepareGoogle()
  return true
}

export function prepareGoogle() {
  if (automatic || !driveStatus.clientId || !navigator.onLine || driveStatus.ready || googleTask) return
  googleTask = new Promise((resolve, reject) => {
    if (globalThis.google?.accounts?.oauth2) { resolve(); return }
    const script = document.createElement('script')
    const cancel = setTimeout(() => fail(), 10000)
    function fail() {
      clearTimeout(cancel)
      script.remove()
      reject(new Error('google-unavailable'))
    }
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => {
      clearTimeout(cancel)
      if (globalThis.google?.accounts?.oauth2) resolve()
      else fail()
    }
    script.onerror = fail
    document.head.append(script)
  }).then(() => {
    driveStatus.ready = true
    report(driveStatus.phase === 'google-unavailable' ? 'idle' : driveStatus.phase)
  }).catch(() => report('google-unavailable')).finally(() => { googleTask = null })
}

export function authorizeDrive() {
  if (!navigator.onLine) { report('offline'); return }
  if (automatic) { startServiceAuthorization(); return }
  if (!driveStatus.ready) { prepareGoogle(); return }
  const clientId = driveStatus.clientId
  const oauth = globalThis.google.accounts.oauth2
  try {
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope,
      include_granted_scopes: false,
      callback: response => {
        if (driveStatus.phase !== 'authorizing') return
        if (!response.access_token || !oauth.hasGrantedAllScopes(response, scope)) { report('denied'); return }
        setSession({ clientId, token: response.access_token, expires: Date.now() + Number(response.expires_in) * 1000 - 15000 })
        queueDriveSync(0)
      },
      error_callback: () => { if (driveStatus.phase === 'authorizing') report('denied') }
    })
    report('authorizing')
    client.requestAccessToken({ prompt: driveStatus.email ? '' : 'select_account', login_hint: driveStatus.email || undefined })
  } catch { report('denied') }
}

export function pauseDrive() {
  if (automatic) saveService({ ...automatic, paused: true, pendingUntil: 0 })
  setSession(null)
  clearTimeout(timer)
  pending = false
  report('paused')
}

const driveCanSync = () => automatic ? !automatic.paused && !driveStatus.needsConsent : Boolean(session)

export function queueDriveSync(delay = 500) {
  if (!driveCanSync()) return
  clearTimeout(timer)
  timer = setTimeout(syncDriveNow, delay)
}

export function syncDriveNow() {
  if (!driveCanSync()) return
  if (!navigator.onLine) { report('offline'); return }
  if (syncTask) { pending = true; return syncTask }
  syncTask = synchronizeWithAuthorization().finally(() => {
    syncTask = null
    if (pending) { pending = false; queueDriveSync() }
  })
  return syncTask
}

async function synchronizeWithAuthorization() {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (session?.expires <= Date.now()) setSession(null)
    if (!session) {
      if (!automatic) { report('authorize'); return }
      await renewDriveSession(automatic)
      if (!session) return
    }
    const active = session
    report('syncing')
    try {
      await synchronize(active)
      if (session === active) {
        driveStatus.time = new Date()
        report('synced')
      }
    } catch (error) {
      if (session !== active) return
      if (error.message === 'wrong-account' || error.status === 401) setSession(null)
      if (active.automatic && error.status === 401 && attempt === 0 && navigator.onLine) continue
      if (active.automatic && (error.status === 401 || error.message === 'wrong-account')) driveStatus.needsConsent = true
      const phase = !navigator.onLine ? 'offline' : error.status === 401 ? 'authorize' :
        ['wrong-account', 'invalid-cloud'].includes(error.message) ? error.message : 'error'
      report(phase)
    }
    return
  }
}

function driveRequest(active, url, options = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  active.controller.signal.addEventListener('abort', abort, { once: true })
  if (active.controller.signal.aborted) abort()
  const timeout = setTimeout(abort, 20000)
  return fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + active.token, ...options.headers },
    cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal
  }).then(async response => {
    if (!response.ok && !(options.missingOk && response.status === 404)) {
      throw Object.assign(new Error('Drive request failed'), { status: response.status })
    }
    return response.status === 204 || response.status === 404 ? null : response.json()
  }).finally(() => {
    clearTimeout(timeout)
    active.controller.signal.removeEventListener('abort', abort)
  })
}

async function downloadHeads(active) {
  const heads = []
  const query = new URLSearchParams({
    spaces: 'appDataFolder', q: `name = '${name}'`, fields: 'nextPageToken,incompleteSearch,files(id)', pageSize: '100'
  })
  do {
    const page = await driveRequest(active, driveUrl + '/files?' + query)
    if (page.incompleteSearch) throw new Error('Drive search incomplete')
    for (const { id } of page.files ?? []) {
      const payload = await driveRequest(active, driveUrl + '/files/' + encodeURIComponent(id) + '?alt=media', { missingOk: true })
      if (!payload) continue
      const replica = readReplica(payload)
      validateCloud(replica)
      heads.push({ id, replica })
    }
    if (page.nextPageToken) query.set('pageToken', page.nextPageToken)
    else query.delete('pageToken')
  } while (query.has('pageToken'))
  return heads
}

function validateCloud(replica) {
  try { return validateBackup(backupDocument(replicaLedger(replica))) }
  catch { throw new Error('invalid-cloud') }
}

async function uploadHead(active, replica) {
  const boundary = crypto.randomUUID()
  const part = '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
  const meta = { name, parents: ['appDataFolder'], mimeType: 'application/json' }
  const document = { format: 'hiba-drive-sync', version: 1, replica }
  const body = `--${boundary}${part}${JSON.stringify(meta)}\r\n--${boundary}${part}${JSON.stringify(document)}\r\n--${boundary}--\r\n`
  const { id } = await driveRequest(active, uploadUrl + '/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body
  })
  if (!id) throw new Error('Drive upload was not confirmed')
  return id
}

async function synchronize(active) {
  const about = active.account ??= (await driveRequest(active, driveUrl + '/about?fields=user(permissionId,emailAddress)')).user
  if (!about?.permissionId) throw new Error('Drive account unavailable')
  const first = await readDriveState()
  const assertBinding = ({ sync }) => {
    if (sync && (sync.clientId !== active.clientId || sync.account !== about.permissionId)) throw new Error('wrong-account')
  }
  assertBinding(first)
  const heads = await downloadHeads(active)
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = attempt ? await readDriveState() : first
    if (session !== active) return
    assertBinding(current)
    const revision = crypto.randomUUID()
    const replica = mergeLedgerChanges(current.sync?.replica ?? emptyReplica(), current.ledger, heads.map(head => head.replica), {
      reset: Boolean(current.reset), time: Date.now(), id: revision
    })
    const ledger = validateCloud(replica)
    const applied = await applyDriveState(current, ledger, {
      revision, replica, clientId: active.clientId, account: about.permissionId, email: about.emailAddress ?? ''
    })
    if (!applied) continue
    showBinding({ clientId: active.clientId, email: about.emailAddress ?? '', account: about.permissionId })
    if (applied.changed) driveEvents.dispatchEvent(new Event('ledger'))
    if (session !== active) return

    // Writes are immutable. Only files included in a confirmed merged copy may be removed.
    // Equal copies keep the lowest ID so concurrent pruning cannot delete both.
    const existing = heads.filter(head => equalData(head.replica, replica)).map(head => head.id).sort()[0]
    const savedId = existing ?? await uploadHead(active, replica)
    for (const head of heads) {
      if (head.id !== savedId) await driveRequest(active, driveUrl + '/files/' + encodeURIComponent(head.id), {
        method: 'DELETE', missingOk: true
      })
    }
    return
  }
  throw new Error('Ledger kept changing during synchronization')
}

ledgerChanges.addEventListener('change', () => queueDriveSync())
