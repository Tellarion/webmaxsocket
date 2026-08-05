/**
 * Генерация UserAgent для Max API
 */

const { APP_VERSION, BUILD_NUMBER } = require('./constants');

const DEVICE_NAMES = [
  'Android', 'Chrome', 'Firefox', 'Edge', 'Safari', 'Opera', 'Vivaldi', 'Brave', 'Chromium',
  'Windows 10', 'Windows 11', 'macOS Big Sur', 'macOS Monterey', 'macOS Ventura',
  'Ubuntu 20.04', 'Ubuntu 22.04', 'Fedora 35', 'Fedora 36', 'Debian 11',
];

const SCREEN_SIZES = [
  '1920x1080 1.0x', '1366x768 1.0x', '1440x900 1.0x', '1536x864 1.0x',
  '1280x720 1.0x', '1600x900 1.0x', '1680x1050 1.0x', '2560x1440 1.0x', '3840x2160 1.0x',
];

const OS_VERSIONS = [
  'Android 14', 'Windows 10', 'Windows 11', 'macOS Big Sur', 'macOS Monterey', 'macOS Ventura',
  'Ubuntu 20.04', 'Ubuntu 22.04', 'Fedora 35', 'Fedora 36', 'Debian 11',
];

const TIMEZONES = [
  'Europe/Moscow', 'Europe/Kaliningrad', 'Europe/Samara', 'Asia/Yekaterinburg',
  'Asia/Omsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk',
  'Asia/Vladivostok', 'Asia/Kamchatka',
];

const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:121.0) Gecko/20100101 Firefox/121.0',
];

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Создает UserAgent пейлоад для Max API
 * Поддерживает WEB, ANDROID и кастомные профили (для token auth)
 */
class UserAgentPayload {
  constructor(options = {}) {
    this.deviceType = options.deviceType || 'WEB';
    this.locale = options.locale || 'ru';
    this.deviceLocale = options.deviceLocale || 'ru';
    this.osVersion = options.osVersion || randomChoice(OS_VERSIONS);
    this.deviceName = options.deviceName || randomChoice(DEVICE_NAMES);
    this.headerUserAgent = options.headerUserAgent || randomChoice(USER_AGENTS);
    this.appVersion = options.appVersion || APP_VERSION;
    this.screen = options.screen || randomChoice(SCREEN_SIZES);
    this.timezone = options.timezone || randomChoice(TIMEZONES);
    this.clientSessionId = options.clientSessionId ?? randomInt(1, 15);
    this.buildNumber = options.buildNumber ?? BUILD_NUMBER;
    this.release = options.release;
  }

  /**
   * Преобразует в объект для отправки (camelCase ключи)
   */
  toJSON() {
    const obj = {
      deviceType: this.deviceType,
      locale: this.locale,
      deviceLocale: this.deviceLocale,
      osVersion: this.osVersion,
      deviceName: this.deviceName,
      headerUserAgent: this.headerUserAgent,
      appVersion: this.appVersion,
      screen: this.screen,
      timezone: this.timezone,
      clientSessionId: this.clientSessionId,
      buildNumber: this.buildNumber,
    };
    if (this.release !== undefined) obj.release = this.release;
    return obj;
  }
}

module.exports = { UserAgentPayload };

