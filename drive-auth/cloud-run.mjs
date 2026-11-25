import { createServer } from 'node:http'
import { authConfig, createDriveAuth } from './service.mjs'
import { firestoreStore } from './firestore.mjs'

const config = authConfig(process.env)
if (!process.env.GOOGLE_CLOUD_PROJECT) throw new Error('Missing GOOGLE_CLOUD_PROJECT')
const serve = createDriveAuth(config, firestoreStore(process.env.GOOGLE_CLOUD_PROJECT, process.env.FIRESTORE_DATABASE))

createServer(async (input, output) => {
  try {
    const path = new URL(input.url, config.service)
    if (path.origin !== config.service.origin) { output.writeHead(400).end(); return }
    const chunks = []
    let size = 0
    for await (const chunk of input) {
      size += chunk.length
      if (size > 4096) { output.writeHead(413).end(); return }
      chunks.push(chunk)
    }
    const response = await serve(new Request(path, { method: input.method, headers: input.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined }))
    output.writeHead(response.status, Object.fromEntries(response.headers))
    output.end(Buffer.from(await response.arrayBuffer()))
  } catch { output.writeHead(400, { 'Cache-Control': 'no-store' }).end() }
}).listen(Number(process.env.PORT || 8080), '0.0.0.0')
