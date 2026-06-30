import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// M17 per-sweep workspace isolation (.agents/design/isolation.md). loop/worktree.sh
// gives each implementer SWEEP its own git worktree over the shared object store, so
// concurrent processes (M18) can't collide on one checkout. Pure git mechanics — no
// substrate, no network — so we exercise it against a scratch repo.

const HELPER = join(__dirname, "..", "loop", "worktree.sh");
let repo: string;
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
const wt = (args: string[]) => execFileSync("bash", [join(repo, "loop", "worktree.sh"), ...args], { cwd: repo, encoding: "utf8" }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ainarres-wt-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.invalid"]);
  git(["config", "user.name", "t"]);
  git(["checkout", "-q", "-b", "main"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  mkdirSync(join(repo, "loop"), { recursive: true });
  copyFileSync(HELPER, join(repo, "loop", "worktree.sh"));
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("worktree.sh", () => {
  it("enter creates an isolated checkout; two sweeps don't see each other's edits", () => {
    const p1 = wt(["enter", "sweep-1"]);
    const p2 = wt(["enter", "sweep-2"]);
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);
    expect(p1).not.toBe(p2);

    // Mutate sweep-1's tree only.
    writeFileSync(join(p1, "f.txt"), "changed-by-1\n");
    expect(readFileSync(join(p2, "f.txt"), "utf8")).toBe("base\n"); // sweep-2 untouched
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("base\n"); // main checkout untouched
  });

  it("enter is idempotent — re-entering the same id returns the same path, no error", () => {
    const a = wt(["enter", "sweep-1"]);
    const b = wt(["enter", "sweep-1"]);
    expect(a).toBe(b);
  });

  it("a sweep can branch + commit independently inside its worktree", () => {
    const p = wt(["enter", "sweep-3"]);
    git(["checkout", "-q", "-b", "loop/task-abc"], p);
    writeFileSync(join(p, "f.txt"), "task-abc work\n");
    git(["add", "-A"], p);
    git(["commit", "-qm", "task-abc"], p);
    // The branch exists in the shared repo; main's checkout is still the base.
    expect(git(["branch", "--list", "loop/task-abc"])).toContain("loop/task-abc");
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("base\n");
  });

  it("gc removes worktrees not in the active set, keeps the active ones", () => {
    wt(["enter", "sweep-1"]);
    wt(["enter", "sweep-2"]);
    wt(["gc", "sweep-2"]); // keep only sweep-2
    expect(existsSync(join(repo, ".loop-worktrees", "sweep-1"))).toBe(false);
    expect(existsSync(join(repo, ".loop-worktrees", "sweep-2"))).toBe(true);
  });

  it("teardown removes a worktree and deregisters it", () => {
    const p = wt(["enter", "sweep-9"]);
    expect(existsSync(p)).toBe(true);
    wt(["teardown", "sweep-9"]);
    expect(existsSync(p)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"])).not.toContain("sweep-9");
  });

  it("gc with no active ids clears the worktree dir entirely (end-of-run)", () => {
    wt(["enter", "sweep-a"]);
    wt(["enter", "sweep-b"]);
    wt(["gc"]);
    const list = git(["worktree", "list", "--porcelain"]);
    expect(list).not.toContain("sweep-a");
    expect(list).not.toContain("sweep-b");
  });
});
