interface Frame { width: number; height: number; jpeg: Uint8Array }

/** Decode at most one frame at a time and replace any pending stale frame. */
export class FrameView {
    private latest?: Frame;
    private rendering = false;
    private generation = 0;

    constructor(private canvas: HTMLCanvasElement, private dimensions: (width: number, height: number) => void, private report: (error: unknown) => void) {}

    push(frame: Frame) {
        this.latest = frame;
        if (this.rendering) return;
        this.rendering = true;
        void this.drain().finally(() => { this.rendering = false; });
    }

    clear() {
        this.generation++;
        this.latest = undefined;
        delete this.canvas.dataset.ready;
        this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    private async drain() {
        while (this.latest) {
            const frame = this.latest;
            this.latest = undefined;
            const generation = this.generation;
            try {
                const image = await createImageBitmap(new Blob([new Uint8Array(frame.jpeg)], { type: "image/jpeg" }));
                try {
                    if (generation !== this.generation) continue;
                    if (this.canvas.width !== image.width) this.canvas.width = image.width;
                    if (this.canvas.height !== image.height) this.canvas.height = image.height;
                    this.canvas.getContext("2d")!.drawImage(image, 0, 0);
                    this.dimensions(frame.width, frame.height);
                    this.canvas.dataset.ready = "true";
                } finally { image.close(); }
            } catch (error) { if (generation === this.generation) this.report(error); }
        }
    }
}
