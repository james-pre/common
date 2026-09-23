// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Command } from 'commander';
import { styleText } from 'node:util';
import { isLingering } from './linger.js';
import type { ActiveState, InstallSource, Service } from './service.js';

export interface ServiceCommandOptions {
	/** @default 'service' */
	name?: string;
	/**
	 * The service to manage.
	 * @param user Whether `--user` or `--system` asked for the user's or the system's service manager, if either did
	 */
	service: (user: boolean | undefined) => Service;
	/** What `install` installs, which leaves out `install` when absent. */
	source?: (service: Service) => InstallSource;
}

const stateColors: Partial<Record<ActiveState, 'green' | 'red'>> = { active: 'green', failed: 'red' };

const byteUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

function formatBytes(bytes: number): string {
	const unit = Math.min(byteUnits.length - 1, Math.floor(Math.log2(Math.max(bytes, 1)) / 10));
	return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${byteUnits[unit]}`;
}

/**
 * Add a command for managing a systemd service to `parent`.
 * @returns the new command, for adding more subcommands
 */
export function serviceCommand<C extends Command>(parent: C, options: ServiceCommandOptions): Command {
	const command = parent
		.command(options.name ?? 'service')
		.description('Manage the systemd service')
		.addOption(parent.createOption('--user', "use the user's service manager").conflicts('system'))
		.addOption(parent.createOption('--system', "use the system's service manager").conflicts('user'));

	function service(): Service {
		const { user, system } = command.opts();
		return options.service(user ? true : system ? false : undefined);
	}

	/** Get the service, when the user may write the unit directory. */
	function writableService(): Service {
		const svc = service();
		if (!svc.options.user && process.getuid?.() !== 0)
			command.error('error: managing a system service requires root, try again with sudo or use --user');
		return svc;
	}

	if (options.source) {
		const { source } = options;
		command
			.command('install')
			.description('Install the service')
			.option('-e, --enable', 'start the service on boot')
			.option('-s, --start', 'start the service now')
			.option('-r, --replace', 'replace the service if it is already installed')
			.action(opts => {
				const svc = writableService();
				svc.install(source(svc), opts);
				console.log('Installed', styleText('bold', svc.unit), 'to', svc.path);

				if (svc.options.user && opts.enable && !isLingering())
					console.warn(
						styleText(
							'yellow',
							`${svc.unit} will not start until you log in. To start it on boot, run: loginctl enable-linger`
						)
					);
			});
	}

	command
		.command('uninstall')
		.description('Stop and remove the service')
		.option('-k, --keep-running', 'leave the service running')
		.action(opts => {
			const svc = writableService();
			if (svc.uninstall({ stop: !opts.keepRunning })) console.log('Uninstalled', styleText('bold', svc.unit));
			else console.log(svc.unit, 'is not installed');
		});

	command
		.command('status')
		.description('Show the state of the service')
		.action(() => {
			const svc = service();
			const status = svc.status();

			if (status.load == 'not-found') {
				console.log(svc.unit, styleText('dim', 'is not installed'));
				process.exitCode = 4;
				return;
			}

			const since = status.since ? styleText('dim', ` since ${status.since.toLocaleString()}`) : '';
			const state = styleText(stateColors[status.active] ?? 'yellow', `${status.active} (${status.sub})`);

			console.log(styleText('bold', svc.unit), styleText('dim', svc.options.user ? '(user)' : '(system)'));
			console.log('   State:', state + since);
			console.log('    Boot:', status.enabled ?? styleText('dim', 'unknown'));
			if (status.pid) console.log('     PID:', status.pid);
			if (status.memory !== null) console.log('  Memory:', formatBytes(status.memory));
			if (status.result != 'success')
				console.log(
					'  Result:',
					styleText('red', status.result),
					styleText('dim', `(exit status ${status.exitStatus})`)
				);
			console.log('    Unit:', styleText('dim', status.path ?? svc.path));

			if (status.active != 'active') process.exitCode = 3;
		});

	for (const [name, description] of [
		['start', 'Start the service'],
		['stop', 'Stop the service'],
		['restart', 'Restart the service'],
	] as const) {
		command
			.command(name)
			.description(description)
			.action(() => service()[name]());
	}

	command
		.command('enable')
		.description('Start the service on boot')
		.option('--now', 'also start it now')
		.action(opts => service().enable(opts));

	command
		.command('disable')
		.description('Stop starting the service on boot')
		.option('--now', 'also stop it now')
		.action(opts => service().disable(opts));

	return command;
}
