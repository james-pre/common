// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Git } from './git.js';
import {
	dependencyFields,
	findRoot,
	listWorkspaces,
	readPackage,
	writePackage,
	type PackageJSON,
	type Workspace,
} from './workspaces.js';

export interface ReleaseOptions {
	/**
	 * Push the release commit and tag.
	 * @default true
	 */
	push?: boolean;
}

export interface Release {
	workspace: Workspace;
	tag: string;
	version: string;
	/** The lines of the messages of the commits since the previous release. */
	changes: string[];
}

export interface DependencyUpdate {
	/** The dependent workspace. */
	workspace: Workspace;
	/** The field of the `package.json` with the dependency, like `devDependencies`. */
	field: (typeof dependencyFields)[number];
	from: string;
	to: string;
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
	 * Bump the versions of workspaces, then commit them together and tag each one.
	 * @param bumps Each workspace with anything `npm version` takes, like `patch`, `minor`, `prerelease`, or `1.2.3`
	 */
	public release(bumps: Iterable<readonly [Workspace, string]>, options: ReleaseOptions = {}): Release[] {
		const entries = [...bumps];
		if (!entries.length) throw new Error('no workspaces to release');
		if (!this.git.isClean()) throw new Error('the working tree has uncommitted changes');

		const seen = new Set<Workspace>();
		for (const [workspace] of entries) {
			if (seen.has(workspace)) throw new Error(`${workspace.id} is released more than once`);
			seen.add(workspace);

			if (workspace.private) throw new Error(`${workspace.name} is private`);

			const latest = this.latestRelease(workspace);
			if (latest && !this.git.changedSince(latest, workspace.path))
				throw new Error(`${workspace.id} has not changed since ${latest}`);
		}

		const files = [
			...entries.map(([workspace]) => join(workspace.path, 'package.json')),
			'package-lock.json',
		].filter(file => existsSync(join(this.root, file)));

		const releases: Release[] = [];

		try {
			for (const [workspace, bump] of entries) {
				const changes = this.changes(workspace);

				execFileSync('npm', ['version', bump, '--workspace', workspace.path, '--no-git-tag-version'], {
					cwd: this.root,
					stdio: ['ignore', 'ignore', 'inherit'],
				});

				const version = readPackage(join(this.root, workspace.path)).version!;
				releases.push({ workspace, tag: tagName(workspace, version), version, changes });
			}

			this.git.run('add', '--', ...files);
			this.git.run('commit', '--quiet', '-m', releases.map(release => release.tag).join(', '));
		} catch (error) {
			this.git.run('reset', '--quiet', '--', ...files);
			this.git.run('checkout', '--', ...files);
			throw error;
		}

		for (const { workspace, tag, version } of releases) {
			workspace.version = version;
			this.git.run('tag', tag, '-m', tag);
		}

		if (options.push !== false) this.git.show('push', '--follow-tags');

		return releases;
	}

	/**
	 * Set the version range of `target` that workspaces depend on.
	 * @param range Written exactly as given. By default, the target's version with the operator of each existing range.
	 */
	public updateDependency(dependents: Iterable<Workspace>, target: Workspace, range?: string): DependencyUpdate[] {
		if (!range && !target.version) throw new Error(`${target.name} has no version`);

		const updates: DependencyUpdate[] = [];
		const packages = new Map<Workspace, PackageJSON>();

		for (const workspace of new Set(dependents)) {
			const pkg = readPackage(join(this.root, workspace.path));
			const previous = updates.length;

			for (const field of dependencyFields) {
				const dependencies = pkg[field];
				const from = dependencies?.[target.name];
				if (!dependencies || from === undefined) continue;

				let to = range;
				if (!to) {
					const operator = /^([~^]|[<>]=?|=)?\s*v?\d[^\s|]*$/.exec(from.trim());
					if (!operator)
						throw new Error(
							`can't keep the range '${from}' of ${target.name} in ${workspace.id}, so give one like ${target.id}@^${target.version}`
						);
					to = (operator[1] ?? '') + target.version;
				}

				dependencies[target.name] = to;
				updates.push({ workspace, field, from, to });
			}

			if (updates.length == previous) throw new Error(`${workspace.id} does not depend on ${target.name}`);
			packages.set(workspace, pkg);
		}

		for (const [workspace, pkg] of packages) writePackage(join(this.root, workspace.path), pkg);

		return updates;
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
