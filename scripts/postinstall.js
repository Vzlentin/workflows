/**
 * The postinstall of the package: in a global install, the setup of `dist/setup.js`. npm 12 runs no install script by
 * default, so the installed command runs the same setup on its first start. Plain JavaScript, as Node does not strip
 * types under `node_modules`. Other installs, such as `npm ci` in a checkout without `dist/`, do nothing, and an error
 * never fails the npm install: a failed global install of a new package leaves its `bin` link pointing to nothing.
 */
if (process.env.npm_config_global === "true") {
	try {
		const { PACKAGE, setup } = await import("../dist/setup.js");
		await setup(PACKAGE);
	} catch (error) {
		console.warn(`workflows: setup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
