// SPDX-License-Identifier: LGPL-3.0-or-later
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { relabel } from './selinux.js';
import { daemonReload, systemctl, type ManagerOptions, type Result } from './systemctl.js';
import { stringify, type UnitFile } from './unit.js';
import { styleText } from 'node:util';

/** Where units are installed for a service manager. */
export function unitDirectory(options: ManagerOptions = {}): string {
	if (!options.user) return '/etc/systemd/system';
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
}

export type InstallSource =
	| { unit: UnitFile }
	| { text: string }
	/** A unit file that systemd reads where it is, linked into the unit directory. Its name must match the service's. */
	| { link: string };

export interface InstallOptions {
	/** Replace the service if it is already installed, rather than failing. */
	replace?: boolean;
	enable?: boolean;
	start?: boolean;
	/**
	 * Label a linked system unit so systemd may read it, when SELinux is enabled.
	 * @default true
	 */
	selinux?: boolean;
}

export interface UninstallOptions {
	/**
	 * Stop the service before removing it.
	 * @default true
	 */
	stop?: boolean;
}

export interface ToggleOptions {
	/** Also start or stop the service. */
	now?: boolean;
}

export type LoadState = 'stub' | 'loaded' | 'not-found' | 'bad-setting' | 'error' | 'merged' | 'masked';

export type ActiveState =
	'active' | 'reloading' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'maintenance' | 'refreshing';

export interface Status {
	description: string;
	load: LoadState;
	active: ActiveState;
	/** A state specific to services, such as `running`, `exited`, or `auto-restart`. */
	sub: string;
	/** Whether the service starts on boot, such as `enabled`, `disabled`, `static`, or `linked`, or null without a unit file. */
	enabled: string | null;
	/** The unit file, or null when there is none. */
	path: string | null;
	pid: number | null;
	/** When the service last changed its active state. */
	since: Date | null;
	/** How the service last stopped, such as `success`, `exit-code`, or `signal`. */
	result: string;
	/** The main process's last exit status. */
	exitStatus: number | null;
	/** Memory used by the service's processes in bytes, when accounting is on. */
	memory: number | null;
}

const statusProperties = [
	'Description',
	'LoadState',
	'ActiveState',
	'SubState',
	'UnitFileState',
	'FragmentPath',
	'MainPID',
	'StateChangeTimestamp',
	'Result',
	'ExecMainStatus',
	'MemoryCurrent',
] as const;

function integer(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	const number = Number(value);
	// Unset counters are reported as the largest 64-bit integer.
	return number < 2 ** 64 - 1 ? number : null;
}

export class Service {
	/** The unit's full name, e.g. `example.service`. */
	public readonly unit: string;

	/**
	 * @param name The service's name, with or without `.service`
	 */
	public constructor(
		name: string,
		public readonly options: ManagerOptions = {}
	) {
		this.unit = name.endsWith('.service') ? name : name + '.service';
	}

	/** Where the service is installed to. */
	public get path(): string {
		return join(unitDirectory(this.options), this.unit);
	}

	protected systemctl(command: string, ...args: string[]): Result {
		return systemctl([command, ...args, this.unit], this.options);
	}

	/** Whether the service is installed in the unit directory, rather than not at all or by a package. */
	public isInstalled(): boolean {
		return !!lstatSync(this.path, { throwIfNoEntry: false });
	}

	public install(source: InstallSource, options: InstallOptions = {}): void {
		if (!options.replace && this.isInstalled())
			throw new Error(`${this.unit} is already installed at ${this.path}`);

		if ('link' in source) {
			const target = resolve(source.link);
			if (basename(target) != this.unit) throw new Error(`can not link ${target} as ${this.unit}`);
			rmSync(this.path, { force: true });
			systemctl(['link', target], this.options);
			if (!this.options.user && options.selinux !== false) relabel(target);
		} else {
			mkdirSync(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${process.pid}.tmp`;
			try {
				writeFileSync(temp, 'unit' in source ? stringify(source.unit) : source.text, { mode: 0o644 });
				renameSync(temp, this.path);
			} finally {
				rmSync(temp, { force: true });
			}
		}

		daemonReload(this.options);

		if (options.enable) this.enable({ now: options.start });
		else if (options.start) this.start();
	}

	/**
	 * Remove the service from the unit directory, disabling it first.
	 * @returns whether there was anything to remove
	 */
	public uninstall(options: UninstallOptions = {}): boolean {
		if (!this.isInstalled()) return false;

		const { load } = this.status();
		if (options.stop !== false && load != 'not-found') this.stop();
		this.systemctl('disable');
		rmSync(this.path, { force: true });
		daemonReload(this.options);
		systemctl(['reset-failed', this.unit], { ...this.options, allowFailure: true });

		return true;
	}

	/** Read properties of the service, as `systemctl show` reports them. Unknown properties are empty. */
	public show<const K extends string>(properties: readonly K[]): Record<K, string> {
		const { stdout } = this.systemctl('show', '--timestamp=unix', '--property=' + properties.join(','));

		const values = Object.fromEntries(properties.map(property => [property, ''])) as Record<K, string>;

		for (const line of stdout.split('\n')) {
			const separator = line.indexOf('=');
			const key = line.slice(0, separator) as K;
			if (separator != -1 && key in values) values[key] = line.slice(separator + 1);
		}

		return values;
	}

	public status(): Status {
		const values = this.show(statusProperties);
		const since = /^@(\d+)$/.exec(values.StateChangeTimestamp);

		return {
			description: values.Description,
			load: values.LoadState as LoadState,
			active: values.ActiveState as ActiveState,
			sub: values.SubState,
			enabled: values.UnitFileState || null,
			path: values.FragmentPath || null,
			pid: integer(values.MainPID) || null,
			since: since ? new Date(Number(since[1]) * 1000) : null,
			result: values.Result,
			exitStatus: integer(values.ExecMainStatus),
			memory: integer(values.MemoryCurrent),
		};
	}

	public shortStatus(): string {
		const { load, active, enabled } = this.status();

		if (load == 'not-found') return styleText('dim', 'not found');

		const color = active == 'failed' ? 'red' : active == 'active' ? 'green' : 'yellow';
		return `${enabled}, ${styleText(color, active)}`;
	}

	public start(): void {
		this.systemctl('start');
	}

	public stop(): void {
		this.systemctl('stop');
	}

	public restart(): void {
		this.systemctl('restart');
	}

	/** Ask the service to reload its configuration, which it must support with `ExecReload=`. */
	public reload(): void {
		this.systemctl('reload');
	}

	/** Start the service on boot. */
	public enable(options: ToggleOptions = {}): void {
		this.systemctl('enable', ...(options.now ? ['--now'] : []));
	}

	/** Stop starting the service on boot. */
	public disable(options: ToggleOptions = {}): void {
		this.systemctl('disable', ...(options.now ? ['--now'] : []));
	}
}
