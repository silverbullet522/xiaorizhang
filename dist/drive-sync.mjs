import { emptyReplica, equalData, mergeLedgerChanges, readReplica, replicaLedger } from './sync-ledger.mjs'
import { applyDriveState, backupDocument, ledgerChanges, readDriveState, validateBackup } from './storage.mjs'
import { loadGoogleOAuth, validGoogleClient } from './google-auth.mjs'

const scope = 'https://www.googleapis.com/auth/drive.appdata'
const driveUrl = 'https://www.googleapis.com/drive/v3'
const uploadUrl = 'https://www.googleapis.com/upload/drive/v3'
const name = 'xiaorizhang-ledger-sync.json'
const preference = 'hiba-drive-client'
const sessionKey = 'hiba-drive-session'

export const driveEvents = new EventTarget()
export const driveStatus = { clientId: '', linked: false, email: '', ready: false, authorized: false, phase: 'idle', time: null }
let session
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
    if (value) sessionStorage.setItem(sessionKey, JSON.stringify(value))
    else sessionStorage.removeItem(sessionKey)
  } catch { /* Synchronization remains available for this page session. */ }
}

function showBinding(sync) {
  driveStatus.linked = Boolean(sync)
  driveStatus.email = sync?.email ?? ''
  if (sync) driveStatus.clientId = sync.clientId
}

export async function initializeDrive() {
  const { sync } = await readDriveState()
  try {
    const clientId = localStorage.getItem(preference)
    if (validGoogleClient(clientId)) driveStatus.clientId = clientId
    const stored = JSON.parse(sessionStorage.getItem(sessionKey))
    if (stored?.clientId === (sync?.clientId ?? driveStatus.clientId) && stored.token && stored.expires > Date.now()) {
      setSession(stored)
    }
  } catch { /* Unavailable storage or an expired session requires authorization. */ }
  showBinding(sync)
  report(session ? 'idle' : sync ? 'authorize' : 'idle')
  queueDriveSync()
}

export function configureDrive(clientId) {
  const value = clientId.trim()
  if (!validGoogleClient(value) || (driveStatus.linked && value !== driveStatus.clientId)) return false
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
  if (!driveStatus.clientId || !navigator.onLine || driveStatus.ready || googleTask) return
  googleTask = loadGoogleOAuth().then(() => {
    driveStatus.ready = true
    report(driveStatus.phase === 'google-unavailable' ? 'idle' : driveStatus.phase)
  }).catch(() => report('google-unavailable')).finally(() => { googleTask = null })
}

export function authorizeDrive() {
  if (!navigator.onLine) { report('offline'); return }
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
  setSession(null)
  clearTimeout(timer)
  pending = false
  report('paused')
}

export function queueDriveSync(delay = 500) {
  if (!session) return
  clearTimeout(timer)
  timer = setTimeout(syncDriveNow, delay)
}

export function syncDriveNow() {
  if (!session) return
  if (!navigator.onLine) { report('offline'); return }
  if (session.expires <= Date.now()) { setSession(null); report('authorize'); return }
  if (syncTask) { pending = true; return syncTask }
  const active = session
  report('syncing')
  syncTask = synchronize(active).then(() => {
    if (session === active) {
      driveStatus.time = new Date()
      report('synced')
    }
  }).catch(error => {
    if (session !== active) return
    if (error.message === 'wrong-account' || error.status === 401) setSession(null)
    const phase = !navigator.onLine ? 'offline' : error.status === 401 ? 'authorize' :
      ['wrong-account', 'invalid-cloud'].includes(error.message) ? error.message : 'error'
    report(phase)
  }).finally(() => {
    syncTask = null
    if (pending) { pending = false; queueDriveSync() }
  })
  return syncTask
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
    showBinding({ clientId: active.clientId, email: about.emailAddress ?? '' })
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
