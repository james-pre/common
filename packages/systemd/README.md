# @james-pre/systemd

A small library for installing and managing systemd services, as either system units or user units (`systemctl --user`).

```ts
import { Service, command } from '@james-pre/systemd';

const service = new Service('example', { user: true });

service.install(
	{
		unit: {
			Unit: { Description: 'Example daemon' },
			Service: { ExecStart: command(process.execPath, '/opt/example/daemon.js') },
			Install: { WantedBy: 'default.target' },
		},
	},
	{ enable: true, start: true }
);

const { active, enabled, pid } = service.status();

service.restart();
service.uninstall();
```

A unit can also be installed from its text (`{ text }`), or linked where it is (`{ link: path }`).
Linked system units are labeled for SELinux automatically, since systemd can not read them otherwise.

User services only run while their user is logged in, unless lingering is enabled with `setLinger(true)`.

## CLI

`@james-pre/systemd/cli` adds a `service` command to a [Commander](https://github.com/tj/commander.js) program, with `install`, `uninstall`, `status`, `start`, `stop`, `restart`, `enable`, and `disable`:

```ts
import { serviceCommand } from '@james-pre/systemd/cli';

serviceCommand(program, {
	service: user => new Service('example', { user }),
	source: () => ({ link: '/opt/example/example.service' }),
});
```

Commander is an optional peer dependency, needed only for the CLI.
