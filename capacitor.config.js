const serverUrl = process.env.CAPACITOR_SERVER_URL || process.env.CAPACITOR_URL || '';
const cookiesEnabled = process.env.CAPACITOR_COOKIES_ENABLED !== 'false';
const updateChannel = process.env.CAPACITOR_UPDATE_CHANNEL || 'stable';
const updateMethod = process.env.CAPGO_UPDATE_METHOD || 'auto';

const config = {
  appId: process.env.CAPACITOR_APP_ID || 'chat.openclaw.client',
  appName: process.env.CAPACITOR_APP_NAME || 'Miso Chat',
  webDir: 'public',
  android: {
    buildToolsVersion: '33.0.0',
    minSdkVersion: 22,
    targetSdkVersion: 33,
    useAndroidX: true,
    allowMixedContent: true
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,
      backgroundColor: '#0d0d14',
      androidScaleType: 'CENTER_CROP'
    },
    CapacitorCookies: {
      enabled: cookiesEnabled
    },
    CapgoUpdater: {
      appId: process.env.CAPGO_APP_ID || 'chat.openclaw.miso',
      updateMethod: updateMethod,
      updateChannel: updateChannel,
      minUpdateDuration: 3000,
      maxUpdateDuration: 30000,
      debug: process.env.NODE_ENV === 'development'
    }
  }
};

if (serverUrl) {
  config.server = {
    androidScheme: 'https',
    url: serverUrl
  };
}

module.exports = config;
