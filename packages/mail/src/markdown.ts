/**
 * A markdown renderer for mail — Laravel's markdown mailables, minus the parser.
 *
 * Deliberately a **subset**, and the subset is chosen by what survives in a mail
 * client: headings, paragraphs, emphasis, links, lists, blockquotes, rules,
 * inline and fenced code. No tables, no footnotes, no raw HTML passthrough.
 *
 * A full CommonMark parser is a dependency and a large one; what mail actually
 * uses is this much, and writing it means the output can be inline-styled as it
 * is produced. That matters more than completeness here: Gmail strips `<style>`
 * blocks, so a stylesheet-driven renderer produces a mail that looks right in
 * the preview and unstyled in the inbox.
 *
 * Raw HTML in the source is **escaped**, not passed through. Markdown for a mail
 * usually contains a value somebody typed, and passing tags through is how a
 * display name becomes a phishing link.
 */
export function markdownToHtml(source: string): string {
  const blocks = source.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const html: string[] = []

  for (const raw of blocks) {
    const block = raw.trim()

    if (block === '') continue

    if (block.startsWith('```')) {
      const body = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')

      html.push(`<pre style="${STYLES.pre}"><code>${escapeHtml(body.trimEnd())}</code></pre>`)

      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(block)

    if (heading) {
      const level = (heading[1] as string).length
      const size = [24, 20, 18, 16, 15, 14][level - 1] ?? 14

      html.push(
        `<h${level} style="${STYLES.heading} font-size: ${size}px;">${inline(heading[2] as string)}</h${level}>`
      )

      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(block)) {
      html.push(`<hr style="${STYLES.rule}">`)

      continue
    }

    if (block.split('\n').every((line) => line.trim().startsWith('>'))) {
      const body = block
        .split('\n')
        .map((line) => line.replace(/^\s*>\s?/, ''))
        .join(' ')

      html.push(`<blockquote style="${STYLES.quote}">${inline(body)}</blockquote>`)

      continue
    }

    const lines = block.split('\n')

    if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
      html.push(
        list(
          'ul',
          lines.map((line) => line.replace(/^\s*[-*+]\s+/, ''))
        )
      )

      continue
    }

    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      html.push(
        list(
          'ol',
          lines.map((line) => line.replace(/^\s*\d+[.)]\s+/, ''))
        )
      )

      continue
    }

    // A paragraph keeps its single newlines as line breaks, which is what a
    // person writing an address block expects and what markdown's "two spaces"
    // rule is too easy to lose in an editor.
    html.push(`<p style="${STYLES.paragraph}">${lines.map(inline).join('<br>')}</p>`)
  }

  return html.join('\n')
}

/**
 * The same source as plain text, for the alternative part.
 *
 * Not the HTML with tags stripped: a link becomes `text (url)` so it is still
 * usable, and a heading keeps its `#` so the shape survives. A mail whose text
 * part is unreadable is a mail that looks broken to anybody whose client
 * prefers text — including most screen readers.
 */
export function markdownToText(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`{3}[^\n]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_](\W|$)/g, '$1$2$3')
    .trim()
}

const STYLES = {
  paragraph: 'margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #333;',
  heading: 'margin: 0 0 12px; color: #111; font-weight: 600;',
  rule: 'border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;',
  quote:
    'margin: 0 0 16px; padding: 8px 16px; border-left: 3px solid #d0d0d0; color: #555; font-size: 15px;',
  pre: 'margin: 0 0 16px; padding: 12px; background: #f5f5f5; border-radius: 6px; font-size: 13px; overflow-x: auto;',
  list: 'margin: 0 0 16px; padding-left: 20px; font-size: 15px; line-height: 1.6; color: #333;',
  link: 'color: #2563eb;'
} as const

function list(tag: 'ul' | 'ol', items: string[]): string {
  const rendered = items.map((item) => `<li>${inline(item)}</li>`).join('')

  return `<${tag} style="${STYLES.list}">${rendered}</${tag}>`
}

/**
 * Inline markup, applied to already-escaped text.
 *
 * Escaping happens first and once: doing it afterwards would escape the tags
 * this function just produced, and doing it twice would show `&amp;lt;` to the
 * reader.
 */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(
      /`([^`]+)`/g,
      '<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px">$1</code>'
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])[*_]([^*_]+)[*_]/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `<a href="$2" style="${STYLES.link}">$1</a>`)
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
