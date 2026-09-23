// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';

/** Runs git in a working tree. */
export class Git {
	public constructor(public readonly cwd: string) {}

	/** Run git, returning its output. Its errors are shown as they happen. */
	public run(...args: string[]): string {
		return execFileSync('git', args, {
			cwd: this.cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit'],
		}).trimEnd();
	}

	/** Run git on the terminal, such as with a pager. */
	public show(...args: string[]): void {
		const { status, error } = spawnSync('git', args, { cwd: this.cwd, stdio: 'inherit' });
		if (error) throw error;
		if (status) throw new Error(`git ${args[0]} exited with status ${status}`);
	}

	/** Whether git succeeds, for commands that answer with their exit status. */
	public test(...args: string[]): boolean {
		const { status, error } = spawnSync('git', args, { cwd: this.cwd, stdio: 'ignore' });
		if (error) throw error;
		return status === 0;
	}

	public isClean(): boolean {
		return !this.run('status', '--porcelain');
	}

	public hasTag(name: string): boolean {
		return this.test('rev-parse', '--verify', '--quiet', `refs/tags/${name}`);
	}

	/** The tags matching `pattern`, by version. */
	public tags(pattern: string, order: 'ascending' | 'descending' = 'ascending'): string[] {
		const tags = this.run('tag', '--list', pattern, `--sort=${order == 'descending' ? '-' : ''}v:refname`);
		return tags ? tags.split('\n') : [];
	}

	/** Whether anything in `path` changed between `since` and `HEAD`. */
	public changedSince(since: string, path: string): boolean {
		return !this.test('diff', '--quiet', `${since}..HEAD`, '--', path);
	}

	/**
	 * The non-empty lines of the messages of commits to `path`, oldest first.
	 * @param since Only include commits after this one, rather than all of them.
	 */
	public messages(path: string, since?: string | null): string[] {
		const range = since ? [`${since}..HEAD`] : [];
		return this.run('log', '--reverse', '--format=%B', ...range, '--', path)
			.split('\n')
			.filter(Boolean);
	}
}
