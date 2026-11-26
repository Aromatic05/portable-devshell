/** Map DOM input into the remote viewport; text composition is local until commit. */
export class BrowserInput {
    private width = 0;
    private height = 0;
    private move?: { type: string; x: number; y: number };
    private moving = false;
    private keys = new Map<string, string>();
    private buttons = new Map<number, { x: number; y: number; button: string }>();
    private composing = false;

    constructor(private screen: HTMLCanvasElement, private keyboard: HTMLTextAreaElement, private send: (value: unknown) => Promise<void>) {
        screen.addEventListener("pointermove", event => this.pointerMove(event));
        screen.addEventListener("pointerdown", event => {
            if (!this.width) return;
            keyboard.focus({ preventScroll: true });
            screen.setPointerCapture(event.pointerId);
            event.preventDefault();
            const value = { ...this.coordinates(event), button: this.button(event) };
            this.buttons.set(event.button, value);
            void this.send({ type: "down", ...value });
        });
        screen.addEventListener("pointerup", event => {
            if (!this.buttons.delete(event.button)) return;
            void this.send({ type: "up", ...this.coordinates(event), button: this.button(event) });
        });
        screen.addEventListener("pointercancel", () => this.release());
        screen.addEventListener("lostpointercapture", () => this.releaseButtons());
        screen.addEventListener("contextmenu", event => event.preventDefault());
        screen.addEventListener("wheel", event => {
            if (!this.width) return;
            event.preventDefault();
            void this.send({ type: "wheel", dx: event.deltaX, dy: event.deltaY });
        }, { passive: false });
        keyboard.addEventListener("keydown", event => {
            if (!this.width || event.isComposing || this.composing || event.key === "Process" || event.key === "Dead") return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
            const key = event.key === " " ? "Space" : event.key;
            if (key === "Unidentified") return;
            event.preventDefault();
            this.keys.set(event.code, key);
            void this.send({ type: "keyDown", key });
        });
        keyboard.addEventListener("keyup", event => {
            const key = this.keys.get(event.code);
            if (key === undefined) return;
            this.keys.delete(event.code);
            event.preventDefault();
            void this.send({ type: "keyUp", key });
        });
        keyboard.addEventListener("compositionstart", () => { this.composing = true; });
        keyboard.addEventListener("compositionend", event => {
            this.composing = false;
            if (event.data) void this.send({ type: "text", text: event.data });
            keyboard.value = "";
        });
        keyboard.addEventListener("input", () => {
            if (!this.composing && keyboard.value) {
                void this.send({ type: "text", text: keyboard.value });
                keyboard.value = "";
            }
        });
        keyboard.addEventListener("paste", event => {
            event.preventDefault();
            const text = event.clipboardData?.getData("text");
            if (text) void this.send({ type: "text", text });
        });
        keyboard.addEventListener("blur", () => this.release());
    }

    dimensions(width: number, height: number): void { this.width = width; this.height = height; }

    release(): void {
        this.move = undefined;
        for (const key of this.keys.values()) void this.send({ type: "keyUp", key });
        this.keys.clear();
        this.releaseButtons();
    }

    private releaseButtons() {
        for (const value of this.buttons.values()) void this.send({ type: "up", ...value });
        this.buttons.clear();
    }

    private coordinates(event: MouseEvent) {
        const rect = this.screen.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(this.width - 1, (event.clientX - rect.left) * this.width / rect.width)),
            y: Math.max(0, Math.min(this.height - 1, (event.clientY - rect.top) * this.height / rect.height)),
        };
    }

    private button(event: MouseEvent) { return ["left", "middle", "right"][event.button] ?? "left"; }

    private pointerMove(event: PointerEvent) {
        if (!this.width) return;
        this.move = { type: "move", ...this.coordinates(event) };
        if (this.moving) return;
        this.moving = true;
        void (async () => {
            try {
                while (this.move) {
                    const current = this.move;
                    this.move = undefined;
                    await this.send(current);
                }
            } finally { this.moving = false; }
        })();
    }
}
