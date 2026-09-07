import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@/components/diff-view";

/** A real `git diff`: a new file, an edit, a rename, a delete, a binary. */
const DIFF = `diff --git a/ts/state/presenceStore.ts b/ts/state/presenceStore.ts
new file mode 100644
index 0000000..8b1a993
--- /dev/null
+++ b/ts/state/presenceStore.ts
@@ -0,0 +1,3 @@ 
+export const presence = new Map();
+
+export default presence;
diff --git a/ts/components/Avatar.tsx b/ts/components/Avatar.tsx
index 264a1b2..991ccde 100644
--- a/ts/components/Avatar.tsx
+++ b/ts/components/Avatar.tsx
@@ -264,7 +264,8 @@ export class Avatar extends React.Component<Props, State> {
   public render(): JSX.Element {
-    const { size } = this.props;
+    const { size, isOnline } = this.props;
+    const dot = isOnline ? "on" : "off";
     return null;
   }
diff --git a/old/name.ts b/new/name.ts
similarity index 96%
rename from old/name.ts
rename to new/name.ts
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-export default a;
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF);

  it("finds every file git described, including ones with no hunks", () => {
    expect(files.map((f) => f.path)).toEqual([
      "ts/state/presenceStore.ts",
      "ts/components/Avatar.tsx",
      "new/name.ts",
      "gone.ts",
      "logo.png",
    ]);
    expect(files.map((f) => f.status)).toEqual(["added", "modified", "renamed", "deleted", "modified"]);
    expect(files[2].oldPath).toBe("old/name.ts");
    expect(files[4].note).toBe("binary file");
  });

  it("counts additions and deletions without counting the +++/--- headers", () => {
    // The file headers start with "+++"/"---" and would inflate both counts if
    // they were treated as content lines.
    expect(files[0]).toMatchObject({ additions: 3, deletions: 0 });
    expect(files[1]).toMatchObject({ additions: 2, deletions: 1 });
    expect(files[3]).toMatchObject({ additions: 0, deletions: 2 });
  });

  it("numbers both sides the way the hunk header says", () => {
    const lines = files[1].hunks[0].lines;
    expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["context", 264, 264],
      ["del", 265, null],
      ["add", null, 265],
      ["add", null, 266],
      ["context", 266, 267],
      ["context", 267, 268],
    ]);
  });

  it("keeps a hunk's trailing context and its section header", () => {
    expect(files[1].hunks[0].header).toBe("export class Avatar extends React.Component<Props, State> {");
    expect(files[0].hunks[0].lines.map((l) => l.text)).toEqual([
      "export const presence = new Map();",
      "",
      "export default presence;",
    ]);
  });
});
