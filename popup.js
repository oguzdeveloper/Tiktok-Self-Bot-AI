// TikTok Self Bot - Popup Script
// Ayarlar arayüzü kontrolü

// Chrome / Firefox uyumluluğu
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

document.addEventListener('DOMContentLoaded', () => {
  // Elemanlar
  const toggleBotBtn = document.getElementById('toggleBotBtn');
  const btnText = document.getElementById('btnText');
  const messageDiv = document.getElementById('message');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');

  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleApiKeyVisibility = document.getElementById('toggleApiKeyVisibility');
  const languageSelect = document.getElementById('languageSelect');
  const customPromptGroup = document.getElementById('customPromptGroup');
  const customPromptInput = document.getElementById('customPromptInput');
  const replyDelayInput = document.getElementById('replyDelayInput');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');

  let isBotActive = true;
  let currentSettings = {};

  // Ayarları yükle
  function loadSettings() {
    try {
      browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' })
        .then((response) => {
          if (response) {
            currentSettings = response;
            updateStatus(response.autoReplyEnabled !== false);

            if (response.apiKey) apiKeyInput.value = response.apiKey;
            if (response.language) languageSelect.value = response.language;
            if (response.customPrompt) customPromptInput.value = response.customPrompt;
            if (response.replyDelay !== undefined) replyDelayInput.value = response.replyDelay;

            updateCustomPromptVisibility();
          }
        })
        .catch((error) => {
          console.error('Settings load error:', error);
          showMessage('Background script not responding!', 'error');
        });
    } catch (e) {
      console.error('Runtime error:', e);
      showMessage('Extension failed to load!', 'error');
    }
  }

  // Durumu güncelle
  function updateStatus(active) {
    isBotActive = active;

    if (active) {
      statusIndicator.className = 'status-indicator active';
      statusText.textContent = 'Bot Active';
      btnText.textContent = 'Stop Bot';
      toggleBotBtn.classList.add('stop-mode');
    } else {
      statusIndicator.className = 'status-indicator inactive';
      statusText.textContent = 'Bot Offline';
      btnText.textContent = 'Start Bot';
      toggleBotBtn.classList.remove('stop-mode');
    }
  }

  // Mesaj göster
  function showMessage(text, type = 'info') {
    messageDiv.textContent = text;
    messageDiv.className = `message ${type}`;
    messageDiv.style.display = 'block';

    setTimeout(() => {
      messageDiv.style.display = 'none';
    }, 3000);
  }

  // Custom prompt görünürlüğü
  function updateCustomPromptVisibility() {
    if (languageSelect.value === 'custom') {
      customPromptGroup.style.display = 'block';
    } else {
      customPromptGroup.style.display = 'none';
    }
  }

  // API Key görünürlük toggle
  toggleApiKeyVisibility.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
    } else {
      apiKeyInput.type = 'password';
    }
  });

  // Dil değişimi
  languageSelect.addEventListener('change', updateCustomPromptVisibility);

  // Ayarları kaydet
  saveSettingsBtn.addEventListener('click', () => {
    const settings = {
      apiKey: apiKeyInput.value.trim(),
      language: languageSelect.value,
      customPrompt: customPromptInput.value.trim(),
      replyDelay: parseInt(replyDelayInput.value, 10) || 1200,
      autoReplyEnabled: isBotActive
    };

    browserAPI.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: settings
    }).then((response) => {
      if (response && response.success) {
        showMessage('Settings saved!', 'success');
        currentSettings = settings;

        // Content script'e bildir
        browserAPI.tabs.query({ url: '*://*.tiktok.com/*' }, (tabs) => {
          if (browserAPI.runtime.lastError) {
            console.error('Tabs query error:', browserAPI.runtime.lastError.message);
            return;
          }
          tabs.forEach(tab => {
            browserAPI.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED' }).catch(() => {});
          });
        });
      } else {
        showMessage('Save failed!', 'error');
      }
    }).catch((error) => {
      console.error('Save error:', error);
      showMessage('Save failed! ' + (error.message || ''), 'error');
    });
  });

  // Başlat/Durdur Butonu
  toggleBotBtn.addEventListener('click', () => {
    const newState = !isBotActive;

    browserAPI.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: {
        autoReplyEnabled: newState,
        apiKey: apiKeyInput.value.trim(),
        language: languageSelect.value,
        customPrompt: customPromptInput.value.trim(),
        replyDelay: parseInt(replyDelayInput.value, 10) || 1200
      }
    }).then((response) => {
      if (response && response.success) {
        showMessage(newState ? 'Bot started!' : 'Bot stopped!', 'success');
        updateStatus(newState);

        // Content script'e bildir
        browserAPI.tabs.query({ url: '*://*.tiktok.com/*' }, (tabs) => {
          if (browserAPI.runtime.lastError) {
            console.error('Tabs query error:', browserAPI.runtime.lastError.message);
            return;
          }
          tabs.forEach(tab => {
            browserAPI.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED' }).catch(() => {});
          });
        });
      } else {
        showMessage('Action failed!', 'error');
      }
    }).catch((error) => {
      console.error('Action error:', error);
      showMessage('Action failed! ' + (error.message || ''), 'error');
    });
  });

  // İlk yükleme
  loadSettings();
});
