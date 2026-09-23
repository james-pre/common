// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, globSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface PackageJSON {
	name?: string;
	version?: string;
	private?: boolean;
	workspaces?: string[] | { packages?: string[] };
	[key: string]: unknown;
}

export function readPackage(dir: string): PackageJSON {
	return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJSON;
}

export interface Workspace {
	/** The name of the workspace's directory, which its release tags start with. */
	id: string;
	/** The package's name, or its ID when it has none. */
	name: string;
	version: string | null;
	/** The workspace's directory, relative to the root. */
	path: string;
	private: boolean;
}

/** The closest directory at or above `from` with a `package.json` that declares workspaces. */
export function findRoot(from: string = process.cwd()): string {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		if (existsSync(join(dir, 'package.json')) && readPackage(dir).workspaces) return dir;
		if (dirname(dir) == dir) throw new Error(`no package.json with workspaces at or above ${from}`);
	}
}

/** The workspaces declared by the `package.json` in `root`, sorted by path. */
export function listWorkspaces(root: string): Workspace[] {
	const { workspaces } = readPackage(root);
	const patterns = (Array.isArray(workspaces) ? workspaces : workspaces?.packages) ?? [];

	const paths = globSync(
		patterns.filter(pattern => !pattern.startsWith('!')),
		{ cwd: root, exclude: patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1)) }
	);

	return paths
		.filter(path => existsSync(join(root, path, 'package.json')))
		.sort()
		.map(path => {
			const pkg = readPackage(join(root, path));
			const id = basename(path);
			return { id, name: pkg.name ?? id, version: pkg.version ?? null, path, private: !!pkg.private };
		});
}
