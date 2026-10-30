import { filterEnglishContent } from './filter.js';

export class SentenceBuffer {

  constructor(options = {}) {
    this.onInterimUpdate = options.onInterimUpdate || (() => {});
    this.onSentenceFinalized = options.onSentenceFinalized || (() => {});
    this.onSkipped = options.onSkipped || (() => {});

    this.currentInterimText = '';
    this.accumulatedFinalText = '';
    this.sentenceFlushTimer = null;
    this.interimClauseTimer = null;

    this.recentFinalSentences = [];
    this.MAX_RECENT_HISTORY = 6;
  }

  handleSpeechResult(event) {
    let interimTranscript = '';
    let hasNewFinal = false;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript || '';

      if (result.isFinal) {
        hasNewFinal = true;
        const cleanedPart = transcript.trim();
        if (cleanedPart) {
          if (this.accumulatedFinalText) {
            this.accumulatedFinalText += ' ' + cleanedPart;
          } else {
            this.accumulatedFinalText = cleanedPart;
          }
        }
      } else {
        interimTranscript += transcript;
      }
    }

    this.currentInterimText = interimTranscript.trim();
    if (this.currentInterimText) {
      const filterResult = filterEnglishContent(this.currentInterimText);
      this.onInterimUpdate({
        english: this.currentInterimText,
        isEnglish: filterResult.isEnglish
      });

      const interimWords = this.currentInterimText.split(/\s+/).filter(Boolean);
      if (interimWords.length >= 10 && /[.?!,;]$/.test(this.currentInterimText)) {
        if (!this.accumulatedFinalText) {
          this.accumulatedFinalText = this.currentInterimText;
          this.currentInterimText = '';
          this.evaluateAndFlushBuffer();
        }
      }
    } else if (!hasNewFinal) {
      this.onInterimUpdate({ english: '', isEnglish: true });
    }

    if (hasNewFinal && this.accumulatedFinalText) {
      this.evaluateAndFlushBuffer();
    }
  }

  handleTranscriptText(text, isFinal = true) {
    if (!text || !text.trim()) return;
    const clean = text.trim();

    if (isFinal) {
      if (this.accumulatedFinalText) {
        this.accumulatedFinalText = this.mergeWithOverlapDeduplication(this.accumulatedFinalText, clean);
      } else {
        this.accumulatedFinalText = clean;
      }
      this.evaluateAndFlushBuffer();
    } else {
      this.currentInterimText = clean;
      const filterResult = filterEnglishContent(this.currentInterimText);
      this.onInterimUpdate({
        english: this.currentInterimText,
        isEnglish: filterResult.isEnglish
      });
    }
  }

  mergeWithOverlapDeduplication(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;

    const existingWords = existing.trim().split(/\s+/).filter(Boolean);
    const incomingWords = incoming.trim().split(/\s+/).filter(Boolean);

    const maxOverlap = Math.min(4, existingWords.length, incomingWords.length);
    for (let len = maxOverlap; len >= 1; len--) {
      const existingEnd = existingWords.slice(-len).map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '')).join(' ');
      const incomingStart = incomingWords.slice(0, len).map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '')).join(' ');
      if (existingEnd && existingEnd === incomingStart) {

        const nonOverlapping = incomingWords.slice(len).join(' ');
        return nonOverlapping ? `${existing
} ${nonOverlapping
}` : existing;
      }
    }
    return `${existing
} ${incoming
}`;
  }

  evaluateAndFlushBuffer() {
    clearTimeout(this.sentenceFlushTimer);
    clearTimeout(this.interimClauseTimer);

    const text = this.accumulatedFinalText.trim();
    if (!text) return;

    const words = text.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const hasTerminalEnding = /[.?!]$/.test(text);
    const hasClauseBreak = /[,;:—–]$/.test(text);

    if (hasTerminalEnding && wordCount >= 2) {
      this.commitFinalSentence(text);
      this.accumulatedFinalText = '';
      return;
    }

    if (hasClauseBreak && wordCount >= 3) {
      this.commitFinalSentence(text);
      this.accumulatedFinalText = '';
      return;
    }

    if (wordCount >= 6) {
      this.commitFinalSentence(text);
      this.accumulatedFinalText = '';
      return;
    }

    this.sentenceFlushTimer = setTimeout(() => {
      if (this.accumulatedFinalText) {
        const pending = this.accumulatedFinalText.trim();
        if (pending) {
          this.commitFinalSentence(pending);
          this.accumulatedFinalText = '';
        }
      }
    }, 450);
  }

  commitFinalSentence(rawSentence) {
    if (!rawSentence) return;

    let formattedText = rawSentence.trim();
    if (formattedText.length === 0) return;

    formattedText = formattedText.charAt(0).toUpperCase() + formattedText.slice(1);

    const words = formattedText.split(/\s+/).filter(Boolean);
    if (!/[.?!,;:]$/.test(formattedText)) {
      if (words.length >= 4) {
        formattedText += '.';
      }
    }

    formattedText = formattedText.replace(/\.{2,}/g, '.').replace(/,\./g, '.');

    const filterCheck = filterEnglishContent(formattedText);
    console.log(`[NgheGiang-Diag][3.LangFilter] Evaluation: isEnglish=${filterCheck.isEnglish
}, reason=${filterCheck.reason
}, charLen=${formattedText.length
}`);

    if (!filterCheck.isEnglish) {
      console.log(`[NgheGiang-Diag][3.LangFilter] Discarded non-English segment. Reason: ${filterCheck.reason
}`);
      this.onSkipped({
        text: formattedText,
        reason: filterCheck.reason
      });
      return;
    }

    const normalizedNew = formattedText.toLowerCase().replace(/[.,!?;:'"()—–]/g, '').replace(/\s+/g, ' ').trim();
    if (!normalizedNew) return;

    const isDuplicate = this.recentFinalSentences.some(past => past === normalizedNew);

    if (isDuplicate) {
      console.log('[NgheGiang-Diag][4.Buffer] Deduplication: suppressed identical repeating sentence.');
      return;
    }

    this.recentFinalSentences.unshift(normalizedNew);
    if (this.recentFinalSentences.length > this.MAX_RECENT_HISTORY) {
      this.recentFinalSentences.pop();
    }

    this.currentInterimText = '';
    this.onInterimUpdate({ english: '', isEnglish: true });

    const now = new Date();
    const timeString = now.toTimeString().split(' ')[0];
    const sentenceId = 'sent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

    console.log(`[NgheGiang-Diag][4.Buffer] Sentence finalized: id=${sentenceId
}, words=${words.length
}, time=${timeString
}`);

    this.onSentenceFinalized({
      id: sentenceId,
      english: formattedText,
      timestamp: timeString
    });
  }

  handleRecognitionEnd() {
    clearTimeout(this.sentenceFlushTimer);
    clearTimeout(this.interimClauseTimer);

    if (this.accumulatedFinalText && this.accumulatedFinalText.trim()) {
      this.commitFinalSentence(this.accumulatedFinalText.trim());
      this.accumulatedFinalText = '';
    } else if (this.currentInterimText && this.currentInterimText.trim()) {
      const text = this.currentInterimText.trim();
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length >= 2) {
        const filterCheck = filterEnglishContent(text);
        if (filterCheck.isEnglish) {
          this.commitFinalSentence(text);
        }
      }
      this.currentInterimText = '';
      this.onInterimUpdate({ english: '', isEnglish: true });
    }
  }

  flush() {
    this.handleRecognitionEnd();
  }

  reset() {
    clearTimeout(this.sentenceFlushTimer);
    clearTimeout(this.interimClauseTimer);
    this.currentInterimText = '';
    this.accumulatedFinalText = '';
    this.recentFinalSentences = [];
  }
}
