import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  resolve: {
    /* onnxruntime's 'external wasm' build: it starts its extra threads from its own .mjs file
       (ort-wasm-simd-threaded.jsep.mjs). The default bundle starts them from whatever file it
       was bundled into — inside our engine worker that's the worker itself, and threads never start. */
    alias: [{ find: /^onnxruntime-web$/, replacement: fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/ort.min.mjs', import.meta.url)) }],
  },   // the voice-engine worker (lib/tts.worker.js) code-splits like the app
  build: {
    chunkSizeWarningLimit: 8192,    // onnxruntime-web is chunky by nature
    target: 'es2022',
    rollupOptions: {
      output: {
        /* onnxruntime starts its inference worker from its own file â€” keep it apart from the app,
           or the worker would boot the whole UI bundle ("document is not defined") */
        manualChunks: (id) => (/node_modules[\\/]onnxruntime-(web|common)[\\/]/.test(id) ? 'ort' : undefined),
      },
    },
  },
  /* same isolation as the Android app (MainActivity) so WASM can use several threads */
  server: { port: 5199, strictPort: true, headers: isolation },
  preview: { headers: isolation },
});
