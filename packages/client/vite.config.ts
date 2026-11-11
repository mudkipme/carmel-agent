import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { lingui } from "@lingui/vite-plugin";

const serverUrl = process.env.CARMEL_SERVER_URL ?? "http://localhost:8797";
const serverWsUrl = serverUrl.replace(/^http/, "ws");
// Extra hostnames for LAN development; unset by default so a checkout does not
// pin one machine's name.
const allowedHosts = process.env.CARMEL_DEV_HOSTS?.split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [lingui({ macroTransform: true }), react(), tailwindcss()],
  server: {
    proxy: {
      // The terminal upgrades to a WebSocket, which the default proxy entry
      // would not carry.
      "/api/terminal": { target: serverWsUrl, ws: true },
      "/api/browser": { target: serverWsUrl, ws: true },
      "/api/updates": { target: serverWsUrl, ws: true },
      "/api": serverUrl,
    },
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
            },
            { name: "radix-vendor", test: /node_modules[\\/](radix-ui|@radix-ui)[\\/]/ },
            // Markdown rendering stack (react-markdown + remark/micromark + highlight.js).
            {
              name: "markdown-vendor",
              test: /node_modules[\\/](react-markdown|remark-.*|mdast-.*|micromark.*|unified|unist-.*|hast-.*|vfile.*|highlight\.js|property-information|space-separated-tokens|comma-separated-tokens|character-entities.*|decode-named-character-reference|devlop|trim-lines|ccount|escape-string-regexp|markdown-table|zwitch|longest-streak|html-url-attributes|estree-.*|style-to-.*|bail|is-plain-obj)[\\/]/,
            },
            // Keep CodeMirror and Pele in async chunks for editors and diagrams.
            {
              name: "vendor",
              test: (id) =>
                id.includes("node_modules") && !/[\\/](@codemirror|@lezer|pele)[\\/]/.test(id),
            },
          ],
        },
      },
    },
  },
});
