import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/t'
const PANE = { plugin: 'artifact-viewer', component: 'Pane', requestId: 'artifacts' } as const

function world(on: On, files: Record<string, string>) {
  const calls: { op: string; body: unknown }[] = []
  const opened: string[] = []
  mock.env(on, { HOME })
  on('fs.stat', async ($, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false, realPath: e.path } }))
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
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '18 36\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'ready\nframe /tmp/f-0.png 1\n' }
    // A live renderer: the stream stays open for the session's life.
    await new Promise(() => {})

    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async ($, e) => {
    calls.push({ op: e.url.slice('http://helper/'.length), body: JSON.parse(e.init?.body ?? '{}') })

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('ui.open', async ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.blit', async () => ({ value: {} }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('tool.call', async () => ({ result: {} as never }))

  return { calls, opened }
}

test('a written html file opens the pane and is rendered by the page helper', async ($, on) => {
  const files: Record<string, string> = {}
  const { calls, opened } = world(on, files)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })

  expect(opened).toContain('artifacts')
  expect(calls).toContainEqual({ op: 'show', body: { url: 'file:///p/page.html', file: '/p/page.html' } })
})

test('instruction files, ~/.claude files and edits of unshown markdown stay out', async ($, on) => {
  const files: Record<string, string> = { '/p/notes.md': '# hi' }
  const { opened } = world(on, files)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Edit', file_path: '/p/notes.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/p/CLAUDE.md', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: `${HOME}/.claude/plans/x.html`, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/p/app.ts', content: 'x' })

  expect(opened).toEqual([])
})

test('markdown is drawn as text and a page as a picture under a click region', { timeoutMs: 20000 }, async ($, on) => {
  const files: Record<string, string> = { '/p/notes.md': '# Relatório' }
  world(on, files)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/p/notes.md', content: '# Relatório' })

  const doc = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 80, scroll: { offset: 0, bodyRows: 30 } } as never })
  expect((await doc.find({ type: 'Markdown' }))?.text).toContain('Relatório')
  await doc.unmount()

  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<h1>x</h1>' })
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 80, scroll: { offset: 0, bodyRows: 30 } } as never })
  expect(await terminal.find({ type: 'Image', key: 'view' })).toBeDefined()
  expect(await terminal.find({ type: 'Client', key: 'input' })).toBeDefined()
  expect(await terminal.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: { bodyColumns: 80, scroll: { offset: 0, bodyRows: 30 } } as never })
  expect(await desktop.find({ type: 'Text', text: /Ghostty/ })).toBeDefined()
  await desktop.unmount()
})

test('a click on the picture reaches the page at the same spot', async ($, on) => {
  const files: Record<string, string> = {}
  const { calls } = world(on, files)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/p/page.html', content: '<button>x</button>' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } } as never })
  await ui.pointer({ type: 'down', x: 40, y: 10, button: 'left' })
  await ui.pointer({ type: 'up', x: 40, y: 10, button: 'left' })

  // 100x29 cells of 18x36 px at scale 2 make a 900x522 page; cell (40, 10) is centred at 40.5, 10.5.
  expect(calls).toContainEqual({ op: 'viewport', body: { width: 900, height: 522, scale: 2 } })
  expect(calls).toContainEqual({ op: 'click', body: { x: 364.5, y: 189 } })
  await ui.unmount()
})

test('the system prompt tells the model where artifacts go', async ($, on) => {
  mock.env(on, { HOME })
  on('prompt.compose', async () => ({ sections: [] }))

  const { sections } = await $.prompt.compose({
    model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [],
  })

  expect(sections[0]?.id).toBe('artifact-viewer:artifacts')
  expect(sections[0]?.text).toContain(`${HOME}/claude-artifacts/`)
})
