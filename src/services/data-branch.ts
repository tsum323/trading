/**
 * Чтение ветки `data` (перспективный тест и журнал исследований) по HTTP —
 * для интерфейса, которому не нужна локальная копия репозитория.
 * По умолчанию — raw.githubusercontent.com публичного репозитория.
 */
export const DEFAULT_DATA_BRANCH_URL = "https://raw.githubusercontent.com/tsum323/trading/data";

export class DataBranchReader {
  constructor(
    readonly baseUrl: string = DEFAULT_DATA_BRANCH_URL,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async get(path: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/${path}`, signal ? { signal } : {});
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return res.text();
  }

  /** JSONL-журнал; отсутствующий файл — пустой журнал. Повреждённая строка — ошибка, а не пропуск. */
  async readJsonl<T>(path: string, signal?: AbortSignal): Promise<T[]> {
    const text = await this.get(path, signal);
    if (text === null) return [];
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l, i) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          throw new Error(`${path}:${i + 1}: invalid JSON`);
        }
      });
  }

  async readJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    const text = await this.get(path, signal);
    return text === null ? null : (JSON.parse(text) as T);
  }

  /** Ссылка на файл для просмотра на GitHub (только для raw.githubusercontent.com). */
  browseUrl(path: string): string | null {
    const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(this.baseUrl);
    return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/${path}` : null;
  }
}
