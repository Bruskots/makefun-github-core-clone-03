import { Forge } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The login that will own the repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/name full name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the token user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// tools/list must answer byte-for-byte identical on every call, so the
// table is frozen once at module load and never mutated afterwards.
Object.freeze(TOOLS);
for (const tool of TOOLS) Object.freeze(tool);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = asText(pick(args, ['owner', 'owner_login', 'login', 'user_login']));
  let repo = asText(pick(args, ['repo', 'repository', 'repo_name', 'repository_name']));
  if (repo === '') {
    const full = asText(pick(args, ['full_name', 'repo_full_name', 'repository_full_name']));
    const slash = full.indexOf('/');
    if (slash > 0) {
      if (owner === '') owner = full.slice(0, slash);
      repo = full.slice(slash + 1);
    }
  }
  return { owner, repo };
}

type ToolOutcome =
  | { ok: true; result: unknown; text?: unknown }
  | { ok: false; message: string };

function toolResult(result: unknown, text?: unknown): Record<string, unknown> {
  const shown = text ?? result;
  return {
    content: [{ type: 'text', text: typeof shown === 'string' ? shown : JSON.stringify(shown) }],
    structuredContent: isRecord(result) ? result : { value: result },
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const lowered = name.toLowerCase();
  if (lowered === 'create_repo') {
    const repoName = asText(pick(args, ['name', 'repo', 'repository', 'repository_name']));
    if (repoName === '') return { ok: false, message: 'Missing required argument: name' };
    const owner = asText(pick(args, ['owner', 'owner_login']));
    if (owner !== '' && forge.viewerLogin === null) forge.claimOwner(owner);
    const repo = forge.createRepo(repoName, asText(pick(args, ['description', 'about', 'body'])), pick(args, ['private', 'is_private']) === true);
    if (repo === null) return { ok: false, message: `Repository '${repoName}' already exists` };
    return { ok: true, result: forge.repoJson(repo) };
  }
  if (lowered === 'get_repo') {
    const { owner, repo: repoName } = splitFullName(args);
    if (owner === '' || repoName === '') return { ok: false, message: 'Missing required argument: owner and repo' };
    const repo = forge.findRepo(owner, repoName);
    if (repo === null) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
    return { ok: true, result: forge.repoJson(repo) };
  }
  if (lowered === 'create_issue') {
    const { owner, repo: repoName } = splitFullName(args);
    const title = asText(pick(args, ['title', 'issue_title', 'subject']));
    if (owner === '' || repoName === '') return { ok: false, message: 'Missing required argument: owner and repo' };
    if (title === '') return { ok: false, message: 'Missing required argument: title' };
    const repo = forge.findRepo(owner, repoName);
    if (repo === null) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
    const body = asText(pick(args, ['body', 'issue_body', 'description', 'content']));
    const issue = forge.createIssue(repo, title, body, []);
    if ('error' in issue) return { ok: false, message: issue.error };
    return { ok: true, result: forge.issueJson(repo, issue) };
  }
  if (lowered === 'list_issues') {
    const { owner, repo: repoName } = splitFullName(args);
    if (owner === '' || repoName === '') return { ok: false, message: 'Missing required argument: owner and repo' };
    const repo = forge.findRepo(owner, repoName);
    if (repo === null) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
    const state = asText(pick(args, ['state', 'status'])) || 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => a.number - b.number);
    const items = list.map((issue) => forge.issueJson(repo, issue));
    return { ok: true, result: { issues: items }, text: items };
  }
  if (lowered === 'create_pull_request') {
    const { owner, repo: repoName } = splitFullName(args);
    const title = asText(pick(args, ['title', 'pr_title', 'pull_request_title', 'subject']));
    const head = asText(pick(args, ['head', 'head_ref', 'head_branch', 'source_branch', 'from_branch'])).split(':').pop() ?? '';
    const base = asText(pick(args, ['base', 'base_ref', 'base_branch', 'target_branch', 'into_branch'])).split(':').pop() ?? '';
    if (owner === '' || repoName === '') return { ok: false, message: 'Missing required argument: owner and repo' };
    if (title === '' || head === '' || base === '') return { ok: false, message: 'Missing required argument: title, head and base' };
    const repo = forge.findRepo(owner, repoName);
    if (repo === null) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
    const body = asText(pick(args, ['body', 'description', 'content']));
    const pull = forge.createPull(repo, head, base, title, body);
    if ('error' in pull) return { ok: false, message: pull.error };
    return { ok: true, result: forge.pullJson(repo, pull) };
  }
  if (lowered === 'merge_pull_request') {
    const { owner, repo: repoName } = splitFullName(args);
    const number = asInt(pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number']));
    if (owner === '' || repoName === '') return { ok: false, message: 'Missing required argument: owner and repo' };
    if (number === null) return { ok: false, message: 'Missing required argument: pull_number' };
    const repo = forge.findRepo(owner, repoName);
    if (repo === null) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { ok: false, message: `Pull request #${number} not found` };
    const merged = forge.mergePull(repo, pull);
    if (!merged.ok) return { ok: false, message: merged.reason === 'conflict' ? 'Merge conflict' : merged.reason };
    return { ok: true, result: { sha: merged.sha, merged: true, number, state: 'closed', message: `Pull request #${number} successfully merged` } };
  }
  if (lowered === 'get_issue') {
    const { owner, repo: repoName } = splitFullName(args);
    const number = asInt(pick(args, ['issue_number', 'number']));
    if (owner === '' || repoName === '') return { ok: false, message: 'Missing required argument: owner and repo' };
    if (number === null) return { ok: false, message: 'Missing required argument: issue_number' };
    const repo = forge.findRepo(owner, repoName);
    if (repo === null) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
    const issue = repo.issues.get(number);
    if (issue === undefined) return { ok: false, message: `Issue #${number} not found` };
    return { ok: true, result: forge.issueJson(repo, issue) };
  }
  if (lowered === 'list_repos') {
    const items = forge.listRepos().map((repo) => forge.repoJson(repo));
    return { ok: true, result: { repositories: items }, text: items };
  }
  return { ok: false, message: `Unknown tool: ${name}` };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function dispatch(forge: Forge, request: unknown): { empty: boolean; body: unknown } {
  if (!isRecord(request)) return { empty: false, body: rpcError(null, -32600, 'Invalid Request') };
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  if (id === undefined) {
    // A notification: no answer is owed.
    return { empty: true, body: null };
  }

  if (method === 'server/discover') {
    return {
      empty: false,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests, and merge them.',
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return {
      empty: false,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'ping') {
    return { empty: false, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { empty: false, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = TOOLS.some((tool) => tool.name.toLowerCase() === name.toLowerCase());
    if (!known) {
      return { empty: false, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const outcome = runTool(forge, name, args);
    if (!outcome.ok) {
      return { empty: false, body: rpcResult(id, toolError(outcome.message)) };
    }
    return { empty: false, body: rpcResult(id, toolResult(outcome.result, outcome.text)) };
  }
  return { empty: false, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

export function handleMcp(forge: Forge, token: string, authHeader: string, raw: Buffer): { empty: boolean; status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return { empty: false, status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (token !== '' && authHeader !== `Bearer ${token}`) {
    return { empty: false, status: 401, body: { message: 'Requires authentication' } };
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      const answer = dispatch(forge, entry);
      if (!answer.empty) answers.push(answer.body);
    }
    return { empty: false, status: 200, body: answers };
  }
  const answer = dispatch(forge, parsed);
  if (answer.empty) return { empty: true, status: 202, body: null };
  return { empty: false, status: 200, body: answer.body };
}
