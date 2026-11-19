const capacitor = globalThis.Capacitor
export const isIosApp = capacitor?.getPlatform?.() === 'ios'

export async function readClipboardText() {
  if (!isIosApp) return navigator.clipboard?.readText() ?? ''
  const { value, type } = await capacitor.Plugins.Clipboard.read()
  return type === 'text/plain' ? value : ''
}

export async function shareIosFile(file, title) {
  const { Filesystem, Share } = capacitor.Plugins
  const folder = `exports/${crypto.randomUUID()}`
  const directory = 'CACHE'
  try {
    // Preserve the UTF-8 BOM used by CSV exports so Excel detects the encoding.
    const data = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await file.arrayBuffer())
    const { uri } = await Filesystem.writeFile({
      path: `${folder}/${file.name}`, directory, data, encoding: 'utf8', recursive: true
    })
    await Share.share({ title, files: [uri] })
    return true
  } catch (error) {
    if (error.message === 'Share canceled') return false
    throw error
  } finally {
    await Filesystem.rmdir({ path: folder, directory, recursive: true }).catch(() => {})
  }
}
