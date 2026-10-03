import type { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

export type WorkspaceDisplayMode = "inline" | "pip" | "fullscreen";
export interface WorkspaceHostContext { availableDisplayModes?: WorkspaceDisplayMode[]; displayMode?: WorkspaceDisplayMode; theme?: string; styles?: { variables?: Record<string, string>; css?: { fonts?: string } }; }
export interface WorkspaceWidgetState { modelContent?: unknown; privateContent?: Record<string, unknown>; imageIds?: string[]; [key: string]: unknown; }
export interface WorkspaceHostAdapter {
    callServerTool(request: { name: string; arguments: Record<string, unknown> }, options?: { timeout?: number; signal?: AbortSignal }): Promise<{ structuredContent?: unknown; _meta?: Record<string, unknown> }>;
    updateModelContext(value: unknown): Promise<unknown>;
    sendMessage(value: unknown): Promise<{ isError?: boolean }>;
    requestDisplayMode(mode: WorkspaceDisplayMode): Promise<WorkspaceDisplayMode>;
    close(): Promise<void>;
}

interface WorkspaceMcpApps {
    App: typeof App;
    applyDocumentTheme(theme: "light" | "dark"): void;
    applyHostFonts(fonts: string): void;
    applyHostStyleVariables(variables: Record<string, string>): void;
}
type WorkspaceSdkApp = App & { onclose?: () => void; close(): Promise<void> };
type CloseHandler = () => void;
type ToolResultHandler = (result: unknown) => void;
type HostContextHandler = (context: WorkspaceHostContext) => void;
type ToolInputHandler = (input: unknown) => void;
type ToolCancelledHandler = (params: { reason?: string }) => void;
type TeardownHandler = () => Promise<void>;

export class WorkspaceHost {
    readonly app: WorkspaceHostAdapter;
    readonly #version: string;
    #sdkApp: WorkspaceSdkApp;
    #closeHandler?: CloseHandler;
    #toolResultHandler?: ToolResultHandler;
    #hostContextHandler?: HostContextHandler;
    #toolInputHandler?: ToolInputHandler;
    #toolCancelledHandler?: ToolCancelledHandler;
    #teardownHandler?: TeardownHandler;
    #hostContext: WorkspaceHostContext = {};
    #connected = false;
    #reconnecting = false;
    #sizeChangedCleanup?: () => void;

    constructor(version: string) {
        this.#version = version;
        this.#sdkApp = this.#createApp(workspaceMcpApps());
        this.app = {
            callServerTool: (request, options) => this.#sdkApp.callServerTool(request, options),
            updateModelContext: value => this.#sdkApp.updateModelContext(value, { timeout: 5_000 }),
            sendMessage: value => this.#sdkApp.sendMessage(value, { timeout: 5_000 }),
            requestDisplayMode: mode => this.requestDisplayMode(mode),
            close: () => this.close(),
        };
    }

    get hostContext(): Readonly<WorkspaceHostContext> { return this.#hostContext; }
    set onclose(handler: CloseHandler | undefined) { this.#closeHandler = handler; }
    set ontoolresult(handler: ToolResultHandler | undefined) { this.#toolResultHandler = handler; }
    set onhostcontextchanged(handler: HostContextHandler | undefined) { this.#hostContextHandler = handler; }
    set ontoolinput(handler: ToolInputHandler | undefined) { this.#toolInputHandler = handler; }
    set ontoolcancelled(handler: ToolCancelledHandler | undefined) { this.#toolCancelledHandler = handler; }
    set onteardown(handler: TeardownHandler | undefined) { this.#teardownHandler = handler; }

    async connect(): Promise<void> {
        this.#connected = false;
        await this.#sdkApp.connect(undefined, { timeout: 3_000 });
        this.#connected = true;
        this.#hostContext = this.#sdkApp.getHostContext() ?? {};
        this.#hostContextHandler?.(this.#hostContext);
        this.#stopSizeTracking();
        this.#sizeChangedCleanup = this.#sdkApp.setupSizeChangedNotifications();
    }

    async reconnect(): Promise<void> {
        this.#reconnecting = true;
        this.#connected = false;
        this.#stopSizeTracking();
        try {
            await this.#sdkApp.close();
            this.#sdkApp = this.#createApp(workspaceMcpApps());
            await this.connect();
        } finally {
            this.#reconnecting = false;
        }
    }

    updateModelContext(value: unknown): Promise<unknown> { return this.app.updateModelContext(value); }
    sendMessage(value: unknown): Promise<{ isError?: boolean }> { return this.app.sendMessage(value); }
    async requestDisplayMode(mode: WorkspaceDisplayMode): Promise<WorkspaceDisplayMode> { return (await this.#sdkApp.requestDisplayMode({ mode }, { timeout: 1_000 })).mode; }
    async close(): Promise<void> { this.#connected = false; this.#stopSizeTracking(); await this.#sdkApp.close(); }

    readWidgetState(): WorkspaceWidgetState {
        return typeof window === "undefined" ? {} : ((window as Window & { openai?: { widgetState?: WorkspaceWidgetState } }).openai?.widgetState ?? {});
    }
    writeWidgetState(state: WorkspaceWidgetState): void {
        if (typeof window === "undefined") return;
        (window as Window & { openai?: { setWidgetState?: (value: WorkspaceWidgetState) => void } }).openai?.setWidgetState?.(state);
    }

    #createApp(sdk: WorkspaceMcpApps): WorkspaceSdkApp {
        const app = new sdk.App({ name: "portable-devshell-workspace", version: this.#version }, { availableDisplayModes: ["inline", "pip", "fullscreen"] }, { autoResize: false }) as WorkspaceSdkApp;
        const sendSizeChanged = app.sendSizeChanged.bind(app);
        app.sendSizeChanged = params => {
            if (!this.#connected || app !== this.#sdkApp) return Promise.resolve();
            return sendSizeChanged(params).catch(error => { if (this.#connected && app === this.#sdkApp) console.error(error); });
        };
        app.onhostcontextchanged = context => {
            if (context.theme === "light" || context.theme === "dark") sdk.applyDocumentTheme(context.theme);
            if (context.styles?.variables) sdk.applyHostStyleVariables(context.styles.variables);
            if (typeof context.styles?.css?.fonts === "string") sdk.applyHostFonts(context.styles.css.fonts);
            this.#hostContext = { ...this.#hostContext, ...context };
            this.#hostContextHandler?.(this.#hostContext);
        };
        app.ontoolinput = input => this.#toolInputHandler?.(input);
        app.ontoolresult = result => this.#toolResultHandler?.(result);
        app.ontoolcancelled = params => this.#toolCancelledHandler?.(params);
        app.onteardown = async () => { this.#connected = false; this.#stopSizeTracking(); await this.#teardownHandler?.(); return {}; };
        app.onclose = () => {
            if (app !== this.#sdkApp) return;
            const connected = this.#connected;
            this.#connected = false;
            this.#stopSizeTracking();
            if (connected && !this.#reconnecting) this.#closeHandler?.();
        };
        return app;
    }

    #stopSizeTracking(): void { this.#sizeChangedCleanup?.(); this.#sizeChangedCleanup = undefined; }
}

function workspaceMcpApps(): WorkspaceMcpApps {
    const apps = (globalThis as typeof globalThis & { __portableDevshellMcpApps?: WorkspaceMcpApps }).__portableDevshellMcpApps;
    if (!apps) throw new Error("MCP Apps SDK script is unavailable");
    return apps;
}
