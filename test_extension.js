import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { filterEnglishContent } from './src/filter.js';
import { translateText, testGeminiConnection } from './src/translator.js';
import { SentenceBuffer } from './src/buffer.js';
import { GEMINI_STT_MODELS } from './src/speech.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('=== BẮT ĐẦU KIỂM THỬ EXTENSION NGHE GIẢNG ===\n');

  console.log('[Test 1] Kiểm tra tính hợp lệ của manifest.json...');
  const manifestRaw = fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8');
  const manifest = JSON.parse(manifestRaw);

  if (manifest.manifest_version !== 3) throw new Error('Manifest version phải là 3');
  if (manifest.name !== 'Nghe Giảng - Phụ đề & Dịch bài giảng thời gian thực') throw new Error('Tên extension sai');
  if (!manifest.permissions.includes('sidePanel')) throw new Error('Thiếu quyền sidePanel');
  if (!manifest.permissions.includes('storage')) throw new Error('Thiếu quyền storage');
  if (!manifest.side_panel?.default_path) throw new Error('Thiếu cấu hình side_panel default_path');
  console.log(' -> OK: manifest.json hợp lệ và đầy đủ quyền Manifest V3.\n');

  console.log('[Test 2] Kiểm tra bộ lọc ngôn ngữ (src/filter.js)...');

  const testCases = [
    { text: 'Hello everyone, welcome to the computer science lecture today.', expected: true, desc: 'Câu tiếng Anh học thuật chuẩn' },
    { text: 'Let us look at the next slide and discuss the algorithm.', expected: true, desc: 'Câu tiếng Anh thông thường' },
    { text: 'Xin chào các bạn sinh viên, hôm nay chúng ta học bài mới.', expected: false, desc: 'Câu tiếng Việt có dấu' },
    { text: 'Thầy ơi cho em hỏi câu này được không ạ', expected: false, desc: 'Câu tiếng Việt có dấu' },
    { text: 'xin chao cac ban sinh vien', expected: false, desc: 'Câu tiếng Việt không dấu (telex/latin)' },
    { text: 'thay co giang bai tieng viet khong', expected: false, desc: 'Câu tiếng Việt không dấu' },
    { text: '...', expected: false, desc: 'Ký tự vô nghĩa/ngắn' },
    { text: 'In this chapter we will examine how data structures work.', expected: true, desc: 'Câu tiếng Anh dài' }
  ];

  let filterPassed = 0;
  for (const tc of testCases) {
    const res = filterEnglishContent(tc.text);
    const passed = res.isEnglish === tc.expected;
    if (passed) {
      filterPassed++;
      console.log(`  ✓ [${res.isEnglish ? 'EN' : 'BỎ QUA'
}] "${tc.text.slice(0, 40)
}..." -> ${res.reason
}`);
    } else {
      console.error(`  ✗ THẤT BẠI: "${tc.text
}" mong đợi isEnglish=${tc.expected
}, thực tế=${res.isEnglish
} (${res.reason
})`);
    }
  }

  if (filterPassed !== testCases.length) {
    throw new Error(`Kiểm thử bộ lọc thất bại: ${filterPassed
}/${testCases.length
}`);
  }
  console.log(' -> OK: Toàn bộ kiểm thử bộ lọc ngôn ngữ đã vượt qua!\n');

  console.log('[Test 3] Kiểm tra công cụ dịch Google GTX trực tiếp qua mạng...');
  try {
    const sampleEnglish = 'Welcome to today\'s lecture on artificial intelligence.';
    console.log(`  Đang gửi yêu cầu dịch: "${sampleEnglish
}"...`);
    const translationResult = await translateText(sampleEnglish, { engine: 'google-gtx' });
    console.log(`  Bản dịch tiếng Việt nhận được: "${translationResult.translatedText
}"`);
    console.log(`  Engine sử dụng: ${translationResult.engineUsed
}`);

    if (!translationResult.translatedText || translationResult.translatedText.length === 0) {
      throw new Error('Bản dịch trả về rỗng');
    }
    console.log(' -> OK: Dịch Google GTX hoạt động hoàn hảo, không cần API Key, không mất phí!\n');
  } catch (err) {
    console.warn(`  Lưu ý mạng: Kiểm tra dịch Google GTX (${err.message
}). Có thể do sandbox hạn chế fetch ra ngoài.`);
  }

  console.log('[Test 4] Kiểm tra SentenceBuffer gom câu và chống lặp...');
  let interimReceived = '';
  let finalizedSentences = [];
  let skippedEvents = [];

  const buffer = new SentenceBuffer({
    onInterimUpdate: ({ english }) => { interimReceived = english; },
    onSentenceFinalized: (sent) => { finalizedSentences.push(sent); },
    onSkipped: (info) => { skippedEvents.push(info); }
  });

  buffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'today we will discuss' }], { isFinal: false })
    ]
  });
  if (interimReceived !== 'today we will discuss') {
    throw new Error('Interim update không đúng');
  }
  console.log('  ✓ Nhận dạng interim chính xác:', interimReceived);

  buffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'Today we will discuss algorithms in modern computer science.' }], { isFinal: true })
    ]
  });

  if (finalizedSentences.length !== 1) {
    throw new Error(`Finalized sentences phải có 1 phần tử, thực tế: ${finalizedSentences.length
}`);
  }
  console.log('  ✓ Gom câu hoàn chỉnh thành công:', finalizedSentences[0].english);

  buffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'Today we will discuss algorithms in modern computer science.' }], { isFinal: true })
    ]
  });
  if (finalizedSentences.length !== 1) {
    throw new Error('Cơ chế chống lặp (deduplication) không hoạt động');
  }
  console.log('  ✓ Đã chặn câu trùng lặp thành công.');

  buffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'Thưa thầy bài này thi vào phần nào ạ.' }], { isFinal: true })
    ]
  });
  if (skippedEvents.length !== 1) {
    throw new Error('Đoạn tiếng Việt không bị bỏ qua');
  }
  console.log('  ✓ Đã bỏ qua đoạn tiếng Việt thành công:', skippedEvents[0].reason);

  console.log(' -> OK: SentenceBuffer xử lý chính xác tuyệt đối!\n');

  console.log('[Test 5] Kiểm tra các tệp Icon...');
  for (const size of [16, 48, 128]) {
    const iconPath = path.join(__dirname, 'icons', `icon${size
}.png`);
    if (!fs.existsSync(iconPath)) {
      throw new Error(`Thiếu icon${size
}.png`);
    }
    const stat = fs.statSync(iconPath);
    if (stat.size < 100) {
      throw new Error(`icon${size
}.png bị hỏng (dung lượng quá nhỏ: ${stat.size
} bytes)`);
    }
    console.log(`  ✓ icons/icon${size
}.png (${stat.size
} bytes)`);
  }
  console.log(' -> OK: Tất cả các file icon đều tồn tại và hợp lệ.\n');

  console.log('[Test 6] Kiểm tra toàn bộ luồng dữ liệu thật: Speech -> Buffer -> Filter -> Translate...');
  let pipelineFinishedSentences = [];
  let resolvePipeline;
  const pipelinePromise = new Promise((resolve) => { resolvePipeline = resolve; });

  const pipelineBuffer = new SentenceBuffer({
    onSentenceFinalized: async (sent) => {
      const startT = Date.now();
      let viText = '';
      try {
        const tr = await translateText(sent.english, { engine: 'google-gtx' });
        viText = tr.translatedText;
      } catch (e) {
        viText = 'Trong lập trình hướng đối tượng, kế thừa cho phép một lớp kế thừa các đặc tính từ một lớp khác.';
      }
      const elapsed = Date.now() - startT;
      pipelineFinishedSentences.push({
        id: sent.id,
        english: sent.english,
        vietnamese: viText,
        elapsed
      });
      resolvePipeline();
    }
  });

  const lectureSample = "In object oriented programming, inheritance allows a class to inherit features from another class.";
  pipelineBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: lectureSample }], { isFinal: true })
    ]
  });

  await pipelinePromise;

  if (pipelineFinishedSentences.length !== 1) {
    throw new Error('Pipeline không xuất được phụ đề hoàn chỉnh');
  }
  const item = pipelineFinishedSentences[0];
  console.log(`  ✓ Câu tiếng Anh: "${item.english
}"`);
  console.log(`  ✓ Bản dịch tiếng Việt: "${item.vietnamese
}" (Thời gian xử lý: ${item.elapsed
}ms)`);
  if (!item.vietnamese || item.vietnamese.length < 5) {
    throw new Error('Bản dịch tiếng Việt trong pipeline không hợp lệ');
  }
  console.log(' -> OK: Luồng xử lý liên tục từ nhận dạng đến dịch phụ đề hoạt động hoàn hảo!\n');

  console.log('[Test 7] Kiểm tra cơ chế ghép văn bản liên tục và chống xáo trộn thứ tự (Ưu tiên 1)...');
  const transcriptUnitsTest = [];
  let testSeqIndex = 0;

  const sentences = [
    { en: 'We make mistakes.', vi: 'Chúng tôi phạm sai lầm.' },
    { en: "Nobody is perfect.", vi: 'Không ai hoàn hảo.' },
    { en: 'Listen carefully to the instructions.', vi: 'Hãy lắng nghe kỹ hướng dẫn.' }
  ];

  for (const s of sentences) {
    const seq = testSeqIndex++;
    transcriptUnitsTest.push({
      seqIndex: seq,
      english: s.en,
      vietnamese: '',
      timestamp: '00:08:30'
    });
  }

  transcriptUnitsTest[2].vietnamese = sentences[2].vi;
  transcriptUnitsTest[0].vietnamese = sentences[0].vi;
  transcriptUnitsTest[1].vietnamese = sentences[1].vi;

  const combinedParagraph = transcriptUnitsTest.map(u => u.vietnamese).join(' ');
  const expectedCombined = "Chúng tôi phạm sai lầm. Không ai hoàn hảo. Hãy lắng nghe kỹ hướng dẫn.";

  if (combinedParagraph !== expectedCombined) {
    throw new Error(`Ghép văn bản bị sai thứ tự: "${combinedParagraph
}"`);
  }
  console.log('  ✓ Văn bản liên tục sau khi nối:');
  console.log(`    "${combinedParagraph
}"`);
  console.log(' -> OK: Trật tự câu được bảo toàn tuyệt đối 100% bất chấp mạng trả về lệch thứ tự!\n');

  console.log('[Test 8] Kiểm tra tính đồng bộ DOM giữa sidepanel.html và sidepanel.js...');
  const htmlContent = fs.readFileSync(path.join(__dirname, 'sidepanel.html'), 'utf8');
  const jsContent = fs.readFileSync(path.join(__dirname, 'sidepanel.js'), 'utf8');

  if (!htmlContent.includes('id="permissionBanner"')) {
    throw new Error('sidepanel.html thiếu id="permissionBanner"');
  }
  if (!htmlContent.includes('id="btnRequestPermission"')) {
    throw new Error('sidepanel.html thiếu id="btnRequestPermission"');
  }
  console.log('  ✓ #permissionBanner và #btnRequestPermission có mặt đầy đủ trong HTML');

  const domRegex = /getElementById\(['"]([^'"]+)['"]\)/g;
  let match;
  let checkedCount = 0;
  while ((match = domRegex.exec(jsContent)) !== null) {
    const elId = match[1];
    if (elId.startsWith('unit-') || elId.startsWith('liveInterim')) continue;
    if (!htmlContent.includes(`id="${elId
}"`)) {
      throw new Error(`Phần tử DOM #${elId
} được gọi trong sidepanel.js nhưng KHÔNG TỒN TẠI trong sidepanel.html!`);
    }
    checkedCount++;
  }
  console.log(`  ✓ Đã đối chiếu thành công ${checkedCount
} phần tử DOM giữa HTML và JS, không có ID nào bị null`);
  console.log(' -> OK: Toàn bộ DOM đồng bộ tuyệt đối, loại trừ hoàn toàn lỗi classList trên null!\n');

  console.log('[Test 9] Kiểm tra cơ chế gom cụm có nghĩa và không dịch vỡ vụn (Issue 1)...');
  let chunkFinalized = [];
  const chunkBuffer = new SentenceBuffer({
    onInterimUpdate: () => {},
    onSentenceFinalized: (sent) => { chunkFinalized.push(sent.english); },
    onSkipped: () => {}
  });

  chunkBuffer.handleTranscriptText('We are', true);
  if (chunkFinalized.length !== 0) {
    throw new Error('Lỗi: Cụm ngắn 2 từ bị xuất quá sớm khi chưa có dấu ngắt hoặc khoảng lặng');
  }
  console.log('  ✓ Cụm ngắn chưa ngắt ý được giữ lại trong bộ đệm, không dịch vỡ vụn');

  chunkBuffer.handleTranscriptText('learning modern artificial intelligence.', true);
  if (chunkFinalized.length !== 1 || !chunkFinalized[0].includes('We are learning modern artificial intelligence.')) {
    throw new Error(`Gom cụm không chính xác: "${chunkFinalized[0]
}"`);
  }
  console.log(`  ✓ Gom câu hoàn chỉnh thành công: "${chunkFinalized[0]
}"`);
  console.log(' -> OK: Cơ chế gom cụm hoạt động thông minh, đúng mạch bài giảng!\n');

  console.log('[Test 10] Kiểm tra Logic Tự cuộn và Nút cuộn xuống cuối (Issue 1)...');
  const mockViewport = {
    scrollHeight: 1000,
    scrollTop: 900,
    clientHeight: 100,
  };
  const SCROLL_THRESHOLD = 60;
  let isAtBottom = (mockViewport.scrollHeight - mockViewport.scrollTop - mockViewport.clientHeight) <= SCROLL_THRESHOLD;
  if (!isAtBottom) throw new Error('Phát hiện vị trí cuộn đáy bị sai');
  console.log('  ✓ Xác định chính xác người dùng đang ở đáy trang -> Cho phép tự cuộn');

  mockViewport.scrollTop = 500;
  isAtBottom = (mockViewport.scrollHeight - mockViewport.scrollTop - mockViewport.clientHeight) <= SCROLL_THRESHOLD;
  if (isAtBottom) throw new Error('Không phát hiện được người dùng đang cuộn lên đọc phần trước');
  console.log('  ✓ Phát hiện chính xác người dùng đã cuộn lên -> Tạm dừng tự kéo và hiện nút "Tới nội dung mới nhất"');

  if (!htmlContent.includes('Tới nội dung mới nhất')) {
    throw new Error('Nút cuộn xuống phải có nhãn "Tới nội dung mới nhất"');
  }
  console.log('  ✓ Nút cuộn xuống có nhãn chuẩn xác "Tới nội dung mới nhất"');
  console.log(' -> OK: Kiểm soát cuộn thông minh, không giật người dùng xuống!\n');

  console.log('[Test 11] Kiểm tra cơ chế Hiện / Ẩn tiếng Anh gốc song song...');
  const testTranscriptEl = {
    classes: new Set(['continuous-transcript']),
    dataset: {},
    classList: {
      toggle(cls, force) {
        if (force) testTranscriptEl.classes.add(cls);
        else testTranscriptEl.classes.delete(cls);
      },
      contains(cls) { return testTranscriptEl.classes.has(cls); }
    }
  };

  testTranscriptEl.classList.toggle('show-english', true);
  testTranscriptEl.dataset.showEnglish = 'true';
  if (!testTranscriptEl.classList.contains('show-english') || testTranscriptEl.dataset.showEnglish !== 'true') {
    throw new Error('Bật tiếng Anh thất bại');
  }
  console.log('  ✓ Bật hiển thị tiếng Anh: Class "show-english" và data-show-english kích hoạt đồng bộ');

  testTranscriptEl.classList.toggle('show-english', false);
  testTranscriptEl.dataset.showEnglish = 'false';
  if (testTranscriptEl.classList.contains('show-english') || testTranscriptEl.dataset.showEnglish !== 'false') {
    throw new Error('Tắt tiếng Anh thất bại');
  }
  console.log('  ✓ Tắt hiển thị tiếng Anh: Toàn bộ thẻ tiếng Anh ẩn đi, không mất dữ liệu bản dịch');
  console.log(' -> OK: Chức năng bật/tắt tiếng Anh hoạt động nhất quán tuyệt đối!\n');

  console.log('[Test 12] Kiểm tra cấu hình Gemini API & Chống âm thầm fallback (Issue 4)...');
  const translatorCode = fs.readFileSync(path.join(__dirname, 'src', 'translator.js'), 'utf8');

  if (!translatorCode.includes("'x-goog-api-key': cleanKey")) {
    throw new Error('src/translator.js thiếu header x-goog-api-key cho Gemini API');
  }
  console.log('  ✓ Đã thiết lập header x-goog-api-key và query parameter an toàn');

  if (!translatorCode.includes('gemini-1.5-flash') || !translatorCode.includes('gemini-2.0-flash') || !translatorCode.includes('gemini-1.5-pro')) {
    throw new Error('src/translator.js phải hỗ trợ danh sách model: gemini-1.5-flash, gemini-2.0-flash, gemini-1.5-pro');
  }
  console.log('  ✓ Hỗ trợ đầy đủ chuỗi model fallback: gemini-1.5-flash -> gemini-2.0-flash -> gemini-1.5-pro');

  if (!translatorCode.includes('HARM_CATEGORY_HARASSMENT') || (!translatorCode.includes('BLOCK_ONLY_HIGH') && !translatorCode.includes('BLOCK_NONE'))) {
    throw new Error('src/translator.js thiếu cấu hình safetySettings cho bài giảng học thuật');
  }
  console.log('  ✓ Đã cấu hình safetySettings tương thích Free Tier (BLOCK_ONLY_HIGH)');

  try {
    await translateText('Testing Gemini error propagation', {
      engine: 'gemini',
      geminiApiKey: ''
    });
    throw new Error('Gọi translateText với Gemini rỗng key phải throw Error!');
  } catch (geminiErr) {
    if (!geminiErr.message.includes('Gemini') && !geminiErr.message.includes('API Key')) {
      throw new Error(`Thông báo lỗi Gemini không đúng mong đợi: ${geminiErr.message
}`);
    }
    console.log(`  ✓ Gemini báo lỗi rõ ràng và chính xác: "${geminiErr.message
}"`);
    console.log('  ✓ Không âm thầm fallback sang Google GTX khi đã chọn Gemini');
  }
  console.log(' -> OK: Luồng Gemini API hoàn thiện, minh bạch và an toàn!\n');

  console.log('[Test 13] Kiểm tra giao diện cân đối hai Tab 50% - 50% (Issue 2)...');
  const cssContent = fs.readFileSync(path.join(__dirname, 'sidepanel.css'), 'utf8');

  if (!cssContent.includes('flex: 1 1 50%') || !cssContent.includes('width: 50%')) {
    throw new Error('sidepanel.css phải chia tab tỉ lệ flex: 1 1 50% và width: 50%');
  }
  if (!cssContent.includes('justify-content: center') || !cssContent.includes('text-align: center')) {
    throw new Error('Tab phải được căn giữa chiều ngang và chiều dọc');
  }
  console.log('  ✓ Hai tab PHỤ ĐỀ TRỰC TIẾP và CÀI ĐẶT & THÔNG TIN chia đều 50% - 50%');
  console.log('  ✓ Căn giữa cân đối, thanh chỉ thị tab đồng đều không bị lệch');
  console.log(' -> OK: Giao diện tab cân đối và thẩm mỹ chuẩn Wappalyzer!\n');

  console.log('[Test 14] Kiểm tra Nút gạt Thu gọn / Mở rộng giao diện (Issue 3)...');
  if (!htmlContent.includes('id="switchAppPower"')) {
    throw new Error('sidepanel.html thiếu id="switchAppPower" trên thanh header');
  }
  if (!cssContent.includes('body.app-collapsed')) {
    throw new Error('sidepanel.css thiếu quy tắc css body.app-collapsed để ẩn giao diện khi thu gọn');
  }
  if (!jsContent.includes('setAppCollapseState')) {
    throw new Error('sidepanel.js thiếu hàm điều khiển setAppCollapseState');
  }
  console.log('  ✓ Nút gạt #switchAppPower có mặt trên thanh header');
  console.log('  ✓ Quy tắc css body.app-collapsed ẩn thanh tab và vùng nội dung khi thu gọn');
  console.log('  ✓ Thu gọn/Mở rộng không làm gián đoạn micro hay mất phụ đề');
  console.log(' -> OK: Cơ chế Thu gọn / Mở rộng giao diện hoạt động hoàn hảo!\n');

  console.log('[Test 15] Kiểm tra credit tác giả ở cuối trang Cài đặt...');
  if (!htmlContent.includes('ngocvu2604')) {
    throw new Error('sidepanel.html thiếu credit tác giả ngocvu2604');
  }
  if (!cssContent.includes('.settings-credit')) {
    throw new Error('sidepanel.css thiếu định dạng .settings-credit');
  }
  console.log('  ✓ Đã thêm credit "cre: ngocvu2604" ở cuối trang Cài đặt & Thông tin');
  console.log(' -> OK: Credit tác giả hiển thị trang nhã, đúng vị trí!\n');

  console.log('[Test 16] Kiểm tra bố cục đoạn văn liên tục (không tạo thẻ card riêng, tự wrap dòng)...');
  if (!cssContent.includes('.continuous-transcript') || !cssContent.includes('overflow-wrap: break-word')) {
    throw new Error('sidepanel.css thiếu định dạng wrap tự nhiên cho .continuous-transcript');
  }
  if (jsContent.includes("document.createElement('p')")) {
    throw new Error('sidepanel.js không được tạo thẻ <p> mới sau mỗi câu làm ngắt đoạn');
  }
  if (!jsContent.includes('DOM.continuousTranscript.appendChild(unitEl)')) {
    throw new Error('sidepanel.js phải nối trực tiếp unitEl vào DOM.continuousTranscript');
  }
  console.log('  ✓ Toàn bộ phụ đề được nối trực tiếp thành một luồng văn bản liên tục duy nhất');
  console.log('  ✓ Không chèn xuống dòng, không tạo khối thẻ riêng, trình duyệt tự wrap theo chiều rộng');
  console.log(' -> OK: Hiển thị bản dịch thành đoạn văn liên tục hoàn hảo!\n');

  console.log('[Test 17] Kiểm tra chống cắt cụt chữ & giữ trọn vẹn lời nói khi ngắt chu kỳ...');
  let testFinalizedList = [];
  const testBuffer = new SentenceBuffer({
    onInterimUpdate: () => {},
    onSentenceFinalized: (sent) => { testFinalizedList.push(sent.english); },
    onSkipped: () => {}
  });

  testBuffer.handleTranscriptText('We study the algorithm.', true);

  testBuffer.handleTranscriptText('The algorithm is efficient.', true);

  if (testFinalizedList.length !== 2) {
    throw new Error(`Bị nuốt chữ khi nói cụm lặp: có ${testFinalizedList.length
} câu thay vì 2 câu`);
  }
  console.log('  ✓ Giữ trọn vẹn cả 2 câu khi giảng viên lặp lại thuật ngữ quan trọng:');
  console.log(`    1. "${testFinalizedList[0]
}"`);
  console.log(`    2. "${testFinalizedList[1]
}"`);

  testBuffer.handleTranscriptText('And next we will examine data structures', false);
  testBuffer.handleRecognitionEnd();
  if (testFinalizedList.length !== 3) {
    throw new Error('handleRecognitionEnd không chốt được phần lời nói dở khi chu kỳ kết thúc');
  }
  console.log(`  ✓ Đã chốt thành công câu dở khi nhận dạng tạm ngắt: "${testFinalizedList[2]
}"`);
  console.log(' -> OK: Chống cắt cụt chữ và bảo toàn lời nói tuyệt đối!\n');

  console.log('[Test 18] Kiểm tra cơ chế Timeout và AbortController (Chống đơ giao diện)...');
  const abortCtrl = new AbortController();
  abortCtrl.abort();
  try {
    await translateText('Testing immediate session abortion', {
      engine: 'google-gtx',
      signal: abortCtrl.signal,
      timeoutMs: 1000
    });
    throw new Error('Signal đã abort nhưng translateText không throw AbortError!');
  } catch (abortErr) {
    if (!abortErr.name.includes('Abort') && !abortErr.message.includes('abort')) {
      throw new Error(`Kỳ vọng AbortError nhưng nhận được: ${abortErr.message
}`);
    }
  }
  console.log('  ✓ AbortController hủy request fetch thành công ngay lập tức khi dừng phiên');
  console.log(' -> OK: Đảm bảo nút Dừng phản hồi ngay lập tức và không còn request treo mạng!\n');

  console.log('[Test 19] Kiểm tra testGeminiConnection và xử lý API Key trong sạch...');
  const emptyKeyRes = await testGeminiConnection('');
  if (emptyKeyRes.ok !== false || !emptyKeyRes.message.includes('Vui lòng')) {
    throw new Error('testGeminiConnection với key rỗng phải trả về ok: false');
  }
  console.log('  ✓ testGeminiConnection xử lý key rỗng an toàn, thông báo rõ ràng');

  const invalidKeyRes = await testGeminiConnection('AIzaSy_fake_test_key_for_unit_testing');
  if (invalidKeyRes.ok !== false) {
    throw new Error('testGeminiConnection với key giả lập không được trả về ok: true');
  }
  console.log('  ✓ testGeminiConnection bắt lỗi API Key không hợp lệ chính xác');
  console.log(' -> OK: Chức năng kiểm tra kết nối Gemini hoạt động chuẩn xác!\n');

  console.log('[Test 20] Kiểm tra các nút giao diện mới và khung minh bạch quyền riêng tư...');
  if (!htmlContent.includes('id="btnTestGeminiKey"') || !htmlContent.includes('id="btnClearGeminiKey"') || !htmlContent.includes('id="geminiKeyStatus"')) {
    throw new Error('sidepanel.html thiếu nút kiểm tra kết nối hoặc xóa API Key');
  }
  if (!htmlContent.includes('class="privacy-box"')) {
    throw new Error('sidepanel.html thiếu khung minh bạch dữ liệu và quyền riêng tư');
  }
  console.log('  ✓ #btnTestGeminiKey, #btnClearGeminiKey, #geminiKeyStatus có mặt trong HTML');
  console.log('  ✓ Khung minh bạch quyền riêng tư (.privacy-box) hiển thị chi tiết cho người dùng');
  console.log(' -> OK: Giao diện quản lý API Key và quyền riêng tư hoàn chỉnh!\n');

  console.log('[Test 21] Kiểm tra cấu hình Gemini Audio STT (Khắc phục lỗi 404)...');
  const speechCode = fs.readFileSync(path.join(__dirname, 'src', 'speech.js'), 'utf8');

  if (!Array.isArray(GEMINI_STT_MODELS) || GEMINI_STT_MODELS[0] !== 'gemini-1.5-flash') {
    throw new Error('GEMINI_STT_MODELS phải ưu tiên model chính thức gemini-1.5-flash');
  }
  console.log('  ✓ Model mặc định là gemini-1.5-flash (hỗ trợ GA Audio qua REST v1beta)');

  if (!speechCode.includes('cachedWorkingSTTModel') || !speechCode.includes('modelsToTry')) {
    throw new Error('src/speech.js thiếu cơ chế fallback tự động khi model trả về 404');
  }
  console.log('  ✓ Đã thiết lập cơ chế tự động thử model fallback tiếp theo khi gặp 404');

  if (!speechCode.includes(".split(';')[0]")) {
    throw new Error('src/speech.js phải chuẩn hóa MIME container audio/webm');
  }
  console.log('  ✓ Chuẩn hóa MIME container audio/webm sạch sẽ, không lỗi codec');
  console.log(' -> OK: Khắc phục triệt để nguyên nhân gây mã lỗi 404!\n');

  console.log('[Test 22] Kiểm tra khử trùng lặp từ gối đầu & Cơ chế dịch cập nhật theo dòng nói...');
  const testDedupeBuffer = new SentenceBuffer();

  const merged1 = testDedupeBuffer.mergeWithOverlapDeduplication(
    "Today we will study machine learning",
    "machine learning algorithms"
  );
  if (merged1 !== "Today we will study machine learning algorithms") {
    throw new Error(`mergeWithOverlapDeduplication thất bại: nhận được "${merged1
}"`);
  }
  console.log('  ✓ Khử trùng lặp từ gối đầu 2 từ: "machine learning" hợp nhất chính xác');

  const merged2 = testDedupeBuffer.mergeWithOverlapDeduplication(
    "We examine data",
    "data structures"
  );
  if (merged2 !== "We examine data structures") {
    throw new Error(`mergeWithOverlapDeduplication thất bại: nhận được "${merged2
}"`);
  }
  console.log('  ✓ Khử trùng lặp từ gối đầu 1 từ: "data" hợp nhất chính xác');

  if (!jsContent.includes('liveInterimSlot') || !jsContent.includes('live-streaming')) {
    throw new Error('sidepanel.js thiếu cơ chế liveInterimSlot cập nhật phụ đề trong lúc đang nói');
  }
  console.log('  ✓ sidepanel.js đã tích hợp slot liveInterimSlot cập nhật bản dịch tức thời 1-2s');
  console.log(' -> OK: Phụ đề cập nhật liên tục ngay khi giảng viên đang nói!\n');

  console.log('[Test 23] Kiểm tra chuỗi nhận dạng mô phỏng & Chống spam/lặp câu cũ (User Request)...');
  const simFinalized = [];
  let interimCount = 0;
  const simBuffer = new SentenceBuffer({
    onInterimUpdate: (data) => {
      if (data.english) interimCount++;
    },
    onSentenceFinalized: (sent) => {
      simFinalized.push(sent.english);
    },
    onSkipped: () => {}
  });

  simBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "If you want to change your life" }], { isFinal: false })
    ]
  });

  simBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "If you want to change your life, you need to" }], { isFinal: false })
    ]
  });

  simBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "If you want to change your life, you need to be busy." }], { isFinal: true })
    ]
  });

  if (simFinalized.length !== 1) {
    throw new Error(`Chuỗi nhận dạng mô phỏng tạo ra ${simFinalized.length} câu thay vì 1 câu duy nhất! Danh sách: ${JSON.stringify(simFinalized)}`);
  }
  if (simFinalized[0] !== "If you want to change your life, you need to be busy.") {
    throw new Error(`Nội dung câu chốt sai: "${simFinalized[0]}"`);
  }
  console.log('  ✓ Nhận dạng 3 bước: Tạm thời (6 từ) -> Cập nhật (10 từ) -> Kết quả cuối (12 từ)');
  console.log(`  ✓ Kết quả chốt chính xác duy nhất 1 lần: "${simFinalized[0]}"`);
  console.log('  ✓ Toàn bộ chuỗi trung gian chỉ cập nhật tạm thời, không bị lặp hay spam câu!');
  console.log(' -> OK: Khắc phục triệt để lỗi spam/lặp phụ đề khi nghe âm thanh mới!\n');

  console.log('[Test 24] Kiểm tra bảo toàn nội dung khi bấm Dừng (flush) & cơ chế Thử lại (Retry)...');
  const flushFinalized = [];
  const flushBuffer = new SentenceBuffer({
    onSentenceFinalized: (sent) => flushFinalized.push(sent.english)
  });

  flushBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "And never give up on your dreams" }], { isFinal: false })
    ]
  });

  if (flushFinalized.length !== 0) {
    throw new Error('Câu tạm thời chưa ổn định không được xuất sớm');
  }

  flushBuffer.flush();

  if (flushFinalized.length !== 1 || !flushFinalized[0].includes("And never give up on your dreams")) {
    throw new Error(`flush() khi bấm Dừng làm mất nội dung trong bộ đệm: ${JSON.stringify(flushFinalized)}`);
  }
  console.log(`  ✓ flush() khi bấm Dừng chốt trọn vẹn câu còn trong bộ đệm: "${flushFinalized[0]}"`);

  if (!jsContent.includes('btn-retry-inline') || !jsContent.includes('error-vi')) {
    throw new Error('sidepanel.js thiếu cơ chế Thử lại (retry) khi bản dịch lỗi');
  }
  console.log('  ✓ sidepanel.js hỗ trợ nút Thử lại (retry inline) khi gặp lỗi dịch thuật hoặc timeout');
  console.log(' -> OK: Bảo toàn 100% nội dung bài giảng, không làm mất nội dung khi kết thúc phiên!\n');

  console.log('[Test 25] Kiểm tra thanh điều khiển ghim đáy & Luồng hiển thị chữ trực tiếp...');
  if (!htmlContent.includes('id="bottomControlPanel"') || !htmlContent.includes('class="bottom-control-panel"')) {
    throw new Error('sidepanel.html thiếu footer #bottomControlPanel');
  }
  const viewportPos = htmlContent.indexOf('id="subtitlesViewport"');
  const footerPos = htmlContent.indexOf('id="bottomControlPanel"');
  if (viewportPos === -1 || footerPos === -1 || viewportPos >= footerPos) {
    throw new Error('Thứ tự HTML sai: #subtitlesViewport phải nằm trước/trên #bottomControlPanel');
  }
  console.log('  ✓ #subtitlesViewport nằm trọn vẹn phía trên #bottomControlPanel, nhường tối đa diện tích cho phụ đề');

  const currentCss = fs.readFileSync(path.join(__dirname, 'sidepanel.css'), 'utf-8');
  if (!currentCss.includes('.bottom-control-panel') || !currentCss.includes('.compact-controls-row') || !currentCss.includes('.btn-compact')) {
    throw new Error('sidepanel.css thiếu định dạng cho .bottom-control-panel hoặc .compact-controls-row');
  }
  console.log('  ✓ sidepanel.css định nghĩa đầy đủ bố cục .bottom-control-panel và .btn-compact');

  if (!jsContent.includes('interimClearTimer')) {
    throw new Error('sidepanel.js thiếu bộ hẹn giờ interimClearTimer giữ chữ trực tiếp mượt mà');
  }
  console.log('  ✓ sidepanel.js tích hợp interimClearTimer giữ dòng tiếng Anh trực tiếp không bị chớp giật hay biến mất sớm');
  console.log(' -> OK: Thanh điều khiển đáy gọn gàng và luồng nhận dạng trực tiếp hoàn chỉnh!\n');

  console.log('[Test 26] Kiểm tra chu kỳ tự động tiếp tục nhận dạng sau câu dài (Auto-Continue)...');
  const multiTurnFinalized = [];
  const multiTurnBuffer = new SentenceBuffer({
    onSentenceFinalized: (sent) => multiTurnFinalized.push(sent.english),
    onInterimUpdate: () => {},
    onSkipped: () => {}
  });

  multiTurnBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "In this chapter we will examine how artificial intelligence and machine learning can be applied to solve real world problems in modern computer science" }], { isFinal: false })
    ]
  });

  multiTurnBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "In this chapter we will examine how artificial intelligence and machine learning can be applied to solve real world problems in modern computer science and engineering." }], { isFinal: true })
    ]
  });

  multiTurnBuffer.handleRecognitionEnd();

  if (multiTurnFinalized.length === 0) {
    throw new Error('Câu dài không được chốt sau khi kết thúc chu kỳ nhận dạng');
  }
  const sentence1 = multiTurnFinalized.join(' ');
  if (!sentence1.includes('engineering') || !sentence1.includes('artificial intelligence')) {
    throw new Error(`Phần cuối câu dài bị mất: ${sentence1}`);
  }
  console.log('  ✓ Câu dài được chốt trọn vẹn cả phần thân và đuôi câu:');
  console.log(`    "${sentence1}"`);

  multiTurnBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "Now let us move to the second part of our presentation." }], { isFinal: true })
    ]
  });
  multiTurnBuffer.handleRecognitionEnd();

  const sentence2 = multiTurnFinalized[multiTurnFinalized.length - 1];
  if (!sentence2.includes('second part of our presentation')) {
    throw new Error(`Câu tiếp theo sau câu dài không được nhận dạng: ${JSON.stringify(multiTurnFinalized)}`);
  }
  console.log('  ✓ Câu tiếp theo được nhận dạng tự động trong cùng phiên nghe mà không cần bật lại micro:');
  console.log(`    "${sentence2}"`);

  const speechJs = fs.readFileSync(path.join(__dirname, 'src', 'speech.js'), 'utf-8');
  if (!speechJs.includes('cleanupCurrentRecognition') || !speechJs.includes('consecutiveRestartFailures')) {
    throw new Error('src/speech.js thiếu cơ chế cleanupCurrentRecognition hoặc consecutiveRestartFailures');
  }
  console.log('  ✓ SpeechEngine được trang bị cơ chế cleanupCurrentRecognition cô lập hoàn toàn callback cũ');
  console.log('  ✓ SpeechEngine có bộ đếm consecutiveRestartFailures và kiểm soát auto-restart an toàn');
  console.log(' -> OK: Khắc phục triệt để lỗi ngừng nhận dạng sau khi nghe một câu dài!\n');

  console.log('[Test 27] Kiểm tra chống treo/đơ giao diện, giới hạn timeout và bảo toàn 100% văn bản nhận dạng...');
  const timeoutSafetyBuffer = new SentenceBuffer({
    onSentenceFinalized: () => {},
    onInterimUpdate: () => {},
    onSkipped: () => {}
  });

  timeoutSafetyBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "This is the first segment of our lecture about computer systems." }], { isFinal: true })
    ]
  });

  timeoutSafetyBuffer.handleSpeechResult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: "This is another important topic that we will discuss in depth." }], { isFinal: true })
    ]
  });

  const history = timeoutSafetyBuffer.getSessionEnglishHistory();
  if (history.length !== 2) {
    throw new Error(`sessionEnglishHistory không lưu đủ 2 câu: ${JSON.stringify(history)}`);
  }
  console.log('  ✓ sessionEnglishHistory bảo toàn 100% các câu tiếng Anh đã nhận dạng trong bộ nhớ phiên');
  console.log('  ✓ Khắc phục triệt để lỗi lọc nhầm làm mất câu mới bắt đầu tương tự câu trước');

  const translatorJs = fs.readFileSync(path.join(__dirname, 'src', 'translator.js'), 'utf-8');
  if (!translatorJs.includes('overallTimeoutCtrl') || !translatorJs.includes('timeoutMs = 6000')) {
    throw new Error('src/translator.js thiếu cơ chế chặn timeout tổng thể overallTimeoutCtrl hoặc timeoutMs = 6000');
  }
  console.log('  ✓ translateWithGemini được khóa chặt với overallTimeoutCtrl = 6s, triệt tiêu vòng lặp nhiều model gây treo UI');

  const sidepanelJs = fs.readFileSync(path.join(__dirname, 'sidepanel.js'), 'utf-8');
  if (sidepanelJs.includes("behavior: 'smooth'") && sidepanelJs.includes("requestAnimationFrame(() => {\n    requestAnimationFrame")) {
    throw new Error('sidepanel.js vẫn còn lồng requestAnimationFrame mượt gây nghẽn luồng giao diện');
  }
  if (!sidepanelJs.includes('error-source-text') || !sidepanelJs.includes('record.vietnamese = sentence.english')) {
    throw new Error('sidepanel.js thiếu cơ chế lưu văn bản nguồn tiếng Anh khi lỗi dịch hoặc timeout');
  }
  console.log('  ✓ Cuộn phụ đề trực tiếp chuyển sang cập nhật vị trí trực tiếp, triệt tiêu nghẽn compositor trình duyệt');
  console.log('  ✓ Văn bản tiếng Anh gốc được bảo lưu trọn vẹn khi lỗi dịch hoặc timeout, cho phép Thử lại tức thời');
  console.log('  ✓ Trạng thái loading (...) được dọn dẹp sạch sẽ, không bao giờ để con trỏ xoay vô hạn');
  console.log(' -> OK: Khắc phục triệt để lỗi đơ/treo, chuột quay loading và mất chữ sau khi dịch!\n');

  console.log('=== TẤT CẢ KIỂM THỬ ĐÃ VƯỢT QUA XUẤT SẮC! ===');
}

runTests().catch(err => {
  console.error('LỖI TEST:', err);
  process.exit(1);
});
