import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Chrome extension popups are loaded from chrome-extension://<id>/... so all
// asset URLs must be RELATIVE ('./assets/...'), never absolute ('/assets/...').
// base: './' is what makes that happen.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../frontend',
    emptyOutDir: false, // keep frontend/icons/* (manifest icons) intact
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        popup: 'popup.html',
      },
    },
  },
});
