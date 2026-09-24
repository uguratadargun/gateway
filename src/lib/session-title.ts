/**
 * What the user asked, out of the first user message of a request.
 *
 * Claude Code files several requests under one session id, and the first to
 * arrive names the session: the title request wraps the prompt in
 * `<session>…</session>` and appends its own instructions; the auto-mode
 * permission classifier opens with the user's CLAUDE.md and carries no prompt
 * of its own, and neither does one that opens with a `<transcript>`; the
 * conversation itself puts `<system-reminder>` blocks, and an IDE its
 * `<ide_…>` blocks, ahead of what the user typed, and a slash command arrives
 * as `<command-name>` and `<command-args>`. Only the prompt is the title.
 */
export const SESSION_TITLE_MAX = 2000;

const CLASSIFIER_PREFIX = "The following is the user's CLAUDE.md";

export function sessionTitle(firstText: string): string | null {
  let t = firstText.trim();
  const wrapped = /^<session>\s*([\s\S]*?)\s*(?:<\/session>|$)/.exec(t);
  if (wrapped) t = wrapped[1];
  if (t.startsWith(CLASSIFIER_PREFIX) || t.startsWith("<transcript>")) return null;
  // An unclosed block is a stored title cut mid-block: nothing after it is the prompt.
  t = t.replace(/<(system-reminder|ide_[a-z_]+|local-command-[a-z]+)>[\s\S]*?(?:<\/\1>|$)/g, "").trim();
  // A slash command arrives as tags; its title is the command as typed.
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (command) t = `${command[1]} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1] ?? ""}`.trim();
  // A stored title cut short can end inside a closing tag: `…\n</ses`.
  t = t.replace(/\s*<\/[\w-]*$/, "");
  return t ? t.slice(0, SESSION_TITLE_MAX) : null;
}
