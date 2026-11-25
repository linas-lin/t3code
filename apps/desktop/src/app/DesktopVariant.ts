declare const __T3CODE_DESKTOP_VARIANT__: string | undefined;

export type DesktopVariant = "standard" | "ct";

export function normalizeDesktopVariant(value: string | undefined): DesktopVariant {
  return value?.trim() === "ct" ? "ct" : "standard";
}

export const CURRENT_DESKTOP_VARIANT: DesktopVariant = normalizeDesktopVariant(
  typeof __T3CODE_DESKTOP_VARIANT__ === "undefined" ? undefined : __T3CODE_DESKTOP_VARIANT__,
);

export function isCtDesktopVariant(variant: DesktopVariant = CURRENT_DESKTOP_VARIANT): boolean {
  return variant === "ct";
}

export function resolveDefaultBaseDirName(
  variant: DesktopVariant = CURRENT_DESKTOP_VARIANT,
): string {
  return isCtDesktopVariant(variant) ? ".t3-ct" : ".t3";
}

export function resolveProductionUserDataDirName(
  variant: DesktopVariant = CURRENT_DESKTOP_VARIANT,
): string {
  return isCtDesktopVariant(variant) ? "t3code-ct" : "t3code-v2";
}

export function resolveProductionDesktopScheme(
  variant: DesktopVariant = CURRENT_DESKTOP_VARIANT,
): string {
  // Use `t3code-dev` for CT builds so they stay separate from the official `t3code://`
  // production scheme while still being accepted by Clerk / T3 Connect and server CORS.
  return isCtDesktopVariant(variant) ? "t3code-dev" : "t3code";
}

export function resolveProductionAppUserModelId(
  variant: DesktopVariant = CURRENT_DESKTOP_VARIANT,
): string {
  return isCtDesktopVariant(variant) ? "com.ct.code" : "com.t3tools.t3code";
}

export function resolveLinuxDesktopEntryNameForVariant(
  isDevelopment: boolean,
  variant: DesktopVariant = CURRENT_DESKTOP_VARIANT,
): string {
  if (isDevelopment) {
    return "com.t3tools.T3Code.Development.desktop";
  }
  return isCtDesktopVariant(variant) ? "com.ct.Code.desktop" : "com.t3tools.T3Code.desktop";
}
