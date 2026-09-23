# @james-pre/config

A small library for managing configuration files.

## CLI

`@james-pre/config/cli` adds a `config` command to a [Commander](https://github.com/tj/commander.js) program, with `dump`, `get`, `set`, `list`, and `schema`:

```ts
import { configCommand } from '@james-pre/config/cli';

configCommand(program, configManager);
```

Commander is an optional peer dependency, needed only for the CLI.
