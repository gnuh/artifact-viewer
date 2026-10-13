import { atom, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, Register } from 'claude-code'

import type { Item, Kind } from '../types'

const PANE = 'artifacts'
const TITLE = 'Artifact Viewer'
const NODE_MAJOR = 22 // the helper needs the global WebSocket, stable from Node 22
const KINDS: Record<string, Kind> = {
  html: 'page', htm: 'page', svg: 'page', pdf: 'page', png: 'page', jpg: 'page', jpeg: 'page', gif: 'page', webp: 'page',
  md: 'md', markdown: 'md', mmd: 'mermaid', mermaid: 'mermaid',
}
const INSTRUCTION_FILE = /^(CLAUDE|AGENTS|MEMORY)\.md$/i
const BLANK: ImageSource = { rgba: 'AAAAAA==', width: 1, height: 1 }
const CELL_PROBE =
  'import fcntl,termios,struct,os;fd=os.open("/dev/tty",os.O_RDONLY);r,c,x,y=struct.unpack("HHHH",fcntl.ioctl(fd,termios.TIOCGWINSZ,b"\\0"*8));print(x/c,y/r)'

const items = atom({ plugin: 'artifact-viewer', key: 'items' } as const, [])
const current = atom({ plugin: 'artifact-viewer', key: 'current' } as const, '')

type Mode = 'asked' | 'write' | 'edit'
type Helper = { url: string; token: string; runDir: string; ready: Promise<void> }
type Host = { isWindows: boolean; home: string; cache: string }

// The module's own run state: a reload starts a fresh helper, so none of it needs to survive one.
let host: Host = { isWindows: false, home: '', cache: '' }
let helper: Helper | undefined
let view: 'pane' | 'window' = 'pane'
let frame: ImageSource | undefined
let shown = ''
let cell = { width: 18, height: 40 }
let scale = 2
let page = { columns: 0, rows: 0, width: 1, height: 1 }

const slashes = (path: string) => path.replaceAll('\\', '/')
const fileUrl = (path: string) => `file://${/^[A-Za-z]:/.test(path) ? '/' : ''}${encodeURI(path)}`
const escapeHtml = (text: string) => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)
const artifactsDir = () => `${host.home}/claude-artifacts`

async function detectHost($: EngineInterface): Promise<Host> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = slashes((isWindows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? '')
  const cacheRoot = isWindows
    ? ((await $.env.get('LOCALAPPDATA')) ?? `${home}/AppData/Local`)
    : ((await $.env.get('XDG_CACHE_HOME')) ?? `${home}/.cache`)

  return { isWindows, home, cache: `${slashes(cacheRoot)}/artifact-viewer` }
}

// Pictures in a pane need the terminal Claude Code draws them on (Ghostty, kitty); the rest get a window.
async function canDrawPictures($: EngineInterface) {
  if (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) {
    return true
  }
  if ((await $.env.get('TMUX')) || (await $.env.get('STY'))) {
    return false
  }
  const term = (await $.env.get('TERM')) ?? ''

  return (await $.env.get('TERM_PROGRAM')) === 'ghostty' || term === 'xterm-ghostty' || term.includes('kitty') ||
    Boolean(await $.env.get('KITTY_WINDOW_ID'))
}

async function measureCells($: EngineInterface) {
  if (host.isWindows) {
    return
  }
  const probe = await $.process.run(['python3', '-c', CELL_PROBE]).catch(() => undefined)
  const [width = 0, height = 0] = probe?.stdout.trim().split(' ').map(Number) ?? []
  if (width > 0 && height > 0) {
    cell = { width, height }
  }
}

async function mustRun($: EngineInterface, argv: string[]) {
  const ran = await $.process.run(argv, { timeoutMs: 600_000 })
  if (ran.exitCode !== 0) {
    throw new Error(`${argv[0]} failed: ${ran.stderr.trim().slice(0, 300)}`)
  }

  return ran.stdout.trim()
}

// Node on the PATH when it is new enough, else a copy downloaded once into the cache.
async function nodeBinary($: EngineInterface) {
  const installed = await $.process.run(['node', '--version']).catch(() => undefined)
  if (installed?.exitCode === 0 && Number(installed.stdout.trim().slice(1).split('.')[0]) >= NODE_MAJOR) {
    return 'node'
  }

  const root = `${host.cache}/node`
  const binaryIn = (folder: string) => (host.isWindows ? `${root}/${folder}/node.exe` : `${root}/${folder}/bin/node`)
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(binaryIn(entry.name)))) {
      return binaryIn(entry.name)
    }
  }

  const os = host.isWindows ? 'win' : (await mustRun($, ['uname', '-s'])) === 'Darwin' ? 'darwin' : 'linux'
  const machine = host.isWindows ? ((await $.env.get('PROCESSOR_ARCHITECTURE')) ?? '') : await mustRun($, ['uname', '-m'])
  const arch = /arm64|aarch64/i.test(machine) ? 'arm64' : 'x64'
  const releases = JSON.parse((await $.http.fetch('https://nodejs.org/dist/index.json')).text) as { version: string; lts: unknown }[]
  const version = releases.find(release => release.lts && Number(release.version.slice(1).split('.')[0]) >= NODE_MAJOR)?.version
  if (!version) {
    throw new Error('no Node.js LTS release found')
  }
  const name = `node-${version}-${os}-${arch}`
  const archive = `${root}/${name}.${host.isWindows ? 'zip' : 'tar.gz'}`
  $.ui.toast('artifact-viewer: downloading Node.js (about 30 MB, only this once)…')
  await $.fs.write(`${root}/.keep`, '')
  await mustRun($, ['curl', '-fsSL', '-o', archive, `https://nodejs.org/dist/${version}/${name}.${host.isWindows ? 'zip' : 'tar.gz'}`])
  // ponytail: the archive stays beside the unpacked copy; delete it when cache size matters.
  await mustRun($, ['tar', '-xf', archive, '-C', root])

  return binaryIn(name)
}

async function call($: EngineInterface, op: string, body: object) {
  if (!helper) {
    throw new Error('the page renderer is not running')
  }
  await helper.ready
  const response = await $.http.fetch(`${helper.url}/${op}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-token': helper.token },
  })
  if (!response.ok) {
    throw new Error(`renderer ${op}: ${response.text}`)
  }
}

async function useWindow($: EngineInterface) {
  view = 'window'
  $.ui.invalidate('ui.render')
  await call($, 'mode', { mode: 'window' })
}

async function showFrame($: EngineInterface, file: string, generation: number) {
  if (view !== 'pane') {
    return
  }
  frame = { file, format: 'png', generation }
  const blitted = await $.ui.blit({ requestId: PANE, key: 'view', source: frame })
  if (blitted.deny !== undefined && /draws its alt/.test(blitted.deny)) {
    await useWindow($)
  } else if (blitted.deny !== undefined) {
    $.ui.invalidate('ui.render')
  }
}

// Runs the page renderer for the session's life and blits each frame it paints.
async function runHelper($: EngineInterface) {
  const runDir = `${artifactsDir()}/.viewer/${crypto.randomUUID().slice(0, 8)}`
  let markReady = () => {}
  const mine: Helper = { url: '', token: '', runDir, ready: new Promise(resolve => (markReady = resolve)) }
  helper = mine
  const node = await nodeBinary($)
  const child = $.process.spawn({ argv: [node, `${$.plugin.root}/bin/browser.mjs`, runDir, host.cache, view] })
  let pending = ''
  for await (const { stream, text } of child) {
    if (stream === 'stderr') {
      $.ui.log(text, { to: 'debug' })
      continue
    }
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const [word = '', ...rest] = line.trim().split(' ')
      if (word === 'ready') {
        mine.url = `http://127.0.0.1:${rest[0]}`
        mine.token = rest[1] ?? ''
        markReady()
        // A pane drawn before the renderer was up (a plugin reload redraws it first) asked for its size in vain.
        if (page.columns > 0) {
          await resize($, page.columns, page.rows)
        }
      } else if (word === 'frame') {
        await showFrame($, rest.slice(0, -1).join(' '), Number(rest.at(-1)))
      } else if (word === 'status') {
        $.ui.toast(`artifact-viewer: ${rest.join(' ')}`)
      }
    }
  }
  if (helper === mine) {
    helper = undefined
  }
}

async function present($: EngineInterface, item: Item) {
  await update($, current, () => item.path)
  void $.ui.open({ id: PANE, title: TITLE })
  if (item.kind === 'md' || (item.kind === 'page' && item.path === shown)) {
    return
  }

  shown = item.path
  if (item.kind === 'page') {
    return call($, 'show', { url: fileUrl(item.path), file: item.path })
  }
  if (!helper) {
    throw new Error('the page renderer is not running')
  }

  const wrapper = `${helper.runDir}/mermaid.html`
  await $.fs.write(
    wrapper,
    '<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#fff">' +
      `<pre class="mermaid">${escapeHtml(item.text ?? '')}</pre>` +
      '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
      '<script>mermaid.initialize({ startOnLoad: true })</script>',
  )
  return call($, 'show', { url: fileUrl(wrapper), file: wrapper })
}

async function reopen($: EngineInterface, item: Item) {
  shown = ''
  await present($, item)
}

// Returns why the file was not shown, or undefined once it is in the pane.
async function show($: EngineInterface, path: string, mode: Mode): Promise<string | undefined> {
  const stat = await $.fs.stat(path.replace(/^~(?=[\\/])/, host.home), { resolve: true })
  const real = slashes(stat.realPath ?? path)
  const name = real.slice(real.lastIndexOf('/') + 1)
  const kind = KINDS[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]
  if (!kind) {
    return `${name}: the pane draws html, svg, md, mmd, pdf and images`
  }

  const isKnown = (await read($, items)).some(item => item.path === real)
  const isSkipped =
    real.includes('/.claude/') || real.includes('/node_modules/') || INSTRUCTION_FILE.test(name) ||
    (kind === 'md' && mode === 'edit')
  if (mode !== 'asked' && !isKnown && isSkipped) {
    return 'skipped'
  }

  const item: Item = { path: real, name, kind, text: kind === 'page' ? undefined : await $.fs.read(real) }
  await update($, items, all =>
    all.some(one => one.path === real) ? all.map(one => (one.path === real ? item : one)) : [...all, item].slice(-20),
  )
  await present($, item)

  return undefined
}

async function capture($: EngineInterface, path: string, mode: Mode) {
  try {
    await show($, path, mode)
  } catch (error) {
    $.ui.toast(`artifact-viewer: ${String(error)}`)
  }
}

async function resize($: EngineInterface, columns: number, rows: number) {
  page = { columns, rows, width: Math.round((columns * cell.width) / scale), height: Math.round((rows * cell.height) / scale) }
  await call($, 'viewport', { width: page.width, height: page.height, scale }).catch(() => {})
}

async function forward($: EngineInterface, op: string, body: object) {
  await call($, op, body).catch(() => {})
}

async function startSession($: EngineInterface) {
  host = await detectHost($)
  view = (await canDrawPictures($)) ? 'pane' : 'window'
  await measureCells($)
  // ponytail: the display's density is guessed from the cell height (about 20 px on a 1x display, 40 on a 2x one):
  // a wrong guess draws the page blurred or at half size. ARTIFACT_VIEWER_SCALE sets it; ask the display when fonts fool this.
  scale = Number(await $.env.get('ARTIFACT_VIEWER_SCALE')) || (cell.height >= 30 ? 2 : 1)
  // ponytail: one idle node per session; the browser itself starts on the first page shown.
  void runHelper($).catch(error => {
    helper = undefined
    $.ui.toast(`artifact-viewer: page renderer failed: ${String(error)}`)
  })
}

export const register: Register = on => {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await capture($, e.file_path, 'write')
    }

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await capture($, e.file_path, 'edit')
    }

    return ran
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSession($)
    // Claude Code refuses a command name it ships: that must never keep the renderer from starting.
    await $.command
      .register({ name: 'viewer', description: 'Open the artifact pane, or show a file in it', argumentHint: '[file]' })
      .catch(error => $.ui.toast(`artifact-viewer: ${String(error)}`))

    return started
  })

  on('command.run', { command: 'viewer' }, async ($, e) => {
    const path = e.args.trim()
    try {
      if (!path) {
        await $.ui.open({ id: PANE, title: TITLE })

        return { text: 'Artifact pane open.' }
      }

      return { text: (await show($, path, 'asked')) ?? `${path} is in the artifact pane.` }
    } catch (error) {
      return { text: `artifact-viewer: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, items)
    const path = await read($, current)
    const item = list.find(one => one.path === path)
    const columns = e.props.bodyColumns
    const rows = Math.max(1, e.props.scroll.bodyRows - 1)
    const { Box, Button, Text, Markdown } = $.ui.resolve(e)
    const tabs = (
      <Box key="tabs" flexDirection="row">
        {list.map(one => (
          <Button
            key={`tab:${one.path}`}
            plain
            variant={one.path === path ? 'primary' : undefined}
            label={` ${one.name} `}
            onPress={() => present($, one)}
          />
        ))}
      </Box>
    )

    if (!item) {
      return <Text dimColor>Nenhum artefato ainda. Arquivos .html, .svg, .mmd e .md que o Claude criar aparecem aqui.</Text>
    }
    if (item.kind === 'md') {
      return (
        <Box flexDirection="column">
          {tabs}
          <Markdown key="doc" text={item.text ?? ''} />
        </Box>
      )
    }
    if (e.surface !== 'terminal' || view === 'window') {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>{item.name} está aberto na janela à direita: este terminal não desenha imagens no painel.</Text>
          <Button key="reopen" label="Abrir a janela de novo" onPress={() => reopen($, item)} />
        </Box>
      )
    }

    if (page.columns !== columns || page.rows !== rows) {
      // ponytail: fire-and-forget from the draw; the next screencast frame repaints at the new size.
      void resize($, columns, rows)
    }

    const { Image, Client } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {tabs}
        <Box width={columns} height={rows}>
          <Image key="view" source={frame ?? BLANK} columns={columns} rows={rows} alt={`${item.name}: carregando…`} />
          <Box position="absolute" top={0} left={0}>
            <Client key="input" module="./input.ts" width={columns} height={rows} />
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'input') {
      return next(e)
    }

    const data = e.data as { kind?: string; x?: number; y?: number; key?: string }
    const x = ((data.x ?? 0) * page.width) / Math.max(1, page.columns)
    const y = ((data.y ?? 0) * page.height) / Math.max(1, page.rows)
    if (data.kind === 'click') {
      await forward($, 'click', { x, y })
    } else if (data.kind === 'key' && typeof data.key === 'string') {
      await forward($, 'key', { key: data.key })
    }

    return {}
  })

  on('ui.scroll', async ($, e, next) => {
    const isPageShown = view === 'pane' && shown !== '' && (await read($, current)) === shown
    if (e.component !== 'Pane' || e.requestId !== PANE || !isPageShown) {
      return next(e)
    }

    const rowPixels = page.height / Math.max(1, page.rows)
    await forward($, 'wheel', {
      x: ((e.pointer?.column ?? page.columns / 2) * page.width) / Math.max(1, page.columns),
      y: (e.pointer?.row ?? page.rows / 2) * rowPixels,
      deltaY: e.by * 3 * rowPixels,
    })

    return {}
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // Without a renderer no page reaches the pane, so the model is not told that one does.
    // ponytail: a renderer whose browser cannot start still counts; track failed shows when that bites.
    if (e.surfaces.length === 0 || !helper) {
      return composed
    }

    const text = [
      '# Artifacts',
      "The user sees an artifact pane docked on the right of this Claude Code session, like the artifact panel of Claude's desktop app.",
      'Every .html, .svg, .mmd (Mermaid) or .md file you create with Write shows there by itself, rendered and interactive, and reloads whenever you Write or Edit it again.',
      `So when the user asks for something to look at (a page, mockup, chart, diagram, report, slides, a document), deliver it as one self-contained file in ${artifactsDir()}/ unless they name another place (libraries may load from a CDN), and tell them it is in the pane.`,
      'Do not open it in a browser, take screenshots of it, or paste its rendered content into the reply.',
    ].join('\n')

    return { sections: [...composed.sections, { id: 'artifact-viewer:artifacts', text, scope: 'session' }] }
  })
}
