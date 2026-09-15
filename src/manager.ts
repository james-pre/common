// SPDX-License-Identifier: LGPL-3.0-or-later
import EventEmitter from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { FlattenKeys, GetByString, PartialRecursive } from 'utilium';
import { deepAssign, getByString, memoize, setByString } from 'utilium';
import * as z from 'zod';

export type FileType = 'system' | 'user' | 'local';

/** Information about a loaded config file */
interface File<Value, Options extends LoadOptions = LoadOptions> {
	path: string;
	wasIncluded: boolean;
	data: Value;
	type: FileType;
	auto: boolean;
	options: Partial<Options>;
}

/**
 * How a file is being loaded
 * @internal
 */
interface FileLoadInit {
	wasIncluded?: boolean;
	type?: FileType;
	auto?: boolean;
}

export interface LoadOptions {
	/**
	 * If enabled, the config file will still be loaded if it does not match the schema.
	 */
	loose: boolean;

	/**
	 * If enabled, the config file will be skipped if it does not exist.
	 */
	optional: boolean;

	/**
	 * If enabled, an empty config file will be created when it does not exist.
	 * Included files are never created.
	 */
	create: boolean;

	/**
	 * Used to mark files that are included, auto-loaded, etc.
	 * @internal
	 */
	[kInit]: FileLoadInit;
}

const kInit = Symbol.for('LoadOptions:init');

export interface ManagerOptions {
	/** If true, allow specifying `include: [...]` to load additional files */
	enableIncludes?: boolean;

	/**
	 * If set, try to load files in the XDG config directory (or the OS-equivalent).
	 * This corresponds to the relative path, though you can omit `.json`
	 */
	xdg?: string;

	/**
	 * Try to load system-wide configuration from `/etc` (or the OS-equivalent).
	 * Trailing `.json` can be omitted.
	 */
	system?: string;
}

const include = z.string().array().optional();

function canInclude(options: ManagerOptions, file: unknown): file is { include: string[] } {
	return (
		!!options.enableIncludes
		&& typeof file === 'object'
		&& file !== null
		&& 'include' in file
		&& Array.isArray(file.include)
	);
}

const xdgConfigDir =
	process.env.XDG_CONFIG_HOME
	|| (process.platform == 'win32' ? process.env.APPDATA : null)
	|| join(homedir(), '.config');

const systemConfigDir = (process.platform == 'win32' ? process.env.PROGRAMDATA : null) || '/etc';

function typeFromPath(path: string): FileType {
	if (path.startsWith(systemConfigDir + sep)) return 'system';
	if (path.startsWith(xdgConfigDir + sep)) return 'user';
	return 'local';
}

/** Resolve a `ManagerOptions` path, which may omit the `.json` extension */
function withExtension(path: string): string {
	return path.endsWith('.json') ? path : path + '.json';
}

/**
 * Remove `.default()` and `.prefault()` from a schema and everything nested within it.
 */
function stripDefaults(schema: z.ZodType): z.ZodType {
	const def = schema._zod.def as any;

	switch (def.type) {
		case 'default':
		case 'prefault':
			return stripDefaults(def.innerType);
		case 'object':
			return z.core.clone(schema, {
				...def,
				shape: Object.fromEntries(
					Object.entries<z.ZodType>(def.shape).map(([key, member]) => [key, stripDefaults(member)])
				),
				catchall: def.catchall && stripDefaults(def.catchall),
			});
		case 'array':
			return z.core.clone(schema, { ...def, element: stripDefaults(def.element) });
		case 'record':
		case 'map':
		case 'set':
			return z.core.clone(schema, { ...def, valueType: stripDefaults(def.valueType) });
		case 'union':
			return z.core.clone(schema, { ...def, options: (def.options as z.ZodType[]).map(stripDefaults) });
		case 'tuple':
			return z.core.clone(schema, {
				...def,
				items: (def.items as z.ZodType[]).map(stripDefaults),
				rest: def.rest && stripDefaults(def.rest),
			});
		case 'optional':
		case 'nullable':
		case 'readonly':
		case 'nonoptional':
		case 'catch':
			return z.core.clone(schema, { ...def, innerType: stripDefaults(def.innerType) });
		default:
			return schema;
	}
}

/**
 * Compute a schema's default value from `.default()` on it and on anything nested within it.
 * Members without a default are left out, so the result is not necessarily a complete config.
 */
function defaultsOf(schema: z.ZodType): unknown {
	const def = schema._zod.def as any;

	switch (def.type) {
		case 'default':
		case 'prefault':
		case 'catch':
			try {
				return schema.parse(undefined);
			} catch {
				return defaultsOf(def.innerType);
			}
		case 'object': {
			const value: Record<string, unknown> = {};
			for (const [key, member] of Object.entries<z.ZodType>(def.shape)) {
				const inner = defaultsOf(member);
				if (inner !== undefined) value[key] = inner;
			}
			return Object.keys(value).length ? value : undefined;
		}
		default:
			return def.innerType ? defaultsOf(def.innerType) : undefined;
	}
}

/**
 * Manager for configuration files
 */
export class Manager<
	LoadOpts extends LoadOptions = LoadOptions,
	Shape extends Readonly<Record<string, z.ZodType>> = Readonly<Record<string, z.ZodType>>,
	out In extends z.input<z.ZodObject<Shape>> = z.input<z.ZodObject<Shape>>,
	out FileData = z.output<ReturnType<typeof z.deepPartial<z.ZodObject<Shape>>>>,
> extends EventEmitter<{
	load: [path: string, config: FileData, options: Partial<LoadOpts>];
	post_load: [path: string, config: FileData, options: Partial<LoadOpts>];
	load_error: [path: string, stage: 'read' | 'create' | 'parse', error: Error];
	create: [path: string];
	change: [];
	write: [path: string, data: FileData];
	reload: [];
}> {
	public readonly schema: z.ZodObject<Shape>;
	public readonly fileSchema: ReturnType<typeof z.deepPartial<z.ZodObject<Shape>>>;

	protected files: Map<string, File<FileData>> = new Map();

	public readonly data: z.output<z.ZodObject<Shape>>;

	constructor(
		shape: Shape,
		protected options: ManagerOptions = {}
	) {
		super({ captureRejections: true });

		this.schema = z.object(shape);
		this.fileSchema = z.deepPartial(
			stripDefaults(z.object(options.enableIncludes ? { ...shape, include } : shape)) as z.ZodObject<Shape>
		);
		this.data = this.schema.parse(this.defaults);
	}

	/**
	 * A fresh config with only the schema's defaults applied.
	 */
	public get defaults(): z.output<z.ZodObject<Shape>> & In {
		return structuredClone(defaultsOf(this.schema) ?? {}) as z.output<z.ZodObject<Shape>> & In;
	}

	public get<const K extends string | number = FlattenKeys<z.output<z.ZodObject<Shape>>>>(
		key: K
	): GetByString<z.output<z.ZodObject<Shape>>, K> {
		return getByString(this.data, key);
	}

	public set<
		const K extends string | number = FlattenKeys<z.output<z.ZodObject<Shape>>>,
		V = GetByString<z.output<z.ZodObject<Shape>>, K>,
	>(key: K, value: V) {
		setByString(this.data, key, value);
	}

	/**
	 * Deeply merge `config` into the current config. Arrays are replaced rather than combined.
	 */
	public merge(config: PartialRecursive<In>) {
		deepAssign(this.data as object, structuredClone(config) as object, { replaceArrays: true });
		this.emit('change');
	}

	/** Replace the current config with `config`, applying defaults for anything missing. */
	public replace(config: In) {
		for (const key of Object.keys(this.data)) delete (this.data as Record<string, unknown>)[key];
		Object.assign(this.data, this.schema.parse(config));
		this.emit('change');
	}

	loadFile(path: string, options: Partial<LoadOpts>) {
		if (this.files.has(path)) return;

		let json;
		try {
			json = JSON.parse(readFileSync(path, 'utf8'));
		} catch (e: any) {
			if (!options.create || e.code != 'ENOENT') {
				if (!options.optional) throw e;
				this.emit('load_error', path, 'read', e);
				return;
			}

			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, '{}', 'utf-8');
			} catch (e: any) {
				if (!options.optional) throw e;
				this.emit('load_error', path, 'create', e);
				return;
			}

			this.emit('create', path);
			json = {};
		}

		let file: FileData;
		try {
			file = this.fileSchema.parse(json) as FileData;
		} catch (e: any) {
			if (!options.loose) throw e;
			this.emit('load_error', path, 'parse', e);
			file = json;
		}

		this.files.set(path, {
			auto: false,
			wasIncluded: false,
			type: typeFromPath(path),
			...(options[kInit] || {}),
			data: file,
			path,
			options,
		});

		this.emit('load', path, file, options);
		this.merge(file as PartialRecursive<In>);

		if (canInclude(this.options, file))
			for (const include of file.include ?? []) {
				this.loadFile(resolve(dirname(path), include), {
					...options,
					optional: true,
					create: false,
					[kInit]: { ...options[kInit], wasIncluded: true },
				});
			}

		this.emit('post_load', path, file, options);
	}

	/** Get the entry for `path`, adding one for a file that has not been loaded */
	protected fileAt(path: string): File<FileData> {
		const existing = this.files.get(path);
		if (existing) return existing;

		const file: File<FileData> = {
			path,
			data: {} as FileData,
			type: typeFromPath(path),
			auto: false,
			wasIncluded: false,
			options: {},
		};
		this.files.set(path, file);
		return file;
	}

	protected writeFile(file: File<FileData>) {
		mkdirSync(dirname(file.path), { recursive: true });
		writeFileSync(file.path, JSON.stringify(file.data, null, '\t'), 'utf-8');
		this.emit('write', file.path, file.data);
	}

	/**
	 * Replace the contents of the config file at `path` and write it,
	 * then rebuild the current config from the defaults and all loaded files.
	 */
	replaceFile(path: string, config: In) {
		const file = this.fileAt(path);
		file.data = this.fileSchema.parse(config) as FileData;
		this.writeFile(file);
		this.replace(this.defaults);
		for (const file of this.files.values()) this.merge(file.data as PartialRecursive<In>);
	}

	/**
	 * Merge `config` into the current config and into the config file at `path`, then write it.
	 */
	updateFile(path: string, config: PartialRecursive<In>) {
		const file = this.fileAt(path);
		deepAssign(file.data as object, this.fileSchema.parse(config) as object, { replaceArrays: true });
		this.merge(config);
		this.writeFile(file);
	}

	/**
	 * The files `loadDefaults` will try to load, ordered from most global to most local.
	 * @internal
	 */
	@memoize
	public get defaultPaths(): ReadonlyArray<{ path: string; type: FileType }> {
		const paths: { path: string; type: FileType }[] = [];
		const { system, xdg } = this.options;
		if (system) paths.push({ type: 'system', path: join(systemConfigDir, withExtension(system)) });
		if (xdg) paths.push({ type: 'user', path: join(xdgConfigDir, withExtension(xdg)) });
		return paths;
	}

	/**
	 * Load the files from `defaultPaths`. Missing files are skipped unless `options` says otherwise.
	 */
	loadDefaults(options: Partial<LoadOpts> = {}) {
		for (const { path, type } of this.defaultPaths) {
			this.loadFile(path, { optional: true, ...options, [kInit]: { type, auto: true } });
		}
	}

	/**
	 * The file a change of the given type is written to:
	 * the most recently loaded file of that type, or the path `loadDefaults` would use for it.
	 */
	public findPath(type?: FileType): string {
		const loaded = this.files
			.values()
			.filter(file => (!type || file.type == type) && !file.wasIncluded)
			.map(file => file.path)
			.toArray();

		if (loaded.length) return loaded.at(-1)!;

		const fallback = type ? this.defaultPaths.find(entry => entry.type == type) : this.defaultPaths.at(-1);
		if (!fallback) throw new Error(`No ${type ?? 'writable'} configuration file to write to`);
		return fallback.path;
	}

	/**
	 * Merge `config` into the current config and save it.
	 */
	update(config: PartialRecursive<In>, type?: FileType) {
		this.updateFile(this.findPath(type), config);
	}

	reloadFiles(options: Partial<LoadOpts> = {}) {
		const files = this.files
			.values()
			.filter(file => !file.wasIncluded)
			.toArray();

		this.files.clear();
		this.replace(this.defaults);
		for (const file of files) {
			this.loadFile(file.path, { ...options, [kInit]: { type: file.type, auto: file.auto } });
		}
		this.emit('reload');
	}
}
