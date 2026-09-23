// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Command } from 'commander';
import { getByString, setByString } from 'utilium';
import * as z from 'zod';
import type { FileType, Manager } from './manager.js';

export interface ConfigCommandOptions {
	/** @default 'config' */
	name?: string;
	/**
	 * Keys whose values `--redact` hides, wherever they are.
	 * @default ['password', 'secret']
	 */
	sensitive?: readonly string[];
	/** The kind of file `set` writes to without `--type`, otherwise the most recently loaded one. */
	defaultType?: FileType;
}

const fileTypes = ['system', 'user', 'local'] as const satisfies FileType[];

function redact(value: unknown, keys: readonly string[]): unknown {
	if (Array.isArray(value)) return value.map(item => redact(item, keys));
	if (typeof value != 'object' || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, keys.includes(key) ? '[redacted]' : redact(child, keys)])
	);
}

/**
 * Add a command for reading and changing a manager's configuration to `parent`.
 * @returns the new command, for adding more subcommands
 */
export function configCommand<C extends Command>(
	parent: C,
	manager: Manager<z.ZodObject>,
	options: ConfigCommandOptions = {}
): Command {
	const { sensitive = ['password', 'secret'] } = options;

	const command = parent
		.command(options.name ?? 'config')
		.description('Manage the configuration')
		.option('-j, --json', 'read and write values as JSON', false)
		.option('-r, --redact', 'hide sensitive values', false);

	function output(value: unknown) {
		const { json, redact: hide } = command.opts();
		if (hide) value = redact(value, sensitive);
		console.log(json ? JSON.stringify(value, null, 4) : value);
	}

	command
		.command('dump')
		.description('Output the entire current configuration')
		.action(() => output(manager.data));

	command
		.command('get')
		.description('Get a config value')
		.argument('<key>', 'the key to get')
		.action(key => output(getByString(manager.data, key)));

	command
		.command('set')
		.description('Set a config value, which must be JSON for anything but a string')
		.argument('<key>', 'the key to set')
		.argument('<value>', 'the value')
		.addOption(command.createOption('-t, --type <type>', 'the kind of file to write to').choices(fileTypes))
		.addOption(
			command.createOption('-g, --global', 'write to the system file, like --type system').conflicts('type')
		)
		.action(function (key, value, opts) {
			let parsed: unknown = value;
			if (command.opts().json) {
				try {
					parsed = JSON.parse(value);
				} catch {
					this.error('error: value is not valid JSON');
				}
			}

			const update: Record<string, unknown> = {};
			setByString(update, key, parsed);

			try {
				manager.update(update, opts.global ? 'system' : (opts.type ?? options.defaultType));
			} catch (error) {
				if (!(error instanceof z.ZodError)) throw error;
				this.error('error: invalid value\n' + z.prettifyError(error));
			}
		});

	command
		.command('list')
		.alias('ls')
		.alias('files')
		.description('List loaded config files')
		.action(() => {
			for (const path of manager.filePaths) console.log(path);
		});

	command
		.command('schema')
		.description('Get the JSON schema for config files')
		.action(() => output(z.toJSONSchema(manager.fileSchema, { io: 'input' })));

	return command;
}
