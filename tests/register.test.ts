import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/t'
const PANE = { plugin: 'artifact-viewer', component: 'Pane', requestId: 'artifacts' } as const
const PROPS = { bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } } as never
const GHOSTTY = { HOME, TERM_PROGRAM: 'ghostty' }

type World = {
  env?: Record<string, string>
  files?: Record<string, string>
  hasNode?: boolean
  blitDeny?: string
  isCommandRefused?: boolean
  cellPixels?: string
  // The kit resolves a path against the test's folder; a Windows host already has `C:\\...` absolute.
  isWindowsFs?: boolean
}

function world(on: On, { env = GHOSTTY, files = {}, hasNode = true, blitDeny, isCommandRefused, cellPixels = '18 36', isWindowsFs }: World = {}) {
  const calls: { op: string; body: unknown; token?: string }[] = []
  const runs: string[][] = []
  const spawns: string[][] = []
  const opened: string[] = []
  const toasts: string[] = []
  mock.env(on, env)
  on('fs.stat', async ($, e) => {
    const realPath = isWindowsFs ? e.path.replace(/^.*(?=[A-Za-z]:\\)/, '') : e.path

    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false, realPath } }
  })
  on('fs.read', async ($, e) => {
    const text = files[e.path]
    if (text === undefined) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: text }
  })
  on('fs.write', async ($, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.list', async () => ({ value: [] }))
  on('fs.exists', async () => ({ value: false }))
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    const answers: Record<string, [number, string]> = {
      python3: [0, `${cellPixels}\n`],
      node: hasNode ? [0, 'v22.1.0\n'] : [127, ''],
      'uname -s': [0, 'Darwin\n'],
      'uname -m': [0, 'arm64\n'],
    }
    const [exitCode, stdout] = answers[e.argv.slice(0, 2).join(' ')] ?? answers[e.argv[0] ?? ''] ?? [0, '']

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e) {
    spawns.push([...e.argv])
    yield { stream: 'stdout', text: 'ready 4321 secret\nframe /tmp/f-0.png 1\n' }
    // A live renderer: the stream stays open for the session's life.
    await new Promise(() => {})

    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async ($, e) => {
    if (e.url === 'https://nodejs.org/dist/index.json') {
      const releases = [{ version: 'v25.0.0', lts: false }, { version: 'v24.11.0', lts: 'Krypton' }]

      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(releases) } }
    }
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    calls.push({ op: e.url.slice('http://127.0.0.1:4321/'.length), body: JSON.parse(e.init?.body ?? '{}'), token: headers['x-token'] })

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('ui.open', async ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.blit', async () => ({ value: blitDeny ? { deny: blitDeny } : {} }))
  on('ui.toast', async ($, e) => {
    toasts.push(String((e as { text?: unknown }).text))

    return { value: undefined }
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  // Unanswered, the registration rejects, as it does for a name Claude Code ships.
  if (!isCommandRefused) {
    on('command.register', async ($, e) => ({ value: { command: e.name } }))
  }
  on('tool.call', async () => ({ result: {} as never }))

  return { calls, runs, spawns, opened, toasts }
}

const START = { cwd: '/p', surface: 'terminal', isInteractive: true } as const

test('a written html file opens the pane and is rendered by the page helper', async ($, on) => {
  const { calls, opened, spawns } = world(on)
  await $.session.start(START)

  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })

  expect(spawns[0]?.at(-1)).toBe('pane')
  expect(opened).toContain('artifacts')
  expect(calls).toContainEqual({ op: 'show', body: { url: 'file:///p/page.html', file: '/p/page.html' }, token: 'secret' })
})

test('a command name Claude Code refuses does not keep the page helper from starting', async ($, on) => {
  const { calls, toasts } = world(on, { isCommandRefused: true })
  await $.session.start(START)

  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })

  expect(toasts.length).toBe(1)
  expect(calls).toContainEqual({ op: 'show', body: { url: 'file:///p/page.html', file: '/p/page.html' }, token: 'secret' })
})

test('instruction files, ~/.claude files and edits of unshown markdown stay out', async ($, on) => {
  const { opened } = world(on, { files: { '/p/notes.md': '# hi' } })
  await $.session.start(START)

  await $.tool.call({ tool: 'Edit', file_path: '/p/notes.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/p/CLAUDE.md', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: `${HOME}/.claude/plans/x.html`, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/p/app.ts', content: 'x' })

  expect(opened).toEqual([])
})

test('markdown is drawn as text and a page as a picture under a click region', { timeoutMs: 20000 }, async ($, on) => {
  world(on, { files: { '/p/notes.md': '# Relatório' } })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/notes.md', content: '# Relatório' })

  const doc = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect((await doc.find({ type: 'Markdown' }))?.text).toContain('Relatório')
  await doc.unmount()

  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await terminal.find({ type: 'Image', key: 'view' })).toBeDefined()
  expect(await terminal.find({ type: 'Client', key: 'input' })).toBeDefined()
  expect(await terminal.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(await desktop.find({ type: 'Text', text: /janela/ })).toBeDefined()
  await desktop.unmount()
})

test('a click on the picture reaches the page at the same spot', { timeoutMs: 20000 }, async ($, on) => {
  const { calls } = world(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<button>x</button>' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 90, scroll: { offset: 0, bodyRows: 30 } } as never })
  await ui.pointer({ type: 'down', x: 40, y: 10, button: 'left' })
  await ui.pointer({ type: 'up', x: 40, y: 10, button: 'left' })

  // 90x29 cells of 18x36 px at scale 2 make an 810x522 page; cell (40, 10) is centred at 40.5, 10.5.
  expect(calls).toContainEqual({ op: 'viewport', body: { width: 810, height: 522, scale: 2 }, token: 'secret' })
  expect(calls).toContainEqual({ op: 'click', body: { x: 364.5, y: 189 }, token: 'secret' })
  await ui.unmount()
})

test('a regular display gets one page pixel per pane pixel', { timeoutMs: 20000 }, async ($, on) => {
  const { calls } = world(on, { cellPixels: '10 21' })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(calls).toContainEqual({ op: 'viewport', body: { width: 1000, height: 609, scale: 1 }, token: 'secret' })
  await ui.unmount()
})

test('a pane drawn before the page helper is up is sized once it is', { timeoutMs: 20000 }, async ($, on) => {
  const { calls } = world(on)
  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(calls).toEqual([])

  await $.session.start(START)
  await new Promise(resolve => setTimeout(resolve, 200))

  expect(calls).toContainEqual({ op: 'viewport', body: { width: 900, height: 522, scale: 2 }, token: 'secret' })
  await ui.unmount()
})

test('a terminal that draws no pictures gets the page in a window', { timeoutMs: 20000 }, async ($, on) => {
  const { spawns } = world(on, { env: { HOME, TERM_PROGRAM: 'WezTerm' } })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })

  expect(spawns[0]?.at(-1)).toBe('window')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /janela/ })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
})

test('a picture the terminal refuses moves the page to a window', { timeoutMs: 20000 }, async ($, on) => {
  const { calls } = world(on, { blitDeny: 'the Image draws its alt here: the terminal draws no placeholder images (probe)' })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })

  expect(calls).toContainEqual({ op: 'mode', body: { mode: 'window' }, token: 'secret' })
})

test('without Node 22 a copy is downloaded once and runs the helper', async ($, on) => {
  const { runs, spawns } = world(on, { hasNode: false })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })

  const cache = `${HOME}/.cache/artifact-viewer/node`
  expect(runs).toContainEqual([
    'curl', '-fsSL', '-o', `${cache}/node-v24.11.0-darwin-arm64.tar.gz`,
    'https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz',
  ])
  expect(runs).toContainEqual(['tar', '-xf', `${cache}/node-v24.11.0-darwin-arm64.tar.gz`, '-C', cache])
  expect(spawns[0]?.[0]).toBe(`${cache}/node-v24.11.0-darwin-arm64/bin/node`)
})

test('Windows paths become file URLs and the cache sits in LOCALAPPDATA', async ($, on) => {
  const env = { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\t', LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }
  const { calls, spawns, toasts } = world(on, { env, isWindowsFs: true })
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\t\\claude-artifacts\\page.html', content: '<h1>x</h1>' })
  expect(ran.deny).toBeUndefined()
  expect(toasts).toEqual([])

  expect(spawns[0]?.[2]?.startsWith('C:/Users/t/claude-artifacts/.viewer/')).toBe(true)
  expect(spawns[0]?.slice(3)).toEqual(['C:/Users/t/AppData/Local/artifact-viewer', 'window'])
  expect(calls).toContainEqual({
    op: 'show',
    body: { url: 'file:///C:/Users/t/claude-artifacts/page.html', file: 'C:/Users/t/claude-artifacts/page.html' },
    token: 'secret',
  })
})

const FACTS = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

test('the system prompt tells the model where artifacts go', async ($, on) => {
  world(on)
  on('prompt.compose', async () => ({ sections: [] }))
  await $.session.start(START)

  const { sections } = await $.prompt.compose(FACTS)

  expect(sections[0]?.id).toBe('artifact-viewer:artifacts')
  expect(sections[0]?.text).toContain(`${HOME}/claude-artifacts/`)
})

test('the model is not told about the pane while no page renderer runs', async ($, on) => {
  mock.env(on, { HOME })
  on('prompt.compose', async () => ({ sections: [] }))

  expect((await $.prompt.compose(FACTS)).sections).toEqual([])
})
