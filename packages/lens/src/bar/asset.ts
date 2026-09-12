/**
 * The bar's stylesheet and script, as strings.
 *
 * The UI model is php-debugbar's, read from `resources/debugbar.js` rather than
 * remembered:
 *
 * - `class Tab` and `class Indicator` are separate types there, and the
 *   distinction is the grammar of the whole thing. A tab opens a panel; an
 *   indicator is a number you read and cannot click.
 * - every request is kept as a dataset in a `<select>`, and one that came from
 *   `fetch` is labelled `(ajax)` — `addDataSet(data, id, '(ajax)', autoShow)`.
 *   The list is not cleared on navigation.
 * - `autoShow` is the reader's choice, persisted, not the tool's decision.
 * - `restoreState()` restores height, whether the bar is open, and which tab.
 *
 * Not TSX, because the shadow root is the point: the application's stylesheet
 * cannot reach in and this one cannot reach out. Every recorded value reaches
 * the DOM through `textContent` — there is no `innerHTML` here, and a test says
 * so. No backtick appears in either string: they ship inside template literals,
 * and one would end the literal in the middle of a function.
 */

/** `String.raw`, so a CSS escape such as `content: "\25B8"` stays one. */
export const BAR_STYLE = String.raw`
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
  background: #12161f; color: #e2e8f0; font-size: 12px; line-height: 1;
  border-top: 1px solid #2d3748; box-shadow: 0 -2px 14px rgba(0,0,0,.4);
  display: flex; flex-direction: column;
}
.grip { height: 5px; cursor: ns-resize; }
.bar.open .grip { background: #2d3748; }

.panel { display: none; min-height: 0; flex: 1 1 auto; }
.bar.open .panel { display: flex; }
.pane { flex: 1 1 0; overflow-y: auto; min-width: 0; }
.pane + .pane { border-left: 1px solid #22293a; }
.pane.detail { flex: 0 0 44%; }
@media (max-width: 1000px) { .pane.detail { flex: 1 1 0; } }

/* Header: tabs on the left, indicators on the right — php-debugbar's shape. */
.head-bar { display: flex; align-items: stretch; height: 32px; border-top: 1px solid #2d3748; }
.bar:not(.open) .head-bar { border-top: 0; }
.brand { padding: 0 10px; display: flex; align-items: center; gap: 7px; background: #FF2D20; color: #fff; font-weight: 700; border: 0; cursor: pointer; font-family: inherit; font-size: 12px; }
.brand.bad { background: #c53030; }

/* Tabs give way to the indicators rather than being clipped by them. */
.tabs { display: flex; align-items: stretch; overflow-x: auto; min-width: 0; flex: 0 1 auto; }
.tabs::-webkit-scrollbar { height: 3px; }
.tabs::-webkit-scrollbar-thumb { background: #2d3748; }
.tab {
  display: flex; align-items: center; gap: 6px; padding: 0 11px; cursor: pointer;
  border: 0; border-right: 1px solid #22293a; background: transparent; color: #a0aec0;
  font-family: inherit; font-size: 12px; white-space: nowrap;
}
.tab:hover { background: #1a202c; color: #e2e8f0; }
.tab[aria-selected="true"] { background: #1a202c; color: #fff; box-shadow: inset 0 -2px 0 #FF2D20; }
.tab b { color: #e2e8f0; font-weight: 600; }
.tab .warn { color: #f6ad55; }

.spacer { flex: 1 1 auto; }

/* Indicators are read, never clicked. */
.ind { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; padding: 0 11px; color: #718096; white-space: nowrap; border-left: 1px solid #22293a; }
.ind b { color: #e2e8f0; font-weight: 600; font-variant-numeric: tabular-nums; }
.ind .bad { color: #fc8181; } .ind .warn { color: #f6ad55; } .ind .good { color: #68d391; }
.ind.build { color: #4a5568; font-size: 10px; letter-spacing: .04em; }
.status-2 { color: #68d391; } .status-3 { color: #63b3ed; }
.status-4 { color: #f6ad55; } .status-5 { color: #fc8181; }

.split { display: flex; height: 3px; width: 84px; border-radius: 2px; overflow: hidden; background: #22293a; }
.split i { display: block; height: 3px; }
.split .db { background: #63b3ed; } .split .view { background: #b794f4; } .split .rest { background: #4a5568; }

select.sets, .shut, .follow { flex: 0 0 auto;
  background: #1a202c; color: #a0aec0; border: 0; border-left: 1px solid #22293a;
  font-family: inherit; font-size: 11px; padding: 0 8px; cursor: pointer; max-width: 260px;
}
select.sets:hover, .shut:hover { color: #e2e8f0; }
.follow { display: flex; align-items: center; gap: 5px; }
.follow input { accent-color: #FF2D20; }

.head { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid #22293a; position: sticky; top: 0; background: #12161f; }
.head .who { flex: 1 1 auto; color: #718096; text-transform: uppercase; letter-spacing: .05em; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.act { background: #1a202c; color: #a0aec0; border: 1px solid #2d3748; border-radius: 5px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
button.act:hover { color: #e2e8f0; border-color: #4a5568; }
button.act[aria-pressed="true"] { color: #fff; border-color: #FF2D20; }
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

.lane { display: grid; grid-template-columns: 50px 1fr minmax(0, 44%) auto; gap: 10px; align-items: center; width: 100%; padding: 6px 10px; border: 0; border-bottom: 1px solid #22293a; background: transparent; color: inherit; cursor: pointer; font-family: inherit; font-size: 12px; text-align: left; }
.lane:hover { background: #1a202c; }
.lane .at { color: #718096; text-align: right; font-variant-numeric: tabular-nums; }
.lane .track { position: relative; height: 8px; background: #1a202c; border-radius: 2px; overflow: hidden; }
.lane .track i { position: absolute; top: 0; height: 8px; min-width: 2px; border-radius: 2px; background: #4a5568; }
.lane .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lane .kind { color: #718096; margin-right: 8px; }
.lane .what { color: #e2e8f0; }
.lane .took { color: #a0aec0; font-variant-numeric: tabular-nums; }
.lane .track i.kind-query { background: #63b3ed; }
.lane .track i.kind-view { background: #b794f4; }
.lane .track i.kind-cache { background: #68d391; }
.lane .track i.kind-model { background: #f6ad55; }
.lane .track i.kind-exception, .lane .track i.kind-log { background: #fc8181; }
.lane .track i.kind-job, .lane .track i.kind-batch, .lane .track i.kind-schedule { background: #f6e05e; }
.lane .track i.kind-mail, .lane .track i.kind-notification { background: #4fd1c5; }
.lane .track i.kind-client_request { background: #90cdf4; }

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

.hot { display: grid; grid-template-columns: 52px 1fr auto; gap: 4px 10px; padding: 4px 10px 10px; align-items: center; }
.hot .ms { color: #e2e8f0; text-align: right; font-variant-numeric: tabular-nums; }
.hot .who { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hot .name { color: #e2e8f0; }
.hot .name.mine { color: #fc8181; }
.hot .at { color: #718096; }
.hot .meter { width: 90px; height: 4px; background: #22293a; border-radius: 2px; overflow: hidden; }
.hot .meter i { display: block; height: 4px; background: #4a5568; }
.hot .meter i.mine { background: #FF2D20; }

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
  let sets = []
  let cursor = 0
  let crossProcess = false
  let stale = false
  let view = null
  let picked = null
  let entry = null
  let costs = []
  let find = ''
  let condensed = true

  /**
   * Per-viewer state, the four keys php-debugbar keeps plus two of our own.
   *
   * restoreState() in debugbar.js reads phpdebugbar-height,
   * -open, -visible and -tab, and reopens the tab you were on. An earlier
   * version of this bar remembered nothing and then remembered too much; these
   * are the ones a bar is expected to keep.
   */
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
  const panel = node('div', 'panel')
  const middle = node('div', 'pane')
  const detailPane = node('div', 'pane detail')
  const header = node('div', 'head-bar')
  panel.append(middle, detailPane)
  // Panel above the header, as a bottom-anchored bar must be.
  bar.append(grip, panel, header)
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
    panel.style.height = Math.max(140, Math.min(height, window.innerHeight - 90)) + 'px'
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

  // ---------------------------------------------------------------- header

  /**
   * Tabs on the left, indicators on the right.
   *
   * class Tab and class Indicator are separate types in php-debugbar and the
   * distinction is the whole grammar of the thing: a tab opens a panel, an
   * indicator is a number you read. An earlier version of this bar made the
   * timing a button, so two controls opened the same panel and a reader had no
   * way to tell what was clickable.
   */
  function drawHeader() {
    header.textContent = ''
    if (batch === null) return

    if (stale) {
      const warn = node('button', 'brand bad')
      warn.type = 'button'
      warn.textContent = 'Stale — reload'
      warn.title = 'This page was served before the bar changed.'
      warn.onclick = () => location.reload()
      header.appendChild(warn)
    }

    const problems = batch.found.filter((one) => one.level === 'problem').length
    const brand = node('button', 'brand' + (problems > 0 ? ' bad' : ''))
    brand.type = 'button'
    brand.title = 'Findings'
    brand.textContent = problems > 0 ? problems + ' problem' + (problems === 1 ? '' : 's') : 'Lens'
    brand.onclick = () => show('findings')
    header.appendChild(brand)

    const tabs = node('div', 'tabs')
    tabs.appendChild(tabFor('findings', 'Findings'))
    tabs.appendChild(tabFor('timeline', 'Timeline'))
    tabs.appendChild(tabFor('request', 'Request'))

    const counts = new Map()
    for (const held of batch.entries) counts.set(held.type, (counts.get(held.type) || 0) + 1)

    for (const [type, n] of counts) {
      if (type === 'request') continue
      tabs.appendChild(tabFor(type, type, n, worstRepeat(type)))
    }

    tabs.appendChild(tabFor('profile', batch.profile ? 'Profile' : 'Profile • arm'))
    tabs.appendChild(tabFor('costs', 'Routes'))
    header.appendChild(tabs)

    header.appendChild(node('div', 'spacer'))

    header.appendChild(indicator([['', batch.method + ' ' + batch.path, 'b'],
      ['', batch.status, 'status-' + String(batch.status).charAt(0)]]))

    const shape = batch.shape
    const timing = node('div', 'ind')
    timing.appendChild(node('b', '', ms(shape.totalMs)))
    timing.appendChild(meter(shape))
    timing.appendChild(node('span', '', 'db ' + ms(shape.databaseMs)))
    timing.appendChild(node('span', '', 'view ' + ms(shape.renderMs)))
    timing.appendChild(node('span', '', 'app ' + ms(shape.otherMs)))
    if (batch.verdict && batch.verdict.times !== undefined && batch.verdict.samples > 3) {
      const how = batch.verdict.times
      timing.appendChild(
        node('span', how >= 2 ? 'bad' : how <= 0.6 ? 'good' : 'warn', how.toFixed(1) + '× median')
      )
    }
    header.appendChild(timing)

    header.appendChild(switcher())
    header.appendChild(follow())
    header.appendChild(node('div', 'ind build', tag.dataset.build || ''))

    const shut = node('button', 'shut')
    shut.type = 'button'
    shut.textContent = '×'
    shut.title = 'Close (Ctrl + backquote)'
    shut.onclick = () => show(null)
    header.appendChild(shut)

    mark()
  }

  function tabFor(name, label, count, warn) {
    const tab = node('button', 'tab')
    tab.type = 'button'
    tab.dataset.view = name
    if (count !== undefined) tab.appendChild(node('b', '', count))
    tab.appendChild(node('span', '', label))
    if (warn > 1) tab.appendChild(node('span', 'warn', 'N+1 ×' + warn))
    tab.onclick = () => (name === 'profile' && !batch.profile ? armProfiler(tab) : show(name))
    return tab
  }

  function worstRepeat(type) {
    return batch.entries
      .filter((held) => held.type === type)
      .reduce((most, held) => Math.max(most, held.repeats || 1), 1)
  }

  function indicator(parts) {
    const box = node('div', 'ind')
    for (const [, text, cls] of parts) box.appendChild(node(cls === 'b' ? 'b' : 'span', cls === 'b' ? '' : cls, text))
    return box
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

  /**
   * Every request, as a dropdown — php-debugbar's datasetsSelect.
   *
   * It keeps every dataset and labels an AJAX one with a (ajax) suffix
   * (addDataSet(data, id, '(ajax)', autoShow)), rather than clearing on
   * navigation. A column of them was taking a fifth of the panel for something
   * that is a menu.
   */
  function switcher() {
    const select = document.createElement('select')
    select.className = 'sets'
    select.title = 'Requests'

    for (const item of sets) {
      const option = document.createElement('option')
      option.value = item.batchId
      const where = item.source === 'storage' ? item.path : item.method + ' ' + item.path
      option.textContent =
        where +
        (item.kind === 'xhr' ? ' (ajax)' : '') +
        ' · ' +
        (item.source === 'storage' ? 'elsewhere' : item.status + ' · ' + ms(item.durationMs)) +
        (item.problems > 0 ? ' · ' + item.problems + ' problem' : '')
      option.disabled = item.source === 'storage'
      if (item.batchId === current) option.selected = true
      select.appendChild(option)
    }

    select.onchange = () => {
      current = select.value
      picked = null
      entry = null
      load(0)
    }

    return select
  }

  /**
   * php-debugbar's phpdebugbar-ajaxhandler-autoshow: yours to decide.
   *
   * On by default here, where it is off there. A page that polls will yank the
   * panel about, which is the argument for off — but a call you just triggered
   * and cannot see is the more common surprise, and turning it off is one click
   * that is then remembered.
   */
  function follow() {
    const box = node('label', 'follow')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = kept.get('follow', '1') === '1'
    check.onchange = () => kept.set('follow', check.checked ? '1' : '0')
    box.appendChild(check)
    box.appendChild(node('span', '', 'follow ajax'))
    box.title = 'Switch to a request the page makes, as it arrives'
    return box
  }

  function mark() {
    for (const tab of header.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(view !== null && tab.dataset.view === view))
    }
  }

  function show(next) {
    view = next === null || view === next ? null : next
    picked = null
    entry = null
    bar.classList.toggle('open', view !== null)
    kept.set('visible', view === null ? '0' : '1')
    if (view !== null) kept.set('tab', view)
    mark()
    drawView()
    drawDetail()
    if (view === 'costs') loadCosts()
    if (view === 'request') openRequest()
  }

  function openRequest() {
    if (batch === null) return
    const only = batch.entries.find((held) => held.type === 'request')
    if (only !== undefined) open(only.uuid)
  }

  // ------------------------------------------------------------------ views

  function drawView() {
    middle.textContent = ''
    if (view === null || batch === null) return
    if (view === 'findings') return drawFindings()
    if (view === 'timeline') return drawTimeline()
    if (view === 'profile') return drawProfile()
    if (view === 'costs') return drawCosts()
    if (view === 'request') return drawEntries('request')
    drawEntries(view)
  }

  function drawFindings() {
    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'Findings'))
    middle.appendChild(head)

    if (batch.found.length === 0) {
      const clear = node('div', 'clear')
      clear.appendChild(node('b', '', 'Nothing to report.'))
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
      if (one.cost !== undefined && one.cost !== null) line.appendChild(node('span', 'cost', ms(one.cost)))
      box.appendChild(line)
      box.appendChild(node('div', 'd', one.detail))
      box.onclick = () => {
        picked = picked === one.id ? null : one.id
        drawView()
      }
      if (picked === one.id) box.appendChild(evidenceOf(one))
      middle.appendChild(box)
    }
  }

  function evidenceOf(one) {
    const box = node('div', 'proof')
    const held = new Map()
    for (const found of batch.entries) held.set(found.uuid, found)
    const proof = one.evidence.map((uuid) => held.get(uuid)).filter((found) => found !== undefined)
    if (proof.length === 0) return box

    const type = proof[0].type
    const times = proof.map((found) => Number((found.summary || {}).took || 0)).filter((t) => t > 0)
    const facts = []
    if (proof.length > 1) facts.push(proof.length + ' × ' + type)
    if (times.length > 0) {
      facts.push('total ' + ms(times.reduce((sum, t) => sum + t, 0)))
      if (proof.length > 1) facts.push('slowest ' + ms(Math.max.apply(null, times)))
    }
    facts.push('first at ' + ms(proof[0].offsetMs))
    if (proof.length > 1) facts.push('last at ' + ms(proof[proof.length - 1].offsetMs))
    box.appendChild(node('span', 'facts', facts.join('  ·  ')))

    const go = node('button', 'act')
    go.type = 'button'
    go.textContent = proof.length > 1 ? 'Show in ' + type : 'Open'
    go.onclick = (event) => {
      event.stopPropagation()
      if (proof.length === 1) return open(proof[0].uuid)
      view = type
      picked = null
      find = String((proof[0].summary || {}).title || '').toLowerCase()
      kept.set('tab', view)
      mark()
      drawView()
    }
    box.appendChild(go)
    return box
  }

  /**
   * Condensed by default, expandable — Clockwork's timeline has the same switch.
   * Folding is a way of looking, not the only way.
   */
  function drawTimeline() {
    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'Timeline'))

    const fold = node('button', 'act', condensed ? 'Condensed' : 'Every entry')
    fold.type = 'button'
    fold.setAttribute('aria-pressed', String(condensed))
    fold.onclick = () => {
      condensed = !condensed
      kept.set('condensed', condensed ? '1' : '0')
      drawView()
    }
    head.appendChild(fold)

    if (batch.verdict && batch.verdict.samples > 1) {
      const compare = node('button', 'act', 'Median ' + ms(batch.verdict.medianMs) + ' over ' + batch.verdict.samples)
      compare.type = 'button'
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

    for (const group of condensed ? byKind(timed) : timed.map((held) => [held])) {
      const first = group[0]
      const last = group[group.length - 1]
      const took = group.reduce((sum, held) => sum + Number((held.summary || {}).took || 0), 0)
      const from = first.offsetMs
      const to = Math.max(last.offsetMs + Number((last.summary || {}).took || 0), from)

      const row = node('button', 'lane')
      row.type = 'button'
      row.appendChild(node('span', 'at', ms(from)))

      const track = node('span', 'track')
      const fill = node('i', 'kind-' + first.type)
      fill.style.left = Math.min(99, (from / total) * 100) + '%'
      fill.style.width = Math.max(0.6, ((to - from) / total) * 100) + '%'
      track.appendChild(fill)
      row.appendChild(track)

      /**
       * Every lane says the same things in the same places: the kind of work,
       * how much of it, what it cost.
       *
       * A description was appended only when a kind happened once, so some lanes
       * carried a sentence and others a count and the column meant two different
       * things down the page. Removed once, then carried back in when this file
       * was rewritten from the older copy — which is why it is spelled out here.
       */
      const label = node('span', 'label')
      label.appendChild(node('span', 'kind', first.type))
      if (group.length > 1) label.appendChild(node('span', 'dupe', '×' + group.length))
      row.appendChild(label)
      row.appendChild(node('span', 'took', took > 0 ? ms(took) : ''))
      row.onclick = () => (group.length === 1 ? open(first.uuid) : show(first.type))
      middle.appendChild(row)
    }
  }

  /** Consecutive entries of one kind, so a run of queries is one lane. */
  function byKind(entries) {
    const groups = []
    for (const held of entries) {
      const last = groups[groups.length - 1]
      if (last !== undefined && last[0].type === held.type) last.push(held)
      else groups.push([held])
    }
    return groups
  }

  function stages(total) {
    const box = node('div', 'stages')
    const marks = batch.marks || []
    let from = 0
    const parts = []
    for (const at of marks) {
      parts.push({ name: at.name, from: from, to: at.atMs })
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

  function drawEntries(type) {
    const head = node('div', 'head')
    const box = document.createElement('input')
    box.className = 'find'
    box.type = 'search'
    box.placeholder = 'Filter ' + type
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
      if (held.type !== type) return false
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
      if (shown.took !== undefined && shown.took !== null) row.appendChild(node('div', 'took', ms(shown.took)))
      row.onclick = () => open(held.uuid)
      middle.appendChild(row)
    }
  }

  function drawProfile() {
    const head = node('div', 'head')
    head.appendChild(node('span', 'who', 'CPU profile'))
    middle.appendChild(head)

    if (!batch.profile) {
      middle.appendChild(node('div', 'empty', 'No profile for this request. Press Profile, then reload.'))
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

    if (batch.profile.hot.length === 0) {
      middle.appendChild(node('div', 'empty', 'Every sample landed in the runtime.'))
      return
    }

    middle.appendChild(node('h3', '', 'Where the time went'))
    const origins = batch.profile.origins || []
    const widest = origins[0] ? origins[0].selfMs || 1 : 1
    const summary = node('div', 'hot')
    for (const origin of origins) {
      summary.appendChild(node('span', 'ms', ms(origin.selfMs)))
      const who = node('span', 'who')
      who.appendChild(node('span', origin.mine ? 'name mine' : 'name', origin.name))
      summary.appendChild(who)
      const meter = node('span', 'meter')
      const fill = node('i', origin.mine ? 'mine' : '')
      fill.style.width = Math.round((origin.selfMs / widest) * 100) + '%'
      meter.appendChild(fill)
      summary.appendChild(meter)
    }
    middle.appendChild(summary)

    middle.appendChild(node('h3', '', 'Slowest functions'))
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
      const meter = node('span', 'meter')
      const fill = node('i')
      fill.style.width = Math.round((hot.selfMs / top) * 100) + '%'
      meter.appendChild(fill)
      grid.appendChild(meter)
    }
    middle.appendChild(grid)
  }

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
      const meter = node('span', 'meter')
      const fill = node('i')
      fill.style.width = Math.round((cost.medianMs / top) * 100) + '%'
      meter.appendChild(fill)
      grid.appendChild(meter)
    }
    middle.appendChild(grid)
  }

  // ----------------------------------------------------------------- detail

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
    holder.open = depth < 2
    const summary = document.createElement('summary')
    if (key !== null) summary.appendChild(node('span', 'k', key + ': '))
    summary.appendChild(node('span', 'z', (kind === 'array' ? 'Array(' : 'Object(') + entries.length + ')'))
    holder.appendChild(summary)

    const kids = node('div', 'kids')
    for (const [name, held] of entries) kids.appendChild(branch(name, held, depth + 1))
    holder.appendChild(kids)
    return holder
  }

  function leaf(key, value, kind) {
    const line = node('div', '')
    if (key !== null) line.appendChild(node('span', 'k', key + ': '))
    line.appendChild(node('span', className(kind), kind === 'string' ? JSON.stringify(value) : String(value)))
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

  async function armProfiler(tab) {
    tab.textContent = 'Reload to profile'
    kept.set('reopen', 'profile')
    try {
      const answer = await ask('/profile')
      if (!answer.ok) tab.textContent = 'Profiler refused'
    } catch {
      tab.textContent = 'Profiler failed'
    }
  }

  async function load(attempt) {
    try {
      const answer = await ask('/' + current)
      if (answer.status === 404 && attempt < 6) return setTimeout(() => load(attempt + 1), 120)
      if (!answer.ok) return
      batch = (await answer.json()).batch
      restoreState()
      drawHeader()
      drawView()
      drawDetail()
      await refresh()
    } catch {
      // A bar that cannot reach its endpoint says nothing rather than throwing
      // inside somebody else's page.
    }
  }

  /**
   * php-debugbar's restoreState(): height, whether it is open, and which tab.
   *
   * Plus reopen, a one-shot for the profiler, whose flow *requires* a reload —
   * without it the one action that needs the panel always came back with it
   * shut.
   */
  let restored = false

  function restoreState() {
    if (restored) return
    restored = true

    condensed = kept.get('condensed', '1') === '1'

    const asked = kept.get('reopen', '')
    if (asked) {
      kept.set('reopen', '')
      view = asked
    } else if (kept.get('visible', '0') === '1') {
      view = kept.get('tab', 'findings') || 'findings'
    }

    if (view !== null) {
      bar.classList.add('open')
      if (view === 'costs') loadCosts()
      if (view === 'request') openRequest()
    }
  }

  async function refresh() {
    try {
      const answer = await ask('?since=0')
      if (!answer.ok) return
      const payload = await answer.json()
      sets = payload.batches || []
      cursor = payload.cursor || 0
      crossProcess = payload.crossProcess === true
      const mine = tag.dataset.build || ''
      if (payload.build && mine && payload.build !== mine) stale = true
      drawHeader()
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
        sets = fresh.concat(sets).slice(0, 40)
        // php-debugbar's autoShow, off unless asked for.
        if (kept.get('follow', '1') === '1') {
          current = fresh[0].batchId
          entry = null
          picked = null
          return load(0)
        }
        drawHeader()
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
    show(view === null ? kept.get('tab', 'findings') || 'findings' : null)
  })

  window.addEventListener('resize', applyHeight)

  watchTheirRequests()
  load(0)
})()
`
