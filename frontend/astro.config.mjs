// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  server: { host: true },
  // Behind the gateway/tunnel the Host header is not localhost; allow it.
  vite: {
    preview: { allowedHosts: true },
  },
});
