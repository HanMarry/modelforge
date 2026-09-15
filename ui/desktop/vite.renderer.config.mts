import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.GOOSE_TUNNEL': JSON.stringify(process.env.GOOSE_TUNNEL !== 'no' && process.env.GOOSE_TUNNEL !== 'none'),
  },

  plugins: [tailwindcss()],

  // 本机 `localhost` 解析到 ::1，Vite 默认 host 因此只绑 IPv6，Electron 走 IPv4 会
  // ERR_CONNECTION_REFUSED（窗口停在 chrome-error://）。显式绑 127.0.0.1 即可，
  // 仍只监听回环，不改变安全面。
  server: {
    host: '127.0.0.1',
    // 编辑器「写临时目录再改名」的保存方式会让 watcher 拿到一个打不开的文件，EBUSY 会直接
    // 终止整个 dev 运行。忽略这些临时目录即可，真实源码仍然照常监听。
    watch: {
      ignored: ['**/*.tmpdir/**', '**/.*.tmp'],
    },
  },

  // Vite caches a copy of @aaif/goose-acp-client and doesn't notice when we rebuild it
  // locally, so it serves stale code until you clear node_modules/.vite by hand.
  // Excluding it makes Vite always read the latest ui/goose-acp-client/dist build.
  // Dev-server only — release builds ignore optimizeDeps.
  optimizeDeps: {
    exclude: ['@aaif/goose-acp-client'],
  },

  build: {
    target: 'esnext'
  },
});
