import { useEffect, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import type { QqModuleInstallationStatus } from "../../../../shared/qq-module-installation";
import type { SettingsApi } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";

type StatusReader = Pick<SettingsApi, "channelsQqModuleInstallationStatus">;

/** Read-only entry at the original QQ settings location. No install IPC exists yet. */
export function QqModuleInstallationCard({ api, listenMode, customHost }: { api?: StatusReader; listenMode: string; customHost: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"loading" | "unconfigured" | "error">("loading");
  const [listen, setListen] = useState<"loopback" | "unsupported-host" | "unresolved">("unresolved");
  const [token, setToken] = useState<QqModuleInstallationStatus["tokenCompatibility"]>("unresolved");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setStatus("loading");
    setListen("unresolved");
    setToken("unresolved");
    if (!api?.channelsQqModuleInstallationStatus) { setStatus("error"); return; }
    void api.channelsQqModuleInstallationStatus({ listenMode, customHost }).then((result) => {
      if (active) {
        setListen(result?.listenCompatibility ?? "unresolved");
        setToken(result?.tokenCompatibility ?? "unresolved");
        setStatus(result?.availability === "release-unconfigured" && result.canInstall === false
        && result.moduleInstalled === false && result.currentDriver === "legacy-builtin"
        && ["available", "required", "unresolved"].includes(result.tokenCompatibility)
        && ["loopback", "unsupported-host", "unresolved"].includes(result.listenCompatibility) ? "unconfigured" : "error");
      }
    }, () => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [api, open, listenMode, customHost]);
  const key = "settingsPage.channels.qqModule";
  return <section aria-label={t(`${key}.title`)}>
    <p className="cy-channels-hint">{t(`${key}.summary`)}</p>
    <Button onClick={() => setOpen(true)}>{t(`${key}.entry`)}</Button>
    <Modal open={open} title={t(`${key}.title`)} onCancel={() => setOpen(false)}
      footer={<Button onClick={() => setOpen(false)}>{t(`${key}.close`)}</Button>} destroyOnHidden>
      {status === "loading" ? <Spin /> : <Alert type="warning" showIcon
        title={t(`${key}.${status === "error" ? "failed" : "unavailable"}`)} />}
      <p>{t(`${key}.legacy`)}</p>
      <p>{t(`${key}.safety`)}</p>
      <p>{t(`${key}.loopbackPolicy`)}</p>
      {status !== "loading" && <p role="status">{t(`${key}.${status !== "unconfigured" ? "listenUnresolved" : listen === "loopback" ? "listenReady" : listen === "unsupported-host" ? "listenUnsupported" : "listenUnresolved"}`)}</p>}
      <p>{t(`${key}.tokenPolicy`)}</p>
      {status !== "loading" && <p role="status">{t(`${key}.${status !== "unconfigured" || token === "unresolved" ? "tokenUnresolved" : token === "required" ? "tokenRequired" : "tokenAvailable"}`)}</p>}
      <p>{t(`${key}.data`)}</p>
      <Button type="primary" disabled>{t(`${key}.install`)}</Button>
    </Modal>
  </section>;
}
