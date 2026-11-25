import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const scope = 'https://www.googleapis.com/auth/drive.appdata'
const cookieName = '__Host-hiba-drive-auth'
const stateSeconds = 600
const randomKey = () => randomBytes(32).toString('base64url')
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const digest = value => createHash('sha256').update(value).digest('base64url')
const validClient = value => /^[a-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/i.test(value ?? '')
const normalizedEmail = value => String(value ?? '').trim().toLowerCase()

export function authConfig(env) {
  const app = new URL(env.APP_URL || 'https://silverbullet522.github.io/xiaorizhang/')
  const service = new URL(env.SERVICE_URL)
  if (app.protocol !== 'https:' || service.protocol !== 'https:' || service.href !== service.origin + '/' ||
      app.username || app.password || app.search || app.hash || !validClient(env.GOOGLE_CLIENT_ID) || !env.GOOGLE_CLIENT_SECRET ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.GOOGLE_OWNER_EMAIL ?? '') || !/^[0-9a-f]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY ?? '')) {
    throw new Error('Invalid Drive authorization service configuration')
  }
  return { app, service, clientId: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET,
    email: normalizedEmail(env.GOOGLE_OWNER_EMAIL), key: Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex') }
}

function seal(key, context, value) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url')
}

function unseal(key, context, text) {
  const value = Buffer.from(text, 'base64url')
  const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
  cipher.setAAD(Buffer.from(context))
  cipher.setAuthTag(value.subarray(12, 28))
  return JSON.parse(Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'))
}

const securityHeaders = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
}

function json(body, status, origin) {
  return Response.json(body, { status, headers: { ...securityHeaders, Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) } })
}

function oauthCookie(value, age) {
  return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`
}

function redirect(url, cookie) {
  return new Response(null, { status: 303, headers: { ...securityHeaders, Location: url.href, 'Set-Cookie': cookie } })
}

export function createDriveAuth(config, store, requestGoogle = fetch, now = Date.now) {
  const callback = new URL('/oauth/callback', config.service).href
  const appOrigin = config.app.origin

  async function google(url, options) {
    return requestGoogle(url, { ...options, signal: AbortSignal.timeout(12000), redirect: 'error' })
  }

  async function googleToken(params) {
    const response = await google('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.secret, ...params
    }) })
    const result = await response.json()
    if (response.status === 400 && result.error === 'invalid_grant') return null
    const scopes = (result.scope ?? scope).split(/\s+/).filter(Boolean)
    if (!response.ok || typeof result.access_token !== 'string' || !(Number(result.expires_in) > 30) ||
        scopes.length !== 1 || scopes[0] !== scope) throw new Error('Google token unavailable')
    return result
  }

  async function begin(request) {
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return json({ error: 'invalid-request' }, 400)
    const form = new URLSearchParams(await request.text())
    const secret = form.get('device')
    const account = form.get('account') || ''
    if (!isKey(secret) || !/^[a-zA-Z0-9_-]{0,128}$/.test(account)) return json({ error: 'invalid-request' }, 400)
    const device = digest(secret)
    const existing = await store.read(device)
    const state = randomKey()
    const verifier = randomKey()
    const pending = seal(config.key, 'oauth-state', { state, verifier, device, account,
      version: existing?.version ?? null, expires: now() + stateSeconds * 1000 })
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, response_type: 'code',
      scope, state, code_challenge: digest(verifier), code_challenge_method: 'S256', access_type: 'offline',
      include_granted_scopes: 'false', prompt: 'consent', login_hint: config.email })
    return redirect(url, oauthCookie(pending, stateSeconds))
  }

  function finish(status) {
    const target = new URL(config.app)
    target.searchParams.set('drive_auth', status)
    return redirect(target, oauthCookie('', 0))
  }

  async function complete(request, url) {
    const encrypted = request.headers.get('cookie')?.split(/;\s*/).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    let pending
    try { pending = unseal(config.key, 'oauth-state', encrypted ?? '') } catch { return finish('denied') }
    if (url.searchParams.get('state') !== pending.state || pending.expires <= now() || url.searchParams.has('error')) return finish('denied')
    const code = url.searchParams.get('code')
    if (!code || code.length > 2048) return finish('denied')
    const result = await googleToken({ grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: pending.verifier })
    if (!result?.refresh_token) return finish('denied')
    const profile = await google('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)',
      { headers: { Authorization: 'Bearer ' + result.access_token } })
    if (!profile.ok) return finish('denied')
    const { user } = await profile.json()
    const email = normalizedEmail(user?.emailAddress)
    if (!user?.permissionId || email !== config.email || (pending.account && user.permissionId !== pending.account)) return finish('wrong-account')
    const token = seal(config.key, 'drive:' + pending.device, result.refresh_token)
    const saved = await store.replace(pending.device, { token, email, account: user.permissionId }, pending.version)
    return finish(saved ? 'connected' : 'denied')
  }

  async function token(record, device) {
    if (!record || record.email !== config.email) return json({ error: 'connect-required' }, 401, appOrigin)
    const refresh = unseal(config.key, 'drive:' + device, record.token)
    const result = await googleToken({ grant_type: 'refresh_token', refresh_token: refresh })
    if (!result) {
      await store.remove(device, record.version)
      return json({ error: 'connect-required' }, 401, appOrigin)
    }
    if (result.refresh_token && result.refresh_token !== refresh) {
      const updated = { account: record.account, email: record.email, token: seal(config.key, 'drive:' + device, result.refresh_token) }
      if (!await store.replace(device, updated, record.version)) return json({ error: 'retry' }, 409, appOrigin)
    } else if ((await store.read(device))?.version !== record.version) return json({ error: 'retry' }, 409, appOrigin)
    return json({ accessToken: result.access_token, expiresIn: Number(result.expires_in),
      account: record.account, email: record.email }, 200, appOrigin)
  }

  return async request => {
    const url = new URL(request.url)
    const path = url.pathname
    const { method } = request
    const fromApp = request.headers.get('origin') === appOrigin
    try {
      if (method === 'GET' && path === '/health') return json({ ok: true }, 200)
      if (method === 'GET' && path === '/oauth/callback') return await complete(request, url)
      if (!fromApp) return json({ error: 'forbidden' }, 403)
      if (method === 'OPTIONS' && ['/v1/config', '/v1/token', '/v1/session'].includes(path)) {
        return new Response(null, { status: 204, headers: { ...securityHeaders, Vary: 'Origin',
          'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE',
          'Access-Control-Allow-Headers': 'Authorization' } })
      }
      if (method === 'GET' && path === '/v1/config') return json({ version: 1, clientId: config.clientId }, 200, appOrigin)
      if (method === 'POST' && path === '/oauth/connect') return await begin(request)
      if ((method === 'POST' && path === '/v1/token') || (method === 'DELETE' && path === '/v1/session')) {
        const secret = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
        if (!isKey(secret)) return json({ error: 'connect-required' }, 401, appOrigin)
        const device = digest(secret)
        const current = await store.read(device)
        if (method === 'POST') return await token(current, device)
        if (current && !await store.remove(device, current.version)) return json({ error: 'retry' }, 409, appOrigin)
        return new Response(null, { status: 204, headers: { ...securityHeaders, Vary: 'Origin', 'Access-Control-Allow-Origin': appOrigin } })
      }
      return json({ error: 'not-found' }, 404, appOrigin)
    } catch {
      if (path === '/oauth/callback') return finish('service-error')
      return json({ error: 'service-error' }, 503, fromApp ? appOrigin : null)
    }
  }
}
