export type ToolSpec = { name: string; description: string; properties: Record<string, { type: string; description: string }>; required: string[] };

/** Coding actions, in a stable order so the tool prefix can be cached. */
export const codingTools: ToolSpec[] = [
  { name: 'check', description: 'Run the user-supplied verification command', properties: {}, required: [] },
  { name: 'create', description: 'Create a new text file', properties: { path: { type: 'string', description: 'Relative file' }, content: { type: 'string', description: 'File text' } }, required: ['path', 'content'] },
  { name: 'finish', description: 'Stop and report what changed and what was verified', properties: { summary: { type: 'string', description: 'What changed and what was verified' } }, required: ['summary'] },
  { name: 'graph', description: 'Return the task graph recorded so far', properties: {}, required: [] },
  { name: 'impact', description: 'List importers and tests for a file', properties: { path: { type: 'string', description: 'Relative file' } }, required: ['path'] },
  { name: 'list', description: 'List a project directory', properties: { path: { type: 'string', description: 'Relative directory' } }, required: ['path'] },
  { name: 'read', description: 'Read a project file', properties: { path: { type: 'string', description: 'Relative file' } }, required: ['path'] },
  { name: 'replace', description: 'Replace one exact text match in a file', properties: { path: { type: 'string', description: 'Relative file' }, old: { type: 'string', description: 'Exact text that appears once' }, new: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old', 'new'] },
];
