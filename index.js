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
    this.messageVariations = ["", " ", ".", "...", " ."];
    this.isActive = true;
    this.totalMessages = 0;
    this.failedMessages = 0;
    this.availableGroups = [];
  }

  async initializeWhatsApp() {
    // Check if WhatsApp should be skipped for this client
    if (this.config.skipWhatsApp === true) {
      console.log(`⏭️ [${this.clientId}] WhatsApp connection skipped by configuration`);
      this.isWhatsAppReady = false;
      return;
    }

    console.log(`🚀 [${this.clientId}] Initializing WhatsApp client...`);
    
    // FIXED: Use persistent path for Render.com
    const sessionsDir = process.env.RENDER ? 
      `/opt/render/project/sessions/${this.clientId}` : 
      `./sessions/${this.clientId}`;
      
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      console.log(`📁 [${this.clientId}] Sessions directory: ${sessionsDir}`);
    } catch (error) {
      console.log(`📁 [${this.clientId}] Sessions directory setup complete`);
    }
    
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
          "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
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

    this.whatsappClient.on("authenticated", (session) => {
      console.log(`✅ [${this.clientId}] WhatsApp authenticated - session saved!`);
      console.log(`🔐 [${this.clientId}] Future starts will use saved session (no QR needed)`);
    });

    this.whatsappClient.on("ready", async () => {
      console.log(`🚀 [${this.clientId}] WhatsApp ready! Using ${this.reconnectAttempts === 0 ? 'saved session' : 'fresh connection'}`);
      this.isWhatsAppReady = true;
      this.reconnectAttempts = 0;
      
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
      this.handleWhatsAppReconnect();
    });

    await this.whatsappClient.initialize();
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
        console.log(`   📍 ID: ${group.id._serialized}`);
        console.log(`   👥 Participants: ${participantCount}`);
        console.log(`   📅 Created: ${group.createdAt ? new Date(group.createdAt.low * 1000).toLocaleDateString() : 'Unknown'}`);
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
    }, 10000);
  }

  initializeTelegram() {
    console.log(`🚀 [${this.clientId}] Initializing Telegram bot...`);
    
    this.telegramBot = new TelegramBot(this.config.telegramBotToken, {
      polling: true,
    });

    this.telegramBot.on("message", async (msg) => {
      if (!this.isActive) {
        console.log(`⏸️ [${this.clientId}] Forwarding paused, message skipped`);
        return;
      }

      try {
        const chatId = msg.chat.id.toString();
        if (!this.config.telegramGroups || !this.config.telegramGroups.includes(chatId)) {
          return;
        }
        await this.handleTelegramMessage(msg);
      } catch (error) {
        console.error(`❌ [${this.clientId}] Error processing Telegram message:`, error.message);
      }
    });

    this.telegramBot.on("polling_error", (error) => {
      console.error(`❌ [${this.clientId}] Telegram polling error:`, error.message);
    });

    console.log(`✅ [${this.clientId}] Telegram bot initialized and listening`);
  }

  async handleTelegramMessage(msg) {
    const messageInfo = {
      text: msg.text || msg.caption || "",
      from: msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ""),
      chat: msg.chat.title || "Private Chat",
      timestamp: new Date(msg.date * 1000).toLocaleString(),
      type: "text",
    };

    if (msg.photo) {
      messageInfo.type = "photo";
      messageInfo.fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document) {
      messageInfo.type = "document";
      messageInfo.fileId = msg.document.file_id;
      messageInfo.fileName = msg.document.file_name;
    } else if (msg.video) {
      messageInfo.type = "video";
      messageInfo.fileId = msg.video.file_id;
    } else if (msg.audio || msg.voice) {
      messageInfo.type = "audio";
      messageInfo.fileId = (msg.audio || msg.voice).file_id;
    }

    this.messageQueue.push(messageInfo);
    console.log(`📨 [${this.clientId}] New message queued: ${messageInfo.type}`);

    if (!this.isProcessingQueue) {
      this.processMessageQueue();
    }
  }

  // FIXED: Updated delays - 8-13 seconds between messages
  async processMessageQueue() {
    if (this.isProcessingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      if (!this.isActive) {
        console.log(`⏸️ [${this.clientId}] Forwarding paused`);
        await this.sleep(5000);
        continue;
      }

      // Skip forwarding if WhatsApp is disabled for this client
      if (this.config.skipWhatsApp === true) {
        console.log(`⏭️ [${this.clientId}] WhatsApp skipped - clearing message queue`);
        this.messageQueue = [];
        break;
      }

      if (!this.isWhatsAppReady) {
        console.log(`⏳ [${this.clientId}] WhatsApp not ready, waiting...`);
        await this.sleep(5000);
        continue;
      }

      const messageInfo = this.messageQueue.shift();
      await this.forwardToWhatsApp(messageInfo);

      // FIXED: 8-13 seconds delay between messages
      const messageDelay = Math.floor(Math.random() * 5000) + 8000; // 8000-13000ms
      console.log(`⏳ [${this.clientId}] Waiting ${messageDelay}ms before next message...`);
      await this.sleep(messageDelay);
    }

    this.isProcessingQueue = false;
  }

  // FIXED: Updated group delays and fixed file download
  async forwardToWhatsApp(messageInfo) {
    // Skip forwarding if WhatsApp is disabled for this client
    if (this.config.skipWhatsApp === true) {
      console.log(`⏭️ [${this.clientId}] WhatsApp forwarding skipped (client configured as Telegram-only)`);
      return;
    }

    if (!this.config.whatsappGroups || this.config.whatsappGroups.length === 0) {
      console.log(`⚠️ [${this.clientId}] No WhatsApp groups configured, skipping message`);
      return;
    }

    if (!this.isWhatsAppReady) {
      console.log(`⏳ [${this.clientId}] WhatsApp not ready, message will stay in queue`);
      return;
    }

    let messageText = messageInfo.text;
    if (messageText) {
      const randomVariation = this.messageVariations[Math.floor(Math.random() * this.messageVariations.length)];
      messageText = messageInfo.text + randomVariation;
    }

    for (let i = 0; i < this.config.whatsappGroups.length; i++) {
      const groupId = this.config.whatsappGroups[i];
      
      try {
        if (messageInfo.type === "text" && messageText) {
          await this.whatsappClient.sendMessage(groupId, messageText, { linkPreview: false });
          console.log(`✅ [${this.clientId}] Text message sent to WhatsApp group ${i + 1} (no preview)`);
        } else if (messageInfo.fileId) {
          console.log(`📎 [${this.clientId}] Processing ${messageInfo.type} file...`);
          const mediaData = await this.downloadTelegramFile(messageInfo.fileId);
          if (mediaData) {
            const media = new MessageMedia(
              mediaData.mimeType, 
              mediaData.buffer.toString('base64'), 
              mediaData.fileName
            );
            await this.whatsappClient.sendMessage(groupId, media, { 
              caption: messageText || "",
              linkPreview: false
            });
            console.log(`✅ [${this.clientId}] ${messageInfo.type} message sent to WhatsApp group ${i + 1} (no preview)`);
          } else {
            console.log(`❌ [${this.clientId}] Failed to download ${messageInfo.type} file`);
            this.failedMessages++;
            continue;
          }
        }

        this.totalMessages++;
      } catch (error) {
        console.error(`❌ [${this.clientId}] Failed to send message to group ${i + 1}:`, error.message);
        this.failedMessages++;
      }

      // FIXED: 3-5 seconds delay between groups
      if (i < this.config.whatsappGroups.length - 1) {
        const groupDelay = Math.floor(Math.random() * 2000) + 3000; // 3000-5000ms
        console.log(`⏳ [${this.clientId}] Waiting ${groupDelay}ms before next group...`);
        await this.sleep(groupDelay);
      }
    }
  }

  // FIXED: Complete file download implementation
  async downloadTelegramFile(fileId) {
    try {
      console.log(`📥 [${this.clientId}] Downloading file: ${fileId}`);
      
      // Get file info from Telegram
      const fileInfo = await this.telegramBot.getFile(fileId);
      console.log(`📋 [${this.clientId}] File info:`, {
        path: fileInfo.file_path,
        size: fileInfo.file_size
      });

      if (!fileInfo.file_path) {
        throw new Error('File path not available from Telegram API');
      }

      // Construct the download URL
      const fileUrl = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${fileInfo.file_path}`;
      console.log(`🔗 [${this.clientId}] Download URL: ${fileUrl}`);

      // Download file as buffer using https module
      const buffer = await new Promise((resolve, reject) => {
        const chunks = [];
        https.get(fileUrl, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download file: ${response.statusCode}`));
            return;
          }

          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const fileBuffer = Buffer.concat(chunks);
            console.log(`✅ [${this.clientId}] File downloaded successfully: ${fileBuffer.length} bytes`);
            resolve(fileBuffer);
          });
          response.on('error', reject);
        }).on('error', reject);
      });

      // Determine MIME type and filename
      const fileName = fileInfo.file_path.split('/').pop() || 'file';
      const mimeType = this.getMimeTypeFromPath(fileInfo.file_path);

      return {
        buffer: buffer,
        mimeType: mimeType,
        fileName: fileName
      };

    } catch (error) {
      console.error(`❌ [${this.clientId}] Error downloading file:`, error.message);
      return null;
    }
  }

  // Helper function to determine MIME type from file path
  getMimeTypeFromPath(filePath) {
    const extension = filePath.split('.').pop().toLowerCase();
    const mimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'ogg': 'audio/ogg',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'txt': 'text/plain'
    };
    return mimeTypes[extension] || 'application/octet-stream';
  }

  getMimeType(type) {
    const mimeTypes = {
      photo: "image/jpeg",
      video: "video/mp4",
      audio: "audio/mpeg",
      voice: "audio/ogg",
      document: "application/octet-stream",
    };
    return mimeTypes[type] || "application/octet-stream";
  }

  getFileExtension(type) {
    const extensions = {
      photo: "jpg",
      video: "mp4",
      audio: "mp3",
      voice: "ogg",
      document: "bin",
    };
    return extensions[type] || "bin";
  }

  // Add skip function
  skipCurrentMessage() {
    if (this.messageQueue.length > 0) {
      const skippedMessage = this.messageQueue.shift();
      console.log(`⏭️ [${this.clientId}] Skipped message: ${skippedMessage.type}`);
      return true;
    }
    console.log(`⏭️ [${this.clientId}] No message in queue to skip`);
    return false;
  }

  // Add pause/resume functions
  pause() {
    this.isActive = false;
    console.log(`⏸️ [${this.clientId}] Forwarding paused`);
  }

  resume() {
    this.isActive = true;
    console.log(`▶️ [${this.clientId}] Forwarding resumed`);
    if (this.messageQueue.length > 0 && !this.isProcessingQueue) {
      this.processMessageQueue();
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async start() {
    console.log(`🚀 [${this.clientId}] Starting forwarder...`);
    
    // Only initialize WhatsApp if not skipped
    if (!this.config.skipWhatsApp) {
      await this.initializeWhatsApp();
    } else {
      console.log(`⏭️ [${this.clientId}] WhatsApp initialization skipped - Telegram only mode`);
    }
    
    // Always initialize Telegram
    this.initializeTelegram();
  }

  async stop() {
    console.log(`🛑 [${this.clientId}] Stopping forwarder...`);
    this.isActive = false;
    if (this.whatsappClient) {
      await this.whatsappClient.destroy();
    }
    if (this.telegramBot) {
      this.telegramBot.stopPolling();
    }
  }

  getStats() {
    return {
      clientId: this.clientId,
      isActive: this.isActive,
      isWhatsAppReady: this.isWhatsAppReady,
      whatsappSkipped: this.config.skipWhatsApp || false,
      totalMessages: this.totalMessages,
      failedMessages: this.failedMessages,
      queueLength: this.messageQueue.length,
      availableGroups: this.availableGroups.length,
    };
  }
}

class MultiClientManager {
  constructor() {
    this.clients = new Map();
    this.app = express();
    this.port = process.env.PORT || 3000;
  }

  async loadClientConfig(clientId) {
    try {
      const configPath = `./configs/${clientId}.json`;
      const configData = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.error(`❌ Failed to load config for ${clientId}:`, error.message);
      throw error;
    }
  }

  async startClient(clientId) {
    try {
      if (this.clients.has(clientId)) {
        console.log(`⚠️ Client ${clientId} is already running`);
        return;
      }

      const config = await this.loadClientConfig(clientId);
      const client = new SingleClientForwarder(clientId, config);
      
      this.clients.set(clientId, client);
      await client.start();
      
      console.log(`✅ Client ${clientId} started successfully`);
    } catch (error) {
      console.error(`❌ Failed to start client ${clientId}:`, error.message);
    }
  }

  async stopClient(clientId) {
    if (!this.clients.has(clientId)) {
      console.log(`⚠️ Client ${clientId} is not running`);
      return;
    }

    const client = this.clients.get(clientId);
    await client.stop();
    this.clients.delete(clientId);
    
    console.log(`🛑 Client ${clientId} stopped successfully`);
  }

  setupAPI() {
    this.app.use(express.json());

    this.app.get('/', (req, res) => {
      res.json({
        status: 'Multi-Client Telegram to WhatsApp Forwarder',
        clients: Array.from(this.clients.keys()),
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/clients', (req, res) => {
      const clientStats = Array.from(this.clients.entries()).map(([id, client]) => ({
        id,
        ...client.getStats()
      }));
      res.json(clientStats);
    });

    // Dashboard HTML
    this.app.get('/dashboard', (req, res) => {
      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Client Manager Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
          .header { background: #2196F3; color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
          .client { border: 1px solid #ddd; margin: 15px 0; padding: 20px; border-radius: 8px; background: white; }
          .active { border-left: 5px solid #4CAF50; }
          .inactive { border-left: 5px solid #f44336; }
          .paused { border-left: 5px solid #ff9800; }
          .skipped { border-left: 5px solid #9C27B0; }
          button { margin: 5px; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; }
          .start-btn { background: #4CAF50; color: white; }
          .pause-btn { background: #ff9800; color: white; }
          .resume-btn { background: #2196F3; color: white; }
          .stop-btn { background: #f44336; color: white; }
          .skip-btn { background: #9C27B0; color: white; }
          .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin: 5px; }
          .status-active { background: #4CAF50; color: white; }
          .status-inactive { background: #f44336; color: white; }
          .status-skipped { background: #9C27B0; color: white; }
          .stats { margin: 10px 0; font-size: 14px; color: #666; }
          .add-client { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📱 Multi-Client Telegram → WhatsApp Forwarder</h1>
          <p>Manage your forwarding clients remotely</p>
          <button onclick="refreshStatus()" style="background:rgba(255,255,255,0.2);color:white;border:1px solid white;">🔄 Refresh Status</button>
        </div>
        
        <div class="add-client">
          <h3>➕ Add New Client</h3>
          <input type="text" id="newClientId" placeholder="Enter client ID (e.g., client2)" style="padding: 8px; margin: 5px; width: 200px;">
          <button onclick="addNewClient()" class="start-btn">🚀 Add & Start Client</button>
          <p style="font-size: 12px; color: #666;">Make sure the config file exists in /configs/ folder</p>
        </div>
        
        <div id="clients"></div>
        
        <script>
          async function controlClient(clientId, action) {
            try {
              const response = await fetch(\`/clients/\${clientId}/\${action}\`, {method: 'POST'});
              const result = await response.json();
              if (result.success) {
                showMessage(result.message, 'success');
              } else {
                showMessage(result.error, 'error');
              }
              setTimeout(refreshStatus, 1000);
            } catch (error) {
              showMessage('Error: ' + error.message, 'error');
            }
          }
          
          async function skipMessage(clientId) {
            try {
              const response = await fetch(\`/clients/\${clientId}/skip\`, {method: 'POST'});
              const result = await response.json();
              showMessage(result.message, result.success ? 'success' : 'error');
              setTimeout(refreshStatus, 1000);
            } catch (error) {
              showMessage('Error: ' + error.message, 'error');
            }
          }
          
          async function toggleWhatsApp(clientId, skip) {
            try {
              const response = await fetch(\`/clients/\${clientId}/toggle-whatsapp\`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({skip: skip})
              });
              const result = await response.json();
              showMessage(result.message, result.success ? 'success' : 'error');
              setTimeout(refreshStatus, 2000);
            } catch (error) {
              showMessage('Error: ' + error.message, 'error');
            }
          }
          
          async function addNewClient() {
            const clientId = document.getElementById('newClientId').value.trim();
            if (!clientId) {
              showMessage('Please enter a client ID', 'error');
              return;
            }
            await controlClient(clientId, 'start');
            document.getElementById('newClientId').value = '';
          }
          
          function showMessage(message, type) {
            const div = document.createElement('div');
            div.style.cssText = \`position:fixed;top:20px;right:20px;padding:15px;border-radius:5px;z-index:1000;
              background:\${type === 'success' ? '#4CAF50' : '#f44336'};color:white;font-weight:bold;\`;
            div.textContent = message;
            document.body.appendChild(div);
            setTimeout(() => div.remove(), 3000);
          }
          
          async function refreshStatus() {
            try {
              const response = await fetch('/clients');
              const clients = await response.json();
              
              const container = document.getElementById('clients');
              container.innerHTML = '';
              
              if (clients.length === 0) {
                container.innerHTML = '<div class="client"><p style="text-align:center;color:#666;">No clients running. Add a new client above.</p></div>';
                return;
              }
              
              clients.forEach(client => {
                const div = document.createElement('div');
                let statusClass = 'inactive';
                if (client.whatsappSkipped) statusClass = 'skipped';
                else if (client.isActive && client.isWhatsAppReady) statusClass = 'active';
                else if (client.isActive && !client.isWhatsAppReady) statusClass = 'inactive';
                else statusClass = 'paused';
                
                div.className = \`client \${statusClass}\`;
                div.innerHTML = \`
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                      <h3>\${client.id}</h3>
                      <span class="status \${client.isActive ? 'status-active' : 'status-inactive'}">
                        \${client.isActive ? '🟢 ACTIVE' : '🔴 PAUSED'}
                      </span>
                      \${client.whatsappSkipped ? 
                        '<span class="status status-skipped">📵 WhatsApp SKIPPED</span>' : 
                        \`<span class="status \${client.isWhatsAppReady ? 'status-active' : 'status-inactive'}">
                          \${client.isWhatsAppReady ? '📱 Connected (Saved Session)' : '📱 Disconnected (May Need QR)'}
                        </span>\`
                      }
                    </div>
                    <div>
                      <button class="start-btn" onclick="controlClient('\${client.id}', 'start')" title="Start/Restart client">🚀 Start</button>
                      <button class="pause-btn" onclick="controlClient('\${client.id}', 'pause')" title="Pause forwarding">⏸️ Pause</button>
                      <button class="resume-btn" onclick="controlClient('\${client.id}', 'resume')" title="Resume forwarding">▶️ Resume</button>
                      <button class="skip-btn" onclick="skipMessage('\${client.id}')" title="Skip current message">⏭️ Skip Msg</button>
                      \${!client.whatsappSkipped ? 
                        '<button class="skip-btn" onclick="toggleWhatsApp(\'' + client.id + '\', true)" title="Skip WhatsApp for this client">📵 Skip WhatsApp</button>' :
                        '<button class="resume-btn" onclick="toggleWhatsApp(\'' + client.id + '\', false)" title="Enable WhatsApp for this client">📱 Enable WhatsApp</button>'
                      }
                      <button class="stop-btn" onclick="controlClient('\${client.id}', 'stop')" title="Stop client completely">🛑 Stop</button>
                    </div>
                  </div>
                  <div class="stats">
                    📊 Messages: \${client.totalMessages} sent, \${client.failedMessages} failed | 
                    📬 Queue: \${client.queueLength} pending | 
                    👥 Groups: \${client.availableGroups} available
                    \${client.whatsappSkipped ? ' | 📵 Telegram-only mode' : ''}
                  </div>
                \`;
                container.appendChild(div);
              });
            } catch (error) {
              console.error('Failed to refresh status:', error);
            }
          }
          
          // Auto refresh every 15 seconds
          setInterval(refreshStatus, 15000);
          
          // Load initial status
          refreshStatus();
        </script>
      </body>
      </html>
      `;
      res.send(html);
    });

    // Skip message API
    this.app.post('/clients/:clientId/skip', (req, res) => {
      const client = this.clients.get(req.params.clientId);
      if (client) {
        const skipped = client.skipCurrentMessage();
        res.json({ 
          success: true, 
          message: skipped ? `Skipped current message for ${req.params.clientId}` : `No message to skip for ${req.params.clientId}`
        });
      } else {
        res.status(404).json({ success: false, error: 'Client not found' });
      }
    });

    // Toggle WhatsApp API
    this.app.post('/clients/:clientId/toggle-whatsapp', async (req, res) => {
      const client = this.clients.get(req.params.clientId);
      if (!client) {
        return res.status(404).json({ success: false, error: 'Client not found' });
      }

      const { skip } = req.body;
      
      try {
        client.config.skipWhatsApp = skip;
        
        if (skip) {
          if (client.whatsappClient) {
            await client.whatsappClient.destroy();
            client.whatsappClient = null;
          }
          client.isWhatsAppReady = false;
          client.messageQueue = [];
          console.log(`📵 [${req.params.clientId}] WhatsApp disabled`);
          res.json({ success: true, message: `WhatsApp disabled for ${req.params.clientId}` });
        } else {
          console.log(`📱 [${req.params.clientId}] Enabling WhatsApp...`);
          await client.initializeWhatsApp();
          res.json({ success: true, message: `WhatsApp enabled for ${req.params.clientId} - check logs for QR code if needed` });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Start client API
    this.app.post('/clients/:clientId/start', async (req, res) => {
      try {
        await this.startClient(req.params.clientId);
        res.json({ success: true, message: `Client ${req.params.clientId} started` });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Pause client API
    this.app.post('/clients/:clientId/pause', (req, res) => {
      const client = this.clients.get(req.params.clientId);
      if (client) {
        client.pause();
        res.json({ success: true, message: `Client ${req.params.clientId} paused` });
      } else {
        res.status(404).json({ success: false, error: 'Client not found' });
      }
    });

    // Resume client API
    this.app.post('/clients/:clientId/resume', (req, res) => {
      const client = this.clients.get(req.params.clientId);
      if (client) {
        client.resume();
        res.json({ success: true, message: `Client ${req.params.clientId} resumed` });
      } else {
        res.status(404).json({ success: false, error: 'Client not found' });
      }
    });

    // Stop client API
    this.app.post('/clients/:clientId/stop', async (req, res) => {
      try {
        await this.stopClient(req.params.clientId);
        res.json({ success: true, message: `Client ${req.params.clientId} stopped` });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.listen(this.port, () => {
      console.log(`🌐 API server running on port ${this.port}`);
    });
  }

  async start() {
    console.log('🚀 Starting Multi-Client Manager...');
    
    this.setupAPI();
    
    // Auto-start client1
    try {
      await this.startClient('client1');
    } catch (error) {
      console.log('⚠️ client1 config not found or failed to start - use dashboard to add clients');
    }
  }
}

// Start the application
const manager = new MultiClientManager();
manager.start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  for (const [clientId, client] of manager.clients) {
    await client.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  for (const [clientId, client] of manager.clients) {
    await client.stop();
  }
  process.exit(0);
});
