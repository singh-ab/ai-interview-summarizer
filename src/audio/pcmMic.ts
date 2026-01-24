export interface PcmMicEvents {
  onStart?: () => void;
  onStop?: () => void;
  onPcmChunk?: (
    pcm: Float32Array,
    sampleRate: number,
    timestamp: number,
  ) => void;
  onError?: (error: Error) => void;
}

export class PcmMicRecorder {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private readonly events: PcmMicEvents;

  constructor(events: PcmMicEvents = {}) {
    this.events = events;
  }

  async start(): Promise<void> {
    if (this.audioContext) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.audioContext = new AudioContext();
      await this.audioContext.audioWorklet.addModule(
        new URL("./pcmProcessor.ts", import.meta.url),
      );

      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "pcm-processor",
        {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        },
      );

      this.workletNode.port.onmessage = (event: MessageEvent) => {
        const pcm = event.data as Float32Array;
        const ts = performance.now();
        this.events.onPcmChunk?.(pcm, this.audioContext!.sampleRate, ts);
      };

      this.sourceNode.connect(this.workletNode);
      this.events.onStart?.();
    } catch (e) {
      this.events.onError?.(e as Error);
      this.stop();
      throw e;
    }
  }

  stop(): void {
    try {
      this.workletNode?.port.close();
    } catch {
      // ignore
    }

    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }

    this.workletNode = null;
    this.sourceNode = null;
    this.events.onStop?.();
  }
}
