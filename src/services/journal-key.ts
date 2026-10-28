/**
 * Ключ конфигурации для учёта множественных проверок (validation-plan §5):
 * стратегия, версия и набор символов. Те же правила на другой корзине — другая
 * конфигурация.
 */
export function configurationKey(e: { strategyId: string; strategyVersion: string; symbols: readonly string[] }): string {
  return `${e.strategyId}@${e.strategyVersion}:${[...e.symbols].sort().join(",")}`;
}
