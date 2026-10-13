import { atom, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, Register } from 'claude-code'

import type { Item, Kind } from '../types'

// ponytail: macOS + Google Chrome + node on PATH; another OS needs its own CHROME and cell probe.
const PANE = 'artifacts'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SCALE = 2
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
type Helper = { socket: string; runDir: string; ready: Promise<void> }

// The module's own run state: a reload starts a fresh helper, so none of it needs to survive one.
let helper: Helper | undefined
let frame: ImageSource | undefined
let shown = ''
let cell = { width: 17, height: 34 }
let page = { columns: 0, rows: 0, width: 1, height: 1 }

const fileUrl = (path: string) => `file://${encodeURI(path)}`
const escapeHtml = (text: string) => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)

async function home($: EngineInterface) {
  return (await $.env.get('HOME')) ?? ''
}

async function artifactsDir($: EngineInterface) {
  return `${await home($)}/claude-artifacts`
}

async function call($: EngineInterface, op: string, body: object) {
  if (!helper) {
    throw new Error('the page renderer is not running')
  }
  await helper.ready
  const response = await $.http.fetch(`http://helper/${op}`, {
    method: 'POST',
    body: JSON.stringify(body),
    socketPath: helper.socket,
  })
  if (!response.ok) {
    throw new Error(`renderer ${op}: ${response.text}`)
  }
}

async function measureCells($: EngineInterface) {
  const probe = await $.process.run(['python3', '-c', CELL_PROBE]).catch(() => undefined)
  const [width = 0, height = 0] = probe?.stdout.trim().split(' ').map(Number) ?? []
  if (width > 0 && height > 0) {
    cell = { width, height }
  }
}

// Runs the headless page renderer for the session's life and blits each frame it paints.
async function runHelper($: EngineInterface) {
  const runDir = `${await artifactsDir($)}/.viewer/${crypto.randomUUID().slice(0, 8)}`
  let markReady = () => {}
  const mine: Helper = { socket: `${runDir}/b.sock`, runDir, ready: new Promise(resolve => (markReady = resolve)) }
  helper = mine
  const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/bin/browser.mjs`, mine.socket, runDir, CHROME] })
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
      const found = line.match(/^frame (.+) (\d+)$/)
      if (line === 'ready') {
        markReady()
      } else if (found) {
        frame = { file: found[1] ?? '', format: 'png', generation: Number(found[2]) }
        const blitted = await $.ui.blit({ requestId: PANE, key: 'view', source: frame })
        if (blitted.deny !== undefined) {
          $.ui.invalidate('ui.render')
        }
      }
    }
  }
  if (helper === mine) {
    helper = undefined
  }
}

async function present($: EngineInterface, item: Item) {
  await update($, current, () => item.path)
  void $.ui.open({ id: PANE, title: 'Artefatos' })
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

// Returns why the file was not shown, or undefined once it is in the pane.
async function show($: EngineInterface, path: string, mode: Mode): Promise<string | undefined> {
  const stat = await $.fs.stat(path.replace(/^~(?=\/)/, await home($)), { resolve: true })
  const real = stat.realPath ?? path
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
  page = { columns, rows, width: Math.round((columns * cell.width) / SCALE), height: Math.round((rows * cell.height) / SCALE) }
  await call($, 'viewport', { width: page.width, height: page.height, scale: SCALE }).catch(() => {})
}

async function forward($: EngineInterface, op: string, body: object) {
  await call($, op, body).catch(() => {})
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
    await $.command.register({
      name: 'artifacts',
      description: 'Open the artifact pane, or show a file in it',
      argumentHint: '[file]',
    })
    await measureCells($)
    // ponytail: one idle node per session; Chrome itself starts on the first page shown.
    void runHelper($).catch(error => $.ui.toast(`artifact-viewer: page renderer failed: ${String(error)}`))

    return started
  })

  on('command.run', { command: 'artifacts' }, async ($, e) => {
    const path = e.args.trim()
    try {
      if (!path) {
        await $.ui.open({ id: PANE, title: 'Artefatos' })

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
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>{item.name}: a página só é desenhada no terminal (Ghostty ou kitty).</Text>
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
          <Image
            key="view"
            source={frame ?? BLANK}
            columns={columns}
            rows={rows}
            alt={`${item.name}: este terminal não desenha imagens (use Ghostty ou kitty)`}
          />
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
    const isPageShown = shown !== '' && (await read($, current)) === shown
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
    if (e.surfaces.length === 0) {
      return composed
    }

    const text = [
      '# Artifacts',
      "The user sees an artifact pane docked on the right of this Claude Code session, like the artifact panel of Claude's desktop app.",
      'Every .html, .svg, .mmd (Mermaid) or .md file you create with Write shows there by itself, rendered and interactive, and reloads whenever you Write or Edit it again.',
      `So when the user asks for something to look at (a page, mockup, chart, diagram, report, slides, a document), deliver it as one self-contained file in ${await artifactsDir($)}/ unless they name another place (libraries may load from a CDN), and tell them it is in the pane.`,
      'Do not open it in a browser, take screenshots of it, or paste its rendered content into the reply.',
    ].join('\n')

    return { sections: [...composed.sections, { id: 'artifact-viewer:artifacts', text, scope: 'session' }] }
  })
}
