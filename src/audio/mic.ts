export interface MicEvents {
  onStart?: () => void;
  onStop?: () => void;
  onChunk?: (chunk: Blob, timestamp: number) => void;
  onError?: (error: Error) => void;
}

export class MicRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private readonly events: MicEvents;

  constructor(events: MicEvents = {}) {
    this.events = events;
  }

  async start(): Promise<void> {
    if (this.mediaRecorder) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: "audio/webm;codecs=opus",
      });

      this.mediaRecorder.onstart = () => {
        this.events.onStart?.();
      };

      this.mediaRecorder.onstop = () => {
        this.events.onStop?.();
        this.cleanupStream();
      };

      this.mediaRecorder.onerror = (ev: Event) => {
        const anyEv = ev as any;
        const err =
          anyEv?.error instanceof Error
            ? anyEv.error
            : new Error(String(anyEv?.error ?? "MediaRecorder error"));
        this.events.onError?.(err);
      };

      this.mediaRecorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data.size > 0) {
          this.events.onChunk?.(ev.data, performance.now());
        }
      };

      this.mediaRecorder.start(250); // emit chunks every 250ms
    } catch (err) {
      this.events.onError?.(err as Error);
      this.cleanupStream();
      throw err;
    }
  }

  stop(): void {
    if (!this.mediaRecorder) return;
    this.mediaRecorder.stop();
    this.mediaRecorder = null;
  }

  private cleanupStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
