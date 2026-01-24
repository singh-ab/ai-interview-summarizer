// AudioWorkletProcessor that collects mono PCM and posts Float32Array chunks.

// TypeScript in typical app builds doesn't include AudioWorklet global typings
// for module files; declare the minimal surface we need.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(name: string, processorCtor: any): void;

class PcmProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array;
  private writeIndex = 0;

  constructor() {
    super();
    // Send ~2048 samples per message to reduce overhead.
    this.buffer = new Float32Array(2048);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Use channel 0; downmixing is handled by the main thread if needed.
    const channel = input[0];
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const remaining = this.buffer.length - this.writeIndex;
      const toCopy = Math.min(remaining, channel.length - offset);
      this.buffer.set(
        channel.subarray(offset, offset + toCopy),
        this.writeIndex,
      );
      this.writeIndex += toCopy;
      offset += toCopy;

      if (this.writeIndex >= this.buffer.length) {
        // Copy out to avoid transferring the internal buffer.
        const out = this.buffer.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this.writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
