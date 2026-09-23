// SPDX-License-Identifier: LGPL-3.0-or-later
import { realpathSync } from 'node:fs';
import { exec } from './exec.js';

const unitType = 'systemd_unit_file_t';

export function selinuxEnabled(): boolean {
	try {
		return !exec('selinuxenabled', []).status;
	} catch {
		return false;
	}
}

/**
 * Record `pattern` as a unit file in the SELinux policy, so relabeling keeps it one.
 * @returns whether the policy could be changed
 */
function persistLabel(pattern: string): boolean {
	try {
		return ['-a', '-m'].some(action => !exec('semanage', ['fcontext', action, '-t', unitType, pattern]).status);
	} catch {
		return false;
	}
}

/**
 * Label a unit file so systemd may read it where it is, on hosts where SELinux is enabled.
 * This is needed for a linked system unit, which keeps the label of its directory (e.g. `user_home_t`).
 * The label survives relabeling when `semanage` is installed.
 */
export function relabel(path: string): void {
	if (!selinuxEnabled()) return;

	const real = realpathSync(path);
	const pattern = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	const result = persistLabel(pattern) ? exec('restorecon', [real]) : exec('chcon', ['-t', unitType, real]);

	if (result.status) throw new Error(`could not label ${real} as a unit file: ${result.stderr.trim()}`);
}
