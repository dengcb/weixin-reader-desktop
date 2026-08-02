import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';

export function normalizeUpdaterSignature(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('updater signature 为空');
  if (trimmed.startsWith('untrusted comment:')) {
    return Buffer.from(trimmed, 'utf8').toString('base64');
  }
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  if (!decoded.startsWith('untrusted comment:')) {
    throw new Error('updater signature 既不是 Minisign 文本，也不是其 Base64 编码');
  }
  return trimmed;
}

function decodeMinisignFile(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('untrusted comment:')) return trimmed;
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  if (!decoded.startsWith('untrusted comment:')) throw new Error('无效的 Minisign 文件');
  return decoded;
}

export function verifyUpdaterSignature(
  updater: Uint8Array,
  rawSignature: string,
  encodedPublicKeyFile: string,
): void {
  const publicKeyFile = Buffer.from(encodedPublicKeyFile, 'base64').toString('utf8');
  const publicKeyLine = publicKeyFile
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith('untrusted comment:'));
  if (!publicKeyLine) throw new Error('Tauri updater 公钥格式无效');
  const publicKeyBlob = Buffer.from(publicKeyLine, 'base64');
  if (publicKeyBlob.length !== 42) throw new Error('Tauri updater 公钥长度无效');

  const signatureLines = decodeMinisignFile(rawSignature).split(/\r?\n/);
  if (
    signatureLines.length < 4 ||
    !signatureLines[0].startsWith('untrusted comment:') ||
    !signatureLines[2].startsWith('trusted comment: ')
  ) {
    throw new Error('Tauri updater 签名格式无效');
  }
  const signatureBlob = Buffer.from(signatureLines[1], 'base64');
  const globalSignature = Buffer.from(signatureLines[3], 'base64');
  if (signatureBlob.length !== 74 || globalSignature.length !== 64) {
    throw new Error('Tauri updater 签名长度无效');
  }
  if (!signatureBlob.subarray(2, 10).equals(publicKeyBlob.subarray(2, 10))) {
    throw new Error('Tauri updater 签名 key ID 与配置公钥不匹配');
  }

  const algorithm = signatureBlob.subarray(0, 2).toString('ascii');
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(`不支持的 Minisign 算法：${algorithm}`);
  }
  const publicKeyDer = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    publicKeyBlob.subarray(10),
  ]);
  const key = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const signedContent =
    algorithm === 'ED'
      ? createHash('blake2b512').update(updater).digest()
      : Buffer.from(updater);
  const signature = signatureBlob.subarray(10);
  if (!verifyEd25519(null, signedContent, key, signature)) {
    throw new Error('Tauri updater 签名与最终文件不匹配');
  }
  const trustedComment = signatureLines[2].slice('trusted comment: '.length);
  const globalContent = Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]);
  if (!verifyEd25519(null, globalContent, key, globalSignature)) {
    throw new Error('Tauri updater trusted comment 签名无效');
  }
}
