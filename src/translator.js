const translationCache = new Map();
const MAX_CACHE_SIZE = 150;

function getCached(key) {
  const normalized = key.trim().toLowerCase();
  if (translationCache.has(normalized)) {
    return translationCache.get(normalized);
  }
  return null;
}

function setCache(key, value) {
  const normalized = key.trim().toLowerCase();
  if (translationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(normalized, value);
}

async function translateWithGoogleGTX(text, timeoutMs = 7000, signal = null) {
  const cleanText = text.trim();
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(cleanText)
}`;

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      timeoutCtrl.abort();
    } else {
      signal.addEventListener('abort', () => timeoutCtrl.abort(), { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: timeoutCtrl.signal
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Google GTX: Bị giới hạn tần suất (429). Hãy thử lại sau giây lát.');
      }
      throw new Error(`Google GTX phản hồi mã lỗi: ${response.status
}`);
    }

    const data = await response.json();
    if (!data || !data[0]) {
      throw new Error('Dữ liệu dịch trả về không đúng định dạng');
    }

    const translated = data[0].map(item => item[0]).filter(Boolean).join(' ').trim();
    return translated;
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal && signal.aborted) {
        throw err;
      }
      throw new Error('Google GTX: Quá thời gian chờ phản hồi (Timeout 7s).');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash'
];

let cachedWorkingModel = null;

async function translateWithGemini(text, apiKey, context = '', timeoutMs = 9000, signal = null) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Chưa cấu hình Gemini API Key. Vui lòng vào Cài đặt để nhập Key miễn phí từ Google AI Studio.');
  }

  const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '').trim();
  if (!cleanKey) {
    throw new Error('Gemini API Key rỗng. Vui lòng dán khóa hợp lệ từ Google AI Studio.');
  }

  let promptInstruction = '';
  if (context && context.trim()) {
    promptInstruction = `Bạn là trợ lý dịch bài giảng học thuật tiếng Anh sang tiếng Việt thời gian thực.
Ngữ cảnh lời giảng vừa nói trước đó: "${context.trim()
}"
Câu mới cần dịch: "${text
}"
Yêu cầu: Dịch câu mới sang tiếng Việt chuẩn xác theo ngữ cảnh trên, giữ đúng đại từ, thuật ngữ chuyên ngành và tính liên kết ý.
CHỈ trả về duy nhất bản dịch tiếng Việt của câu mới, không kèm giải thích, không lặp lại câu trước, không dùng ngoặc kép.`;
  } else {
    promptInstruction = `Bạn là trợ lý dịch phụ đề bài giảng học thuật thời gian thực từ tiếng Anh sang tiếng Việt. Hãy dịch đoạn văn bản sau sang tiếng Việt một cách tự nhiên, chuẩn xác theo văn phong sư phạm/học thuật, ngắn gọn và rõ nghĩa. CHỈ trả về duy nhất bản dịch tiếng Việt, không kèm giải thích hay ngoặc kép.\n\n"${text
}"`;
  }

  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: promptInstruction
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  const modelsToTry = cachedWorkingModel
    ? [cachedWorkingModel, ...GEMINI_MODELS.filter(m => m !== cachedWorkingModel)]
    : GEMINI_MODELS;

  let lastError = null;

  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model
}:generateContent`;

    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        timeoutCtrl.abort();
      } else {
        signal.addEventListener('abort', () => timeoutCtrl.abort(), { once: true });
      }
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey
        },
        body: JSON.stringify(requestBody),
        signal: timeoutCtrl.signal
      });

      if (!response.ok) {
        let errJson = null;
        let errMsg = '';
        try {
          errJson = await response.json();
          errMsg = errJson?.error?.message || '';
        } catch {
          errMsg = await response.text().catch(() => '');
        }

        if (response.status === 404) {
          lastError = new Error(`Gemini: Model ${model
} không khả dụng.`);
          continue;
        }

        if (response.status === 400 || response.status === 403) {
          const lower = errMsg.toLowerCase();
          if (lower.includes('api_key_invalid') || lower.includes('key not valid') || lower.includes('api key not valid') || lower.includes('forbidden')) {
            throw new Error('Gemini: API Key không hợp lệ hoặc đã bị vô hiệu hóa.');
          }
          if (lower.includes('location is not supported') || lower.includes('unsupported location')) {
            throw new Error('Gemini: Vùng địa lý hiện tại chưa được Google hỗ trợ (cần VPN).');
          }
          throw new Error(`Gemini: Yêu cầu bị từ chối (${response.status
}: ${errMsg.slice(0, 90) || 'Lỗi tham số'
})`);
        }

        if (response.status === 429) {
          throw new Error('Gemini: Vượt hạn mức sử dụng (Quota / Rate limit 15 RPM). Vui lòng thử lại sau.');
        }

        throw new Error(`Gemini: Máy chủ báo mã ${response.status
} (${errMsg.slice(0, 80) || 'Lỗi không xác định'
})`);
      }

      const result = await response.json();
      const candidatePart = result.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!candidatePart) {
        const finishReason = result.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY') {
          throw new Error('Gemini: Bản dịch bị bộ lọc an toàn của Google chặn.');
        }
        if (finishReason && finishReason !== 'STOP') {
          throw new Error(`Gemini: Bản dịch bị ngắt quãng (${finishReason
})`);
        }
        throw new Error('Gemini: Không nhận được nội dung bản dịch từ AI.');
      }

      cachedWorkingModel = model;
      return candidatePart.trim().replace(/^["']|["']$/g, '');
    } catch (err) {
      if (err.name === 'AbortError') {
        if (signal && signal.aborted) {
          throw err;
        }
        throw new Error(`Gemini: Quá thời gian chờ phản hồi (Timeout ${Math.round(timeoutMs/1000)
}s).`);
      }
      lastError = err;

      if (err.message.includes('API Key không hợp lệ') || err.message.includes('Vượt hạn mức') || err.message.includes('Timeout')) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('Không thể kết nối đến máy chủ Gemini.');
}

export async function testGeminiConnection(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { ok: false, message: 'Vui lòng dán API Key trước khi kiểm tra.' };
  }
  const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '').trim();
  const startTime = performance.now();
  try {
    const testResult = await translateWithGemini('Hello', cleanKey, '', 6500);
    const elapsed = Math.round(performance.now() - startTime);
    return {
      ok: true,
      message: `Kết nối thành công! Gemini phản hồi: "${testResult
}" (${elapsed
}ms).`,
      latency: elapsed
    };
  } catch (err) {
    return {
      ok: false,
      message: err.message || 'Không thể kết nối đến máy chủ Gemini.'
    };
  }
}

async function translateWithMyMemory(text, timeoutMs = 7000, signal = null) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)
}&langpair=en|vi`;

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      timeoutCtrl.abort();
    } else {
      signal.addEventListener('abort', () => timeoutCtrl.abort(), { once: true });
    }
  }

  try {
    const response = await fetch(url, { signal: timeoutCtrl.signal });
    if (!response.ok) {
      throw new Error(`MyMemory API lỗi mã: ${response.status
}`);
    }

    const data = await response.json();
    if (data.responseStatus !== 200 && data.responseStatus !== '200') {
      throw new Error(data.responseDetails || 'Lỗi từ máy chủ MyMemory');
    }

    return (data.responseData?.translatedText || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal && signal.aborted) {
        throw err;
      }
      throw new Error('MyMemory: Quá thời gian chờ phản hồi (Timeout 7s).');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

let localTranslatorInstance = null;

async function translateWithLocalAI(text) {

  if (typeof window !== 'undefined' && window.ai && window.ai.translator) {
    if (!localTranslatorInstance) {
      const canTranslate = await window.ai.translator.capabilities();
      if (canTranslate.available === 'no') {
        throw new Error('Local AI chưa sẵn sàng hoặc không hỗ trợ cặp ngôn ngữ en -> vi trên máy này.');
      }
      localTranslatorInstance = await window.ai.translator.create({
        sourceLanguage: 'en',
        targetLanguage: 'vi'
      });
    }
    const result = await localTranslatorInstance.translate(text);
    return result;
  }
  throw new Error('Trình duyệt hiện tại chưa hỗ trợ Chrome Built-in AI Translation (yêu cầu Chrome 131+ bật flag).');
}

export async function translateText(text, options = {}) {
  const cleanText = text.trim();
  if (!cleanText) {
    return { translatedText: '', engineUsed: 'none', fromCache: false };
  }

  const cached = getCached(cleanText);
  if (cached && !options.context) {
    return { translatedText: cached, engineUsed: 'cache', fromCache: true };
  }

  const engine = options.engine || 'google-gtx';
  let translatedResult = '';
  let finalEngine = engine;

  try {
    if (engine === 'gemini') {
      translatedResult = await translateWithGemini(cleanText, options.geminiApiKey, options.context, options.timeoutMs, options.signal);
    } else if (engine === 'local-ai') {
      translatedResult = await translateWithLocalAI(cleanText);
    } else if (engine === 'mymemory') {
      translatedResult = await translateWithMyMemory(cleanText, options.timeoutMs, options.signal);
    } else {

      translatedResult = await translateWithGoogleGTX(cleanText, options.timeoutMs, options.signal);
    }
  } catch (primaryError) {

    if (engine === 'gemini') {
      throw primaryError;
    }

    console.warn(`[NgheGiang] Lỗi khi dịch bằng ${engine
}:`, primaryError.message);

    if (engine !== 'google-gtx') {
      try {
        console.info('[NgheGiang] Đang chuyển sang chế độ dự phòng miễn phí Google GTX...');
        translatedResult = await translateWithGoogleGTX(cleanText, 6000, options.signal);
        finalEngine = 'google-gtx (fallback)';
      } catch (fallbackError) {
        throw new Error(`Cả ${engine
} và dự phòng Google GTX đều không thể dịch: ${primaryError.message
}`);
      }
    } else {
      throw primaryError;
    }
  }

  if (translatedResult && !translatedResult.startsWith('(')) {
    setCache(cleanText, translatedResult);
  }

  return {
    translatedText: translatedResult,
    engineUsed: finalEngine,
    fromCache: false
  };
}
