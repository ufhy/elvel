/**
 * The bar's stylesheet and script, as strings.
 *
 * Not TSX, and the reason is the shadow root. Everything the bar draws is built
 * in the browser inside a tree of its own so the application's stylesheet cannot
 * reach it and its own cannot reach the application — the single most common
 * complaint about Laravel Debugbar is its CSS landing on the page it is
 * inspecting.
 *
 * Every value that comes from an entry reaches the DOM through `textContent`.
 * There is no `innerHTML` in this file, which is what keeps a recorded SQL
 * string, a request path or a cached value from being markup on a page this
 * package does not own. A test enforces it.
 *
 * No backtick appears inside the script below, and that is not a style choice:
 * it ships inside a template literal, and one backtick would end the literal
 * somewhere in the middle of a function. The keyboard shortcut is matched on
 * `event.code === 'Backquote'` for the same reason, which also happens to be
 * the right way to match a key by position.
 */

/**
 * `String.raw`, so a CSS escape stays a CSS escape.
 *
 * `content: "\25B8"` is how a stylesheet writes a character, and in an ordinary
 * template literal TypeScript reads it as a JavaScript escape and refuses it as
 * octal. Raw is the right mode for every stylesheet, not a workaround for these
 * two rules.
 */
export const BAR_STYLE = String.raw`
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
  background: #1a202c; color: #e2e8f0; font-size: 12px; line-height: 1;
  border-top: 1px solid #2d3748; box-shadow: 0 -2px 12px rgba(0,0,0,.35);
}
.grip { height: 5px; cursor: ns-resize; background: transparent; }
.bar.open .grip { background: #2d3748; }
.strip { display: flex; align-items: stretch; height: 30px; overflow-x: auto; }
.chip {
  display: flex; align-items: center; gap: 6px; padding: 0 10px; cursor: pointer;
  border: 0; background: transparent; color: #a0aec0; font-size: 12px; white-space: nowrap;
  border-right: 1px solid #2d3748; font-family: inherit;
}
.chip:hover { background: #2d3748; color: #e2e8f0; }
.chip[aria-selected="true"] { background: #2d3748; color: #fff; box-shadow: inset 0 -2px 0 #FF2D20; }
.chip b { color: #e2e8f0; font-weight: 600; }
.chip .warn { color: #f6ad55; }
.mark { padding: 0 10px; display: flex; align-items: center; gap: 8px; background: #FF2D20; color: #fff; font-weight: 700; }
.spacer { flex: 1 1 auto; border-right: 0; cursor: default; }
.spacer:hover { background: transparent; }
.status-2 { color: #68d391; } .status-3 { color: #63b3ed; }
.status-4 { color: #f6ad55; } .status-5 { color: #fc8181; }
.panel { display: none; border-top: 1px solid #2d3748; min-height: 0; }
.bar.open .panel { display: flex; }
.side { width: 210px; flex: 0 0 210px; overflow-y: auto; border-right: 1px solid #2d3748; }
.side button {
  display: block; width: 100%; text-align: left; padding: 6px 10px; cursor: pointer;
  background: transparent; border: 0; border-bottom: 1px solid #22293a; color: #a0aec0;
  font-size: 11px; font-family: inherit;
}
.side button:hover:not(:disabled) { background: #2d3748; }
.side button:disabled { cursor: default; opacity: .55; }
.side button[aria-current="true"] { background: #2d3748; color: #fff; }
.side .path { display: block; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side .meta { display: block; margin-top: 3px; opacity: .7; }
.aside { padding: 8px 10px; color: #718096; line-height: 1.4; }
.middle { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.tools { display: flex; gap: 8px; padding: 5px 8px; border-bottom: 1px solid #22293a; align-items: center; }
.tools input {
  flex: 1 1 auto; min-width: 0; background: #12161f; color: #e2e8f0; font-size: 11px;
  border: 1px solid #2d3748; border-radius: 5px; padding: 4px 7px; font-family: inherit;
}
.tools input:focus { outline: 0; border-color: #FF2D20; }
.tools .count { color: #718096; white-space: nowrap; }
.list { flex: 1 1 auto; overflow-y: auto; }
.row {
  display: flex; gap: 10px; padding: 7px 10px; border-bottom: 1px solid #22293a;
  align-items: baseline; width: 100%; text-align: left; background: transparent;
  border-left: 0; border-right: 0; border-top: 0; color: inherit; cursor: pointer; font-family: inherit; font-size: 12px;
}
.row:hover { background: #22293a; }
.row[aria-current="true"] { background: #2d3748; }
.row .at { flex: 0 0 52px; text-align: right; color: #718096; font-variant-numeric: tabular-nums; }
.row .body { flex: 1 1 auto; min-width: 0; }
.row .title { color: #e2e8f0; word-break: break-word; white-space: pre-wrap; }
.row .sub { margin-top: 4px; color: #718096; }
.row .took { flex: 0 0 auto; color: #a0aec0; font-variant-numeric: tabular-nums; }
.row.is-slow .took { color: #fc8181; }
.dupe { display: inline-block; margin-left: 6px; padding: 1px 5px; border-radius: 8px; background: #744210; color: #fbd38d; }
a.frame, a.out { color: #63b3ed; text-decoration: none; }
a.frame:hover, a.out:hover { text-decoration: underline; }
.empty { padding: 14px; color: #718096; line-height: 1.5; }
.detail { width: 46%; flex: 0 0 46%; overflow-y: auto; border-left: 1px solid #2d3748; }
.detail .head { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid #22293a; }
.detail .head .who { flex: 1 1 auto; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail button.act {
  background: #12161f; color: #a0aec0; border: 1px solid #2d3748; border-radius: 5px;
  padding: 3px 7px; cursor: pointer; font-family: inherit; font-size: 11px;
}
.detail button.act:hover { color: #e2e8f0; border-color: #4a5568; }
.card { border-bottom: 1px solid #22293a; }
.card h3 { margin: 0; padding: 6px 10px; font-size: 11px; color: #718096; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
/* A block heading inside a summary puts the disclosure marker on its own line. */
.card summary { cursor: pointer; }
.card summary h3 { display: inline-block; }
.kv { margin: 0; padding: 2px 10px 8px; display: grid; grid-template-columns: minmax(80px, auto) 1fr; gap: 5px 12px; }
.kv dt { color: #718096; }
.kv dd { margin: 0; color: #e2e8f0; word-break: break-word; }
pre { margin: 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; color: #e2e8f0; line-height: 1.5; }
.src { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; padding: 4px 10px 8px; }
.src .n { color: #4a5568; text-align: right; }
.src .t { white-space: pre-wrap; word-break: break-word; }
.src .blame { color: #fc8181; }
.src .blame.n { color: #fc8181; }
.tree { padding: 4px 10px 8px; line-height: 1.6; }
.tree details { margin-left: 0; }
.tree summary { cursor: pointer; color: #a0aec0; list-style: none; }
.tree summary::-webkit-details-marker { display: none; }
.tree summary:before { content: "\25B8"; display: inline-block; width: 12px; color: #4a5568; }
.tree details[open] > summary:before { content: "\25BE"; }
.tree .kids { padding-left: 14px; border-left: 1px solid #22293a; margin-left: 5px; }
.tree .k { color: #90cdf4; }
.tree .s { color: #9ae6b4; }
.tree .n { color: #f6ad55; }
.tree .b { color: #d6bcfa; }
.tree .z { color: #718096; }
.live { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #68d391; }
`

/**
 * The client.
 *
 * Deliberately one file with no build step and no dependency: the bar is
 * injected into somebody else's page, and a page that already runs React must
 * not have to agree with it about anything.
 */
export const BAR_SCRIPT = String.raw`
(() => {
  const tag = document.currentScript
  if (tag === null || window.__elvelBar) return
  window.__elvelBar = true

  const endpoint = tag.dataset.endpoint
  const editor = tag.dataset.editor || ''
  const root = tag.dataset.root || ''

  let current = tag.dataset.batch
  let batch = null
  let recent = []
  let cursor = 0
  let crossProcess = false
  let open = null
  let selected = null
  let detail = null
  let filter = ''

  /** Per-viewer conveniences only. Any of these may throw in a private window. */
  const remembered = {
    get(key, fallback) {
      try {
        const held = localStorage.getItem('elvel.bar.' + key)
        return held === null ? fallback : held
      } catch {
        return fallback
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('elvel.bar.' + key, String(value))
      } catch {
        //
      }
    }
  }

  const host = document.createElement('div')
  host.id = 'elvel-bar-host'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = window.__elvelBarCss || ''
  shadow.appendChild(style)
  document.body.appendChild(host)

  const bar = node('div', 'bar')
  const grip = node('div', 'grip')
  const strip = node('div', 'strip')
  const panel = node('div', 'panel')
  const side = node('div', 'side')
  const middle = node('div', 'middle')
  const tools = node('div', 'tools')
  const search = document.createElement('input')
  const counter = node('span', 'count')
  const list = node('div', 'list')
  const details = node('div', 'detail')

  search.type = 'search'
  search.placeholder = 'Filter'
  search.oninput = () => {
    filter = search.value.toLowerCase()
    drawList()
  }

  tools.append(search, counter)
  middle.append(tools, list)
  panel.append(side, middle, details)
  bar.append(grip, strip, panel)
  shadow.appendChild(bar)

  let height = Number(remembered.get('height', 300)) || 300
  applyHeight()

  function node(name, className, text) {
    const element = document.createElement(name)
    if (className) element.className = className
    if (text !== undefined) element.textContent = String(text)
    return element
  }

  function ms(value) {
    const n = Number(value) || 0
    if (n >= 1000) return (n / 1000).toFixed(2) + 's'
    return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + 'ms'
  }

  function applyHeight() {
    panel.style.height = Math.max(120, Math.min(height, window.innerHeight - 80)) + 'px'
  }

  /**
   * A frame becomes a link only when an editor scheme is configured, because a
   * dead vscode:// link on a machine without VS Code is worse than plain text.
   */
  function place(file, line) {
    const inside = root && String(file).indexOf(root) === 0
    const shown = inside ? String(file).slice(root.length).replace(/^\//, '') : String(file)
    return line ? shown + ':' + line : shown
  }

  function frame(file, line) {
    if (!file) return null
    const label = place(file, line)
    if (!editor) return node('span', '', label)
    const link = node('a', 'frame', label)
    link.href = editor.replace('{file}', String(file)).replace('{line}', String(line || 1))
    return link
  }

  function describe(entry) {
    return entry.summary || { title: entry.type, sub: '', slow: false }
  }

  // ------------------------------------------------------------------ strip

  function draw() {
    strip.textContent = ''
    if (batch === null) return

    const brand = node('div', 'mark')
    brand.append(node('span', '', 'Lens'), node('i', 'live'))
    strip.appendChild(brand)

    const head = node('button', 'chip')
    head.type = 'button'
    head.dataset.type = 'request'
    head.append(node('b', '', batch.method + ' ' + batch.path))
    head.append(
      node('span', 'status-' + String(batch.status).charAt(0), batch.status),
      node('span', '', ms(batch.durationMs))
    )
    head.onclick = () => show('request')
    strip.appendChild(head)

    const byType = new Map()
    for (const entry of batch.entries) {
      if (!byType.has(entry.type)) byType.set(entry.type, [])
      byType.get(entry.type).push(entry)
    }

    for (const [type, entries] of byType) {
      if (type === 'request') continue
      const chip = node('button', 'chip')
      chip.type = 'button'
      chip.dataset.type = type
      chip.append(node('b', '', entries.length), node('span', '', type))

      // Counted on the server, in snapshot(); the badge only reads it.
      const worst = entries.reduce((most, entry) => Math.max(most, entry.repeats || 1), 1)
      if (worst > 1) chip.append(node('span', 'warn', 'N+1 ×' + worst))

      chip.onclick = () => show(type)
      strip.appendChild(chip)
    }

    strip.appendChild(node('div', 'chip spacer'))

    const close = node('button', 'chip')
    close.type = 'button'
    close.textContent = '×'
    close.title = 'Close (Ctrl + backquote)'
    close.onclick = () => show(null)
    strip.appendChild(close)
    highlight()
  }

  function highlight() {
    for (const chip of strip.querySelectorAll('.chip')) {
      chip.setAttribute('aria-selected', String(open !== null && chip.dataset.type === open))
    }
  }

  function show(type) {
    open = type === null || open === type ? null : type
    selected = null
    detail = null
    bar.classList.toggle('open', open !== null)
    remembered.set('open', open === null ? '' : open)
    highlight()
    drawSide()
    drawList()
    drawDetail()
  }

  // ------------------------------------------------------------------- side

  function drawSide() {
    side.textContent = ''

    for (const item of recent) {
      const own = item.source !== 'storage'
      const button = node('button', '')
      button.type = 'button'
      button.setAttribute('aria-current', String(item.batchId === current))
      button.appendChild(node('span', 'path', own ? item.method + ' ' + item.path : item.path))
      button.appendChild(
        node(
          'span',
          'meta',
          own ? item.status + ' · ' + ms(item.durationMs) + ' · ' + item.count : 'elsewhere'
        )
      )
      // A batch from another process has no entries here to switch to; it is
      // shown so the list does not pretend the worker did nothing.
      button.disabled = !own
      button.onclick = () => {
        current = item.batchId
        selected = null
        detail = null
        load(0)
      }
      side.appendChild(button)
    }

    if (!crossProcess) {
      side.appendChild(
        node(
          'div',
          'aside',
          'Queue and scheduler run in other processes. Set LENS_ENABLED=true to see them.'
        )
      )
    }
  }

  // ------------------------------------------------------------------- list

  function visible() {
    if (batch === null || open === null) return []
    return batch.entries.filter((entry) => {
      if (entry.type !== open) return false
      if (filter === '') return true
      const shown = describe(entry)
      return (shown.title + ' ' + shown.sub).toLowerCase().indexOf(filter) !== -1
    })
  }

  function drawList() {
    list.textContent = ''
    if (open === null) return

    const entries = visible()
    const all = batch === null ? [] : batch.entries.filter((entry) => entry.type === open)
    counter.textContent = entries.length + ' of ' + all.length

    if (entries.length === 0) {
      list.appendChild(node('div', 'empty', 'Nothing matches.'))
      return
    }

    for (const entry of entries) {
      const shown = describe(entry)
      const row = node('button', 'row' + (shown.slow ? ' is-slow' : ''))
      row.type = 'button'
      row.setAttribute('aria-current', String(entry.uuid === selected))
      row.appendChild(node('div', 'at', ms(entry.offsetMs)))

      const body = node('div', 'body')
      const title = node('div', 'title', shown.title)
      if ((entry.repeats || 1) > 1) title.appendChild(node('span', 'dupe', '×' + entry.repeats))
      body.appendChild(title)

      const sub = node('div', 'sub')
      if (shown.sub) sub.appendChild(node('span', '', shown.sub + '  '))
      // Text, not a link: an anchor inside a button is interactive content
      // nested in interactive content, and clicking it would open the row too.
      // The editor link lives in the detail this row opens.
      if (shown.file) sub.appendChild(node('span', '', place(shown.file, shown.line)))
      if (sub.childNodes.length > 0) body.appendChild(sub)

      row.appendChild(body)
      if (shown.took !== undefined && shown.took !== null) {
        row.appendChild(node('div', 'took', ms(shown.took)))
      }
      row.onclick = () => select(entry.uuid)
      list.appendChild(row)
    }
  }

  // ----------------------------------------------------------------- detail

  async function select(uuid) {
    selected = selected === uuid ? null : uuid
    detail = null
    drawList()
    drawDetail()
    if (selected === null) return

    try {
      const answer = await ask('/entry/' + selected)
      if (!answer.ok) return
      const found = await answer.json()
      if (found.uuid !== selected) return
      detail = found
      drawDetail()
    } catch {
      //
    }
  }

  function drawDetail() {
    details.textContent = ''
    details.style.display = selected === null ? 'none' : ''
    if (selected === null) return

    if (detail === null) {
      details.appendChild(node('div', 'empty', 'Loading…'))
      return
    }

    const head = node('div', 'head')
    head.appendChild(node('span', 'who', detail.type))

    const copy = node('button', 'act', 'Copy JSON')
    copy.type = 'button'
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(detail.content, null, 2))
        copy.textContent = 'Copied'
        setTimeout(() => { copy.textContent = 'Copy JSON' }, 1200)
      } catch {
        copy.textContent = 'Blocked'
      }
    }
    head.appendChild(copy)

    if (detail.dashboard) {
      const link = node('a', 'out', 'Open in Lens')
      link.href = detail.dashboard
      link.target = '_blank'
      link.rel = 'noreferrer'
      head.appendChild(link)
    }

    const close = node('button', 'act', '×')
    close.type = 'button'
    close.onclick = () => select(selected)
    head.appendChild(close)

    details.appendChild(head)

    for (const one of detail.panels) details.appendChild(card(one))

    details.appendChild(raw(detail.content))
  }

  function card(one) {
    if (one.kind === 'facts') {
      const box = node('div', 'card')
      const kv = node('dl', 'kv')
      for (const [name, value] of one.rows) {
        kv.appendChild(node('dt', '', name))
        const dd = node('dd', '')
        const link = name === 'Called from' || name === 'Where' || name === 'Checked at'
          ? linkify(value)
          : null
        if (link === null) dd.textContent = value
        else dd.appendChild(link)
        kv.appendChild(dd)
      }
      box.appendChild(kv)
      return box
    }

    if (one.kind === 'mapping') {
      const box = node('div', 'card')
      box.appendChild(node('h3', '', one.title))
      box.appendChild(treeOf(one.value))
      return box
    }

    if (one.kind === 'block') {
      const box = node('div', 'card')
      box.appendChild(node('h3', '', one.title))
      if (typeof one.value === 'string') box.appendChild(node('pre', '', one.value))
      else box.appendChild(treeOf(one.value))
      return box
    }

    if (one.kind === 'code') {
      const box = node('div', 'card')
      box.appendChild(node('h3', '', one.title))
      box.appendChild(node('pre', '', one.value))
      return box
    }

    if (one.kind === 'source') {
      const box = node('div', 'card')
      box.appendChild(node('h3', '', 'Source'))
      const grid = node('div', 'src')
      for (const [number, text] of one.lines) {
        const blame = number === one.blame ? ' blame' : ''
        grid.appendChild(node('span', 'n' + blame, number))
        grid.appendChild(node('span', 't' + blame, text))
      }
      box.appendChild(grid)
      return box
    }

    if (one.kind === 'trace') {
      const box = node('div', 'card')
      box.appendChild(node('h3', '', 'Stack · ' + one.frames.length))
      const grid = node('div', 'src')
      for (const at of one.frames) {
        const cell = node('span', 't')
        const link = frame(at.file, at.line)
        if (link === null) cell.textContent = at.file
        else cell.appendChild(link)
        grid.appendChild(node('span', 'n', at.line))
        grid.appendChild(cell)
      }
      box.appendChild(grid)
      return box
    }

    return node('div', 'card')
  }

  /** A file:line facts row becomes the same editor link a stack frame gets. */
  function linkify(value) {
    const match = /^(.*):(\d+)$/.exec(String(value))
    if (match === null) return null
    return frame(match[1], match[2])
  }

  function raw(content) {
    const box = node('div', 'card')
    const holder = document.createElement('details')
    const summary = document.createElement('summary')
    summary.appendChild(node('h3', '', 'Raw content'))
    holder.appendChild(summary)
    holder.appendChild(treeOf(content))
    box.appendChild(holder)
    return box
  }

  // ------------------------------------------------------------------- tree

  /**
   * A collapsible view of a value.
   *
   * The thing a bar of one-line rows cannot do, and the reason this is an
   * inspector rather than a log: a request's payload, a job's arguments and a
   * cached value are all objects, and reading one as a flattened string is
   * reading it by eye.
   */
  function treeOf(value) {
    const box = node('div', 'tree')
    box.appendChild(branch(null, value, 0))
    return box
  }

  function branch(key, value, depth) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

    if (kind !== 'object' && kind !== 'array') return leaf(key, value, kind)

    const entries = kind === 'array'
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value)

    if (entries.length === 0) {
      return leaf(key, kind === 'array' ? '[]' : '{}', 'empty')
    }

    const holder = document.createElement('details')
    // Two levels open, then folded. Deeper than that is somebody's own business.
    holder.open = depth < 2
    const summary = document.createElement('summary')
    if (key !== null) summary.appendChild(node('span', 'k', key + ': '))
    summary.appendChild(
      node('span', 'z', (kind === 'array' ? 'Array(' : 'Object(') + entries.length + ')')
    )
    holder.appendChild(summary)

    const kids = node('div', 'kids')
    for (const [name, held] of entries) kids.appendChild(branch(name, held, depth + 1))
    holder.appendChild(kids)

    return holder
  }

  function leaf(key, value, kind) {
    const line = node('div', '')
    if (key !== null) line.appendChild(node('span', 'k', key + ': '))
    const shown = kind === 'string' ? JSON.stringify(value) : String(value)
    line.appendChild(node('span', className(kind), shown))
    return line
  }

  function className(kind) {
    if (kind === 'string') return 's'
    if (kind === 'number') return 'n'
    if (kind === 'boolean') return 'b'
    return 'z'
  }

  // ------------------------------------------------------------------- wire

  function ask(path) {
    return fetch(endpoint + path, { headers: { accept: 'application/json' }, __elvelBar: true })
  }

  async function load(attempt) {
    try {
      const answer = await ask('/' + current)
      if (answer.status === 404 && attempt < 6) return setTimeout(() => load(attempt + 1), 120)
      if (!answer.ok) return
      batch = (await answer.json()).batch
      draw()
      drawList()
      await refresh()
    } catch {
      // A bar that cannot reach its endpoint says nothing rather than throwing
      // inside somebody else's page.
    }
  }

  /** The list is its own request, so a batch of entries is not fetched to draw it. */
  async function refresh() {
    try {
      const answer = await ask('?since=0')
      if (!answer.ok) return
      const payload = await answer.json()
      recent = payload.batches || []
      cursor = payload.cursor || 0
      crossProcess = payload.crossProcess === true
      drawSide()
    } catch {
      //
    }
  }

  /**
   * What the page does after it has loaded.
   *
   * Without this the bar is a snapshot: every fetch the page makes is recorded
   * on the server and invisible until a reload. The wrapper does not touch the
   * request — it waits for it to settle and then asks what is new, which keeps a
   * failing call the bar's business rather than the wrapper's.
   */
  let pending = null

  function later() {
    if (pending !== null) return
    pending = setTimeout(async () => {
      pending = null
      try {
        const answer = await ask('?since=' + cursor)
        if (!answer.ok) return
        const payload = await answer.json()
        const fresh = payload.batches || []
        cursor = payload.cursor || cursor
        if (fresh.length === 0) return
        // Newest first, and the bar's own endpoint is on the ignore list, so
        // nothing here can be the request that asked.
        recent = fresh.concat(recent).slice(0, 40)
        drawSide()
      } catch {
        //
      }
    }, 250)
  }

  function watchTheirRequests() {
    const original = window.fetch
    window.fetch = function (input, init) {
      const ours = init && init.__elvelBar === true
      const answer = original.apply(this, arguments)
      if (!ours) answer.then(later, later)
      return answer
    }

    const send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('loadend', later)
      return send.apply(this, arguments)
    }
  }

  // ------------------------------------------------------------------ input

  grip.addEventListener('pointerdown', (event) => {
    const from = event.clientY
    const was = height
    grip.setPointerCapture(event.pointerId)
    const move = (moved) => {
      height = was + (from - moved.clientY)
      applyHeight()
    }
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      remembered.set('height', Math.round(height))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
  })

  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.code !== 'Backquote') return
    event.preventDefault()
    show(open === null ? remembered.get('open', 'request') || 'request' : null)
  })

  window.addEventListener('resize', applyHeight)

  watchTheirRequests()
  load(0)
})()
`
