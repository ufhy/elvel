/**
 * The bar's stylesheet and script, as strings.
 *
 * Not TSX, and the reason is the shadow root. Everything the bar draws is built
 * in the browser inside a tree of its own so the application's stylesheet cannot
 * reach it and its own cannot reach the application — the single most common
 * complaint about Laravel Debugbar is its CSS landing on the page it inspects.
 *
 * Every value that comes from an entry reaches the DOM through `textContent`.
 * There is no `innerHTML` in this file, which is what keeps a recorded SQL
 * string, a request path or a cached value from becoming markup on a page this
 * package does not own. A test enforces it.
 *
 * No backtick appears in either string below, and that is not a style choice:
 * they ship inside template literals, and one backtick would end the literal
 * somewhere in the middle of a function. The keyboard shortcut is matched on
 * `event.code === 'Backquote'` for the same reason — which also happens to be
 * the right way to match a key by position.
 *
 * What the client does *not* do is decide anything. Findings, the time split,
 * the baseline verdict and the profile are all worked out on the server, where
 * they can be tested. This file draws them.
 */

/**
 * `String.raw`, so a CSS escape stays a CSS escape.
 *
 * `content: "\25B8"` is how a stylesheet writes a character, and in an ordinary
 * template literal TypeScript reads it as a JavaScript escape and refuses it as
 * octal.
 */
export const BAR_STYLE = String.raw`
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
  background: #12161f; color: #e2e8f0; font-size: 12px; line-height: 1;
  border-top: 1px solid #2d3748; box-shadow: 0 -2px 14px rgba(0,0,0,.4);
}
.grip { height: 5px; cursor: ns-resize; }
.bar.open .grip { background: #2d3748; }

.verdict { display: flex; align-items: stretch; height: 34px; overflow-x: auto; }
.mark { padding: 0 10px; display: flex; align-items: center; gap: 7px; background: #FF2D20; color: #fff; font-weight: 700; cursor: pointer; border: 0; font-family: inherit; font-size: 12px; }
.mark.bad { background: #c53030; }
.mark[aria-selected="true"] { box-shadow: inset 0 -2px 0 #12161f; }
.cell { display: flex; align-items: center; gap: 7px; padding: 0 12px; border-right: 1px solid #22293a; white-space: nowrap; color: #a0aec0; }
.cell b { color: #e2e8f0; font-weight: 600; font-variant-numeric: tabular-nums; }
.cell.pill { cursor: pointer; background: transparent; border-top: 0; border-bottom: 0; border-left: 0; font-family: inherit; font-size: 12px; }
.cell.pill:hover { background: #1a202c; color: #e2e8f0; }
.cell[aria-selected="true"] { background: #1a202c; color: #fff; box-shadow: inset 0 -2px 0 #FF2D20; }
.cell .bad { color: #fc8181; }
.cell .warn { color: #f6ad55; }
.cell .good { color: #68d391; }
.spacer { flex: 1 1 auto; border-right: 0; }
.build { color: #4a5568; font-size: 10px; letter-spacing: .04em; }
.status-2 { color: #68d391; } .status-3 { color: #63b3ed; }
.status-4 { color: #f6ad55; } .status-5 { color: #fc8181; }

.split { display: flex; height: 3px; width: 90px; border-radius: 2px; overflow: hidden; background: #22293a; }
.split i { display: block; height: 3px; }
.split .db { background: #63b3ed; }
.split .view { background: #b794f4; }
.split .rest { background: #4a5568; }

.panel { display: none; border-top: 1px solid #2d3748; min-height: 0; }
.bar.open .panel { display: flex; }
.pane { flex: 1 1 0; overflow-y: auto; min-width: 0; }
.pane + .pane { border-left: 1px solid #22293a; }
/* Navigation, always the same width and never replaced by anything. */
.pane.narrow { flex: 0 0 210px; }
.pane.detail { flex: 0 0 44%; }
@media (max-width: 1000px) { .pane.detail { flex: 1 1 0; } .pane.narrow { flex: 0 0 160px; } }

.head { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid #22293a; position: sticky; top: 0; background: #12161f; }
.head .who { flex: 1 1 auto; color: #718096; text-transform: uppercase; letter-spacing: .05em; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.act { background: #1a202c; color: #a0aec0; border: 1px solid #2d3748; border-radius: 5px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
button.act:hover { color: #e2e8f0; border-color: #4a5568; }
button.act:disabled { opacity: .5; cursor: default; }
input.find { flex: 1 1 auto; min-width: 0; background: #0d1017; color: #e2e8f0; font-size: 11px; border: 1px solid #2d3748; border-radius: 5px; padding: 4px 7px; font-family: inherit; }
input.find:focus { outline: 0; border-color: #FF2D20; }

.finding { border-bottom: 1px solid #22293a; padding: 9px 10px; cursor: pointer; }
.finding:hover { background: #1a202c; }
.finding[aria-current="true"] { background: #1a202c; box-shadow: inset 2px 0 0 #FF2D20; }
.finding .t { display: flex; gap: 8px; align-items: baseline; }
.finding .dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; margin-top: 3px; background: #f6ad55; }
.finding.problem .dot { background: #fc8181; }
.finding .title { flex: 1 1 auto; color: #e2e8f0; line-height: 1.35; }
.finding .cost { flex: 0 0 auto; color: #a0aec0; font-variant-numeric: tabular-nums; }
.finding .d { margin: 5px 0 0 14px; color: #718096; line-height: 1.45; word-break: break-word; }
.stages { padding: 10px 10px 8px; border-bottom: 1px solid #22293a; }
.phases { display: flex; height: 10px; border-radius: 3px; overflow: hidden; background: #1a202c; }
.phases .phase { display: block; height: 10px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; color: #718096; }
.legend .key { display: flex; align-items: center; gap: 5px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: block; }
.phase-middleware, .legend i.phase-middleware { background: #4a5568; }
.phase-handler, .legend i.phase-handler { background: #63b3ed; }
.phase-response, .legend i.phase-response { background: #b794f4; }
.phase-sent, .legend i.phase-sent { background: #2d3748; }

.proof { display: flex; align-items: center; gap: 12px; margin: 8px 0 0 14px; flex-wrap: wrap; }
.proof .facts { color: #a0aec0; font-variant-numeric: tabular-nums; }

.clear { padding: 16px 12px; color: #718096; line-height: 1.6; }
.clear b { color: #68d391; }

.row { display: flex; gap: 10px; padding: 7px 10px; border-bottom: 1px solid #22293a; align-items: baseline; width: 100%; text-align: left; background: transparent; border-left: 0; border-right: 0; border-top: 0; color: inherit; cursor: pointer; font-family: inherit; font-size: 12px; }
.row:hover { background: #1a202c; }
.row[aria-current="true"] { background: #1a202c; }
.row .at { flex: 0 0 50px; text-align: right; color: #718096; font-variant-numeric: tabular-nums; }
.row .body { flex: 1 1 auto; min-width: 0; }
.row .title { color: #e2e8f0; word-break: break-word; white-space: pre-wrap; }
.row .sub { margin-top: 4px; color: #718096; }
.row .took { flex: 0 0 auto; color: #a0aec0; font-variant-numeric: tabular-nums; }
.row.is-slow .took { color: #fc8181; }
.dupe { display: inline-block; margin-left: 6px; padding: 1px 5px; border-radius: 8px; background: #744210; color: #fbd38d; }

.side button { display: block; width: 100%; text-align: left; padding: 6px 10px; cursor: pointer; background: transparent; border: 0; border-bottom: 1px solid #22293a; color: #a0aec0; font-size: 11px; font-family: inherit; }
.side button:hover:not(:disabled) { background: #1a202c; }
.side button:disabled { cursor: default; opacity: .55; }
.side button[aria-current="true"] { background: #1a202c; color: #fff; }
.side .path { display: block; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side .meta { display: block; margin-top: 3px; opacity: .7; }
.side .flag { color: #fc8181; }
.aside { padding: 8px 10px; color: #718096; line-height: 1.45; }

.card { border-bottom: 1px solid #22293a; }
.card h3 { margin: 0; padding: 6px 10px; font-size: 10px; color: #718096; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.card summary { cursor: pointer; }
.card summary h3 { display: inline-block; }
.kv { margin: 0; padding: 2px 10px 8px; display: grid; grid-template-columns: minmax(78px, auto) 1fr; gap: 5px 12px; }
.kv dt { color: #718096; }
.kv dd { margin: 0; color: #e2e8f0; word-break: break-word; }
pre { margin: 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; color: #e2e8f0; line-height: 1.5; }
a.frame, a.out { color: #63b3ed; text-decoration: none; }
a.frame:hover, a.out:hover { text-decoration: underline; }
.empty { padding: 14px; color: #718096; line-height: 1.5; }

.src { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; padding: 4px 10px 8px; }
.src .n { color: #4a5568; text-align: right; }
.src .t { white-space: pre-wrap; word-break: break-word; }
.src .blame { color: #fc8181; }

.lane {
  display: grid; grid-template-columns: 50px 1fr minmax(0, 44%) auto; gap: 10px; align-items: center;
  width: 100%; padding: 6px 10px; border: 0; border-bottom: 1px solid #22293a;
  background: transparent; color: inherit; cursor: pointer; font-family: inherit; font-size: 12px; text-align: left;
}
.lane:hover { background: #1a202c; }
.lane[aria-current="true"] { background: #1a202c; }
.lane .at { color: #718096; text-align: right; font-variant-numeric: tabular-nums; }
.lane .track { position: relative; height: 8px; background: #1a202c; border-radius: 2px; overflow: hidden; }
.lane .track i { position: absolute; top: 0; height: 8px; min-width: 2px; border-radius: 2px; background: #4a5568; }
.lane .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lane .kind { color: #718096; margin-right: 8px; }
.lane .what { color: #e2e8f0; }
.lane .took { color: #a0aec0; font-variant-numeric: tabular-nums; }
/* The .lane .track i rule sets the fallback and outranks a bare class, so these
   have to be at least as specific or every bar comes out grey. */
.lane .track i.kind-query { background: #63b3ed; }
.lane .track i.kind-view { background: #b794f4; }
.lane .track i.kind-cache { background: #68d391; }
.lane .track i.kind-model { background: #f6ad55; }
.lane .track i.kind-exception, .lane .track i.kind-log { background: #fc8181; }
.lane .track i.kind-job, .lane .track i.kind-batch, .lane .track i.kind-schedule { background: #f6e05e; }
.lane .track i.kind-mail, .lane .track i.kind-notification { background: #4fd1c5; }
.lane .track i.kind-client_request { background: #90cdf4; }
.lane .track i.kind-event, .lane .track i.kind-dump, .lane .track i.kind-gate { background: #718096; }
.hot { display: grid; grid-template-columns: 44px 1fr auto; gap: 4px 10px; padding: 4px 10px 10px; align-items: center; }
.hot .ms { color: #e2e8f0; text-align: right; font-variant-numeric: tabular-nums; }
.hot .who { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hot .name { color: #e2e8f0; }
.hot .at { color: #718096; }
.hot .meter { width: 90px; height: 4px; background: #22293a; border-radius: 2px; overflow: hidden; }
.hot .meter i { display: block; height: 4px; background: #FF2D20; }

.tree { padding: 4px 10px 8px; line-height: 1.6; }
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
`

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
  /** 'findings' | 'profile' | 'costs' | an entry type. Null means closed. */
  let view = null
  let picked = null
  let entry = null
  let costs = []
  let find = ''

  /** Per-viewer conveniences only. Any of these may throw in a private window. */
  const kept = {
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
  const sheet = document.createElement('style')
  sheet.textContent = window.__elvelBarCss || ''
  shadow.appendChild(sheet)
  document.body.appendChild(host)

  const bar = node('div', 'bar')
  const grip = node('div', 'grip')
  const verdict = node('div', 'verdict')
  const panel = node('div', 'panel')
  /**
   * Three panes with fixed jobs, left to right: which request, what about it,
   * and the detail of one thing.
   *
   * The first arrangement put Recent on the right and let the detail replace it,
   * so choosing a request meant losing the pane you chose it from. Navigation
   * does not move and does not get overwritten.
   */
  const side = node('div', 'pane side narrow')
  const middle = node('div', 'pane')
  const detailPane = node('div', 'pane detail')
  panel.append(side, middle, detailPane)
  bar.append(grip, verdict, panel)
  shadow.appendChild(bar)

  let height = Number(kept.get('height', 320)) || 320
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
    panel.style.height = Math.max(140, Math.min(height, window.innerHeight - 80)) + 'px'
  }

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

  // --------------------------------------------------------------- verdict

  /**
   * The line that makes this an inspector rather than a log.
   *
   * A Debugbar strip counts things: 12 queries, 3 views. Counting is not an
   * answer. This says where the time went and how many problems were found, so
   * a bad page is obvious without opening anything.
   */
  function drawVerdict() {
    verdict.textContent = ''
    if (batch === null) return

    const problems = batch.found.filter((one) => one.level === 'problem').length

    const brand = node('button', 'mark' + (problems > 0 ? ' bad' : ''))
    brand.type = 'button'
    brand.dataset.view = 'findings'
    brand.title = 'Findings'
    brand.append(node('span', '', problems > 0 ? problems + ' problem' + (problems === 1 ? '' : 's') : 'Lens'))
    brand.onclick = () => show('findings')
    verdict.appendChild(brand)

    /** The request itself, and one click to everything it carried. */
    const where = node('button', 'cell pill')
    where.type = 'button'
    where.dataset.view = 'request'
    where.append(
      node('b', '', batch.method + ' ' + batch.path),
      node('span', 'status-' + String(batch.status).charAt(0), batch.status)
    )
    where.onclick = () => show('request')
    verdict.appendChild(where)

    /**
     * The split, and a tab of its own.
     *
     * It briefly opened the findings, which the badge beside it already did —
     * two buttons, one destination. Removing it was worse: the number people
     * actually reach for stopped being reachable. It now opens the thing it
     * describes, which is where those milliseconds went, in order.
     */
    const shape = batch.shape
    const time = node('button', 'cell pill')
    time.type = 'button'
    time.dataset.view = 'timeline'
    time.title = 'Timeline'
    time.append(node('b', '', ms(shape.totalMs)))
    time.appendChild(meter(shape))
    time.append(
      node('span', '', 'db ' + ms(shape.databaseMs)),
      node('span', '', 'view ' + ms(shape.renderMs)),
      node('span', '', 'app ' + ms(shape.otherMs))
    )
    /**
     * The baseline joins the timing rather than standing as a tab of its own.
     *
     * It is only known once a route has been seen a few times — a multiple
     * against two samples is noise — so as a tab it appeared and disappeared
     * while you worked, which reads as the bar rearranging itself. It is a fact
     * about this number, so it lives beside this number, and the route costs are
     * reached from the timeline that shows them.
     */
    if (batch.verdict && batch.verdict.times !== undefined && batch.verdict.samples > 3) {
      const how = batch.verdict.times
      const tone = how >= 2 ? 'bad' : how <= 0.6 ? 'good' : 'warn'

      time.append(node('span', tone, how.toFixed(1) + '\u00d7 median'))
    }

    time.onclick = () => show('timeline')
    verdict.appendChild(time)

    const counts = new Map()
    for (const held of batch.entries) counts.set(held.type, (counts.get(held.type) || 0) + 1)

    for (const [type, n] of counts) {
      if (type === 'request') continue

      const cell = node('button', 'cell pill')
      cell.type = 'button'
      cell.dataset.view = type
      cell.append(node('b', '', n), node('span', '', type))
      cell.onclick = () => show(type)
      verdict.appendChild(cell)
    }

    verdict.appendChild(node('div', 'cell spacer'))

    const profile = node('button', 'cell pill')
    profile.type = 'button'
    profile.dataset.view = 'profile'
    profile.textContent = batch.profile ? 'Profile · ' + batch.profile.samples : 'Profile'
    profile.onclick = () => (batch.profile ? show('profile') : armProfiler(profile))
    verdict.appendChild(profile)

    /**
     * Which build of the bar this page is running.
     *
     * A dev tool inlined into a page is invisibly cacheable: you change it,
     * reload, and see the old one with nothing saying so. This is the glance
     * that settles it.
     */
    const build = node('div', 'cell build', tag.dataset.build || '')
    build.title = 'Lens bar build'
    verdict.appendChild(build)

    const close = node('button', 'cell pill')
    close.type = 'button'
    close.textContent = '×'
    close.title = 'Close (Ctrl + backquote)'
    close.onclick = () => show(null)
    verdict.appendChild(close)

    mark()
  }

  function meter(shape) {
    const box = node('span', 'split')
    const total = Math.max(shape.totalMs, 0.01)
    for (const [name, value] of [['db', shape.databaseMs], ['view', shape.renderMs], ['rest', shape.otherMs]]) {
      const part = node('i', name)
      part.style.width = Math.max(0, (value / total) * 100) + '%'
      box.appendChild(part)
    }
    return box
  }

  function mark() {
    for (const cell of verdict.querySelectorAll('.cell, .mark')) {
      cell.setAttribute('aria-selected', String(view !== null && cell.dataset.view === view))
    }
  }

  /**
   * Arming samples from now until the next request ends, so the page has to be
   * reloaded for the profile to be about anything.
   */
  async function armProfiler(button) {
    button.disabled = true
    try {
      const answer = await ask('/profile')
      button.textContent = answer.ok ? 'Reload to profile' : 'Profiler refused'
    } catch {
      button.textContent = 'Profiler failed'
    }
  }

  function show(next) {
    view = next === null || view === next ? null : next
    picked = null
    entry = null
    bar.classList.toggle('open', view !== null)
    kept.set('view', view === null ? '' : view)
    mark()
    drawRecent()
    drawView()
    drawDetail()
    if (view === 'costs') loadCosts()

    /**
     * There is only ever one request entry, so making somebody click a list of
     * one to reach it is a step for nothing. Its detail opens with the tab.
     */
    if (view === 'request' && batch !== null) {
      const only = batch.entries.find((held) => held.type === 'request')

      if (only !== undefined) open(only.uuid)
    }
  }

  /** Everything below the strip, from whatever state we are in. */
  function drawPanel() {
    drawRecent()
    drawView()
    drawDetail()
  }

  // ------------------------------------------------------------------ left

  function drawView() {
    middle.textContent = ''
    if (view === null || batch === null) return

    if (view === 'findings') return drawFindings()
    if (view === 'timeline') return drawTimeline()
    if (view === 'profile') return drawProfile()
    if (view === 'costs') return drawCosts()

    drawEntries()
  }

  /**
   * Findings first, and by default. The whole redesign is this list existing
   * before the data does.
   */
  function drawFindings() {
    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'Findings'))
    middle.appendChild(head)

    if (batch.found.length === 0) {
      const clear = node('div', 'clear')
      clear.append(node('b', '', 'Nothing to report.'), node('div', '', ''))
      clear.appendChild(
        node('div', '', 'No repeated queries, no slow ones, no swallowed exceptions, nothing oversized.')
      )
      middle.appendChild(clear)
      return
    }

    for (const one of batch.found) {
      const box = node('div', 'finding ' + one.level)
      box.setAttribute('aria-current', String(picked === one.id))
      const line = node('div', 't')
      line.appendChild(node('span', 'dot'))
      line.appendChild(node('span', 'title', one.title))
      if (one.cost !== undefined && one.cost !== null) {
        line.appendChild(node('span', 'cost', ms(one.cost)))
      }
      box.appendChild(line)
      box.appendChild(node('div', 'd', one.detail))
      /**
       * A finding summarises its own evidence rather than opening it.
       *
       * Selecting one used to throw a full query panel into the detail pane,
       * which is the query tab's job and made the findings view a detour to
       * somewhere else. A few lines here answer "which ones?" in place; the row
       * that needs the whole panel is one more click.
       */
      box.onclick = () => {
        picked = picked === one.id ? null : one.id
        drawView()
      }

      if (picked === one.id) box.appendChild(evidenceOf(one))

      middle.appendChild(box)
    }
  }

  /**
   * The evidence behind a finding, summarised — not listed.
   *
   * Listing it printed eight identical statements under an N+1, which is a list
   * of the same thing eight times and tells nobody anything the count did not.
   * A finding says how many, how long and when; the tab that owns those entries
   * is one button away and already knows how to show them.
   */
  function evidenceOf(one) {
    const box = node('div', 'proof')
    const held = new Map()

    for (const found of batch.entries) held.set(found.uuid, found)

    const proof = one.evidence.map((uuid) => held.get(uuid)).filter((found) => found !== undefined)

    if (proof.length === 0) return box

    const type = proof[0].type
    const times = proof
      .map((found) => Number((found.summary || {}).took || 0))
      .filter((took) => took > 0)
    const facts = []

    if (proof.length > 1) facts.push(proof.length + ' \u00d7 ' + type)
    if (times.length > 0) {
      facts.push('total ' + ms(times.reduce((sum, took) => sum + took, 0)))
      if (proof.length > 1) facts.push('slowest ' + ms(Math.max.apply(null, times)))
    }

    facts.push('first at ' + ms(proof[0].offsetMs))

    if (proof.length > 1) {
      facts.push('last at ' + ms(proof[proof.length - 1].offsetMs))
    }

    box.appendChild(node('span', 'facts', facts.join('  \u00b7  ')))

    const go = node('button', 'act')
    go.type = 'button'
    go.textContent = proof.length > 1 ? 'Show in ' + type : 'Open'
    go.onclick = (event) => {
      event.stopPropagation()

      if (proof.length === 1) return open(proof[0].uuid)

      /**
       * Hand off to the tab that owns these, filtered to them. A finding names
       * a problem; the tab is where the rows live, and duplicating the rows here
       * would be two places to keep agreeing.
       */
      view = type
      picked = null
      find = String((proof[0].summary || {}).title || '').toLowerCase()
      mark()
      drawView()
    }
    box.appendChild(go)

    return box
  }

  function drawEntries() {
    const head = node('div', 'head')
    const box = document.createElement('input')
    box.className = 'find'
    box.type = 'search'
    box.placeholder = 'Filter ' + view
    box.value = find
    box.oninput = () => {
      find = box.value.toLowerCase()
      const at = middle.scrollTop
      drawView()
      middle.scrollTop = at
      const again = middle.querySelector('input.find')
      if (again) {
        again.focus()
        again.setSelectionRange(again.value.length, again.value.length)
      }
    }
    head.appendChild(box)
    middle.appendChild(head)

    const rows = batch.entries.filter((held) => {
      if (held.type !== view) return false
      if (find === '') return true
      const shown = held.summary || {}
      return ((shown.title || '') + ' ' + (shown.sub || '')).toLowerCase().indexOf(find) !== -1
    })

    if (rows.length === 0) {
      middle.appendChild(node('div', 'empty', 'Nothing matches.'))
      return
    }

    for (const held of rows) {
      const shown = held.summary || { title: held.type, sub: '' }
      const row = node('button', 'row' + (shown.slow ? ' is-slow' : ''))
      row.type = 'button'
      row.setAttribute('aria-current', String(held.uuid === (entry && entry.uuid)))
      row.appendChild(node('div', 'at', ms(held.offsetMs)))

      const body = node('div', 'body')
      const title = node('div', 'title', shown.title)
      if ((held.repeats || 1) > 1) title.appendChild(node('span', 'dupe', '×' + held.repeats))
      body.appendChild(title)

      const sub = node('div', 'sub')
      if (shown.sub) sub.appendChild(node('span', '', shown.sub + '  '))
      if (shown.file) sub.appendChild(node('span', '', place(shown.file, shown.line)))
      if (sub.childNodes.length > 0) body.appendChild(sub)

      row.appendChild(body)
      if (shown.took !== undefined && shown.took !== null) {
        row.appendChild(node('div', 'took', ms(shown.took)))
      }
      row.onclick = () => open(held.uuid)
      middle.appendChild(row)
    }
  }

  /**
   * Where the milliseconds went, in the order they went.
   *
   * The split in the strip says how much; this says when, and next to what. An
   * N+1 is a picket fence, a slow query is one long bar with nothing beside it,
   * and a request that spent its time in neither is a gap — which is the answer
   * the three numbers alone cannot give.
   */
  function drawTimeline() {
    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'Timeline'))

    if (batch.verdict && batch.verdict.samples > 1) {
      const compare = node('button', 'act')
      compare.type = 'button'
      compare.textContent =
        'Median ' + ms(batch.verdict.medianMs) + ' over ' + batch.verdict.samples
      compare.title = 'What every route costs this session'
      compare.onclick = () => show('costs')
      head.appendChild(compare)
    }

    middle.appendChild(head)

    const total = Math.max(batch.shape.totalMs, 0.01)

    middle.appendChild(stages(total))

    const timed = batch.entries
      .filter((held) => held.type !== 'request')
      .sort((a, b) => a.offsetMs - b.offsetMs)

    if (timed.length === 0) {
      middle.appendChild(node('div', 'empty', 'Nothing was recorded inside this request.'))
      return
    }

    for (const held of timed) {
      const shown = held.summary || { title: held.type, sub: '' }
      const took = Number(shown.took ?? 0)
      const row = node('button', 'lane')
      row.type = 'button'
      row.setAttribute('aria-current', String(held.uuid === (entry && entry.uuid)))

      row.appendChild(node('span', 'at', ms(held.offsetMs)))

      const track = node('span', 'track')
      const fill = node('i', 'kind-' + held.type)
      // A bar for something that took no measurable time still has to be visible.
      fill.style.left = Math.min(99, (held.offsetMs / total) * 100) + '%'
      fill.style.width = Math.max(0.6, (took / total) * 100) + '%'
      track.appendChild(fill)
      row.appendChild(track)

      const label = node('span', 'label')
      label.appendChild(node('span', 'kind', held.type))
      label.appendChild(node('span', 'what', shown.title))
      row.appendChild(label)

      row.appendChild(node('span', 'took', took > 0 ? ms(took) : ''))
      row.onclick = () => open(held.uuid)
      middle.appendChild(row)
    }
  }

  /**
   * The request's own progress, arrival to response.
   *
   * The entries below are what the application did; this is what the framework
   * was doing around them. Without it a request that spent nine milliseconds in
   * neither the database nor rendering was a number with no shape — this says
   * whether that time was middleware, the handler, or building the response.
   *
   * The stages come from Elysia's own boundaries. An unmatched path has fewer of
   * them, because Elysia runs neither the before- nor after-handle stage for
   * one, which is itself the answer to why a 404 was fast.
   */
  function stages(total) {
    const box = node('div', 'stages')
    const marks = batch.marks || []
    const named = { middleware: 'middleware', handler: 'handler', response: 'response' }
    let from = 0
    const parts = []

    for (const at of marks) {
      parts.push({ name: named[at.name] || at.name, from: from, to: at.atMs })
      from = at.atMs
    }

    parts.push({ name: 'sent', from: from, to: total })

    const track = node('div', 'phases')
    for (const part of parts) {
      const width = Math.max(0, ((part.to - part.from) / total) * 100)

      if (width <= 0) continue

      const piece = node('span', 'phase phase-' + part.name)
      piece.style.width = width + '%'
      piece.title = part.name + ' ' + ms(part.to - part.from)
      track.appendChild(piece)
    }
    box.appendChild(track)

    const legend = node('div', 'legend')
    for (const part of parts) {
      const item = node('span', 'key')
      item.appendChild(node('i', 'phase-' + part.name))
      item.appendChild(node('span', '', part.name + ' ' + ms(part.to - part.from)))
      legend.appendChild(item)
    }
    box.appendChild(legend)

    return box
  }

  /**
   * Where the time actually went, from a real CPU profile.
   *
   * Self time sorted, not a flamegraph: a flamegraph is the famous shape and
   * unreadable at thirty pixels tall. The number that answers "why was this
   * slow" is self time, and it fits on a line.
   */
  function drawProfile() {
    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'CPU profile'))
    middle.appendChild(head)

    if (!batch.profile) {
      middle.appendChild(
        node('div', 'empty', 'No profile for this request. Press Profile, then reload the page.')
      )
      return
    }

    const facts = node('dl', 'kv')
    for (const [name, value] of [
      ['Sampled', ms(batch.profile.durationMs)],
      ['Samples', String(batch.profile.samples)],
      ['Idle and engine', ms(batch.profile.outsideMs)]
    ]) {
      facts.appendChild(node('dt', '', name))
      facts.appendChild(node('dd', '', value))
    }
    middle.appendChild(facts)

    middle.appendChild(node('h3', '', 'Self time'))

    if (batch.profile.hot.length === 0) {
      middle.appendChild(
        node('div', 'empty', 'Every sample landed in the runtime. Nothing of yours was on the stack.')
      )
      return
    }

    const top = batch.profile.hot[0].selfMs || 1
    const grid = node('div', 'hot')
    for (const hot of batch.profile.hot) {
      grid.appendChild(node('span', 'ms', ms(hot.selfMs)))
      const who = node('span', 'who')
      who.appendChild(node('span', 'name', hot.name))
      if (hot.file) {
        who.appendChild(node('span', 'at', '  '))
        const link = frame(hot.file, hot.line)
        if (link !== null) who.appendChild(link)
      }
      grid.appendChild(who)
      const bar = node('span', 'meter')
      const fill = node('i')
      fill.style.width = Math.round((hot.selfMs / top) * 100) + '%'
      bar.appendChild(fill)
      grid.appendChild(bar)
    }
    middle.appendChild(grid)
  }

  /**
   * What every route costs, learned while the server ran.
   *
   * Only possible because the process lives: PHP forgets between requests, so no
   * debug bar in that world can tell you what "usually" means.
   */
  function drawCosts() {
    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'Route cost, this session'))
    middle.appendChild(head)

    if (costs.length === 0) {
      middle.appendChild(node('div', 'empty', 'Nothing measured yet.'))
      return
    }

    const grid = node('div', 'hot')
    const top = costs[0].medianMs || 1
    for (const cost of costs) {
      grid.appendChild(node('span', 'ms', ms(cost.medianMs)))
      const who = node('span', 'who')
      who.appendChild(node('span', 'name', cost.route))
      who.appendChild(node('span', 'at', '  ' + cost.samples + ' seen, worst ' + ms(cost.slowestMs)))
      grid.appendChild(who)
      const bar = node('span', 'meter')
      const fill = node('i')
      fill.style.width = Math.round((cost.medianMs / top) * 100) + '%'
      bar.appendChild(fill)
      grid.appendChild(bar)
    }
    middle.appendChild(grid)
  }

  // ----------------------------------------------------------------- right

  function drawRecent() {
    side.textContent = ''
    if (view === null) return

    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'Recent'))
    side.appendChild(head)

    for (const item of recent) {
      const own = item.source !== 'storage'
      const button = node('button', '')
      button.type = 'button'
      button.setAttribute('aria-current', String(item.batchId === current))
      button.appendChild(node('span', 'path', own ? item.method + ' ' + item.path : item.path))
      const meta = node('span', 'meta')
      if (own) {
        meta.appendChild(node('span', '', item.status + ' · ' + ms(item.durationMs) + ' · '))
        meta.appendChild(
          node('span', item.problems > 0 ? 'flag' : '', item.problems > 0 ? item.problems + ' problem' : 'clean')
        )
      } else {
        meta.appendChild(node('span', '', 'elsewhere'))
      }
      button.appendChild(meta)
      button.disabled = !own
      /** Choosing another request keeps the view you were in, and this pane. */
      button.onclick = () => {
        current = item.batchId
        picked = null
        entry = null
        load(0)
      }
      side.appendChild(button)
    }

    if (!crossProcess) {
      side.appendChild(
        node('div', 'aside', 'Queue and scheduler run in other processes. Set LENS_ENABLED=true to see them.')
      )
    }
  }

  async function open(uuid) {
    entry = { uuid: uuid, panels: null }
    drawView()
    drawDetail()
    try {
      const answer = await ask('/entry/' + uuid)
      if (!answer.ok) return
      const found = await answer.json()
      if (entry === null || entry.uuid !== uuid) return
      entry = found
      drawDetail()
    } catch {
      //
    }
  }

  /** The third pane, and only when something is selected. */
  function drawDetail() {
    detailPane.textContent = ''
    detailPane.style.display = view === null || entry === null ? 'none' : ''
    if (view === null || entry === null) return

    const head = node('div', 'head')
    head.appendChild(node('span', 'who', entry.type || 'entry'))

    if (entry.content) {
      const copy = node('button', 'act', 'Copy JSON')
      copy.type = 'button'
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(entry.content, null, 2))
          copy.textContent = 'Copied'
          setTimeout(() => { copy.textContent = 'Copy JSON' }, 1200)
        } catch {
          copy.textContent = 'Blocked'
        }
      }
      head.appendChild(copy)
    }

    if (entry.dashboard) {
      const link = node('a', 'out', 'Open in Lens')
      link.href = entry.dashboard
      link.target = '_blank'
      link.rel = 'noreferrer'
      head.appendChild(link)
    }

    const back = node('button', 'act', '×')
    back.type = 'button'
    back.onclick = () => {
      entry = null
      drawView()
      drawDetail()
    }
    head.appendChild(back)
    detailPane.appendChild(head)

    if (entry.panels === null) {
      detailPane.appendChild(node('div', 'empty', 'Loading…'))
      return
    }

    for (const one of entry.panels) detailPane.appendChild(card(one))
    detailPane.appendChild(raw(entry.content))
  }

  function card(one) {
    const box = node('div', 'card')

    if (one.kind === 'facts') {
      const kv = node('dl', 'kv')
      for (const [name, value] of one.rows) {
        kv.appendChild(node('dt', '', name))
        const dd = node('dd', '')
        const link = /^(.*):(\d+)$/.exec(String(value))
        if (link === null) dd.textContent = value
        else dd.appendChild(frame(link[1], link[2]))
        kv.appendChild(dd)
      }
      box.appendChild(kv)
      return box
    }

    if (one.kind === 'mapping') {
      box.appendChild(node('h3', '', one.title))
      box.appendChild(treeOf(one.value))
      return box
    }

    if (one.kind === 'block') {
      box.appendChild(node('h3', '', one.title))
      if (typeof one.value === 'string') box.appendChild(node('pre', '', one.value))
      else box.appendChild(treeOf(one.value))
      return box
    }

    if (one.kind === 'code') {
      box.appendChild(node('h3', '', one.title))
      box.appendChild(node('pre', '', one.value))
      return box
    }

    if (one.kind === 'source') {
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

    return box
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

    if (entries.length === 0) return leaf(key, kind === 'array' ? '[]' : '{}', 'empty')

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

  // ------------------------------------------------------------------ wire

  function ask(path) {
    return fetch(endpoint + path, { headers: { accept: 'application/json' }, __elvelBar: true })
  }

  async function load(attempt) {
    try {
      const answer = await ask('/' + current)
      if (answer.status === 404 && attempt < 6) return setTimeout(() => load(attempt + 1), 120)
      if (!answer.ok) return
      batch = (await answer.json()).batch
      drawVerdict()
      drawPanel()
      await refresh()
    } catch {
      // A bar that cannot reach its endpoint says nothing rather than throwing
      // inside somebody else's page.
    }
  }

  async function refresh() {
    try {
      const answer = await ask('?since=0')
      if (!answer.ok) return
      const payload = await answer.json()
      recent = payload.batches || []
      cursor = payload.cursor || 0
      crossProcess = payload.crossProcess === true
      drawRecent()
    } catch {
      //
    }
  }

  async function loadCosts() {
    try {
      const answer = await ask('/costs')
      if (!answer.ok) return
      costs = (await answer.json()).costs || []
      if (view === 'costs') drawView()
    } catch {
      //
    }
  }

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
        recent = fresh.concat(recent).slice(0, 40)
        drawRecent()
      } catch {
        //
      }
    }, 250)
  }

  /**
   * What the page does after it has loaded.
   *
   * Without this the bar is a snapshot: every fetch the page makes is recorded
   * on the server and invisible until a reload. The wrapper does not touch the
   * request — it waits for it to settle and then asks what is new.
   */
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
      kept.set('height', Math.round(height))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
  })

  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.code !== 'Backquote') return
    event.preventDefault()
    show(view === null ? kept.get('view', 'findings') || 'findings' : null)
  })

  window.addEventListener('resize', applyHeight)

  watchTheirRequests()
  load(0)
})()
`
