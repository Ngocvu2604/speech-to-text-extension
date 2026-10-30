const VIETNAMESE_DIACRITICS_REGEX = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i;

const DISTINCT_VIETNAMESE_PHRASES = [
  'xin chao', 'cac ban', 'chung ta', 'sinh vien', 'thay co', 'giang vien',
  'tieng viet', 'tiengviet', 'khong co', 'duoc khong', 'nhu the nao',
  'cam on', 'tam biet', 'chuc mung', 'bai giang', 'dung roi', 'hoc sinh'
];

const DISTINCT_VIETNAMESE_WORDS = new Set([
  'chao', 'nguoi', 'chungta', 'sinhvien', 'giangvien', 'hocsinh',
  'tiengviet', 'khong', 'duoc', 'nhung', 'chucmung', 'camon',
  'dungroi', 'baigiang', 'thayco'
]);

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on',
  'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we',
  'say', 'her', 'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their',
  'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
  'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take', 'people', 'into',
  'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now',
  'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two',
  'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any',
  'these', 'give', 'day', 'most', 'us', 'is', 'am', 'are', 'was', 'were', 'been', 'being',
  'has', 'had', 'does', 'did', 'doing', 'lecture', 'student', 'class', 'today', 'slide',
  'slides', 'concept', 'problem', 'solution', 'example', 'learn', 'study', 'exam', 'course',
  'professor', 'system', 'data', 'result', 'process', 'point', 'important', 'question',
  'answer', 'screen', 'please', 'next', 'let', 'start', 'show', 'mean', 'means', 'call',
  'called', 'here', 'right', 'okay', 'well', 'talk', 'discuss', 'chapter', 'section', 'board'
]);

export function filterEnglishContent(text) {
  if (!text || typeof text !== 'string') {
    return { isEnglish: false, reason: 'empty', cleanText: '' };
  }

  const cleanText = text.trim();
  if (cleanText.length < 2) {
    return { isEnglish: false, reason: 'too_short', cleanText };
  }

  if (VIETNAMESE_DIACRITICS_REGEX.test(cleanText)) {
    return { isEnglish: false, reason: 'vietnamese_detected', cleanText };
  }

  const lowerText = cleanText.toLowerCase();

  for (const phrase of DISTINCT_VIETNAMESE_PHRASES) {
    if (lowerText.includes(phrase)) {
      return { isEnglish: false, reason: 'vietnamese_unaccented', cleanText };
    }
  }

  const words = lowerText
    .replace(/[^\p{L}\s']/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);

  if (words.length === 0) {
    return { isEnglish: false, reason: 'no_alphabetic_words', cleanText };
  }

  let viWordCount = 0;
  let enWordCount = 0;

  for (const w of words) {
    const cleanWord = w.replace(/^'+|'+$/g, '');
    if (DISTINCT_VIETNAMESE_WORDS.has(cleanWord)) {
      viWordCount++;
    }
    if (COMMON_ENGLISH_WORDS.has(cleanWord)) {
      enWordCount++;
    }
  }

  if (viWordCount >= 1 && enWordCount === 0) {
    return { isEnglish: false, reason: 'vietnamese_unaccented', cleanText };
  }

  const nonLatinMatch = cleanText.match(/[^\u0000-\u007F\u00A0-\u00FF]/g);
  if (nonLatinMatch && nonLatinMatch.length > cleanText.length * 0.25) {
    return { isEnglish: false, reason: 'non_latin_script', cleanText };
  }

  return { isEnglish: true, reason: 'valid_english', cleanText };
}
