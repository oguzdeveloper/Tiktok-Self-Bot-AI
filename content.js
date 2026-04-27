// TikTok Self Bot - Content Script
// TikTok DM sayfasında çalışır, mesajları dinler ve otomatik cevap verir

(function() {
  'use strict';

  // Chrome / Firefox uyumluluğu
  const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

  // Ayarlar
  let settings = {
    autoReplyEnabled: true,
    replyDelay: 1200,
    apiKey: null,
    // Reply (alintili cevap) modu - TikTok'un kendi rendering'inde JSON parse hatasi cikariyor
    // Default false - normal mesaj gonderim daha guvenli
    useReply: false
  };

  // Konuşma geçmişi (her kullanıcı için ayrı)
  const conversationHistories = new Map();
  
  // Kullanici profilleri - bot'un karsi taraf hakkinda ogrendigi bilgiler
  // conversationKey -> { realName, age, location, hobby, ... }
  // "adim X", "ben X", "ismim X" gibi self-disclosure'lardan dogru cikarilir
  const userProfiles = new Map();
  
  // Mesajdan kisisel bilgi cikar (isim vb)
  function extractUserInfo(text, conversationKey) {
    if (!text || typeof text !== 'string') return;
    const lower = text.toLowerCase();
    
    // Isim cikarma pattern'leri - sira onemli, en spesifik once
    const namePatterns = [
      // "benim adim X", "benim ismim X" - en guvenilir
      /\bben[i\u0131]m\s+(?:ad[\u0131i]m|ismim)\s+([a-z\u00e7\u011f\u0131\u00f6\u015f\u00fc]{2,20})\b/i,
      // "adim X", "ismim X"
      /\b(?:ad[\u0131i]m|ismim)\s+([a-z\u00e7\u011f\u0131\u00f6\u015f\u00fc]{2,20})\b/i,
      // "ben X" - SADECE kisa mesajlarda (false-positive azaltmak icin)
      // Ornek: "ben Ahmet" OK, ama "ben iyiyim" yakalanmamali (stop word)
    ];
    
    // "ben Ahmet" pattern'i ayri - kisa mesajda (1-3 kelime)
    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount <= 3) {
      namePatterns.push(/\bben\s+([a-z\u00e7\u011f\u0131\u00f6\u015f\u00fc]{2,20})\b/i);
    }
    
    // Yaygin kelimelerin isim sanilmasini engelle
    const stopWords = new Set([
      'iyiyim', 'iyim', 'iyi', 'kotu', 'k\u00f6t\u00fc', 'guzel', 'g\u00fczel', 'cok', '\u00e7ok',
      'biraz', 'hep', 'hic', 'hi\u00e7', 'hala', 'h\u00e2l\u00e2', 'simdi', '\u015fimdi',
      'burada', 'orada', 'evde', 'okulda', 'isteyim', 'istiyorum', 'olum', '\u00f6l\u00fcm',
      'kanka', 'knk', 'lan', 'amk', 'aq', 'moruk', 'abi', 'evet', 'hayir', 'hay\u0131r',
      'tamam', 'okey', 'ok', 'tabii', 'olur', 'olabilir', 'belki', 'sanirim', 'san\u0131r\u0131m',
      'mutluyum', 'uzgunum', '\u00fcz\u00fcg\u00fcn\u00fcm', 'yorgunum', 'sikildim', 's\u0131k\u0131ld\u0131m',
      'birisi', 'biri', 'kimse',
      'yes', 'no', 'maybe', 'thanks', 'good', 'fine', 'great', 'hello', 'hey', 'sup', 'bro'
    ]);
    
    for (const pattern of namePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].toLowerCase().trim();
        if (stopWords.has(candidate)) continue;
        if (candidate.length < 2 || candidate.length > 20) continue;
        
        // Buyuk harfle baslayacak sekilde formatla
        const formatted = candidate.charAt(0).toUpperCase() + candidate.slice(1);
        
        if (!userProfiles.has(conversationKey)) {
          userProfiles.set(conversationKey, {});
        }
        const profile = userProfiles.get(conversationKey);
        profile.realName = formatted;
        log('Kullanici ismi tespit edildi:', formatted);
        return;
      }
    }
  }
  
  // Chat basina benzersiz gondericiler - grup sohbeti tespiti icin
  // chatId -> Set<senderId>
  const chatSenders = new Map();
  
  // Bir chat grup sohbeti mi? (2+ benzersiz gonderici varsa)
  function isGroupChat(chatId) {
    if (!chatId) return false;
    const senders = chatSenders.get(chatId);
    return senders && senders.size >= 2;
  }
  
  // Bir gondericiyi chat'e kaydet
  function trackSender(chatId, senderId) {
    if (!chatId || !senderId) return;
    if (!chatSenders.has(chatId)) {
      chatSenders.set(chatId, new Set());
    }
    chatSenders.get(chatId).add(senderId);
  }
  
  // İşlenen mesaj ELEMENTLERI (DOM referansiyla takip - WeakSet otomatik temizler)
  let processedElements = new WeakSet();
  
  // Son N saniyede islenen text'ler (DOM rerender / virtualization koruması)
  // Ayni text 3 saniye icinde tekrar gelirse duplicate sayilir (rerender icin yeterli,
  // kullanici tekrar yazarsa cevap alabilsin diye kisa tutuluyor)
  const recentlyProcessedTexts = new Map(); // `${userId}_${text}` -> timestamp
  const RECENT_TEXT_WINDOW_MS = 3000;
  
  function isRecentlyProcessedText(userId, text) {
    const key = `${userId}_${text}`;
    const lastTime = recentlyProcessedTexts.get(key);
    if (!lastTime) return false;
    if (Date.now() - lastTime > RECENT_TEXT_WINDOW_MS) {
      recentlyProcessedTexts.delete(key);
      return false;
    }
    return true;
  }
  
  function markTextProcessed(userId, text) {
    const key = `${userId}_${text}`;
    recentlyProcessedTexts.set(key, Date.now());
    // Eskiyen kayitlari temizle
    if (recentlyProcessedTexts.size > 100) {
      const cutoff = Date.now() - RECENT_TEXT_WINDOW_MS;
      for (const [k, ts] of recentlyProcessedTexts) {
        if (ts < cutoff) recentlyProcessedTexts.delete(k);
      }
    }
  }

  // Durum göstergesi
  let statusIndicator = null;

  // Aktif MutationObserver referansı
  let activeObserver = null;

  // Bot başlangıç zamanı - sadece bu zamandan SONRA gelen mesajlara cevap ver
  let botStartTime = Date.now();
  
  // Observer başlama zamanı - observer başladıktan SONRA eklenen elementleri işle
  let observerStartTime = null;

  // Debug modu - false yaparak logları kapat
  const DEBUG = false;
  
  function log(...args) {
    if (DEBUG) console.log('[TikTok Bot]', ...args);
  }
  
  // Sadece önemli olayları logla
  function logImportant(...args) {
    console.log('[TikTok Bot]', ...args);
  }

  // Ayarları yükle
  function loadSettings() {
    browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' })
      .then((response) => {
        if (response) {
          settings = { ...settings, ...response };
          log('Ayarlar yüklendi:', settings);
          updateStatusIndicator();
        }
      })
      .catch((error) => {
        console.error('[TikTok Bot] Ayar yükleme hatası:', error);
      });
  }

  // Durum göstergesini oluştur
  function createStatusIndicator() {
    if (statusIndicator) return;
    
    statusIndicator = document.createElement('div');
    statusIndicator.id = 'tiktok-bot-status';
    statusIndicator.innerHTML = `
      <div class="bot-status-content">
        <span class="bot-status-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="3" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><circle cx="15" cy="11" r="1.5" fill="currentColor"/><path d="M12 18v3M9 21h6M12 4V2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
        <span class="bot-status-text">Bot Active</span>
      </div>
    `;
    document.body.appendChild(statusIndicator);
    updateStatusIndicator();
  }

  // Durum göstergesini güncelle
  function updateStatusIndicator() {
    if (!statusIndicator) return;
    
    const icon = statusIndicator.querySelector('.bot-status-icon');
    const text = statusIndicator.querySelector('.bot-status-text');
    
    if (!settings.apiKey) {
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#ffaa00" stroke-width="2"/><path d="M12 9v4M12 17h.01" stroke="#ffaa00" stroke-width="2" stroke-linecap="round"/></svg>';
      text.textContent = 'No API Key';
      statusIndicator.classList.add('warning');
      statusIndicator.classList.remove('disabled');
    } else if (settings.autoReplyEnabled) {
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="3" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><circle cx="15" cy="11" r="1.5" fill="currentColor"/><path d="M12 18v3M9 21h6M12 4V2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      text.textContent = 'Bot Active';
      statusIndicator.classList.remove('disabled', 'warning');
    } else {
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M4.93 4.93l14.14 14.14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      text.textContent = 'Bot Offline';
      statusIndicator.classList.add('disabled');
      statusIndicator.classList.remove('warning');
    }
  }

  // TikTok DM sayfasında mıyız kontrol et
  function isDMPage() {
    const url = window.location.href;
    return url.includes('tiktok.com/messages') || 
           url.includes('tiktok.com/dm') ||
           url.includes('/messages');
  }

  // Tüm olası mesaj container'larını bul
  function findAllMessageContainers() {
    const allSelectors = [
      '[class*="DivChatMessagesContainer"]',
      '[class*="ChatMessagesContainer"]',
      '[class*="messages-container"]',
      '[class*="MessagesContainer"]',
      '[data-e2e="chat-messages"]',
      '[data-e2e="dm-chat-messages"]',
      '[class*="DivChatMessageList"]',
      '[class*="ChatMessageList"]',
      '[class*="message-list"]',
      '[class*="MessageList"]',
      '[class*="chat-content"]',
      '[class*="ChatContent"]',
      '[role="log"]',
      '[role="listbox"]'
    ];
    
    for (const selector of allSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          log('Mesaj container bulundu:', selector, elements.length, 'adet');
          return elements;
        }
      } catch (e) {
        // Seçici hatalı olabilir, atla
      }
    }
    
    // Alternatif: tüm scrollable container'ları kontrol et
    const scrollables = document.querySelectorAll('[style*="overflow"]');
    for (const el of scrollables) {
      if (el.scrollHeight > 200) {
        log('Scrollable container bulundu:', el);
        return [el];
      }
    }
    
    return [];
  }

  // Mesaj elemanlarını bul
  function findMessageElements(container) {
    const messageSelectors = [
      '[data-e2e="chat-message"]',
      '[class*="DivChatMessage"]',
      '[class*="ChatMessage"]',
      '[class*="message-item"]',
      '[class*="MessageItem"]',
      '[class*="msg-bubble"]',
      '[class*="MsgBubble"]',
      'div[class*="Div"][class*="Message"]',
      'div[class*="Div"][class*="Chat"]',
      'div[role="listitem"]',
      'li'
    ];
    
    for (const selector of messageSelectors) {
      try {
        const elements = container.querySelectorAll(selector);
        if (elements.length > 0) {
          log('Mesaj elemanları bulundu:', selector, elements.length, 'adet');
          return Array.from(elements);
        }
      } catch (e) {}
    }
    
    return [];
  }

  // Medya turunu tespit et (sticker, video, foto, ses, dosya)
  // Cevap verilmeyecek tum medya turlerini yakalar
  function detectMediaType(messageElement) {
    // 1. VIDEO - <video> elementi
    const videoEl = messageElement.querySelector('video');
    if (videoEl) {
      return '[Video]';
    }
    
    // 2. SES / VOICE MESSAGE - <audio> veya voice container
    const audioEl = messageElement.querySelector('audio');
    if (audioEl) {
      return '[Ses]';
    }
    // Voice message container (data-e2e veya class ile)
    if (messageElement.querySelector('[data-e2e*="voice"], [data-e2e*="audio"], [class*="voice-message"], [class*="VoiceMessage"], [class*="audio-message"], [class*="AudioMessage"], [class*="DivVoice"], [class*="DivAudio"]')) {
      return '[Ses]';
    }
    
    // 3. STICKER - sticker container veya sticker URL'li img
    if (messageElement.querySelector('[data-e2e*="sticker"], [class*="sticker"], [class*="Sticker"], [class*="DivSticker"]')) {
      return '[Sticker]';
    }
    // Sticker img'leri genelde tiktokcdn'de "sticker" path'inde olur
    const stickerImg = messageElement.querySelector('img[src*="sticker"], img[src*="Sticker"], img[alt*="sticker"], img[alt*="Sticker"]');
    if (stickerImg) {
      return '[Sticker]';
    }
    
    // 4. DOSYA / FILE - dosya eki indikatorleri
    if (messageElement.querySelector('[data-e2e*="file"], [class*="file-attachment"], [class*="FileAttachment"], [class*="DivFile"], a[download]')) {
      return '[Dosya]';
    }
    
    // 5. RESIM / IMAGE - genel <img> kontrolu (avatar/profile haric)
    const imgEls = messageElement.querySelectorAll('img');
    for (const imgEl of imgEls) {
      const src = imgEl.src || '';
      const alt = imgEl.alt || '';
      const imgClass = imgEl.className || '';
      
      // Avatar / profil haric
      if (src.includes('avatar') || src.includes('profile') || src.includes('Avatar') ||
          imgClass.includes('avatar') || imgClass.includes('Avatar')) {
        continue;
      }
      // Cok kucuk img'ler (icon, emoji rendering icin) atla
      if (imgEl.naturalWidth > 0 && imgEl.naturalWidth < 32 && imgEl.naturalHeight < 32) {
        continue;
      }
      // Mesaj balonunda gorunur boyutta img varsa = resim mesaji
      if (imgEl.offsetWidth > 40 || imgEl.offsetHeight > 40) {
        return '[Resim]';
      }
    }
    
    return null;
  }

  // Desteklenmeyen mesaj turu placeholder'i mi?
  function isUnsupportedMessage(text) {
    if (!text) return false;
    const patterns = [
      /this message type isn'?t supported/i,
      /download tiktok app to view/i,
      /bu mesaj tur(u|ü) desteklenmiyor/i,
      /tiktok uygulamas(ı|i)n(ı|i) indir/i,
      /^\[.*not supported.*\]$/i,
      /^\[.*desteklenmiyor.*\]$/i
    ];
    return patterns.some(p => p.test(text));
  }

  // Mesaj içeriğini çıkar
  function extractMessageContent(messageElement) {
    // Profil fotoğrafı / avatar container'larını atla
    const className = (messageElement.className && typeof messageElement.className === 'string')
      ? messageElement.className
      : (messageElement.className?.baseVal || '');

    if (className.includes('avatar') || 
        className.includes('Avatar') ||
        className.includes('user-avatar') ||
        className.includes('UserAvatar') ||
        className.includes('css-bactz8')) {
      return null;
    }
    
    // Bot'un kendi eklediği bildirim container'larını atla
    if (className.includes('tiktok-bot-notification') || 
        className.includes('notification-content') ||
        className.includes('notification-icon') ||
        className.includes('notification-text')) {
      return null;
    }
    
    // ONCE medya kontrolu - sticker/video/foto/ses varsa text'e bakma
    const mediaType = detectMediaType(messageElement);
    if (mediaType) {
      return mediaType;
    }
    
    // Mesaj metnini cikar
    const textEls = messageElement.querySelectorAll('[data-e2e="dm-new-message-text"]');
    
    if (textEls.length > 0) {
      // KRITIK: Eger birden fazla text elementi varsa ve farkli mesaj bubble'larindaysa
      // (yani element bir mesaj LIST container'i, tek mesaj DEGIL),
      // null don ki checkIfMessage'in loop'u her birini ayri ayri kuyruga atsin.
      // Bu olmazsa hizli sohbette 3 mesaj birlestirilip TEK cevap aliniyor.
      if (textEls.length > 1) {
        const messageBubbleParents = new Set();
        for (const textEl of textEls) {
          // En yakin "mesaj balonu" parent'i
          const bubble = textEl.closest('[class*="message"], [class*="Message"], [class*="bubble"], [class*="Bubble"], [class*="msg"], [class*="Msg"]') || textEl.parentElement;
          messageBubbleParents.add(bubble);
        }
        // Farkli bubble'larda = ayri mesajlar = loop'a birak
        if (messageBubbleParents.size > 1) {
          return null;
        }
        // Ayni bubble icinde = tek mesaj, satir araliklari ile - birlestir
      }
      
      // Tek mesaj (veya tek bubble icinde multi-line) - birlestir
      let fullMessageText = '';
      for (const textEl of textEls) {
        const text = textEl.textContent?.trim();
        if (text && text.length > 0) {
          if (fullMessageText.length > 0) {
            fullMessageText += ' ';
          }
          fullMessageText += text;
        }
      }
      
      if (fullMessageText.length > 0 && fullMessageText.length < 1000) {
        // Desteklenmeyen mesaj placeholder'ini atla
        if (isUnsupportedMessage(fullMessageText)) {
          return '[Desteklenmiyor]';
        }
        if (!isTimeStamp(fullMessageText) && !isSystemMessage(fullMessageText)) {
          return fullMessageText;
        }
      }
    }
    
    // Element kendisi data-e2e="dm-new-message-text" mi?
    if (messageElement.getAttribute('data-e2e') === 'dm-new-message-text') {
      const text = messageElement.textContent?.trim();
      if (text && text.length > 0 && text.length < 1000) {
        if (isUnsupportedMessage(text)) {
          return '[Desteklenmiyor]';
        }
        if (!isTimeStamp(text) && !isSystemMessage(text)) {
          return text;
        }
      }
    }
    
    return null;
  }

  // Zaman damgası mı kontrol et
  function isTimeStamp(text) {
    const timePatterns = [
      /^\d{1,2}:\d{2}$/,
      /^\d{1,2}:\d{2}\s*(AM|PM)$/i,
      /^(today|yesterday|bugün|dün)/i,
      /^\d{1,2}\s*(min|minute|dakika)/i,
      /^just now$/i,
      /^şimdi$/i
    ];
    
    return timePatterns.some(p => p.test(text));
  }

  // Sistem mesajı mı kontrol et
  function isSystemMessage(text) {
    const trimmed = text.trim();
    const systemPatterns = [
      /^sent a message$/i,
      /^mesaj gönderdi$/i,
      /^.+ is typing\.?\.?\.?$/i,
      /^.+ yazıyor\.?\.?\.?$/i,
      /^seen$/i,
      /^görüldü$/i,
      /^delivered$/i,
      /^iletildi$/i,
      // Medya bildirimleri (sidebar etiketleri)
      /^sent a sticker$/i,
      /^sent a photo$/i,
      /^sent an? image$/i,
      /^sent a video$/i,
      /^sent a voice( message)?$/i,
      /^sent an? audio$/i,
      /^sent a file$/i,
      /^sent a gif$/i,
      /^you sent (a|an) .+$/i,
      /^.+ sent (a|an) (sticker|photo|image|video|voice|audio|file|gif|message)$/i,
      /^çıkart(ı|m)a gönderdi$/i,
      /^foto(g|ğ)raf gönderdi$/i,
      /^video gönderdi$/i,
      /^ses gönderdi$/i,
      // Reply etiketleri
      /^replied to you$/i,
      /^sana yanıt verdi$/i,
      /^you replied$/i
    ];
    
    return systemPatterns.some(p => p.test(trimmed));
  }

  // Mesajın benden mi geldiğini kontrol et
  function isMyMessage(messageElement) {
    const messageTextEl = messageElement.querySelector('[data-e2e="dm-new-message-text"]') || 
                          (messageElement.getAttribute('data-e2e') === 'dm-new-message-text' ? messageElement : null);
    
    if (!messageTextEl) {
      const parent = messageElement.closest('[data-e2e="dm-new-message-text"]');
      if (parent) {
        return checkIfMyMessage(parent);
      }
      return false;
    }
    
    return checkIfMyMessage(messageTextEl);
  }
  
  // Mesajın benden mi olduğunu kontrol et
  function checkIfMyMessage(messageTextEl) {
    const msgContainer = messageTextEl.closest('[class*="DivMessageVertical"]');
    if (!msgContainer) return false;
    
    // Alternatif: mesaj balonunun class'ında "Right" var mı?
    const bubbleClass = msgContainer.className || '';
    if (bubbleClass.includes('Right') || bubbleClass.includes('right')) {
      log('Kendi mesajım (class Right)');
      return true;
    }

    // Avatar pozisyonuna göre kontrol
    const img = msgContainer.querySelector('img');
    if (img) {
      const imgRect = img.getBoundingClientRect();
      const containerRect = msgContainer.getBoundingClientRect();
      
      const imgCenter = imgRect.left + imgRect.width / 2;
      const containerCenter = containerRect.left + containerRect.width / 2;
      
      if (imgCenter > containerCenter + 20) {
        log('Kendi mesajım (avatar sağda)');
        return true;
      } else {
        log('Karşıdan gelen mesaj (avatar solda)');
        return false;
      }
    }
    
    return false;
  }

  // Aktif chat'in ID'sini (URL'den) al - 1-on-1 ve grup icin ortak
  function getCurrentChatId() {
    const urlMatch = window.location.href.match(/messages\/([^\/\?&#]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }
    return 'unknown_chat';
  }

  // Chat baslik / ad - sadece display icin
  function getCurrentChatTitle() {
    const usernameSelectors = [
      '[data-e2e="chat-username"]',
      '[class*="DivChatTitle"]',
      '[class*="ChatTitle"]',
      '[class*="username"]',
      '[class*="Username"]',
      'h2',
      'h3'
    ];
    
    for (const selector of usernameSelectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent?.trim()) {
        const text = el.textContent.trim();
        if (text.length > 0 && text.length < 50) {
          return text;
        }
      }
    }
    return 'unknown';
  }

  // Mesaji gonderen kisinin bilgilerini cikar
  // PRIMARY: profil linki <a href="/@username"> - en guvenilir kaynak
  // FALLBACK: avatar URL hash
  // SKIP: alt="image message" olan avatarlar (sticker/foto icerigi, kullanici degil)
  function getMessageSenderInfo(messageElement) {
    const msgContainer = messageElement.closest('[class*="DivMessageVertical"]') ||
                         messageElement.closest('[class*="DivChatItemWrapper"]') ||
                         messageElement.closest('[data-e2e="dm-new-chat-item"]') ||
                         messageElement.parentElement;
    
    if (!msgContainer) return { senderId: null, senderName: null };
    
    // 1. PRIMARY: Profil linki <a href="/@username">
    // Bu TikTok'ta her mesaj balonunda gondericinin profiline link verir
    const profileLinks = msgContainer.querySelectorAll('a[href^="/@"]');
    for (const link of profileLinks) {
      const href = link.getAttribute('href') || '';
      // /@username veya /@username/video/123 gibi olabilir, sadece username'i al
      const match = href.match(/^\/@([^\/\?#]+)/);
      if (match && match[1]) {
        const username = match[1];
        // Reply blogundaki linkleri at - sadece direkt mesaj sahibinin linkini al
        // Reply container'inda olan link'ler farkli kisileri gosterir
        const isInReply = link.closest('[class*="DivChatItemSenderNameContainer"]') ||
                          link.closest('[class*="DivRefTextContent"]');
        if (!isInReply) {
          return {
            senderId: 'u_' + username,
            senderName: username
          };
        }
      }
    }
    
    // 2. FALLBACK: Avatar URL (data-e2e="chat-avatar" cocugu olan img)
    const avatarContainer = msgContainer.querySelector('[data-e2e="chat-avatar"]');
    let avatar = null;
    if (avatarContainer) {
      avatar = avatarContainer.querySelector('img');
    }
    if (!avatar) {
      // Son care - herhangi bir img (image message degil ise)
      const allImgs = msgContainer.querySelectorAll('img');
      for (const img of allImgs) {
        // "image message" avatari atla - bu sticker/foto icerigi
        if (img.alt === 'image message') continue;
        avatar = img;
        break;
      }
    }
    
    if (avatar && avatar.src) {
      const src = avatar.src;
      if (!src.includes('default') && !src.includes('placeholder')) {
        const url = src.split('?')[0];
        const parts = url.split('/');
        const lastPart = parts[parts.length - 1] || url;
        // URL hash'inden ID olustur, isim yok
        return {
          senderId: 'av_' + lastPart.substring(0, 40),
          senderName: null
        };
      }
    }
    
    return { senderId: null, senderName: null };
  }

  // Geriye uyumluluk icin eski API
  function getMessageSenderId(messageElement) {
    return getMessageSenderInfo(messageElement).senderId;
  }
  
  function getMessageSenderName(messageElement) {
    return getMessageSenderInfo(messageElement).senderName;
  }

  // Conversation history key'i olustur
  // 1-on-1 chat: chatId
  // Grup chat: chatId + senderId
  function getConversationKey(chatId, senderId) {
    if (senderId) {
      return chatId + '_' + senderId;
    }
    return chatId;
  }

  // Konuşma geçmişini güncelle
  function updateConversationHistory(conversationKey, role, content) {
    if (!conversationHistories.has(conversationKey)) {
      conversationHistories.set(conversationKey, []);
    }
    
    const history = conversationHistories.get(conversationKey);
    history.push({ role, content });
    
    // Son 20 mesajı tut
    if (history.length > 20) {
      history.shift();
    }
  }

  // Mesaj gönderme alanını bul
  function findMessageInput() {
    const selectors = [
      '[data-e2e="dm-chat-input"]',
      '[data-e2e="chat-input"]',
      '[class*="DivChatInput"]',
      '[class*="ChatInput"]',
      '[class*="message-input"]',
      '[class*="MessageInput"]',
      'div[contenteditable="true"]',
      'textarea[placeholder]',
      'input[type="text"]'
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        if (element.offsetWidth > 0 && element.offsetHeight > 0) {
          const isInput = element.tagName === 'TEXTAREA' || 
                         element.tagName === 'INPUT' ||
                         element.getAttribute('contenteditable') === 'true';
          if (isInput) {
            log('Mesaj input bulundu:', selector);
            return element;
          }
        }
      }
    }
    return null;
  }

  // Gönder butonunu bul
  function findSendButton() {
    const selectors = [
      '[data-e2e="dm-send-button"]',
      '[data-e2e="send-button"]',
      'button[type="submit"]',
      'button[class*="send"]',
      'button[class*="Send"]',
      'button[aria-label*="send"]',
      'button[aria-label*="gönder"]'
    ];
    
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && element.offsetWidth > 0) {
        log('Gönder butonu bulundu:', selector);
        return element;
      }
    }
    return null;
  }

  // Reply butonunu bul ve tıkla
  function clickReplyButton(messageElement) {
    let msgContainer = messageElement.closest('[class*="DivMessageVertical"]') ||
                       messageElement.closest('[class*="DivChatItemWrapper"]') ||
                       messageElement.closest('[data-e2e="dm-new-chat-item"]');
    
    if (!msgContainer) {
      let parent = messageElement.parentElement;
      let attempts = 0;
      while (parent && attempts < 10) {
        const cls = parent.className || '';
        if (cls.includes('DivMessageVertical') || 
            cls.includes('DivChatItemWrapper') ||
            cls.includes('ChatItem')) {
          msgContainer = parent;
          break;
        }
        parent = parent.parentElement;
        attempts++;
      }
    }
    
    if (!msgContainer) {
      log('Reply: Mesaj container bulunamadı');
      return Promise.resolve(false);
    }
    
    // Mouse over event'i tetikle
    msgContainer.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    msgContainer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    
    let p = msgContainer.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      p.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      p = p.parentElement;
    }
    
    return new Promise((resolve) => {
      setTimeout(() => {
        let buttons = msgContainer.querySelectorAll('[class*="DivIconAction"]');
        
        if (buttons.length === 0) {
          buttons = msgContainer.querySelectorAll('button, [role="button"], [class*="IconAction"]');
        }
        
        if (buttons.length === 0) {
          buttons = msgContainer.querySelectorAll('div[class*="DivIconAction"], span[class*="DivIconAction"]');
        }
        
        log('Reply: Butonlar bulundu:', buttons.length);
        
        if (buttons.length >= 2) {
          buttons[1].click();
          resolve(true);
        } else if (buttons.length === 1) {
          buttons[0].click();
          resolve(true);
        } else {
          log('Reply butonu bulunamadı, normal gönderim yapılacak');
          resolve(false);
        }
      }, 500);
    });
  }

  // Mesaj gönder - LEXICAL/REACT UYUMLU SADELESTIRILMIS YONTEM
  // KRITIK: 
  //  - input.innerHTML = '' KULLANMA - React state'ini bozar
  //  - execCommand selectAll/delete kullanma - Lexical state'ini "e is null" hatasiyla bozuyor
  //  - Multiple Enter event (keydown+keypress+keyup) bot tarafindan birden fazla submit tetikleyebilir
  //  - Sadece ClipboardEvent paste + InputEvent + tek Enter (keydown) kullan
  async function sendMessage(text) {
    logImportant('Mesaj gönderiliyor:', text);
    
    const input = findMessageInput();
    
    if (!input) {
      logImportant('HATA: Mesaj giriş alanı bulunamadı!');
      showNotification('Mesaj kutusu bulunamadı!', 'error');
      return false;
    }
    
    // Focus
    input.focus();
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Mevcut icerik varsa: SADECE beforeinput + InputEvent ile temizle
    // (execCommand'i tamamen birakitik - Lexical "e is null" hatasi cikariyor)
    if (input.textContent && input.textContent.trim().length > 0) {
      try {
        // Lexical icin: select-all benzeri davranis, sonra deleteContent input event
        const range = document.createRange();
        range.selectNodeContents(input);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        await new Promise(resolve => setTimeout(resolve, 30));
        
        input.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'deleteContentBackward',
          bubbles: true,
          cancelable: true
        }));
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch(e) {
        log('Temizleme hatasi:', e.message);
      }
    }
    
    // ClipboardEvent paste - Lexical/Draft.js native handle eder
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      });
      input.dispatchEvent(pasteEvent);
    } catch(e) {
      log('Paste event hatasi:', e.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Paste calismadiysa: beforeinput + insertFromPaste fallback (execCommand'siz)
    if (!input.textContent || input.textContent.trim().length === 0) {
      try {
        // beforeinput event - React/Lexical bunu native handle eder
        input.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertFromPaste',
          data: text,
          bubbles: true,
          cancelable: true
        }));
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Hala bossa son care: execCommand insertText (degerli kullanicilar icin fallback)
        if (!input.textContent || input.textContent.trim().length === 0) {
          document.execCommand('insertText', false, text);
        }
      } catch(e) {
        log('insertText fallback hatasi:', e.message);
      }
    }
    
    // Paste sonrasi React/Lexical state'inin senkronize olmasi icin biraz bekle
    await new Promise(resolve => setTimeout(resolve, 350));
    
    // Gönder butonunu bul ve tıkla (TIKLAMA Enter'dan daha guvenli)
    const sendButton = findSendButton();
    
    if (sendButton && sendButton.offsetWidth > 0) {
      logImportant('Gönder butonuna tıklanıyor...');
      sendButton.click();
    } else {
      logImportant('Enter ile gönderiliyor...');
      
      // SADECE keydown - keypress + keyup TikTok editor'unde "e is null" tetikliyordu
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }
    
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const isInputCleared = !input.textContent || input.textContent.trim() === '';
    
    if (isInputCleared) {
      logImportant('Mesaj başarıyla gönderildi!');
      showNotification('Mesaj gönderildi!', 'success');
      return true;
    } else {
      logImportant('Mesaj gönderilemedi!');
      showNotification('Mesaj gönderilemedi!', 'error');
      return false;
    }
  }

  // Bildirim göster
  function showNotification(text, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `tiktok-bot-notification ${type}`;
    notification.innerHTML = `
      <div class="notification-content ${type}">
        <span class="notification-icon">${type === 'success' ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 11.08V12a10 10 0 11-5.93-9.14" stroke="#00ff88" stroke-width="2" stroke-linecap="round"/><path d="M22 4L12 14.01l-3-3" stroke="#00ff88" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : type === 'error' ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#ff4444" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" stroke="#ff4444" stroke-width="2" stroke-linecap="round"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#48dbfb" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="#48dbfb" stroke-width="2" stroke-linecap="round"/></svg>'}</span>
        <span class="notification-text">${text}</span>
      </div>
    `;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 3000);
  }

  // Son gelen mesaj elementi (reply için)
  let lastReceivedMessageElement = null;

  // Reply ile mesaj gönder
  async function sendReplyMessage(text, messageElement) {
    log('Reply ile mesaj gönderiliyor:', text);
    
    const replyClicked = await clickReplyButton(messageElement);
    
    if (!replyClicked) {
      log('Reply butonu tıklanamadı, normal gönderim yapılacak');
      return false;
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const input = findMessageInput();
    const sendButton = findSendButton();
    
    if (!input) {
      log('HATA: Mesaj giriş alanı bulunamadı!');
      return false;
    }
    
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, text);
      } else {
        input.value = text;
      }
      
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      
    } else if (input.getAttribute('contenteditable') === 'true') {
      input.focus();
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // React-friendly temizleme - input.textContent = '' KULLANMA
      if (input.textContent && input.textContent.trim().length > 0) {
        try {
          document.execCommand('selectAll', false, null);
          await new Promise(resolve => setTimeout(resolve, 30));
          document.execCommand('delete', false, null);
        } catch(e) {}
      }
      
      try {
        document.execCommand('insertText', false, text);
      } catch(e) {
        log('insertText hatasi:', e.message);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (sendButton) {
      log('Reply: Gönder butonuna tıklanıyor...');
      sendButton.click();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    }
    
    log('Reply mesajı gönderildi!');
    showNotification('AI cevabı reply olarak gönderildi!', 'success');
    return true;
  }

  // Debounce icin bekleyen elementler
  let pendingElements = [];
  let debounceTimer = null;

  // Tüm DOM değişikliklerini izle
  function observeAllChanges() {
    // Eski observer varsa önce kapat
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
      log('Eski MutationObserver kapatıldı');
    }
    
    // Pending temizle
    pendingElements = [];
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    
    log('DOM değişiklikleri izlenmeye başlanıyor...');
    
    // Observer başlama zamanını kaydet - bu zamandan SONRA eklenen elementleri işle
    observerStartTime = Date.now();
    
    activeObserver = new MutationObserver((mutations) => {
      // Observer başlamadan önce eklenen elementleri atla
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pendingElements.push(node);
          }
        }
      }
      
      // Debounce: 300ms bekle, TikTok DOM renderini bitirsin (hizli sohbet icin dusuruldu)
      // Yarim render olursa processQueue icindeki fresh content read kapsayacak
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        const elements = pendingElements.slice();
        pendingElements = [];
        for (const el of elements) {
          // Element hala DOM'da mi kontrol et
          if (document.body.contains(el)) {
            checkIfMessage(el, observerStartTime);
          }
        }
      }, 300);
    });
    
    activeObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
    
    log('MutationObserver kuruldu (debounced), başlama zamanı:', observerStartTime);
  }

  // Mesaj kuyruğu
  const messageQueue = [];
  let isProcessingQueue = false;

  // Mesajı kuyruğa ekle
  function queueMessage(messageContent, conversationKey, senderName, messageElement, elementTimestamp) {
    // Medya/marker mesajlari kuyruga bile alma
    const mediaMarkers = ['[Resim]', '[Video]', '[Sticker]', '[Ses]', '[Dosya]', '[Desteklenmiyor]'];
    if (mediaMarkers.includes(messageContent)) {
      log('Medya mesaji kuyruga eklenmedi:', messageContent);
      return;
    }
    if (/^\[[^\]]+\]$/.test(messageContent.trim())) {
      log('Marker mesaji kuyruga eklenmedi:', messageContent);
      return;
    }
    
    // Kuyrukta zaten var mı kontrol et (ayni gonderici icin)
    const alreadyQueued = messageQueue.some(m => m.content === messageContent && m.conversationKey === conversationKey);
    if (alreadyQueued) {
      log('Mesaj zaten kuyrukta, atlanıyor');
      return;
    }

    // Eğer elementTimestamp varsa ve bot başlangıç zamanından önceyse, atla
    if (elementTimestamp && elementTimestamp < botStartTime) {
      log('Eski mesaj, atlanıyor (zaman kontrolü)');
      return;
    }

    messageQueue.push({
      content: messageContent,
      conversationKey: conversationKey,
      senderName: senderName,
      element: messageElement,
      timestamp: Date.now()
    });
    
    logImportant('Mesaj kuyruğa eklendi. Kuyruk boyutu:', messageQueue.length, '| Sender:', senderName || 'unknown');
    processQueue();
  }

  // Kuyruğu sırayla işle
  async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) {
      return;
    }
    
    isProcessingQueue = true;
    
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      logImportant('Kuyruk işleniyor. Kalan:', messageQueue.length);
      
      // Element hala DOM'daysa fresh content oku - TikTok mesaji parca parca
      // render ettiyse queue'da bekleme suresinde tam metin olusmus olur
      let actualContent = msg.content;
      if (msg.element && document.body.contains(msg.element)) {
        try {
          const fresh = extractMessageContent(msg.element);
          // Daha uzun + ayni prefix ile basliyorsa yarim render'di, simdi tamamlandi
          if (fresh && typeof fresh === 'string' &&
              !/^\[[^\]]+\]$/.test(fresh.trim()) &&
              fresh.length > actualContent.length &&
              fresh.startsWith(actualContent.substring(0, Math.min(15, actualContent.length)))) {
            log('Mesaj icerigi guncellendi:', actualContent.length, '->', fresh.length, 'karakter');
            actualContent = fresh;
          }
        } catch(e) {}
      }
      
      await handleIncomingMessage(actualContent, msg.conversationKey, msg.senderName, msg.element);
      
      if (messageQueue.length > 0) {
        // Kuyrukta hala mesaj var - kisa gecikme ile siradakine gec
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    
    isProcessingQueue = false;
  }

  // Mesaj işleme (Promise tabanlı)
  function handleIncomingMessage(messageContent, conversationKey, senderName, messageElement = null) {
    return new Promise((resolve) => {
      if (!settings.autoReplyEnabled) {
        resolve();
        return;
      }
      
      if (!settings.apiKey) {
        showNotification('API key not set!', 'error');
        resolve();
        return;
      }
      
      // Medya mesajlarına ve desteklenmeyen mesajlara cevap VERME
      const mediaMarkers = ['[Resim]', '[Video]', '[Sticker]', '[Ses]', '[Dosya]', '[Desteklenmiyor]'];
      if (mediaMarkers.includes(messageContent)) {
        log('Medya/desteklenmeyen mesaj, cevap verilmeyecek:', messageContent);
        resolve();
        return;
      }
      
      // Sadece [...] markerlardan olusan mesajlari atla
      if (/^\[[^\]]+\]$/.test(messageContent.trim())) {
        log('Marker mesaj, cevap verilmeyecek:', messageContent);
        resolve();
        return;
      }
      
      // Son 3 saniyede ayni text geldiyse duplicate (rerender korumasi)
      if (isRecentlyProcessedText(conversationKey, messageContent)) {
        log('Mesaj son 3sn icinde islendi (rerender), atlanıyor');
        resolve();
        return;
      }
      markTextProcessed(conversationKey, messageContent);
      
      if (messageElement) {
        lastReceivedMessageElement = messageElement;
      }
      
      // Grup sohbeti mi tespit et
      const chatId = getCurrentChatId();
      const isGroup = isGroupChat(chatId);
      
      logImportant('AI cevap hazırlanıyor (' + (senderName || 'unknown') + (isGroup ? ' [GRUP]' : '') + ', ' + messageContent.length + ' krk):', messageContent);
      showNotification('AI cevap hazırlanıyor...', 'info');
      
      // Mesajdan kisisel bilgi cikar (isim vb) - bot karsi tarafi tanisin
      extractUserInfo(messageContent, conversationKey);
      
      updateConversationHistory(conversationKey, 'user', messageContent);
      const history = conversationHistories.get(conversationKey);
      const userProfile = userProfiles.get(conversationKey) || null;
      
      browserAPI.runtime.sendMessage({
        type: 'GENERATE_RESPONSE',
        userMessage: messageContent,
        conversationHistory: history,
        senderName: senderName,
        isGroup: isGroup,
        userProfile: userProfile
      }, async (response) => {
        // Chrome'da runtime.lastError kontrolü
        if (browserAPI.runtime.lastError) {
          logImportant('Runtime hatası:', browserAPI.runtime.lastError.message);
          showNotification('Bağlantı hatası!', 'error');
          resolve();
          return;
        }

        if (!response || response.error) {
          logImportant('AI hatası:', response?.error || 'Yanıt yok');
          // Hata durumunda sessizce atla, spam yapma
          resolve();
          return;
        }
        
        const aiResponse = response.response;
        
        // Bos veya anlamsiz yanitlari gonderme
        if (!aiResponse || aiResponse.trim().length < 1) {
          logImportant('AI bos yanit dondu, mesaj gonderilmeyecek');
          resolve();
          return;
        }
        
        // GRUP SOHBETI ise cevabin basina @senderName ekle - kim kime cevap veriyor netlik
        // 1-on-1 sohbette gereksiz, ad eklenmez
        let finalResponse = aiResponse;
        if (isGroup && senderName && senderName.length > 0 && senderName !== 'unknown') {
          const lowerResp = aiResponse.toLowerCase().trim();
          const lowerName = senderName.toLowerCase();
          // Model zaten ad ile baslamissa duplicate yapma
          const alreadyStartsWithName = 
            lowerResp.startsWith(lowerName) ||
            lowerResp.startsWith('@' + lowerName);
          if (!alreadyStartsWithName) {
            finalResponse = '@' + senderName + ' ' + aiResponse;
          }
        }
        
        logImportant('AI cevabı:', finalResponse);
        
        updateConversationHistory(conversationKey, 'assistant', finalResponse);
        
        setTimeout(async () => {
          let replySuccess = false;
          // Reply mode sadece settings.useReply true ise denenir
          // TikTok'un kendi rendering'inde 'ref message content parse error' cikariyor
          if (settings.useReply && lastReceivedMessageElement) {
            replySuccess = await sendReplyMessage(finalResponse, lastReceivedMessageElement);
          }
          
          if (!replySuccess) {
            await sendMessage(finalResponse);
          }
          
          logImportant('Cevap gönderildi!');
          resolve();
        }, settings.replyDelay);
      });
    });
  }

  // Mesajin chat containerinin altinda (yeni mesaj) olup olmadigini kontrol et
  function isNearBottomOfChat(element) {
    // Mesaj containerini bul
    const chatContainer = element.closest('[class*="DivChatMessagesContainer"]') ||
                          element.closest('[class*="ChatMessagesContainer"]') ||
                          element.closest('[class*="message-list"]') ||
                          element.closest('[class*="MessageList"]') ||
                          element.closest('[data-e2e="chat-messages"]') ||
                          element.closest('[role="log"]');
    
    if (!chatContainer) {
      // Container bulunamazsa, guvende olmak icin true don
      return true;
    }
    
    // Scroll pozisyonu kontrolu: container neredeyse en alttaysa mesaj yeni demektir
    const scrollBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
    if (scrollBottom < 200) {
      return true;
    }
    
    // Element'in container icindeki pozisyonu
    const containerRect = chatContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    
    // Element container'in alt %40'inda mi?
    const containerBottom = containerRect.bottom;
    const containerHeight = containerRect.height;
    const threshold = containerBottom - (containerHeight * 0.4);
    
    if (elementRect.top > threshold) {
      return true;
    }
    
    log('Eski mesaj (pozisyon kontrolu), atlanıyor');
    return false;
  }

  // Elemanın mesaj olup olmadığını kontrol et
  // observerStartTime: observer başladığı zaman - bu zamandan SONRA eklenen elementleri işle
  function checkIfMessage(element, observerStartTime) {
    // Eğer observer henüz başlamadıysa, elementi işleme
    if (!observerStartTime) {
      return;
    }
    
    const messageClassPatterns = [
      'message', 'Message', 'chat', 'Chat', 'msg', 'Msg',
      'bubble', 'Bubble', 'item', 'Item'
    ];
    
    const className = (element.className && typeof element.className === 'string') 
      ? element.className 
      : (element.className?.baseVal || '');
    
    // Bot'un kendi eklediği elementleri ve editor'ı atla
    if (className.includes('avatar') || 
        className.includes('Avatar') ||
        className.includes('user-avatar') ||
        className.includes('tiktok-bot-notification') ||
        className.includes('notification-content') ||
        className.includes('notification-icon') ||
        className.includes('notification-text') ||
        className.includes('public-DraftEditor') ||
        className.includes('DraftEditorPlaceholder')) {
      return;
    }
    
    const isPotentialMessage = messageClassPatterns.some(p => className.includes(p));
    
    if (!isPotentialMessage && element.tagName !== 'DIV' && element.tagName !== 'LI') {
      return;
    }
    
    // Mesaj içeriği var mı?
    const content = extractMessageContent(element);
    if (!content) {
      // Alt elemanları kontrol et - parent icindeki TUM yeni mesajlari isle
      // (return YERINE continue - hizli sohbette mesaj kaybini onler)
      const messageTexts = element.querySelectorAll('[data-e2e="dm-new-message-text"]');
      for (const textEl of messageTexts) {
        const text = textEl.textContent?.trim();
        if (!text || text.length === 0 || text.length >= 500) continue;
        if (isTimeStamp(text) || isSystemMessage(text) || isMyMessage(textEl)) continue;
        
        const chatId = getCurrentChatId();
        const senderInfo = getMessageSenderInfo(textEl);
        const senderId = senderInfo.senderId;
        const senderName = senderInfo.senderName;
        const conversationKey = getConversationKey(chatId, senderId);
        
        // Sender'i chat'te kayit et (grup tespiti icin)
        trackSender(chatId, senderId);
        
        // Element zaten islendiyse atla
        if (processedElements.has(textEl)) continue;
        // Son N saniyede ayni text geldiyse atla (rerender koruması)
        if (isRecentlyProcessedText(conversationKey, text)) {
          processedElements.add(textEl);
          continue;
        }
        // Eski mesaj pozisyon kontrolu
        if (!isNearBottomOfChat(textEl)) {
          processedElements.add(textEl);
          log('Eski mesaj (pozisyon), isaretlen:', text.substring(0, 20));
          continue;
        }
        processedElements.add(textEl);
        log('Yeni mesaj bulundu (sender:', senderName || 'unknown', '):', text);
        queueMessage(text, conversationKey, senderName, textEl, Date.now());
      }
      return;
    }
    
    // Benim mesajım mı?
    if (isMyMessage(element)) {
      log('Kendi mesajım, atlanıyor');
      return;
    }
    
    const chatId = getCurrentChatId();
    const senderInfo = getMessageSenderInfo(element);
    const senderId = senderInfo.senderId;
    const senderName = senderInfo.senderName;
    const conversationKey = getConversationKey(chatId, senderId);
    
    // Sender'i chat'te kayit et (grup tespiti icin)
    trackSender(chatId, senderId);
    
    // Element zaten islendiyse atla
    if (processedElements.has(element)) {
      return;
    }
    // Son 3 saniyede ayni text geldiyse atla (rerender koruması)
    if (isRecentlyProcessedText(conversationKey, content)) {
      processedElements.add(element);
      return;
    }
    // Eski mesaj pozisyon kontrolu
    if (!isNearBottomOfChat(element)) {
      processedElements.add(element);
      log('Eski mesaj (pozisyon), isaretlen:', content.substring(0, 20));
      return;
    }
    processedElements.add(element);
    log('Yeni mesaj bulundu (sender:', senderName || 'unknown', '):', content);
    queueMessage(content, conversationKey, senderName, element, Date.now());
  }

  // Tek seferde tum gorunur mesajlari tara ve isaretle
  // Ayni zamanda gondericileri kayit eder (grup tespiti icin)
  function doSingleScan() {
    let count = 0;
    const chatId = getCurrentChatId();
    
    // 1. Container-based tarama
    const containers = findAllMessageContainers();
    for (const container of containers) {
      const messages = findMessageElements(container);
      for (const msg of messages) {
        const content = extractMessageContent(msg);
        if (content) {
          // Sender kayit (grup tespiti)
          if (!isMyMessage(msg)) {
            const senderId = getMessageSenderInfo(msg).senderId;
            if (senderId) trackSender(chatId, senderId);
          }
          if (!processedElements.has(msg)) {
            processedElements.add(msg);
            count++;
          }
        }
      }
    }

    // 2. data-e2e ile direkt tarama
    const allTexts = document.querySelectorAll('[data-e2e="dm-new-message-text"]');
    for (const textEl of allTexts) {
      const text = textEl.textContent?.trim();
      if (text && text.length > 0 && text.length < 500) {
        // Sender kayit (grup tespiti)
        if (!isMyMessage(textEl)) {
          const senderId = getMessageSenderInfo(textEl).senderId;
          if (senderId) trackSender(chatId, senderId);
        }
        if (!processedElements.has(textEl)) {
          processedElements.add(textEl);
          count++;
        }
      }
    }

    // 3. Tum mesaj balonlarindaki metinleri de tara
    const bubbleSelectors = [
      '[class*="DivMessageVertical"]',
      '[class*="ChatMessage"]',
      '[class*="msg-bubble"]',
      '[data-e2e="dm-new-chat-item"]'
    ];
    for (const selector of bubbleSelectors) {
      try {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          const text = el.textContent?.trim();
          if (text && text.length > 0 && text.length < 500 && !isTimeStamp(text)) {
            if (!processedElements.has(el)) {
              processedElements.add(el);
              count++;
            }
          }
        }
      } catch(e) {}
    }
    
    return count;
  }

  // Sayfadaki mevcut mesajlari tara ve isaretleme yap (cevap VERME)
  // Birden fazla tarama yaparak lazy-loaded mesajlari da yakala
  function scanExistingMessages() {
    log('Mevcut mesajlar taranıyor (1. tarama)...');
    const count1 = doSingleScan();
    logImportant('1. tarama:', count1, 'mesaj isaretlendi');
    
    // 2. tarama - 1 saniye sonra (lazy-loaded icin)
    setTimeout(() => {
      const count2 = doSingleScan();
      if (count2 > 0) {
        logImportant('2. tarama:', count2, 'yeni mesaj isaretlendi');
      }
    }, 1000);
    
    // 3. tarama - 2.5 saniye sonra (gec yuklenenler icin)
    setTimeout(() => {
      const count3 = doSingleScan();
      if (count3 > 0) {
        logImportant('3. tarama:', count3, 'yeni mesaj isaretlendi');
      }
    }, 2500);
  }

  // URL değişikliklerini izle (SPA için)
  function observeUrlChanges() {
    let lastUrl = window.location.href;
    
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function() {
      originalPushState.apply(history, arguments);
      onUrlChange();
    };
    
    history.replaceState = function() {
      originalReplaceState.apply(history, arguments);
      onUrlChange();
    };
    
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
    
    function onUrlChange() {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        log('URL değişti:', lastUrl);
        
        // Bot başlangıç zamanını güncelle - sadece bu zamandan SONRA gelen mesajlara cevap ver
        botStartTime = Date.now();
        
        // Observer başlama zamanını da güncelle - yeni sohbet için
        observerStartTime = null;
        
        // İşlenmiş mesajları temizle (yeni sohbet)
        processedElements = new WeakSet();
        recentlyProcessedTexts.clear();
        messageQueue.length = 0;
        isProcessingQueue = false;
        lastReceivedMessageElement = null;
        
        if (isDMPage()) {
          // Yeni sohbet için: önce mevcut mesajları tara, SONRA observer'ı yeniden başlat
          setTimeout(() => {
            logImportant('Yeni sohbet - mevcut mesajlar taranıyor...');
            scanExistingMessages();
            
            // Observer'ı yeniden başlat
            setTimeout(() => {
              logImportant('Observer yeniden başlatılıyor...');
              observeAllChanges();
            }, 500);
          }, 3000);
        }
      }
    }
  }

  // Başlat
  function init() {
    logImportant('=== TikTok Self Bot Başlatılıyor ===');
    
    // Ayarları yükle
    loadSettings();
    
    // Durum göstergesini oluştur
    setTimeout(createStatusIndicator, 500);
    
    // URL değişikliklerini izle
    observeUrlChanges();
    
    // ÖNCE mevcut mesajları işaretle, SONRA observer'ı başlat
    if (isDMPage()) {
      // 3 saniye bekle - sayfanın tam yüklenmesi için
      setTimeout(() => {
        logImportant('Mevcut mesajlar taranıyor...');
        scanExistingMessages();
        
        // Tarama bittikten SONRA observer'ı başlat
        setTimeout(() => {
          logImportant('DOM observer başlatılıyor...');
          observeAllChanges();
          logImportant('=== Bot Başlatıldı - Sadece YENİ mesajlara cevap verilecek ===');
        }, 500);
      }, 3000);
    } else {
      // DM sayfası değilse observer başlatma - URL değişikliğinde tekrar kontrol edilecek
      logImportant('=== Bot Başlatıldı (DM sayfası değil - observer bekleniyor) ===');
    }
    
    // Ayar değişikliklerini dinle
    browserAPI.runtime.onMessage.addListener((message) => {
      if (message.type === 'SETTINGS_CHANGED') {
        loadSettings();
      }
    });
  }

  // Sayfa yüklendiğinde başlat
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
