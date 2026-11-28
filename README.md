# AI Task Assistant: Jira demo

A small, runnable slice of the design in `docs/superpowers/plans/`: type a task, get asked only
for what is missing (with real choices), confirm on a card, and the ticket is created.
Tickets go to your Jira Cloud site through Atlassian's Rovo MCP server: type `/connect` and sign in.

## Desktop app (the main way to use it)

A tray app with a global hotkey, as in the plan, on Windows and macOS. Press **Ctrl+Shift+Space** on
Windows (falls back to Ctrl+Alt+Space, then Ctrl+Alt+J if another app owns it) or **⌥Space** on a Mac
(then ⌘⇧Space, then ⌃⌥Space). The terminal prints which one it got; `HOTKEY` in `.env` picks your own.
It opens as a small rounded input bar. Type a request and press Enter: the window grows downward to
show questions (answer with the buttons, the number keys, or by typing), then the result with a link.
**Esc** hides it; clicking elsewhere also hides it and your place is kept. The tray icon has the menu.
Only one copy can run at a time: quit the old one from the tray before starting a new build.

```bash
npm install
npm run desktop         # builds, then starts the tray app
npm run smoke:desktop   # launches once, checks the window and connections, creates nothing
```

- **macOS:** it lives in the menu bar (no Dock icon) and opens over full-screen apps and on every
  desktop. Shortcuts use ⌘ (⌘N new chat, ⌘H history, ⌘V paste); **Esc** hands the keyboard back to the
  app you were in. Taking a screenshot needs the Screen Recording permission: the first try says where
  to turn it on (System Settings > Privacy & Security > Screen & System Audio Recording), then restart
  the app. While developing, macOS lists it as *Electron*.
- **Gemini:** copy `.env.example` to `.env`, put your key in `GEMINI_API_KEY`, and restart. Without it,
  requests are read by built-in rules. The key stays in `.env` (git-ignored), never on a command line.
- **Create without asking** (tray menu, on by default): a complete, valid draft is created immediately.
  Missing required values still produce questions, and read-only connections never create. Turn it off
  to get the confirmation card back. This is a deliberate relaxation of the plan's "every write is
  confirmed" rule, so keep it in mind when pointing the app at a real Jira.
- **Connect your tools:** type `/connect` in the window, or pick *Connect…* in the tray menu (see
  [Connecting tools](#connecting-tools-connect) below).
- **Windows PowerShell:** set variables on their own line (`$env:LOG='debug'`), because
  `LOG=debug npm run ...` only works in bash. Or put them in `.env`.
- **Reasoning (needs the Gemini key):** it answers questions, asks one clarifying question when a
  request is vague, or drafts a ticket and says why. Jira's own data still validates every value, and
  a project it picked itself is confirmed with you first.
- **History:** the clock button in the bar, `Ctrl+H` (⌘H on a Mac), or typing `history` lists every ticket you have
  created from the app, newest first and grouped by day. Enter or a click opens it in Jira. It reads
  the local audit log (`data/audit.jsonl`).
- **Conversation:** the chat stays on screen. While a draft is open, tell it what to change ("make it
  highest", "add that it started yesterday") or ask a question; say **create it** or **cancel**. Those
  two are matched by fixed rules, not by the model, so the AI cannot trigger a write. A draft that is
  being discussed is never auto-created. Type `new` or press `Ctrl+N` (⌘N) to start over.
- **Screenshots:** say "I have an error on this page" and it asks "Can I take a screenshot?". Only
  the **Take a screenshot** button captures (the window hides first). The image appears as a chip in
  the bar and goes to Gemini only when you press Enter. `Ctrl+V` (after `Win+Shift+S`) and
  drag-and-drop make the same chip (on a Mac, ⌃⇧⌘4 then ⌘V). Gemini reads the error and drafts the ticket from it. The image
  is not attached to the Jira ticket yet, and free-tier Gemini may use prompts to improve Google
  products, so mind what is on screen.
- Not built yet: installer and auto-update, running the core in a separate process, a connections
  page, attaching the screenshot to the Jira ticket, and the related-tickets check.

## Browser version (development)

```bash
npm run web         # http://127.0.0.1:4000 (same chat page, served over HTTP)
npm test            # the tests run against a test Jira in tests/helpers, no account needed
```

## What to try

With Jira connected (`/connect`, then *Jira Cloud*):

- `Create a bug for the login page crashing on Safari, high priority`: asks only for what is missing, with your site's real projects and issue types
- `Create a task in <PROJECT KEY> for checkout error, urgent`: if "Urgent" is not one of your priorities, it lists the real ones
- Assign to a name two people share: it asks and never guesses

## Optional LLM (Gemini)

Without a key, requests are read by built-in rules. To use Gemini for extraction, get a key from
Google AI Studio and set it in your shell (never commit it):

```bash
GEMINI_API_KEY=your-key npm run demo
# optional: GEMINI_MODEL=gemini-3.8-flash
```

Any OpenAI-compatible provider (Ollama, Groq, OpenRouter) works with `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`.
The LLM only proposes values; each one is still matched against Jira's real data. Gemini's free tier
may use prompts to improve Google products, so use synthetic data only.

## Connect to Atlassian's real Rovo MCP server

This is the official remote server (`https://mcp.atlassian.com/v2/mcp`). It uses OAuth sign-in in
your browser, and you need a Jira Cloud site (a free one is enough). Step one only discovers the
tools; the assistant is not yet wired to them.

```bash
npm run mcp:discover
```

It opens your browser to sign in and approve access, then saves every tool's name and input schema to
`data/rovo-tools.json` (tool definitions only, no tokens). OAuth tokens are stored in
`data/rovo-oauth.json`; both files are git-ignored, and the token file must never be shared.

Once signed in (with `/connect` or the command above), the app has the connection **Atlassian Rovo (live)**, wired through
`src/core/connectors/rovo.ts`. It uses Rovo's lookup tools (`listJiraProjects`,
`listJiraProjectIssueTypesMetadata`, `getJiraIssueTypeMetaWithFields`, `listJiraProjectComponents`,
`lookupJiraAccountId`) so questions get real choices, and `createJiraIssue` to write. The card shows
"This creates a real issue on <your site>" before anything is sent.

```bash
npm run verify:rovo               # read-only check against your site
ROVO_READONLY=1 npm run demo      # live connection that refuses all writes
```

Try: `@rovo create a task in KAN for <summary>`. Limits: assignee choices appear only after you type a
name (Rovo's lookup needs a query), and assignable-user checks are left to Jira. A real create was
verified end to end: `createJiraIssue` returns `{"data":{"id":"10013","key":"KAN-4"}}`, and the issue
was read back with `getJiraIssue`. Only a plain Task was created, so priority, assignee and
components on a live site are still untested.

The sign-in requested every Atlassian scope, including delete and manage. This demo never calls those
tools, but a real build should request only read, write and search scopes.

## Logs

The terminal that runs the app (`npm run desktop` or `npm run web`) shows a timestamped line for every
step: each message from the window and each reply (`[session]`), the AI's calls and decisions (`[llm]`,
`[ai]`), every call to Jira, Rovo and Microsoft 365 with its timing (`[jira]`, `[rovo]`, `[m365]`), every
write (`[write]`), sign-in steps (`[connect]`), the Microsoft 365 server's own log (`[ms365-server]`) and
window events (`[window]`, `[tray]`). Set `LOG=debug` in `.env` to also see prompts, tool arguments and
replies, or `LOG=0` to turn it off. Keys and tokens are never logged; screenshots only as a count.

## Connecting tools: /connect

Type `/connect` in the window (or pick *Connect…* in the tray menu) and choose a tool. Each one
signs in on the service's own page in your normal browser, so the app never sees your password, and
`/connect` itself never goes to the LLM.

```
Connect which tool?
1  Microsoft 365       not connected
2  Jira Cloud          connected as Priya Nair @ example.atlassian.net
3  Other connectors    coming later
```

- **Microsoft 365:** choose a work or school account (with Teams) or a personal one. The window shows a
  code; *Copy code and open the page* takes you to Microsoft's sign-in page, where you paste it and
  approve access, and the window says *Connected as …*. A code is needed because the server's ready-made
  Microsoft app rejects a browser redirect to this machine ("redirect_uri is not valid"). With our own
  app registration (`M365_CLIENT_ID`, the IT request in `docs/decisions.md`) Microsoft 365 signs in
  through the browser like Jira, with *Use a code instead* as the fallback.
- **Jira Cloud:** your browser opens Atlassian's sign-in page (the Rovo connection below).
- **Already connected:** picking the tool offers *Sign in again* (for example with another account),
  *Sign out* (disconnects and deletes its sign-in), or leaving it as it is.
- **Remembered:** connections come back at the next launch. `data/connections.json` holds only the
  Microsoft account kind; tokens stay in each service's own store (`data/rovo-oauth.json` for Rovo,
  the Microsoft server's encrypted cache for Microsoft 365).
- **If it fails,** the reason is in plain words, for example that your organisation needs an admin to
  approve the app (the IT request is in `docs/decisions.md`), with a way to try again.
- While you are in the browser the window may hide; the result is there when you reopen it, and a
  notification says *Connected*.

Developer shortcuts still work: `M365=1` in `.env` (with `M365_WORK=1`) and `npm run m365:login` for
Microsoft 365, `npm run mcp:discover` for Rovo.

## Microsoft 365 (Outlook, calendar, To Do, Teams)

The app talks to Microsoft 365 through Softeria's [ms-365-mcp-server](https://github.com/softeria/ms-365-mcp-server),
pinned to 0.191.0 in `package.json` and started as a child process. Only the tools the app uses are
enabled, so sign-in asks Microsoft for just these permissions:

- Personal account: `Mail.Read Mail.Send Calendars.ReadWrite Tasks.ReadWrite`
- Work or school account (`M365_WORK=1`), which adds Teams and people lookups: the above plus
  `People.Read Team.ReadBasic.All Channel.ReadBasic.All Chat.Read ChatMessage.Send ChannelMessage.Send`

```bash
npm run desktop         # then type /connect and pick Microsoft 365
```

What to try:

- `email Meera that the release moved to Friday`: the card shows the exact recipient and full text
- `set up a bug triage meeting with Arjun tomorrow at 3 with a Teams link`
- `remind me to check the release notes on Friday` (a To Do task)
- `post in the Web team's Releases channel that 2.3 is out` (work account)
- `make a ticket from Sam's email about checkout`: lists matching emails, drafts the ticket from the one
  you pick, and links back to it. `log the bug from the release chat` does the same for a Teams chat.
- After a ticket is created, buttons offer to reply to whoever reported it, post it in a channel, or set a reminder.

Safety: emails, replies, invites and Teams messages always show the card, even with *Create without
asking* on, and the confirm button needs a second press because they can't be unsent. The server's own
write gate is on (`MS365_MCP_REQUIRE_CONFIRM`), so it refuses any write the card did not approve. An
email or chat you make a ticket from goes to the LLM as quoted data that it is told not to take orders from.

Limits: tested against a fake server only (`tests/helpers/fakeMs365.ts`), not yet against a real
account. One recipient or attendee per message. Teams channel threads can't become tickets yet,
because reading channel messages needs admin consent; chats work. The server's token key falls back to a
file next to its cache because npm skipped keytar's native build; the cache lives in the server's own
folder (`~/Library/Application Support/ms-365-mcp-server/` on macOS), outside this repo.

## Not in this demo (see the plan)

Electron shell, hotkey and tray; Microsoft 365; JEV as the decision policy; editable draft fields;
saved preferences UI; "open in Jira prefilled"; retry/idempotency for multi-step plans; rate-limit
backoff; credential vault (the token comes from env vars); SQLite (audit is a JSONL file in `data/`).

## Layout

```
src/core/        connectors (rovo, ms365, mcp), router, understand, questionnaire, executor, session
src/mcp/         sign-in and the Rovo and Microsoft 365 server connections
src/server/      app wiring, /connect sign-in, web server
tests/           connector, MCP, session and LLM tests; tests/helpers has the test Jira and fake servers
```
