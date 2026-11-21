/** 同意门禁只停止新工作，不取消已经派发的副作用及其持久化收尾。 */
let checkConsent: () => boolean = () => true;

export class TermsConsentRequiredError extends Error {
  readonly code = "E_TERMS_CONSENT_REQUIRED";
  constructor() {
    super("请在桌面应用阅读并同意最新条款后继续操作。");
    this.name = "TermsConsentRequiredError";
  }
}

export function isTermsExecutionAllowed(): boolean {
  try { return checkConsent(); } catch { return false; }
}

export function assertTermsExecutionAllowed(): void {
  if (!isTermsExecutionAllowed()) throw new TermsConsentRequiredError();
}

/** 返回清理函数，旧实例退出时不能解除较新实例的门禁。 */
export function configureTermsExecutionGate(check: () => boolean): () => void {
  const previous = checkConsent;
  checkConsent = check;
  return () => { if (checkConsent === check) checkConsent = previous; };
}
