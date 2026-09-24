/**
 * How hard a model thinks: the `effort:` an agent file names. Claude Code
 * takes it as its own `--effort`/`effort` setting for a node's subagent; gate
 * only checks that it is one of these.
 */
export type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["default", "low", "medium", "high", "xhigh", "max"];
