/**
 * The bar's stylesheet and script, as strings.
 *
 * Not TSX, and the reason is the shadow root. Everything the bar draws is built
 * in the browser inside a closed-off tree so the application's stylesheet cannot
 * reach it and its own cannot reach the application — the single most common
 * complaint about Laravel Debugbar is its CSS landing on the page it is
 * inspecting. A server-rendered fragment would be in the document's tree and
 * would inherit whatever the page says about div, table and button.
 *
 * Every value that comes from an entry reaches the DOM through `textContent`.
 * There is no `innerHTML` in this file with anything but a literal in it, which
 * is what keeps a recorded SQL string or a request path from being markup.
 */

export const BAR_STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
  background: #1a202c; color: #e2e8f0; font-size: 12px; line-height: 1;
  border-top: 1px solid #2d3748; box-shadow: 0 -2px 12px rgba(0,0,0,.35);
}
.strip { display: flex; align-items: stretch; height: 30px; overflow-x: auto; }
.chip {
  display: flex; align-items: center; gap: 6px; padding: 0 10px; cursor: pointer;
  border: 0; background: transparent; color: #a0aec0; font-size: 12px; white-space: nowrap;
  border-right: 1px solid #2d3748;
}
.chip:hover { background: #2d3748; color: #e2e8f0; }
.chip[aria-selected="true"] { background: #2d3748; color: #fff; box-shadow: inset 0 -2px 0 #FF2D20; }
.chip b { color: #e2e8f0; font-weight: 600; }
.chip .warn { color: #f6ad55; }
.mark { padding: 0 10px; display: flex; align-items: center; gap: 8px; background: #FF2D20; color: #fff; font-weight: 700; }
.spacer { flex: 1 1 auto; border-right: 0; }
.status-2 { color: #68d391; } .status-3 { color: #63b3ed; }
.status-4 { color: #f6ad55; } .status-5 { color: #fc8181; }
.panel { display: none; height: 300px; border-top: 1px solid #2d3748; }
.panel.open { display: flex; }
.side { width: 210px; flex: 0 0 210px; overflow-y: auto; border-right: 1px solid #2d3748; }
.side button {
  display: block; width: 100%; text-align: left; padding: 6px 10px; cursor: pointer;
  background: transparent; border: 0; border-bottom: 1px solid #22293a; color: #a0aec0; font-size: 11px;
}
.side button:hover:not(:disabled) { background: #2d3748; }
.side button:disabled { cursor: default; opacity: .55; }
.aside { padding: 8px 10px; color: #718096; line-height: 1.4; }
.side button[aria-current="true"] { background: #2d3748; color: #fff; }
.side .path { display: block; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side .meta { display: block; margin-top: 3px; opacity: .7; }
.list { flex: 1 1 auto; overflow-y: auto; }
.row { display: flex; gap: 10px; padding: 7px 10px; border-bottom: 1px solid #22293a; align-items: baseline; }
.row:hover { background: #22293a; }
.row .at { flex: 0 0 52px; text-align: right; color: #718096; font-variant-numeric: tabular-nums; }
.row .body { flex: 1 1 auto; min-width: 0; }
.row .title { color: #e2e8f0; word-break: break-word; white-space: pre-wrap; }
.row .sub { margin-top: 4px; color: #718096; }
.row .took { flex: 0 0 auto; color: #a0aec0; font-variant-numeric: tabular-nums; }
.row.is-slow .took { color: #fc8181; }
.dupe { display: inline-block; margin-left: 6px; padding: 1px 5px; border-radius: 8px; background: #744210; color: #fbd38d; }
a.frame { color: #63b3ed; text-decoration: none; }
a.frame:hover { text-decoration: underline; }
.empty { padding: 14px; color: #718096; }
.fall { display: flex; height: 4px; width: 120px; align-items: center; gap: 1px; }
.fall i { display: block; height: 4px; background: #4a5568; flex: 1 1 auto; }
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

  const host = document.createElement('div')
  host.id = 'elvel-bar-host'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = window.__elvelBarCss || ''
  shadow.appendChild(style)
  document.body.appendChild(host)

  const bar = node('div', 'bar')
  const strip = node('div', 'strip')
  const panel = node('div', 'panel')
  const side = node('div', 'side')
  const list = node('div', 'list')
  panel.append(side, list)
  bar.append(strip, panel)
  shadow.appendChild(bar)

  let open = null
  let batch = null

  function node(name, className, text) {
    const element = document.createElement(name)
    if (className) element.className = className
    if (text !== undefined) element.textContent = String(text)
    return element
  }

  function ms(value) {
    const n = Number(value) || 0
    if (n >= 1000) return (n / 1000).toFixed(2) + 's'
    // A sub-millisecond query rounding to '0ms' reads as 'not measured'.
    return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + 'ms'
  }

  /**
   * A frame becomes a link only when an editor scheme is configured, because a
   * dead vscode:// link on a machine without VS Code is worse than plain text.
   */
  function frame(file, line) {
    if (!file) return null
    const inside = root && String(file).startsWith(root)
    // Only a path that really is under the application loses its leading slash;
    // trimming it from every path turned /Users/... into Users/..., which reads
    // like a relative path that does not exist.
    const shown = inside ? String(file).slice(root.length).replace(/^\//, '') : String(file)
    const label = line ? shown + ':' + line : shown
    if (!editor) return node('span', '', label)
    const link = node('a', 'frame', label)
    link.href = editor.replace('{file}', String(file)).replace('{line}', String(line || 1))
    return link
  }

  /**
   * The one-line form comes from the server.
   *
   * It used to be a map of eighteen shapes here, which meant the browser knew
   * the field names of every kind of entry and could disagree with the
   * dashboard about them. It is now decided once in panels/describe.ts and
   * arrives on the wire; this is a renderer.
   */
  function describe(entry) {
    return entry.summary || { title: entry.type, sub: '', slow: false }
  }

  function draw() {
    strip.textContent = ''
    if (batch === null) return

    const brand = node('div', 'mark')
    brand.append(node('span', '', 'Lens'))
    strip.appendChild(brand)

    const head = node('button', 'chip')
    head.type = 'button'
    head.dataset.type = 'request'
    head.append(node('b', '', batch.method + ' ' + batch.path))
    const code = node('span', 'status-' + String(batch.status).charAt(0), batch.status)
    head.append(code, node('span', '', ms(batch.durationMs)))
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
    panel.classList.toggle('open', open !== null)
    highlight()
    drawSide()
    drawList()
  }

  function drawList() {
    list.textContent = ''
    if (batch === null || open === null) return

    const entries = batch.entries.filter((entry) => entry.type === open)
    if (entries.length === 0) {
      list.appendChild(node('div', 'empty', 'Nothing recorded for ' + open + '.'))
      return
    }

    for (const entry of entries) {
      const shown = describe(entry)
      const row = node('div', 'row' + (shown.slow ? ' is-slow' : ''))
      row.appendChild(node('div', 'at', ms(entry.offsetMs)))

      const body = node('div', 'body')
      const title = node('div', 'title', shown.title)
      if ((entry.repeats || 1) > 1) title.appendChild(node('span', 'dupe', '×' + entry.repeats))
      body.appendChild(title)

      const sub = node('div', 'sub')
      if (shown.sub) sub.appendChild(node('span', '', shown.sub + '  '))
      const where = frame(shown.file, shown.line)
      if (where !== null) sub.appendChild(where)
      if (sub.childNodes.length > 0) body.appendChild(sub)

      row.appendChild(body)
      if (shown.took !== undefined && shown.took !== null) {
        row.appendChild(node('div', 'took', ms(shown.took)))
      }
      list.appendChild(row)
    }
  }

  function drawSide() {
    side.textContent = ''
    for (const item of recent) {
      const button = node('button', '')
      button.type = 'button'
      button.setAttribute('aria-current', String(item.batchId === current))
      const own = item.source !== 'storage'
      button.appendChild(node('span', 'path', own ? item.method + ' ' + item.path : item.path))
      button.appendChild(
        node('span', 'meta', own ? item.status + ' · ' + ms(item.durationMs) + ' · ' + item.count : 'elsewhere')
      )
      // A batch from another process has no entries here to switch to; it is
      // shown so the list does not pretend the worker did nothing.
      button.disabled = !own
      button.onclick = () => { current = item.batchId; load(0) }
      side.appendChild(button)
    }

    /**
     * Said once, at the foot of the list.
     *
     * Without storage the worker and the scheduler are invisible to this
     * process, and an inspector that silently shows nothing is worse than one
     * that names its blind spot.
     */
    if (!crossProcess) {
      side.appendChild(node('div', 'aside', 'Queue and scheduler run in other processes. Set LENS_ENABLED=true to see them.'))
    }
  }

  let recent = []
  let crossProcess = false

  /**
   * The batch is written to the ring after the response has been sent, so the
   * first ask can legitimately be too early. Retried rather than waited for on
   * the server, which would hold a connection open on every page load.
   */
  async function ask(path) {
    return fetch(endpoint + path, { headers: { accept: 'application/json' } })
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
      crossProcess = payload.crossProcess === true
      drawSide()
    } catch {
      //
    }
  }

  load(0)
})()
`
