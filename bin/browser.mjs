// Headless Chrome behind the artifact pane. Commands arrive as JSON POSTs on a
// Unix socket (show, viewport, pointer, wheel, key); every frame Chrome paints
// is written to a PNG in the run folder and announced on stdout as
// `frame <path> <generation>`, which the hooks module blits into the pane.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [socket, runDir, chromePath] = process.argv.slice(2)
const KEYS = {
  return: ['Enter', 13], backspace: ['Backspace', 8], tab: ['Tab', 9], delete: ['Delete', 46],
  up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39],
  pageup: ['PageUp', 33], pagedown: ['PageDown', 34], home: ['Home', 36], end: ['End', 35],
}

let send
let viewport = { width: 800, height: 600, scale: 2 }
let watched
let generation = 0

async function startChrome() {
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${runDir}/chrome`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  process.on('exit', () => chrome.kill())
  const endpoint = await new Promise((resolve, reject) => {
    let text = ''
    chrome.stderr.on('data', chunk => {
      text += chunk
      const found = text.match(/DevTools listening on (ws:\S+)/)
      if (found) resolve(found[1])
    })
    chrome.on('exit', () => reject(new Error('chrome exited')))
  })
  const pages = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json()
  const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      pending.get(message.id)?.(message.result)
      pending.delete(message.id)
    } else if (message.method === 'Page.screencastFrame') {
      const path = `${runDir}/frame-${generation % 4}.png`
      writeFileSync(path, Buffer.from(message.params.data, 'base64'))
      generation += 1
      console.log(`frame ${path} ${generation}`)
      void send('Page.screencastFrameAck', { sessionId: message.params.sessionId })
    }
  })
  send = (method, params = {}) =>
    new Promise(resolve => {
      pending.set(++id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Page.enable')
}

async function applyViewport() {
  const { width, height, scale } = viewport
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
  await send('Page.stopScreencast')
  await send('Page.startScreencast', { format: 'png', maxWidth: width * scale, maxHeight: height * scale })
}

const mouse = (type, { x, y, button = 'none', clickCount = 0, deltaY = 0 }) =>
  send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, deltaX: 0, deltaY })

const handlers = {
  async show({ url, file }) {
    if (!send) {
      await startChrome()
      await applyViewport()
    }
    if (watched) unwatchFile(watched)
    watched = file
    // ponytail: stat polling (300 ms) instead of fs.watch, which misses editors' atomic renames.
    watchFile(file, { interval: 300 }, () => void send('Page.reload', { ignoreCache: true }))
    await send('Page.navigate', { url })
  },
  async viewport(next) {
    viewport = next
    if (send) await applyViewport()
  },
  async click({ x, y }) {
    await mouse('mouseMoved', { x, y })
    await mouse('mousePressed', { x, y, button: 'left', clickCount: 1 })
    await mouse('mouseReleased', { x, y, button: 'left', clickCount: 1 })
  },
  async wheel({ x, y, deltaY }) {
    await mouse('mouseWheel', { x, y, deltaY })
  },
  async key({ key }) {
    const special = KEYS[key]
    if (!special) return send('Input.insertText', { text: key })
    const [name, code] = special
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code })
  },
}

mkdirSync(runDir, { recursive: true })
rmSync(socket, { force: true })
process.on('exit', () => rmSync(runDir, { recursive: true, force: true }))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))
// The session that spawned us may die without killing us: leave with it.
setInterval(() => process.ppid === 1 && process.exit(0), 2000)

createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  try {
    await handlers[request.url.slice(1)](body ? JSON.parse(body) : {})
    response.end('{}')
  } catch (error) {
    response.statusCode = 500
    response.end(String(error))
  }
}).listen(socket, () => console.log('ready'))
