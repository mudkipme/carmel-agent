import { defineConfig } from "vitepress";

const repo = "https://github.com/mudkipme/carmel-agent";
const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  title: "Carmel Agent",
  description:
    "Self-hosted, multi-user web app for running AI agents with sandboxed tools, knowledge, and memory.",
  base,
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}favicon.ico`, sizes: "any" }],
    ["link", { rel: "icon", type: "image/png", href: `${base}favicon-32x32.png` }],
    ["meta", { name: "theme-color", content: "#3b6478" }],
  ],
  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
  },
  themeConfig: {
    logo: "/logo.png",
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Self-hosting", link: "/self-hosting/installation", activeMatch: "/self-hosting/" },
      { text: "Reference", link: "/reference/environment-variables", activeMatch: "/reference/" },
      { text: "Development", link: "/development/", activeMatch: "/development/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Quick start", link: "/guide/quick-start" },
            { text: "Core concepts", link: "/guide/concepts" },
          ],
        },
        {
          text: "Using Carmel Agent",
          items: [
            { text: "Chat and sessions", link: "/guide/chat" },
            { text: "Agents", link: "/guide/agents" },
            { text: "Workspace, terminal, and browser", link: "/guide/workspace" },
            { text: "Home and memory", link: "/guide/home-and-memory" },
            { text: "Knowledge", link: "/guide/knowledge" },
            { text: "Tasks", link: "/guide/tasks" },
            { text: "Schedules", link: "/guide/schedules" },
            { text: "Agent collaboration", link: "/guide/collaboration" },
            { text: "Questions and credentials", link: "/guide/questions-and-credentials" },
            { text: "Messaging apps", link: "/guide/messaging-apps" },
            { text: "Import from Open WebUI", link: "/guide/import-open-webui" },
          ],
        },
        {
          text: "Extending agents",
          items: [
            { text: "Skills and templates", link: "/guide/skills-and-templates" },
            { text: "MCP servers", link: "/guide/mcp" },
            { text: "Codemode", link: "/guide/codemode" },
          ],
        },
      ],
      "/self-hosting/": [
        {
          text: "Self-hosting",
          items: [
            { text: "Installation", link: "/self-hosting/installation" },
            { text: "Production setup", link: "/self-hosting/production" },
            { text: "Users and sign-in", link: "/self-hosting/users-and-sign-in" },
            { text: "Providers and models", link: "/self-hosting/providers-and-models" },
            { text: "Sandbox and runner", link: "/self-hosting/sandbox" },
            { text: "Backups and upgrades", link: "/self-hosting/backups-and-upgrades" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Environment variables", link: "/reference/environment-variables" },
            { text: "Built-in tools", link: "/reference/tools" },
            { text: "OpenAI-compatible API", link: "/reference/openai-api" },
            { text: "HTTP API", link: "/reference/http-api" },
            { text: "Security model", link: "/reference/security" },
          ],
        },
      ],
      "/development/": [
        {
          text: "Development",
          items: [
            { text: "Contributing", link: "/development/" },
            { text: "Architecture", link: "/development/architecture" },
            { text: "Session storage", link: "/development/session-storage" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      copyright: "Copyright © Mudkip",
    },
  },
});
