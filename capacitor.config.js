const serverUrl = process.env.CAPACITOR_SERVER_URL || process.env.CAPACITOR_URL || '';

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
