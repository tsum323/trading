import { inflateRawSync } from "node:zlib";

/**
 * Первый файл из zip-архива как текст. Архивы Binance Vision содержат один CSV;
 * разбирается центральный каталог (размеры в локальном заголовке могут быть нулевыми).
 * Только сжатие deflate (8) и без сжатия (0); zip64 не поддерживается.
 */
export function unzipFirstText(data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const cd = view.getUint32(eocd + 16, true);
  if (view.getUint32(cd, true) !== 0x02014b50) throw new Error("zip: bad central directory");
  const method = view.getUint16(cd + 10, true);
  const compressedSize = view.getUint32(cd + 20, true);
  const localOffset = view.getUint32(cd + 42, true);
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("zip: bad local header");
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLen + extraLen;
  const body = data.subarray(start, start + compressedSize);
  const raw = method === 0 ? body : method === 8 ? inflateRawSync(body) : null;
  if (raw === null) throw new Error(`zip: unsupported compression method ${method}`);
  return new TextDecoder().decode(raw);
}
