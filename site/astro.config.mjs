// @ts-check
import { defineConfig } from 'astro/config';

// Served from GitHub Pages at mahmoudsr.github.io/fastdl until the site has
// its own domain. Then set SITE_URL to it and SITE_BASE to "/".
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://mahmoudsr.github.io',
  base: process.env.SITE_BASE ?? '/fastdl',
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'auto' },
});
