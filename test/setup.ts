// A rebase or a Git hook that runs the tests exports `GIT_DIR` and others, which point every Git of the tests at the
// repository of the caller. `sandbox()` sets the Git variables that the tests need.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("GIT_")) delete process.env[name];
}
