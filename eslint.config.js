import shared from 'utilium/eslint';

export default shared(import.meta.dirname).map(config =>
	config.files ? { ...config, files: config.files.map(pattern => 'packages/*/' + pattern) } : config
);
