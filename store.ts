import {
  ZERO_OID,
  buildCommitBytes,
  buildTree,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  reachableObjects,
  storeObject,
  type GitObj,
  type ObjType,
} from './gitproto.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Serialized issue JSON (with trailing newline), valid while jsonVersion matches the repo's. */
  jsonBuf: Buffer | null;
  jsonVersion: number;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  commitSeq: Map<string, number>;
  commitMessage: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  comments: Map<number, Comment[]>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextLabelId: number;
  nextCommentId: number;
  /** How many issues are open right now; kept exact so repoJson never scans. */
  openCount: number;
  createdAt: string;
  seq: number;
  /** Bumped by every mutation that can change a served JSON shape. */
  version: number;
  /** Serialized repo JSON (with trailing newline), valid while repoVersion matches. */
  repoJsonBuf: Buffer | null;
  repoJsonVersion: number;
  /**
   * Complete fetch responses (upload-pack v0/v2), keyed by the request that
   * produced them. Sound because a fetch answer depends only on the wanted,
   * held and shallow oids plus the depth, and on objects that are never
   * mutated or removed; the cache lives on the repo, so deleting the repo
   * drops it. Only filled when every oid the request names already exists.
   */
  fetchCache: Map<string, Buffer>;
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function gid(kind: string, parts: Array<string | number>): string {
  return b64encode([kind, ...parts.map(String)].join(':'));
}

export function decodeGid(value: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (kind === undefined || parts.length === 0) return null;
    if (!/^[A-Za-z]+$/.test(kind)) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function countLines(data: Buffer | null): number {
  if (data === null || data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** A tiny line diff: added lines are those in `next` beyond the shared prefix/suffix. */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData !== null && newData !== null && oldData.equals(newData)) return { additions: 0, deletions: 0 };
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldData !== null && oldData.length > 0 && oldData.toString('utf8').endsWith('\n')) oldLines.pop();
  if (newData !== null && newData.length > 0 && newData.toString('utf8').endsWith('\n')) newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

export class Forge {
  viewerLogin: string | null = null;
  reposByName = new Map<string, Repo>();
  nextRepoId = 1;
  nextRepoSeq = 1;
  clock = 1_700_000_000;
  private lastIsoStamp = -1;
  private lastIsoText = '';

  /** A deterministic clock: every stamp comes from this counter, never the wall. */
  nextStamp(): number {
    this.clock += 1;
    return this.clock;
  }

  iso(stamp: number): string {
    if (stamp === this.lastIsoStamp) return this.lastIsoText;
    const text = new Date(stamp * 1000).toISOString();
    this.lastIsoStamp = stamp;
    this.lastIsoText = text;
    return text;
  }

  identity(): string {
    const login = this.viewerLogin ?? 'forge';
    return `${login} <${login}@example.invalid>`;
  }

  /** Learn the token owner's login from the first owner that names a repo. */
  claimOwner(owner: string): void {
    if (this.viewerLogin === null) this.viewerLogin = owner;
  }

  /** Whether `owner` is the token owner's login (or still unknown). */
  ownerMatches(owner: string): boolean {
    return this.viewerLogin === null || this.viewerLogin === owner;
  }

  /** Mark a repo changed, so every cached JSON of it is rebuilt on next use. */
  touch(repo: Repo): void {
    repo.version += 1;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.reposByName.has(name)) return null;
    const stamp = this.nextStamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewerLogin ?? '',
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      commitSeq: new Map(),
      commitMessage: new Map(),
      labels: new Map(),
      issues: new Map(),
      comments: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextLabelId: 1,
      nextCommentId: 1,
      openCount: 0,
      createdAt: this.iso(stamp),
      seq: this.nextRepoSeq++,
      version: 0,
      repoJsonBuf: null,
      repoJsonVersion: -1,
      fetchCache: new Map(),
    };
    this.reposByName.set(name, repo);
    return repo;
  }

  /** Find a repo by name, honouring the owner rule (another owner is never this token's). */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.reposByName.get(name);
    if (repo === undefined) return null;
    if (repo.owner !== '' && repo.owner !== owner) return null;
    if (repo.owner === '') {
      if (this.viewerLogin !== null && this.viewerLogin !== owner) return null;
      repo.owner = owner;
      this.claimOwner(owner);
    }
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.reposByName.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.seq - b.seq);
  }

  // ------------------------------------------------------------------ git data

  objectType(repo: Repo, oid: string): ObjType | null {
    return repo.objects.get(oid)?.type ?? null;
  }

  /** Flatten a tree into path -> {mode, oid} for every blob below it. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, base: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) the tree for a flat file map, returning its root oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) { sub = new Map(); dirs.set(dir, sub); }
          sub.set(path, file);
        }
      }
      for (const dir of dirs.keys()) {
        const childPrefix = prefix === '' ? `${dir}/` : `${prefix}${dir}/`;
        const oid = buildLevel(childPrefix);
        entries.push({ mode: '40000', name: dir, oid });
      }
      const data = buildTree(entries);
      return storeObject(repo.objects, 'tree', data);
    };
    return buildLevel('');
  }

  /** Create a commit object on top of `parent` with the given file map. */
  makeCommit(repo: Repo, parent: string | null, files: Map<string, { mode: string; oid: string }>, message: string): string {
    const treeOid = this.buildTreeFromFiles(repo, files);
    const stamp = this.nextStamp();
    const who = `${this.identity()} ${stamp} +0000`;
    const data = buildCommitBytes({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      author: who,
      committer: who,
      message,
    });
    const oid = storeObject(repo.objects, 'commit', data);
    repo.commitSeq.set(oid, this.nextStamp());
    repo.commitMessage.set(oid, message);
    return oid;
  }

  /** The commit object ids reachable from `tip`, newest first by creation order. */
  commitList(repo: Repo, tip: string): string[] {
    const reached = reachableObjects(repo.objects, [tip]);
    const commits: string[] = [];
    for (const oid of reached) if (repo.objects.get(oid)?.type === 'commit') commits.push(oid);
    commits.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
    return commits;
  }

  /** Resolve a branch name, a ref, or a raw commit id to a commit id. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) return repo.objects.get(ref)?.type === 'commit' ? ref : null;
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct;
    const headed = repo.refs.get(`refs/heads/${ref}`);
    if (headed !== undefined) return headed;
    return null;
  }

  /** Peel a tag object down to its commit, following nested tags. */
  peelToCommit(repo: Repo, oid: string): string | null {
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

  /** Diff two trees into a file-change list. */
  diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
    const base = baseTree === ZERO_OID ? new Map() : this.flattenTree(repo, baseTree);
    const head = headTree === ZERO_OID ? new Map() : this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry === undefined && newEntry !== undefined) {
        const data = repo.objects.get(newEntry.oid)?.data ?? null;
        changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: countLines(data), deletions: 0 });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        const data = repo.objects.get(oldEntry.oid)?.data ?? null;
        changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: countLines(data) });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
        const newData = repo.objects.get(newEntry.oid)?.data ?? null;
        const counts = lineDiff(oldData, newData);
        changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions: counts.additions, deletions: counts.deletions });
      }
    }
    return changes;
  }

  // ------------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `Label '${name}' does not exist` };
      labels.push(label);
    }
    const stamp = this.nextStamp();
    const issue: Issue = {
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels,
      createdAt: this.iso(stamp),
      updatedAt: this.iso(stamp),
      closedAt: null,
      jsonBuf: null,
      jsonVersion: -1,
    };
    repo.issues.set(issue.number, issue);
    repo.openCount += 1;
    this.touch(repo);
    return issue;
  }

  /**
   * Move an issue between open and closed. The open counter moves only on
   * a real transition; closedAt is re-stamped on every close, matching the
   * PATCH handler's old behaviour.
   */
  setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): void {
    if (issue.state === 'open' && state === 'closed') repo.openCount -= 1;
    if (issue.state === 'closed' && state === 'open') repo.openCount += 1;
    issue.state = state;
    issue.closedAt = state === 'closed' ? this.iso(this.nextStamp()) : null;
    this.touch(repo);
  }

  addComment(repo: Repo, number: number, body: string): Comment | null {
    if (!repo.issues.has(number)) return null;
    const stamp = this.nextStamp();
    const comment: Comment = { id: repo.nextCommentId++, body, createdAt: this.iso(stamp) };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    this.touch(repo);
    return comment;
  }

  // ------------------------------------------------------------------ pulls

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) return { error: `Head branch '${headRef}' does not exist` };
    if (baseSha === undefined) return { error: `Base branch '${baseRef}' does not exist` };
    const stamp = this.nextStamp();
    const pull: Pull = {
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdAt: this.iso(stamp),
    };
    repo.pulls.set(pull.number, pull);
    this.touch(repo);
    return pull;
  }

  pullHeadSha(repo: Repo, pull: Pull): string {
    return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  }

  pullBaseSha(repo: Repo, pull: Pull): string {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    const headTree = repo.objects.get(headSha)?.type === 'commit' ? parseCommit(repo.objects.get(headSha)!.data).tree : ZERO_OID;
    const baseTree = repo.objects.get(baseSha)?.type === 'commit' ? parseCommit(repo.objects.get(baseSha)!.data).tree : ZERO_OID;
    return this.diffTrees(repo, baseTree, headTree);
  }

  /** MERGEABLE when the three-way merge of head onto base has no conflicting path. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    const base = mergeBase(repo.objects, headSha, baseSha);
    if (base === null) return 'CONFLICTING';
    const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    const tipTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const ancestorFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const tipFiles = this.flattenTree(repo, tipTree);
    const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.oid ?? null;
      const h = headFiles.get(path)?.oid ?? null;
      const t = tipFiles.get(path)?.oid ?? null;
      const headChanged = h !== a;
      const tipChanged = t !== a;
      if (headChanged && tipChanged && h !== t) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
    if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'already merged' };
    if (this.pullMergeable(repo, pull) === 'CONFLICTING') return { ok: false, reason: 'conflict' };
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    const base = mergeBase(repo.objects, headSha, baseSha);
    const baseTree = base === null ? '' : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    const tipTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const ancestorFiles = baseTree === '' ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const tipFiles = this.flattenTree(repo, tipTree);
    const merged = new Map(tipFiles);
    const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.oid ?? null;
      const h = headFiles.get(path)?.oid ?? null;
      if (h === a) continue;
      if (h === null) merged.delete(path);
      else merged.set(path, headFiles.get(path)!);
    }
    const message = `Merge pull request #${pull.number}: ${pull.title}`;
    const sha = this.makeCommit(repo, baseSha, merged, message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const stamp = this.nextStamp();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.iso(stamp);
    pull.mergeCommitSha = sha;
    this.touch(repo);
    return { ok: true, sha };
  }

  // ------------------------------------------------------------------ shapes

  /** The login a JSON shape names for this repo; null while it is still unknown. */
  loginOf(repo: Repo): string | null {
    if (repo.owner !== '') return repo.owner;
    return this.viewerLogin;
  }

  repoJson(repo: Repo): Record<string, unknown> {
    const login = repo.owner === '' ? (this.viewerLogin ?? 'forge') : repo.owner;
    return {
      id: repo.id,
      node_id: gid('repo', [repo.id]),
      name: repo.name,
      full_name: `${login}/${repo.name}`,
      owner: { login, id: 1000, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://example.invalid/${login}/${repo.name}`,
      url: `/api/v3/repos/${login}/${repo.name}`,
      created_at: repo.createdAt,
      updated_at: repo.createdAt,
      pushed_at: repo.createdAt,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      fork: false,
      archived: false,
      disabled: false,
      visibility: repo.isPrivate ? 'private' : 'public',
      open_issues_count: repo.openCount,
      watchers_count: 0,
      stargazers_count: 0,
      forks_count: 0,
      license: null,
      topics: [],
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    };
  }

  /** Serialized repo JSON as one buffer (trailing newline included), cached while the repo is unchanged. */
  repoJsonBuf(repo: Repo): Buffer {
    if (this.loginOf(repo) === null) return Buffer.from(`${JSON.stringify(this.repoJson(repo))}\n`, 'utf8');
    if (repo.repoJsonBuf !== null && repo.repoJsonVersion === repo.version) return repo.repoJsonBuf;
    const buf = Buffer.from(`${JSON.stringify(this.repoJson(repo))}\n`, 'utf8');
    repo.repoJsonBuf = buf;
    repo.repoJsonVersion = repo.version;
    return buf;
  }

  labelJson(label: Label): Record<string, unknown> {
    return { id: label.id, node_id: gid('label', [label.id]), name: label.name, color: label.color, description: label.description, default: false };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    const login = repo.owner === '' ? (this.viewerLogin ?? 'forge') : repo.owner;
    return {
      id: repo.id * 1_000_000 + issue.number,
      node_id: gid('issue', [repo.id, issue.number]),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => this.labelJson(label)),
      user: { login, id: 1000, type: 'User' },
      assignees: [],
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      comments: (repo.comments.get(issue.number) ?? []).length,
      html_url: `https://example.invalid/${login}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
      repository_url: `/api/v3/repos/${login}/${repo.name}`,
    };
  }

  /** Serialized issue JSON as one buffer (trailing newline included), cached while the repo is unchanged. */
  issueJsonBuf(repo: Repo, issue: Issue): Buffer {
    if (this.loginOf(repo) === null) return Buffer.from(`${JSON.stringify(this.issueJson(repo, issue))}\n`, 'utf8');
    if (issue.jsonBuf !== null && issue.jsonVersion === repo.version) return issue.jsonBuf;
    const buf = Buffer.from(`${JSON.stringify(this.issueJson(repo, issue))}\n`, 'utf8');
    issue.jsonBuf = buf;
    issue.jsonVersion = repo.version;
    return buf;
  }

  commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
    const login = repo.owner === '' ? (this.viewerLogin ?? 'forge') : repo.owner;
    return {
      id: comment.id,
      node_id: gid('comment', [repo.id, issue.number, comment.id]),
      body: comment.body,
      user: { login, id: 1000, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
      html_url: `https://example.invalid/${login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    };
  }

  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    const login = repo.owner === '' ? (this.viewerLogin ?? 'forge') : repo.owner;
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    const files = pull.state === 'open' ? this.pullFiles(repo, pull) : [];
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return {
      id: repo.id * 1_000_000 + pull.number,
      node_id: gid('pull', [repo.id, pull.number]),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      mergeable: pull.state === 'open' ? this.pullMergeable(repo, pull) === 'MERGEABLE' : null,
      mergeable_state: pull.state === 'open' ? (this.pullMergeable(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown',
      head: { label: `${login}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: { login, id: 1000, type: 'User' }, repo: { id: repo.id, name: repo.name, full_name: `${login}/${repo.name}` } },
      base: { label: `${login}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: { login, id: 1000, type: 'User' }, repo: { id: repo.id, name: repo.name, full_name: `${login}/${repo.name}` } },
      user: { login, id: 1000, type: 'User' },
      created_at: pull.createdAt,
      updated_at: pull.createdAt,
      closed_at: pull.mergedAt,
      draft: false,
      commits: 1,
      additions,
      deletions,
      changed_files: files.length,
      html_url: `https://example.invalid/${login}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
    };
  }

  branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
    const login = repo.owner === '' ? (this.viewerLogin ?? 'forge') : repo.owner;
    return {
      name,
      commit: { sha, url: `/api/v3/repos/${login}/${repo.name}/commits/${sha}` },
      protected: false,
    };
  }

  commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return null;
    const view = parseCommit(obj.data);
    const login = repo.owner === '' ? (this.viewerLogin ?? 'forge') : repo.owner;
    const message = repo.commitMessage.get(sha) ?? view.message;
    const person = (line: string): { name: string; email: string; date: string } => {
      const match = line.match(/^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
      if (match === null) return { name: line, email: '', date: repo.createdAt };
      return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(Number(match[3]) * 1000).toISOString() };
    };
    return {
      sha,
      commit: {
        message,
        author: person(view.author),
        committer: person(view.committer),
        tree: { sha: view.tree },
      },
      author: { login, id: 1000, type: 'User' },
      committer: { login, id: 1000, type: 'User' },
      parents: view.parents.map((parent) => ({ sha: parent })),
      url: `/api/v3/repos/${login}/${repo.name}/commits/${sha}`,
      html_url: `https://example.invalid/${login}/${repo.name}/commit/${sha}`,
    };
  }
}

export { isAncestor, parseCommit, parseTree };
