import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
  type GitObj,
} from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Forge, type FileChange, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_AGENT = 'forge/1.0.0';
const UPLOAD_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=${FORGE_AGENT}`;
const RECEIVE_CAPS = `symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=${FORGE_AGENT}`;
const FETCH_CACHE_MAX = 64;

let requestCounter = 0;

/** One JSON reply: a body string, the standard headers, and a request id. */
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': `req-${++requestCounter}`,
    ...extra,
  });
  res.end(buf);
}

/** Send a pre-built JSON buffer (already carrying its trailing newline). */
function sendJsonBuf(res: ServerResponse, status: number, buf: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': `req-${++requestCounter}`,
    ...extra,
  });
  res.end(buf);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Read the request body. A single chunk is used as-is, never copied. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); return; }
      if (first === null && chunks.length === 0) { first = chunk; chunks.push(chunk); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) resolve(Buffer.alloc(0));
      else if (chunks.length === 1) resolve(chunks[0]!);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a pathname into decoded segments, dropping empty parts. */
function splitPath(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part !== '') out.push(decodeSegment(part));
  }
  return out;
}

/** A request's query string, parsed lazily on first use. */
class Query {
  private map: Map<string, string> | null = null;
  private readonly raw: string;

  constructor(raw: string) {
    this.raw = raw;
  }

  get(name: string): string | null {
    if (this.map === null) {
      this.map = new Map<string, string>();
      if (this.raw !== '') {
        for (const pair of this.raw.split('&')) {
          if (pair === '') continue;
          const eq = pair.indexOf('=');
          const key = eq < 0 ? pair : pair.slice(0, eq);
          const value = eq < 0 ? '' : pair.slice(eq + 1);
          try {
            this.map.set(decodeURIComponent(key), decodeURIComponent(value));
          } catch {
            this.map.set(key, value);
          }
        }
      }
    }
    const value = this.map.get(name);
    return value === undefined ? null : value;
  }
}

interface ReqCtx {
  method: string;
  segments: string[];
  pathname: string;
  query: Query;
  host: string;
}

function paginate<T>(items: readonly T[], query: Query): { page: T[]; next: number | null; perPage: number; pageNo: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const pageNo = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNo - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const next = start + perPage < items.length ? pageNo + 1 : null;
  return { page, next, perPage, pageNo };
}

function pageLink(ctx: ReqCtx, next: number | null, perPage: number): Record<string, string> {
  if (next === null) return {};
  const base = `http://${ctx.host}${ctx.pathname}`;
  return { link: `<${base}?per_page=${perPage}&page=${next}>; rel="next"` };
}

export function createApp(forge: Forge, token: string): Server {
  const server = createServer((req, res) => {
    void handleRequest(forge, token, req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // the socket is already gone; nothing left to do
      }
    });
  });
  return server;
}

async function handleRequest(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const qmark = rawUrl.indexOf('?');
  const pathname = qmark < 0 ? rawUrl : rawUrl.slice(0, qmark);
  const ctx: ReqCtx = {
    method: req.method ?? 'GET',
    segments: splitPath(pathname),
    pathname,
    query: new Query(qmark < 0 ? '' : rawUrl.slice(qmark + 1)),
    host: req.headers.host ?? 'localhost',
  };
  const seg = ctx.segments;

  if (seg.length === 1 && seg[0] === 'healthz' && ctx.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (seg.length >= 2 && seg[1]!.endsWith('.git')) {
    const owner = seg[0] ?? '';
    const name = seg[1]!.slice(0, -4);
    const rest = seg.length > 2 ? `/${seg.slice(2).join('/')}` : '';
    await handleGit(forge, req, res, ctx, owner, name, rest);
    return;
  }

  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
    await handleGraphqlRoute(forge, token, req, res);
    return;
  }

  if (seg.length === 1 && seg[0] === 'mcp') {
    await handleMcpRoute(forge, token, req, res);
    return;
  }

  if (seg.length >= 1 && seg[0] === 'api' && (seg.length === 1 || seg[1] === 'v3')) {
    await handleRest(forge, token, req, res, ctx);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function authorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

function bearerMissing(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse, ctx: ReqCtx): Promise<void> {
  const method = ctx.method;
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };

  if (!authorized(req, token)) {
    bearerMissing(res);
    return;
  }

  // Segments below /api/v3 (empty when the path is exactly /api/v3).
  const segments = ctx.segments.length <= 2 ? [] : ctx.segments.slice(2);

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: unknown = {};
  if (needsBody) {
    const bytes = await readBody(req);
    const parsed = parseJsonBody(bytes);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' }, scopes);
      return;
    }
    body = parsed.value;
  }

  const notFound = (message = 'Not Found'): void => sendJson(res, 404, { message }, scopes);
  const repoOf = (owner: string, name: string): Repo | null => forge.findRepo(owner, name);

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') { notFound(); return; }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      meta: '/api/v3/meta',
    }, scopes);
    return;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') { notFound(); return; }
    sendJson(res, 200, { installed_version: '1.0.0', version: '1.0.0' }, scopes);
    return;
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') { notFound(); return; }
    const login = forge.viewerLogin ?? 'forge';
    sendJson(res, 200, { login, id: 1000, type: 'User', html_url: `https://example.invalid/${login}` }, scopes);
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = forge.listRepos().map((repo) => forge.repoJson(repo));
      const { page, next, perPage } = paginate(all, ctx.query);
      sendJson(res, 200, page, { ...scopes, ...pageLink(ctx, next, perPage) });
      return;
    }
    if (method === 'POST') {
      if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
      const name = asString(body.name).trim();
      if (name === '') { sendJson(res, 422, { message: 'Repository name is required' }, scopes); return; }
      const repo = forge.createRepo(name, asString(body.description), asBool(body.private, false));
      if (repo === null) {
        sendJson(res, 422, { message: `Repository '${name}' already exists` }, scopes);
        return;
      }
      sendJson(res, 201, forge.repoJson(repo), scopes);
      return;
    }
    notFound();
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] ?? '';
    const name = segments[2] ?? '';
    const tail = segments.slice(3);
    await handleRepoRoute(forge, req, res, ctx, owner, name, tail, method, body, scopes, notFound, repoOf);
    return;
  }

  notFound();
}

async function handleRepoRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReqCtx,
  owner: string,
  name: string,
  tail: string[],
  method: string,
  body: unknown,
  scopes: Record<string, string>,
  notFound: (message?: string) => void,
  repoOf: (owner: string, name: string) => Repo | null,
): Promise<void> {
  const repo = repoOf(owner, name);
  if (repo === null) { notFound(); return; }
  const login = repo.owner === '' ? (forge.viewerLogin ?? 'forge') : repo.owner;

  // /repos/{o}/{r} itself
  if (tail.length === 0) {
    if (method === 'GET') { sendJsonBuf(res, 200, forge.repoJsonBuf(repo), scopes); return; }
    if (method === 'PATCH') {
      if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      forge.touch(repo);
      sendJson(res, 200, forge.repoJson(repo), scopes);
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(name);
      res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    notFound();
    return;
  }

  const head = tail[0] ?? '';

  // branches
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => forge.branchJson(repo, branch, repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID));
      sendJson(res, 200, branches, scopes);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (sha === undefined) { notFound(); return; }
      sendJson(res, 200, forge.branchJson(repo, tail[1] ?? '', sha), scopes);
      return;
    }
    notFound();
    return;
  }

  // commits
  if (head === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, ref);
      if (tip === null) { sendJson(res, 200, [], scopes); return; }
      const commits = forge.commitList(repo, tip)
        .map((sha) => forge.commitJson(repo, sha))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      sendJson(res, 200, commits, scopes);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const entry = forge.commitJson(repo, tail[1] ?? '');
      if (entry === null) { notFound(); return; }
      sendJson(res, 200, entry, scopes);
      return;
    }
    notFound();
    return;
  }

  // git data: refs
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) { sendJson(res, 422, { message: 'Invalid ref' }, scopes); return; }
      if (!isOid(sha) || repo.objects.get(sha) === undefined) { sendJson(res, 422, { message: 'Invalid sha' }, scopes); return; }
      if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }, scopes); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${login}/${name}/git/${ref}` } }, scopes);
      return;
    }
    if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${tail[3]}`);
      if (sha === undefined) { notFound(); return; }
      sendJson(res, 200, { ref: `refs/heads/${tail[3]}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }, scopes);
      return;
    }
    if (method === 'GET' && tail.length === 4 && tail[2] === 'tags') {
      const sha = repo.refs.get(`refs/tags/${tail[3]}`);
      if (sha === undefined) { notFound(); return; }
      sendJson(res, 200, { ref: `refs/tags/${tail[3]}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'tag' } }, scopes);
      return;
    }
    notFound();
    return;
  }

  // contents
  if (head === 'contents') {
    const filePath = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, ref);
      if (tip === null) { notFound(); return; }
      const tree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
      if (tree === '') { notFound(); return; }
      const entry = lookupPath(repo, tree, filePath);
      if (entry === null) { notFound(); return; }
      if (entry.kind === 'dir') {
        const listing = listDirectory(repo, entry.oid, filePath).map((item) => contentEntryJson(repo, item, filePath));
        sendJson(res, 200, listing, scopes);
        return;
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) { notFound(); return; }
      sendJson(res, 200, fileContentJson(repo, filePath, entry.oid, blob.data), scopes);
      return;
    }
    if (method === 'PUT') {
      if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
      const content = asString(body.content);
      const message = asString(body.message, 'Update file');
      const branch = asString(body.branch, repo.defaultBranch);
      const data = Buffer.from(content, 'base64');
      const branchRef = `refs/heads/${branch}`;
      let tip = repo.refs.get(branchRef);
      if (tip === undefined && branch !== repo.defaultBranch) {
        const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (baseTip !== undefined) tip = baseTip;
      }
      let files = new Map<string, { mode: string; oid: string }>();
      let parent: string | null = null;
      if (tip !== undefined) {
        parent = tip;
        const tree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        if (tree !== '') files = forge.flattenTree(repo, tree);
      }
      const existing = files.get(filePath);
      const givenSha = asString(body.sha);
      if (givenSha !== '') {
        if (existing === undefined || existing.oid.toLowerCase() !== givenSha.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current file' }, scopes);
          return;
        }
      }
      const isUpdate = existing !== undefined;
      const blobOid = hashObject('blob', data);
      if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data });
      files.set(filePath, { mode: '100644', oid: blobOid });
      const commitSha = forge.makeCommit(repo, parent, files, message);
      repo.refs.set(branchRef, commitSha);
      const answer = {
        content: fileContentJson(repo, filePath, blobOid, data),
        commit: { sha: commitSha, message },
      };
      sendJson(res, isUpdate ? 200 : 201, answer, scopes);
      return;
    }
    if (method === 'DELETE') {
      if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
      const message = asString(body.message, 'Delete file');
      const branch = asString(body.branch, repo.defaultBranch);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) { notFound(); return; }
      const tree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
      const files = tree === '' ? new Map<string, { mode: string; oid: string }>() : forge.flattenTree(repo, tree);
      const existing = files.get(filePath);
      if (existing === undefined) { notFound(); return; }
      const givenSha = asString(body.sha);
      if (givenSha !== '' && existing.oid.toLowerCase() !== givenSha.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current file' }, scopes);
        return;
      }
      files.delete(filePath);
      const commitSha = forge.makeCommit(repo, tip, files, message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, 200, { commit: { sha: commitSha, message } }, scopes);
      return;
    }
    notFound();
    return;
  }

  // labels
  if (head === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => forge.labelJson(label)), scopes);
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
      const name = asString(body.name).trim();
      if (name === '') { sendJson(res, 422, { message: 'Label name is required' }, scopes); return; }
      let label = repo.labels.get(name);
      if (label === undefined) {
        label = { id: repo.nextLabelId++, name, color: asString(body.color, 'ededed'), description: asString(body.description) };
        repo.labels.set(name, label);
      }
      sendJson(res, 201, forge.labelJson(label), scopes);
      return;
    }
    notFound();
    return;
  }

  // issues
  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page, next, perPage } = paginate(list.map((issue) => forge.issueJson(repo, issue)), ctx.query);
        sendJson(res, 200, page, { ...scopes, ...pageLink(ctx, next, perPage) });
        return;
      }
      if (method === 'POST') {
        if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
        const title = asString(body.title).trim();
        if (title === '') { sendJson(res, 422, { message: 'Issue title is required' }, scopes); return; }
        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const entry of body.labels) {
            if (typeof entry === 'string') labelNames.push(entry);
            else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
          }
        }
        const issue = forge.createIssue(repo, title, asString(body.body), labelNames);
        if ('error' in issue) { sendJson(res, 422, { message: issue.error }, scopes); return; }
        sendJson(res, 201, forge.issueJson(repo, issue), scopes);
        return;
      }
      notFound();
      return;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) { notFound(); return; }
    const issue = repo.issues.get(number);
    if (tail.length === 2) {
      if (issue === undefined) { notFound(); return; }
      if (method === 'GET') { sendJsonBuf(res, 200, forge.issueJsonBuf(repo, issue), scopes); return; }
      if (method === 'PATCH') {
        if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') {
          forge.setIssueState(repo, issue, body.state);
        }
        forge.touch(repo);
        sendJson(res, 200, forge.issueJson(repo, issue), scopes);
        return;
      }
      notFound();
      return;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) { notFound(); return; }
      if (method === 'GET') {
        const comments = (repo.comments.get(number) ?? []).map((comment) => forge.commentJson(repo, issue, comment));
        sendJson(res, 200, comments, scopes);
        return;
      }
      if (method === 'POST') {
        if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
        const comment = forge.addComment(repo, number, asString(body.body));
        if (comment === null) { notFound(); return; }
        sendJson(res, 201, forge.commentJson(repo, issue, comment), scopes);
        return;
      }
      notFound();
      return;
    }
    notFound();
    return;
  }

  // pulls
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.number - a.number);
        const { page, next, perPage } = paginate(list.map((pull) => forge.pullJson(repo, pull)), ctx.query);
        sendJson(res, 200, page, { ...scopes, ...pageLink(ctx, next, perPage) });
        return;
      }
      if (method === 'POST') {
        if (!isRecord(body)) { sendJson(res, 400, { message: 'Invalid body' }, scopes); return; }
        const title = asString(body.title).trim();
        if (title === '') { sendJson(res, 422, { message: 'Pull request title is required' }, scopes); return; }
        const headRef = asString(body.head).split(':').pop() ?? '';
        const baseRef = asString(body.base).split(':').pop() ?? '';
        const pull = forge.createPull(repo, headRef, baseRef, title, asString(body.body));
        if ('error' in pull) { sendJson(res, 422, { message: pull.error }, scopes); return; }
        sendJson(res, 201, forge.pullJson(repo, pull), scopes);
        return;
      }
      notFound();
      return;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) { notFound(); return; }
    const pull = repo.pulls.get(number);
    if (tail.length === 2) {
      if (pull === undefined) { notFound(); return; }
      if (method === 'GET') { sendJson(res, 200, forge.pullJson(repo, pull), scopes); return; }
      notFound();
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pull === undefined) { notFound(); return; }
      const files = forge.pullFiles(repo, pull).map((file: FileChange) => ({
        sha: file.newOid ?? file.oldOid ?? ZERO_OID,
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
      }));
      sendJson(res, 200, files, scopes);
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) { notFound(); return; }
      if (pull.merged) { sendJson(res, 405, { message: 'Pull request already merged' }, scopes); return; }
      const merged = forge.mergePull(repo, pull);
      if (!merged.ok) {
        sendJson(res, 405, { message: merged.reason === 'conflict' ? 'Merge conflict' : merged.reason }, scopes);
        return;
      }
      sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} successfully merged` }, scopes);
      return;
    }
    notFound();
    return;
  }

  notFound();
}

function contentEntryJson(repo: Repo, item: { mode: string; name: string; oid: string }, parentPath: string): Record<string, unknown> {
  const path = parentPath === '' ? item.name : `${parentPath}/${item.name}`;
  const isDir = item.mode === '40000';
  const blob = isDir ? null : repo.objects.get(item.oid);
  return {
    type: isDir ? 'dir' : 'file',
    name: item.name,
    path,
    sha: item.oid,
    size: blob === null ? 0 : blob.data.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

function fileContentJson(repo: Repo, path: string, oid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

function lookupPath(repo: Repo, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string } | null {
  if (path === '') return { kind: 'dir', oid: treeOid };
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) {
      return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function listDirectory(repo: Repo, treeOid: string, _path: string): Array<{ mode: string; name: string; oid: string }> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

// ---------------------------------------------------------------------------
// GraphQL / MCP routes
// ---------------------------------------------------------------------------

async function handleGraphqlRoute(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authorized(req, token)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return;
  }
  const answer = handleGraphql(forge, parsed.value);
  sendJson(res, answer.status, answer.body);
}

async function handleMcpRoute(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const raw = await readBody(req);
  const answer = handleMcp(forge, token, req.headers.authorization ?? '', raw);
  if (answer.empty) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendJson(res, answer.status, answer.body);
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const refs = sortedRefs(repo);
  const main = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${main} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') { current = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${FORGE_AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

interface FetchPlan {
  toSend: Set<string>;
  shallowOut: string[];
  unshallowOut: string[];
  acks: string[];
}

/** Work out what a fetch must send, given wants, haves, shallow lines and a depth. */
function planFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  const objects = repo.objects;
  const shallowSet = new Set(shallowIn);

  const expandRoots = (roots: string[], limit: number | null, respectShallow: boolean): { commits: Map<string, number>; objects: Set<string> } => {
    const commits = new Map<string, number>();
    const queue: Array<{ oid: string; generation: number }> = [];
    const included = new Set<string>();
    let head = 0;
    const pushCommit = (oid: string, generation: number): void => {
      if (commits.has(oid)) return;
      const obj = objects.get(oid);
      if (obj === undefined) return;
      if (obj.type === 'tag') {
        included.add(oid);
        const target = parseTag(obj.data).object;
        queue.push({ oid: target, generation });
        return;
      }
      if (obj.type !== 'commit') { included.add(oid); return; }
      commits.set(oid, generation);
      queue.push({ oid, generation });
    };
    for (const root of roots) pushCommit(root, 1);
    while (head < queue.length) {
      const current = queue[head++]!;
      const obj = objects.get(current.oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      included.add(current.oid);
      included.add(view.tree);
      const addTree = (treeOid: string): void => {
        const treeObj = objects.get(treeOid);
        if (treeObj === undefined || treeObj.type !== 'tree') return;
        included.add(treeOid);
        for (const entry of parseTree(treeObj.data)) {
          if (entry.mode === '40000') addTree(entry.oid);
          else included.add(entry.oid);
        }
      };
      addTree(view.tree);
      if (limit !== null && current.generation >= limit) continue;
      // A shallow boundary only cuts the side the client already holds:
      // the wanted side must walk straight through it, or a deepen could
      // never reach the parent it is asking for.
      if (respectShallow && shallowSet.has(current.oid)) continue;
      for (const parent of view.parents) pushCommit(parent, current.generation + 1);
    }
    return { commits, objects: included };
  };

  // Depth limits only the wanted side; what the client already holds is
  // always its full reachable graph, cut at its shallow boundaries.
  const want = expandRoots(wants, depth, false);
  const held = expandRoots(haves, null, true);
  const toSend = new Set<string>();
  for (const oid of want.objects) if (!held.objects.has(oid)) toSend.add(oid);
  for (const oid of want.commits.keys()) if (!held.objects.has(oid)) toSend.add(oid);

  const union = new Set([...want.commits.keys(), ...held.commits.keys()]);
  const shallowOut: string[] = [];
  for (const [oid, generation] of want.commits) {
    if (!toSend.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const cut = parents.some((parent) => !union.has(parent));
    if (cut || (depth !== null && generation >= depth)) shallowOut.push(oid);
  }
  const unshallowOut: string[] = [];
  for (const boundary of shallowIn) {
    if (!union.has(boundary)) continue;
    const obj = objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((parent) => union.has(parent))) unshallowOut.push(boundary);
  }
  // The full wanted graph is only needed to answer which haves the server
  // can acknowledge; with no haves there is nothing to acknowledge, so the
  // walk is skipped entirely.
  let acks: string[] = [];
  if (haves.length > 0) {
    const fullWant = expandRoots(wants, null, false);
    acks = haves.filter((have) => fullWant.commits.has(have) || fullWant.objects.has(have));
  }
  return { toSend, shallowOut, unshallowOut, acks };
}

function packFor(repo: Repo, oids: Set<string>): Buffer {
  const list = [...oids].sort().map((oid) => repo.objects.get(oid)).filter((obj): obj is GitObj => obj !== undefined);
  return writePack(list);
}

async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReqCtx,
  owner: string,
  name: string,
  rest: string,
): Promise<void> {
  const method = ctx.method;
  const repo = forge.findRepo(owner, name);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  forge.claimOwner(owner);

  if (method === 'GET' && rest === '/info/refs') {
    const service = ctx.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, v0Advertisement(repo, service), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, v0Advertisement(repo, service), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: 'Unknown service' });
    return;
  }

  if (method === 'POST' && rest === '/git-upload-pack') {
    const raw = await readBody(req);
    let packets;
    try {
      packets = decodePktLines(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad pkt-line');
      return;
    }
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const answer = isV2 ? serveFetchV2(repo, packets) : serveFetchV0(repo, packets);
      sendBuffer(res, 200, answer, 'application/x-git-upload-pack-result');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    }
    return;
  }

  if (method === 'POST' && rest === '/git-receive-pack') {
    const raw = await readBody(req);
    try {
      const answer = serveReceivePack(forge, repo, raw);
      sendBuffer(res, 200, answer, 'application/x-git-receive-pack-result');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function serveFetchV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') { afterDelim = true; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  if (command === 'ls-refs') return serveLsRefs(repo, args);
  if (command === 'fetch') return serveFetch(repo, args, true);
  throw new Error(`unknown v2 command ${command}`);
}

function serveLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (refName: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => refName.startsWith(prefix));
  const lines: string[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (keep('HEAD')) {
    if (main !== undefined) {
      lines.push(`${main} HEAD${wantSymrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD${wantSymrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (wantPeel && obj !== undefined && obj.type === 'tag') {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function parseFetchArgs(args: string[]): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

function serveFetch(repo: Repo, args: string[], v2: boolean): Buffer {
  const { wants, haves, shallow, depth } = parseFetchArgs(args);
  const cacheKey = `${v2 ? '2' : '0'}|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = packFor(repo, plan.toSend);
  let answer: Buffer;
  if (!v2) {
    const parts: Buffer[] = [];
    for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    if (plan.acks.length > 0) {
      for (const oid of plan.acks) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(sidebandWrap(pack, 1));
    parts.push(pktFlush);
    answer = Buffer.concat(parts);
  } else {
    const sections: Buffer[] = [];
    sections.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const oid of plan.acks) sections.push(pktLine(`ACK ${oid}\n`));
      sections.push(pktLine('ready\n'));
    } else {
      sections.push(pktLine('NAK\n'));
    }
    sections.push(pktDelim);
    if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
      sections.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallowOut) sections.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallowOut) sections.push(pktLine(`unshallow ${oid}\n`));
      sections.push(pktDelim);
    }
    sections.push(pktLine('packfile\n'));
    sections.push(sidebandWrap(pack, 1));
    sections.push(pktFlush);
    answer = Buffer.concat(sections);
  }
  // Cache only when every named oid already exists: a later push could
  // otherwise change what the same request must answer.
  const allKnown = wants.every((oid) => repo.objects.has(oid))
    && haves.every((oid) => repo.objects.has(oid))
    && shallow.every((oid) => repo.objects.has(oid));
  if (allKnown) {
    if (repo.fetchCache.size >= FETCH_CACHE_MAX) {
      const oldest = repo.fetchCache.keys().next().value;
      if (oldest !== undefined) repo.fetchCache.delete(oldest);
    }
    repo.fetchCache.set(cacheKey, answer);
  }
  return answer;
}

function serveFetchV0(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') continue;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'done') continue;
    args.push(line);
  }
  return serveFetch(repo, args, false);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function serveReceivePack(forge: Forge, repo: Repo, raw: Buffer): Buffer {
  const packets = decodePktLines(raw.subarray(0, findPackStart(raw)));
  const commands: PushCommand[] = [];
  let capabilities = '';
  let unpackOk = true;
  let unpackDetail = 'ok';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0 && capabilities === '') capabilities = text.slice(nul + 1);
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error('bad receive-pack command');
    commands.push({ oldOid: parts[0] ?? '', newOid: parts[1] ?? '', ref: parts.slice(2).join(' ') });
  }
  const packStart = findPackStart(raw);
  if (packStart < raw.length) {
    try {
      const objects = readPack(raw.subarray(packStart));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    }
  }
  const report: string[] = [`unpack ${unpackDetail}\n`];
  const sideband = capabilities.includes('side-band-64k');
  for (const command of commands) {
    const verdict = applyPush(forge, repo, command, unpackOk);
    report.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
  }
  const reportBytes = encodePktLines(report);
  if (sideband) {
    return Buffer.concat([sidebandWrap(reportBytes, 1), pktFlush]);
  }
  return Buffer.concat([reportBytes, pktFlush]);
}

/** The offset where the packfile starts: just past the first flush pkt-line. */
function findPackStart(raw: Buffer): number {
  let at = 0;
  while (at + 4 <= raw.length) {
    const text = raw.subarray(at, at + 4).toString('ascii');
    if (!isHex4Text(text)) return at;
    const len = parseInt(text, 16);
    if (len === 0) return at + 4;
    if (len < 4 || at + len > raw.length) return raw.length;
    at += len;
  }
  return raw.length;
}

function isHex4Text(text: string): boolean {
  if (text.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    const code = text.charCodeAt(i);
    const hex = (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
    if (!hex) return false;
  }
  return true;
}

function applyPush(forge: Forge, repo: Repo, command: PushCommand, unpackOk: boolean): { ok: boolean; reason: string } {
  if (!unpackOk) return { ok: false, reason: 'unpacker error' };
  if (!isOid(command.oldOid) || !isOid(command.newOid)) return { ok: false, reason: 'invalid oid' };
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'old oid does not match' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const obj = repo.objects.get(command.newOid);
  if (obj === undefined) return { ok: false, reason: 'missing object' };
  if (command.ref.startsWith('refs/heads/') && obj.type !== 'commit') return { ok: false, reason: 'not a commit' };
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    noteNewCommits(forge, repo, command.newOid);
    return { ok: true, reason: '' };
  }
  if (current === undefined) return { ok: false, reason: 'ref does not exist' };
  if (command.oldOid !== current) return { ok: false, reason: 'old oid does not match' };
  if (obj.type === 'commit' && !isAncestor(repo.objects, command.newOid, command.oldOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  noteNewCommits(forge, repo, command.newOid);
  return { ok: true, reason: '' };
}

/**
 * Give pushed commits creation-order numbers and display messages. A commit
 * already numbered has all its ancestors numbered too (numbering always
 * covers a commit's whole reachable graph), so the walk stops there: a push
 * onto a long chain only visits its new commits.
 */
function noteNewCommits(forge: Forge, repo: Repo, tip: string): void {
  const seen = new Set<string>();
  const stack = [tip];
  const ordered: string[] = [];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (repo.commitSeq.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    ordered.push(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  for (const oid of ordered.reverse()) {
    if (!repo.commitSeq.has(oid)) {
      repo.commitSeq.set(oid, forge.nextStamp());
      const view = parseCommit(repo.objects.get(oid)!.data);
      repo.commitMessage.set(oid, view.message.replace(/\n$/, ''));
    }
  }
}
