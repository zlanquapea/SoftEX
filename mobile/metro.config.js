// Learn more https://docs.expo.dev/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const webcrypto = path.resolve(__dirname, 'src/lib/webcrypto.native.js');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'lib0/webcrypto' && platform !== 'web') return { type: 'sourceFile', filePath: webcrypto };
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
