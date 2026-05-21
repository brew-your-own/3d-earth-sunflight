import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';

function gitRev(): string {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
}

// Two build modes:
//   `npm run build`   → normal chunked output in dist/ (separate hashed assets)
//   `npm run package` → one self-contained dist/index.html with textures and
//                       airports JSON inlined as base64 data URLs. Friend can
//                       double-click and run it without a server.
export default defineConfig(({ mode }) => {
  const single = mode === 'singlefile';
  return {
    plugins: single ? [viteSingleFile()] : [],
    define: {
      __GIT_REV__: JSON.stringify(gitRev()),
    },
    server: {
      // Allow reaching the dev server from the LAN via the laptop's mDNS
      // hostname (e.g. hal.home.arpa) — used for testing on a phone.
      allowedHosts: ['.home.arpa'],
    },
    build: single
      ? {
          // Inline every asset, no matter how large.
          assetsInlineLimit: 100_000_000,
          cssCodeSplit: false,
          rollupOptions: { output: { inlineDynamicImports: true } },
          // Singlefile output is one big HTML; the warning is expected.
          chunkSizeWarningLimit: 20_000,
        }
      : {},
  };
});
