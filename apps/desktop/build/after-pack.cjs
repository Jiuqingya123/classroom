const path = require('node:path');
const { signApp } = require('@electron/osx-sign');

/**
 * 没有 Developer ID 时走 ad-hoc 签名。
 * arm64 上未签名的 app 会因为签名失效直接拒绝启动，所以这一步不能省。
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const entitlements = path.join(context.packager.projectDir, 'build', 'entitlements.mac.plist');

  // 必须用 signApp：同包的 sign() 是废弃的回调版，返回 undefined，
  // await 会立刻通过，签名变成后台异步跑，dmg 就会打进未签名的 app。
  await signApp({
    app: appPath,
    platform: 'darwin',
    identity: '-',
    identityValidation: false,
    type: 'development',
    preAutoEntitlements: false,
    // osx-sign 默认会带 --timestamp 去连 Apple 时间戳服务器，内网/国内环境会一直挂住；
    // ad-hoc 签名本来也无法打时间戳，必须显式关掉。
    // disable-library-validation 也必须在，否则 ad-hoc 下 dyld 会因 Team ID 不一致
    // 拒绝加载 Electron Framework。
    optionsForFile: () => ({ entitlements, hardenedRuntime: true, timestamp: 'none' }),
  });

  console.log(`  • ad-hoc signed  ${appPath}`);
};
