// SPDX-License-Identifier: LGPL-3.0-or-later
import { Command } from 'commander';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { styleText } from 'node:util';
import { Monorepo } from './monorepo.js';
import $pkg from '../package.json' with { type: 'json' };

const cli = new Command('monorepo')
	.version($pkg.version)
	.description($pkg.description)
	.option('--root <path>', 'the monorepo to use, instead of the closest one');

function repo(): Monorepo {
	const { root } = cli.opts();
	return root ? new Monorepo(resolve(root)) : Monorepo.find();
}

const cli_release = cli.command('release').alias('rl').description('Manage monorepo releases');

cli_release
	.command('list')
	.alias('ls')
	.description('List the current version of each workspace')
	.action(() => {
		const { workspaces } = repo();
		const width = Math.max(...workspaces.map(ws => ws.id.length));
		for (const ws of workspaces) {
			const version = ws.version ?? styleText('dim', 'none');
			if (ws.private) console.log(ws.id.padEnd(width), version, styleText('dim', '(private)'));
			else console.log(ws.id.padEnd(width), version);
		}
	});

cli_release
	.command('changed')
	.description('List the workspaces that changed since their latest release')
	.action(() => {
		const monorepo = repo();
		for (const ws of monorepo.workspaces) {
			const changed = monorepo.hasChanged(ws);
			if (changed === null) console.log(ws.id, styleText('dim', '(no releases)'));
			else if (changed) console.log(ws.id);
		}
	});

cli_release
	.command('log')
	.description('Show the commits since the latest release of a workspace, or of every workspace')
	.argument('[workspace]', 'the workspace to show, by ID, package name, or path')
	.action(query => {
		const monorepo = repo();

		if (query) {
			for (const line of monorepo.changes(monorepo.workspace(query))) console.log(line);
			return;
		}

		for (const ws of monorepo.workspaces) {
			const changes = monorepo.changes(ws);
			if (!changes.length) continue;
			console.log(styleText('bold', `--- ${ws.id} ---`));
			for (const line of changes) console.log(line);
		}
	});

cli_release
	.command('diff')
	.description('Show the changes to a workspace since a release, by default its latest')
	.argument('<workspace>', 'the workspace, by ID, package name, or path')
	.argument('[version]', 'the release to compare against')
	.action((query, version) => {
		const monorepo = repo();
		const ws = monorepo.workspace(query);
		const tag = version ? `${ws.id}@${version}` : monorepo.latestRelease(ws);
		if (!tag) cli_release.error(`error: ${ws.id} has no releases`);
		monorepo.git.show('diff', `${tag}..HEAD`, '--', ws.path);
	});

cli_release
	.command('history')
	.description('List the releases of a workspace')
	.argument('<workspace>', 'the workspace, by ID, package name, or path')
	.action(query => {
		const monorepo = repo();
		const ws = monorepo.workspace(query);
		for (const tag of monorepo.releases(ws)) console.log(tag.slice(ws.id.length + 1));
	});

cli_release
	.command('create-tags')
	.description("Tag the current version of every workspace that hasn't been")
	.action(() => {
		for (const tag of repo().createTags()) console.log('Created tag', tag);
	});

cli_release
	.command('force-update')
	.alias('retag')
	.description("Move the tag of a workspace's current version to HEAD")
	.argument('<workspace>', 'the workspace, by ID, package name, or path')
	.action(query => {
		const monorepo = repo();
		console.log('Moved', monorepo.retag(monorepo.workspace(query)));
	});

function release(bumps: [query: string, bump: string][], opts: { push: boolean }) {
	const monorepo = repo();
	const releases = monorepo.release(
		bumps.map(([query, bump]) => [monorepo.workspace(query), bump]),
		opts
	);
	for (const { tag, changes } of releases) {
		console.log('\n+ ' + tag);
		for (const line of changes) console.log(line);
	}
}

cli_release
	.command('version')
	.description('Release workspaces: bump their versions, then commit them together, tag, and push them')
	.argument(
		'<releases...>',
		'each workspace, by ID, package name, or path, and anything `npm version` takes, like core:patch or client:1.2.3'
	)
	.option('--no-push', 'commit and tag without pushing')
	.action((releases: string[], opts) =>
		release(
			releases.map(arg => {
				const separator = arg.lastIndexOf(':');
				if (separator < 1) throw new Error(`expected <workspace>:<bump>, got '${arg}'`);
				return [arg.slice(0, separator), arg.slice(separator + 1)];
			}),
			opts
		)
	);

for (const bump of ['patch', 'minor', 'major']) {
	cli_release
		.command(bump)
		.description(`Shortcut for version <workspace>:${bump} for each workspace`)
		.argument('<workspaces...>', 'the workspaces, by ID, package name, or path')
		.option('--no-push', 'commit and tag without pushing')
		.action((queries: string[], opts) =>
			release(
				queries.map(query => [query, bump]),
				opts
			)
		);
}

cli_release
	.command('update')
	.description('Set the version of a workspace that other workspaces depend on')
	.argument('<workspaces...>', 'the dependent workspaces, by ID, package name, or path')
	.requiredOption(
		'--to <dependency>',
		"the workspace to depend on, with a range to write exactly, like core@^1.2.3, or without one to use its version with each dependent's existing operator"
	)
	.action((queries: string[], opts: { to: string }) => {
		const monorepo = repo();
		const separator = opts.to.lastIndexOf('@');
		const [query, range] = separator > 0 ? [opts.to.slice(0, separator), opts.to.slice(separator + 1)] : [opts.to];
		const target = monorepo.workspace(query);
		const updates = monorepo.updateDependency(
			queries.map(query => monorepo.workspace(query)),
			target,
			range
		);
		for (const { workspace, field, from, to } of updates)
			console.log(`${workspace.id} (${field}): ${from} -> ${to}`);
	});

cli_release
	.command('resolve')
	.description(
		'Print the path of the workspace a release tag is for, checking its version. In GitHub Actions, also set the outputs path, id, name, and version'
	)
	.argument('<tag>', 'the release tag, like example@1.2.3')
	.action(tag => {
		const ws = repo().resolveTag(tag);
		console.log(ws.path);

		const outputs = process.env.GITHUB_OUTPUT;
		if (outputs) appendFileSync(outputs, `path=${ws.path}\nid=${ws.id}\nname=${ws.name}\nversion=${ws.version}\n`);
	});

export default cli;
