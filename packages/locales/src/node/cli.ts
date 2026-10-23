#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
import * as io from 'ioium/node';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fallbackLocale } from '../locale.js';
import { merge, read } from './files.js';
import { generateTypes } from './typegen.js';

const usage = `Usage: locales typegen [options] [dirs...]

Generate types for the translation keys of each package directory (default: .)

Options:
    -d, --directory <path>    The directory in each package with its translations (default: locales)
    -o, --output <path>       Where to write the generated module, relative to each package (default: src/.locale.ts)
    -r, --reference <locale>  The locale whose translations take precedence (default: ${fallbackLocale})
    -v, --verbose             Enable verbose output
    -h, --help                Show this help message
`;

let parsed;
try {
	parsed = parseArgs({
		allowPositionals: true,
		options: {
			directory: { type: 'string', short: 'd', default: 'locales' },
			output: { type: 'string', short: 'o', default: 'src/.locale.ts' },
			reference: { type: 'string', short: 'r', default: fallbackLocale },
			verbose: { type: 'boolean', short: 'v', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
} catch (error) {
	io.error(io.errorText(error));
	console.error(usage);
	process.exit(1);
}

const {
	positionals: [command, ...dirs],
	values: opts,
} = parsed;

if (opts.help) {
	console.error(usage);
	process.exit(0);
}

if (command != 'typegen') {
	if (command) io.error('Unknown command: ' + command);
	console.error(usage);
	process.exit(1);
}

io._setDebugOutput(opts.verbose);

for (const dir of (dirs.length ? dirs : ['.']).map(dir => resolve(dir))) {
	const localesDir = join(dir, opts.directory);
	if (!existsSync(localesDir)) {
		io.debug('No locales in', dir);
		continue;
	}

	const output = resolve(dir, opts.output);

	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, generateTypes(merge(read(localesDir), opts.reference)), 'utf8');

	console.log('Generated', output);
}
