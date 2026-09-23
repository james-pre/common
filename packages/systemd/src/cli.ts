// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Command } from 'commander';
import { styleText } from 'node:util';
import { isLingering } from './linger.js';
import type { ActiveState, InstallSource, Service } from './service.js';
import { ensureServiceUser, removeServiceUser, type ServiceUserOptions } from './users.js';

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
	/**
	 * The user the service runs as, which `install` creates when it doesn't exist.
	 * When given, `user` is added to manage it, and `uninstall` can remove it.
	 */
	serviceUser?: (service: Service) => ServiceUserOptions | undefined;
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

	/** Create or update the service's user, if it has one. */
	function setupUser(svc: Service, overrides: Partial<ServiceUserOptions> = {}): void {
		const userOptions = options.serviceUser?.(svc);
		if (!userOptions) return;

		const { user, created, added } = ensureServiceUser({ ...userOptions, ...overrides });
		if (created) console.log('Created system user', styleText('bold', user.name));
		for (const member of added)
			console.log('Added', member, 'to the', user.name, 'group, effective on their next login');
	}

	const memberOption = () => command.createOption('-m, --member <users...>', "add users to the service user's group");

	if (options.source) {
		const { source } = options;
		const install = command
			.command('install')
			.description('Install the service')
			.option('-e, --enable', 'start the service on boot')
			.option('-s, --start', 'start the service now')
			.option('-r, --replace', 'replace the service if it is already installed');

		if (options.serviceUser) install.addOption(memberOption());

		install.action((opts: { enable?: true; start?: true; replace?: true; member?: string[] }) => {
			const svc = writableService();
			setupUser(svc, { members: opts.member });
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

	if (options.serviceUser) {
		const { serviceUser } = options;
		command
			.command('user')
			.description("Create the service's user, or update it")
			.option('--home <path>', "the user's home directory")
			.option('--shell <path>', "the user's login shell")
			.addOption(memberOption())
			.action((opts: { home?: string; shell?: string; member?: string[] }) => {
				const svc = writableService();
				if (!serviceUser(svc)) command.error(`error: ${svc.unit} does not run as its own user`);
				setupUser(svc, { home: opts.home, shell: opts.shell, members: opts.member });
			});
	}

	const uninstall = command
		.command('uninstall')
		.description('Stop and remove the service')
		.option('-k, --keep-running', 'leave the service running');

	if (options.serviceUser) uninstall.option('--remove-user', "also delete the service's user");

	uninstall.action((opts: { keepRunning?: true; removeUser?: true }) => {
		const svc = writableService();
		if (svc.uninstall({ stop: !opts.keepRunning })) console.log('Uninstalled', styleText('bold', svc.unit));
		else console.log(svc.unit, 'is not installed');

		const name = opts.removeUser && options.serviceUser?.(svc)?.name;
		if (name && removeServiceUser(name)) console.log('Deleted system user', styleText('bold', name));
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
