import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { raceHypotheses } from '../src/actor-coding.ts';
import { ActorRuntime, brierScore, consolidateBrain, reconsolidate, templates } from '../src/actors.ts';
import type { Brain } from '../src/actors.ts';
import { gitRepo, openJournal, tempDir } from './helpers.ts';

const pass = 'node -e "process.exit(0)"';
const fail = 'node -e "process.exit(1)"';

function episode(file: string, status: string, note: string): Brain['episodic'][number] {
  return { at: note, status, files: [file], note };
}

test('consolidation turns two failures into one claim and does not revive a retraction', () => {
  const brain: Brain = {
    role: 'coder', template: 'coder', workingContext: '', procedural: templates.coder,
    taskGraph: { nodes: [], edges: [] }, decisions: [], hypotheses: [],
    episodic: [episode('a.txt', 'failed', '1'), episode('a.txt', 'unverified', '2'), episode('b.txt', 'failed', '3')],
    claims: [{ id: 'old', text: 'Edits touching c.txt failed', status: 'retracted', files: ['c.txt'], strength: 0.9, retrieved: 1 }],
  };
  const once = consolidateBrain(brain);
  assert.deepEqual(once.distilled, ['claim-a-txt']);
  assert.equal(once.brain.claims.find(claim => claim.files.includes('a.txt'))?.status, 'unverified');
  assert.equal(once.brain.claims.find(claim => claim.files.includes('b.txt')), undefined, 'one failure stays an episode');
  assert.equal(once.brain.claims.find(claim => claim.id === 'old')?.status, 'retracted');
  const again = consolidateBrain({ ...once.brain, episodic: [...once.brain.episodic, episode('a.txt', 'failed', '4')] });
  assert.equal(again.brain.claims.find(claim => claim.files.includes('a.txt'))?.status, 'supported');
  assert.equal(again.distilled.length, 0);
});

test('unreinforced claims decay below the recall floor and a resumed outcome contests a failure claim', () => {
  let brain: Brain = {
    role: 'coder', template: 'coder', workingContext: '', procedural: templates.coder,
    taskGraph: { nodes: [], edges: [] }, episodic: [], decisions: [], hypotheses: [],
    claims: [{ id: 'stale', text: 'old', status: 'unverified', files: ['z.txt'], strength: 0.4, retrieved: 0 }],
  };
  for (let pass = 0; pass < 5; pass += 1) brain = consolidateBrain(brain).brain;
  assert.equal(brain.claims.find(claim => claim.id === 'stale'), undefined);
  const contested = reconsolidate({
    ...brain,
    claims: [{ id: 'a', text: 'Edits touching a.txt failed', status: 'supported', files: ['a.txt'], strength: 0.6, retrieved: 0 }],
  }, { files: ['a.txt'], status: 'completed' });
  const contestedClaim = contested.claims[0];
  if (!contestedClaim) throw new Error('missing contested claim');
  assert.equal(contestedClaim.status, 'contested');
  assert.equal(contestedClaim.retrieved, 1);
  assert.ok(contestedClaim.strength < 0.6);
  const supported = reconsolidate(structuredClone(contested), { files: ['a.txt'], status: 'failed' });
  const supportedClaim = supported.claims[0];
  if (!supportedClaim) throw new Error('missing supported claim');
  assert.equal(supportedClaim.status, 'supported');
  const untouched = reconsolidate(supported, { files: ['other.txt'], status: 'completed' });
  const untouchedClaim = untouched.claims[0];
  if (!untouchedClaim) throw new Error('missing untouched claim');
  assert.equal(untouchedClaim.retrieved, supportedClaim.retrieved);
});

test('brier score is the mean squared error and ignores unscored decisions', () => {
  assert.equal(brierScore([]), undefined);
  const score = brierScore([{ confidence: 0.8, outcome: 1 }, { confidence: 0.9, outcome: 0 }, { confidence: 0.5 }]);
  assert.ok(score !== undefined && Math.abs(score - ((0.2 ** 2) + (0.9 ** 2)) / 2) < 1e-12);
});

test('idle actors are claimed from the pool and a second connection resumes the checkpoint', async context => {
  const { journal } = await openJournal(context);
  const runtime = new ActorRuntime(journal);
  const first = runtime.spawn('coder');
  const second = runtime.spawn('coder');
  const claimed = runtime.claim('coder');
  assert.equal(claimed.actor.id, first.actor.id);
  assert.equal(runtime.get(second.actor.id).state, 'idle');
  const brain = runtime.brain(first.actor.id);
  brain.workingContext = 'saved context';
  runtime.release(first.actor.id, brain);
  assert.equal(runtime.resident(first.actor.id), false);
  assert.equal(runtime.get(first.actor.id).state, 'idle');
  const reopened = new ActorRuntime(journal);
  const again = reopened.claim('coder');
  assert.equal(again.actor.id, first.actor.id);
  assert.equal(again.brain.workingContext, 'saved context');
  assert.equal(again.brain.procedural, templates.coder);
});

test('revert keeps the abandoned snapshot, and fork does not change the parent', async context => {
  const { journal } = await openJournal(context);
  const runtime = new ActorRuntime(journal);
  const planner = runtime.spawn('planner', { context: 'original plan' });
  const edited = runtime.brain(planner.actor.id);
  edited.workingContext = 'wandered';
  const version = runtime.checkpoint(planner.actor.id, edited, { sleep: false });
  assert.equal(runtime.revert(planner.actor.id, 1).workingContext, 'original plan');
  assert.equal(runtime.brainAt(planner.actor.id, version).workingContext, 'wandered');
  const sibling = runtime.fork(planner.actor.id, {
    role: 'coder',
    hypothesis: { id: 'h1', text: 'edit a.txt', confidence: 0.4, files: ['a.txt'] },
  });
  assert.equal(sibling.brain.role, 'coder');
  assert.equal(sibling.brain.procedural, templates.coder);
  assert.equal(sibling.brain.decisions[0]?.outcome, undefined, 'confidence is recorded before any outcome');
  assert.equal(sibling.actor.forkedFrom?.actorId, planner.actor.id);
  assert.equal(runtime.brain(planner.actor.id).workingContext, 'original plan');
  assert.notEqual(sibling.actor.id, planner.actor.id);
});

test('a supervisor retries once from the snapshot and a second crash stays crashed', async context => {
  const { journal } = await openJournal(context);
  const runtime = new ActorRuntime(journal);
  const coder = runtime.spawn('coder', { context: 'clean' });
  let calls = 0;
  const value = await runtime.supervise(coder.actor.id, async brain => {
    calls += 1;
    assert.equal(brain.workingContext, 'clean');
    brain.workingContext = 'dirty';
    if (calls === 1) throw new Error('disk full');
    return 'kept';
  });
  assert.equal(value, 'kept');
  assert.equal(calls, 2);
  assert.equal(runtime.get(coder.actor.id).restarts, 1);
  assert.equal(runtime.brain(coder.actor.id).workingContext, 'clean');
  await assert.rejects(runtime.supervise(coder.actor.id, async () => { throw new Error('still broken'); }), /still broken/);
  assert.equal(runtime.get(coder.actor.id).state, 'crashed');
  assert.equal(runtime.brain(coder.actor.id).workingContext, 'clean');
});

test('messages wait in the journal until they are acknowledged', async context => {
  const { journal } = await openJournal(context);
  const runtime = new ActorRuntime(journal);
  const from = runtime.spawn('planner');
  const to = runtime.spawn('verifier');
  runtime.send(from.actor.id, to.actor.id, 'verdict', { status: 'failed' });
  assert.equal((runtime.inbox(to.actor.id)[0]?.body as { status: string }).status, 'failed');
  assert.equal(runtime.inbox(to.actor.id).length, 1);
  runtime.ack(runtime.inbox(to.actor.id).map(message => message.id));
  assert.equal(runtime.inbox(to.actor.id).length, 0);
});

test('forked hypotheses keep dissent and accept only the completed check', async context => {
  const root = await gitRepo(context, { 'a.txt': 'one', 'b.txt': 'two' });
  const { journal } = await openJournal(context);
  const runtime = new ActorRuntime(journal);
  const trees: Record<string, string> = {};
  for (const name of ['left', 'right']) {
    const path = join(dirname(root), `hyp-${name}`);
    trees[name] = path;
    context.after(() => rm(path, { recursive: true, force: true }));
    execFileSync('git', ['worktree', 'add', '--detach', path, 'HEAD'], { cwd: root, stdio: 'pipe' });
  }
  const rightSeen: string[] = [];
  const script = (steps: unknown[], log?: string[]) => {
    let index = 0;
    return async (messages: { content: string }[]) => {
      log?.push(messages.map(message => message.content).join('\n'));
      return JSON.stringify(steps[index++]);
    };
  };
  const left = trees.left;
  const right = trees.right;
  if (!left || !right) throw new Error('hypothesis worktrees were not created');
  const race = await raceHypotheses({
    runtime,
    hypotheses: [
      {
        id: 'left', text: 'Change a.txt to ONE', confidence: 0.8, files: ['a.txt'], task: 'Change a.txt',
        worktree: left, check: pass,
        provider: script([
          { action: 'replace', path: 'a.txt', old: 'one', new: 'ONE' },
          { action: 'check' },
          { action: 'finish', summary: 'done' },
        ]),
      },
      {
        id: 'right', text: 'Change b.txt and fail the check', confidence: 0.9, files: ['b.txt'], task: 'Change b.txt',
        worktree: right, check: fail,
        provider: script([
          { action: 'replace', path: 'b.txt', old: 'two', new: 'TWO' },
          { action: 'check' },
          { action: 'finish', summary: 'I passed' },
        ], rightSeen),
      },
    ],
  });
  assert.equal(race.accepted, 'left');
  assert.deepEqual(race.dissent, ['right']);
  assert.equal(runtime.brain(race.plannerId).workingContext.includes('Change a.txt'), true);
  assert.equal(runtime.get(race.plannerId).version, race.plannerVersion, 'the race does not rewrite the planner after the fork point');
  const coder = runtime.list().find(actor => actor.role === 'coder' && actor.forkedFrom);
  assert.ok(coder);
  assert.equal(runtime.brainAt(coder.id, 1).decisions[0]?.outcome, undefined);
  assert.ok(!rightSeen.join('\n').includes('ONE'), 'the second coder does not see the first coder\'s edit');
  assert.ok((race.brier ?? 1) > 0, 'a confident failure is not a perfect forecast');
  assert.equal(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'a.txt'), 'utf8')), 'one');
});

test('CLI lists actors from the journal', async context => {
  const { spawnSync } = await import('node:child_process');
  const home = await tempDir(context);
  const { Journal } = await import('../src/durable.ts');
  const journal = new Journal(home);
  new ActorRuntime(journal).spawn('reviewer');
  journal.close();
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'actors'], { encoding: 'utf8', env: { ...process.env, VLYN_HOME: home } });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /reviewer/u);
});
