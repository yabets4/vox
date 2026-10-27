import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 8192,    // onnxruntime-web is chunky by nature
    target: 'es2022',
    rollupOptions: {
      output: {
        /* onnxruntime starts its inference worker from its own file — keep it apart from the app,
           or the worker would boot the whole UI bundle ("document is not defined") */
        manualChunks: (id) => (/node_modules[\\/]onnxruntime-(web|common)[\\/]/.test(id) ? 'ort' : undefined),
      },
    },
  },
  server: { port: 5199, strictPort: true }
});
