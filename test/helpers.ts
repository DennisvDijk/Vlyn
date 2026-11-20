import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { Journal } from '../src/durable.ts';

export async function tempDir(context: TestContext, prefix = 'vlyn-'): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
}

export async function gitRepo(context: TestContext, files: Record<string, string>): Promise<string> {
  const root = await tempDir(context, 'vlyn-repo-');
  await writeFiles(root, files);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  return root;
}

/** A model that replays scripted JSON actions per task id. */
export function scripted(actions: Record<string, unknown[]>) {
  return (task: { id: string }) => {
    let index = 0;
    return async () => JSON.stringify(actions[task.id][index++]);
  };
}

/** A journal in a temporary home. It is closed before the folder is removed, which Windows requires. */
export async function openJournal(context: TestContext): Promise<{ journal: Journal; home: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vlyn-home-')));
  const journal = new Journal(home);
  context.after(async () => {
    try { journal.close(); } catch { /* already closed */ }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { journal, home };
}
