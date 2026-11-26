import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Candidate, ExecResult, JsonSchema, PlanStep } from '../types.js';
import type { Connector, SourceContent } from './contract.js';

/**
 * Microsoft 365 through Softeria's ms-365-mcp-server (stdio). The server maps each tool 1:1 to a
 * Microsoft Graph endpoint and returns Graph's JSON as text; a send returns {"success":true}.
 * Only the tools below are enabled, so sign-in asks Microsoft for just their permissions, and
 * every write passes `confirm: true` (the server's MS365_MCP_REQUIRE_CONFIRM gate) after our card.
 */
export const MS365_VERSION = '0.191.0';

const PERSONAL_TOOLS = [
  'login',
  'logout',
  'verify-login',
  // Not used by the app, but its scope (User.Read) is: the server's sign-in check reads /me, and without
  // it every check gets 403, so a finished sign-in never counts as signed in.
  'get-current-user',
  'list-todo-task-lists',
  'create-todo-task',
  'list-mail-messages',
  'get-mail-message',
  'send-mail',
  'reply-mail-message',
  'create-calendar-event',
];
/** Work/school accounts only (Softeria's --org-mode). */
const WORK_TOOLS = ['list-relevant-people', 'list-joined-teams', 'list-team-channels', 'list-chats', 'list-chat-messages', 'send-chat-message', 'send-channel-message'];

/** Server flags. Sign-in must use the same ones, because the permissions requested follow the enabled tools. */
export function ms365Args(work: boolean): string[] {
  const tools = work ? [...PERSONAL_TOOLS, ...WORK_TOOLS] : PERSONAL_TOOLS;
  return ['--enabled-tools', `^(${tools.join('|')})$`, ...(work ? ['--org-mode'] : [])];
}

export type Ms365Action = 'task' | 'email' | 'reply' | 'meeting' | 'channel' | 'chat';

const ACTIONS: { id: Ms365Action; label: string; work?: boolean }[] = [
  { id: 'task', label: 'To Do task' },
  { id: 'email', label: 'Email' },
  { id: 'reply', label: 'Reply to an email' },
  { id: 'meeting', label: 'Meeting invite' },
  { id: 'channel', label: 'Teams channel post', work: true },
  { id: 'chat', label: 'Teams chat message', work: true },
];

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const DATE_TIME = '^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}$';
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UNSENDABLE = "This can't be unsent. Check the recipient and the full text above.";

const strip = (html: string) =>
  html.replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

export interface Ms365Options {
  /** Work or school account: Teams and people lookups are available. */
  work: boolean;
  /** IANA time zone for meeting times and due dates (default: this machine's). */
  timeZone?: string;
}

export class Ms365Connector implements Connector {
  manifest: Connector['manifest'] = {
    type: 'ms365',
    keywords: ['email', 'e-mail', 'mail', 'outlook', 'reply', 'meeting', 'invite', 'calendar', 'schedule', 'teams', 'channel', 'chat', 'to do', 'todo', 'remind'],
    idPatterns: [],
    confirmAlways: true,
  };
  private tz: string;
  private me?: string;
  /** Emails and chats already shown or read, so a remembered id (e.g. the email a ticket came from) resolves. */
  private seen = new Map<string, Candidate & { link?: string }>();

  constructor(private client: Client, private opts: Ms365Options) {
    this.tz = opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  /** The actions this account supports, for the reasoning step and the "Which action?" question. */
  actions(): Ms365Action[] {
    return ACTIONS.filter((a) => this.opts.work || !a.work).map((a) => a.id);
  }

  private static text(res: unknown) {
    return (((res as { content?: unknown }).content as { type: string; text?: string }[]) ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = Ms365Connector.text(res);
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain text */
    }
    if (res.isError || parsed?.error) {
      const e = parsed?.error;
      throw new Error(typeof e === 'string' ? e : e?.message ?? parsed?.message ?? (text || `${name} failed`));
    }
    return parsed;
  }

  /**
   * Sign in. Started with --auth-browser, the server opens Microsoft's sign-in page and this returns once
   * the user is back; otherwise it returns the code to enter on Microsoft's page (the server keeps polling).
   */
  async login(timeoutMs: number): Promise<{ signedIn: string } | { url: string; code: string }> {
    const res = await this.client.callTool({ name: 'login', arguments: {} }, undefined, { timeout: timeoutMs });
    const text = Ms365Connector.text(res);
    let r: any;
    try {
      r = JSON.parse(text);
    } catch {
      throw new Error(text || 'Sign-in failed.');
    }
    if (r?.error === 'device_code_required') {
      // e.g. "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABC123XYZ to authenticate."
      const msg = String(r.message ?? '');
      const url = msg.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,;)]+$/, '');
      const code = msg.match(/\bcode\s+([A-Z0-9-]{6,})/i)?.[1];
      if (url && code) return { url, code };
      throw new Error(msg || 'Microsoft did not return a sign-in code.');
    }
    if (r?.success === true) {
      this.me = r.userData?.displayName ?? this.me;
      return { signedIn: r.userData?.userPrincipalName ?? r.userData?.displayName ?? 'you' };
    }
    throw new Error(typeof r?.error === 'string' ? r.error : (r?.message ?? 'Sign-in failed.'));
  }

  async logout() {
    await this.call('logout');
    this.me = undefined;
  }

  /** The signed-in user's name, so a 1:1 chat is labelled with the other person. */
  private async whoAmI() {
    if (this.me === undefined) {
      const r = await this.call('verify-login').catch(() => undefined);
      this.me = r?.userData?.displayName ?? '';
    }
    return this.me;
  }

  async testConnection() {
    try {
      const r = await this.call('verify-login');
      if (!r?.success) {
        // "No valid token" means not signed in; anything else (e.g. "...Graph API access failed: 403") is a real error.
        const why = String(r?.message ?? '');
        const error = !why || /no (valid )?token|not (logged|signed) in/i.test(why) ? 'Not signed in to Microsoft 365. Type /connect to sign in.' : why;
        return { ok: false as const, error, needsReauth: true };
      }
      this.me = r.userData?.displayName ?? '';
      return { ok: true as const, actingAs: r.userData?.userPrincipalName ?? r.userData?.displayName ?? 'you' };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, needsReauth: true };
    }
  }

  async getSchema(ctx: Record<string, string>): Promise<JsonSchema> {
    const props: Record<string, JsonSchema> = { action: { type: 'string', title: 'Action', 'x-lookup': 'action' } };
    const required = ['action'];
    const add = (key: string, prop: JsonSchema, req = true) => {
      props[key] = { type: 'string', ...prop };
      if (req) required.push(key);
    };
    const schema: JsonSchema = { type: 'object', properties: props, required };
    const person = { 'x-lookup': 'person', 'x-question': this.opts.work ? 'Who should it go to? Type a name or an email address.' : 'Who should it go to? Type their email address.' };

    switch (ctx.action as Ms365Action | undefined) {
      case 'task':
        add('list', { title: 'List', 'x-lookup': 'list' });
        add('title', { title: 'Title' });
        add('due', { title: 'Due date', pattern: DATE, 'x-question': 'When is it due? Use YYYY-MM-DD.' }, false);
        add('importance', { title: 'Importance', enum: ['Low', 'Normal', 'High'] }, false);
        add('notes', { title: 'Notes' }, false);
        Object.assign(schema, { title: 'Add this To Do task?', 'x-button': 'Add to To Do' });
        break;
      case 'email':
        add('to', { title: 'To', ...person });
        add('subject', { title: 'Subject' });
        add('body', { title: 'Message' });
        Object.assign(schema, { title: 'Send this email?', 'x-button': 'Send email', 'x-guard': true, 'x-warnings': [UNSENDABLE] });
        break;
      case 'reply':
        add('email', { title: 'Reply to', 'x-lookup': 'email', 'x-question': 'Which email are you replying to?' });
        add('body', { title: 'Message' });
        Object.assign(schema, { title: 'Send this reply?', 'x-button': 'Send reply', 'x-guard': true, 'x-warnings': [UNSENDABLE] });
        break;
      case 'meeting':
        add('subject', { title: 'Title' });
        add('start', { title: 'Starts', pattern: DATE_TIME, 'x-question': 'When does it start? Use YYYY-MM-DD HH:MM, for example 2026-11-27 15:00.' });
        add('duration', {
          title: 'Duration',
          'x-lookup': 'duration',
          default: '30',
        });
        add('attendees', { title: 'Attendee', ...person }, false);
        if (this.opts.work) add('online', { title: 'Teams link', enum: ['Yes', 'No'] }, false);
        Object.assign(schema, {
          title: ctx.attendees ? 'Send this invite?' : 'Add this to your calendar?',
          'x-button': ctx.attendees ? 'Send invite' : 'Add to calendar',
          'x-guard': Boolean(ctx.attendees),
          'x-warnings': ctx.attendees ? [`The invite goes to the attendee as soon as you confirm. Times are in ${this.tz}.`] : [`Times are in ${this.tz}.`],
        });
        break;
      case 'channel':
        add('team', { title: 'Team', 'x-lookup': 'team' });
        add('channel', { title: 'Channel', 'x-lookup': 'channel' });
        add('message', { title: 'Message' });
        Object.assign(schema, { title: 'Post this in Teams?', 'x-button': 'Post to channel', 'x-guard': true, 'x-warnings': ['Posted as you, visible to the whole channel straight away.'] });
        break;
      case 'chat':
        add('chat', { title: 'Chat', 'x-lookup': 'chat' });
        add('message', { title: 'Message' });
        Object.assign(schema, { title: 'Send this Teams message?', 'x-button': 'Send message', 'x-guard': true, 'x-warnings': ['Sent as you, straight away.'] });
        break;
    }
    return schema;
  }

  async lookup(kind: string, text: string, ctx: Record<string, string> = {}): Promise<Candidate[]> {
    const q = text.trim();
    const remembered = this.seen.get(q);
    if (remembered && (kind === 'email' || kind === 'chat')) return [remembered];
    switch (kind) {
      case 'action':
        return ACTIONS.filter((a) => this.opts.work || !a.work).map((a) => ({ id: a.id, label: a.label }));
      case 'duration':
        return [
          { id: '15', label: '15 min' },
          { id: '30', label: '30 min' },
          { id: '45', label: '45 min' },
          { id: '60', label: '1 hour' },
          { id: '90', label: '1.5 hours' },
        ];
      case 'list': {
        const r = await this.call('list-todo-task-lists');
        return ((r?.value ?? []) as any[]).map((l) => ({ id: l.id, label: l.displayName }));
      }
      case 'person': {
        // A typed address is always a valid recipient; names need the work directory.
        const typed = EMAIL.test(q) ? [{ id: q, label: q }] : [];
        if (!this.opts.work) return typed;
        const r = await this.call('list-relevant-people', { ...(q && !typed.length ? { search: `"${q}"` } : {}), top: 8 });
        const people = ((r?.value ?? []) as any[])
          .map((p) => ({ address: p.scoredEmailAddresses?.[0]?.address as string | undefined, name: p.displayName as string }))
          .filter((p): p is { address: string; name: string } => Boolean(p.address))
          .map((p) => ({ id: p.address, label: p.name, detail: p.address }));
        return typed.length ? [...typed, ...people.filter((p) => p.id.toLowerCase() !== q.toLowerCase())] : people;
      }
      case 'team': {
        const r = await this.call('list-joined-teams');
        return ((r?.value ?? []) as any[]).map((t) => ({ id: t.id, label: t.displayName }));
      }
      case 'channel': {
        if (!ctx.team) return [];
        const r = await this.call('list-team-channels', { teamId: ctx.team });
        return ((r?.value ?? []) as any[]).map((c) => ({ id: c.id, label: c.displayName }));
      }
      case 'chat': {
        const [r, me] = [await this.call('list-chats', { expand: 'members', top: 20 }), await this.whoAmI()];
        const chats = ((r?.value ?? []) as any[]).map((c) => {
          const others = ((c.members ?? []) as any[]).map((m) => m.displayName).filter((n) => n && n !== me);
          const label = c.topic || others.join(', ') || 'Chat';
          return { id: c.id as string, label, detail: c.chatType === 'oneOnOne' ? 'chat' : 'group chat', link: c.webUrl as string | undefined };
        });
        for (const c of chats) this.seen.set(c.id, c);
        return q ? chats.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())) : chats;
      }
      case 'email': {
        const r = await this.call('list-mail-messages', {
          ...(q ? { search: `"${q.replace(/"/g, '')}"` } : { orderby: ['receivedDateTime desc'] }),
          top: 8,
          select: ['id', 'subject', 'from', 'receivedDateTime', 'webLink'],
        });
        const mails = ((r?.value ?? []) as any[]).map((m) => ({
          id: m.id as string,
          label: (m.subject as string) || '(no subject)',
          detail: [m.from?.emailAddress?.name, String(m.receivedDateTime ?? '').slice(0, 10)].filter(Boolean).join(' · '),
          link: m.webLink as string | undefined,
        }));
        for (const m of mails) this.seen.set(m.id, m);
        return mails;
      }
      default:
        return [];
    }
  }

  /** The text of an email or chat the user picked, to draft a ticket from. */
  async read(kind: 'email' | 'chat', id: string): Promise<SourceContent> {
    if (kind === 'email') {
      const m = await this.call('get-mail-message', { messageId: id, select: ['subject', 'from', 'body', 'webLink', 'receivedDateTime'] });
      const from = m?.from?.emailAddress ?? {};
      const content = { id, kind, title: m?.subject || '(no subject)', from: from.name || from.address || '', fromAddress: from.address, text: strip(String(m?.body?.content ?? '')).slice(0, 6000), link: m?.webLink };
      this.seen.set(id, { id, label: content.title, detail: content.from, link: content.link });
      return content;
    }
    const r = await this.call('list-chat-messages', { chatId: id, top: 20 });
    const lines = ((r?.value ?? []) as any[])
      .filter((m) => m.messageType === undefined || m.messageType === 'message')
      .reverse() // Graph lists newest first; a transcript reads oldest first
      .map((m) => `${m.from?.user?.displayName ?? 'Someone'}: ${strip(String(m.body?.content ?? ''))}`)
      .filter((l) => !l.endsWith(': '));
    const chat = this.seen.get(id);
    return { id, kind, title: chat?.label ?? 'Teams chat', from: chat?.label ?? '', text: lines.join('\n').slice(-6000), link: chat?.link };
  }

  /** Graph wants a local time plus its zone; "2026-11-27 15:00" becomes 2026-11-27T15:00:00. */
  private when(local: string, plusMinutes = 0) {
    const [d, t] = local.replace('T', ' ').split(' ');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = t.split(':').map(Number);
    const at = new Date(Date.UTC(y, mo - 1, da, h, mi + plusMinutes)); // UTC only as a calendar, no zone shift
    return { dateTime: at.toISOString().slice(0, 19), timeZone: this.tz };
  }

  async execute(step: PlanStep): Promise<ExecResult> {
    const p = step.params;
    const text = (content: string) => ({ contentType: 'text', content });
    try {
      switch (p.action as Ms365Action) {
        case 'task': {
          await this.call('create-todo-task', {
            todoTaskListId: p.list,
            body: {
              title: p.title,
              ...(p.importance ? { importance: p.importance.toLowerCase() } : {}),
              ...(p.due ? { dueDateTime: { dateTime: `${p.due}T00:00:00`, timeZone: this.tz } } : {}),
              ...(p.notes ? { body: text(p.notes) } : {}),
            },
            confirm: true,
          });
          return { ok: true, id: p.title, url: '', stamp: 'Added to To Do' };
        }
        case 'email':
          await this.call('send-mail', {
            body: { Message: { subject: p.subject, body: text(p.body), toRecipients: [{ emailAddress: { address: p.to } }] }, SaveToSentItems: true },
            confirm: true,
          });
          return { ok: true, id: `to ${p.to}`, url: '', stamp: 'Email sent' };
        case 'reply': {
          await this.call('reply-mail-message', { messageId: p.email, body: { Comment: p.body }, confirm: true });
          const m = this.seen.get(p.email);
          return { ok: true, id: m ? `to "${m.label}"` : 'sent', url: m?.link ?? '', stamp: 'Reply sent', linkText: 'Open in Outlook' };
        }
        case 'meeting': {
          const r = await this.call('create-calendar-event', {
            body: {
              subject: p.subject,
              start: this.when(p.start),
              end: this.when(p.start, Number(p.duration || 30)),
              ...(p.attendees ? { attendees: [{ emailAddress: { address: p.attendees }, type: 'required' }] } : {}),
              ...(p.online === 'Yes' ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
            },
            confirm: true,
          });
          return { ok: true, id: p.subject, url: r?.webLink ?? '', stamp: p.attendees ? 'Invite sent' : 'Added to calendar', linkText: 'Open in Outlook' };
        }
        case 'channel': {
          const r = await this.call('send-channel-message', { teamId: p.team, channelId: p.channel, body: { body: text(p.message) }, confirm: true });
          return { ok: true, id: 'in Teams', url: r?.webUrl ?? '', stamp: 'Posted', linkText: 'Open in Teams' };
        }
        case 'chat': {
          const r = await this.call('send-chat-message', { chatId: p.chat, body: { body: text(p.message) }, confirm: true });
          return { ok: true, id: `to ${this.seen.get(p.chat)?.label ?? 'the chat'}`, url: r?.webUrl ?? '', stamp: 'Message sent', linkText: 'Open in Teams' };
        }
        default:
          return { ok: false, error: `Unknown Microsoft 365 action: ${p.action}`, retryable: false };
      }
    } catch (e) {
      // Never retryable: a send that timed out may have gone through, and a retry would send it twice.
      return { ok: false, error: (e as Error).message, retryable: false };
    }
  }

  async close() {
    await this.client.close();
  }
}
