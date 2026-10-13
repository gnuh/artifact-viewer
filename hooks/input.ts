import type { ClientModule } from 'claude-code'

// An empty region laid over the page's picture: it only catches the mouse and
// the keys and posts them to the hooks module, which hands them to the page.
// A release posts one whole click: posts made in one frame replace each other,
// so a separate down could be lost under its own up.
// ponytail: clicks only, no hover or drag; add move forwarding when a page needs it.
const Input: ClientModule<null, true> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type === 'up') {
        surface.post({ kind: 'click', x: event.fine?.x ?? event.x + 0.5, y: event.fine?.y ?? event.y + 0.5 })
      }
    })
    surface.onKey(event => surface.post({ kind: 'key', key: event.key }))
    surface.setState(true)
  }

  return surface.elements.Box({ width: surface.columns, height: surface.rows })
}

export default Input
