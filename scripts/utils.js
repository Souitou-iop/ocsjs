const { exec } = require('child_process');
const path = require('path');

/** 将 exec 错误信息输出到 stdout */
function execOut(command, ...opts) {
	let options = {};
	let callback = undefined;

	if (typeof opts[0] === 'function') {
		callback = opts[0];
	} else if (typeof opts[0] === 'object') {
		options = { ...opts[0] };
		if (typeof opts[1] === 'function') {
			callback = opts[1];
		}
	}

	const cwd = options.cwd ? path.resolve(__dirname, options.cwd) : process.cwd();
	const localBin = path.join(cwd, 'node_modules', '.bin');
	const rootBin = path.resolve(__dirname, '../node_modules/.bin');
	options.env = {
		...process.env,
		...(options.env || {}),
		PATH: `${localBin}:${rootBin}:${process.env.PATH}`
	};

	const cmd = exec(command, options, callback);
	if (cmd.stdout) cmd.stdout.pipe(process.stdout);
	if (cmd.stderr) cmd.stderr.pipe(process.stdout);
	return cmd;
}

exports.execOut = execOut;
