# 🤖 TikTok AI Auto Reply

> **AI-powered Firefox extension that automatically replies to TikTok DMs.**
> <br>**OpenAI-uyumlu API ile çalışan Firefox eklentisi — TikTok DM'lerine otomatik AI cevapları.**

[![Firefox](https://img.shields.io/badge/Firefox-Compatible-orange?logo=firefox)](https://www.mozilla.org/firefox/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![AI](https://img.shields.io/badge/AI-OpenAI%20compatible-blue)](https://platform.openai.com/docs/api-reference/chat)

---

## 🌍 English

### Overview

TikTok AI Auto Reply is a browser extension that listens to incoming TikTok DMs and generates smart, contextual replies using any **OpenAI-compatible API** (OpenAI, OpenRouter, Fireworks, or a local model).

### Features

- **🔥 AI Auto-Reply** — Responds to incoming TikTok DMs automatically
- **💬 Conversation Memory** — Remembers previous messages for contextual replies
- **🌐 Multi-Language** — Supports **English** and **Turkish** with customizable system prompts
- **✏️ Custom Prompts** — Write your own personality/instructions for the AI
- **⏱️ Adjustable Delay** — Control how fast the bot responds
- **🎛️ Easy Settings** — Clean popup UI to configure everything

### Installation

1. Get an **API key** from any OpenAI-compatible provider (e.g. [OpenAI](https://platform.openai.com/api-keys), [OpenRouter](https://openrouter.ai/keys), [Fireworks AI](https://fireworks.ai/api-keys))
2. Open Firefox and go to `about:debugging`
3. Click **"This Firefox"** → **"Load Temporary Add-on"**
4. Select the `manifest.json` file from this folder
5. Click the extension icon in the toolbar, paste your API key, set the **API Base URL** and **Model** (or leave the defaults for OpenAI), and hit **Save**

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **API Key** | Your OpenAI-compatible API key | — |
| **API Base URL** | Provider endpoint (OpenAI format) | `https://api.openai.com/v1` |
| **Model** | Free-text model name | `gpt-4o-mini` |
| **Language** | `EN` / `TR` / `Custom` | `EN` |
| **Custom Prompt** | Your own system prompt (when Language = Custom) | — |
| **Reply Delay** | Milliseconds before sending a reply | `1200` |
| **Auto Reply** | Enable / disable the bot | `Enabled` |

---

## 🇹🇷 Türkçe

### Genel Bakış

TikTok AI Auto Reply, gelen TikTok DM'lerini dinleyen ve herhangi bir **OpenAI-uyumlu API** (OpenAI, OpenRouter, Fireworks veya yerel bir model) üzerinden akıllı, bağlamsal cevaplar üreten bir tarayıcı eklentisidir.

### Özellikler

- **🔥 AI Otomatik Cevap** — Gelen DM'lere otomatik cevap verir
- **💬 Konuşma Hafızası** — Önceki mesajları hatırlayarak bağlamsal yanıtlar üretir
- **🌐 Çok Dilli** — **İngilizce** ve **Türkçe** desteği + özelleştirilebilir promptlar
- **✏️ Özel Prompt** — AI'in kişiliğini/kurallarını kendin yazabilirsin
- **⏱️ Ayarlanabilir Gecikme** — Botun ne kadar hızlı cevap vereceğini kontrol et
- **🎛️ Kolay Ayarlar** — Tüm ayarlar şık popup arayüzünden yönetilir

### Kurulum

1. Herhangi bir OpenAI-uyumlu sağlayıcıdan **API Key** al (ör. [OpenAI](https://platform.openai.com/api-keys), [OpenRouter](https://openrouter.ai/keys), [Fireworks AI](https://fireworks.ai/api-keys))
2. Firefox'ta `about:debugging` adresine git
3. **"Bu Firefox"** → **"Geçici Eklenti Yükle"** butonuna tıkla
4. Bu klasördeki `manifest.json` dosyasını seç
5. Araç çubuğundaki eklenti ikonuna tıkla, API Key'i yapıştır, **API Base URL** ve **Model**'i gir (OpenAI için varsayılanları bırakabilirsin) ve **Kaydet**

### Ayarlar

| Ayar | Açıklama | Varsayılan |
|------|----------|------------|
| **API Key** | OpenAI-uyumlu API anahtarın | — |
| **API Base URL** | Sağlayıcı adresi (OpenAI formatı) | `https://api.openai.com/v1` |
| **Model** | Serbest metin model adı | `gpt-4o-mini` |
| **Dil** | `EN` / `TR` / `Özel` | `EN` |
| **Özel Prompt** | Kendi sistem promptun (Dil = Özel ise) | — |
| **Cevap Gecikmesi** | Cevap öncesi bekleme süresi (ms) | `1200` |
| **Otomatik Cevap** | Botu aç/kapat | `Açık` |

---

## 🚀 Usage / Kullanım

1. Log in to TikTok and open a **DM conversation**
2. The extension injects a small floating status indicator on the page
3. When someone messages you, the AI generates and sends a reply automatically
4. Toggle the bot ON/OFF anytime from the extension popup

---

## 📁 Project Structure / Dosya Yapısı

```
tiktok-ai-auto-reply/
├── manifest.json       # Extension manifest
├── background.js       # Background service worker (API calls)
├── content.js          # Content script (TikTok DM listener)
├── styles.css          # Injected page styles
├── popup.html          # Settings popup UI
├── popup.js            # Popup logic
├── popup.css           # Popup styles
├── icons/
│   ├── icon48.svg
│   └── icon96.svg
└── README.md
```

---

## 🛡️ Security / Güvenlik

- **API keys are stored locally** in browser storage — never sent anywhere except the API base URL you configured
- **No TikTok credentials are collected**
- **No third-party analytics or tracking**

---

## ⚠️ Disclaimer

> This project is built for **educational and research purposes**. Automating interactions on TikTok may violate their Terms of Service. Use at your own risk and responsibility.
>
> Bu proje **eğitim ve araştırma amaçlı** geliştirilmiştir. TikTok'ta otomatik etkileşimler, platformun kullanım koşullarını ihlal edebilir. Kendi sorumluluğunuzda kullanın.

---

## 📄 License / Lisans

[MIT License](LICENSE)

---

<p align="center">Made with ☕ + 🤖</p>

---

## 📬 İletişim

- TikTok: [@ogquzz](https://www.tiktok.com/@ogquzz)
