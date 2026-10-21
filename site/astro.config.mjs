import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import { fixtureDataPlugin } from './scripts/dev-fixtures-plugin.mjs';

// Hosted at https://holdthedoorhoid.github.io/card-show-atlas/ (static output only).
export default defineConfig({
  site: 'https://holdthedoorhoid.github.io',
  base: '/card-show-atlas',
  trailingSlash: 'always',
  build: { format: 'directory' },
  compressHTML: true,
  devToolbar: { enabled: false },
  integrations: [
    preact(),
    // My shows is private to each visitor and the 404 page is not a page.
    sitemap({ filter: (page) => !page.includes('/my-shows/') && !page.endsWith('/404.html') }),
  ],
  vite: {
    plugins: [fixtureDataPlugin('/card-show-atlas/data/')],
  },
});
