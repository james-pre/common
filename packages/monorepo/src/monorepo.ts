// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Git } from './git.js';
import { findRoot, listWorkspaces, readPackage, type Workspace } from './workspaces.js';

export interface ReleaseOptions {
	/**
	 * Push the release commit and tag.
	 * @default true
	 */
	push?: boolean;
}

export interface Release {
	tag: string;
	version: string;
	/** The lines of the messages of the commits since the previous release. */
	changes: string[];
}

/** The tag of a workspace's release, like `example@1.2.3`. */
export function tagName(workspace: Workspace, version: string | null = workspace.version): string {
	return `${workspace.id}@${version}`;
}

export class Monorepo {
	public readonly git: Git;
	public readonly workspaces: Workspace[];

	public constructor(public readonly root: string) {
		this.git = new Git(root);
		this.workspaces = listWorkspaces(root);
	}

	/** The monorepo at or above `from`. */
	public static find(from?: string): Monorepo {
		return new Monorepo(findRoot(from));
	}

	/** Find a workspace by its ID, its package name, or its path relative to the working directory. */
	public workspace(query: string): Workspace {
		const path = relative(this.root, resolve(query));
		const workspace = this.workspaces.find(ws => ws.id == query || ws.name == query || ws.path == path);
		if (!workspace) throw new Error(`no workspace matches '${query}'`);
		return workspace;
	}

	/** Find the workspace a release tag is for, checking that the tag matches its version. */
	public resolveTag(tag: string): Workspace {
		const separator = tag.lastIndexOf('@');
		const id = tag.slice(0, separator),
			version = tag.slice(separator + 1);

		const workspace = separator > 0 && this.workspaces.find(ws => ws.id == id);
		if (!workspace) throw new Error(`no workspace has release tag '${tag}'`);
		if (workspace.version != version)
			throw new Error(`${tag} does not match the version of ${workspace.name} (${workspace.version})`);

		return workspace;
	}

	/** The tags of a workspace's releases, oldest first. */
	public releases(workspace: Workspace): string[] {
		return this.git.tags(`${workspace.id}@*`);
	}

	public latestRelease(workspace: Workspace): string | null {
		return this.git.tags(`${workspace.id}@*`, 'descending')[0] ?? null;
	}

	/** Whether a workspace changed since its latest release, or null when it has never been released. */
	public hasChanged(workspace: Workspace): boolean | null {
		const latest = this.latestRelease(workspace);
		return latest === null ? null : this.git.changedSince(latest, workspace.path);
	}

	/** The lines of the messages of the commits to a workspace since its latest release. */
	public changes(workspace: Workspace): string[] {
		return this.git.messages(workspace.path, this.latestRelease(workspace));
	}

	/**
	 * Bump a workspace's version, then commit and tag it.
	 * @param bump Anything `npm version` takes, like `patch`, `minor`, `prerelease`, or `1.2.3`
	 */
	public release(workspace: Workspace, bump: string, options: ReleaseOptions = {}): Release {
		if (workspace.private) throw new Error(`${workspace.name} is private`);
		if (!this.git.isClean()) throw new Error('the working tree has uncommitted changes');

		const latest = this.latestRelease(workspace);
		if (latest && !this.git.changedSince(latest, workspace.path))
			throw new Error(`${workspace.id} has not changed since ${latest}`);

		const changes = this.changes(workspace);
		const files = [join(workspace.path, 'package.json'), 'package-lock.json'].filter(file =>
			existsSync(join(this.root, file))
		);

		let version: string, tag: string;

		try {
			execFileSync('npm', ['version', bump, '--workspace', workspace.path, '--no-git-tag-version'], {
				cwd: this.root,
				stdio: ['ignore', 'ignore', 'inherit'],
			});

			version = readPackage(join(this.root, workspace.path)).version!;
			tag = tagName(workspace, version);

			this.git.run('add', '--', ...files);
			this.git.run('commit', '--quiet', '-m', tag);
		} catch (error) {
			this.git.run('reset', '--quiet', '--', ...files);
			this.git.run('checkout', '--', ...files);
			throw error;
		}

		workspace.version = version;
		this.git.run('tag', tag, '-m', tag);
		if (options.push !== false) this.git.show('push', '--follow-tags');

		return { tag, version, changes };
	}

	/** Point the tag of a workspace's current version at `HEAD`. */
	public retag(workspace: Workspace): string {
		const tag = tagName(workspace);
		this.git.run('tag', '--force', tag, '-m', tag);
		return tag;
	}

	/**
	 * Tag the current version of every public workspace that hasn't been.
	 * @returns the tags created
	 */
	public createTags(): string[] {
		const created: string[] = [];

		for (const workspace of this.workspaces) {
			if (workspace.private || !workspace.version) continue;
			const tag = tagName(workspace);
			if (this.git.hasTag(tag)) continue;
			this.git.run('tag', tag, '-m', tag);
			created.push(tag);
		}

		return created;
	}
}
