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
    ['meta', { name: 'theme-color', content: '#b8410f' }],
    ['link', { rel: 'icon', href: '/elvel/favicon.svg' }]
  ],

  themeConfig: {
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
          { text: 'Configuration', link: '/getting-started/configuration' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'The 27 packages', link: '/architecture/packages' },
          { text: 'Bootstrap order', link: '/architecture/bootstrap' }
        ]
      },
      {
        text: 'The basics',
        items: [
          { text: 'Routing and controllers', link: '/basics/routing' },
          { text: 'Validation', link: '/basics/validation' },
          { text: 'Events and logging', link: '/basics/events-and-logging' }
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
        text: 'Security',
        items: [
          { text: 'Encryption', link: '/security/encryption' },
          { text: 'Reporting a vulnerability', link: '/security/reporting' }
        ]
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
