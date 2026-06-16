import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Split heavy 3D/physics vendors into their own chunk for better caching.
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            cannon: ['cannon-es'],
            react: ['react', 'react-dom'],
          },
        },
      },
      chunkSizeWarningLimit: 700,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
