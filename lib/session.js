const fs = require('fs');
const path = require('path');

/**
 * Менеджер сессий для хранения данных авторизации
 */
class SessionManager {
  constructor(sessionName = 'default') {
    this.sessionName = sessionName;
    this.sessionDir = path.join(process.cwd(), 'sessions');
    this.sessionFile = path.join(this.sessionDir, `${sessionName}.json`);
    this.data = {};
    
    this.ensureSessionDir();
    this.load();
  }

  /**
   * Создает директорию для сессий если её нет
   */
  ensureSessionDir() {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Загружает данные сессии из файла
   */
  load() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = fs.readFileSync(this.sessionFile, 'utf8');
        this.data = JSON.parse(data);
        return true;
      }
    } catch (error) {
      console.error('Ошибка при загрузке сессии:', error.message);
    }
    return false;
  }

  /**
   * Копия последнего успешного состояния (после удачного sync) — для ручного восстановления:
   * скопируйте `.last_ok.json` на место основного файла сессии.
   */
  copyToLastOk() {
    try {
      if (!fs.existsSync(this.sessionFile)) return false;
      const okPath = path.join(this.sessionDir, `${this.sessionName}.last_ok.json`);
      fs.copyFileSync(this.sessionFile, okPath);
      return true;
    } catch (error) {
      console.error('Ошибка резервной копии сессии:', error.message);
      return false;
    }
  }

  /**
   * Сохраняет данные сессии в файл
   */
  save() {
    try {
      fs.writeFileSync(
        this.sessionFile,
        JSON.stringify(this.data, null, 2),
        'utf8'
      );
      return true;
    } catch (error) {
      console.error('Ошибка при сохранении сессии:', error.message);
      return false;
    }
  }

  /**
   * Устанавливает значение в сессии
   */
  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  /**
   * Получает значение из сессии
   */
  get(key, defaultValue = null) {
    return this.data[key] !== undefined ? this.data[key] : defaultValue;
  }

  /**
   * Удаляет значение из сессии
   */
  delete(key) {
    delete this.data[key];
    this.save();
  }

  /**
   * Проверяет наличие ключа в сессии
   */
  has(key) {
    return this.data[key] !== undefined;
  }

  /**
   * Очищает все данные сессии
   */
  clear() {
    this.data = {};
    this.save();
  }

  /**
   * Удаляет файл сессии
   */
  destroy() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        fs.unlinkSync(this.sessionFile);
      }
      this.data = {};
      return true;
    } catch (error) {
      console.error('Ошибка при удалении сессии:', error.message);
      return false;
    }
  }

  /**
   * Проверяет, авторизован ли пользователь
   */
  isAuthorized() {
    return this.has('token') && this.has('userId');
  }
}

module.exports = SessionManager;

