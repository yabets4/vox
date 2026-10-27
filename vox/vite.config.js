import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 8192,    // onnxruntime-web is chunky by nature
    target: 'es2022'
  },
  server: { port: 5199, strictPort: true }
});
