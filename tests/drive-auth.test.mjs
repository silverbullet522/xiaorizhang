import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { authConfig, createDriveAuth } from '../drive-auth/service.mjs'
import { firestoreStore } from '../drive-auth/firestore.mjs'

const app = 'https://ledger.example/xiaorizhang/'
const origin = new URL(app).origin
const service = 'https://drive-auth.example'
const device = 'a'.repeat(43)
const otherDevice = 'b'.repeat(43)
const scope = 'https://www.googleapis.com/auth/drive.appdata'
const clientId = 'test.apps.googleusercontent.com'
const profile = { emailAddress: 'owner@example.com', permissionId: '12345' }

function fixture() {
  const config = authConfig({ APP_URL: app, SERVICE_URL: service, GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_OWNER_EMAIL: profile.emailAddress, TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) })
  let version = 0
  const docs = new Map()
  const store = {
    async read(id) { return docs.get(id) ?? null },
    async replace(id, record, expected) {
      if ((docs.get(id)?.version ?? null) !== expected) return false
      docs.set(id, { ...record, version: String(++version) })
      return true
    },
    async remove(id, expected) {
      if (docs.get(id)?.version !== expected) return false
      return docs.delete(id)
    }
  }
  const google = { profile, codeCalls: [], refreshCalls: [], refreshing: null, time: 0 }
  const serve = createDriveAuth(config, store, async (url, init) => {
    if (url.startsWith('https://www.googleapis.com/drive/v3/about?')) return Response.json({ user: google.profile })
    assert.equal(url, 'https://oauth2.googleapis.com/token')
    assert.equal(init.body.get('client_secret'), 'test-secret')
    if (init.body.get('grant_type') === 'authorization_code') {
      google.codeCalls.push(Object.fromEntries(init.body))
      return Response.json({ access_token: 'first-access', refresh_token: 'test-refresh', expires_in: 3600, scope })
    }
    const refresh = init.body.get('refresh_token')
    google.refreshCalls.push(refresh)
    return google.refreshing ? google.refreshing() : Response.json({ access_token: 'next-access', expires_in: 3600, scope })
  }, () => google.time)
  const call = (path, init = {}) => serve(new Request(service + path, init))
  const begin = (key = device, account = '12345', from = origin) => call('/oauth/connect', { method: 'POST', headers: { Origin: from },
    body: new URLSearchParams({ device: key, account }) })
  const finish = (result, overrides = {}) => {
    const googleUrl = new URL(result.headers.get('location'))
    const state = overrides.state ?? googleUrl.searchParams.get('state')
    const cookie = overrides.cookie ?? result.headers.get('set-cookie').split(';')[0]
    return call('/oauth/callback?state=' + state + '&code=test-code', { headers: { Cookie: cookie } })
  }
  const renew = (key = device, method = 'POST') => call(method === 'POST' ? '/v1/token' : '/v1/session', {
    method, headers: { Origin: origin, Authorization: 'Bearer ' + key } })
  return { docs, google, call, begin, finish, renew }
}

test('Google 授权成功后可在没有 Cookie 的新页面续期，云端只保存加密的刷新令牌', async () => {
  const { docs, google, begin, finish, renew } = fixture()
  assert.equal((await renew()).status, 401)
  const pending = await begin()
  const query = new URL(pending.headers.get('location')).searchParams
  assert.equal(query.get('access_type'), 'offline')
  assert.equal(query.get('redirect_uri'), service + '/oauth/callback')
  assert.equal(query.get('code_challenge_method'), 'S256')
  assert.equal(query.get('scope'), scope)
  assert.match(pending.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/)
  assert.match((await finish(pending)).headers.get('location'), /drive_auth=connected$/)
  assert.equal(createHash('sha256').update(google.codeCalls[0].code_verifier).digest('base64url'), query.get('code_challenge'))
  assert.equal(docs.size, 1)
  assert.equal(JSON.stringify([...docs]).includes('test-refresh'), false)
  assert.equal(JSON.stringify([...docs]).includes(device), false)
  for (let i = 0; i < 2; i++) {
    const response = await renew()
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('access-control-allow-origin'), origin)
    assert.deepEqual(await response.json(), { accessToken: 'next-access', expiresIn: 3600, email: profile.emailAddress, account: '12345' })
  }
  assert.deepEqual(google.refreshCalls, ['test-refresh', 'test-refresh'])
  assert.equal((await renew(otherDevice)).status, 401)
  assert.equal((await renew(device, 'DELETE')).status, 204)
  assert.equal(docs.size, 0)
})

test('授权服务拒绝其他网站、无效状态、已过期状态和错误的 Google 账号', async () => {
  const { docs, google, call, begin, finish } = fixture()
  assert.equal((await call('/v1/config')).status, 403)
  assert.equal((await begin(device, '12345', 'https://unrelated.example')).status, 403)
  assert.equal((await call('/v1/config', { headers: { Origin: origin } })).status, 200)
  const pending = await begin()
  assert.match((await finish(pending, { cookie: '' })).headers.get('location'), /drive_auth=denied$/)
  assert.match((await finish(pending, { state: 'c'.repeat(43) })).headers.get('location'), /drive_auth=denied$/)
  google.time += 600001
  assert.match((await finish(pending)).headers.get('location'), /drive_auth=denied$/)
  assert.equal(google.codeCalls.length, 0)
  const newPending = await begin()
  google.profile = { ...profile, permissionId: '56789' }
  assert.match((await finish(newPending)).headers.get('location'), /drive_auth=wrong-account$/)
  assert.equal(docs.size, 0)
})

test('Google 暂时失败保留授权，被撤销的授权需要重新连接', async () => {
  const { docs, google, begin, finish, renew } = fixture()
  await finish(await begin())
  google.refreshing = () => Response.json({ error: 'server_error' }, { status: 500 })
  assert.equal((await renew()).status, 503)
  assert.equal(docs.size, 1)
  google.refreshing = () => Response.json({ error: 'invalid_grant' }, { status: 400 })
  assert.equal((await renew()).status, 401)
  assert.equal(docs.size, 0)
})

test('Firestore 写入读取用 Cloud Run 身份，更新和删除带版本条件', async () => {
  const calls = []
  const store = firestoreStore('test-project', '(default)', async (url, options) => {
    calls.push({ url, ...options })
    if (url.startsWith('http://metadata.google.internal/')) return Response.json({ access_token: 'test-cloud-run-access', expires_in: 3600 })
    if (options.method === 'GET') return Response.json({ updateTime: '2026-11-25T00:00:00Z', fields: {
      token: { stringValue: 'encrypted' }, email: { stringValue: profile.emailAddress }, account: { stringValue: profile.permissionId }
    } })
    return options.method === 'DELETE' ? Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 }) : Response.json({})
  })
  const data = await store.read(device)
  assert.equal(data.version, '2026-11-25T00:00:00Z')
  const { version, ...record } = data
  assert.equal(await store.replace(device, record, null), true)
  assert.equal(await store.remove(device, version), false)
  assert.equal(calls[0].headers['Metadata-Flavor'], 'Google')
  assert.equal(calls[1].headers.Authorization, 'Bearer test-cloud-run-access')
  assert.equal(new URL(calls[2].url).searchParams.get('currentDocument.exists'), 'false')
  assert.equal(new URL(calls[3].url).searchParams.get('currentDocument.updateTime'), version)
})
