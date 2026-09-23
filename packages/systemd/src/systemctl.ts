// SPDX-License-Identifier: LGPL-3.0-or-later
import { exec, type Result } from './exec.js';

export type { Result };

export interface ManagerOptions {
	/** Use the calling user's service manager (`systemctl --user`) instead of the system's. */
	user?: boolean;
}

export interface SystemctlOptions extends ManagerOptions {
	/** Return the result when `systemctl` fails, instead of throwing. */
	allowFailure?: boolean;
}

export class SystemctlError extends Error {
	public constructor(
		public readonly args: readonly string[],
		public readonly result: Result
	) {
		super(result.stderr.trim() || `systemctl ${args.join(' ')} exited with status ${result.status}`);
		this.name = 'SystemctlError';
	}
}

export function systemctl(args: readonly string[], options: SystemctlOptions = {}): Result {
	const fullArgs = options.user ? ['--user', ...args] : args;
	const result = exec('systemctl', fullArgs);
	if (result.status && !options.allowFailure) throw new SystemctlError(fullArgs, result);
	return result;
}

/** Have the service manager reread every unit file. */
export function daemonReload(options: ManagerOptions = {}): void {
	systemctl(['daemon-reload'], options);
}
