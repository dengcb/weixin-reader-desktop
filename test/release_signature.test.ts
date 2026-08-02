import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import {
  normalizeUpdaterSignature,
  verifyUpdaterSignature,
} from '../src/scripts/release_signature';

function fixture(): {
  updater: Buffer;
  signature: string;
  encodedPublicKeyFile: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const rawPublicKey = publicDer.subarray(-32);
  const keyId = Buffer.from('0102030405060708', 'hex');
  const keyBlob = Buffer.concat([Buffer.from('ED'), keyId, rawPublicKey]);
  const publicKeyFile = `untrusted comment: test public key\n${keyBlob.toString('base64')}\n`;

  const updater = Buffer.from('final installer bytes');
  const signature = sign(null, createHash('blake2b512').update(updater).digest(), privateKey);
  const signatureBlob = Buffer.concat([Buffer.from('ED'), keyId, signature]);
  const trustedComment = 'timestamp:0';
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment)]),
    privateKey,
  );
  const signatureFile = [
    'untrusted comment: test signature',
    signatureBlob.toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');

  return {
    updater,
    signature: signatureFile,
    encodedPublicKeyFile: Buffer.from(publicKeyFile).toString('base64'),
  };
}

describe('release updater signature verification', () => {
  it('verifies raw and Base64 Minisign files against the final updater bytes', () => {
    const data = fixture();

    expect(() =>
      verifyUpdaterSignature(data.updater, data.signature, data.encodedPublicKeyFile),
    ).not.toThrow();
    expect(() =>
      verifyUpdaterSignature(
        data.updater,
        Buffer.from(data.signature).toString('base64'),
        data.encodedPublicKeyFile,
      ),
    ).not.toThrow();
    expect(normalizeUpdaterSignature(data.signature)).toBe(
      Buffer.from(data.signature.trim()).toString('base64'),
    );
  });

  it('rejects a signature after the updater bytes change', () => {
    const data = fixture();

    expect(() =>
      verifyUpdaterSignature(
        Buffer.concat([data.updater, Buffer.from('tampered')]),
        data.signature,
        data.encodedPublicKeyFile,
      ),
    ).toThrow('签名与最终文件不匹配');
  });
});
