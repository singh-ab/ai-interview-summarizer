import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

type SummaryPipeline = any;

let summarizer: SummaryPipeline | null = null;
let isInitializing = false;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "init") {
    if (isInitializing || summarizer) return;
    isInitializing = true;

    try {
      self.postMessage({
        type: "model-load",
        status: "Loading summarization model...",
        progress: 0,
      });

      summarizer = await pipeline(
        "summarization",
        "Xenova/distilbart-cnn-12-6",
        {
          progress_callback: (progress: any) => {
            if (progress.status === "progress" && progress.progress) {
              self.postMessage({
                type: "model-load",
                status: `Loading: ${progress.file}`,
                progress: Math.round(progress.progress),
              });
            }
          },
        },
      );

      self.postMessage({
        type: "model-load",
        status: "Summarization ready",
        progress: 100,
      });

      self.postMessage({ type: "ready" });
    } catch (error: any) {
      self.postMessage({ type: "error", error: error.message });
    } finally {
      isInitializing = false;
    }
  }

  if (msg.type === "summarize") {
    if (!summarizer) {
      self.postMessage({ type: "error", error: "Summarizer not initialized" });
      return;
    }

    try {
      const text = msg.text as string;
      if (!text || text.trim().length < 50) {
        // Skip very short inputs
        self.postMessage({
          type: "summary",
          summary: "Not enough content yet.",
          startMs: msg.startMs,
          endMs: performance.now(),
        });
        return;
      }

      // Basic cleanup for STT errors
      const cleanedText = text
        .replace(/\b(um|uh|like|you know)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      const result = await summarizer(cleanedText, {
        max_length: 150,
        min_length: 30,
        do_sample: false,
      });

      const summary = result?.[0]?.summary_text ?? "Unable to summarize.";

      self.postMessage({
        type: "summary",
        summary,
        startMs: msg.startMs,
        endMs: performance.now(),
      });
    } catch (error: any) {
      self.postMessage({ type: "error", error: error.message });
    }
  }

  if (msg.type === "generate-filler") {
    try {
      // Contextual, rule-based filler phrase generation (no model needed)
      const context = String(msg.context ?? "");
      const normalized = context
        .toLowerCase()
        .replace(/[^a-z0-9\s'?.!]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const recent = normalized.slice(Math.max(0, normalized.length - 500));
      const isQuestion =
        /\?\s*$/.test(recent) ||
        /\b(what|why|how|when|where|which|can you|could you|do you)\b/.test(
          recent,
        );
      const hasNumbers = /\b\d+\b/.test(recent);

      const stopwords = new Set([
        "the",
        "a",
        "an",
        "and",
        "or",
        "but",
        "so",
        "because",
        "then",
        "than",
        "to",
        "of",
        "in",
        "on",
        "for",
        "with",
        "as",
        "at",
        "by",
        "from",
        "this",
        "that",
        "these",
        "those",
        "it",
        "its",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "i",
        "you",
        "we",
        "they",
        "he",
        "she",
        "them",
        "my",
        "your",
        "our",
        "their",
        "me",
        "us",
        "just",
        "like",
        "um",
        "uh",
        "you",
        "know",
      ]);

      const words = recent
        .replace(/[?.!]/g, " ")
        .split(" ")
        .map((w) => w.trim())
        .filter((w) => w.length >= 4 && !stopwords.has(w));

      const freq = new Map<string, number>();
      for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
      const keyword = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

      const acknowledging = [
        "Got it.",
        "Okay.",
        "Understood.",
        "Thanks — please continue.",
        "Mm-hmm.",
      ];
      const encouraging = [
        "Go on.",
        "Please continue.",
        "Take your time.",
        "I'm listening.",
      ];
      const questionResponse = [
        "Good question.",
        "That's a fair question.",
        "Okay — let’s keep going.",
      ];
      const numeric = [
        "Okay — noted.",
        "Got it — noted.",
        "Understood — noted.",
      ];

      const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

      let filler = "";
      if (isQuestion) filler = pick(questionResponse);
      else if (hasNumbers) filler = pick(numeric);
      else filler = Math.random() < 0.6 ? pick(acknowledging) : pick(encouraging);

      // Light contextuality: acknowledge the key topic without "thinking" language.
      if (keyword && Math.random() < 0.35) {
        filler = `Got it — about ${keyword}.`;
      }

      self.postMessage({
        type: "filler",
        phrase: filler,
      });
    } catch (error: any) {
      self.postMessage({ type: "error", error: error.message });
    }
  }

  if (msg.type === "generate-followup") {
    try {
      const followups = [
        "Is everything alright?",
        "Are you still with me?",
        "No rush — just let me know when you're ready.",
        "Take your time. I'm here when you're ready.",
      ];
      const phrase = followups[Math.floor(Math.random() * followups.length)];
      self.postMessage({ type: "filler", phrase });
    } catch (error: any) {
      self.postMessage({ type: "error", error: error.message });
    }
  }
};

self.postMessage({ type: "worker-loaded" });
