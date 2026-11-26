const _c = (x: number) => String.fromCharCode(x);
const _a = () => _c((0x19 << 1) + 1) + _c(0x32);
const _b = () => _c(0x6b);

const _K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
]);

const _S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
]);

const _H = "0123456789abcdef".split("");

export function getChapterUrl(uid: string | number): string {
  const _s = uid.toString();
  const _h = (str: string): string => {
    let n = str.length;
    let nblk = ((n + 8) >> 6) + 1;
    let blks = new Uint32Array(nblk * 16);
    for (let i = 0; i < n; i++) blks[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
    blks[n >> 2] |= 0x80 << ((n % 4) * 8);
    blks[nblk * 16 - 2] = n * 8;
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < blks.length; i += 16) {
      let oa = a, ob = b, oc = c, od = d;
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) { f = (b & c) | ((~b) & d); g = j; }
        else if (j < 32) { f = (d & b) | ((~d) & c); g = (5 * j + 1) % 16; }
        else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
        else { f = c ^ (b | (~d)); g = (7 * j) % 16; }
        let t = d; d = c; c = b;
        let sum = (a + f + _K[j] + blks[i + g]) | 0;
        b = ((b + ((sum << _S[j]) | (sum >>> (32 - _S[j])))) | 0);
        a = t;
      }
      a = (a + oa) | 0; b = (b + ob) | 0; c = (c + oc) | 0; d = (d + od) | 0;
    }
    let out = "";
    [a, b, c, d].forEach(v => {
      out += _H[(v >> 4) & 0x0F] + _H[v & 0x0F] + _H[(v >> 12) & 0x0F] + _H[(v >> 8) & 0x0F] +
             _H[(v >> 20) & 0x0F] + _H[(v >> 16) & 0x0F] + _H[(v >> 28) & 0x0F] + _H[(v >> 24) & 0x0F];
    });
    return out;
  };
  let _v = _h(_s);
  let _x = parseInt(_s).toString(16);
  let _xl = _x.length < 10 ? '0' + _x.length : _x.length.toString();
  let _p = 11 - _x.length;
  let _core = _v.slice(0, 3) + _a() + _v.slice(-2) + _xl + _x + _v.slice(0, _p > 0 ? _p : 0);
  let _sig = _h(_core).slice(0, 3);
  return _b() + _core + _sig;
}
