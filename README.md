# AI Interview Assistant

**Overview**
This browser based demo transcribes live speech, generates concise summaries, and offers helpful interviewer style filler prompts when there is a real pause. It runs entirely client side using the Web Speech API for transcription and Transformers.js for neural summarization.

## **Setup**

1. Ensure you have Node.js and npm installed.
2. Install dependencies:

```bash
npm install
```

**Run**
Start the development server:

```bash
npm run dev
```

Build a production bundle:

```bash
npm run build
```

## **Files**

Key files in this project include [src/main.ts](src/main.ts) for app orchestration and UI, [src/workers/summaryWorker.ts](src/workers/summaryWorker.ts) for summarization and filler generation, [src/style.css](src/style.css) for styles, and [.github/copilot-instructions.md](.github/copilot-instructions.md) for workspace guidance.

## **How It Works**

- Transcription uses the browser Web Speech API with continuous recognition and interim results.
- Summarization runs in a Web Worker. It uses a neural model via Transformers.js (Xenova distilbart cnn 12 6) to produce abstractive summaries.
- Filler prompts are generated contextually from recent speech and spoken via speech synthesis only after a true pause. Cooldowns and follow up prompts prevent interruptions and looping.

## **Notes**

- Model load time is shown in the UI. Runtime latency varies by device.
