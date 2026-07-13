import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8797",
    },
    allowedHosts: ["porygon-z.lan"]
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  build: {
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "react-vendor", test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
            { name: "radix-vendor", test: /node_modules[\\/](radix-ui|@radix-ui)[\\/]/ },
            // Markdown rendering stack (react-markdown + remark/micromark + highlight.js).
            { name: "markdown-vendor", test: /node_modules[\\/](react-markdown|remark-.*|mdast-.*|micromark.*|unified|unist-.*|hast-.*|vfile.*|highlight\.js|property-information|space-separated-tokens|comma-separated-tokens|character-entities.*|decode-named-character-reference|devlop|trim-lines|ccount|escape-string-regexp|markdown-table|zwitch|longest-streak|html-url-attributes|estree-.*|style-to-.*|bail|is-plain-obj)[\\/]/ },
            { name: "lit-vendor", test: /node_modules[\\/](lit|@lit|@lit-labs|@mariozechner)[\\/]/ },
            // Catch-all for the rest of node_modules, but leave Monaco out: it is only
            // reached through the lazily-loaded file editor, so excluding it here keeps
            // it in its own async chunk (off the initial load) instead of an eager one.
            {
              name: "vendor",
              test: (id) =>
                id.includes("node_modules") && !/[\\/](monaco-editor|@monaco-editor)[\\/]/.test(id),
            },
          ],
        },
      },
    },
  },
});
