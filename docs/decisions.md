# Decisions

These are the answers that Task 0 of the MVP plan asks for (`docs/superpowers/plans/2026-10-27-desktop-ai-task-assistant-mvp.md`).
**Decided** means the decision is settled and built.
**Proposed** means the build already works this way, but the project owners need to sign off before a real rollout.

| # | Decision | Status |
|---|---|---|
| 1 | Team language: Electron and TypeScript (Option A) | Decided |
| 2 | LLM provider: Gemini on a paid tier, behind the gateway | Proposed |
| 3 | What data may leave the machine | Proposed |
| 4 | Deletes and bulk edits are blocked | Decided |

## 1. Team language: Electron and TypeScript (Option A)

**Decided.**
The spec recommends Option A unless the team mainly writes C#/.NET (Option C) or install size matters most (Option B).
The MVP is built on Option A: the core, the connectors, the desktop shell and 77 tests are TypeScript on Electron 45.

Three parts were deliberately kept smaller than the plan:
- The window is plain HTML, without React.
- The build uses esbuild (`scripts/build.mjs`) instead of electron-vite.
- The audit log is a JSONL file instead of SQLite.

Changing language now means rewriting all the code; only the design would carry over.
Reopen this decision only if the team that will own the app writes C# every day.

## 2. LLM provider: Gemini on a paid tier

**Proposed.**
The plan assumed the Anthropic API.
The build instead uses Google Gemini through Gemini's OpenAI-compatible endpoint (`src/core/llm.ts`), and fails over to another model when one is slow or overloaded.
To switch to any other OpenAI-compatible provider (Ollama, Groq, OpenRouter or a company gateway), change three settings in `.env`: `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`.
No code changes are needed.

Conditions:
- **Free tier for synthetic data only.** Gemini's free tier may use prompts to improve Google's products. A rollout with real tickets needs either a paid tier whose terms exclude training on prompts, or a gateway the company has approved.
- **The model is chosen separately,** in decision 6.
- **A provider outage does not stop ticket creation.** Without a key, the app falls back to its built-in rules, so the answers get worse but tickets can still be created.

**Needs sign-off:** which provider and which contract the company approves.

## 3. What data may leave the machine

**Proposed.**
The table lists everything the code sends today.
The rule to approve is: the app sends only this, and anything more needs a new decision here.

| Goes to | What | Where in the code |
|---|---|---|
| The LLM | The request text | `understand.ts`, `advisor.ts` |
| The LLM | The last 10 turns of the current session (what the user and the assistant said) | `session.ts`, `consult` |
| The LLM | The names of the connected tools, up to 12 project keys and names per connection, and today's date | `session.ts`, `context` |
| The LLM | Keys and summaries of the last 5 tickets created, taken from the audit log | `session.ts`, `context` |
| Jira or Rovo | Only the values on the confirmation card. With auto-create on, the complete, validated draft is sent instead. | `executor.ts` |

**Never sent to the LLM:**
- tokens and keys
- people lists and account IDs
- components
- the descriptions of existing tickets
- the rest of the audit log, apart from those 5 summaries

The model does not pick a person, a priority or a component.
Code picks them by checking against the tool's own data (`matcher.ts`, `questionnaire.ts`).

**Stays on the machine:**
- the audit log (`data/audit.jsonl`)
- the Rovo sign-in (`data/rovo-oauth.json`), which roadmap phase 1 moves to Electron safeStorage

**Open, needs the company's rules:**
- A per-connection switch that never sends anything to the LLM, for tools under NDA. This is not built.
- Whether the text a user writes in a ticket may go to a provider outside the company's region.
- Removing secrets from a request before it is sent. This is part of the helpdesk concept and is not built.

## 4. Deletes and bulk edits: blocked

**Decided.**
The app has no code path that deletes, bulk-edits or transitions an issue.
Connectors can only create: Jira REST uses `POST /rest/api/2/issue`, and Rovo uses `createJiraIssue`.
Any connection can also be made read-only (for example `ROVO_READONLY=1`), which refuses every write.

Two follow-ups keep this true:
- **Rovo scopes:** the Rovo sign-in currently grants every Atlassian scope, including delete. It should request only read, write and search (roadmap phase 1).
- **Generic MCP connector:** it writes with the first tool that is not marked read-only. On a third-party server, that tool could be a delete. Before custom MCP connections ship, pin each one to a named create tool (`toolName`).

## Long-lead items

These items take weeks and need someone with a budget or admin rights.
The requests below are ready to send.
Fill in the owner and the date when each one goes out.

### Code-signing certificate

**Status:** the request is written but has not been placed.
**Owner:** _(to be named)_
**Requested on:** _(not yet)_

**Why it is needed:**
- Windows SmartScreen warns users about unsigned installers.
- Intune deploys a signed MSI.
- Roadmap phase 3 (installer and auto-update) depends on it. electron-builder signs the app during the build.

**Why start now:** Microsoft or the certificate authority (CA) checks the company's legal identity first, and that can take days to weeks.

| Option | Cost (check before buying) | Use it when |
|---|---|---|
| Azure Artifact Signing (formerly Trusted Signing) | About $9.99 a month for up to 5,000 signatures, on a paid Azure subscription | The company is in a supported country. At the last check: the US, Canada, the EU and the UK. |
| OV code-signing certificate from a CA (DigiCert, Sectigo, SSL.com) | A yearly fee | Artifact Signing is not available to the company |

**Recommendation:** use Artifact Signing if the company qualifies, otherwise an OV certificate.

Things to know before buying:
- **Hardware for the key.** Since June 2023, the key for a CA-issued certificate must live on hardware: either a USB token or the CA's cloud signing service. Plan which one the build machine will use.
- **SmartScreen.** Microsoft's guidance treats OV certificates and Artifact Signing the same way, so there is no need to pay extra for EV. With either one, SmartScreen builds reputation as the app gets downloaded.
- **What the buyer needs:** the company's legal name and registered address, and a contact who can answer the verification call or email.
