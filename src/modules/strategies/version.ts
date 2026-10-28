/**
 * Версия стратегии с учётом параметров: отличия от значений по умолчанию
 * дописываются к базовой версии (`0.1.0+period=30,targetR=3`), поэтому
 * разные наборы не смешиваются в статистике и журнале.
 */
export function paramsVersion<P extends object>(base: string, defaults: P, params: P): string {
  const diff = (Object.keys(defaults) as (keyof P)[])
    .filter((k) => params[k] !== defaults[k])
    .map((k) => `${String(k)}=${String(params[k])}`);
  return diff.length === 0 ? base : `${base}+${diff.join(",")}`;
}
