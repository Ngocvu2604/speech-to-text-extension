import { filterEnglishContent } from './filter.js';

export class SentenceBuffer {

  constructor(options = {}) {
    this.onInterimUpdate = options.onInterimUpdate || (() => {});
    this.onSentenceFinalized = options.onSentenceFinalized || (() => {});
    this.onSkipped = options.onSkipped || (() => {});

    this.currentInterimText = '';
    this.accumulatedFinalText = '';
    this.sentenceFlushTimer = null;

    this.recentFinalSentences = [];
    this.sessionEnglishHistory = [];
    this.MAX_RECENT_HISTORY = 12;
  }

  getSessionEnglishHistory() {
    return [...this.sessionEnglishHistory];
  }

  normalizeTokens(str) {
    if (!str) return [];
    return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
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
        return nonOverlapping ? `${existing} ${nonOverlapping}` : existing;
      }
    }
    return `${existing} ${incoming}`;
  }

  handleSpeechResult(event) {
    let uncommittedInterimTranscript = '';
    let hasNewFinal = false;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = (result[0]?.transcript || '').trim();
      if (!transcript) continue;

      if (result.isFinal) {
        hasNewFinal = true;
        if (this.accumulatedFinalText) {
          this.accumulatedFinalText += ' ' + transcript;
        } else {
          this.accumulatedFinalText = transcript;
        }
      } else {
        uncommittedInterimTranscript = transcript;
      }
    }

    this.currentInterimText = uncommittedInterimTranscript.trim();
    if (this.currentInterimText) {
      const filterResult = filterEnglishContent(this.currentInterimText);
      this.onInterimUpdate({
        english: this.currentInterimText,
        isEnglish: filterResult.isEnglish
      });
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

  evaluateAndFlushBuffer(isImmediateEnd = false) {
    clearTimeout(this.sentenceFlushTimer);

    const text = this.accumulatedFinalText.trim();
    if (!text) return;

    const sentenceEndRegex = /([.?!])\s+/;
    if (sentenceEndRegex.test(text)) {
      const match = text.match(sentenceEndRegex);
      const splitIndex = match.index + match[1].length;
      const completedSentence = text.slice(0, splitIndex).trim();
      const remainder = text.slice(splitIndex).trim();

      if (completedSentence) {
        this.commitFinalSentence(completedSentence);
      }
      this.accumulatedFinalText = remainder;
      if (this.accumulatedFinalText) {
        this.evaluateAndFlushBuffer(isImmediateEnd);
      }
      return;
    }

    const words = text.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const hasTerminalEnding = /[.?!]$/.test(text);

    if (hasTerminalEnding && wordCount >= 2) {
      this.commitFinalSentence(text);
      this.accumulatedFinalText = '';
      return;
    }

    const hasClauseBreak = /[,;:—–]$/.test(text);
    if (hasClauseBreak && wordCount >= 10) {
      this.commitFinalSentence(text);
      this.accumulatedFinalText = '';
      return;
    }

    if (wordCount >= 18) {
      this.commitFinalSentence(text);
      this.accumulatedFinalText = '';
      return;
    }

    if (isImmediateEnd && wordCount >= 2) {
      this.commitFinalSentence(text);
      this.accumulatedFinalText = '';
      return;
    }

    this.sentenceFlushTimer = setTimeout(() => {
      if (this.accumulatedFinalText) {
        const pending = this.accumulatedFinalText.trim();
        const pendingWords = pending.split(/\s+/).filter(Boolean);
        if (pendingWords.length >= 3) {
          this.commitFinalSentence(pending);
          this.accumulatedFinalText = '';
        }
      }
    }, 900);
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
    console.log(`[NgheGiang-Diag][3.LangFilter] Evaluation: isEnglish=${filterCheck.isEnglish}, reason=${filterCheck.reason}, charLen=${formattedText.length}`);

    if (!filterCheck.isEnglish) {
      console.log(`[NgheGiang-Diag][3.LangFilter] Discarded non-English segment. Reason: ${filterCheck.reason}`);
      this.onSkipped({
        text: formattedText,
        reason: filterCheck.reason
      });
      return;
    }

    const cleanTokens = formattedText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const normalizedNew = cleanTokens.join(' ');
    if (!normalizedNew) return;

    if (this.recentFinalSentences.includes(normalizedNew)) {
      console.log('[NgheGiang-Diag][4.Buffer] Deduplication: suppressed identical repeating sentence.');
      return;
    }

    if (this.recentFinalSentences.length > 0) {
      const lastSent = this.recentFinalSentences[0];
      if (lastSent.includes(normalizedNew) && normalizedNew.length >= 15) {
        console.log('[NgheGiang-Diag][4.Buffer] Deduplication: new sentence is substring of previous sentence.');
        return;
      }

      if (normalizedNew.startsWith(lastSent) && normalizedNew.length > lastSent.length) {
        const lastSentTokens = lastSent.split(/\s+/);
        const remainingTokens = cleanTokens.slice(lastSentTokens.length);
        if (remainingTokens.length >= 3) {
          formattedText = words.slice(lastSentTokens.length).join(' ');
          formattedText = formattedText.charAt(0).toUpperCase() + formattedText.slice(1);
          if (!/[.?!,;:]$/.test(formattedText) && remainingTokens.length >= 4) {
            formattedText += '.';
          }
          console.log('[NgheGiang-Diag][4.Buffer] Deduplication: stripped cumulative prefix. Remaining:', formattedText);
        } else {
          return;
        }
      } else {
        const lastWords = lastSent.split(/\s+/);
        const newWords = cleanTokens;
        const maxOverlap = Math.min(5, lastWords.length, newWords.length);
        for (let len = maxOverlap; len >= 1; len--) {
          const tailLast = lastWords.slice(-len).join(' ');
          const headNew = newWords.slice(0, len).join(' ');
          if (tailLast === headNew) {
            const strippedWords = words.slice(len);
            if (strippedWords.length >= 2) {
              formattedText = strippedWords.join(' ');
              formattedText = formattedText.charAt(0).toUpperCase() + formattedText.slice(1);
              console.log('[NgheGiang-Diag][4.Buffer] Deduplication: stripped boundary overlap words:', len);
            }
            break;
          }
        }
      }
    }

    const finalTokens = formattedText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const finalNorm = finalTokens.join(' ');
    if (!finalNorm) return;

    this.recentFinalSentences.unshift(finalNorm);
    if (this.recentFinalSentences.length > this.MAX_RECENT_HISTORY) {
      this.recentFinalSentences.pop();
    }

    this.sessionEnglishHistory.push(formattedText);
    this.currentInterimText = '';
    this.onInterimUpdate({ english: '', isEnglish: true });

    const now = new Date();
    const timeString = now.toTimeString().split(' ')[0];
    const sentenceId = 'sent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

    console.log(`[NgheGiang-Diag][4.Buffer] Sentence finalized: id=${sentenceId}, words=${words.length}, time=${timeString}`);

    this.onSentenceFinalized({
      id: sentenceId,
      english: formattedText,
      timestamp: timeString
    });
  }

  handleRecognitionEnd() {
    clearTimeout(this.sentenceFlushTimer);

    let pending = '';
    if (this.accumulatedFinalText && this.accumulatedFinalText.trim()) {
      pending = this.accumulatedFinalText.trim();
      this.accumulatedFinalText = '';
    }

    if (this.currentInterimText && this.currentInterimText.trim()) {
      const interimClean = this.currentInterimText.trim();
      if (pending) {
        pending = this.mergeWithOverlapDeduplication(pending, interimClean);
      } else {
        const words = interimClean.split(/\s+/).filter(Boolean);
        if (words.length >= 3) {
          pending = interimClean;
        }
      }
      this.currentInterimText = '';
    }

    if (pending) {
      this.commitFinalSentence(pending);
    }

    this.onInterimUpdate({ english: '', isEnglish: true });
  }

  flush() {
    clearTimeout(this.sentenceFlushTimer);

    let pending = '';
    if (this.accumulatedFinalText && this.accumulatedFinalText.trim()) {
      pending = this.accumulatedFinalText.trim();
      this.accumulatedFinalText = '';
    }

    if (this.currentInterimText && this.currentInterimText.trim()) {
      const interimClean = this.currentInterimText.trim();
      if (pending) {
        pending = this.mergeWithOverlapDeduplication(pending, interimClean);
      } else {
        const words = interimClean.split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          pending = interimClean;
        }
      }
      this.currentInterimText = '';
    }

    if (pending) {
      this.commitFinalSentence(pending);
    }

    this.onInterimUpdate({ english: '', isEnglish: true });
  }

  reset() {
    clearTimeout(this.sentenceFlushTimer);
    this.currentInterimText = '';
    this.accumulatedFinalText = '';
    this.recentFinalSentences = [];
    this.sessionEnglishHistory = [];
  }
}
