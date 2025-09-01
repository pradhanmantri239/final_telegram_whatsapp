const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const https = require('https');

class SingleClientForwarder {
  constructor(clientId, config) {
    this.clientId = clientId;
    this.config = config;
    this.whatsappClient = null;
    this.telegramBot = null;
    this.isWhatsAppReady = false;
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.messageVariations = ["", " ", ".", "...", " .", "  ", "   ", "·", "•", "‎", "⠀", " ⠀", "⠀ "];
    this.isActive = true;
    this.totalMessages = 0;
    this.failedMessages = 0;
    this.availableGroups = [];
    this.downloadCache = new Map(); // Cache for downloaded files
    this.sessionBackupInterval = null;
  }

  async initializeWhatsApp() {
    // Check if WhatsApp should be skipped for this client
    if (this.config.skipWhatsApp === true) {
      console.log(`⏭️ [${this.clientId}] WhatsApp connection skipped by configuration`);
      this.isWhatsAppReady = false;
      return;
    }

    console.log(`🚀 [${this.clientId}] Initializing WhatsApp client...`);

    // Enhanced session directory management
    const sessionsDir = process.env.RENDER ? 
      `/opt/render/project/sessions/${this.clientId}` : 
      `./sessions/${this.clientId}`;

    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      console.log(`📁 [${this.clientId}] Sessions directory: ${sessionsDir}`);
    } catch (error) {
      console.log(`📁 [${this.clientId}] Sessions directory setup complete`);
    }

    // User agent rotation for better detection avoidance
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ];

    this.whatsappClient = new Client({
      authStrategy: new LocalAuth({
        clientId: `${this.clientId}`,
        dataPath: sessionsDir,
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox", 
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows", 
          "--disable-renderer-backgrounding",
          "--disable-extensions",
          "--disable-blink-features=AutomationControlled",
          "--user-agent=" + userAgents[Math.floor(Math.random() * userAgents.length)]
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      }
    });

    this.whatsappClient.on("qr", (qr) => {
      console.log(`\n📱 [${this.clientId}] FIRST-TIME SETUP or SESSION EXPIRED`);
      console.log(`\n🔑 [${this.clientId}] Scan this QR code with WhatsApp:`);
      qrcode.generate(qr, { small: true });
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
      console.log(`\n🔗 [${this.clientId}] QR URL: ${qrUrl}`);
      console.log(`\n⚠️ [${this.clientId}] After scanning, session will be saved for future use!`);
    });

    this.whatsappClient.on("authenticated", async (session) => {
      console.log(`✅ [${this.clientId}] WhatsApp authenticated - session saved!`);
      console.log(`🔐 [${this.clientId}] Future starts will use saved session (no QR needed)`);
      await this.backupSession();
    });

    this.whatsappClient.on("ready", async () => {
      console.log(`🚀 [${this.clientId}] WhatsApp ready! Using ${this.reconnectAttempts === 0 ? 'saved session' : 'fresh connection'}`);
      this.isWhatsAppReady = true;
      this.reconnectAttempts = 0;

      // Start session backup interval
      this.sessionBackupInterval = setInterval(async () => {
        await this.backupSession();
      }, 600000); // Backup every 10 minutes

      setTimeout(async () => {
        try {
          await this.displayAvailableChats();
          this.processMessageQueue();
        } catch (error) {
          console.error(`❌ [${this.clientId}] Error displaying chats:`, error.message);
          setTimeout(async () => {
            try {
              await this.displayAvailableChats();
            } catch (retryError) {
              console.error(`❌ [${this.clientId}] Retry failed:`, retryError.message);
            }
          }, 5000);
        }
      }, 3000);
    });

    this.whatsappClient.on('loading_screen', (percent, message) => {
      console.log(`⏳ [${this.clientId}] Loading: ${percent}% - ${message}`);
    });

    this.whatsappClient.on('change_state', state => {
      console.log(`🔄 [${this.clientId}] Connection state: ${state}`);
    });

    this.whatsappClient.on("auth_failure", (msg) => {
      console.error(`❌ [${this.clientId}] Authentication failed - session may be corrupted:`, msg);
      console.log(`🔄 [${this.clientId}] Will show QR code for fresh login...`);
      this.handleWhatsAppReconnect();
    });

    this.whatsappClient.on("disconnected", (reason) => {
      console.log(`⚠️ [${this.clientId}] WhatsApp disconnected: ${reason}`);
      if (reason === 'LOGOUT') {
        console.log(`🚪 [${this.clientId}] Logged out - will need QR code on next start`);
      } else {
        console.log(`🔄 [${this.clientId}] Attempting to reconnect with saved session...`);
      }
      this.isWhatsAppReady = false;
      this.availableGroups = [];
      
      // Clear session backup interval
      if (this.sessionBackupInterval) {
        clearInterval(this.sessionBackupInterval);
      }
      
      this.handleWhatsAppReconnect();
    });

    await this.whatsappClient.initialize();
  }

  async backupSession() {
    try {
      const sessionsDir = process.env.RENDER ? 
        `/opt/render/project/sessions/${this.clientId}` : 
        `./sessions/${this.clientId}`;
      
      const backupDir = `${sessionsDir}_backup`;
      await fs.mkdir(backupDir, { recursive: true });
      
      const files = await fs.readdir(sessionsDir);
      for (const file of files) {
        try {
          await fs.copyFile(
            path.join(sessionsDir, file), 
            path.join(backupDir, file)
          );
        } catch (copyError) {
          // Ignore individual file errors
        }
      }
      console.log(`💾 [${this.clientId}] Session backed up successfully`);
    } catch (error) {
      console.log(`⚠️ [${this.clientId}] Session backup failed:`, error.message);
    }
  }

  async checkConnectionHealth() {
    try {
      const state = await this.whatsappClient.getState();
      if (state !== 'CONNECTED') {
        console.log(`⚠️ [${this.clientId}] Connection state: ${state}`);
        return false;
      }
      return true;
    } catch (error) {
      console.log(`❌ [${this.clientId}] Health check failed:`, error.message);
      return false;
    }
  }

  async displayAvailableChats() {
    try {
      console.log(`📋 [${this.clientId}] Fetching WhatsApp chats...`);
      const chats = await this.whatsappClient.getChats();
      console.log(`📊 [${this.clientId}] Total chats found: ${chats.length}`);

      const groups = chats.filter((chat) => chat.isGroup);
      console.log(`📊 [${this.clientId}] Groups found: ${groups.length}`);

      this.availableGroups = groups.map(group => ({
        name: group.name,
        id: group.id._serialized,
        participants: group.participants ? group.participants.length : 0
      }));

      console.log(`\n📋 [${this.clientId}] Available WhatsApp Groups:`);
      console.log("=====================================");

      if (groups.length === 0) {
        console.log(`❌ [${this.clientId}] No groups found. Make sure you're added to WhatsApp groups.`);
        return;
      }

      groups.forEach((group, index) => {
        const participantCount = group.participants ? group.participants.length : 0;
        console.log(`${index + 1}. ${group.name}`);
        console.log(` 📍 ID: ${group.id._serialized}`);
        console.log(` 👥 Participants: ${participantCount}`);
        console.log(` 📅 Created: ${group.createdAt ? new Date(group.createdAt.low * 1000).toLocaleDateString() : 'Unknown'}`);
        console.log('');
      });

      console.log("=====================================\n");

      const individualChats = chats.filter(chat => !chat.isGroup);
      console.log(`📊 [${this.clientId}] Individual chats: ${individualChats.length}`);
      console.log(`📊 [${this.clientId}] Total chats: ${chats.length}\n`);

    } catch (error) {
      console.error(`❌ [${this.clientId}] Error getting chats:`, error.message);
      console.error(`❌ [${this.clientId}] Error details:`, error);

      try {
        console.log(`🔄 [${this.clientId}] Trying alternative method to get chats...`);
        const state = await this.whatsappClient.getState();
        console.log(`📊 [${this.clientId}] WhatsApp state: ${state}`);
      } catch (stateError) {
        console.error(`❌ [${this.clientId}] Could not get WhatsApp state:`, stateError.message);
      }
    }
  }

  async handleWhatsAppReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`❌ [${this.clientId}] Max reconnection attempts reached.`);
      return;
    }

    this.reconnectAttempts++;
    console.log(`🔄 [${this.clientId}] Attempting to reconnect WhatsApp (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        if (this.whatsappClient) {
          await this.whatsappClient.destroy();
        }
        await this.initializeWhatsApp();
      } catch (error) {
        console.error(`❌ [${this.clientId}] Reconnection failed:`, error.message);
        this.handleWhatsAppReconnect();
      }
    }, 15000); // Increased reconnect delay
  }

  initializeTelegram() {
    console.log(`🚀 [${this.clientId}] Initializing Telegram bot...`);
    if (this.config.skipTelegram === true || !this.config.telegramBotToken || this.config.telegramBotToken === "DISABLED") {
    console.log(`⏭️ [${this.clientId}] Telegram connection skipped by configuration`);
    return;
    }
    this.telegramBot = new TelegramBot(this.config.telegramBotToken, {
      polling: true,
    });

    this.telegramBot.on("message", async (msg) => {
      if (!this.isActive) {
        console.log(`⏸️ [${this.clientId}] Forwarding paused, message skipped`);
        return;
      }

      try {
        const chatId = msg.chat.id;

        // Check if this is from a monitored group
        if (!this.config.telegramGroups.includes(chatId)) {
          return;
        }

        // Add message to queue
        this.messageQueue.push(msg);
        console.log(`📨 [${this.clientId}] New message queued: ${msg.text ? 'text' : (msg.photo ? 'photo' : 'other')}`);

        // Process queue if not already processing
        if (!this.isProcessingQueue) {
          this.processMessageQueue();
        }

      } catch (error) {
        console.error(`❌ [${this.clientId}] Error handling Telegram message:`, error.message);
      }
    });

    this.telegramBot.on('polling_error', (error) => {
      console.log(`⚠️ [${this.clientId}] Telegram polling error:`, error.message);
    });

    console.log(`✅ [${this.clientId}] Telegram bot initialized`);
  }

  // FIXED: Download file once and reuse for all groups
  async downloadFileOnce(fileId) {
    try {
      // Check cache first
      if (this.downloadCache.has(fileId)) {
        console.log(`💾 [${this.clientId}] Using cached file: ${fileId}`);
        return this.downloadCache.get(fileId);
      }

      console.log(`📥 [${this.clientId}] Downloading file: ${fileId}`);
      
      const fileInfo = await this.telegramBot.getFile(fileId);
      console.log(`📋 [${this.clientId}] File info:`, { path: fileInfo.file_path, size: fileInfo.file_size });

      const downloadUrl = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${fileInfo.file_path}`;
      console.log(`🔗 [${this.clientId}] Download URL: ${downloadUrl}`);

      // Create unique filename to avoid conflicts
      const timestamp = Date.now();
      const extension = path.extname(fileInfo.file_path) || '.jpg';
      const fileName = `file_${timestamp}_${this.clientId}${extension}`;
      const localPath = path.join('./photos', fileName);

      // Ensure photos directory exists
      await fs.mkdir('./photos', { recursive: true });

      // Download file
      await new Promise((resolve, reject) => {
        const file = require('fs').createWriteStream(localPath);
        https.get(downloadUrl, (response) => {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
          file.on('error', reject);
        }).on('error', reject);
      });

      const stats = await fs.stat(localPath);
      console.log(`✅ [${this.clientId}] File downloaded successfully: ${stats.size} bytes`);

      // Cache the file path
      this.downloadCache.set(fileId, localPath);

      // Schedule cleanup after 10 minutes
      setTimeout(async () => {
        await this.cleanupFile(fileId, localPath);
      }, 600000);

      return localPath;
    } catch (error) {
      console.error(`❌ [${this.clientId}] Error downloading file:`, error.message);
      throw error;
    }
  }

  async cleanupFile(fileId, filePath) {
    try {
      await fs.unlink(filePath);
      this.downloadCache.delete(fileId);
      console.log(`🧹 [${this.clientId}] Cleaned up file: ${filePath}`);
    } catch (error) {
      console.log(`⚠️ [${this.clientId}] Cleanup error:`, error.message);
    }
  }

  async validateSession() {
    try {
      if (!this.isWhatsAppReady) return false;
      
      const info = await this.whatsappClient.info;
      if (!info) return false;
      
      return true;
    } catch (error) {
      console.log(`❌ [${this.clientId}] Session validation failed:`, error.message);
      return false;
    }
  }

  async processMessageQueue() {
    if (this.isProcessingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      
      try {
        // Validate session before processing
        if (!await this.validateSession()) {
          console.log(`⚠️ [${this.clientId}] Session invalid, requeueing message`);
          this.messageQueue.unshift(message);
          break;
        }

        if (message.photo && message.photo.length > 0) {
          await this.handlePhotoMessage(message);
        } else if (message.text) {
          await this.handleTextMessage(message);
        } else if (message.video) {
          await this.handleVideoMessage(message);
        } else if (message.document) {
          await this.handleDocumentMessage(message);
        }

        // Enhanced cooldown between messages
        const messageDelay = Math.floor(Math.random() * 10000) + 15000; // 15-25 seconds
        console.log(`⏳ [${this.clientId}] Waiting ${messageDelay}ms before next message...`);
        await this.sleep(messageDelay);

      } catch (error) {
        console.error(`❌ [${this.clientId}] Error processing message:`, error.message);
        this.failedMessages++;
      }
    }

    this.isProcessingQueue = false;
  }

  async handlePhotoMessage(message) {
    console.log(`📎 [${this.clientId}] Processing photo file...`);

    if (!this.isWhatsAppReady || this.config.whatsappGroups.length === 0) {
      console.log(`⚠️ [${this.clientId}] WhatsApp not ready or no groups configured`);
      return;
    }

    try {
      // Get the largest photo
      const photo = message.photo[message.photo.length - 1];
      
      // FIXED: Download once, use for all groups
      const localPath = await this.downloadFileOnce(photo.file_id);

      // Send to all groups using the same downloaded file
      for (let i = 0; i < this.config.whatsappGroups.length; i++) {
        const groupId = this.config.whatsappGroups[i];
        
        try {
          // Check connection health before sending
          if (!await this.checkConnectionHealth()) {
            console.log(`⚠️ [${this.clientId}] Connection unhealthy, skipping group ${i + 1}`);
            continue;
          }

          const media = MessageMedia.fromFilePath(localPath);
          const variation = this.messageVariations[Math.floor(Math.random() * this.messageVariations.length)];
          
          await this.whatsappClient.sendMessage(groupId, media, { caption: variation });
          console.log(`✅ [${this.clientId}] photo message sent to WhatsApp group ${i + 1} (no preview)`);

          this.totalMessages++;

          // CRITICAL: Much longer delays between groups to avoid detection
          if (i < this.config.whatsappGroups.length - 1) {
            const groupDelay = Math.floor(Math.random() * 45000) + 45000; // 45-90 seconds between groups
            console.log(`⏳ [${this.clientId}] Waiting ${groupDelay}ms before next group...`);
            await this.sleep(groupDelay);
          }

        } catch (error) {
          console.error(`❌ [${this.clientId}] Error sending to group ${i + 1}:`, error.message);
          this.failedMessages++;
          
          // If multiple groups fail, stop to prevent session invalidation
          if (this.failedMessages > 2) {
            console.log(`🛑 [${this.clientId}] Too many failures, stopping batch`);
            break;
          }
        }
      }

      // Cleanup happens automatically via timeout in downloadFileOnce

    } catch (error) {
      console.error(`❌ [${this.clientId}] Error in photo handling:`, error.message);
    }
  }

  async handleTextMessage(message) {
    console.log(`📝 [${this.clientId}] Processing text message...`);

    if (!this.isWhatsAppReady || this.config.whatsappGroups.length === 0) {
      console.log(`⚠️ [${this.clientId}] WhatsApp not ready or no groups configured`);
      return;
    }

    try {
      const text = message.text;

      for (let i = 0; i < this.config.whatsappGroups.length; i++) {
        const groupId = this.config.whatsappGroups[i];
        
        try {
          // Check connection health
          if (!await this.checkConnectionHealth()) {
            console.log(`⚠️ [${this.clientId}] Connection unhealthy, skipping group ${i + 1}`);
            continue;
          }

          const variation = this.messageVariations[Math.floor(Math.random() * this.messageVariations.length)];
          const messageToSend = text + variation;

          await this.whatsappClient.sendMessage(groupId, messageToSend);
          console.log(`✅ [${this.clientId}] text message sent to WhatsApp group ${i + 1}`);

          this.totalMessages++;

          // Enhanced delays between groups
          if (i < this.config.whatsappGroups.length - 1) {
            const groupDelay = Math.floor(Math.random() * 30000) + 30000; // 30-60 seconds
            console.log(`⏳ [${this.clientId}] Waiting ${groupDelay}ms before next group...`);
            await this.sleep(groupDelay);
          }

        } catch (error) {
          console.error(`❌ [${this.clientId}] Error sending text to group ${i + 1}:`, error.message);
          this.failedMessages++;
        }
      }

    } catch (error) {
      console.error(`❌ [${this.clientId}] Error in text handling:`, error.message);
    }
  }

  async handleVideoMessage(message) {
    console.log(`🎥 [${this.clientId}] Processing video file...`);

    if (!this.isWhatsAppReady || this.config.whatsappGroups.length === 0) {
      console.log(`⚠️ [${this.clientId}] WhatsApp not ready or no groups configured`);
      return;
    }

    try {
      // FIXED: Download once, use for all groups
      const localPath = await this.downloadFileOnce(message.video.file_id);

      for (let i = 0; i < this.config.whatsappGroups.length; i++) {
        const groupId = this.config.whatsappGroups[i];
        
        try {
          if (!await this.checkConnectionHealth()) {
            console.log(`⚠️ [${this.clientId}] Connection unhealthy, skipping group ${i + 1}`);
            continue;
          }

          const media = MessageMedia.fromFilePath(localPath);
          const variation = this.messageVariations[Math.floor(Math.random() * this.messageVariations.length)];

          await this.whatsappClient.sendMessage(groupId, media, { caption: variation });
          console.log(`✅ [${this.clientId}] video message sent to WhatsApp group ${i + 1}`);

          this.totalMessages++;

          if (i < this.config.whatsappGroups.length - 1) {
            const groupDelay = Math.floor(Math.random() * 45000) + 45000; // 45-90 seconds for video
            console.log(`⏳ [${this.clientId}] Waiting ${groupDelay}ms before next group...`);
            await this.sleep(groupDelay);
          }

        } catch (error) {
          console.error(`❌ [${this.clientId}] Error sending video to group ${i + 1}:`, error.message);
          this.failedMessages++;
        }
      }

    } catch (error) {
      console.error(`❌ [${this.clientId}] Error in video handling:`, error.message);
    }
  }

  async handleDocumentMessage(message) {
    console.log(`📄 [${this.clientId}] Processing document file...`);

    if (!this.isWhatsAppReady || this.config.whatsappGroups.length === 0) {
      console.log(`⚠️ [${this.clientId}] WhatsApp not ready or no groups configured`);
      return;
    }

    try {
      // FIXED: Download once, use for all groups
      const localPath = await this.downloadFileOnce(message.document.file_id);

      for (let i = 0; i < this.config.whatsappGroups.length; i++) {
        const groupId = this.config.whatsappGroups[i];
        
        try {
          if (!await this.checkConnectionHealth()) {
            console.log(`⚠️ [${this.clientId}] Connection unhealthy, skipping group ${i + 1}`);
            continue;
          }

          const media = MessageMedia.fromFilePath(localPath);
          const variation = this.messageVariations[Math.floor(Math.random() * this.messageVariations.length)];

          await this.whatsappClient.sendMessage(groupId, media, { caption: variation });
          console.log(`✅ [${this.clientId}] document message sent to WhatsApp group ${i + 1}`);

          this.totalMessages++;

          if (i < this.config.whatsappGroups.length - 1) {
            const groupDelay = Math.floor(Math.random() * 30000) + 30000; // 30-60 seconds
            console.log(`⏳ [${this.clientId}] Waiting ${groupDelay}ms before next group...`);
            await this.sleep(groupDelay);
          }

        } catch (error) {
          console.error(`❌ [${this.clientId}] Error sending document to group ${i + 1}:`, error.message);
          this.failedMessages++;
        }
      }

    } catch (error) {
      console.error(`❌ [${this.clientId}] Error in document handling:`, error.message);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async start() {
    console.log(`🚀 [${this.clientId}] Starting forwarder...`);
    
    try {
      await this.initializeWhatsApp();
      this.initializeTelegram();
    } catch (error) {
      console.error(`❌ [${this.clientId}] Failed to start:`, error.message);
      throw error;
    }
  }

  pause() {
    console.log(`⏸️ [${this.clientId}] Pausing message forwarding...`);
    this.isActive = false;
  }

  resume() {
    console.log(`▶️ [${this.clientId}] Resuming message forwarding...`);
    this.isActive = true;
    if (!this.isProcessingQueue && this.messageQueue.length > 0) {
      this.processMessageQueue();
    }
  }

  async stop() {
    console.log(`🛑 [${this.clientId}] Stopping forwarder...`);
    this.isActive = false;

    // Clear session backup interval
    if (this.sessionBackupInterval) {
      clearInterval(this.sessionBackupInterval);
    }

    // Clean up cached files
    for (const [fileId, filePath] of this.downloadCache.entries()) {
      await this.cleanupFile(fileId, filePath);
    }

    if (this.telegramBot) {
      await this.telegramBot.stopPolling();
    }

    if (this.whatsappClient) {
      await this.whatsappClient.destroy();
    }
  }

  getStatus() {
    return {
      clientId: this.clientId,
      isActive: this.isActive,
      isWhatsAppReady: this.isWhatsAppReady,
      totalMessages: this.totalMessages,
      failedMessages: this.failedMessages,
      queueSize: this.messageQueue.length,
      availableGroups: this.availableGroups.length,
      cacheSize: this.downloadCache.size
    };
  }
}

class MultiClientManager {
  constructor() {
    this.clients = new Map();
    this.configs = [];
    this.app = express();
  }

  async loadConfigs() {
    try {
      const configFiles = await fs.readdir('./configs');
      
      for (const file of configFiles) {
        if (file.endsWith('.json')) {
          try {
            const configPath = path.join('./configs', file);
            const configData = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);
            
            // Validate config
            if (!config.telegramBotToken || !config.telegramGroups || !config.whatsappGroups) {
              console.log(`⚠️ Invalid config in ${file}, skipping...`);
              continue;
            }
            
            const clientId = path.basename(file, '.json');
            config.clientId = clientId;
            this.configs.push(config);
            
            console.log(`✅ Loaded config for client: ${clientId}`);
          } catch (error) {
            console.error(`❌ Error loading config ${file}:`, error.message);
          }
        }
      }
      
      console.log(`📊 Total valid configs loaded: ${this.configs.length}`);
      
    } catch (error) {
      console.error(`❌ Error reading configs directory:`, error.message);
      console.log(`📝 Make sure you have JSON config files in ./configs/ directory`);
    }
  }

  setupAPI() {
    this.app.use(express.json());

    this.app.get('/', (req, res) => {
      res.json({
        status: 'Multi-Client Telegram-WhatsApp Forwarder',
        version: '1.0.0',
        clients: this.configs.length,
        uptime: process.uptime()
      });
    });

    this.app.get('/status', (req, res) => {
      const statuses = Array.from(this.clients.values()).map(client => client.getStatus());
      res.json({
        clients: statuses,
        totalClients: this.clients.size,
        activeClients: statuses.filter(s => s.isActive).length,
        readyClients: statuses.filter(s => s.isWhatsAppReady).length
      });
    });

    this.app.post('/client/:clientId/pause', (req, res) => {
      const client = this.clients.get(req.params.clientId);
      if (client) {
        client.pause();
        res.json({ message: `Client ${req.params.clientId} paused` });
      } else {
        res.status(404).json({ error: 'Client not found' });
      }
    });

    this.app.post('/client/:clientId/resume', (req, res) => {
      const client = this.clients.get(req.params.clientId);
      if (client) {
        client.resume();
        res.json({ message: `Client ${req.params.clientId} resumed` });
      } else {
        res.status(404).json({ error: 'Client not found' });
      }
    });

    const port = process.env.PORT || 10000;
    this.app.listen(port, '0.0.0.0', () => {
      console.log(`🌐 API server running on port ${port}`);
    });
  }

  async start() {
    console.log('🚀 Starting Multi-Client Manager...');
    
    await this.loadConfigs();
    
    if (this.configs.length === 0) {
      console.log('❌ No valid configurations found. Please check your configs directory.');
      return;
    }

    this.setupAPI();

    // Start all clients
    for (const config of this.configs) {
      try {
        const client = new SingleClientForwarder(config.clientId, config);
        this.clients.set(config.clientId, client);
        
        console.log(`🚀 Starting client: ${config.clientId}`);
        await client.start();
        
        // Delay between starting clients to avoid conflicts
        await this.sleep(5000);
        
      } catch (error) {
        console.error(`❌ Failed to start client ${config.clientId}:`, error.message);
      }
    }

    console.log(`✅ Multi-client manager started with ${this.clients.size} clients`);
  }

  async stop() {
    console.log('\n🛑 Shutting down gracefully...');
    
    const stopPromises = Array.from(this.clients.values()).map(client => 
      client.stop().catch(error => 
        console.error(`Error stopping ${client.clientId}:`, error.message)
      )
    );
    
    await Promise.allSettled(stopPromises);
    console.log('✅ All clients stopped');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Enhanced graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n📥 Received SIGINT (Ctrl+C)');
  if (global.manager) {
    await global.manager.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n📥 Received SIGTERM');
  if (global.manager) {
    await global.manager.stop();
  }
  process.exit(0);
});

// Improved error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Main execution
async function main() {
  try {
    global.manager = new MultiClientManager();
    await global.manager.start();
  } catch (error) {
    console.error('❌ Fatal error in main:', error.message);
    process.exit(1);
  }
}

// Start the application
main().catch(error => {
  console.error('❌ Application failed to start:', error);
  process.exit(1);
});
