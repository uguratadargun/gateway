/**
 * Condition expressions for workflow edges.
 *
 * A workflow file is data, not code: expressions are tokenized, parsed into a
 * small AST and interpreted here. There is deliberately no `eval` /
 * `new Function` anywhere in this path, so an untrusted workflow file cannot
 * execute arbitrary JavaScript.
 *
 *   outputs.tester.passed == false && outputs.reviewer.verdict != "approved"
 */

export class ConditionError extends Error {}

export type BinaryOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "&&" | "||";

export type ConditionNode =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "path"; path: string[] }
  | { kind: "not"; expr: ConditionNode }
  | { kind: "neg"; expr: ConditionNode }
  | { kind: "binary"; op: BinaryOp; left: ConditionNode; right: ConditionNode };

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

const OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "(", ")", "."];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let s = "";
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          s += src[i + 1];
          i += 2;
          continue;
        }
        s += src[i++];
      }
      if (i >= src.length) throw new ConditionError(`unterminated string in: ${src}`);
      i++;
      out.push({ t: "str", v: s });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let s = "";
      while (i < src.length && /[0-9._]/.test(src[i])) s += src[i++];
      const n = Number(s.replace(/_/g, ""));
      if (Number.isNaN(n)) throw new ConditionError(`invalid number "${s}"`);
      out.push({ t: "num", v: n });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = "";
      // Dashes are part of a name here: node ids allow them and there is no
      // subtraction operator, so "outputs.security-review.ok" is unambiguous.
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) s += src[i++];
      out.push({ t: "ident", v: s });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ConditionError(`unexpected character "${c}" in: ${src}`);
    i += op.length;
    out.push({ t: "op", v: op });
  }
  return out;
}

/** Recursive-descent parser: || < && < comparison < unary < primary. */
class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[], private readonly src: string) {}

  parse(): ConditionNode {
    const node = this.or();
    if (this.pos < this.toks.length) throw new ConditionError(`trailing input in: ${this.src}`);
    return node;
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private eatOp(...ops: string[]): string | null {
    const t = this.peek();
    if (t?.t === "op" && ops.includes(t.v)) {
      this.pos++;
      return t.v;
    }
    return null;
  }

  private or(): ConditionNode {
    let left = this.and();
    while (this.eatOp("||")) left = { kind: "binary", op: "||", left, right: this.and() };
    return left;
  }

  private and(): ConditionNode {
    let left = this.comparison();
    while (this.eatOp("&&")) left = { kind: "binary", op: "&&", left, right: this.comparison() };
    return left;
  }

  private comparison(): ConditionNode {
    const left = this.unary();
    const op = this.eatOp("==", "!=", ">=", "<=", ">", "<");
    if (!op) return left;
    return { kind: "binary", op: op as BinaryOp, left, right: this.unary() };
  }

  private unary(): ConditionNode {
    if (this.eatOp("!")) return { kind: "not", expr: this.unary() };
    return this.primary();
  }

  private primary(): ConditionNode {
    const t = this.peek();
    if (!t) throw new ConditionError(`unexpected end of expression: ${this.src}`);
    if (t.t === "op" && t.v === "(") {
      this.pos++;
      const inner = this.or();
      if (!this.eatOp(")")) throw new ConditionError(`missing ")" in: ${this.src}`);
      return inner;
    }
    if (t.t === "num") {
      this.pos++;
      return { kind: "literal", value: t.v };
    }
    if (t.t === "str") {
      this.pos++;
      return { kind: "literal", value: t.v };
    }
    if (t.t === "ident") {
      this.pos++;
      if (t.v === "true") return { kind: "literal", value: true };
      if (t.v === "false") return { kind: "literal", value: false };
      if (t.v === "null") return { kind: "literal", value: null };
      const path = [t.v];
      while (this.eatOp(".")) {
        const seg = this.peek();
        if (seg?.t !== "ident") throw new ConditionError(`expected a name after "." in: ${this.src}`);
        this.pos++;
        path.push(seg.v);
      }
      return { kind: "path", path };
    }
    throw new ConditionError(`unexpected token "${t.v}" in: ${this.src}`);
  }
}

/** Parse an expression. Throws ConditionError on a malformed one (load time). */
export function parseCondition(src: string): ConditionNode {
  if (!src.trim()) throw new ConditionError("empty condition");
  return new Parser(tokenize(src), src).parse();
}

/** Every dotted path an expression reads, for load-time reference checking. */
export function conditionPaths(node: ConditionNode): string[][] {
  switch (node.kind) {
    case "path":
      return [node.path];
    case "not":
    case "neg":
      return conditionPaths(node.expr);
    case "binary":
      return [...conditionPaths(node.left), ...conditionPaths(node.right)];
    default:
      return [];
  }
}

function lookup(path: string[], ctx: unknown): unknown {
  let cur: unknown = ctx;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}

function evalNode(node: ConditionNode, ctx: unknown): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "path":
      return lookup(node.path, ctx);
    case "not":
      return !truthy(evalNode(node.expr, ctx));
    case "neg": {
      const v = evalNode(node.expr, ctx);
      if (typeof v !== "number") throw new ConditionError("unary minus needs a number");
      return -v;
    }
    case "binary": {
      if (node.op === "&&") return truthy(evalNode(node.left, ctx)) && truthy(evalNode(node.right, ctx));
      if (node.op === "||") return truthy(evalNode(node.left, ctx)) || truthy(evalNode(node.right, ctx));
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      // A missing output and an explicit null both mean "absent".
      if (node.op === "==") return l == null && r == null ? true : l === r;
      if (node.op === "!=") return l == null && r == null ? false : l !== r;
      if (typeof l === "number" && typeof r === "number") return compare(node.op, l, r);
      if (typeof l === "string" && typeof r === "string") return compare(node.op, l, r);
      throw new ConditionError(`cannot compare ${typeof l} with ${typeof r} using "${node.op}"`);
    }
  }
}

function compare<T extends number | string>(op: BinaryOp, l: T, r: T): boolean {
  switch (op) {
    case ">":
      return l > r;
    case ">=":
      return l >= r;
    case "<":
      return l < r;
    default:
      return l <= r;
  }
}

/** Evaluate a parsed (or raw) expression against a context object. */
export function evaluateCondition(expr: string | ConditionNode, ctx: unknown): boolean {
  const ast = typeof expr === "string" ? parseCondition(expr) : expr;
  return truthy(evalNode(ast, ctx));
}
