import { defineConfig } from 'vitepress'

/**
 * The documentation site.
 *
 * VitePress rather than something built with Elvel itself, which is the obvious
 * objection: a Bun framework whose site runs on Vue. The reason is what the
 * bottleneck actually is — seventeen of the twenty-seven packages have no
 * documentation at all, so the work is writing, not rendering, and a shell that
 * takes hours leaves the rest of the time for content. Every page here is plain
 * markdown, so the day Elvel can render a static site the words move across
 * unchanged.
 *
 * A page appears in the sidebar when it has real content. Fifty empty pages are
 * worse than eight true ones, so "coming soon" is not a page.
 *
 * VitePress 2 while it is still an alpha, deliberately. The 1.6 line pins vite
 * `^5.4.14`, which carries a high-severity advisory — a `server.fs.deny` bypass
 * on Windows — and `bun audit` runs as a gate in CI. The choice was to mute the
 * finding or to move; 2.0 builds on vite 8, the same major the scaffolded
 * template already uses, and the audit comes back clean.
 */
export default defineConfig({
  title: 'Elvel',
  description: 'A Laravel-shaped framework for Bun, built on Elysia',
  lang: 'en',

  // Published at ufhy.github.io/elvel, so every asset needs the prefix.
  base: '/elvel/',

  // A dead link is a broken promise, and this is the only chance to catch one.
  ignoreDeadLinks: false,

  head: [
    ['meta', { name: 'theme-color', content: '#FF2D20' }],
    ['link', { rel: 'icon', href: '/elvel/favicon.svg' }]
  ],

  themeConfig: {
    /**
     * The full logo, not `mark.svg`.
     *
     * VitePress renders this as an `<img>`, and an image cannot inherit
     * `currentColor` — the mark came out black in both themes, which is how this
     * was found. The logo carries its own red and its own white glyph, so one
     * file is right in either theme.
     */
    logo: '/logo.svg',

    nav: [
      { text: 'Docs', link: '/getting-started/installation' },
      { text: 'Packages', link: '/architecture/packages' },
      {
        text: 'alpha',
        items: [
          { text: 'Release notes', link: 'https://github.com/ufhy/elvel/releases' },
          { text: 'Behaviours', link: 'https://github.com/ufhy/elvel/blob/main/BEHAVIOURS.md' },
          { text: 'npm', link: 'https://www.npmjs.com/org/elvel' }
        ]
      }
    ],

    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Installation', link: '/getting-started/installation' },
          { text: 'Starter kits', link: '/getting-started/starter-kits' },
          { text: 'Configuration', link: '/getting-started/configuration' },
          { text: 'Deployment', link: '/getting-started/deployment' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'The 27 packages', link: '/architecture/packages' },
          { text: 'Request lifecycle and the container', link: '/architecture/lifecycle' }
        ]
      },
      {
        text: 'The basics',
        items: [
          { text: 'Routing', link: '/basics/routing' },
          { text: 'Requests and validation', link: '/basics/requests' },
          { text: 'Validation rules', link: '/basics/validation' },
          { text: 'Middleware', link: '/basics/middleware' },
          { text: 'Session, cookies and CSRF', link: '/basics/session' },
          { text: 'Views', link: '/basics/views' },
          { text: 'Events and logging', link: '/basics/events-and-logging' }
        ]
      },
      {
        text: 'Digging deeper',
        items: [
          { text: 'Broadcasting', link: '/digging-deeper/broadcasting' },
          { text: 'Cache', link: '/digging-deeper/cache' },
          { text: 'Collections and helpers', link: '/digging-deeper/collections' },
          { text: 'Concurrency', link: '/digging-deeper/concurrency' },
          { text: 'Console', link: '/digging-deeper/console' },
          { text: 'File storage', link: '/digging-deeper/storage' },
          { text: 'HTTP client', link: '/digging-deeper/http-client' },
          { text: 'Images', link: '/digging-deeper/images' },
          { text: 'Localization', link: '/digging-deeper/localization' },
          { text: 'Mail', link: '/digging-deeper/mail' },
          { text: 'Notifications', link: '/digging-deeper/notifications' },
          { text: 'Processes', link: '/digging-deeper/processes' },
          { text: 'Queues', link: '/digging-deeper/queues' },
          { text: 'Task scheduling', link: '/digging-deeper/scheduling' }
        ]
      },
      {
        text: 'Database',
        items: [
          { text: 'Getting started', link: '/database/getting-started' },
          { text: 'Models', link: '/database/models' },
          { text: 'Migrations', link: '/database/migrations' }
        ]
      },
      {
        text: 'Testing',
        items: [{ text: 'Getting started', link: '/testing/getting-started' }]
      },
      {
        text: 'Security',
        items: [
          { text: 'Authentication', link: '/security/authentication' },
          { text: 'Authorization', link: '/security/authorization' },
          { text: 'Encryption', link: '/security/encryption' },
          { text: 'Hashing', link: '/digging-deeper/hashing' },
          { text: 'Reporting a vulnerability', link: '/security/reporting' }
        ]
      },
      {
        text: 'Reference',
        items: [{ text: 'Every command', link: '/reference/commands' }]
      },
      {
        text: 'Contributing',
        items: [{ text: 'Working on Elvel', link: '/contributing/working-on-elvel' }]
      }
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/ufhy/elvel' }],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/ufhy/elvel/edit/main/apps/docs/:path',
      text: 'Edit this page on GitHub'
    },

    footer: {
      message: 'MIT. Alpha — the shape is settled, the surface still moves.',
      copyright: 'Elvel'
    },

    outline: [2, 3]
  }
})
