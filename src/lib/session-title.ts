/**
 * What the user asked, out of the first user message of a request.
 *
 * Claude Code files several requests under one session id, and the first to
 * arrive names the session: the title request wraps the prompt in
 * `<session>…</session>` and appends its own instructions; the auto-mode
 * permission classifier opens with the user's CLAUDE.md and carries no prompt
 * of its own; the conversation itself puts `<system-reminder>` blocks ahead
 * of what the user typed. Only the prompt is the title.
 */
export const SESSION_TITLE_MAX = 2000;

const CLASSIFIER_PREFIX = "The following is the user's CLAUDE.md";

export function sessionTitle(firstText: string): string | null {
  let t = firstText.trim();
  // A stored title cut short can end inside the closing tag: `…\n</ses`.
  const wrapped = /^<session>\s*([\s\S]*?)\s*(?:<\/session>|<\/?[\w-]*$|$)/.exec(t);
  if (wrapped) t = wrapped[1];
  if (t.startsWith(CLASSIFIER_PREFIX)) return null;
  // An unclosed reminder is a stored title cut mid-block: nothing after it is the prompt.
  t = t.replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, "").trim();
  return t ? t.slice(0, SESSION_TITLE_MAX) : null;
}
