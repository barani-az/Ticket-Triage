# AI Task Assistant: Jira demo

A small, runnable slice of the design in `docs/superpowers/plans/`: type a task, get asked only
for what is missing (with real choices), confirm on a card, and the ticket is created.
It runs fully offline against a mock Jira. No account or API key is needed.

## Desktop app (the main way to use it)

A tray app with a global hotkey, as in the plan. Press **Ctrl+Shift+Space** (falls back to
Ctrl+Alt+Space, then Ctrl+Alt+J if another app owns it; the terminal prints which one it got).
It opens as a small rounded input bar. Type a request and press Enter: the window grows downward to
show questions (answer with the buttons, the number keys, or by typing), then the result with a link.
**Esc** hides it; clicking elsewhere also hides it and your place is kept. The tray icon has the menu.
Only one copy can run at a time: quit the old one from the tray before starting a new build.

```bash
npm install
npm run desktop         # builds, then starts the tray app
npm run smoke:desktop   # launches once, checks the window and connections, creates nothing
```

- **Gemini:** copy `.env.example` to `.env`, put your key in `GEMINI_API_KEY`, and restart. Without it,
  requests are read by built-in rules. The key stays in `.env` (git-ignored), never on a command line.
- **Create without asking** (tray menu, on by default): a complete, valid draft is created immediately.
  Missing required values still produce questions, and read-only connections never create. Turn it off
  to get the confirmation card back. This is a deliberate relaxation of the plan's "every write is
  confirmed" rule, so keep it in mind when pointing the app at a real Jira.
- **Atlassian Rovo:** after `npm run mcp:discover` (one-time sign-in), the tray app connects to your
  live site automatically. If you haven't signed in, use *Connect Atlassian Rovo…* in the tray menu.
- **Windows PowerShell:** set variables on their own line (`$env:ROVO_ONLY='1'`), because
  `ROVO_ONLY=1 npm run ...` only works in bash. Or put them in `.env`.
- Not built yet: installer and auto-update, running the core in a separate process, a connections
  page, and image/screenshot input to Gemini.

## Browser version (development)

```bash
npm run web         # http://127.0.0.1:4000 (same chat page, served over HTTP)
npm test            # 90 tests
```

The demo starts a mock Jira (on a free port; set `MOCK_JIRA_PORT` to pin one) and two connections to it:

| Connection | What it shows |
|---|---|
| **Company Jira** | The Jira connector: schema from `createmeta`, lookups for projects, people and components, validation by Jira itself |
| **Company Jira (MCP)** | A custom MCP connection: our MCP server (`src/mcp`) is spawned over stdio, and the assistant builds its questions from the tool's input schema. Marked "basic": no lookups |

Route to the MCP one with `@jira-mcp ...` or the "Which tool?" question.

## What to try

- `Create a bug for the login page crashing on Safari, high priority, frontend team`: asks only for the project
- `Create a story in WEB for dark mode, assign to Arjun`: two Arjuns, so it asks and never guesses
- `Create a bug in WEB for checkout error, urgent`: "Urgent" is not a priority here, so it lists the real ones
- Press **Stop asking** on a bug: priority is filled from Jira's default and labelled *assumed*; the required component has no real value, so the card cannot be confirmed (answer it, or save a draft)

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

Once signed in, `npm run demo` adds a third connection, **Atlassian Rovo (live)**, wired through
`src/core/connectors/rovo.ts`. It uses Rovo's lookup tools (`listJiraProjects`,
`listJiraProjectIssueTypesMetadata`, `getJiraIssueTypeMetaWithFields`, `listJiraProjectComponents`,
`lookupJiraAccountId`) so questions get real choices, and `createJiraIssue` to write. The card shows
"This creates a real issue on <your site>" before anything is sent.

```bash
npm run verify:rovo               # read-only check against your site
ROVO_ONLY=1 npm run demo          # only the live connection, no mock Jira
ROVO_READONLY=1 npm run demo      # live connection that refuses all writes
```

Try: `@rovo create a task in KAN for <summary>`. Limits: assignee choices appear only after you type a
name (Rovo's lookup needs a query), and assignable-user checks are left to Jira. A real create was
verified end to end: `createJiraIssue` returns `{"data":{"id":"10013","key":"KAN-4"}}`, and the issue
was read back with `getJiraIssue`. Only a plain Task was created, so priority, assignee and
components on a live site are still untested.

The sign-in requested every Atlassian scope, including delete and manage. This demo never calls those
tools, but a real build should request only read, write and search scopes.

## Microsoft 365 (Outlook, calendar, To Do, Teams)

The app talks to Microsoft 365 through Softeria's [ms-365-mcp-server](https://github.com/softeria/ms-365-mcp-server),
pinned to 0.191.0 in `package.json` and started as a child process. Only the tools the app uses are
enabled, so sign-in asks Microsoft for just these permissions:

- Personal account: `Mail.Read Mail.Send Calendars.ReadWrite Tasks.ReadWrite`
- Work or school account (`M365_WORK=1`), which adds Teams and people lookups: the above plus
  `People.Read Team.ReadBasic.All Channel.ReadBasic.All Chat.Read ChatMessage.Send ChannelMessage.Send`

```bash
# in .env: M365=1, plus M365_WORK=1 for a work account or M365_TENANT_ID=consumers for a personal one
npm run m365:login      # one-time sign-in: open the URL it prints and enter the code
npm run desktop
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

## Use a real Jira (untested)

```bash
JIRA_BASE_URL=https://jira.company.com JIRA_FLAVOR=datacenter JIRA_TOKEN=<PAT> npm run demo
# Cloud: JIRA_FLAVOR=cloud JIRA_EMAIL=you@company.com JIRA_TOKEN=<API token>
```

Only the mock has been exercised. Real Jira may differ, notably Cloud has deprecated the classic
`createmeta` endpoint this demo uses.

## Not in this demo (see the plan)

Electron shell, hotkey and tray; Microsoft 365; JEV as the decision policy; editable draft fields;
saved preferences UI; "open in Jira prefilled"; retry/idempotency for multi-step plans; rate-limit
backoff; credential vault (the token comes from env vars); SQLite (audit is a JSONL file in `data/`).

## Layout

```
src/core/        connectors (jira, mcp), router, understand, questionnaire, executor, session
src/mcp/         the Jira MCP server
src/mock/        mock Jira
src/server/      web server and UI
tests/           connector, MCP, session and LLM tests
```
