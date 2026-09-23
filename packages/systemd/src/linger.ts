// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { exec } from './exec.js';

/** Whether a user's service manager runs without them logged in, which their services need to start on boot. */
export function isLingering(user: string = userInfo().username): boolean {
	return existsSync(`/var/lib/systemd/linger/${user}`);
}

export function setLinger(enabled: boolean, user: string = userInfo().username): void {
	const result = exec('loginctl', [enabled ? 'enable-linger' : 'disable-linger', user]);
	if (result.status) throw new Error(result.stderr.trim() || `could not change lingering for ${user}`);
}
