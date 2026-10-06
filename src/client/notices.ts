/**
 * What a node is told about the harness it runs in, which no agent's prompt
 * says: the notices every `claude-code` node gets, because they are about
 * Claude Code and the person's absence rather than about any one agent's
 * method.
 */

/**
 * What a node is told when nothing it does can be answered.
 *
 * Models are trained in sessions with a person in them: they stop at an
 * approval, ask a clarifying question, raise a concern "before starting". A
 * subagent's question has no one to reach — so the node is told so, and told
 * what to do instead.
 *
 * Who gets it follows the executor. Every `claude-code` node does, because a
 * subagent of the person's session cannot ask the person. An `executor: gate`
 * node run by the session itself never does: there the person is right
 * there, and a node that needs to ask should ask. Deciding this from the prompt's
 * wording was tried; the model guessed "unattended" with a user watching,
 * and approved its own plan.
 *
 * So the notices are issued in exactly two places — the prompt `gate next`
 * hands a claude-code node, and the subagent file it is started from — and
 * nowhere else. Three are issued there: this one, `backgroundSubagentNotice`,
 * and `fileReadingNotice`. The rule is about the *places*, not the count: a fourth
 * added to both sites keeps it, and one added to an agent's prompt instead
 * breaks it, because then only that agent has it and the next one written
 * does not. An agent prompt may rely on all three: a claude-code agent is
 * always unattended, always dispatching into a background harness, and always
 * holds the file tools this repository's agents are measured against, so a
 * prompt that hedges "when there is a person" — or repeats what these say —
 * is hedging against a case that does not happen.
 */
export function unattendedNotice(): string {
  return (
    "This node is running unattended: there is no person in this session, and a question you ask here reaches " +
    "nobody. Where you would stop for approval, ask a clarifying question, or raise a concern " +
    "before starting, do not wait for a reply here. If the prompt below gives such questions a way out — an " +
    "output field they go into, so that the run can put them to the person elsewhere — put them there, all of " +
    "them, and stop; the person decides, not you, and a decision you take in their place is a defect. Only where " +
    "the prompt gives no such way out, or tells you the person has already been asked and was not there, take the " +
    "reading a careful colleague would take, act on it, and record the ruling where the answer would have been " +
    "recorded (the plan file, your summary), so that a wrong one can be seen and undone."
  );
}

/**
 * How subagents behave in a Claude Code that gate drives, which a model does
 * not assume: it writes as if dispatch blocks until the subagent answers, and
 * in this harness it does not.
 * Measured here: an implementer that dispatched a review and then slept in a
 * shell loop for eight minutes waiting for a report file — eighty sleeps in
 * one reviewer — with the result already delivered as a notification. And,
 * in the run after, an implementer that dispatched five tasks, wrote "ending
 * my turn to let it run", and was resumed nine minutes later by the
 * notification with the tasks committed: ending the turn is the mechanism,
 * not the end of the node, and the note says so in as many words, because a
 * model reading "end your turn" as "finish" would hand in half a change.
 *
 * Three more failures, all measured in one run, and each one the reason for
 * a sentence below that reads like it is labouring the point:
 *
 * A verifier had its checks green 59 seconds in and then spent 85% of an
 * 18-minute node waiting on forks. It dispatched four; because
 * `subagent_type: "fork"` copies the parent's context, and that context held
 * the instruction to fan out, the four dispatched too — sixteen in all, one
 * branch's tail alone 7¼ minutes, 40% of the node. A depth limit cannot fix
 * this: a copy cannot read its way to knowing it is a copy, so the rule has
 * to cut at the root and forbid the dispatch.
 *
 * Fifteen of that node's twenty-four shell calls were `true`, `sleep`, `echo`
 * or `date`. The old wording forbade sleeping "in a shell loop", and a bare
 * `true` is neither a sleep nor a loop, so the ban is now on the purpose
 * rather than the command.
 *
 * And a reviewer wrote its verdict without one of its forks: 425.9 seconds of
 * Opus finished, its notification appears nowhere in the transcript, and the
 * verdict shipped anyway. "Your final answer comes only when nothing you
 * dispatched is still running" was already there and was not enough, because
 * nothing made the model *look*. Naming each one and what it returned is a
 * check it has to perform rather than a state it has to notice.
 */
export function backgroundSubagentNotice(): string {
  return (
    "Subagents you dispatch with the Agent tool run in the background: the call returns as soon as the subagent " +
    "is launched, and its result reaches you as a notification. Ending your turn while one of yours is still " +
    "running does not finish this node — you are resumed with the result when it completes. So after " +
    "dispatching, do whatever work does not depend on the result, then say what you are waiting on and stop; " +
    "never poll for its commits or a report file, and never run a command whose only purpose is to let time " +
    "pass — no `sleep`, no `true`, no `echo`, no `date`, and no loop around any of them — because the result " +
    "was on its way and a turn spent passing time is one in which it cannot arrive.\n\n" +
    "Never dispatch a subagent type that copies your own context. Your context contains your instruction to " +
    "dispatch, so the copy dispatches too, and its copies do, and a copy cannot tell that it is one. Measured " +
    "here: four such dispatches became sixteen, and one branch's tail was 40% of the node. Dispatch a named " +
    "agent with a task written out in the prompt, so that what it was asked is something you decided and can " +
    "read back.\n\n" +
    "Dispatch only when the work is bigger than the dispatch. A subagent starts cold: it reads what you have " +
    "already read before it can begin, and a check you could run yourself in a minute costs more dispatched " +
    "than done. Reading a handful of files, running this project's test command, answering a question you " +
    "already know where to look for — do those yourself.\n\n" +
    "Before you give your final answer, name every subagent you dispatched and what it returned. If any of " +
    "them has not returned, you have no final answer yet: say which one you are waiting on and stop. A verdict " +
    "written without a result you asked for is wrong even when it happens to be right, because you did not " +
    "know that when you wrote it."
  );
}

/**
 * How reading a file costs what it costs here, which no agent's prompt says
 * because it is a fact about this harness rather than a method.
 *
 * Measured in one implementer node: Read was called 43 times for 1.0 second
 * in total; Bash was called 107 times for 224.6 seconds, of which roughly 143
 * were shell startup alone, and the node opened with 5.2 minutes and 34 Bash
 * calls of pure looking before its first edit. Grep and Glob were never
 * called once. Thirteen Edits were then refused with "File has not been read
 * yet" — 142 seconds thrown away — because the file had been read with `cat`,
 * which the harness does not count. The same four files were read an average
 * of four times each.
 *
 * It belongs here and not in the four agent prompts that would each need it:
 * four copies drift, and none of them is describing how that agent works.
 * They are all describing the same tools.
 */
export function fileReadingNotice(): string {
  return (
    "Read files with Read, find them with Glob, and search them with Grep. Each is one call that returns what " +
    "you asked for. A shell command that does the same thing — `cat`, `head`, `sed -n`, `find`, `grep` — opens " +
    "a shell first, and here that costs more than the read: measured in one node, 43 Reads took a second " +
    "between them while 107 shell calls took nearly four minutes, most of it startup. Shell is for commands " +
    "that do something: tests, a build, git.\n\n" +
    "A file read through the shell does not count as read. The next Edit to it is refused — \"File has not " +
    "been read yet\" — and you pay for the read twice; measured in the same node, thirteen refused Edits. Read " +
    "the whole file the first time rather than a window you will have to widen, and re-read only after " +
    "something has changed it."
  );
}
