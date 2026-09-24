/**
 * The tool vocabulary an `executor: gate` agent file may draw from. Names are
 * validated when an agent is saved, so a typo fails in the editor rather than
 * in front of the person.
 *
 * Nothing in gate executes these any more: the person's session does the node
 * with its own tools and reads the list as the shape of the role — reads for a
 * reviewer, writes for an implementer. The memory tools are the exception with
 * a concrete form, `gate memory search`, `gate memory feature` and
 * `gate memory history`, which the session is told to run in their place.
 */
const TOOLS = [
  "read_file",
  "list_files",
  "search_files",
  "write_file",
  "edit_file",
  "run_command",
  "memory_search",
  "memory_feature",
  "memory_history",
] as const;

export function knownToolNames(): string[] {
  return [...TOOLS].sort();
}

export function isKnownTool(name: string): boolean {
  return (TOOLS as readonly string[]).includes(name);
}
