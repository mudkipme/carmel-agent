---
layout: home

hero:
  name: Carmel Agent
  text: Self-hosted AI agents for you and your team
  tagline: Bring your own model keys. Your agents get a sandboxed workspace, a live browser, your knowledge, and conversations that keep running after you close the tab.
  image:
    src: /logo.png
    alt: Carmel Agent
  actions:
    - theme: brand
      text: Get started
      link: /guide/quick-start
    - theme: alt
      text: What is Carmel Agent?
      link: /guide/introduction
    - theme: alt
      text: View on GitHub
      link: https://github.com/mudkipme/carmel-agent

features:
  - icon: 💬
    title: Chat that keeps working
    details: Runs live on the server. Reload, switch devices, or close the tab — reopening a session reconnects to the run in progress.
    link: /guide/chat
    linkText: Chat and sessions
  - icon: 📦
    title: Sandboxed shell
    details: Bash, terminals, and MCP servers run in a non-root container with CPU, memory, PID, mount, and network limits — never on your host.
    link: /self-hosting/sandbox
    linkText: Sandbox and runner
  - icon: 🌐
    title: A browser you can share
    details: Watch the agent browse, take control to sign in, then hand it back. The browser profile stays with the environment.
    link: /guide/workspace#shared-browser
    linkText: Shared browser
  - icon: 🧠
    title: Home, memory, and knowledge
    details: A private Home conversation per agent with notes it can learn and forget, plus searchable, citable Markdown knowledge.
    link: /guide/home-and-memory
    linkText: Home and memory
  - icon: ✅
    title: Tasks and schedules
    details: Queue work with a brief, follow progress, review evidence, and accept results. Schedule reminders and recurring runs from chat.
    link: /guide/tasks
    linkText: Tasks
  - icon: 🔌
    title: MCP, skills, and codemode
    details: Connect remote or sandboxed MCP servers, add skills as slash commands, and let agents script their tools in a JavaScript sandbox.
    link: /guide/mcp
    linkText: MCP servers
  - icon: 🤝
    title: Agents that work together
    details: Shared environments let specialist agents work on one project. Agents can consult each other or delegate tasks when you allow it.
    link: /guide/collaboration
    linkText: Agent collaboration
  - icon: 📱
    title: Telegram, Feishu, and Lark
    details: Talk to your agent's Home from a private chat and get alerts from scheduled tasks — no public webhook needed.
    link: /guide/messaging-apps
    linkText: Messaging apps
  - icon: 👥
    title: Multi-user with SSO
    details: Admins hold the provider keys; everyone gets private sessions, can share agents, and can sign in with any OpenID Connect provider.
    link: /self-hosting/users-and-sign-in
    linkText: Users and sign-in
---

## See it at work

Forge, a coding agent, found and fixed a bug in a sample project: it reproduced the crash, edited two files, added a test, and ran the suite. Its steps fold under **Show work**, and the uncommitted diff is open beside the conversation.

![A Carmel Agent conversation in which the Forge agent explains a fix, with the changed file's diff open in the workspace pane](/screenshots/overview-light.webp){.screenshot .only-light}
![A Carmel Agent conversation in which the Forge agent explains a fix, with the changed file's diff open in the workspace pane](/screenshots/overview-dark.webp){.screenshot .only-dark}
