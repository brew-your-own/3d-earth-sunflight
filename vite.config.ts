/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';

function git(cmd: string): string {
  try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
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
      // Commit SHA for the GitHub link; `git describe` (e.g. v1.0.1-14-g17b07da,
      // "-dirty" with local changes) for display. CI needs tags fetched.
      __GIT_REV__: JSON.stringify(git('rev-parse --short HEAD')),
      __GIT_DESCRIBE__: JSON.stringify(git('describe --tags --always --dirty')),
    },
    test: {
      // Agent git worktrees live under .claude/worktrees and carry their own
      // copies of src/*.test.ts — don't run those as part of this checkout.
      exclude: [...configDefaults.exclude, '.claude/**'],
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
