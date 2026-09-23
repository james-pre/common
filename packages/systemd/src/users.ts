// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { exec } from './exec.js';

export interface User {
	name: string;
	uid: number;
	gid: number;
	home: string;
	shell: string;
}

export interface Group {
	name: string;
	gid: number;
	members: string[];
}

/** An entry of an NSS database like `passwd` or `group`, split into its fields. */
function getent(database: string, key: string): string[] | null {
	const { status, stdout } = exec('getent', [database, key]);
	return status ? null : stdout.trim().split(':');
}

function run(file: string, args: string[]): void {
	const { status, stderr } = exec(file, args);
	if (status) throw new Error(stderr.trim() || `${file} exited with status ${status}`);
}

export function getUser(name: string): User | null {
	const entry = getent('passwd', name);
	if (!entry) return null;
	const [, , uid, gid, , home, shell] = entry;
	return { name: entry[0], uid: Number(uid), gid: Number(gid), home, shell };
}

export function getGroup(name: string): Group | null {
	const entry = getent('group', name);
	if (!entry) return null;
	return { name: entry[0], gid: Number(entry[2]), members: entry[3] ? entry[3].split(',') : [] };
}

const nologinPaths = ['/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/nologin', '/usr/bin/false', '/bin/false'];

export interface ServiceUserOptions {
	name: string;
	/** The user's home directory, which is never created. */
	home?: string;
	/** @default the system's `nologin`, or `false` without it */
	shell?: string;
	/** Users to add to the service user's group, such as the people who administer the service. */
	members?: readonly string[];
}

export interface ServiceUserResult {
	user: User;
	created: boolean;
	/** The members that were not in the group yet. */
	added: string[];
}

/**
 * Create a system user for a service to run as, with a group of the same name, or update the home and shell of an existing one.
 * Then add the members to its group.
 */
export function ensureServiceUser(options: ServiceUserOptions): ServiceUserResult {
	const { name } = options;
	let user = getUser(name);
	const created = !user;

	if (!user) {
		const shell = options.shell ?? nologinPaths.find(path => existsSync(path));
		run('useradd', [
			'--system',
			'--no-create-home',
			...(getGroup(name) ? ['--gid', name] : ['--user-group']),
			...(options.home ? ['--home-dir', options.home] : []),
			...(shell ? ['--shell', shell] : []),
			name,
		]);
	} else {
		const changes = [
			...(options.home && options.home != user.home ? ['--home', options.home] : []),
			...(options.shell && options.shell != user.shell ? ['--shell', options.shell] : []),
		];
		if (changes.length) run('usermod', [...changes, name]);
	}

	user = getUser(name)!;

	const { members = [] } = getGroup(name) ?? {};
	const added = [...new Set(options.members)].filter(member => member != name && !members.includes(member));
	for (const member of added) run('usermod', ['--append', '--groups', name, member]);

	return { user, created, added };
}

/**
 * Delete a service user, and its group once nobody else is in it. Its home directory is left alone.
 * @returns whether there was a user to delete
 */
export function removeServiceUser(name: string): boolean {
	if (!getUser(name)) return false;
	run('userdel', [name]);
	return true;
}
