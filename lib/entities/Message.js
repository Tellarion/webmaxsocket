const User = require('./User');
const { downloadUrlToTempFile, extFromAttachType } = require('../downloadMedia');

/**
 * Класс представляющий сообщение
 */
class Message {
  constructor(data, client) {
    this.client = client;
    this.id =
      data.id ??
      data.messageId ??
      data.message_id ??
      (data.message && (data.message.id ?? data.message.messageId)) ??
      null;
    this.cid = data.cid || null;
    this.chatId =
      data.chatId !== undefined && data.chatId !== null
        ? data.chatId
        : data.chat_id !== undefined && data.chat_id !== null
          ? data.chat_id
          : null;
    
    // Обработка text: может быть строкой или объектом
    if (typeof data.text === 'string') {
      this.text = data.text;
    } else if (typeof data.text === 'object' && data.text !== null) {
      // Если text - объект, ищем текст внутри
      this.text = data.text.text || JSON.stringify(data.text);
    } else {
      this.text = data.message || '';
    }
    
    // Обработка sender: может быть объектом User или просто ID
    if (data.sender) {
      if (typeof data.sender === 'object') {
        this.senderId = data.sender.id;
        this.sender = new User(data.sender);
      } else {
        // Если sender - это просто ID (число)
        this.senderId = data.sender;
        this.sender = null; // Будет загружен позже при необходимости
      }
    } else {
      this.senderId = data.senderId || data.sender_id || data.from_id || null;
      this.sender = null;
    }
    
    this.timestamp = data.timestamp || data.time || Date.now();
    this.type = data.type || 'text';
    this.isEdited = data.isEdited || data.is_edited || false;
    this.replyTo = data.replyTo || data.reply_to || null;
    this.attachments = data.attaches || data.attachments || [];
    this.rawData = data;
  }
  
  /**
   * Получить информацию об отправителе
   */
  async fetchSender() {
    if (!this.sender && this.senderId) {
      try {
        this.sender = await this.client.getUser(this.senderId);
      } catch (error) {
        console.error('Ошибка загрузки информации об отправителе:', error);
      }
    }
    return this.sender;
  }
  
  /**
   * Получить имя отправителя
   */
  getSenderName() {
    if (this.sender) {
      return this.sender.fullname || this.sender.firstname || 'User';
    }
    return this.senderId ? `User ${this.senderId}` : 'Unknown';
  }

  /**
   * Отправить текст в этот же чат (как ответ собеседнику).
   * По умолчанию без цитаты (без link REPLY): на TCP-сокете сервер часто отклоняет MSG_SEND с link.
   * Цитата/ветка: reply({ text, quote: true }) — если сервер вернёт ошибку, оставьте quote: false.
   */
  async reply(options) {
    if (typeof options === 'string') {
      options = { text: options };
    }

    const { text, cid, attachments, quote = false } = options;
    const payload = {
      chatId: this.chatId,
      text,
      cid,
      attachments
    };
    if (quote && this.id != null && this.id !== '') {
      payload.replyTo = this.id;
    }
    return await this.client.sendMessage(payload);
  }

  /**
   * Редактировать сообщение
   */
  async edit(options) {
    if (typeof options === 'string') {
      options = { text: options };
    }

    return await this.client.editMessage({
      messageId: this.id,
      chatId: this.chatId,
      text: options.text,
      ...options
    });
  }

  /**
   * Удалить сообщение
   */
  async delete() {
    return await this.client.deleteMessage({
      messageId: this.id,
      chatId: this.chatId
    });
  }

  /**
   * Скачать вложение по его baseUrl (HTTPS) во временный файл.
   * По умолчанию каталог: {@link https://nodejs.org/api/os.html#ostmpdir os.tmpdir()}.
   *
   * @param {number} [index=0] индекс в массиве attachments
   * @param {{ dir?: string, filename?: string }} [options]
   * @returns {Promise<{ path: string, contentType: string }>}
   */
  async downloadAttachment(index = 0, options = {}) {
    const att = this.attachments[index];
    if (!att) {
      throw new Error(`Нет вложения с индексом ${index}`);
    }
    let url = att.baseUrl || att.url;
    const t = String(att._type || att.type || '').toUpperCase();
    const chatIdForFile =
      this.chatId != null
        ? this.chatId
        : options.chatId != null
          ? options.chatId
          : this.rawData && (this.rawData.chatId ?? this.rawData.chat_id);

    if (
      (!url || typeof url !== 'string') &&
      t === 'FILE' &&
      att.fileId != null &&
      this.client &&
      typeof this.client.requestFileDownloadUrl === 'function' &&
      chatIdForFile != null
    ) {
      const msgId = this.rawData && this.rawData.id != null ? this.rawData.id : this.id;
      url = await this.client.requestFileDownloadUrl({
        chatId: chatIdForFile,
        messageId: msgId,
        fileId: att.fileId,
        fileName: att.name || att.fileName || att.filename || '',
        attachLocalId: att.attachLocalId || att.localId || ''
      });
    }
    if (!url || typeof url !== 'string') {
      throw new Error('У вложения нет baseUrl/url и не удалось получить ссылку на файл');
    }
    const extFallback = extFromAttachType(att._type || att.type);
    return downloadUrlToTempFile(url, { ...options, extFallback });
  }

  /**
   * Переслать сообщение
   */
  async forward(chatId) {
    return await this.client.forwardMessage({
      messageId: this.id,
      fromChatId: this.chatId,
      toChatId: chatId
    });
  }

  /**
   * Возвращает строковое представление сообщения
   */
  toString() {
    return `Message(id=${this.id}, from=${this.senderId}, text="${this.text.substring(0, 50)}")`;
  }

  /**
   * Возвращает JSON представление
   */
  toJSON() {
    return {
      id: this.id,
      cid: this.cid,
      chatId: this.chatId,
      text: this.text,
      senderId: this.senderId,
      sender: this.sender ? this.sender.toJSON() : null,
      timestamp: this.timestamp,
      type: this.type,
      isEdited: this.isEdited,
      replyTo: this.replyTo,
      attachments: this.attachments
    };
  }
}

module.exports = Message;

