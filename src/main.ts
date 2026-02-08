import "./style.css";

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly 0: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList extends Array<SpeechRecognitionResult> {}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => any) | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => any)
    | null;
  onend: ((this: SpeechRecognition, ev: Event) => any) | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any)
    | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <main class="app">
    <header class="app__header">
      <h1>Ultra-Light Interview Summarizer</h1>
      <p class="app__subtitle">Fast STT & client-side summarization</p>
    </header>

    <section class="controls">
      <button id="mic-toggle" type="button">Start Interview</button>
      <span id="mic-status" class="status status--idle">Idle</span>
    </section>

    <section class="grid">
      <aside class="panel panel--left">
        <h2>Filler Coach</h2>
        <div class="panel__sub">Spoken via TTS only after 3.5s pause</div>
        <div class="panel__body">
          <div class="pill">Current</div>
          <div id="filler" class="filler-current"></div>
          <div class="pill">History</div>
          <div id="fillers" class="panel__body--scroll fillers-list"></div>
        </div>
      </aside>

      <section class="panel panel--right">
        <h2>Candidate</h2>
        <div class="split">
          <div class="panel panel--inner">
            <h3>Live Transcript</h3>
            <div id="transcript" class="panel__body panel__body--scroll"></div>
          </div>

          <div class="panel panel--inner">
            <h3>Running Summary</h3>
            <div id="summary" class="panel__body"></div>
          </div>
        </div>

        <div class="metrics">
          <h3>Metrics</h3>
          <ul>
            <li>Model load time: <span id="metric-model-load">–</span> ms</li>
          </ul>
        </div>
      </section>
    </section>
  </main>
`;

const micToggle = document.querySelector<HTMLButtonElement>("#mic-toggle");
const micStatus = document.querySelector<HTMLSpanElement>("#mic-status");
const transcriptEl = document.querySelector<HTMLDivElement>("#transcript");
const summaryEl = document.querySelector<HTMLDivElement>("#summary");
const fillerEl = document.querySelector<HTMLDivElement>("#filler");
const fillersEl = document.querySelector<HTMLDivElement>("#fillers");

let isRecording = false;
const modelLoadMetric =
  document.querySelector<HTMLSpanElement>("#metric-model-load");

// Initialize summary worker
const summaryWorker = new Worker(
  new URL("./workers/summaryWorker.ts", import.meta.url),
  { type: "module" },
);

let summaryWorkerReady = false;
let transcriptBuffer: string[] = [];
const SUMMARY_TRIGGER_SENTENCES = 3;
let lastFillerTime = 0;
const FILLER_COOLDOWN_MS = 8000;
let sentencesSinceLastFiller = 0;
let fillerTimer: number | null = null;
let lastFinalTranscriptMs = 0;
let lastInterimTranscriptMs = 0;
let isSpeakingFiller = false;
let lastSpeechActivityMs = 0;
let suspendAutoRestart = false;
let recognitionActive = false;
let summaryInFlight = false;

const FILLER_PAUSE_MS = 3500;
const RESPONSE_WAIT_MS = 6000;
let awaitingResponseUntilMs: number | null = null;
let speechActivityAtFillerMs: number | null = null;
let lockFillersUntilSpeech = false;
const MAX_TRANSCRIPT_SENTENCES = 60;
const SUMMARY_SENTENCES_WINDOW = 30;

function appendFillerHistory(phrase: string) {
  if (!fillersEl) return;
  const now = new Date().toLocaleTimeString();
  const p = document.createElement("p");
  p.textContent = `[${now}] ${phrase}`;
  fillersEl.appendChild(p);
  fillersEl.scrollTop = fillersEl.scrollHeight;
}

function speakTts(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();

    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.pitch = 1.0;

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const en = voices.filter((v) =>
        (v.lang || "").toLowerCase().startsWith("en"),
      );
      return en[0] ?? voices[0] ?? null;
    };

    // Some browsers populate voices async
    const voice = pickVoice();
    if (voice) utter.voice = voice;

    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

async function speakFiller(phrase: string): Promise<void> {
  if (isSpeakingFiller) return;
  if (!phrase.trim()) return;

  isSpeakingFiller = true;
  suspendAutoRestart = true;
  // Prevent the recognizer from transcribing our own TTS
  stopRecognition();
  try {
    await speakTts(phrase);
  } finally {
    isSpeakingFiller = false;
    suspendAutoRestart = false;
    if (isRecording) startRecognition();
  }
}

summaryWorker.onmessage = (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "worker-loaded") {
    summaryWorker.postMessage({ type: "init" });
    return;
  }

  if (msg.type === "model-load") {
    if (modelLoadMetric) {
      if (typeof msg.durationMs === "number") {
        modelLoadMetric.textContent = Math.max(
          0,
          Math.round(msg.durationMs),
        ).toString();
      } else if (msg.progress < 100) {
        modelLoadMetric.textContent = `${msg.progress}%`;
      } else if (msg.progress === 100) {
        modelLoadMetric.textContent = "0";
      }
    }
    if (msg.progress === 100) {
      summaryWorkerReady = true;
    }
    return;
  }

  if (msg.type === "ready") {
    summaryWorkerReady = true;
    return;
  }

  if (msg.type === "summary") {
    if (summaryEl) {
      summaryEl.textContent = msg.summary;
    }
    summaryInFlight = false;
    return;
  }

  if (msg.type === "filler") {
    if (fillerEl) {
      fillerEl.textContent = msg.phrase;
      appendFillerHistory(String(msg.phrase ?? ""));
      void speakFiller(String(msg.phrase ?? ""));
      window.setTimeout(() => {
        if (fillerEl) fillerEl.textContent = "";
      }, 4500);
    }
    return;
  }

  if (msg.type === "error") {
    summaryInFlight = false;
    console.error("Summary worker error:", msg.error);
  }
};

if (modelLoadMetric) modelLoadMetric.textContent = "Loading...";

const SpeechRecognitionCtor: SpeechRecognitionConstructor | undefined =
  window.SpeechRecognition ?? window.webkitSpeechRecognition;

let recognition: SpeechRecognition | null = null;
let interimEl: HTMLParagraphElement | null = null;
let currentUtteranceStartMs: number | null = null;

function appendFinalTranscript(text: string) {
  const now = new Date().toLocaleTimeString();
  const p = document.createElement("p");
  p.textContent = `[${now}] ${text}`;
  transcriptEl?.appendChild(p);
  transcriptEl!.scrollTop = transcriptEl!.scrollHeight;

  // Add to transcript buffer for summarization
  transcriptBuffer.push(text);
  if (transcriptBuffer.length > MAX_TRANSCRIPT_SENTENCES) {
    transcriptBuffer = transcriptBuffer.slice(-MAX_TRANSCRIPT_SENTENCES);
  }
  sentencesSinceLastFiller++;
  lastFinalTranscriptMs = performance.now();
  lastSpeechActivityMs = lastFinalTranscriptMs;
  lockFillersUntilSpeech = false;
  awaitingResponseUntilMs = null;
  speechActivityAtFillerMs = null;

  // Trigger summarization every N sentences
  if (
    transcriptBuffer.length >= SUMMARY_TRIGGER_SENTENCES &&
    summaryWorkerReady &&
    !summaryInFlight
  ) {
    const fullText = transcriptBuffer
      .slice(-SUMMARY_SENTENCES_WINDOW)
      .join(" ");
    summaryInFlight = true;
    summaryWorker.postMessage({
      type: "summarize",
      text: fullText,
      startMs: performance.now(),
    });
  }
}

function setInterimTranscript(text: string) {
  if (!transcriptEl) return;
  if (!interimEl) {
    interimEl = document.createElement("p");
    interimEl.style.opacity = "0.7";
    transcriptEl.appendChild(interimEl);
  }
  interimEl.textContent = text ? `(hearing…) ${text}` : "";
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  if (text) {
    lastInterimTranscriptMs = performance.now();
    lastSpeechActivityMs = lastInterimTranscriptMs;
    lockFillersUntilSpeech = false;
    awaitingResponseUntilMs = null;
    speechActivityAtFillerMs = null;
  }
}

function clearInterimTranscript() {
  if (!interimEl) return;
  interimEl.textContent = "";
}

function stopRecognition(): void {
  try {
    recognition?.stop();
  } catch {
    // ignore
  }
}

function startRecognition(): void {
  if (!SpeechRecognitionCtor) return;
  if (recognitionActive) return;

  recognition = recognition ?? new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onstart = () => {
    currentUtteranceStartMs = performance.now();
    recognitionActive = true;
    micStatus!.textContent = "Listening…";
    micStatus!.className = "status status--active";
  };

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    micStatus!.textContent = `STT error: ${event.error}`;
    micStatus!.className = "status status--error";
  };

  recognition.onend = () => {
    clearInterimTranscript();
    recognitionActive = false;
    // Chrome sometimes stops automatically; keep it running while recording.
    if (isRecording && !suspendAutoRestart) {
      try {
        recognition?.start();
      } catch {
        // ignore
      }
    }
  };

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    if (currentUtteranceStartMs === null) {
      currentUtteranceStartMs = performance.now();
    }

    let interim = "";
    let finalized = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? "";
      if (!text) continue;
      if (result.isFinal) {
        finalized += text;
      } else {
        interim += text;
      }
    }

    if (interim) setInterimTranscript(interim.trim());

    if (finalized.trim()) {
      clearInterimTranscript();
      appendFinalTranscript(finalized.trim());
      currentUtteranceStartMs = performance.now();
    }
  };

  try {
    recognition.start();
  } catch {
    // ignore
  }
}

if (!micToggle || !micStatus || !transcriptEl) {
  throw new Error("Missing required UI elements");
}

if (!SpeechRecognitionCtor) {
  micToggle.disabled = true;
  micToggle.textContent = "SpeechRecognition unsupported";
  micStatus.textContent = "This browser doesn't support Web Speech API.";
  micStatus.className = "status status--error";
} else {
  micToggle.disabled = false;
  micToggle.textContent = "Start Interview";
  micStatus.textContent = "Ready";
  micStatus.className = "status status--idle";
}

micToggle?.addEventListener("click", async () => {
  isRecording = !isRecording;

  if (isRecording) {
    micToggle.textContent = "Stop Interview";
    transcriptBuffer = [];
    sentencesSinceLastFiller = 0;
    summaryInFlight = false;
    const now = performance.now();
    lastFillerTime = now;
    lastFinalTranscriptMs = now;
    lastInterimTranscriptMs = now;
    lastSpeechActivityMs = now;
    awaitingResponseUntilMs = null;
    speechActivityAtFillerMs = null;
    lockFillersUntilSpeech = false;

    if (fillerTimer !== null) {
      window.clearInterval(fillerTimer);
    }
    fillerTimer = window.setInterval(() => {
      if (!isRecording) return;
      const now = performance.now();

      if (lockFillersUntilSpeech) return;

      // If we already inserted a filler, wait 5-6s for the candidate to speak.
      // If they don't, ask a follow-up once and then stop until speech resumes.
      if (
        awaitingResponseUntilMs !== null &&
        speechActivityAtFillerMs !== null
      ) {
        if (now >= awaitingResponseUntilMs) {
          const spokeSinceFiller =
            lastSpeechActivityMs > speechActivityAtFillerMs;
          if (!spokeSinceFiller && !isSpeakingFiller) {
            // Follow-up prompt
            summaryWorker.postMessage({
              type: "generate-followup",
              context: transcriptBuffer.slice(-6).join(" "),
            });
            lockFillersUntilSpeech = true;
            lastFillerTime = now;
          }
          awaitingResponseUntilMs = null;
          speechActivityAtFillerMs = null;
        }
        return;
      }

      // Only insert a filler if there's a true pause (>5s) in speech activity.
      // This avoids interrupting the user while they're speaking.
      const sinceSpeech = now - lastSpeechActivityMs;
      if (sinceSpeech < FILLER_PAUSE_MS) return;
      if (isSpeakingFiller) return;
      if (now - lastFillerTime < FILLER_COOLDOWN_MS) return;
      if (transcriptBuffer.length === 0) return;

      lastFillerTime = now;
      sentencesSinceLastFiller = 0;
      awaitingResponseUntilMs = now + RESPONSE_WAIT_MS;
      speechActivityAtFillerMs = lastSpeechActivityMs;
      summaryWorker.postMessage({
        type: "generate-filler",
        context: transcriptBuffer.slice(-6).join(" "),
      });
    }, 800);

    startRecognition();
  } else {
    stopRecognition();

    if (fillerTimer !== null) {
      window.clearInterval(fillerTimer);
      fillerTimer = null;
    }

    micToggle.textContent = "Start Interview";
    micStatus!.textContent = "Idle";
    micStatus!.className = "status status--idle";

    // Final summarization on stop if we have content
    if (transcriptBuffer.length > 0 && summaryWorkerReady) {
      summaryWorker.postMessage({
        type: "summarize",
        text: transcriptBuffer.join(" "),
        startMs: performance.now(),
      });
    }
  }
});
