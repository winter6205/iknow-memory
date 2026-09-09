import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { dashboardApiProxyTarget } from "./src/vite-proxy.ts";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 18868,
    strictPort: true,
    proxy: {
      "/api": {
        target: dashboardApiProxyTarget(process.env),
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 18868,
    strictPort: true,
  },
});
