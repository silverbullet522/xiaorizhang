const prefix = 'hiba-shell-'
const version = prefix + '38'
const root = new URL('./', self.location.href)
const home = root.href
const index = new URL('index.html', root).href
const files = [
  './', 'style.css', 'app.mjs', 'core.mjs', 'storage.mjs', 'rates.mjs',
  'ui.mjs', 'icons.mjs', 'tables.mjs', 'screen.mjs', 'i18n.mjs', 'translations.mjs', 'features.mjs', 'motion.mjs', 'sync-ledger.mjs', 'drive-sync.mjs',
  'app.webmanifest', 'icons/touch.png', 'icons/app-192.png',
  'icons/app-512.png', 'vendor/xlsx.full.min.js'
].map(file => new URL(file, root).href)

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(version)
    const responses = await Promise.all(files.map(async file => {
      const response = await fetch(file, { cache: 'reload', credentials: 'same-origin', redirect: 'error' })
      if (!response.ok || (file === home && !(await response.clone().text()).includes('id="frame"'))) {
        throw new Error('无法缓存应用文件')
      }
      return [file, response]
    }))
    await Promise.all(responses.map(([file, response]) => cache.put(file, response)))
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key.startsWith(prefix) && key !== version).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const href = event.request.url
  if ([home, index].includes(href.split(/[?#]/)[0])) {
    event.respondWith((async () => (await (await caches.open(version)).match(home)) ?? fetch(event.request))())
  } else if (files.includes(href)) {
    event.respondWith((async () => (await (await caches.open(version)).match(href)) ?? fetch(event.request))())
  }
})
