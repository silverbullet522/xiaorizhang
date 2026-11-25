export const validGoogleClient = value => typeof value === 'string' && /^[a-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/i.test(value)
let loading

export function loadGoogleOAuth() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2)
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const timer = setTimeout(fail, 10000)
    function fail() {
      clearTimeout(timer)
      script.remove()
      reject(new Error('google-unavailable'))
    }
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => {
      const oauth = globalThis.google?.accounts?.oauth2
      if (!oauth) { fail(); return }
      clearTimeout(timer)
      resolve(oauth)
    }
    script.onerror = fail
    document.head.append(script)
  }).finally(() => { loading = null })
  return loading
}
