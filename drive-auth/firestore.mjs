// The Cloud Run service account provides short-lived credentials through the metadata server.
export function firestoreStore(project, database = '(default)', request = fetch) {
  const collection = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(database)}/documents/hibaDriveAuthorizations`
  let token
  let expires = 0
  let refreshing

  function credential() {
    if (Date.now() < expires) return token
    refreshing ??= request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000), redirect: 'error'
    }).then(async response => {
      if (!response.ok) throw new Error('Cloud Run service identity unavailable')
      const result = await response.json()
      token = result.access_token
      expires = Date.now() + Math.max(0, Number(result.expires_in) - 60) * 1000
      return token
    }).finally(() => { refreshing = null })
    return refreshing
  }

  async function call(device, method, condition = '', fields) {
    const access = await credential()
    const response = await request(`${collection}/${device}${condition}`, {
      method, headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: fields && JSON.stringify({ fields }), signal: AbortSignal.timeout(8000), redirect: 'error'
    })
    if (response.status === 401 && token === access) expires = 0
    return response
  }

  const precondition = version => '?' + new URLSearchParams(version ? { 'currentDocument.updateTime': version } : { 'currentDocument.exists': 'false' })
  async function changed(response) {
    if (response.ok) return true
    const status = (await response.json()).error?.status
    if (['FAILED_PRECONDITION', 'ALREADY_EXISTS', 'NOT_FOUND', 'ABORTED'].includes(status)) return false
    throw new Error('Firestore write failed')
  }

  return {
    async read(device) {
      const response = await call(device, 'GET')
      if (response.status === 404) return null
      if (!response.ok) throw new Error('Firestore read failed')
      const { fields, updateTime } = await response.json()
      return { token: fields.token.stringValue, email: fields.email.stringValue, account: fields.account.stringValue, version: updateTime }
    },
    replace(device, values, version) {
      const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { stringValue: value }]))
      return call(device, 'PATCH', precondition(version), fields).then(changed)
    },
    remove(device, version) {
      return call(device, 'DELETE', precondition(version)).then(changed)
    }
  }
}
