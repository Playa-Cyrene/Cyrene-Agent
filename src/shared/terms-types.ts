export type TermsLocale = "zh-CN" | "en" | "ja-JP";
export type TermsBlock = { kind: "paragraph" | "heading"; text: string } | { kind: "list"; items: string[] };
export interface TermsDocument { heading: string; sections: Array<{ title: string; blocks: TermsBlock[] }> }
export interface TermsBundle {
  schemaVersion: 1;
  /** 单调递增的发布序号；纯文案修订也必须增加。 */
  revision: number;
  /** YYYY-MM-DD 或 YYYY-MM-DD.N；仅实质修改增加，禁止回退。 */
  consentVersion: string;
  locales: Record<TermsLocale, TermsDocument>;
}
export interface TermsAcceptance { revision: number; consentVersion: string; contentHash: string }
export interface TermsSnapshot extends TermsBundle {
  contentHash: string;
  accepted: boolean;
  source: "builtin" | "cache" | "remote";
}
export interface TermsAcceptResult { ok: boolean; error?: "changed" | "saveFailed"; snapshot: TermsSnapshot }
export interface TermsApi {
  get(): Promise<TermsSnapshot>;
  accept(request: TermsAcceptance): Promise<TermsAcceptResult>;
  onUpdated(callback: (snapshot: TermsSnapshot) => void): () => void;
}
