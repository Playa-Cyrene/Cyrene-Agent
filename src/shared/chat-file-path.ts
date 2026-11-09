/** UNC and device namespaces accept both Windows path separators. */
export function isWindowsNetworkOrDevicePath(filePath: string): boolean {
  return /^[\\/](?:[\\/]|\?\?[\\/])/.test(filePath);
}
