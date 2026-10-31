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

    this.committedPerResultIndex = new Map();
    this.lastCommittedCumulativeText = '';

    this.recentFinalSentences = [];
    this.sessionEnglishHistory = [];
    this.MAX_RECENT_HISTORY = 4;
  }

  getSessionEnglishHistory() {
    return [...this.sessionEnglishHistory];
  }

  normalizeTokens(str) {
    if (!str) return [];
    return str.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  }

  extractNewSuffix(fullText, alreadyCommitted) {
    if (!fullText || !fullText.trim()) return '';
    if (!alreadyCommitted || !alreadyCommitted.trim()) return fullText.trim();

    const fullClean = fullText.trim();
    const committedClean = alreadyCommitted.trim();

    const committedTokens = this.normalizeTokens(committedClean);
    const fullTokens = this.normalizeTokens(fullClean);

    if (committedTokens.length === 0) return fullClean;
    if (fullTokens.length === 0) return '';

    if (fullTokens.length <= committedTokens.length) {
      const allMatch = fullTokens.every((tok, idx) => tok === committedTokens[idx]);
      if (allMatch) return '';
    }

    let matchCount = 0;
    while (matchCount < committedTokens.length && matchCount < fullTokens.length) {
      if (committedTokens[matchCount] === fullTokens[matchCount]) {
        matchCount++;
      } else {
        break;
      }
    }

    if (matchCount === committedTokens.length && matchCount < fullTokens.length) {
      const words = fullClean.split(/\s+/);
      const newWords = words.slice(matchCount);
      let result = newWords.join(' ').trim();
      result = result.replace(/^[,;:.—–]+\s*/, '');
      return result;
    }

    const maxOverlap = Math.min(8, committedTokens.length, fullTokens.length);
    for (let len = maxOverlap; len >= 1; len--) {
      const endCommitted = committedTokens.slice(-len).join(' ');
      const startFull = fullTokens.slice(0, len).join(' ');
      if (endCommitted === startFull) {
        const words = fullClean.split(/\s+/);
        const newWords = words.slice(len);
        let result = newWords.join(' ').trim();
        result = result.replace(/^[,;:.—–]+\s*/, '');
        return result;
      }
    }

    return fullClean;
  }

  handleSpeechResult(event) {
    let uncommittedInterimTranscript = '';
    let hasNewFinal = false;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = (result[0]?.transcript || '').trim();
      if (!transcript) continue;

      const alreadyCommitted = this.committedPerResultIndex.get(i) || '';

      if (result.isFinal) {
        hasNewFinal = true;
        const newSuffix = this.extractNewSuffix(transcript, alreadyCommitted);
        if (newSuffix) {
          if (this.accumulatedFinalText) {
            this.accumulatedFinalText += ' ' + newSuffix;
          } else {
            this.accumulatedFinalText = newSuffix;
          }
          this.committedPerResultIndex.set(i, transcript);
        }
      } else {
        const uncommitted = this.extractNewSuffix(transcript, alreadyCommitted);
        if (uncommitted) {
          uncommittedInterimTranscript = uncommitted;
        }
      }
    }

    this.currentInterimText = uncommittedInterimTranscript.trim();
    if (this.currentInterimText) {
      const filterResult = filterEnglishContent(this.currentInterimText);
      this.onInterimUpdate({
        english: this.currentInterimText,
        isEnglish: filterResult.isEnglish
      });

      clearTimeout(this.interimClauseTimer);
      const interimWords = this.currentInterimText.split(/\s+/).filter(Boolean);

      let pauseMs = 1200;
      if (/[.?!]$/.test(this.currentInterimText) && interimWords.length >= 3) {
        pauseMs = 650;
      } else if (/[,;:—–]$/.test(this.currentInterimText) && interimWords.length >= 4) {
        pauseMs = 850;
      } else if (interimWords.length >= 10) {
        pauseMs = 950;
      }

      if (interimWords.length >= 3) {
        this.interimClauseTimer = setTimeout(() => {
          if (this.currentInterimText && !this.accumulatedFinalText) {
            const activeIndex = event.results.length - 1;
            const activeResult = event.results[activeIndex];
            const fullTranscript = (activeResult?.[0]?.transcript || '').trim();

            const clause = this.currentInterimText;
            this.committedPerResultIndex.set(activeIndex, fullTranscript || clause);

            this.accumulatedFinalText = clause;
            this.currentInterimText = '';
            this.evaluateAndFlushBuffer();
          }
        }, pauseMs);
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
      const newPart = this.extractNewSuffix(clean, this.lastCommittedCumulativeText);
      if (!newPart) return;

      this.lastCommittedCumulativeText = clean;

      if (this.accumulatedFinalText) {
        this.accumulatedFinalText = this.mergeWithOverlapDeduplication(this.accumulatedFinalText, newPart);
      } else {
        this.accumulatedFinalText = newPart;
      }
      this.evaluateAndFlushBuffer();
    } else {
      const uncommitted = this.extractNewSuffix(clean, this.lastCommittedCumulativeText);
      this.currentInterimText = uncommitted || clean;
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

    if (wordCount >= 5) {
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
    }, 600);
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

    if (this.recentFinalSentences.length > 0 && this.recentFinalSentences[0] === normalizedNew) {
      console.log('[NgheGiang-Diag][4.Buffer] Deduplication: suppressed identical repeating sentence.');
      return;
    }

    this.recentFinalSentences.unshift(normalizedNew);
    if (this.recentFinalSentences.length > this.MAX_RECENT_HISTORY) {
      this.recentFinalSentences.pop();
    }

    this.sessionEnglishHistory.push(formattedText);
    this.lastCommittedCumulativeText = formattedText;
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

    let pendingToCommit = '';
    if (this.accumulatedFinalText && this.accumulatedFinalText.trim()) {
      pendingToCommit = this.accumulatedFinalText.trim();
      this.accumulatedFinalText = '';
    }

    if (this.currentInterimText && this.currentInterimText.trim()) {
      const interimClean = this.currentInterimText.trim();
      if (pendingToCommit) {
        pendingToCommit = this.mergeWithOverlapDeduplication(pendingToCommit, interimClean);
      } else {
        const words = interimClean.split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          pendingToCommit = interimClean;
        }
      }
      this.currentInterimText = '';
    }

    if (pendingToCommit) {
      this.commitFinalSentence(pendingToCommit);
    }

    this.onInterimUpdate({ english: '', isEnglish: true });
    this.committedPerResultIndex.clear();
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
    this.sessionEnglishHistory = [];
    this.committedPerResultIndex.clear();
    this.lastCommittedCumulativeText = '';
  }
}
