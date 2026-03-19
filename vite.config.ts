import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    // Vite adds `crossorigin` to every <link rel="stylesheet"> it emits for
    // CSS chunks (e.g. Monaco's extracted CSS file).  In a Tauri production
    // build the webview serves all assets from https://tauri.localhost via a
    // custom URL handler that does NOT send CORS headers.  When a stylesheet
    // is fetched in CORS mode (triggered by the crossorigin attribute) and the
    // server omits Access-Control-Allow-Origin, WebView2 silently discards the
    // stylesheet.  Monaco's core editor survives because it uses inline styles
    // and canvas for text/cursor rendering, but all UI chrome (context menus,
    // suggest widget dropdowns, code-action light-bulbs) relies on the external
    // CSS and therefore renders completely unstyled – plain bullet-point lists,
    // missing codicon icons, etc.
    //
    // Same-origin CSS never requires CORS mode, so stripping the attribute
    // makes the request unconditional and the file loads correctly.
    {
      name: "strip-crossorigin-from-css-links",
      transformIndexHtml(html: string): string {
        // Only target <link rel="stylesheet" crossorigin ...>, not <script>
        // tags which legitimately need crossorigin for module integrity checks.
        return html.replace(
          /<link rel="stylesheet" crossorigin/g,
          '<link rel="stylesheet"',
        );
      },
    },
  ],
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Monaco's standalone editor runtime is intentionally large even after
    // trimming unused language services. Keep chunk warnings useful for the
    // rest of the app while suppressing noise from the known Monaco chunk.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Split Monaco editor and its language workers into a separate chunk so the
        // main app bundle stays small and Monaco is cached independently between
        // PSForge releases (most users will have Monaco cached after first load).
        manualChunks: (id: string) => {
          if (id.includes("monaco-editor")) {
            return "monaco";
          }
          // Group React + React-DOM together so their shared runtime is in one chunk.
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/react-dom")
          ) {
            return "react-vendor";
          }
        },
      },
    },
  },
}));
