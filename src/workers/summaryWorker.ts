import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

// Toggle to control summarization strategy.
// true  -> use neural abstractive summarizer (Xenova/distilbart-cnn-12-6).
// false -> use fast extractive bullet summarizer instead.
const USE_NEURAL_SUMMARY = true;

type SummaryPipeline = any;

let summarizer: SummaryPipeline | null = null;
let isInitializing = false;
let loadStartMs: number | null = null;

function bulletSummarize(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "Not enough content yet.";

  // Split into sentences without lookbehind, to keep browser support broad.
  const sentences = text
    .replace(/([.!?])\s+/g, "$1|")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return "Not enough content yet.";

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
    "just",
    "like",
    "um",
    "uh",
    "you",
    "know",
  ]);

  type Scored = { index: number; score: number; text: string };
  const scored: Scored[] = [];

  sentences.forEach((s, index) => {
    const tokens = s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(" ")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

    let score = 0;
    for (const t of tokens) {
      if (t.length < 3) continue;
      if (stopwords.has(t)) continue;
      score += 1;
    }

    if (score > 0 && s.length >= 40) {
      scored.push({ index, score, text: s });
    }
  });

  if (scored.length === 0) {
    // Fallback: return first 1–2 sentences as a single bullet.
    const fallback = sentences.slice(0, 2).join(" ");
    return `• ${fallback}`;
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const top = scored.slice(0, 3);

  return top
    .sort((a, b) => a.index - b.index)
    .map((s) => `• ${s.text}`)
    .join("\n");
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "init") {
    if (!USE_NEURAL_SUMMARY) {
      // Fast path: no model to load, report ready immediately.
      self.postMessage({
        type: "model-load",
        status: "Bullet summarizer ready",
        progress: 100,
        durationMs: 0,
      });
      self.postMessage({ type: "ready" });
      return;
    }

    if (isInitializing || summarizer) return;
    isInitializing = true;

    try {
      self.postMessage({
        type: "model-load",
        status: "Loading summarization model...",
        progress: 0,
      });

      loadStartMs = performance.now();

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

      const loadEnd = performance.now();
      const durationMs =
        typeof loadStartMs === "number" ? loadEnd - loadStartMs : undefined;

      self.postMessage({
        type: "model-load",
        status: "Summarization ready",
        progress: 100,
        durationMs,
      });

      self.postMessage({ type: "ready" });
    } catch (error: any) {
      self.postMessage({ type: "error", error: error.message });
    } finally {
      isInitializing = false;
    }
  }

  if (msg.type === "summarize") {
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

      // Fast extractive summarization by default.
      if (!USE_NEURAL_SUMMARY) {
        const start = performance.now();
        const summary = bulletSummarize(text);
        const end = performance.now();
        self.postMessage({
          type: "summary",
          summary,
          startMs: start,
          endMs: end,
        });
        return;
      }

      if (!summarizer) {
        self.postMessage({
          type: "error",
          error: "Summarizer not initialized",
        });
        return;
      }

      // Original neural summarization path (kept for reference).
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

      const end = performance.now();
      self.postMessage({
        type: "summary",
        summary,
        startMs: msg.startMs ?? end,
        endMs: end,
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

      const tokens = recent
        .replace(/[?.!]/g, " ")
        .split(" ")
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

      const contentTokens = tokens.filter(
        (w) => w.length >= 4 && !stopwords.has(w),
      );

      const freq = new Map<string, number>();

      // Unigrams
      for (const w of contentTokens) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }

      // Simple bigrams to capture phrases like "energy levels"
      for (let i = 0; i < tokens.length - 1; i++) {
        const a = tokens[i];
        const b = tokens[i + 1];
        if (!a || !b) continue;
        if (stopwords.has(a) && stopwords.has(b)) continue;
        const phrase = `${a} ${b}`;
        freq.set(phrase, (freq.get(phrase) ?? 0) + 1);
      }

      let keyword = "";
      let bestScore = 0;
      for (const [key, score] of freq.entries()) {
        if (score > bestScore) {
          bestScore = score;
          keyword = key;
        }
      }

      if (keyword) {
        keyword = keyword
          .replace(/[^a-z0-9\s-]/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

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

      const pick = (arr: string[]) =>
        arr[Math.floor(Math.random() * arr.length)];

      let filler = "";
      if (isQuestion) filler = pick(questionResponse);
      else if (hasNumbers) filler = pick(numeric);
      else
        filler = Math.random() < 0.6 ? pick(acknowledging) : pick(encouraging);

      // Light contextuality: acknowledge the key topic without "thinking" language.
      if (keyword && keyword.length >= 3 && Math.random() < 0.35) {
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
