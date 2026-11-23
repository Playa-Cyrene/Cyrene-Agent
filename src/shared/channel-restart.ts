/** A caller can require that the ordinary restart actually applies to legacy QQ. */
export type ChannelRestartTarget = "qq";
export const CHANNEL_RESTART_ERROR = {
  shuttingDown: "CHANNELS_SHUTTING_DOWN",
  invalidTarget: "CHANNELS_INVALID_RESTART_TARGET",
  qqBusy: "QQ_MODULE_SETTINGS_BUSY",
  qqManaged: "QQ_MODULE_SETTINGS_REQUIRE_EXPLICIT_RECONFIGURATION",
  qqNotApplied: "QQ_LEGACY_RESTART_NOT_APPLIED",
} as const;
export type ChannelRestartError = typeof CHANNEL_RESTART_ERROR[keyof typeof CHANNEL_RESTART_ERROR];
export type ChannelRestartResult = { ok: true } | { ok: false; error: ChannelRestartError };
