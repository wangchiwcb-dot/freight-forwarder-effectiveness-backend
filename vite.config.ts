import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins:[react(),tailwindcss()],
  server:{host:'127.0.0.1',port:4180,strictPort:true,proxy:{'/api':'http://127.0.0.1:3102'}},
  build:{outDir:'dist/client',chunkSizeWarningLimit:1500},
});
