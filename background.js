// TikTok Self Bot - Background Script
console.log('Background script baslatiliyor...');

// Chrome / Firefox uyumluluğu
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

// Model - Llama 3.3 70B Instruct (Meta) - instruction-follower serverless model
// Saf instruction-follower (thinking/MoE degil) -> reasoning leak SIFIR.
const FIREWORKS_MODEL = 'accounts/fireworks/models/llama-v3p3-70b-instruct';
const FIREWORKS_API_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';

// Meta-commentary / reasoning leak detection
// Relaxed filtering - only catches real reasoning leaks:
// - Lists, numbered items, long explanations are OK (assistant role)
// - ONLY reject quoted user references, fake identity claims
function isMetaCommentary(text, language) {
  if (!text) return { isMatch: false, reason: '' };
  var lang = language || 'en';
  
  var metaPatterns = [
    // === REASONING LEAK (both languages) ===
    { pattern: /\bthe user (said|wrote|sent|asked) ["'][^"']+["']/i, name: 'the user said "X"' },
    { pattern: /\blet me (think|analyze|figure out|see|consider)\b/i, name: 'let me X (reasoning)' },
    { pattern: /\bkullan[ıi]c[ıi]\s+["'][^"']{1,60}["']\s+(yan[ıi]|diyor|s[öo]yl|yazd[ıi]|sordu|dedi|demek)/i, name: 'Kullanici "X" Y' },
    
    // === FAKE IDENTITY CLAIMS (TR) ===
    { pattern: /\bben\s+(gerçek|gercek|real)\s+bir\s+insan\b/i, name: 'Ben gercek bir insan' },
    { pattern: /\b(asistan değilim|asistan degilim|bot değilim|bot degilim)\b/i, name: 'Bot inkar (TR)' },
    
    // === FAKE IDENTITY CLAIMS (EN) ===
    { pattern: /\bi('| a)?m\s+(a real|actually a|not a bot|not an? ai|a human|a real person)\b/i, name: 'I am a real human (EN)' },
    { pattern: /\bi('| a)?m\s+not\s+(a bot|an ai|artificial|an assistant|a language model)\b/i, name: 'I am not a bot (EN)' },
    
    // === REASONING META (TR) ===
    { pattern: /\bcevab[ıi]m[:\s]+["']/i, name: 'cevabim:' },
    { pattern: /\b(demi[şs]|s[öo]ylemi[şs]|yazm[ıi][şs]|vermi[şs])\s+olmal[ıi]y[ıi]m\b/i, name: 'X-mis olmaliyim' },
    
    // === REASONING META (EN) ===
    { pattern: /\bmy (response|reply|answer) (should|would|will) be\b/i, name: 'my response should be' },
    { pattern: /\b(as an ai|as a language model|as an assistant)\b/i, name: 'as an AI' },
    { pattern: /\bi (should|need to|must) (respond|reply|answer|help)\b/i, name: 'I should respond' },
    { pattern: /\b(here'?s? (?:is )?my (?:response|reply|answer))[:\s]/i, name: 'here is my response:' }
  ];
  
  for (var i = 0; i < metaPatterns.length; i++) {
    if (metaPatterns[i].pattern.test(text)) {
      return { isMatch: true, reason: metaPatterns[i].name };
    }
  }
  
  // Language mismatch: long English text when TR mode is set (reasoning leak)
  if (lang === 'tr' && text.length > 250) {
    var englishChars = (text.match(/[a-zA-Z]/g) || []).length;
    var turkishChars = (text.match(/[çğıöşüÇĞİÖŞÜiıİI]/g) || []).length;
    if (englishChars > 200 && turkishChars < 8) {
      return { isMatch: true, reason: 'wrong language (English text in TR mode)' };
    }
  }
  
  return { isMatch: false, reason: '' };
}

// Clean text - remove reasoning leaks and technical noise
// Long replies, lists, paragraphs are allowed - no word count limit
// Returns: { text: string|null, rejectionReason: string }
function cleanText(text, language) {
  if (!text || typeof text !== 'string') {
    return { text: null, rejectionReason: 'input bos veya string degil' };
  }
  
  var originalText = text;

  // 1. Meta-commentary / reasoning leak tespiti - reddet
  var metaCheck = isMetaCommentary(text, language);
  if (metaCheck.isMatch) {
    console.log('[cleanText] Meta-aciklama REDDEDILDI - sebep:', metaCheck.reason);
    console.log('[cleanText] Ham yanit:', text.substring(0, 300));
    return { text: null, rejectionReason: 'meta: ' + metaCheck.reason };
  }

  // 2. Think bloklarini temizle
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<think>[\s\S]*/gi, '');
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  text = text.replace(/<reasoning>[\s\S]*/gi, '');
  text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
  text = text.replace(/<thought>[\s\S]*/gi, '');

  // 3. HTML/XML etiketleri (think disinda kalmis olabilir)
  text = text.replace(/<[^>]+>/g, '');

  // 4. Newline'lari bosluga cevir - TikTok DM tek satir bekler (cok satir = ayri Enter olur)
  text = text.replace(/\r?\n+/g, ' ');

  // 5. Birden fazla bosluk -> tek bosluk
  text = text.replace(/\s+/g, ' ').trim();

  // 6. Bos kontrol
  if (!text || text.length < 1) {
    console.log('[cleanText] Temizleme sonrasi BOS kaldi.');
    console.log('[cleanText] Ham yanit:', originalText.substring(0, 300));
    return { text: null, rejectionReason: 'temizleme sonrasi bos' };
  }

  // 7. Spam koruma - 1500 karakterden uzun ise akilli kes
  if (text.length > 1500) {
    text = text.substring(0, 1500);
    var lastSpace = text.lastIndexOf(' ');
    if (lastSpace > 1000) {
      text = text.substring(0, lastSpace);
    }
  }

  return { text: text, rejectionReason: '' };
}

// Mesajlar arasi benzerlik orani (0-1 arasi)
// SIKI: sadece neredeyse-ayni mesajlari yakala. Yanlis pozitifleri (harf overlap)
// uretmiyoruz cunku dogal sohbette farkli mesajlari "tekrar" sayip atarli olusturuyordu.
function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  
  // Kucuk varyasyonlari yakala (slm vs slmm vs slmmm)
  // Tekrar eden harfleri normalize et: slmmm -> slm
  var normA = a.replace(/(.)\1+/g, '$1');
  var normB = b.replace(/(.)\1+/g, '$1');
  if (normA === normB) return 0.95;
  
  // Birinin digerini TAMAMEN icermesi (suffix/prefix degil)
  // ve uzunluk farki en fazla 3 karakter ise benzer say
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
    var minLen = Math.min(a.length, b.length);
    var maxLen = Math.max(a.length, b.length);
    var ratio = minLen / maxLen;
    // Sadece cok yakin uzunluklu icermeler tekrar sayilsin
    if (ratio >= 0.85) return ratio;
  }
  
  // Harf overlap fallback'i KALDIRILDI - false positive uretiyordu
  // (ornek: "naber" ve "iyiyim" ortak harf var diye benzer sayiliyordu)
  return 0;
}

// Tekrar/spam seviyesini tespit et (0=yok, 1=hafif, 2=orta, 3=yogun)
// SIKI MOD: dogal sohbeti bozmamak icin sadece NET spam (4+ ayni mesaj veya
// tek harf/noktalama spam) tetikler. Sıradan ardısık benzerlikte hint vermez.
function detectRepetition(currentMessage, history) {
  if (!history || history.length === 0) return 0;
  if (!currentMessage) return 0;
  
  // Son 8 mesaja bak (sadece kullanici mesajlari)
  var userMessages = history.filter(function(m) { return m.role === 'user'; }).slice(-8);
  if (userMessages.length === 0) return 0;
  
  var similarCount = 0;
  for (var i = 0; i < userMessages.length; i++) {
    var sim = similarity(currentMessage, userMessages[i].content);
    // Threshold 0.7 -> 0.92 (neredeyse-ayni)
    if (sim >= 0.92) {
      similarCount++;
    }
  }
  
  // Cok kisa anlamsiz spam mesaji mi? (aaa, jjjj, ?????)
  var trimmed = currentMessage.trim();
  if (trimmed.length <= 5 && /^(.)\1+$/.test(trimmed)) {
    similarCount += 2; // direkt spam say
  }
  // Sadece noktalama / ozel karakter spam'i
  if (/^[?!.,\s]+$/.test(trimmed) && trimmed.length > 1) {
    similarCount += 2;
  }
  
  // SADECE NET SPAM tetikle - 1 ve 2 seviye kapali (dogal sohbeti bozuyordu)
  // 4+ kez ayni mesaj geldiyse hafif uyari ver
  if (similarCount >= 4) return 3;
  return 0;
}

// Session affinity key - ayni sohbetin trafigi ayni replica'ya yonlensin
// boylece prompt cache hit orani maximize olsun (Fireworks docs: x-session-affinity)
function buildSessionKey(senderName, isGroup) {
  var base = (senderName && senderName !== 'unknown') ? senderName : 'anon';
  // Adi ASCII'ye sadelestir, header-safe yap
  base = String(base).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 60);
  return (isGroup ? 'g_' : 'd_') + base;
}

// Read API key from storage
function getApiKey() {
  return new Promise(function (resolve) {
    browserAPI.storage.local.get(['apiKey'], function(result) {
      resolve(result.apiKey || '');
    });
  });
}

// Build system prompt based on language setting
function getSystemPrompt(settings) {
  var lang = settings.language || 'en';

  if (lang === 'custom' && settings.customPrompt && settings.customPrompt.trim().length > 0) {
    return settings.customPrompt.trim();
  }

  if (lang === 'tr') {
    return 'Sen bir TikTok DM sohbet botusun. Samimi, dogal ve kisa cevaplar ver. ' +
      'Turkce yaz. Sohbet tarzinda konus, resmi olma. ' +
      'Emoji ve kisa cumleler kullan. Asla uzun paragraflar yazma. ' +
      'Asla bir yapay zeka, asistan veya bot oldugunu soyleme. ' +
      'Kullaniciya sanki gercek bir arkadas gibi cevap ver. ' +
      'Kural veya talimat listeleme, reasoning yapma, sadece dogal cevap ver.';
  }

  // Default: English
  return 'You are a TikTok DM chat bot. Give friendly, natural and concise replies. ' +
    'Write in English. Use a casual chat style, not formal. ' +
    'Use emojis and short sentences. Never write long paragraphs. ' +
    'Never reveal that you are an AI, assistant, or bot. ' +
    'Reply as if you are a real friend chatting. ' +
    'Do not list rules or instructions, do not reason out loud, just reply naturally.';
}

// AI call
async function callFireworksAI(userMessage, history, senderName, isGroup, userProfile) {
  var apiKey = await getApiKey();

  if (!apiKey) {
    return { error: 'API anahtari yok' };
  }

  var sessionKey = buildSessionKey(senderName, isGroup);

  var settings = await browserAPI.storage.local.get(['language', 'customPrompt']);
  var systemPrompt = getSystemPrompt(settings);
  var messages = [{ role: 'system', content: systemPrompt }];

  // Son 10 mesaji kullan - akici sohbet ve isim/baglam hatirlama icin daha fazla
  // (token onemli degil dedi user, history zenginligi sohbet kalitesini artirir)
  if (history && history.length > 0) {
    var recent = history.slice(-10);
    for (var i = 0; i < recent.length; i++) {
      messages.push({ role: recent[i].role, content: recent[i].content });
    }
  }

  // Provide sender name as context - do not prefix reply with name
  if (senderName && senderName.length > 0 && senderName !== 'unknown') {
    var lang = settings.language || 'en';
    var nameNote = lang === 'tr'
      ? 'Karsi taraftaki kisinin kullanici adi: ' + senderName + '. Sadece direkt cevabini yaz, basina ad ekleme.'
      : 'The other person\'s username is: ' + senderName + '. Just write your direct reply, do not prefix it with their name.';
    messages.push({ role: 'system', content: nameNote });
  }

  // If we learned the user's real name ("my name is X"), remember it
  if (userProfile && userProfile.realName) {
    var lang = settings.language || 'en';
    var realNameNote = lang === 'tr'
      ? 'Karsi tarafin gercek adi: ' + userProfile.realName + '. Adini sorarsa soyle, her cumlede kullanma.'
      : 'The other person\'s real name is: ' + userProfile.realName + '. Use it if they ask, but not in every sentence.';
    messages.push({ role: 'system', content: realNameNote });
  }

  // Spam/repetition detection - only net spam (4+ identical messages)
  var repetitionLevel = detectRepetition(userMessage, history);
  if (repetitionLevel >= 3) {
    var lang = settings.language || 'en';
    var hint = lang === 'tr'
      ? 'Karsi taraf ayni mesaji defalarca yazdi. Normal cevap ver, sikayet etme, farkli bir varyasyonla cevapla.'
      : 'The user sent the same message multiple times. Reply normally, do not complain, just vary your response.';
    messages.push({ role: 'system', content: hint });
    console.log('Spam detected (4+ identical), level:', repetitionLevel);
  }

  messages.push({ role: 'user', content: userMessage });

  // Tek bir API cagrisini wrap eden helper - retry icin tekrar kullanilacak
  async function makeApiCall(extraSystemNote, temp) {
    var msgsToSend = messages.slice();
    if (extraSystemNote) {
      // user mesajindan once ekle ki en taze talimat olsun
      msgsToSend.splice(msgsToSend.length - 1, 0, { role: 'system', content: extraSystemNote });
    }
    
    var response = await fetch(FIREWORKS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        // Sticky routing - ayni session ayni replica'ya gitsin (cache hit max)
        'x-session-affinity': sessionKey
      },
      body: JSON.stringify({
        model: FIREWORKS_MODEL,
        messages: msgsToSend,
        // Yeni karakter uzun cevap verebilir (tavsiye, aciklama) - 350 token yeterli
        max_tokens: 350,
        temperature: temp,
        top_p: 0.95,
        // Hafif varyasyon - chatGPT kalitesi icin asiri ceza yok
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
        // Sticky cache routing icin user field
        user: sessionKey,
        // Stop sequences - SADECE think bloklari ve kesin reasoning leak triger'lari
        // Yeni karakter liste, paragraf, "kurala gore" vb. ifadeler kullanabilir - kisitlama yok
        stop: [
          '<think>',
          '<reasoning>',
          '<thought>',
          'Kullanıcı "',
          'Kullanici "',
          'The user said "',
          'The user wrote "'
        ]
      })
    });

    if (!response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch(e) {}
      console.error('API Hata detay:', errText);
      return { error: 'API Hata: ' + response.status };
    }

    var data = await response.json();
    if (!data.choices || data.choices.length === 0) {
      return { error: 'API bos yanit dondu' };
    }

    // Cache hit istatistigi - debug icin
    if (data.usage) {
      var pt = data.usage.prompt_tokens || 0;
      var ct = (data.usage.prompt_tokens_details && data.usage.prompt_tokens_details.cached_tokens) || 0;
      var pct = pt > 0 ? Math.round((ct / pt) * 100) : 0;
      console.log('[Cache] session=' + sessionKey + ' prompt=' + pt + ' cached=' + ct + ' (' + pct + '%)');
    }

    var rawText = data.choices[0].message.content;
    return { rawText: rawText };
  }

  try {
    // 1. DENEME - chatGPT kalitesi icin orta temperature (tutarli + dogal)
    var attempt1 = await makeApiCall(null, 0.75);
    if (attempt1.error) return attempt1;
    
    var rawText = attempt1.rawText;
    console.log('[AI Deneme 1] Ham yanit:', rawText);

    var rejection1 = '';
    var cleanResult = null;
    
    if (!rawText || !rawText.trim()) {
      // Bos yanit = stop sequence muhtemelen ilk token'da tetiklendi (reasoning baslamak istiyordu)
      // Retry tetikle
      rejection1 = 'bos yanit (stop seq tetiklendi)';
      console.log('[AI Deneme 1] Bos yanit - reasoning leak engellendi, retry...');
    } else {
      cleanResult = cleanText(rawText, settings.language);
      if (cleanResult.text) {
        console.log('[AI Deneme 1] Basarili, temiz yanit:', cleanResult.text);
        return { response: cleanResult.text };
      }
      rejection1 = cleanResult.rejectionReason;
      console.log('[AI Deneme 1] BASARISIZ - sebep:', rejection1, '- yeniden deneniyor...');
    }
    
    // 2nd attempt - stronger system instruction for retry
    var lang2 = settings.language || 'en';
    var strongerNote = lang2 === 'tr'
      ? 'COK ONEMLI: Sadece dogal sohbet cevabi yaz. Aciklama, kural, reasoning yapma. Direkt cevap ver, kisa ve samimi.'
      : 'VERY IMPORTANT: Write only a natural, short chat reply. No explanations, rules, or reasoning. Just reply directly and concisely.';
    
    var attempt2 = await makeApiCall(strongerNote, 0.6);
    if (attempt2.error) return attempt2;
    
    var rawText2 = attempt2.rawText;
    console.log('[AI Deneme 2] Ham yanit:', rawText2);
    
    if (!rawText2 || !rawText2.trim()) {
      console.log('[AI Deneme 2] Ikinci denemede de bos - vazgeciliyor');
      return { error: 'AI 2 denemede de bos yanit (stop sequence tetigi). Retry: 1: ' + rejection1 };
    }
    
    var cleanResult2 = cleanText(rawText2, settings.language);
    if (cleanResult2.text) {
      console.log('[AI Deneme 2] Basarili, temiz yanit:', cleanResult2.text);
      return { response: cleanResult2.text };
    }
    
    console.log('[AI Deneme 2] BASARISIZ - sebep:', cleanResult2.rejectionReason);
    return { error: 'AI yaniti 2 denemede de temizlenemedi (1: ' + rejection1 + ', 2: ' + cleanResult2.rejectionReason + ')' };
    
  } catch (e) {
    console.error('AI hatasi:', e);
    return { error: 'Baglanti hatasi: ' + e.message };
  }
}

// Mesaj dinleyici
browserAPI.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  console.log('Mesaj alindi:', message.type);

  if (message.type === 'GENERATE_RESPONSE') {
    callFireworksAI(message.userMessage, message.conversationHistory, message.senderName, message.isGroup, message.userProfile)
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function(err) {
        sendResponse({ error: 'Beklenmeyen hata: ' + err.message });
      });
    return true; // async sendResponse
  }

  if (message.type === 'GET_SETTINGS') {
    try {
      var storageResult = browserAPI.storage.local.get(['autoReplyEnabled', 'apiKey', 'language', 'customPrompt', 'replyDelay'], function(result) {
        sendResponse({
          apiKey: result.apiKey || '',
          autoReplyEnabled: result.autoReplyEnabled !== false,
          language: result.language || 'en',
          customPrompt: result.customPrompt || '',
          replyDelay: result.replyDelay || 1200
        });
      });
      // Firefox browser API döner Promise, callback'i de destekler
      if (storageResult && typeof storageResult.then === 'function') {
        storageResult.catch(function(err) {
          sendResponse({ error: err.message });
        });
      }
    } catch(err) {
      sendResponse({ error: err.message });
    }
    return true; // async sendResponse
  }

  if (message.type === 'SAVE_SETTINGS') {
    try {
      var setResult = browserAPI.storage.local.set(message.settings, function() {
        console.log('Settings saved');
        sendResponse({ success: true });
      });
      // Firefox browser API döner Promise, callback'i de destekler
      if (setResult && typeof setResult.then === 'function') {
        setResult.catch(function(err) {
          sendResponse({ success: false, error: err.message });
        });
      }
    } catch(err) {
      sendResponse({ success: false, error: err.message });
    }
    return true; // async sendResponse
  }

  // Bilinmeyen mesaj tipi - yine de true döndür
  return false;
});

console.log('Background script yuklendi!');
