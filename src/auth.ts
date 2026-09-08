/**
 * 固定トークンによる認証。
 *
 * Workers 上では Node の crypto.timingSafeEqual を利用できないため、
 * 双方を SHA-256 で固定長へ畳んでから XOR 差分を取ることで、
 * 入力長にも内容にも依存しない比較を行う。
 */

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return new Uint8Array(digest);
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < digestA.length; i += 1) {
    diff |= digestA[i]! ^ digestB[i]!;
  }
  return diff === 0;
}

/** Authorization: Bearer <token> ヘッダを期待値と照合する。 */
export async function isAuthorized(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get('authorization');
  if (header === null) {
    return false;
  }
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  if (match === null) {
    return false;
  }
  return timingSafeEqual(match[1]!, expected);
}
