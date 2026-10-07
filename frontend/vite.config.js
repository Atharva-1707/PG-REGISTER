import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bound to 0.0.0.0 so the manager can open the register from a phone on
    // the PG wifi, not just from the mini PC itself.
    host: true,
  },
});
