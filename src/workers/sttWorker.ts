import {
  pipeline,
  AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

export interface SttInitMessage {
  type: "init";
  language?: string;
}

export interface SttAudioPcmMessage {
  type: "audio-pcm";
  pcm: Float32Array;
  startMs: number;
  endMs: number;
}

export interface SttStopMessage {
  type: "stop";
}

export type SttWorkerInMessage =
  | SttInitMessage
  | SttAudioPcmMessage
  | SttStopMessage;

export interface SttTranscriptMessage {
  type: "transcript";
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
}

export interface SttReadyMessage {
  type: "ready";
}

export interface SttErrorMessage {
  type: "error";
  error: string;
}

export interface SttModelLoadMessage {
  type: "model-load";
  progress: number;
  status: string;
}

export type SttWorkerOutMessage =
  | SttTranscriptMessage
  | SttReadyMessage
  | SttErrorMessage
  | SttModelLoadMessage;

let initialized = false;
let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
// language hint is unused for English-only models

// Send ready signal as soon as worker loads
const readyMsg: SttReadyMessage = { type: "ready" };
self.postMessage(readyMsg);

async function transcribePcm(
  pcm: Float32Array,
  startMs: number,
  endMs: number,
) {
  if (!transcriber) return;

  try {
    const inferStart = performance.now();
    // For English-only models (e.g., whisper-tiny.en), do not pass `language`.
    // Tune chunking to improve accuracy on small models.
    const opts: any = {
      return_timestamps: false,
      chunk_length_s: 15,
      stride_length_s: 5,
    };
    const result: any = await (transcriber as any)(pcm, opts);
    const inferEnd = performance.now();

    const text = Array.isArray(result)
      ? result
          .map((r: any) => r.text)
          .join(" ")
          .trim()
      : (result.text ?? "").trim();

    if (text) {
      const out: SttTranscriptMessage = {
        type: "transcript",
        text,
        isFinal: true,
        startMs: startMs ?? inferStart,
        endMs: endMs ?? inferEnd,
      };
      self.postMessage(out);
    }
  } catch (e) {
    const err: SttErrorMessage = {
      type: "error",
      error: `Transcription failed: ${(e as Error).message}`,
    };
    self.postMessage(err);
  }
}

self.onmessage = async (event: MessageEvent<SttWorkerInMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init": {
      try {
        // language hint ignored for English-only model
        self.postMessage({
          type: "model-load",
          status: "Loading Whisper base model...",
          progress: 0,
        } as SttModelLoadMessage);

        // Use whisper-base.en for better accuracy (~150MB)
        const pipe: any = await pipeline(
          "automatic-speech-recognition",
          "Xenova/whisper-base.en",
          {
            device: "auto", // WebGPU if available, else WASM
          },
        );
        transcriber = pipe;

        initialized = true;
        self.postMessage({
          type: "model-load",
          status: "Model ready",
          progress: 100,
        } as SttModelLoadMessage);
      } catch (e) {
        const err: SttErrorMessage = {
          type: "error",
          error: `Model init failed: ${(e as Error).message}`,
        };
        self.postMessage(err);
      }
      break;
    }

    case "audio-pcm": {
      if (!initialized || !transcriber) {
        const err: SttErrorMessage = {
          type: "error",
          error: "STT worker not initialized",
        };
        self.postMessage(err);
        return;
      }

      await transcribePcm(msg.pcm, msg.startMs, msg.endMs);
      break;
    }

    case "stop": {
      // Main thread flushes any remaining audio; nothing to do here.
      break;
    }
  }
};
