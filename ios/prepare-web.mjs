import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'

const publicDir = new URL('./App/App/public/', import.meta.url)
const modules = (await readdir(publicDir)).filter(name => name.endsWith('.mjs'))

// The native WebView's asset handler recognizes .js across iOS versions.
// Change only the copied module paths, so the Pages build can keep using .mjs.
for (const name of ['index.html', ...modules]) {
  const original = new URL(name, publicDir)
  const source = await readFile(original, 'utf8')
  const content = source.replace(/((?:['"])\.\/[-\w]+)\.mjs(?=['"])/g, '$1.js')
  await writeFile(new URL(name.replace(/\.mjs$/, '.js'), publicDir), content)
  if (name.endsWith('.mjs')) await unlink(original)
}
