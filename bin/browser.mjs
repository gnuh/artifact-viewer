// Chromium behind the artifact pane. Commands arrive as JSON POSTs on a random
// localhost port, each carrying the token printed at start. In pane mode the
// browser is headless and every frame it paints is written to a PNG in the run
// folder and announced on stdout as `frame <path> <generation>`, which the hooks
// module blits into the pane. In window mode (a terminal that draws no pictures)
// the page shows in an app window docked on the right half of the screen.
//
// The browser is ARTIFACT_VIEWER_BROWSER when it names one, else an installed
// Chrome, Edge or Chromium, else Chrome for Testing downloaded once into the cache
// (ARTIFACT_VIEWER_BROWSER=download skips the installed ones).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  unwatchFile, watchFile, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const [runDir, cacheDir, startMode] = process.argv.slice(2)
const CFT = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
const PLATFORM = {
  'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux64', 'linux-arm64': 'linux-arm64',
  'win32-x64': 'win64', 'win32-arm64': 'win64', 'win32-ia32': 'win32',
}[`${process.platform}-${process.arch}`]
const EXECUTABLE = {
  darwin: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  win32: 'chrome.exe',
}[process.platform] ?? 'chrome'
const KEYS = {
  return: ['Enter', 13], backspace: ['Backspace', 8], tab: ['Tab', 9], delete: ['Delete', 46],
  up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39],
  pageup: ['PageUp', 33], pagedown: ['PageDown', 34], home: ['Home', 36], end: ['End', 35],
}

let mode = startMode === 'window' ? 'window' : 'pane'
let browserPath
let browser
let send
let viewport = { width: 800, height: 600, scale: 2 }
let current
let generation = 0

const say = line => console.log(line.replace(/\n/g, ' '))

function installedBrowser() {
  const env = process.env
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    win32: [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean)
      .flatMap(root => [join(root, 'Google/Chrome/Application/chrome.exe'), join(root, 'Microsoft/Edge/Application/msedge.exe')]),
  }[process.platform] ?? (env.PATH ?? '')
    .split(delimiter)
    .flatMap(dir => ['google-chrome', 'google-chrome-stable', 'chromium', 'microsoft-edge'].map(name => join(dir, name)))
  // A snap build cannot read the run folder or its own profile there, so it is passed over.
  const isSnap = path => [path, realpathSync(path)].some(one => one.includes('/snap/') || one.endsWith('/snap'))

  return candidates.find(path => existsSync(path) && !isSnap(path))
}

// ponytail: a plain zip reader (no zip64, no encryption), which is what Chrome for Testing ships.
function unzip(zip, target) {
  const root = resolve(target)
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let entry = zip.readUInt32LE(end + 16)
  for (let left = zip.readUInt16LE(end + 10); left > 0; left -= 1) {
    const method = zip.readUInt16LE(entry + 10)
    const size = zip.readUInt32LE(entry + 20)
    const nameLength = zip.readUInt16LE(entry + 28)
    const mode = zip.readUInt32LE(entry + 38) >>> 16
    const local = zip.readUInt32LE(entry + 42)
    const name = zip.toString('utf8', entry + 46, entry + 46 + nameLength)
    entry += 46 + nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32)
    const path = resolve(root, name)
    if (!path.startsWith(root + sep)) {
      throw new Error(`zip entry outside the target: ${name}`)
    }
    if (name.endsWith('/')) {
      mkdirSync(path, { recursive: true })
      continue
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + size)
    const data = method === 8 ? inflateRawSync(raw) : raw
    mkdirSync(dirname(path), { recursive: true })
    if ((mode & 0o170000) === 0o120000) {
      symlinkSync(data.toString(), path)
    } else {
      writeFileSync(path, data)
      if (mode & 0o111) chmodSync(path, mode & 0o777)
    }
  }
}

async function downloadedBrowser() {
  const root = join(cacheDir, 'chromium')
  const executableIn = version => join(root, version, `chrome-${PLATFORM}`, EXECUTABLE)
  const cached = existsSync(root) && readdirSync(root).map(executableIn).find(existsSync)
  if (cached) return cached
  if (!PLATFORM) throw new Error(`no Chromium build for ${process.platform}-${process.arch}`)

  const { version, downloads } = (await (await fetch(CFT)).json()).channels.Stable
  const url = downloads.chrome.find(one => one.platform === PLATFORM)?.url
  say(`status Downloading Chromium ${version} (about 200 MB, only this once)…`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Chromium download failed: HTTP ${response.status}`)
  const staging = join(root, `.${version}-${process.pid}`)
  unzip(Buffer.from(await response.arrayBuffer()), staging)
  try {
    renameSync(staging, join(root, version))
  } catch {
    rmSync(staging, { recursive: true, force: true }) // another session finished first
  }
  say('status Chromium is ready.')

  return executableIn(version)
}

function resolveBrowser() {
  const asked = process.env.ARTIFACT_VIEWER_BROWSER
  browserPath ??= asked && asked !== 'download'
    ? Promise.resolve(asked)
    : Promise.resolve(asked === 'download' ? undefined : installedBrowser()).then(found => found ?? downloadedBrowser())
  browserPath.catch(() => (browserPath = undefined))

  return browserPath
}

function stopBrowser() {
  browser?.kill()
  browser = undefined
  send = undefined
}

async function startBrowser() {
  const path = await resolveBrowser()
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${join(runDir, 'profile')}`,
    '--no-first-run', '--no-default-browser-check',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    // An app window keeps its chrome-less look only for the page it was opened on.
    ...(mode === 'pane' ? ['--headless=new', '--hide-scrollbars', 'about:blank'] : [`--app=${current.url}`]),
  ]
  const child = spawn(path, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  browser = child
  child.on('exit', () => browser === child && stopBrowser())
  const endpoint = await new Promise((done, fail) => {
    let text = ''
    child.stderr.on('data', chunk => {
      text += chunk
      const found = text.match(/DevTools listening on (ws:\S+)/)
      if (found) done(found[1])
    })
    child.on('error', fail)
    child.on('exit', () => fail(new Error(`the browser exited: ${text.trim().split('\n').pop() ?? ''}`)))
  })
  const pages = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json()
  const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    ws.addEventListener('open', done, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
  // The person closed the window: the next page starts the browser again.
  ws.addEventListener('close', () => browser === child && stopBrowser())

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.method === 'Page.screencastFrame') {
      const file = join(runDir, `frame-${generation % 4}.png`)
      writeFileSync(file, Buffer.from(message.params.data, 'base64'))
      generation += 1
      say(`frame ${file} ${generation}`)
      void send?.('Page.screencastFrameAck', { sessionId: message.params.sessionId })
    }
  })
  send = (method, params = {}) =>
    new Promise((done, fail) => {
      pending.set(++id, message => (message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Page.enable')
  if (mode === 'pane') {
    await applyViewport()
  } else {
    await dockRight()
  }
}

async function applyViewport() {
  const { width, height, scale } = viewport
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
  await send('Page.stopScreencast')
  await send('Page.startScreencast', { format: 'png', maxWidth: width * scale, maxHeight: height * scale })
}

async function dockRight() {
  const { result } = await send('Runtime.evaluate', {
    expression: '[screen.availLeft ?? 0, screen.availTop ?? 0, screen.availWidth, screen.availHeight]',
    returnByValue: true,
  })
  const [left, top, width, height] = result.value
  const { windowId } = await send('Browser.getWindowForTarget')
  const half = Math.round(width / 2)
  await send('Browser.setWindowBounds', { windowId, bounds: { left: left + half, top, width: width - half, height } })
}

async function navigate() {
  if (!send) {
    await startBrowser()
    if (mode === 'window') return
  }
  await send('Page.navigate', { url: current.url })
  if (mode === 'window') await send('Page.bringToFront')
}

const mouse = (type, { x, y, button = 'none', clickCount = 0, deltaY = 0 }) =>
  send?.('Input.dispatchMouseEvent', { type, x, y, button, clickCount, deltaX: 0, deltaY })

const handlers = {
  async show({ url, file }) {
    if (current) unwatchFile(current.file)
    current = { url, file }
    // ponytail: stat polling (300 ms) instead of fs.watch, which misses editors' atomic renames.
    watchFile(file, { interval: 300 }, () => void send?.('Page.reload', { ignoreCache: true }))
    await navigate()
  },
  async mode(next) {
    if (next.mode === mode) return
    mode = next.mode
    stopBrowser()
    if (current) await navigate()
  },
  async viewport(next) {
    viewport = next
    if (send && mode === 'pane') await applyViewport()
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
    if (!special) return send?.('Input.insertText', { text: key })
    const [name, code] = special
    await send?.('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code })
    await send?.('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code })
  },
}

mkdirSync(runDir, { recursive: true })
process.on('exit', () => {
  stopBrowser()
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    // Windows keeps the profile locked until the browser is gone; the next run's folder is a new one.
  }
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))
// The session that spawned us may die without killing us: leave with it.
const parent = process.ppid
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    process.exit(0)
  }
}, 2000)

const token = randomBytes(16).toString('hex')
const server = createServer(async (request, response) => {
  const handler = handlers[request.url?.slice(1) ?? '']
  if (request.headers['x-token'] !== token || !handler) {
    response.statusCode = 403
    return response.end()
  }
  let body = ''
  for await (const chunk of request) body += chunk
  try {
    await handler(body ? JSON.parse(body) : {})
    response.end('{}')
  } catch (error) {
    response.statusCode = 500
    response.end(String(error?.message ?? error))
  }
})
server.listen(0, '127.0.0.1', () => say(`ready ${server.address().port} ${token}`))
