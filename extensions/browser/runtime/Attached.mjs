/** The CLI owns the extension relay. Its public JSON listing exposes the bound
 * Playwright endpoint for the helper's separate client connection. */
export async function attachBrowser(chromium, source, name, execute, env) {
    const extensionEnv = { ...env };
    delete extensionEnv.PLAYWRIGHT_MCP_PROFILE_DIR_NAME;
    if (source.profileDirectory) extensionEnv.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = source.profileDirectory;
    await execute(["attach", "--extension=" + source.channel, "--no-tab-group"], extensionEnv);
    const { stdout } = await execute(["list", "--all", "--json"], extensionEnv, 10000);
    const servers = JSON.parse(stdout).servers.filter(server => server.title === name);
    if (servers.length !== 1 || typeof servers[0].endpoint !== "string")
        throw new Error("The attached Playwright browser did not expose its bound endpoint.");
    return chromium.connect(servers[0].endpoint, { timeout: 10000 });
}
