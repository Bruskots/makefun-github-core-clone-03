import { decodeGid, gid, Forge, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// A small GraphQL parser for the documents gh and github-mcp-server send.
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface Field {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selection: Field[] | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selection: Field[];
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? '';
    if (/\s/.test(char) || char === ',') { at += 1; continue; }
    if (char === '#') { while (at < text.length && text[at] !== '\n') at += 1; continue; }
    if (char === '.' && text.slice(at, at + 3) === '...') { tokens.push('...'); at += 3; continue; }
    if ('{}():![]=$@'.includes(char)) { tokens.push(char); at += 1; continue; }
    if (char === '"') {
      let out = '';
      at += 1;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\' && at + 1 < text.length) {
          const next = text[at + 1];
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else if (next === '"') out += '"';
          else if (next === '\\') out += '\\';
          else if (next === '/') out += '/';
          else out += next ?? '';
          at += 2;
        } else {
          out += text[at] ?? '';
          at += 1;
        }
      }
      at += 1;
      tokens.push(JSON.stringify(out));
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = at + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end] ?? '')) end += 1;
      tokens.push(text.slice(at, end));
      at = end;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = at + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end] ?? '')) end += 1;
      tokens.push(text.slice(at, end));
      at = end;
      continue;
    }
    at += 1;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  at = 0;

  constructor(text: string) {
    this.tokens = tokenize(text);
  }

  peek(): string | undefined {
    return this.tokens[this.at];
  }

  next(): string {
    const token = this.tokens[this.at] ?? '';
    this.at += 1;
    return token;
  }

  expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') {
      name = this.next();
    }
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const dollar = this.next();
        if (dollar !== '$') throw new Error('expected $ in variable definition');
        const varName = this.next();
        this.expect(':');
        let type = '';
        while (this.peek() !== undefined && this.peek() !== ')' && this.peek() !== ',' && !this.peek()?.startsWith('$')) {
          type += this.next();
        }
        if (this.peek() === ',') this.next();
        variables.push({ name: varName, type });
      }
      this.expect(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  parseSelectionSet(): Field[] {
    this.expect('{');
    const fields: Field[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          const inner = this.parseSelectionSet();
          for (const field of inner) fields.push({ ...field, name: `...on:${typeName}:${field.name}` });
        } else {
          this.next();
        }
        continue;
      }
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  parseField(): Field {
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selection: Field[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) {
        items.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name];
    case 'string': return value.value;
    case 'int': return value.value;
    case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: Field, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, variables);
}

// ---------------------------------------------------------------------------
// schema surface for __type
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'target'],
  SearchType: [],
};

const SEARCH_ENUMS = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function fieldName(field: Field): string {
  return field.name.startsWith('...on:') ? field.name.split(':').pop() ?? field.name : field.name;
}

function responseKey(field: Field): string {
  return field.alias ?? fieldName(field);
}

function unknownField(ctx: ExecContext, typeName: string, field: Field): null {
  const name = fieldName(field);
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueState(repoIssueState: 'open' | 'closed'): string {
  return repoIssueState === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function executeSelection(ctx: ExecContext, typeName: string, source: unknown, fields: Field[]): Record<string, unknown> {
  const handler = PAYLOAD_FIELDS[typeName];
  if (handler !== undefined) {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      out[responseKey(field)] = handler(ctx, source, field);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const name = fieldName(field);
    const key = responseKey(field);
    out[key] = resolveField(ctx, typeName, source, field, name);
  }
  return out;
}

function resolveField(ctx: ExecContext, typeName: string, source: unknown, field: Field, name: string): unknown {
  const forge = ctx.forge;
  const selection = field.selection ?? [];

  if (typeName === 'Query') {
    if (name === 'viewer') {
      const login = forge.viewerLogin ?? 'forge';
      return executeSelection(ctx, 'User', { login }, selection);
    }
    if (name === 'repository') {
      const owner = argValue(field, 'owner', ctx.variables);
      const repoName = argValue(field, 'name', ctx.variables);
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = forge.findRepo(owner, repoName);
      if (repo === null) return null;
      return executeSelection(ctx, 'Repository', repo, selection);
    }
    if (name === 'node') {
      const id = argValue(field, 'id', ctx.variables);
      if (typeof id !== 'string') return null;
      const decoded = decodeGid(id);
      if (decoded === null) return null;
      if (decoded.kind === 'repo') {
        const repoId = Number(decoded.parts[0]);
        const repo = [...forge.reposByName.values()].find((candidate) => candidate.id === repoId);
        if (repo === undefined) return null;
        return executeSelection(ctx, 'Repository', repo, selection);
      }
      if (decoded.kind === 'issue') {
        const repoId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        const repo = [...forge.reposByName.values()].find((candidate) => candidate.id === repoId);
        const issue = repo?.issues.get(number);
        if (repo === undefined || issue === undefined) return null;
        return executeSelection(ctx, 'Issue', { repo, issue }, selection);
      }
      if (decoded.kind === 'pull') {
        const repoId = Number(decoded.parts[0]);
        const number = Number(decoded.parts[1]);
        const repo = [...forge.reposByName.values()].find((candidate) => candidate.id === repoId);
        const pull = repo?.pulls.get(number);
        if (repo === undefined || pull === undefined) return null;
        return executeSelection(ctx, 'PullRequest', { repo, pull }, selection);
      }
      return null;
    }
    if (name === '__type') {
      const typeArg = argValue(field, 'name', ctx.variables);
      if (typeof typeArg !== 'string') return null;
      return executeSelection(ctx, '__Type', { typeName: typeArg }, selection);
    }
    if (name === '__schema') {
      return executeSelection(ctx, '__Schema', {}, selection);
    }
    return unknownField(ctx, 'Query', field);
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(ctx, field, selection);
    if (name === 'closeIssue') return mutateCloseIssue(ctx, field, selection);
    if (name === 'createPullRequest') return mutateCreatePullRequest(ctx, field, selection);
    if (name === 'mergePullRequest') return mutateMergePullRequest(ctx, field, selection);
    if (name === 'addComment') return mutateAddComment(ctx, field, selection);
    return unknownField(ctx, 'Mutation', field);
  }

  if (typeName === 'Repository') {
    const repo = source as Repo;
    const login = repo.owner === '' ? (forge.viewerLogin ?? 'forge') : repo.owner;
    switch (name) {
      case 'id': return gid('repo', [repo.id]);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${login}/${repo.name}`;
      case 'owner': return executeSelection(ctx, 'User', { login }, selection);
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'url': return `https://example.invalid/${login}/${repo.name}`;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return executeSelection(ctx, 'Ref', { name: repo.defaultBranch }, selection);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const number = argValue(field, 'number', ctx.variables);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        if (issue === undefined) return null;
        return executeSelection(ctx, 'Issue', { repo, issue }, selection);
      }
      case 'issues': return issuesConnection(ctx, repo, field, selection);
      case 'pullRequests': return pullsConnection(ctx, repo, field, selection);
      case 'pullRequest': {
        const number = argValue(field, 'number', ctx.variables);
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        if (pull === undefined) return null;
        return executeSelection(ctx, 'PullRequest', { repo, pull }, selection);
      }
      default: return unknownField(ctx, 'Repository', field);
    }
  }

  if (typeName === 'Issue') {
    const { repo, issue } = source as { repo: Repo; issue: import('./store.ts').Issue };
    switch (name) {
      case 'id': return gid('issue', [repo.id, issue.number]);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issueState(issue.state);
      case 'labels': return issue.labels.map((label) => ({ name: label.name }));
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      case 'author': return executeSelection(ctx, 'User', { login: repo.owner }, selection);
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      default: return unknownField(ctx, 'Issue', field);
    }
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = source as { repo: Repo; pull: Pull };
    switch (name) {
      case 'id': return gid('pull', [repo.id, pull.number]);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pullState(pull);
      case 'merged': return pull.merged;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'mergeable': return forge.pullMergeable(repo, pull);
      case 'createdAt': return pull.createdAt;
      case 'mergedAt': return pull.mergedAt;
      case 'files': {
        const first = argValue(field, 'first', ctx.variables);
        const files = forge.pullFiles(repo, pull).map((change) => ({ path: change.path, additions: change.additions, deletions: change.deletions }));
        const limited = typeof first === 'number' ? files.slice(0, first) : files;
        return executeSelection(ctx, 'PullRequestChangedFileConnection', { nodes: limited }, selection);
      }
      default: return unknownField(ctx, 'PullRequest', field);
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    const { nodes } = source as { nodes: unknown[] };
    switch (name) {
      case 'nodes': {
        const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
        return nodes.map((node) => executeSelection(ctx, itemType, node, selection));
      }
      case 'pageInfo': {
        const pageInfo = (source as { pageInfo?: Record<string, unknown> }).pageInfo;
        if (pageInfo !== undefined) return executeSelection(ctx, 'PageInfo', pageInfo, selection);
        return executeSelection(ctx, 'PageInfo', { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }, selection);
      }
      case 'totalCount': return nodes.length;
      default: return unknownField(ctx, typeName, field);
    }
  }

  if (typeName === 'PullRequestChangedFile') {
    const node = source as { path: string; additions: number; deletions: number };
    switch (name) {
      case 'path': return node.path;
      case 'additions': return node.additions;
      case 'deletions': return node.deletions;
      case 'changeType': return 'MODIFIED';
      default: return unknownField(ctx, 'PullRequestChangedFile', field);
    }
  }

  if (typeName === 'User') {
    const user = source as { login: string };
    switch (name) {
      case 'id': return gid('user', [user.login]);
      case 'login': return user.login;
      case 'name': return user.login;
      case 'email': return `${user.login}@example.invalid`;
      default: return unknownField(ctx, 'User', field);
    }
  }

  if (typeName === 'Ref') {
    const ref = source as { name: string };
    if (name === 'name') return ref.name;
    return unknownField(ctx, 'Ref', field);
  }

  if (typeName === 'PageInfo') {
    const info = source as Record<string, unknown>;
    if (name === 'hasNextPage') return info.hasNextPage ?? false;
    if (name === 'hasPreviousPage') return info.hasPreviousPage ?? false;
    if (name === 'endCursor') return info.endCursor ?? null;
    if (name === 'startCursor') return info.startCursor ?? null;
    return unknownField(ctx, 'PageInfo', field);
  }

  if (typeName === '__Type') {
    const { typeName: target } = source as { typeName: string };
    switch (name) {
      case 'name': return target;
      case 'kind': return TYPE_FIELDS[target] !== undefined ? 'OBJECT' : 'ENUM';
      case 'fields': {
        const names = TYPE_FIELDS[target] ?? [];
        const fields = names.map((fieldName) => ({ name: fieldName }));
        return fields.map((entry) => executeSelection(ctx, '__Field', entry, selection));
      }
      case 'enumValues': {
        if (target !== 'SearchType') return [];
        return SEARCH_ENUMS.map((entry) => executeSelection(ctx, '__EnumValue', { name: entry }, selection));
      }
      default: return unknownField(ctx, '__Type', field);
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    const entry = source as { name: string };
    if (name === 'name') return entry.name;
    return unknownField(ctx, typeName, field);
  }

  if (typeName === '__Schema') {
    if (name === 'types') return [];
    return unknownField(ctx, '__Schema', field);
  }

  return unknownField(ctx, typeName, field);
}

function issuesConnection(ctx: ExecContext, repo: Repo, field: Field, selection: Field[]): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  const states = argValue(field, 'states', ctx.variables);
  const orderBy = argValue(field, 'orderBy', ctx.variables);
  let list = [...repo.issues.values()];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issueState(issue.state)));
  }
  let direction = 'ASC';
  if (isRecord(orderBy) && typeof orderBy.direction === 'string') direction = orderBy.direction;
  if (direction === 'DESC') list.sort((a, b) => b.number - a.number);
  else list.sort((a, b) => a.number - b.number);
  const afterNumber = cursorNumber(after);
  if (afterNumber !== null) {
    list = direction === 'DESC'
      ? list.filter((issue) => issue.number < afterNumber)
      : list.filter((issue) => issue.number > afterNumber);
  }
  const total = list.length;
  const limit = typeof first === 'number' ? first : total;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > limit;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  const nodes = page.map((issue) => ({ repo, issue }));
  return executeSelection(ctx, 'IssueConnection', { nodes, pageInfo: { hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor(page[0]?.number ?? 0) : null } }, selection);
}

function pullsConnection(ctx: ExecContext, repo: Repo, field: Field, selection: Field[]): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.variables);
  const states = argValue(field, 'states', ctx.variables);
  let list = [...repo.pulls.values()];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((pull) => wanted.has(pullState(pull)));
  }
  list.sort((a, b) => b.number - a.number);
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const nodes = page.map((pull) => ({ repo, pull }));
  return executeSelection(ctx, 'PullRequestConnection', { nodes, pageInfo: { hasNextPage: list.length > limit, endCursor: null, hasPreviousPage: false, startCursor: null } }, selection);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inputObject(field: Field, variables: Record<string, unknown>): Record<string, unknown> {
  const input = argValue(field, 'input', variables);
  return isRecord(input) ? input : {};
}

function repoFromGid(ctx: ExecContext, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'repo') return null;
  const repoId = Number(decoded.parts[0]);
  return [...ctx.forge.reposByName.values()].find((candidate) => candidate.id === repoId) ?? null;
}

function mutateCreateIssue(ctx: ExecContext, field: Field, selection: Field[]): unknown {
  const input = inputObject(field, ctx.variables);
  const repo = repoFromGid(ctx, input.repositoryId);
  if (repo === null) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
    return null;
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const created = ctx.forge.createIssue(repo, title, body, []);
  if ('error' in created) {
    ctx.errors.push({ message: created.error });
    return null;
  }
  return executeSelection(ctx, 'CreateIssuePayload', { issue: { repo, issue: created } }, selection);
}

function mutateCloseIssue(ctx: ExecContext, field: Field, selection: Field[]): unknown {
  const input = inputObject(field, ctx.variables);
  const id = typeof input.issueId === 'string' ? input.issueId : '';
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'issue') {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }
  const repo = [...ctx.forge.reposByName.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  const issue = repo?.issues.get(Number(decoded.parts[1]));
  if (repo === undefined || issue === undefined) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }
  ctx.forge.setIssueState(repo, issue, 'closed');
  return executeSelection(ctx, 'CloseIssuePayload', { issue: { repo, issue } }, selection);
}

function mutateCreatePullRequest(ctx: ExecContext, field: Field, selection: Field[]): unknown {
  const input = inputObject(field, ctx.variables);
  const repo = repoFromGid(ctx, input.repositoryId);
  if (repo === null) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
    return null;
  }
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const created = ctx.forge.createPull(repo, head, base, title, body);
  if ('error' in created) {
    ctx.errors.push({ message: created.error });
    return null;
  }
  return executeSelection(ctx, 'CreatePullRequestPayload', { pullRequest: { repo, pull: created } }, selection);
}

function mutateMergePullRequest(ctx: ExecContext, field: Field, selection: Field[]): unknown {
  const input = inputObject(field, ctx.variables);
  const id = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'pull') {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
    return null;
  }
  const repo = [...ctx.forge.reposByName.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  const pull = repo?.pulls.get(Number(decoded.parts[1]));
  if (repo === undefined || pull === undefined) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
    return null;
  }
  const merged = ctx.forge.mergePull(repo, pull);
  if (!merged.ok) {
    ctx.errors.push({ message: merged.reason === 'conflict' ? 'Merge conflict' : merged.reason });
    return executeSelection(ctx, 'MergePullRequestPayload', { pullRequest: { repo, pull } }, selection);
  }
  return executeSelection(ctx, 'MergePullRequestPayload', { pullRequest: { repo, pull } }, selection);
}

function mutateAddComment(ctx: ExecContext, field: Field, selection: Field[]): unknown {
  const input = inputObject(field, ctx.variables);
  const id = typeof input.subjectId === 'string' ? input.subjectId : '';
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'issue') {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }
  const repo = [...ctx.forge.reposByName.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  const issue = repo?.issues.get(Number(decoded.parts[1]));
  const body = typeof input.body === 'string' ? input.body : '';
  if (repo === undefined || issue === undefined) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }
  const comment = ctx.forge.addComment(repo, issue.number, body);
  if (comment === null) {
    ctx.errors.push({ message: 'Could not add a comment to that issue.' });
    return null;
  }
  return executeSelection(ctx, 'AddCommentPayload', { comment: { repo, issue, comment } }, selection);
}

// Payload wrappers: resolveField is called with these synthetic type names.
const PAYLOAD_FIELDS: Record<string, (ctx: ExecContext, source: unknown, field: Field) => unknown> = {
  CreateIssuePayload: (ctx, source, field) => {
    const { issue } = source as { issue: { repo: Repo; issue: import('./store.ts').Issue } };
    if (fieldName(field) === 'issue') return executeSelection(ctx, 'Issue', issue, field.selection ?? []);
    return unknownField(ctx, 'CreateIssuePayload', field);
  },
  CloseIssuePayload: (ctx, source, field) => {
    const { issue } = source as { issue: { repo: Repo; issue: import('./store.ts').Issue } };
    if (fieldName(field) === 'issue') return executeSelection(ctx, 'Issue', issue, field.selection ?? []);
    return unknownField(ctx, 'CloseIssuePayload', field);
  },
  CreatePullRequestPayload: (ctx, source, field) => {
    const { pullRequest } = source as { pullRequest: { repo: Repo; pull: Pull } };
    if (fieldName(field) === 'pullRequest') return executeSelection(ctx, 'PullRequest', pullRequest, field.selection ?? []);
    return unknownField(ctx, 'CreatePullRequestPayload', field);
  },
  MergePullRequestPayload: (ctx, source, field) => {
    const { pullRequest } = source as { pullRequest: { repo: Repo; pull: Pull } };
    if (fieldName(field) === 'pullRequest') return executeSelection(ctx, 'PullRequest', pullRequest, field.selection ?? []);
    return unknownField(ctx, 'MergePullRequestPayload', field);
  },
  AddCommentPayload: (ctx, source, field) => {
    const { comment } = source as { comment: { repo: Repo; issue: import('./store.ts').Issue; comment: import('./store.ts').Comment } };
    if (fieldName(field) === 'commentEdge') {
      return executeSelection(ctx, 'IssueCommentEdge', { node: comment }, field.selection ?? []);
    }
    return unknownField(ctx, 'AddCommentPayload', field);
  },
  IssueCommentEdge: (ctx, source, field) => {
    const { node } = source as { node: { repo: Repo; issue: import('./store.ts').Issue; comment: import('./store.ts').Comment } };
    if (fieldName(field) === 'node') return executeSelection(ctx, 'IssueComment', node, field.selection ?? []);
    return unknownField(ctx, 'IssueCommentEdge', field);
  },
  IssueComment: (ctx, source, field) => {
    const { repo, issue, comment } = source as { repo: Repo; issue: import('./store.ts').Issue; comment: import('./store.ts').Comment };
    if (fieldName(field) === 'id') return gid('comment', [repo.id, issue.number, comment.id]);
    if (fieldName(field) === 'body') return comment.body;
    return unknownField(ctx, 'IssueComment', field);
  },
};

function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { forge, variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, operation.selection);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphql(forge: Forge, body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { errors: [{ message: 'A GraphQL query string is required.' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    let operations: Operation[];
    try {
      operations = new Parser(entry.query).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Could not parse the query.' }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'The document holds no operation.' }] };
    const operation = operations[0]!;
    return executeOperation(forge, operation, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}
