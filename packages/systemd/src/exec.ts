// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawnSync } from 'node:child_process';

export interface Result {
	/** The exit status, which some commands answer with, like `systemctl is-active`. */
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Run a program to completion, returning whatever its exit status.
 * Standard input is shared, so polkit can ask for a password on the terminal.
 * Throws only when it can not be run or is killed.
 * @internal
 */
export function exec(file: string, args: readonly string[]): Result {
	const { status, signal, stdout, stderr, error } = spawnSync(file, args, {
		encoding: 'utf8',
		stdio: ['inherit', 'pipe', 'pipe'],
	});

	if (error) throw error;
	if (status === null) throw new Error(`${file} was killed by ${signal}`);
	return { status, stdout, stderr };
}
